// player.js — drives the <audio> element from replicated playback state.
//
// Position is ALWAYS derived from server time, never from the audio element:
//   PLAYING: serverNow() - startedAt      PAUSED: pausedAt - startedAt
// That keeps the progress bar, drift correction, and host auto-advance working
// even when the audio itself is unavailable (e.g. empty R2 bucket -> 404s).

import { serverNow, isSynced } from './clock.js';
import { state, subscribe, trackInfo } from './state.js';
import { getTrackUrl } from './api.js';

const DRIFT_HARD_SEEK_S = 1.0;   // cycle 1: hard seek beyond this
const TICK_MS = 250;             // setInterval (not rAF) so the host keeps advancing in background tabs
const ADVANCE_RETRY_MS = 3000;
const NUDGE_ABOVE_S = 0.06;      // start rate-correcting beyond 60ms
const NUDGE_RELEASE_S = 0.02;    // back to 1.0 once inside 20ms (hysteresis band 20–60ms)
const NUDGE_GAIN = 0.3;          // rate offset per second of drift
const NUDGE_MAX = 0.05;          // ±5% cap — inaudible with preservesPitch
const DEBUG = new URLSearchParams(location.search).get('debug') === '1';

let audio = null;
let sendCommand = null;
let overlay = null;

let loadedTrackId = null;  // track whose URL we've requested / set
let loadToken = 0;         // guards against out-of-order URL fetches
let audioAvailable = false;
let unlocked = false;      // user gesture has allowed playback at least once
let advancedKey = null;    // "trackId@startedAt" we've already sent an auto-SKIP for

const statusListeners = new Set();
let audioStatus = 'none';  // 'none' | 'loading' | 'ok' | 'unavailable'

function setAudioStatus(s) {
  if (s === audioStatus) return;
  audioStatus = s;
  for (const fn of statusListeners) fn(s);
}

export function onAudioStatus(fn) {
  statusListeners.add(fn);
  fn(audioStatus);
  return () => statusListeners.delete(fn);
}

/** Current position in ms, from server time. null when IDLE. */
export function positionMs(pb = state.playback) {
  if (!pb || !pb.currentTrackId || pb.startedAt == null) return null;
  if (pb.status === 'PLAYING') return Math.max(0, serverNow() - pb.startedAt);
  if (pb.status === 'PAUSED' && pb.pausedAt != null) return Math.max(0, pb.pausedAt - pb.startedAt);
  return 0;
}

export function durationMs(trackId = state.playback.currentTrackId) {
  if (!trackId) return 0;
  return trackInfo(trackId).durationMs || 0;
}

// ---------- loading ----------

async function loadTrack(trackId) {
  const token = ++loadToken;
  loadedTrackId = trackId;
  audioAvailable = false;
  audio.playbackRate = 1;

  if (!trackId) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    setAudioStatus('none');
    return;
  }

  setAudioStatus('loading');
  try {
    const { url } = await getTrackUrl(trackId);
    if (token !== loadToken) return; // superseded by a newer track
    audio.src = url;
    audio.dataset.token = String(token);
    audio.load();
    // currentTime is applied again on loadedmetadata; setting it early is harmless.
    seekToExpected();
    syncPlayState();
  } catch (err) {
    if (token !== loadToken) return;
    markUnavailable();
  }
}

function markUnavailable() {
  audioAvailable = false;
  setAudioStatus('unavailable');
}

function seekToExpected() {
  const pos = positionMs();
  if (pos == null) return;
  audio.playbackRate = 1;
  try { audio.currentTime = pos / 1000; } catch { /* not seekable yet */ }
}

// ---------- play/pause ----------

function syncPlayState() {
  const { status } = state.playback;
  if (status !== 'PLAYING') {
    if (!audio.paused) audio.pause();
    audio.playbackRate = 1;
    if (status === 'PAUSED') seekToExpected();
    return;
  }
  if (audioStatus === 'unavailable' || !audio.getAttribute('src')) return;
  if (!audio.paused) return;
  seekToExpected();
  const p = audio.play();
  if (p && typeof p.catch === 'function') {
    p.then(() => { unlocked = true; hideOverlay(); })
     .catch((err) => {
       if (err && err.name === 'NotAllowedError') showOverlay();
       // AbortError (src changed mid-play) and media errors are handled elsewhere.
     });
  }
}

function showOverlay() {
  if (!overlay || unlocked) return;
  overlay.hidden = false;
}

function hideOverlay() {
  if (overlay) overlay.hidden = true;
}

/** Must be called synchronously inside a user-gesture handler. */
function unlockFromGesture() {
  unlocked = true;
  hideOverlay();
  if (state.playback.status === 'PLAYING' && audio.getAttribute('src') && audioStatus !== 'unavailable') {
    seekToExpected();
    audio.play().catch(() => { /* audio error path will report it */ });
  }
}

// ---------- drift + auto-advance ----------

/**
 * Drift correction: playbackRate nudges for small drift, hard seek only for large.
 *   |d| > 1s        → hard seek, rate 1
 *   |d| > 60ms      → rate = 1 − clamp(d·0.3, ±5%)   (ahead → slow down, behind → speed up)
 *   |d| < 20ms      → rate 1
 *   20–60ms         → keep current rate (hysteresis, avoids flapping around the threshold)
 * @param {number} driftS  audio.currentTime - expected (seconds; + = audio ahead)
 * @param {number} expectedS
 */
function correctDrift(driftS, expectedS) {
  const abs = Math.abs(driftS);
  if (abs > DRIFT_HARD_SEEK_S) {
    audio.playbackRate = 1;
    audio.currentTime = expectedS;
  } else if (abs > NUDGE_ABOVE_S) {
    audio.playbackRate = 1 - Math.min(NUDGE_MAX, Math.max(-NUDGE_MAX, driftS * NUDGE_GAIN));
  } else if (abs < NUDGE_RELEASE_S) {
    if (audio.playbackRate !== 1) audio.playbackRate = 1;
  }
  if (DEBUG) console.debug(`[drift] ${(driftS * 1000).toFixed(0)}ms rate=${audio.playbackRate.toFixed(3)}`);
}

/** Called when a fresh join snapshot lands (incl. reconnect) so a
 *  reconnecting host can auto-advance again. */
export function resetAutoAdvance() {
  advancedKey = null;
}

function hostAdvance(trackId) {
  if (!state.isHost || !trackId) return;
  const key = `${trackId}@${state.playback.startedAt}`;
  if (advancedKey === key) return;
  advancedKey = key;
  sendCommand('SKIP', { expectedTrackId: trackId }, { silent: true }).then((ack) => {
    // STALE_SKIP means someone else already advanced — that's success.
    if (ack && !ack.ok && ack.error && ack.error.code !== 'STALE_SKIP') {
      setTimeout(() => { if (advancedKey === key) advancedKey = null; }, ADVANCE_RETRY_MS);
    }
  });
}

function tick() {
  const pb = state.playback;
  if (pb.status !== 'PLAYING' || !pb.currentTrackId) return;
  const pos = positionMs(pb);
  const dur = durationMs(pb.currentTrackId);

  // Audio unavailable → the host advances on the server-time clock alone.
  // If audio *should* be working, wait a short grace for 'ended' first; the
  // backstop covers a host whose audio is stuck (autoplay blocked, stalled load).
  // Only trusted after the first clock sync — with offset 0 a skewed host clock would skip early.
  const graceMs = audioStatus === 'unavailable' || audioStatus === 'none' ? 0 : 2000;
  if (isSynced() && dur > 0 && pos >= dur + graceMs) {
    hostAdvance(pb.currentTrackId);
    return;
  }

  if (audioAvailable && !audio.paused && !audio.seeking && audio.readyState >= 2) {
    const expectedS = pos / 1000;
    if (Number.isFinite(audio.duration) && expectedS >= audio.duration) return; // let 'ended' fire
    correctDrift(audio.currentTime - expectedS, expectedS);
  }
}

// ---------- wiring ----------

function onPlaybackChange(s, prev) {
  const pb = s.playback;
  const prevPb = prev && prev.playback;
  if (pb.currentTrackId !== loadedTrackId) {
    loadTrack(pb.currentTrackId);
    return;
  }
  if (!prevPb || prevPb.status !== pb.status || prevPb.startedAt !== pb.startedAt || prevPb.pausedAt !== pb.pausedAt) {
    syncPlayState();
  }
}

export function initPlayer({ audioEl, overlayEl, overlayButton, send }) {
  audio = audioEl;
  overlay = overlayEl;
  sendCommand = send;
  // Rate nudges must not shift pitch (default true in modern browsers; set explicitly + legacy prefixes).
  audio.preservesPitch = true;
  audio.mozPreservesPitch = true;
  audio.webkitPreservesPitch = true;

  const isCurrent = () => audio.dataset.token === String(loadToken);

  audio.addEventListener('loadedmetadata', () => {
    if (!isCurrent()) return;
    audioAvailable = true;
    setAudioStatus('ok');
    seekToExpected();
    syncPlayState();
  });
  audio.addEventListener('canplay', () => {
    if (!isCurrent()) return;
    audioAvailable = true;
    setAudioStatus('ok');
  });
  audio.addEventListener('error', () => {
    // Only report errors for the src we actually set (removing src can also fire events).
    if (!audio.getAttribute('src') || !isCurrent()) return;
    markUnavailable();
  });
  audio.addEventListener('ended', () => {
    if (!isCurrent()) return;
    const pb = state.playback;
    if (pb.status === 'PLAYING') hostAdvance(pb.currentTrackId);
  });

  overlayButton.addEventListener('click', unlockFromGesture);

  subscribe(onPlaybackChange);
  setInterval(tick, TICK_MS);
}
