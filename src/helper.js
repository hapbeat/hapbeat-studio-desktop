'use strict'
// Runs the Hapbeat Helper bundled with the app (resources/helper/hapbeat-helper.exe).
//
// Studio talks to the helper on ws://localhost:7703 exactly as in the browser. When
// something already listens there (a pipx-installed helper, or another copy of the
// app), the app uses it and starts nothing; if that one goes away, the bundled helper
// takes over. The bundled helper stops when the app quits; if the app is killed,
// Windows ends it too (Node starts children in a job object closed with the app).

const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

const DEFAULT_PORT = 7703
const READY_TIMEOUT_MS = 20000
const WATCH_INTERVAL_MS = 5000
const RESTART_DELAY_MS = 1500
// More crashes than this within the window → stop retrying and report "crashed".
const MAX_RESTARTS = 5
const RESTART_WINDOW_MS = 60000
const LOG_ROTATE_BYTES = 2 * 1024 * 1024

/** Resolves true when something accepts TCP connections on 127.0.0.1:port. */
function isPortOpen(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (open) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** "hapbeat-helper 0.5.0 starting on ws://localhost:7703" → "0.5.0" */
function parseStartLine(line) {
  const m = /hapbeat-helper\s+(\S+)\s+starting on/.exec(line)
  return m ? m[1] : null
}

class HelperProcess extends EventEmitter {
  /**
   * @param {{ exePath: string, logDir: string, port?: number }} options
   */
  constructor({ exePath, logDir, port = DEFAULT_PORT }) {
    super()
    this.exePath = exePath
    this.logDir = logDir
    this.port = port
    this.logFile = path.join(logDir, 'helper.log')
    this.child = null
    this.stopping = false
    this.restartTimes = []
    this.watchTimer = null
    this.ensuring = null
    this.state = {
      state: 'stopped', // starting | running | external | stopped | crashed | missing
      source: null, // 'bundled' | 'external'
      version: null,
      port,
      error: null,
    }
  }

  /** What Studio may see (no paths or process ids). */
  status() {
    return { ...this.state }
  }

  setState(patch) {
    this.state = { ...this.state, ...patch }
    this.emit('status', this.status())
  }

  /** Start (or adopt an already-running helper) and keep watching. */
  async start() {
    this.stopping = false
    await this.ensureRunning()
    if (!this.watchTimer && !this.stopping) {
      this.watchTimer = setInterval(() => void this.watch(), WATCH_INTERVAL_MS)
    }
  }

  /** One check-and-start at a time: two overlapping calls would both see a free port and spawn twice. */
  ensureRunning() {
    if (!this.ensuring) {
      this.ensuring = this.doEnsureRunning().finally(() => {
        this.ensuring = null
      })
    }
    return this.ensuring
  }

  async doEnsureRunning() {
    if (this.child || this.stopping) return
    if (await isPortOpen(this.port)) {
      this.setState({ state: 'external', source: 'external', version: null, error: null })
      return
    }
    if (!fs.existsSync(this.exePath)) {
      this.setState({ state: 'missing', source: null, error: 'bundled helper not found' })
      return
    }
    this.spawnBundled()
  }

  spawnBundled() {
    this.openLog()
    this.log(`--- starting ${this.exePath} (port ${this.port}) ---`)
    let child
    try {
      child = spawn(this.exePath, ['start', '--no-update-check', '--port', String(this.port)], {
        cwd: path.dirname(this.exePath),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      })
    } catch (err) {
      // e.g. blocked by security software (spawn UNKNOWN / EPERM).
      this.log(`spawn failed: ${err.message}`)
      this.setState({ state: 'crashed', source: 'bundled', error: err.message })
      return
    }
    this.child = child
    this.setState({ state: 'starting', source: 'bundled', version: null, error: null })

    const onData = (chunk) => {
      const text = chunk.toString('utf8')
      this.logRaw(text)
      if (!this.state.version) {
        for (const line of text.split(/\r?\n/)) {
          const version = parseStartLine(line)
          if (version) {
            this.setState({ version })
            break
          }
        }
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('error', (err) => {
      this.log(`helper process error: ${err.message}`)
      // Never started: no 'exit' will follow, so release it here.
      if (this.child === child && child.pid === undefined) {
        this.child = null
        this.setState({ state: 'crashed', error: err.message })
      }
    })
    child.once('exit', (code, signal) => this.onExit(child, code, signal))
    void this.waitReady(child)
  }

  async waitReady(child) {
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (this.child === child && Date.now() < deadline) {
      if (await isPortOpen(this.port)) {
        if (this.child === child) this.setState({ state: 'running' })
        return
      }
      await new Promise((r) => setTimeout(r, 300))
    }
  }

  onExit(child, code, signal) {
    if (this.child !== child) return
    this.child = null
    this.log(`--- helper exited (code ${code}, signal ${signal}) ---`)
    if (this.stopping) {
      this.setState({ state: 'stopped' })
      return
    }
    const now = Date.now()
    this.restartTimes = this.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS)
    if (this.restartTimes.length >= MAX_RESTARTS) {
      this.setState({ state: 'crashed', error: `exited with code ${code}` })
      return
    }
    this.restartTimes.push(now)
    this.setState({ state: 'starting', error: `exited with code ${code}` })
    setTimeout(() => void this.ensureRunning(), RESTART_DELAY_MS)
  }

  /** Adopted helper went away → start ours. Ours is handled by its exit event. */
  async watch() {
    if (this.stopping || this.child || this.ensuring) return
    if (this.state.state === 'external' && !(await isPortOpen(this.port))) {
      this.log('external helper is gone — starting the bundled helper')
      await this.ensureRunning()
    }
  }

  /** Restart from the app's panel (bundled helper only). Clears a "crashed" state. */
  async restart() {
    if (this.state.state === 'external') return this.status()
    this.restartTimes = []
    if (this.ensuring) await this.ensuring
    await this.kill()
    this.stopping = false
    await this.ensureRunning()
    return this.status()
  }

  kill() {
    const child = this.child
    if (!child) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      this.stopping = true
      child.kill()
    })
  }

  /** True while the bundled helper process is running or starting. */
  isBundledRunning() {
    return this.child !== null || this.ensuring !== null
  }

  /** App quit: stop the bundled helper (an adopted one is left running). */
  async stop() {
    this.stopping = true
    if (this.watchTimer) clearInterval(this.watchTimer)
    this.watchTimer = null
    if (this.ensuring) await this.ensuring
    await this.kill()
    this.closeLog()
  }

  openLog() {
    if (this.logStream) return
    try {
      fs.mkdirSync(this.logDir, { recursive: true })
      if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size > LOG_ROTATE_BYTES) {
        fs.renameSync(this.logFile, path.join(this.logDir, 'helper.old.log'))
      }
      const stream = fs.createWriteStream(this.logFile, { flags: 'a' })
      // A locked or unwritable log must not take the app down: just stop logging.
      stream.on('error', () => {
        if (this.logStream === stream) this.logStream = null
      })
      this.logStream = stream
    } catch {
      this.logStream = null
    }
  }

  closeLog() {
    this.logStream?.end()
    this.logStream = null
  }

  logRaw(text) {
    this.logStream?.write(text)
  }

  log(line) {
    this.logRaw(`[${new Date().toISOString()}] ${line}\n`)
  }
}

module.exports = { HelperProcess, isPortOpen, parseStartLine, DEFAULT_PORT }
