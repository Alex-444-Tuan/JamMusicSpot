import { afterEach, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import Redis from 'ioredis';
import { createJamServer } from './app.js';

const fakeStorage = { getURL: async (key) => `https://signed.example/${key}` };
let servers = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => s.shutdown()));
  servers = [];
  vi.restoreAllMocks();
});

async function start(overrides = {}) {
  const log = { appendMany: vi.fn(async () => {}), ensureIndexes: async () => {} };
  const server = createJamServer({ config: { coalesceMs: 10 }, overrides: { commandLog: log, storage: fakeStorage, ...overrides } });
  servers.push(server);
  const { port } = await server.listen(0, '127.0.0.1');
  return { server, log, base: `http://127.0.0.1:${port}` };
}

test('GET /healthz → 200 with redis ok and mongo from the log writer (unknown before any write)', async () => {
  const { base } = await start();
  const res = await fetch(`${base}/healthz`);
  expect(res.status).toBe(200);
  expect(await res.json()).toStrictEqual({ status: 'ok', redis: 'ok', mongo: 'unknown' });
});

test('GET /shared/stateDiff.js serves the exact domain module as text/javascript', async () => {
  const { base } = await start();
  const res = await fetch(`${base}/shared/stateDiff.js`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/^text\/javascript/);
  expect(await res.text()).toBe(await readFile(new URL('./domain/stateDiff.js', import.meta.url), 'utf8'));
});

test('the API still answers through the composed app', async () => {
  const { base } = await start();
  const created = await fetch(`${base}/api/jams`, { method: 'POST' });
  expect(created.status).toBe(201);
  const { jamId } = await created.json();
  expect((await fetch(`${base}/api/jams/${jamId}`)).status).toBe(200);
  const redis = new Redis();
  await redis.del(`room:${jamId}:meta`);
  await redis.quit();
});

test('shutdown closes the HTTP server, flushes the log writer, and is idempotent', async () => {
  const { server, base } = await start();
  const flush = vi.spyOn(server.logWriter, 'flush');

  const first = server.shutdown();
  expect(server.shutdown()).toBe(first);
  await expect(first).resolves.toStrictEqual({ logFlushed: true, logPending: 0 });

  expect(flush).toHaveBeenCalledWith(3000);
  expect(server.httpServer.listening).toBe(false);
  await expect(fetch(`${base}/healthz`)).rejects.toThrow();
});

test('shutdown reports unflushed log batches instead of hanging forever', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const hanging = { appendMany: () => new Promise(() => {}), ensureIndexes: async () => {} };
  const { server } = await start({ commandLog: hanging });
  server.logWriter.enqueue('ROOM01', [{ type: 'ADD_TRACK', payload: {} }], 1);

  const started = Date.now();
  await expect(server.shutdown()).resolves.toStrictEqual({ logFlushed: false, logPending: 1 });
  expect(Date.now() - started).toBeGreaterThanOrEqual(2900);
}, 10_000);
