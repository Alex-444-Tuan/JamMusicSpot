// Conformance: the atomic Lua SKIP must make exactly the transition the
// pure playbackMachine reducer defines for SKIP — the reducer stays the
// spec, the script is just its atomic implementation.
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { createRedisPlaybackStore } from './playbackStore.js';
import { createRedisRoomStore } from './roomStore.js';
import playbackReducer from '../../domain/playbackMachine.js';
import { Skip } from '../../domain/commands.js';

let redis;
let playbackStore;
let roomStore;
let roomId;

beforeAll(() => {
  redis = new Redis();
  playbackStore = createRedisPlaybackStore(redis);
  roomStore = createRedisRoomStore(redis);
});

afterAll(async () => {
  await redis.quit();
});

afterEach(async () => {
  const keys = await redis.keys(`room:${roomId}:*`);
  if (keys.length > 0) await redis.del(...keys);
});

const AT = 1_791_169_764_463; // realistic ms epoch — must survive the round trip exactly
const IDLE = { status: 'IDLE', currentTrackId: null, startedAt: null, pausedAt: null };
const PLAYING = { status: 'PLAYING', currentTrackId: 'x', startedAt: 1_791_169_000_000, pausedAt: null };
const PAUSED = { status: 'PAUSED', currentTrackId: 'x', startedAt: 1_791_169_000_000, pausedAt: 1_791_169_500_000 };

async function seed(playback, queue) {
  roomId = randomUUID();
  if (playback !== IDLE) await redis.set(`room:${roomId}:playback`, JSON.stringify(playback));
  for (const [i, trackId] of queue.entries()) {
    await roomStore.applyCommand(roomId, { type: 'ADD_TRACK', payload: { trackId, addedBy: 'u', addedAt: 1000 + i } });
  }
}

const cases = [];
for (const [name, start] of [['IDLE', IDLE], ['PLAYING x', PLAYING], ['PAUSED x', PAUSED]]) {
  for (const queue of [[], ['a', 'b']]) cases.push([name, start, queue]);
}

test.each(cases)('from %s with queue %j the script matches playbackReducer', async (_, start, queue) => {
  await seed(start, queue);
  const { version: playbackVersionBefore } = await playbackStore.getState(roomId);
  const { version: roomVersionBefore } = await roomStore.getState(roomId);

  const result = await playbackStore.skipNext(roomId, start.currentTrackId, AT);

  if (start === IDLE && queue.length === 0) {
    expect(result).toStrictEqual({ status: 'NOOP', trackId: null });
    expect((await playbackStore.getState(roomId)).version).toBe(playbackVersionBefore);
    return;
  }

  const next = queue[0] ?? null;
  expect(result).toStrictEqual({ status: 'OK', trackId: next });

  const { state, version } = await playbackStore.getState(roomId);
  expect(state).toStrictEqual(playbackReducer(start, Skip(next, AT)));
  expect(version).toBe(playbackVersionBefore + 1);

  const room = await roomStore.getState(roomId);
  expect(room.state.map((t) => t.trackId)).toStrictEqual(queue.slice(1));
  expect(room.version).toBe(roomVersionBefore + (next ? 1 : 0));
});

test('a stale expectedTrackId changes nothing and returns STALE', async () => {
  await seed(PLAYING, ['a', 'b']);
  const before = { playback: await playbackStore.getState(roomId), room: await roomStore.getState(roomId) };

  expect(await playbackStore.skipNext(roomId, 'y', AT)).toStrictEqual({ status: 'STALE', trackId: null });
  expect(await playbackStore.skipNext(roomId, null, AT)).toStrictEqual({ status: 'STALE', trackId: null });

  expect(await playbackStore.getState(roomId)).toStrictEqual(before.playback);
  expect(await roomStore.getState(roomId)).toStrictEqual(before.room);
});

test('a null expectedTrackId against IDLE is not stale', async () => {
  await seed(IDLE, ['a']);
  expect(await playbackStore.skipNext(roomId, null, AT)).toStrictEqual({ status: 'OK', trackId: 'a' });
});

test('the skipped-to track leaves the queue together with its metadata hash and voters set', async () => {
  await seed(PLAYING, ['a', 'b']);
  await roomStore.applyCommand(roomId, { type: 'UPVOTE', payload: { trackId: 'b', userId: 'u1' } }); // b now first

  const result = await playbackStore.skipNext(roomId, 'x', AT);

  expect(result).toStrictEqual({ status: 'OK', trackId: 'b' });
  const { state } = await roomStore.getState(roomId);
  expect(state.map((t) => t.trackId)).toStrictEqual(['a']);
  expect(await redis.exists(`room:${roomId}:trackId:b`)).toBe(0);
  expect(await redis.exists(`room:${roomId}:trackId:b:voters`)).toBe(0);
});
