// Two full server instances (createJamServer, port 0) sharing one local
// Redis — the horizontally scaled deployment in miniature. Socket.IO's
// Redis adapter fans room:diff out across instances; the Redis room lock
// serializes commands across them. Mongo and R2 are faked.
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { io as connect } from 'socket.io-client';
import Redis from 'ioredis';
import { createJamServer } from '../app.js';
import { applyOps } from '../domain/stateDiff.js';
import { catalog } from '../catalog/catalog.js';

const COALESCE_MS = 20;
let A;
let B;
let redis;
const sockets = [];
const jams = [];

async function startInstance() {
  const server = createJamServer({
    config: { coalesceMs: COALESCE_MS },
    overrides: {
      commandLog: { appendMany: async () => {}, ensureIndexes: async () => {} },
      storage: { getURL: async (key) => `https://signed.example/${key}` },
    },
  });
  const { port } = await server.listen(0, '127.0.0.1');
  return { server, url: `http://127.0.0.1:${port}` };
}

beforeAll(async () => {
  redis = new Redis();
  [A, B] = await Promise.all([startInstance(), startInstance()]);
});

afterAll(async () => {
  await Promise.all([A.server.shutdown(), B.server.shutdown()]);
  await redis.quit();
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  for (const jamId of jams.splice(0)) {
    const keys = await redis.keys(`room:${jamId}:*`);
    if (keys.length) await redis.del(...keys);
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs = 3000, what = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), 8000);
    socket.emit(event, payload, (res) => { clearTimeout(timer); resolve(res); });
  });
}

async function createJam(instance) {
  const res = await fetch(`${instance.url}/api/jams`, { method: 'POST' });
  const jam = await res.json();
  jams.push(jam.jamId);
  return jam;
}

// A client that tracks room state purely from its join snapshot + diffs,
// the way the browser does: apply a diff that continues from its version,
// ignore one it has already covered, resync on any gap.
async function joinClient(instance, jam, { userId, name, host = false }) {
  const socket = connect(instance.url, { transports: ['websocket'], forceNew: true, reconnection: false });
  sockets.push(socket);
  const client = { socket, state: null, history: [], resyncs: 0, diffsApplied: 0, errors: [] };
  let busy = Promise.resolve();

  function adopt(snapshot, via) {
    if (client.state && snapshot.version <= client.state.version) return;
    client.state = snapshot;
    client.history.push({ via, version: snapshot.version });
  }

  async function resync() {
    client.resyncs++;
    const res = await emitAck(socket, 'jam:resync', {});
    if (!res.ok) throw new Error(`resync failed: ${res.error.code}`);
    adopt(res.snapshot, 'resync');
  }

  socket.on('room:diff', (diff) => {
    busy = busy.then(async () => {
      const current = client.state;
      if (diff.toVersion <= current.version) return; // already covered
      if (diff.fromVersion !== current.version) return resync(); // gap
      const next = applyOps(current, diff.ops);
      client.history.push({ via: 'diff', fromVersion: diff.fromVersion, version: diff.toVersion });
      client.state = { version: diff.toVersion, ...next };
      client.diffsApplied++;
    }).catch((err) => client.errors.push(err));
  });

  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  const ack = await emitAck(socket, 'jam:join', { jamId: jam.jamId, userId, name, hostToken: host ? jam.hostToken : undefined });
  expect(ack.ok).toBe(true);
  adopt(ack.snapshot, 'join');
  client.command = (type, payload = {}) => emitAck(socket, 'room:command', { type, payload });
  client.idle = () => busy;
  return client;
}

async function freshSnapshot(client) {
  const res = await emitAck(client.socket, 'jam:resync', {});
  expect(res.ok).toBe(true);
  return res.snapshot;
}

// Each client's observed versions only ever go up, and every applied diff
// continued exactly from the version before it.
function expectMonotonicContiguous(client) {
  for (let i = 1; i < client.history.length; i++) {
    const prev = client.history[i - 1];
    const cur = client.history[i];
    expect(cur.version).toBeGreaterThan(prev.version);
    if (cur.via === 'diff') expect(cur.fromVersion).toBe(prev.version);
  }
  expect(client.errors).toStrictEqual([]);
}

test('a command handled by instance A reaches a client connected to instance B as a diff', async () => {
  const jam = await createJam(A);
  const host = await joinClient(A, jam, { userId: 'h', name: 'Host', host: true });
  const guestOnB = await joinClient(B, jam, { userId: 'g', name: 'Guest' });

  const ack = await host.command('ADD_TRACK', { trackId: catalog[0].trackId });
  expect(ack).toStrictEqual({ ok: true, version: 1 });

  await waitFor(() => guestOnB.state.version === 1, 3000, 'diff on B');
  expect(guestOnB.diffsApplied).toBe(1);
  expect(guestOnB.resyncs).toBe(0);
  expect(guestOnB.state.queue.map((t) => t.trackId)).toStrictEqual([catalog[0].trackId]);
  expect(guestOnB.state.queue[0].addedBy).toBe('Host');
});

test('6 concurrent SKIPs split across A and B consume exactly one track', async () => {
  const jam = await createJam(A);
  const hostA = await joinClient(A, jam, { userId: 'h', name: 'Host', host: true });
  const hostB = await joinClient(B, jam, { userId: 'h', name: 'Host', host: true });
  const [x, a, b, c] = catalog.map((t) => t.trackId);

  await hostA.command('ADD_TRACK', { trackId: x });
  await hostA.command('SKIP', { expectedTrackId: null });
  for (const trackId of [a, b, c]) {
    await sleep(2); // distinct addedAt → deterministic FIFO
    await hostB.command('ADD_TRACK', { trackId });
  }

  const acks = await Promise.all([hostA, hostB, hostA, hostB, hostA, hostB]
    .map((h) => h.command('SKIP', { expectedTrackId: x })));

  expect(acks.filter((r) => r.ok)).toHaveLength(1);
  expect(acks.filter((r) => !r.ok).map((r) => r.error.code)).toStrictEqual(Array(5).fill('STALE_SKIP'));

  const snap = await freshSnapshot(hostB);
  expect(snap.playback.currentTrackId).toBe(a);
  expect(snap.queue.map((t) => t.trackId)).toStrictEqual([b, c]);
});

test('under concurrent mixed commands on both instances, every client sees strictly increasing, contiguous versions and converges', async () => {
  const jam = await createJam(A);
  const hostA = await joinClient(A, jam, { userId: 'h', name: 'Host', host: true });
  const guestA = await joinClient(A, jam, { userId: 'ga', name: 'GuestA' });
  const guestB = await joinClient(B, jam, { userId: 'gb', name: 'GuestB' });
  const hostB = await joinClient(B, jam, { userId: 'h', name: 'Host', host: true });
  const clients = [hostA, guestA, guestB, hostB];
  const ids = catalog.map((t) => t.trackId);

  const burst = [];
  for (let round = 0; round < 3; round++) {
    burst.push(
      guestA.command('ADD_TRACK', { trackId: ids[round * 2] }),
      guestB.command('ADD_TRACK', { trackId: ids[round * 2 + 1] }),
      guestA.command('UPVOTE', { trackId: ids[round * 2 + 1] }),
      guestB.command('UPVOTE', { trackId: ids[round * 2] }),
      hostA.command('SKIP', { expectedTrackId: null }),
      hostB.command('PAUSE'),
      hostA.command('PLAY'),
    );
  }
  const acks = await Promise.all(burst);
  // (no-op commands — PLAY while playing etc. — ack ok with the current version, so versions may repeat)
  const okVersions = acks.filter((r) => r.ok).map((r) => r.version);

  await sleep(COALESCE_MS * 5);
  await Promise.all(clients.map((c) => c.idle()));
  const truth = await freshSnapshot(hostA);
  expect(truth.version).toBe(Math.max(...okVersions));

  for (const client of clients) {
    await waitFor(() => client.state.version === truth.version, 3000, 'convergence');
    expectMonotonicContiguous(client);
    expect(client.state).toStrictEqual(truth);
  }
});

test('diff/snapshot equivalence: a client fed only diffs through 30 mixed commands equals a fresh resync snapshot', async () => {
  const jam = await createJam(A);
  const host = await joinClient(A, jam, { userId: 'h', name: 'Host', host: true });
  const guest = await joinClient(A, jam, { userId: 'g', name: 'Guest' });
  const observer = await joinClient(B, jam, { userId: 'o', name: 'Observer' }); // cross-instance
  const ids = catalog.map((t) => t.trackId);

  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  let ok = 0;
  for (let i = 0; i < 30; i++) {
    const known = host.state;
    const r = rand();
    let ack;
    if (r < 0.35) ack = await guest.command('ADD_TRACK', { trackId: pick(ids) });
    else if (r < 0.6) ack = await pick([host, guest]).command('UPVOTE', { trackId: pick(ids) });
    else if (r < 0.8) ack = await host.command('SKIP', { expectedTrackId: known.playback.currentTrackId });
    else ack = await host.command(pick(['PLAY', 'PAUSE']));
    if (ack.ok) ok++;
    await waitFor(() => host.state.version >= (ack.ok ? ack.version : 0), 3000, 'host catch-up');
  }
  expect(ok).toBeGreaterThanOrEqual(15);

  await sleep(COALESCE_MS * 5);
  const truth = await freshSnapshot(host);
  await waitFor(() => observer.state.version === truth.version, 3000, 'observer catch-up');
  await observer.idle();

  expect(observer.resyncs).toBe(0); // reached purely by applying diffs
  expect(observer.diffsApplied).toBeGreaterThan(0);
  expectMonotonicContiguous(observer);
  expect(observer.state).toStrictEqual(truth);
}, 20_000);
