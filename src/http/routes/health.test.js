import { afterEach, expect, test, vi } from 'vitest';
import { createHealthHandlers } from './health.js';

afterEach(() => {
  vi.useRealTimers();
});

function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status: vi.fn((code) => { res.statusCode = code; return res; }),
    json: vi.fn((body) => { res.body = body; return res; }),
  };
  return res;
}

test('redis PONG → 200 with the log writer\'s mongo status', async () => {
  for (const mongo of ['ok', 'down', 'unknown']) {
    const res = fakeRes();
    await createHealthHandlers({ redis: { ping: async () => 'PONG' }, logStatus: () => mongo }).check({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toStrictEqual({ status: 'ok', redis: 'ok', mongo });
  }
});

test('redis error → 503; mongo is reported but never decides the status', async () => {
  const res = fakeRes();
  await createHealthHandlers({ redis: { ping: async () => { throw new Error('ECONNREFUSED'); } }, logStatus: () => 'ok' }).check({}, res);
  expect(res.statusCode).toBe(503);
  expect(res.body).toStrictEqual({ status: 'error', redis: 'down', mongo: 'ok' });
});

test('a redis PING that hangs past 1s → 503', async () => {
  vi.useFakeTimers();
  const res = fakeRes();
  const pending = createHealthHandlers({ redis: { ping: () => new Promise(() => {}) }, logStatus: () => 'unknown' }).check({}, res);

  await vi.advanceTimersByTimeAsync(999);
  expect(res.json).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await pending;

  expect(res.statusCode).toBe(503);
  expect(res.body).toStrictEqual({ status: 'error', redis: 'down', mongo: 'unknown' });
});
