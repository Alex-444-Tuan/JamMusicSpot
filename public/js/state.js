// state.js — the client's replica of room state plus a tiny change emitter.
// Full snapshots (join / resync acks) set the baseline; room:diff messages carry
// {fromVersion, toVersion, ops} and are applied with the server's own shared
// applyOps, strictly in version order. Gaps are buffered briefly, then healed
// by a resync; any inconsistency (DIFF_MISMATCH) also triggers a resync.

import { applyOps } from '/shared/stateDiff.js';

const MAX_BUFFER = 50;   // more out-of-order diffs than this → stop waiting, resync
const GAP_MS = 300;      // how long a version gap may stay open before resync

const listeners = new Set();
let pending = [];        // diffs that can't be applied yet (gap, or before the join snapshot)
let gapTimer = null;
let resyncHandler = null;
let leftoverAt = null;   // version of the last snapshot that left diffs buffered

export const state = {
  lastVersion: -Infinity,
  queue: [],
  playback: { status: 'IDLE', currentTrackId: null, startedAt: null, pausedAt: null },
  isHost: false,
  joined: false,     // true only between a successful jam:join ack and the next disconnect
  me: null,         // {userId, name}
  jamId: null,
  inviteUrl: null,
  catalog: new Map(), // trackId -> {trackId,title,artist,durationMs,color}
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(prev) {
  for (const fn of listeners) {
    try { fn(state, prev); } catch (err) { console.error('[state listener]', err); }
  }
}

/** Full snapshot from jam:join or jam:resync. Applied if not older than what we
 *  hold (equal is harmless), then any buffered diffs that now line up are drained.
 *  Returns true if the snapshot was applied. */
export function applySnapshot(version, changes) {
  if (typeof version !== 'number') return false;
  let applied = false;
  if (version >= state.lastVersion) {
    const prev = { queue: state.queue, playback: state.playback, version: state.lastVersion };
    state.lastVersion = version;
    if (changes && Array.isArray(changes.queue)) state.queue = changes.queue;
    if (changes && changes.playback) state.playback = changes.playback;
    notify(prev);
    applied = true;
  }
  drain();
  // Leftovers ahead of the snapshot may still become applicable: a coalesced
  // V→V+1 can arrive after a V+1→V+2 that beat the ack, so keep them and let
  // drain()'s gap timer resync if the hole never fills. But if a second
  // snapshot lands at the same version with leftovers still stuck, they can
  // never apply (e.g. versions from before a server-side reset) — drop them
  // so the gap timer can't re-trigger resync forever.
  if (pending.length) {
    if (leftoverAt === state.lastVersion) {
      pending = [];
      clearGapTimer();
      leftoverAt = null;
    } else {
      leftoverAt = state.lastVersion;
    }
  } else {
    leftoverAt = null;
  }
  return applied;
}

/** Registered by app.js: asks the server for a fresh snapshot (jam:resync). */
export function setResyncHandler(fn) {
  resyncHandler = fn;
}

function requestResync() {
  clearGapTimer();
  if (resyncHandler) resyncHandler();
}

function clearGapTimer() {
  if (gapTimer) clearTimeout(gapTimer);
  gapTimer = null;
}

/** Applies one contiguous diff. Returns false (and requests a resync) on mismatch. */
function applyOne(d) {
  let next;
  try {
    next = applyOps({ queue: state.queue, playback: state.playback }, d.ops);
  } catch (err) {
    console.warn('[state] diff rejected, resyncing:', err && err.message);
    requestResync();
    return false;
  }
  const prev = { queue: state.queue, playback: state.playback, version: state.lastVersion };
  state.lastVersion = d.toVersion;
  state.queue = next.queue;
  state.playback = next.playback;
  notify(prev);
  return true;
}

/** Applies every buffered diff that is now contiguous; keeps the gap timer
 *  running only while something is still waiting on a missing version. */
function drain() {
  if (state.lastVersion === -Infinity) return; // still waiting for the join snapshot
  let progressed = true;
  while (progressed) {
    progressed = false;
    pending = pending.filter((d) => d.toVersion > state.lastVersion);
    const i = pending.findIndex((d) => d.fromVersion === state.lastVersion);
    if (i !== -1) {
      const [d] = pending.splice(i, 1);
      if (!applyOne(d)) return;
      progressed = true;
    } else if (pending.some((d) => d.fromVersion < state.lastVersion)) {
      // A coalesced diff straddles our version — ops can't be partially applied.
      pending = pending.filter((d) => d.fromVersion > state.lastVersion);
      return requestResync();
    }
  }
  if (pending.length === 0) clearGapTimer();
  else if (!gapTimer) gapTimer = setTimeout(() => { gapTimer = null; requestResync(); }, GAP_MS);
}

/** Handles a room:diff {fromVersion, toVersion, ops}. */
export function applyDiff(d) {
  if (!d || typeof d.fromVersion !== 'number' || typeof d.toVersion !== 'number' || !Array.isArray(d.ops)) return;
  if (d.toVersion <= state.lastVersion) return; // already covered
  if (pending.length >= MAX_BUFFER) {
    pending = [];
    return requestResync();
  }
  pending.push(d);
  drain();
}

/** Called on every (re)connect before jam:join. Forgets the version watermark
 *  and any buffered diffs (not the rendered state), so the join-ack snapshot is
 *  accepted even if the server's counter went backwards (e.g. Redis was flushed
 *  while we were disconnected). Diffs arriving before the ack are buffered and
 *  drained once the snapshot lands. */
export function resetVersion() {
  state.lastVersion = -Infinity;
  pending = [];
  leftoverAt = null;
  clearGapTimer();
}

export function resetForJam(jamId) {
  state.jamId = jamId;
  resetVersion();
  state.queue = [];
  state.playback = { status: 'IDLE', currentTrackId: null, startedAt: null, pausedAt: null };
  state.isHost = false;
}

export function setJoinInfo({ isHost, you }) {
  const prev = { queue: state.queue, playback: state.playback, version: state.lastVersion };
  state.isHost = !!isHost;
  if (you) state.me = you;
  notify(prev);
}

export function setJoined(joined) {
  if (state.joined === !!joined) return;
  state.joined = !!joined;
  notify({ queue: state.queue, playback: state.playback, version: state.lastVersion });
}

export function setCatalog(tracks) {
  state.catalog = new Map(tracks.map((t) => [t.trackId, t]));
  notify({ queue: state.queue, playback: state.playback, version: state.lastVersion });
}

export function trackInfo(trackId) {
  return state.catalog.get(trackId) || { trackId, title: trackId, artist: 'Unknown artist', durationMs: 0, color: '#6c5ce7' };
}
