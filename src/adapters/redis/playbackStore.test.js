import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { createRedisPlaybackStore } from './playbackStore.js';

let redis;
let store;
let roomId;

beforeAll(() => {
  redis = new Redis();
  store = createRedisPlaybackStore(redis);
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

test('getState on a fresh room returns IDLE and version 0', async () => {
  roomId = randomUUID();

  const result = await store.getState(roomId);

  expect(result).toStrictEqual({
    state: { status: 'IDLE', currentTrackId: null, startedAt: null, pausedAt: null },
    version: 0,
  });
});

test('PLAY from IDLE is a no-op — version stays 0', async () => {
  roomId = randomUUID();

  const result = await store.applyCommand(roomId, { type: 'PLAY', payload: { at: 999 } });

  expect(result).toStrictEqual({
    state: { status: 'IDLE', currentTrackId: null, startedAt: null, pausedAt: null },
    version: 0,
  });
});

test('PAUSE from IDLE is a no-op — version stays 0', async () => {
  roomId = randomUUID();

  const result = await store.applyCommand(roomId, { type: 'PAUSE', payload: { at: 999 } });

  expect(result).toStrictEqual({
    state: { status: 'IDLE', currentTrackId: null, startedAt: null, pausedAt: null },
    version: 0,
  });
});

test('SKIP from IDLE with a track transitions to PLAYING and bumps version', async () => {
  roomId = randomUUID();

  const result = await store.applyCommand(roomId, {
    type: 'SKIP',
    payload: { trackId: 'track-1', at: 1000 },
  });

  expect(result).toStrictEqual({
    state: { status: 'PLAYING', currentTrackId: 'track-1', startedAt: 1000, pausedAt: null },
    version: 1,
  });
});

test('PLAY while already PLAYING is a no-op — version does not bump', async () => {
  roomId = randomUUID();
  await store.applyCommand(roomId, { type: 'SKIP', payload: { trackId: 'track-1', at: 1000 } });

  const result = await store.applyCommand(roomId, { type: 'PLAY', payload: { at: 2000 } });

  expect(result).toStrictEqual({
    state: { status: 'PLAYING', currentTrackId: 'track-1', startedAt: 1000, pausedAt: null },
    version: 1,
  });
});

test('PAUSE from PLAYING transitions to PAUSED and bumps version', async () => {
  roomId = randomUUID();
  await store.applyCommand(roomId, { type: 'SKIP', payload: { trackId: 'track-1', at: 1000 } });

  const result = await store.applyCommand(roomId, { type: 'PAUSE', payload: { at: 3000 } });

  expect(result).toStrictEqual({
    state: { status: 'PAUSED', currentTrackId: 'track-1', startedAt: 1000, pausedAt: 3000 },
    version: 2,
  });
});

test('PAUSE while already PAUSED is a no-op — version does not bump', async () => {
  roomId = randomUUID();
  await store.applyCommand(roomId, { type: 'SKIP', payload: { trackId: 'track-1', at: 1000 } });
  await store.applyCommand(roomId, { type: 'PAUSE', payload: { at: 3000 } });

  const result = await store.applyCommand(roomId, { type: 'PAUSE', payload: { at: 4000 } });

  expect(result).toStrictEqual({
    state: { status: 'PAUSED', currentTrackId: 'track-1', startedAt: 1000, pausedAt: 3000 },
    version: 2,
  });
});

test('PLAY from PAUSED transitions back to PLAYING and bumps version', async () => {
  roomId = randomUUID();
  await store.applyCommand(roomId, { type: 'SKIP', payload: { trackId: 'track-1', at: 1000 } });
  await store.applyCommand(roomId, { type: 'PAUSE', payload: { at: 3000 } });

  const result = await store.applyCommand(roomId, { type: 'PLAY', payload: { at: 5000 } });

  expect(result).toStrictEqual({
    state: { status: 'PLAYING', currentTrackId: 'track-1', startedAt: 3000, pausedAt: null }, // resumed at 5000 with 2000ms of progress
    version: 3,
  });
});

test('getState after applyCommand matches what applyCommand already returned', async () => {
  roomId = randomUUID();
  const written = await store.applyCommand(roomId, {
    type: 'SKIP',
    payload: { trackId: 'track-1', at: 1000 },
  });

  const read = await store.getState(roomId);

  expect(read).toStrictEqual(written);
});
