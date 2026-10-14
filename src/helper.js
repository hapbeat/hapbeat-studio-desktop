'use strict'
// Runs the Hapbeat Helper bundled with the app (resources/helper/hapbeat-helper.exe).
//
// Studio talks to the helper on ws://localhost:7703 exactly as in the browser. When
// something already listens there (a pipx-installed helper, or another copy of the
// app), the app uses it and starts nothing; if that one goes away, the bundled helper
// takes over. The bundled helper stops when the app quits.

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
    this.state = {
      state: 'stopped', // starting | running | external | stopped | crashed | missing
      source: null, // 'bundled' | 'external'
      version: null,
      pid: null,
      port,
      logFile: this.logFile,
      error: null,
    }
  }

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
    if (!this.watchTimer) {
      this.watchTimer = setInterval(() => void this.watch(), WATCH_INTERVAL_MS)
    }
  }

  async ensureRunning() {
    if (this.child) return
    if (await isPortOpen(this.port)) {
      this.setState({ state: 'external', source: 'external', version: null, pid: null, error: null })
      return
    }
    if (!fs.existsSync(this.exePath)) {
      this.setState({ state: 'missing', source: null, pid: null, error: `not found: ${this.exePath}` })
      return
    }
    this.spawnBundled()
  }

  spawnBundled() {
    this.openLog()
    this.log(`--- starting ${this.exePath} (port ${this.port}) ---`)
    const child = spawn(this.exePath, ['start', '--no-update-check', '--port', String(this.port)], {
      cwd: path.dirname(this.exePath),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
    })
    this.child = child
    this.setState({ state: 'starting', source: 'bundled', version: null, pid: child.pid ?? null, error: null })

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
      this.log(`spawn error: ${err.message}`)
      this.setState({ error: err.message })
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
      this.setState({ state: 'stopped', pid: null })
      return
    }
    const now = Date.now()
    this.restartTimes = this.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS)
    if (this.restartTimes.length >= MAX_RESTARTS) {
      this.setState({ state: 'crashed', pid: null, error: `exited with code ${code}` })
      return
    }
    this.restartTimes.push(now)
    this.setState({ state: 'starting', pid: null, error: `exited with code ${code}` })
    setTimeout(() => {
      if (!this.stopping) void this.ensureRunning()
    }, RESTART_DELAY_MS)
  }

  /** Adopted helper went away → start ours. Ours is handled by its exit event. */
  async watch() {
    if (this.stopping || this.child) return
    if (this.state.state === 'external' && !(await isPortOpen(this.port))) {
      this.log('external helper is gone — starting the bundled helper')
      await this.ensureRunning()
    }
  }

  /** Restart from the app's helper panel. Clears a "crashed" state. */
  async restart() {
    this.restartTimes = []
    if (this.child) {
      await this.kill()
    }
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

  /** App quit: stop the bundled helper (an adopted one is left running). */
  async stop() {
    this.stopping = true
    if (this.watchTimer) clearInterval(this.watchTimer)
    this.watchTimer = null
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
      this.logStream = fs.createWriteStream(this.logFile, { flags: 'a' })
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
