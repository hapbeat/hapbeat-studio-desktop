'use strict'
// PC sound → Hapbeat. Studio's "PC sound" button calls getDisplayMedia from the click,
// and the app answers with the system audio itself (Windows WASAPI loopback): no
// screen picker, no virtual audio driver. getDisplayMedia always comes with a video
// track, so that track is Studio's own page, which Studio stops at once — nothing
// else on the screen is captured.

const { isStudioOrigin } = require('./urls')

/** Electron captures what the PC plays (loopback) on Windows only. */
function systemAudioSupported(platform = process.platform) {
  return platform === 'win32'
}

function frameUrl(frame) {
  try {
    return frame.url
  } catch {
    return '' // destroyed frame
  }
}

/**
 * getDisplayMedia first asks the 'media' permission with no media types (a camera
 * or microphone request names 'video' / 'audio', and stays refused). Letting this
 * one through only hands the request to `systemAudioGrant`, which decides.
 */
function isDisplayCaptureRequest(permission, details, platform = process.platform) {
  return systemAudioSupported(platform)
    && permission === 'media'
    && details?.isMainFrame === true
    && Array.isArray(details.mediaTypes) && details.mediaTypes.length === 0
}

/**
 * The streams for a getDisplayMedia request (`setDisplayMediaRequestHandler`), or
 * null to refuse it. Only Studio's own top-level page gets them, from a click, and
 * only when it asked for audio. (A subframe's grant would capture the whole page it
 * sits in.)
 */
function systemAudioGrant(request, studioUrl, platform = process.platform) {
  const frame = request?.frame
  if (!systemAudioSupported(platform) || !frame || frame.parent) return null
  if (!request.audioRequested || !request.userGesture) return null
  if (!isStudioOrigin(request.securityOrigin, studioUrl) || !isStudioOrigin(frameUrl(frame), studioUrl)) return null
  return { video: frame, audio: 'loopback' }
}

module.exports = { systemAudioSupported, isDisplayCaptureRequest, systemAudioGrant }
