import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { createRedisJamStore } from './jamStore.js';

let redis;
let store;
let jamId;

beforeAll(() => {
  redis = new Redis();
  store = createRedisJamStore(redis);
});

afterAll(async () => {
  await redis.quit();
});

afterEach(async () => {
  const keys = await redis.keys(`room:${jamId}:*`);
  if (keys.length > 0) await redis.del(...keys);
});

test('create then get round-trips the meta', async () => {
  jamId = randomUUID();
  const meta = { hostToken: 'secret', createdAt: 1234 };

  expect(await store.create(jamId, meta)).toBe(true);
  expect(await store.get(jamId)).toStrictEqual(meta);
});

test('get on an unknown jam returns null', async () => {
  jamId = randomUUID();
  expect(await store.get(jamId)).toBeNull();
});

test('create on a taken id returns false and keeps the original meta', async () => {
  jamId = randomUUID();
  await store.create(jamId, { hostToken: 'first', createdAt: 1 });

  expect(await store.create(jamId, { hostToken: 'second', createdAt: 2 })).toBe(false);
  expect(await store.get(jamId)).toStrictEqual({ hostToken: 'first', createdAt: 1 });
});

test('concurrent creates of the same id: exactly one wins', async () => {
  jamId = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => store.create(jamId, { hostToken: `t${i}`, createdAt: i })),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
});

test('getVersion starts at 0 and bumpVersion increments monotonically', async () => {
  jamId = randomUUID();
  expect(await store.getVersion(jamId)).toBe(0);
  expect(await store.bumpVersion(jamId)).toBe(1);
  expect(await store.bumpVersion(jamId)).toBe(2);
  expect(await store.getVersion(jamId)).toBe(2);
});
