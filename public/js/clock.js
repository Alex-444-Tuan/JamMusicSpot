// clock.js — Cristian's algorithm against the server's 'clock:sync' handler.
// Take several samples, keep the one with the lowest round-trip time (least
// queuing noise), and assume the reply spent rtt/2 in flight:
//   offset = (serverTime + rtt/2) - t1      (t1 = local time when the reply lands)
// serverNow() = Date.now() + offset.

const SAMPLES = 5;
const SAMPLE_GAP_MS = 100;
const RESYNC_MS = 30_000;
const SAMPLE_TIMEOUT_MS = 3_000;
const MAX_RTT_MS = 1_000; // samples slower than this carry too much asymmetry error to trust

let offset = 0;
let synced = false;
let lowConfidence = false; // offset came from a sample with rtt > MAX_RTT_MS
let syncListener = null;
let resyncTimer = null;
let inFlight = null;

export function serverNow() {
  return Date.now() + offset;
}

export function isSynced() {
  return synced;
}

export function isLowConfidence() {
  return lowConfidence;
}

/** Single listener, called after every sync round (used for the connection badge). */
export function onSyncChange(fn) {
  syncListener = fn;
}

export function getOffset() {
  return offset;
}

function sampleOnce(socket) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const timer = setTimeout(() => { done = true; resolve(null); }, SAMPLE_TIMEOUT_MS);
    socket.emit('clock:sync', {}, (reply) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const t1 = Date.now();
      if (!reply || typeof reply.serverTime !== 'number') return resolve(null);
      const rtt = t1 - t0;
      resolve({ rtt, offset: reply.serverTime + rtt / 2 - t1 });
    });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs one sync round (SAMPLES samples). Concurrent callers share the round. */
export function syncClock(socket) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    let best = null;    // lowest RTT among trustworthy samples (rtt ≤ MAX_RTT_MS)
    let bestAny = null; // lowest RTT among all samples
    for (let i = 0; i < SAMPLES; i++) {
      if (!socket.connected) break;
      const s = await sampleOnce(socket);
      if (s && (!bestAny || s.rtt < bestAny.rtt)) bestAny = s;
      if (s && s.rtt <= MAX_RTT_MS && (!best || s.rtt < best.rtt)) best = s;
      if (i < SAMPLES - 1) await wait(SAMPLE_GAP_MS);
    }
    if (best) {
      offset = best.offset;
      synced = true;
      lowConfidence = false;
    } else if (bestAny && !synced) {
      // Very slow link: an imprecise offset beats never syncing (which would block
      // host auto-advance). Never overwrites a good offset; a later good round upgrades it.
      offset = bestAny.offset;
      synced = true;
      lowConfidence = true;
    }
    if (syncListener) syncListener();
    return best || bestAny;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

/** Periodic resync so slow local clock drift doesn't accumulate. */
export function startClockSync(socket) {
  stopClockSync();
  resyncTimer = setInterval(() => {
    if (socket.connected) syncClock(socket);
  }, RESYNC_MS);
  return syncClock(socket);
}

export function stopClockSync() {
  if (resyncTimer) clearInterval(resyncTimer);
  resyncTimer = null;
}
