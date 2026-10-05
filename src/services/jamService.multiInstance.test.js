// Two jamService instances = two server processes: each has its own
// in-process per-room chain, so only the shared Redis lock can serialize
// them. Without it, concurrent SKIPs carrying the same expectedTrackId
// both pass the "is this still the current track?" check and each pops a
// track.
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { randomInt } from 'node:crypto';
import Redis from 'ioredis';
import { createRedisRoomStore } from '../adapters/redis/roomStore.js';
import { createRedisPlaybackStore } from '../adapters/redis/playbackStore.js';
import { createRedisJamStore } from '../adapters/redis/jamStore.js';
import { createRedisRoomLock } from '../adapters/redis/roomLock.js';
import { createJamService } from './jamService.js';

const catalog = ['song-a', 'song-b', 'song-c', 'song-x'].map((trackId) => ({ trackId }));
const randomId = (length, alphabet) => Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join('');

let redisA;
let redisB;
const jams = [];

beforeAll(() => {
  redisA = new Redis();
  redisB = new Redis();
});

afterAll(async () => {
  await redisA.quit();
  await redisB.quit();
});

afterEach(async () => {
  for (const jamId of jams.splice(0)) {
    const keys = await redisA.keys(`room:${jamId}:*`);
    if (keys.length > 0) await redisA.del(...keys);
  }
});

// One "server": its own Redis connection, stores, lock and service.
function instance(redis, clock, roomLock = createRedisRoomLock(redis)) {
  return createJamService({
    jamStore: createRedisJamStore(redis),
    roomStore: createRedisRoomStore(redis),
    playbackStore: createRedisPlaybackStore(redis),
    roomLock,
    logWriter: { enqueue() {} },
    broadcaster: { publishDiff: async () => {} },
    clock,
    catalog,
    randomId,
  });
}

test('6 concurrent SKIPs split across two instances consume exactly one track', async () => {
  let now = 1_000_000;
  const clock = { now: () => now };
  const a = instance(redisA, clock);
  const b = instance(redisB, clock);

  const { jamId, hostToken } = await a.createJam();
  jams.push(jamId);
  const host = { jamId, userId: 'h', name: 'Host', hostToken };
  await a.handleCommand(host, { type: 'ADD_TRACK', payload: { trackId: 'song-x' } });
  await a.handleCommand(host, { type: 'SKIP', payload: { expectedTrackId: null } }); // song-x playing
  for (const trackId of ['song-a', 'song-b', 'song-c']) {
    now += 1;
    await b.handleCommand(host, { type: 'ADD_TRACK', payload: { trackId } });
  }

  const skip = { type: 'SKIP', payload: { expectedTrackId: 'song-x' } };
  const results = await Promise.allSettled([
    a.handleCommand(host, skip), b.handleCommand(host, skip),
    a.handleCommand(host, skip), b.handleCommand(host, skip),
    a.handleCommand(host, skip), b.handleCommand(host, skip),
  ]);

  const ok = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  expect(ok).toHaveLength(1);
  expect(rejected.map((r) => r.reason.code)).toStrictEqual(Array(5).fill('STALE_SKIP'));

  const snap = await a.getSnapshot(jamId);
  expect(snap.playback.currentTrackId).toBe('song-a');
  expect(snap.queue.map((t) => t.trackId)).toStrictEqual(['song-b', 'song-c']);
});

// The lock is a lease: if it ever expires mid-command, exclusivity is
// gone. "Exactly one track per skip" must hold even then, so SKIP's
// check-and-pop is one atomic Redis script. Prove it with NO lock at all.
test('without any lock, 6 concurrent SKIPs across two instances still consume exactly one track', async () => {
  let now = 1_000_000;
  const clock = { now: () => now };
  const noLock = { withLock: (roomId, fn) => fn() };
  const a = instance(redisA, clock, noLock);
  const b = instance(redisB, clock, noLock);

  const { jamId, hostToken } = await a.createJam();
  jams.push(jamId);
  const host = { jamId, userId: 'h', name: 'Host', hostToken };
  await a.handleCommand(host, { type: 'ADD_TRACK', payload: { trackId: 'song-x' } });
  await a.handleCommand(host, { type: 'SKIP', payload: { expectedTrackId: null } }); // song-x playing
  for (const trackId of ['song-a', 'song-b', 'song-c']) {
    now += 1;
    await a.handleCommand(host, { type: 'ADD_TRACK', payload: { trackId } });
  }

  const skip = { type: 'SKIP', payload: { expectedTrackId: 'song-x' } };
  const results = await Promise.allSettled([
    a.handleCommand(host, skip), b.handleCommand(host, skip),
    a.handleCommand(host, skip), b.handleCommand(host, skip),
    a.handleCommand(host, skip), b.handleCommand(host, skip),
  ]);

  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected').map((r) => r.reason.code)).toStrictEqual(Array(5).fill('STALE_SKIP'));
  const snap = await a.getSnapshot(jamId);
  expect(snap.playback.currentTrackId).toBe('song-a');
  expect(snap.queue.map((t) => t.trackId)).toStrictEqual(['song-b', 'song-c']);
});
