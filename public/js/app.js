// app.js — routing + socket lifecycle. Screens: landing → name → room.

import * as api from './api.js';
import { getUser, setName, getHostToken, saveHostToken, clearHostToken } from './identity.js';
import { startClockSync, stopClockSync, syncClock, isLowConfidence, onSyncChange } from './clock.js';
import { canAnimate } from './motion.js';
import { state, applySnapshot, applyDiff, setResyncHandler, resetForJam, resetVersion, setJoinInfo, setJoined, setCatalog } from './state.js';
import { initPlayer, resetAutoAdvance } from './player.js';
import { initToasts, toast, friendlyMessage } from './ui/toast.js';
import { initNowPlaying } from './ui/nowPlaying.js';
import { initQueue } from './ui/queue.js';
import { initCatalog } from './ui/catalog.js';
import { initControls } from './ui/controls.js';

const ACK_TIMEOUT_MS = 8000;
const $ = (sel) => document.querySelector(sel);

const gsap = window.gsap;
const JOIN_BACKOFF_MAX_MS = 15000;

let socket = null;
let roomUiReady = false;
let epoch = 0;             // bumped on every connect; acks from older epochs are ignored
let joinRetryTimer = null;
let joinBackoffMs = 1000;  // 1s, 2s, 4s… capped at JOIN_BACKOFF_MAX_MS; reset on join success
let joinErrorToasted = false; // one toast per join-retry series; reset on join success
let visibilityBound = false;
let resyncInFlight = false;
let resyncTimer = null;
let resyncBackoffMs = 1000; // 1s, 2s, 4s… capped at RESYNC_BACKOFF_MAX_MS; reset on success
const RESYNC_BACKOFF_MAX_MS = 15000;

// ---------- screens ----------

function showScreen(id) {
  for (const el of document.querySelectorAll('[data-screen]')) {
    el.hidden = el.id !== id;
  }
  const el = document.getElementById(id);
  if (canAnimate()) {
    gsap.from(el, { autoAlpha: 0, y: 16, duration: 0.45, ease: 'power3.out', clearProps: 'opacity,visibility,transform' });
    const kids = el.querySelectorAll('[data-enter]');
    if (kids.length) gsap.from(kids, { autoAlpha: 0, y: 12, duration: 0.4, stagger: 0.06, delay: 0.08, ease: 'power2.out', clearProps: 'opacity,visibility,transform' });
  }
  const focusTarget = el.querySelector('[autofocus], input, button');
  if (focusTarget) focusTarget.focus({ preventScroll: true });
}

function showLanding(notice) {
  const n = $('#landing-notice');
  n.textContent = notice || '';
  n.hidden = !notice;
  document.title = 'JamMusicSpot';
  showScreen('screen-landing');
}

function showNameEntry(jamId) {
  $('#name-jam-code').textContent = jamId;
  const input = $('#name-input');
  input.value = getUser().name || '';
  $('#name-host-hint').hidden = !getHostToken(jamId);
  showScreen('screen-name');
  input.select();
}

// ---------- commands ----------

/** Always resolves with an ack object; toasts failures unless silent. */
function sendCommand(type, payload = {}, { silent = false } = {}) {
  return new Promise((resolve) => {
    if (!socket || !socket.connected || !state.joined) {
      const code = socket && socket.connected ? 'NOT_JOINED' : 'DISCONNECTED';
      const ack = { ok: false, error: { code, message: 'Not joined' } };
      if (!silent) toast(friendlyMessage(ack.error), 'error');
      return resolve(ack);
    }
    socket.timeout(ACK_TIMEOUT_MS).emit('room:command', { type, payload }, (err, ack) => {
      if (err) ack = { ok: false, error: { code: 'TIMEOUT', message: 'No response' } };
      if (!ack || typeof ack !== 'object') ack = { ok: false, error: { code: 'INTERNAL', message: 'Bad response' } };
      if (!ack.ok && ack.error && ack.error.code === 'JAM_NOT_FOUND') {
        handleJamGone();
        return resolve(ack);
      }
      if (!ack.ok && !silent) {
        toast(friendlyMessage(ack.error), ack.error && ack.error.code === 'STALE_SKIP' ? 'info' : 'error');
      }
      resolve(ack);
    });
  });
}

// ---------- room ----------

function setConnectionBadge(status) {
  const b = $('#conn-badge');
  b.dataset.state = status;
  b.textContent = status === 'live' ? (isLowConfidence() ? '~Live' : 'Live') : status === 'connecting' ? 'Connecting…' : 'Offline';
  b.title = status === 'live' && isLowConfidence() ? 'Slow connection — sync is approximate' : '';
}
onSyncChange(() => {
  const b = $('#conn-badge');
  if (b && b.dataset.state === 'live') setConnectionBadge('live');
});

function initRoomUi() {
  if (roomUiReady) return;
  roomUiReady = true;
  initPlayer({
    audioEl: $('#audio'),
    overlayEl: $('#tune-in'),
    overlayButton: $('#tune-in-btn'),
    send: sendCommand,
  });
  initNowPlaying($('#now-playing'));
  initQueue({ listEl: $('#queue-list'), emptyEl: $('#queue-empty'), countBadge: $('#queue-count'), sendCommand });
  initCatalog({ listEl: $('#catalog-list'), searchEl: $('#catalog-search'), sendCommand });
  initControls({ root: $('#controls'), sendCommand });
  $('#invite-btn').addEventListener('click', copyInvite);
}

function inviteLink() {
  const path = state.inviteUrl || `/?jam=${encodeURIComponent(state.jamId)}`;
  return location.origin + path;
}

async function copyInvite() {
  const link = inviteLink();
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(link);
      return toast('Invite link copied', 'success');
    }
  } catch { /* fall through */ }
  // Non-secure context (LAN http): legacy execCommand via a hidden textarea.
  const ta = document.createElement('textarea');
  ta.value = link;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  if (ok) toast('Invite link copied', 'success');
  else window.prompt('Copy this invite link:', link);
}

async function loadCatalog() {
  try {
    const { tracks } = await api.getCatalog();
    setCatalog(Array.isArray(tracks) ? tracks : []);
  } catch (err) {
    toast(`Couldn't load the catalog: ${friendlyMessage(err)}`, 'error');
  }
}

function clearJoinRetry() {
  if (joinRetryTimer) clearTimeout(joinRetryTimer);
  joinRetryTimer = null;
  // Same lifecycle for resync: any pending/in-flight resync belongs to the old connection.
  if (resyncTimer) clearTimeout(resyncTimer);
  resyncTimer = null;
  resyncInFlight = false;
}

function teardownSocket() {
  clearJoinRetry();
  setJoined(false);
  stopClockSync();
  if (socket) {
    socket.removeAllListeners();
    socket.io.removeAllListeners('reconnect_attempt');
    socket.disconnect();
  }
  socket = null;
}

/** The jam was deleted server-side: drop the connection and go back to landing. */
function handleJamGone() {
  teardownSocket();
  history.replaceState(null, '', '/');
  showLanding('Jam not found — it may have ended. Start a new one?');
}

function setRole(isHost) {
  setJoinInfo({ isHost });
  $('#role-badge').textContent = isHost ? 'Host' : 'Guest';
}

function joinJam(myEpoch) {
  const me = getUser();
  const msg = { jamId: state.jamId, userId: me.userId, name: me.name };
  const hostToken = getHostToken(state.jamId);
  if (hostToken) msg.hostToken = hostToken;
  const sock = socket;

  // Exponential backoff retry, bound to this connection epoch. If we're no longer
  // connected, the next 'connect' re-joins anyway.
  const scheduleRetry = () => {
    if (!sock.connected) return;
    setConnectionBadge('offline');
    clearJoinRetry();
    const delay = joinBackoffMs;
    joinBackoffMs = Math.min(joinBackoffMs * 2, JOIN_BACKOFF_MAX_MS);
    joinRetryTimer = setTimeout(() => {
      joinRetryTimer = null;
      if (myEpoch === epoch && sock === socket && sock.connected) joinJam(myEpoch);
    }, delay);
  };

  sock.timeout(ACK_TIMEOUT_MS).emit('jam:join', msg, (err, ack) => {
    if (myEpoch !== epoch || sock !== socket) return; // ack from a previous connection
    if (err) return scheduleRetry(); // ack timeout while connected
    if (!ack || !ack.ok) {
      const e = (ack && ack.error) || { code: 'INTERNAL' };
      if (e.code === 'JAM_NOT_FOUND') return handleJamGone();
      if (e.code === 'INTERNAL' || e.code === 'BUSY') {
        // Transient (e.g. room lock held): retry with backoff, toast once per series.
        if (!joinErrorToasted) toast(friendlyMessage(e), 'error');
        joinErrorToasted = true;
        return scheduleRetry();
      }
      toast(friendlyMessage(e), 'error');
      if (e.code === 'BAD_REQUEST') {
        // e.g. a name the server rejects: drop the socket so re-submitting reconnects cleanly.
        teardownSocket();
        setConnectionBadge('offline');
        return showNameEntry(state.jamId);
      }
      return;
    }
    joinBackoffMs = 1000;
    joinErrorToasted = false;
    setConnectionBadge('live');
    resetAutoAdvance();
    setJoined(true);
    // The token we hold may be stale (host moved on while we were away): only
    // keep one the server just confirmed.
    if (ack.isHost && ack.hostToken) saveHostToken(state.jamId, ack.hostToken);
    else if (!ack.isHost) clearHostToken(state.jamId);
    setJoinInfo({ isHost: ack.isHost, you: ack.you });
    $('#role-badge').textContent = ack.isHost ? 'Host' : 'Guest';
    const snap = ack.snapshot || {};
    applySnapshot(snap.version, { queue: snap.queue, playback: snap.playback });
  });
}

/** Fetches a fresh full snapshot (jam:resync) after a version gap or a diff
 *  that didn't apply cleanly. Bound to the connection epoch; BUSY / INTERNAL /
 *  timeout retry with backoff (1s doubling to 15s, same as join); NOT_JOINED
 *  re-runs the join; JAM_NOT_FOUND → handleJamGone. Silent (no toasts). */
function resync() {
  if (!socket || !socket.connected || !state.joined || resyncInFlight || resyncTimer) return;
  const myEpoch = epoch;
  const sock = socket;
  resyncInFlight = true;
  sock.timeout(ACK_TIMEOUT_MS).emit('jam:resync', {}, (err, ack) => {
    if (myEpoch !== epoch || sock !== socket) return; // ack from a previous connection
    resyncInFlight = false;
    if (!err && ack && ack.ok && ack.snapshot) {
      resyncBackoffMs = 1000;
      const snap = ack.snapshot;
      applySnapshot(snap.version, { queue: snap.queue, playback: snap.playback });
      return;
    }
    const code = err ? 'TIMEOUT' : (ack && ack.error && ack.error.code) || 'INTERNAL';
    if (code === 'JAM_NOT_FOUND') return handleJamGone();
    if (code === 'NOT_JOINED') {
      // Server lost our membership (e.g. it restarted without dropping the socket): rejoin.
      setJoined(false);
      resetVersion();
      return joinJam(myEpoch);
    }
    const delay = resyncBackoffMs;
    resyncBackoffMs = Math.min(resyncBackoffMs * 2, RESYNC_BACKOFF_MAX_MS);
    resyncTimer = setTimeout(() => {
      resyncTimer = null;
      if (myEpoch === epoch && sock === socket) resync();
    }, delay);
  });
}
setResyncHandler(resync);

function enterRoom() {
  state.me = { ...getUser() }; // replaced by the server's `you` on join ack
  initRoomUi();
  $('#room-code').textContent = state.jamId;
  document.title = `Jam ${state.jamId} · JamMusicSpot`;
  showScreen('screen-room');
  loadCatalog();

  if (socket) return;
  setConnectionBadge('connecting');
  // forceNew: after a teardown, don't get the cached (listener-stripped) socket back from io()'s manager cache.
  // websocket only: long-polling across several Fly machines would need sticky sessions.
  socket = window.io({ transports: ['websocket'], forceNew: true });

  socket.on('connect', () => {
    epoch++;
    clearJoinRetry();
    setJoined(false);
    resetVersion();
    joinJam(epoch); // re-emitted on EVERY connect, so reconnects re-join the room
    startClockSync(socket);
  });
  socket.on('disconnect', () => {
    epoch++; // invalidates any in-flight join ack
    clearJoinRetry();
    setJoined(false);
    setConnectionBadge('offline');
  });
  socket.io.on('reconnect_attempt', () => setConnectionBadge('connecting'));
  socket.on('room:diff', applyDiff); // {fromVersion, toVersion, ops}
  socket.on('jam:error', (e) => toast(friendlyMessage(e), 'error'));
  // Host succession. The new host alone gets the fresh token; it hands it to
  // its socket (jam:claimHost) so host-only commands are accepted. If we
  // reconnect first, the next jam:join sends the saved token instead.
  socket.on('jam:promoted', (e) => {
    if (!e || e.jamId !== state.jamId || typeof e.hostToken !== 'string') return;
    saveHostToken(state.jamId, e.hostToken);
    const sock = socket;
    const myEpoch = epoch;
    sock.timeout(ACK_TIMEOUT_MS).emit('jam:claimHost', { hostToken: e.hostToken }, (err, ack) => {
      if (myEpoch !== epoch || sock !== socket) return;
      if (!err && ack && ack.ok && ack.isHost) {
        setRole(true);
        toast("The host left, so you're the host now", 'info');
      }
    });
  });
  socket.on('jam:host', (e) => {
    if (!e || !state.me || e.hostUserId === state.me.userId) return; // ours arrives as jam:promoted
    if (state.isHost) {
      clearHostToken(state.jamId);
      setRole(false);
    }
    toast(`${e.hostName || 'Someone'} is now the host`, 'info');
  });

  if (!visibilityBound) {
    visibilityBound = true;
    // Tabs throttle timers in the background; resync when we come back.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && socket && socket.connected) syncClock(socket);
    });
  }
}

// ---------- routing ----------

async function startJam(button) {
  button.disabled = true;
  try {
    const { jamId, hostToken, inviteUrl } = await api.createJam();
    saveHostToken(jamId, hostToken);
    resetForJam(jamId);
    state.inviteUrl = inviteUrl || null;
    history.replaceState(null, '', `/?jam=${encodeURIComponent(jamId)}`);
    showNameEntry(jamId);
  } catch (err) {
    toast(`Couldn't start a jam: ${friendlyMessage(err)}`, 'error');
  } finally {
    button.disabled = false;
  }
}

async function route() {
  const jamId = new URLSearchParams(location.search).get('jam');
  if (!jamId) return showLanding();
  try {
    await api.getJam(jamId);
  } catch (err) {
    if (err.code === 'JAM_NOT_FOUND' || err.status === 404) {
      history.replaceState(null, '', '/');
      return showLanding(`Jam “${jamId}” not found. Start a new one?`);
    }
    toast(friendlyMessage(err), 'error');
    return showLanding();
  }
  resetForJam(jamId);
  showNameEntry(jamId);
}

function bindStaticUi() {
  initToasts($('#toasts'));

  for (const btn of document.querySelectorAll('[data-action="start"]')) {
    btn.addEventListener('click', () => startJam(btn));
  }

  $('#join-code-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('#join-code-input').value.trim().toUpperCase();
    if (!code) return;
    history.replaceState(null, '', `/?jam=${encodeURIComponent(code)}`);
    route();
  });

  $('#name-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#name-input').value.trim().slice(0, 32);
    if (!name) {
      $('#name-input').focus();
      return toast('Pick a name so others know who added what', 'info');
    }
    setName(name);
    enterRoom();
  });

  $('#leave-btn').addEventListener('click', () => {
    location.href = '/';
  });
}

bindStaticUi();
route();
