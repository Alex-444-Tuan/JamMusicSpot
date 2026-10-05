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

const addTrack = (trackId, addedAt, addedBy = 'Tuan') =>
  store.applyCommand(roomId, { type: 'ADD_TRACK', payload: { trackId, addedBy, addedAt } });
const upvote = (trackId, userId) =>
  store.applyCommand(roomId, { type: 'UPVOTE', payload: { trackId, userId } });
const member = (trackId) => `room:${roomId}:trackId:${trackId}`;

test('the exported VOTE_WEIGHT_MS is the 2-day composite-score weight (negative: votes move a track toward the front)', async () => {
  const { VOTE_WEIGHT_MS } = await import('./roomStore.js');
  expect(VOTE_WEIGHT_MS).toBe(-VOTE_CONSTANT_MS);
});

test('a duplicate ADD_TRACK throws DUPLICATE_TRACK and keeps the original score, votes, and version', async () => {
  roomId = randomUUID();
  await addTrack('track-1', 1000, 'Tuan');
  await upvote('track-1', 'userA');
  const scoreBefore = await redis.zscore(`room:${roomId}:queue`, member('track-1'));

  await expect(addTrack('track-1', 5000, 'Alex')).rejects.toMatchObject({ code: 'DUPLICATE_TRACK' });

  expect(await redis.zscore(`room:${roomId}:queue`, member('track-1'))).toBe(scoreBefore);
  const { state, version } = await store.getState(roomId);
  expect(state).toStrictEqual([{ trackId: 'track-1', addedBy: 'Tuan', addedAt: 1000, upvotedBy: ['userA'] }]);
  expect(version).toBe(2);
});

test('an UPVOTE on a track not in the queue throws NOT_IN_QUEUE and creates no ZSET member', async () => {
  roomId = randomUUID();

  await expect(upvote('ghost', 'userA')).rejects.toMatchObject({ code: 'NOT_IN_QUEUE' });

  expect(await redis.zcard(`room:${roomId}:queue`)).toBe(0);
  expect(await redis.exists(`${member('ghost')}:voters`)).toBe(0);
  expect((await store.getState(roomId)).version).toBe(0);
});

test('popNext returns the lowest-score track and deletes its hash and voter set', async () => {
  roomId = randomUUID();
  await addTrack('old-track', 1000);
  await addTrack('new-track', 2000);
  await upvote('new-track', 'userA'); // version 3; new-track now has the lowest score

  const result = await store.popNext(roomId);

  expect(result).toStrictEqual({ trackId: 'new-track', version: 4 });
  expect(await redis.exists(member('new-track'))).toBe(0);
  expect(await redis.exists(`${member('new-track')}:voters`)).toBe(0);
  const { state } = await store.getState(roomId);
  expect(state.map((t) => t.trackId)).toEqual(['old-track']);
});

test('a track re-added after being popped starts fresh, so a previous voter can vote again', async () => {
  roomId = randomUUID();
  await addTrack('track-1', 1000);
  await upvote('track-1', 'userA');
  await store.popNext(roomId);

  await addTrack('track-1', 9000);
  const result = await upvote('track-1', 'userA');

  expect(Number(await redis.zscore(`room:${roomId}:queue`, member('track-1')))).toBe(9000 - VOTE_CONSTANT_MS);
  expect(result.state).toStrictEqual([{ trackId: 'track-1', addedBy: 'Tuan', addedAt: 9000, upvotedBy: ['userA'] }]);
});

test('popNext on an empty queue returns trackId null and leaves version unchanged', async () => {
  roomId = randomUUID();
  await addTrack('track-1', 1000);
  await store.popNext(roomId); // version 2

  const result = await store.popNext(roomId);

  expect(result).toStrictEqual({ trackId: null, version: 2 });
});

test('20 concurrent ADD_TRACKs of the same track: exactly one succeeds', async () => {
  roomId = randomUUID();

  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) => addTrack('track-1', 1000 + i, `user${i}`)),
  );

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(19);
  rejected.forEach((r) => expect(r.reason.code).toBe('DUPLICATE_TRACK'));

  expect(await redis.zcard(`room:${roomId}:queue`)).toBe(1);
  const { state, version } = await store.getState(roomId);
  expect(version).toBe(1);
  // the hash and the ZSET score came from the same (single) winning command
  const score = Number(await redis.zscore(`room:${roomId}:queue`, member('track-1')));
  expect(state[0].addedAt).toBe(score);
});

test('10 concurrent popNext on a 5-track queue: 5 distinct tracks + 5 nulls, nothing left behind', async () => {
  roomId = randomUUID();
  for (let i = 0; i < 5; i++) {
    await addTrack(`track-${i}`, 1000 + i);
    await upvote(`track-${i}`, 'userA');
  }

  const results = await Promise.all(Array.from({ length: 10 }, () => store.popNext(roomId)));

  const ids = results.map((r) => r.trackId).filter((id) => id !== null);
  expect(ids).toHaveLength(5);
  expect(new Set(ids).size).toBe(5);
  expect(results.filter((r) => r.trackId === null)).toHaveLength(5);
  expect(await redis.keys(`room:${roomId}:trackId:*`)).toStrictEqual([]);
  expect(await redis.zcard(`room:${roomId}:queue`)).toBe(0);
});

test('getState returns upvotedBy sorted ascending regardless of vote order', async () => {
  roomId = randomUUID();
  await addTrack('track-1', 1000);
  for (const userId of ['zoe', 'adam', 'mia', 'bob']) await upvote('track-1', userId);

  const { state } = await store.getState(roomId);

  expect(state[0].upvotedBy).toStrictEqual(['adam', 'bob', 'mia', 'zoe']);
});
