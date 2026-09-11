import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { createRedisRoomStore } from './roomStore.js';

const VOTE_CONSTANT_MS = 2 * 24 * 60 * 60 * 1000; // 2 days, matches the adapter's composite score formula

let redis;
let store;
let roomId;

beforeAll(() => {
  redis = new Redis();
  store = createRedisRoomStore(redis);
});

afterAll(async () => {
  await redis.quit();
});

afterEach(async () => {
  const keys = await redis.keys(`room:${roomId}:*`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
});

test('getState on a brand-new room returns empty state and version 0', async () => {
  roomId = randomUUID();

  const result = await store.getState(roomId);

  expect(result).toStrictEqual({ state: [], version: 0 });
});

test('ADD_TRACK adds a track with upvotedBy: [] and bumps version to 1', async () => {
  roomId = randomUUID();

  const result = await store.applyCommand(roomId, {
    type: 'ADD_TRACK',
    payload: { trackId: 'track-1', addedBy: 'Tuan', addedAt: 1000 },
  });

  expect(result).toStrictEqual({
    state: [{ trackId: 'track-1', addedBy: 'Tuan', addedAt: 1000, upvotedBy: [] }],
    version: 1,
  });
});

test('getState after ADD_TRACK matches what applyCommand already returned', async () => {
  roomId = randomUUID();
  const written = await store.applyCommand(roomId, {
    type: 'ADD_TRACK',
    payload: { trackId: 'track-1', addedBy: 'Tuan', addedAt: 1000 },
  });

  const read = await store.getState(roomId);

  expect(read).toStrictEqual(written);
});

test('a new UPVOTE decrements the real track score by the vote constant and bumps version', async () => {
  roomId = randomUUID();
  await store.applyCommand(roomId, {
    type: 'ADD_TRACK',
    payload: { trackId: 'track-1', addedBy: 'Tuan', addedAt: 1000 },
  });

  const result = await store.applyCommand(roomId, {
    type: 'UPVOTE',
    payload: { trackId: 'track-1', userId: 'userA' },
  });

  expect(result.version).toBe(2);

  const rawScore = await redis.zscore(`room:${roomId}:queue`, `room:${roomId}:trackId:track-1`);
  expect(Number(rawScore)).toBe(1000 - VOTE_CONSTANT_MS);
});

test('a duplicate UPVOTE from the same user changes neither score nor version', async () => {
  roomId = randomUUID();
  await store.applyCommand(roomId, {
    type: 'ADD_TRACK',
    payload: { trackId: 'track-1', addedBy: 'Tuan', addedAt: 1000 },
  });
  await store.applyCommand(roomId, {
    type: 'UPVOTE',
    payload: { trackId: 'track-1', userId: 'userA' },
  });
  const scoreBefore = await redis.zscore(`room:${roomId}:queue`, `room:${roomId}:trackId:track-1`);

  const result = await store.applyCommand(roomId, {
    type: 'UPVOTE',
    payload: { trackId: 'track-1', userId: 'userA' },
  });

  const scoreAfter = await redis.zscore(`room:${roomId}:queue`, `room:${roomId}:trackId:track-1`);
  expect(scoreAfter).toBe(scoreBefore);
  expect(result.version).toBe(2); // unchanged from the first, genuine vote
});

test('votes from two different users on the same track both count independently', async () => {
  roomId = randomUUID();
  await store.applyCommand(roomId, {
    type: 'ADD_TRACK',
    payload: { trackId: 'track-1', addedBy: 'Tuan', addedAt: 1000 },
  });
  await store.applyCommand(roomId, { type: 'UPVOTE', payload: { trackId: 'track-1', userId: 'userA' } });

  const result = await store.applyCommand(roomId, { type: 'UPVOTE', payload: { trackId: 'track-1', userId: 'userB' } });

  expect(result.version).toBe(3);
  const rawScore = await redis.zscore(`room:${roomId}:queue`, `room:${roomId}:trackId:track-1`);
  expect(Number(rawScore)).toBe(1000 - 2 * VOTE_CONSTANT_MS);
});

test('an upvoted track added later outranks an unvoted older track', async () => {
  roomId = randomUUID();
  await store.applyCommand(roomId, {
    type: 'ADD_TRACK',
    payload: { trackId: 'old-track', addedBy: 'Tuan', addedAt: 1000 },
  });
  await store.applyCommand(roomId, {
    type: 'ADD_TRACK',
    payload: { trackId: 'new-track', addedBy: 'Alex', addedAt: 2000 },
  });
  await store.applyCommand(roomId, { type: 'UPVOTE', payload: { trackId: 'new-track', userId: 'userA' } });

  const { state } = await store.getState(roomId);

  expect(state.map((track) => track.trackId)).toEqual(['new-track', 'old-track']);
});

test('an unsupported command type throws', async () => {
  roomId = randomUUID();

  await expect(
    store.applyCommand(roomId, { type: 'SKIP', payload: {} }),
  ).rejects.toThrow('not supported yet: SKIP');
});
