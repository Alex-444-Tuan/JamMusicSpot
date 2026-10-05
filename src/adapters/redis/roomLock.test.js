import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { createRedisRoomLock } from './roomLock.js';

let redis;
let redis2;
let roomId;

beforeAll(() => {
  redis = new Redis();
  redis2 = new Redis();
});

afterAll(async () => {
  await redis.quit();
  await redis2.quit();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await redis.del(`room:${roomId}:lock`);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('withLock returns fn\'s result and releases the lock', async () => {
  roomId = randomUUID();
  const lock = createRedisRoomLock(redis);

  expect(await lock.withLock(roomId, async () => 42)).toBe(42);
  expect(await redis.exists(`room:${roomId}:lock`)).toBe(0);
});

test('mutual exclusion: critical sections from two holders never overlap', async () => {
  roomId = randomUUID();
  const lockA = createRedisRoomLock(redis);
  const lockB = createRedisRoomLock(redis2); // separate connection = separate "instance"
  const spans = [];

  await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? lockA : lockB).withLock(roomId, async () => {
    const start = performance.now();
    await sleep(3);
    spans.push([start, performance.now()]);
  })));

  spans.sort((x, y) => x[0] - y[0]);
  expect(spans).toHaveLength(12);
  for (let i = 1; i < spans.length; i++) {
    expect(spans[i][0]).toBeGreaterThanOrEqual(spans[i - 1][1]);
  }
});

test('a release with the wrong token never deletes someone else\'s lock', async () => {
  roomId = randomUUID();
  const lock = createRedisRoomLock(redis);
  await redis.set(`room:${roomId}:lock`, 'someone-else', 'PX', 5000);

  expect(await lock._release(roomId, 'not-my-token')).toBe(0);
  expect(await redis.get(`room:${roomId}:lock`)).toBe('someone-else');
});

test('an expired lock can be taken by another holder; the original release then warns and leaves it alone', async () => {
  roomId = randomUUID();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const slow = createRedisRoomLock(redis, { ttlMs: 50 });
  const other = createRedisRoomLock(redis2);
  let otherHeld = false;

  await slow.withLock(roomId, async () => {
    await sleep(80); // outlive our own TTL
    await other.withLock(roomId, async () => {
      otherHeld = true;
      await redis2.set(`room:${roomId}:marker`, '1');
    }).catch(() => {});
    // `other` released its own lock; take it again and hold it across our release
    await redis2.set(`room:${roomId}:lock`, 'other-token', 'PX', 5000);
  });

  expect(otherHeld).toBe(true);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('lock expired mid-command'), expect.anything());
  expect(await redis.get(`room:${roomId}:lock`)).toBe('other-token');
  await redis.del(`room:${roomId}:marker`);
});

test('acquisition times out with BUSY', async () => {
  roomId = randomUUID();
  await redis.set(`room:${roomId}:lock`, 'held', 'PX', 5000);
  const lock = createRedisRoomLock(redis, { acquireTimeoutMs: 120 });
  const fn = vi.fn();

  const started = performance.now();
  await expect(lock.withLock(roomId, fn)).rejects.toMatchObject({ code: 'BUSY' });
  expect(performance.now() - started).toBeGreaterThanOrEqual(110);
  expect(fn).not.toHaveBeenCalled();
});

test('the lock is released when fn throws, and the error propagates', async () => {
  roomId = randomUUID();
  const lock = createRedisRoomLock(redis);

  await expect(lock.withLock(roomId, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  expect(await redis.exists(`room:${roomId}:lock`)).toBe(0);
});

test('the lock carries a TTL so a crashed holder cannot wedge the room', async () => {
  roomId = randomUUID();
  const lock = createRedisRoomLock(redis);
  let ttl;
  await lock.withLock(roomId, async () => { ttl = await redis.pttl(`room:${roomId}:lock`); });
  expect(ttl).toBeGreaterThan(4000);
  expect(ttl).toBeLessThanOrEqual(5000);
});
