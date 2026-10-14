'use strict'
// Which page the app shows, and which URLs count as "Studio".

const DEFAULT_STUDIO_URL = 'https://studio.hapbeat.com/'

/**
 * The Studio page the window loads: the online Studio (latest deploy), marked with
 * `?shell=desktop` so Studio shows its desktop layout. HAPBEAT_STUDIO_URL points the
 * app at another build (a dev server or the staging deploy) for testing.
 */
function resolveStudioUrl(env = process.env) {
  const url = new URL(env.HAPBEAT_STUDIO_URL || DEFAULT_STUDIO_URL)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`HAPBEAT_STUDIO_URL must be http(s): ${url.href}`)
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
