// Host succession over real sockets on two server instances sharing one
// Redis: the host is on instance A, guests are on B. When the host
// disconnects, the earliest-joined guest still connected must be promoted
// (privately receiving a fresh token), be able to control playback, and the
// old host token must stop working. Short grace period to keep it fast.
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { io as connect } from 'socket.io-client';
import Redis from 'ioredis';
import { createJamServer } from '../app.js';
import { catalog } from '../catalog/catalog.js';

const GRACE_MS = 150;
let A;
let B;
let redis;
const sockets = [];
const jams = [];

async function startInstance() {
  const server = createJamServer({
    config: { coalesceMs: 10, hostGraceMs: GRACE_MS },
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
async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}
const emitAck = (socket, event, payload) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), 8000);
  socket.emit(event, payload, (res) => { clearTimeout(timer); resolve(res); });
});

async function createJam() {
  const jam = await (await fetch(`${A.url}/api/jams`, { method: 'POST' })).json();
  jams.push(jam.jamId);
  return jam;
}

async function member(instance, jamId, userId, hostToken) {
  const socket = connect(instance.url, { transports: ['websocket'], forceNew: true, reconnection: false });
  sockets.push(socket);
  const m = { socket, promoted: [], hostEvents: [] };
  socket.on('jam:promoted', (e) => m.promoted.push(e));
  socket.on('jam:host', (e) => m.hostEvents.push(e));
  await new Promise((resolve) => socket.on('connect', resolve));
  m.join = await emitAck(socket, 'jam:join', { jamId, userId, name: userId, ...(hostToken ? { hostToken } : {}) });
  return m;
}
const command = (m, type, payload = {}) => emitAck(m.socket, 'room:command', { type, payload });

test('host leaves: the earliest-joined guest on the other instance is promoted, the old token dies', async () => {
  const { jamId, hostToken } = await createJam();
  const host = await member(A, jamId, 'host', hostToken);
  const alice = await member(B, jamId, 'alice');
  await sleep(5);
  const bob = await member(B, jamId, 'bob');

  expect(host.join).toMatchObject({ ok: true, isHost: true, hostToken });
  expect(alice.join).toMatchObject({ ok: true, isHost: false, host: { userId: 'host', name: 'host' } });
  expect(alice.join).not.toHaveProperty('hostToken');
  expect(await command(alice, 'PAUSE')).toMatchObject({ ok: false, error: { code: 'NOT_HOST' } });

  await command(host, 'ADD_TRACK', { trackId: catalog[0].trackId });
  await command(host, 'SKIP', { expectedTrackId: null });
  host.socket.disconnect();

  await sleep(GRACE_MS / 2);
  expect(alice.promoted).toHaveLength(0); // still inside the grace period
  await waitFor(() => alice.promoted.length === 1, 3000, 'alice promoted');

  expect(bob.promoted).toHaveLength(0);   // private to the new host
  const { hostToken: newToken } = alice.promoted[0];
  expect(newToken).not.toBe(hostToken);
  await waitFor(() => bob.hostEvents.length === 1, 1000, 'room told');
  expect(bob.hostEvents[0]).toStrictEqual({ hostUserId: 'alice', hostName: 'alice' });

  // Before claiming, alice's socket is still a guest; after, she controls playback.
  expect(await command(alice, 'PAUSE')).toMatchObject({ ok: false, error: { code: 'NOT_HOST' } });
  expect(await emitAck(alice.socket, 'jam:claimHost', { hostToken: newToken })).toStrictEqual({ ok: true, isHost: true });
  expect(await command(alice, 'PAUSE')).toMatchObject({ ok: true });
  expect(await command(bob, 'PLAY')).toMatchObject({ ok: false, error: { code: 'NOT_HOST' } });
  // bob can't claim with a forged or stolen-old token
  expect(await emitAck(bob.socket, 'jam:claimHost', { hostToken })).toStrictEqual({ ok: true, isHost: false });

  // the old host returning with the old token is a guest now
  const returning = await member(A, jamId, 'host', hostToken);
  expect(returning.join).toMatchObject({ ok: true, isHost: false, host: { userId: 'alice' } });
  expect(await command(returning, 'PLAY')).toMatchObject({ ok: false, error: { code: 'NOT_HOST' } });
});

test('a host who reconnects within the grace period stays host', async () => {
  const { jamId, hostToken } = await createJam();
  const host = await member(A, jamId, 'host', hostToken);
  const alice = await member(B, jamId, 'alice');

  host.socket.disconnect();
  await sleep(GRACE_MS / 3);
  const back = await member(B, jamId, 'host', hostToken); // a refresh, landing on the other instance
  await sleep(GRACE_MS * 3);

  expect(back.join).toMatchObject({ ok: true, isHost: true });
  expect(alice.promoted).toHaveLength(0);
  expect(await command(back, 'PLAY')).toMatchObject({ ok: true });
});
