'use strict'
// Which page the app shows, and which URLs count as "Studio".

const DEFAULT_STUDIO_URL = 'https://studio.hapbeat.com/'

/** Hosts an installed app may be pointed at with HAPBEAT_STUDIO_URL (a development run takes any). */
function isAllowedOverrideHost(url) {
  const host = url.hostname.toLowerCase()
  if (url.protocol === 'https:' && (host === 'hapbeat.com' || host.endsWith('.hapbeat.com'))) return true
  return host === 'localhost' || host === '127.0.0.1'
}

/**
 * The Studio page the window loads: the online Studio (latest deploy), marked with
 * `?shell=desktop` so Studio shows its desktop layout. HAPBEAT_STUDIO_URL points the
 * app at another build (a dev server, or another hapbeat.com deploy in an installed app).
 */
function resolveStudioUrl(env = process.env, { packaged = false } = {}) {
  let url = new URL(DEFAULT_STUDIO_URL)
  if (env.HAPBEAT_STUDIO_URL) {
    const wanted = new URL(env.HAPBEAT_STUDIO_URL)
    if (wanted.protocol !== 'https:' && wanted.protocol !== 'http:') {
      throw new Error(`HAPBEAT_STUDIO_URL must be http(s): ${wanted.href}`)
    }
    if (!packaged || isAllowedOverrideHost(wanted)) url = wanted
  }
  url.searchParams.set('shell', 'desktop')
  return url
}

/** True when `target` (a URL string or an origin) is on the Studio origin. */
function isStudioOrigin(target, studioUrl) {
  if (!target) return false
  try {
    return new URL(target).origin === studioUrl.origin
  } catch {
    return false
  }
}

/** Web links leave the app and open in the default browser. */
function isExternalWebUrl(target) {
  try {
    const { protocol } = new URL(target)
    return protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:'
  } catch {
    return false
  }
}

module.exports = { DEFAULT_STUDIO_URL, resolveStudioUrl, isStudioOrigin, isExternalWebUrl }
