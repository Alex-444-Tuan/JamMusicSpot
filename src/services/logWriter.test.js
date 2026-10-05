import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createLogWriter } from './logWriter.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const dupKey = () => Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
const cmd = (n) => ({ type: 'ADD_TRACK', payload: { n } });

function controllableLog() {
  const calls = [];
  return {
    calls,
    appendMany: vi.fn((roomId, commands, version) => new Promise((resolve, reject) => {
      calls.push({ roomId, commands, version, resolve, reject });
    })),
  };
}

test('enqueue returns synchronously and starts the write immediately', () => {
  const log = { appendMany: vi.fn(async () => {}) };
  const writer = createLogWriter(log);

  expect(writer.enqueue('R', [cmd(1)], 1)).toBeUndefined();
  expect(log.appendMany).toHaveBeenCalledWith('R', [cmd(1)], 1);
});

test('per-room FIFO with one batch in flight; rooms are independent', async () => {
  const log = controllableLog();
  const writer = createLogWriter(log);

  writer.enqueue('R', [cmd(1)], 1);
  writer.enqueue('R', [cmd(2)], 2);
  writer.enqueue('S', [cmd(9)], 1);

  expect(log.calls.map((c) => `${c.roomId}${c.version}`)).toStrictEqual(['R1', 'S1']); // R2 waits for R1
  log.calls[0].resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(log.calls.map((c) => `${c.roomId}${c.version}`)).toStrictEqual(['R1', 'S1', 'R2']);
});

test('failures retry the same batch with exponential backoff 500ms → 30s, keeping order', async () => {
  const outcomes = [];
  let failuresLeft = 8;
  const log = {
    appendMany: vi.fn(async (roomId, commands, version) => {
      outcomes.push({ version, at: Date.now() });
      if (failuresLeft-- > 0) throw new Error('mongo down');
    }),
  };
  const writer = createLogWriter(log);
  const t0 = Date.now();

  writer.enqueue('R', [cmd(1)], 1);
  writer.enqueue('R', [cmd(2)], 2);
  await vi.advanceTimersByTimeAsync(200_000);

  const gaps = outcomes.slice(1, 9).map((o, i) => o.at - outcomes[i].at);
  expect(gaps).toStrictEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  expect(outcomes.map((o) => o.version)).toStrictEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 2]);
  expect(outcomes[0].at).toBe(t0);
  expect(writer.status()).toBe('ok');
  expect(writer.pending()).toBe(0);
});

test('status: unknown → down after a failure → ok after a success', async () => {
  let fail = true;
  const writer = createLogWriter({ appendMany: async () => { if (fail) throw new Error('x'); } });
  expect(writer.status()).toBe('unknown');

  writer.enqueue('R', [cmd(1)], 1);
  await vi.advanceTimersByTimeAsync(0);
  expect(writer.status()).toBe('down');

  fail = false;
  await vi.advanceTimersByTimeAsync(500);
  expect(writer.status()).toBe('ok');
});

test('a duplicate-key error counts as success (the batch was already written)', async () => {
  const log = { appendMany: vi.fn(async () => { throw dupKey(); }) };
  const writer = createLogWriter(log);

  writer.enqueue('R', [cmd(1)], 1);
  writer.enqueue('R', [cmd(2)], 2);
  await vi.advanceTimersByTimeAsync(0);

  expect(log.appendMany).toHaveBeenCalledTimes(2); // no retry of version 1
  expect(writer.status()).toBe('ok');
  expect(writer.pending()).toBe(0);
});

test('a bulk-write error made only of duplicate keys also counts as success', async () => {
  const bulk = Object.assign(new Error('bulk'), { writeErrors: [{ code: 11000 }, { code: 11000 }] });
  const log = { appendMany: vi.fn(async () => { throw bulk; }) };
  const writer = createLogWriter(log);

  writer.enqueue('R', [cmd(1), cmd(2)], 1);
  await vi.advanceTimersByTimeAsync(0);

  expect(log.appendMany).toHaveBeenCalledTimes(1);
  expect(writer.pending()).toBe(0);
});

test('overflow drops the oldest waiting batch (never the one in flight), warns and counts', async () => {
  const log = controllableLog();
  const writer = createLogWriter(log, { maxPending: 3 });

  writer.enqueue('R', [cmd(1)], 1); // in flight
  writer.enqueue('R', [cmd(2)], 2);
  writer.enqueue('S', [cmd(3)], 1); // in flight
  writer.enqueue('R', [cmd(4)], 3); // pending would be 4 > 3 → drop R2 (oldest waiting)

  expect(writer.pending()).toBe(3);
  expect(writer.dropped()).toBe(1);
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('dropped'), expect.anything());

  log.calls[0].resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(log.calls.map((c) => `${c.roomId}${c.version}`)).toStrictEqual(['R1', 'S1', 'R3']);
});

test('flush resolves true once everything is written, and wakes batches sleeping in backoff', async () => {
  let fail = true;
  const log = { appendMany: vi.fn(async () => { if (fail) throw new Error('down'); }) };
  const writer = createLogWriter(log);
  writer.enqueue('R', [cmd(1)], 1);
  await vi.advanceTimersByTimeAsync(0); // now sleeping 500ms
  fail = false;

  const flushed = writer.flush(3000);
  await vi.advanceTimersByTimeAsync(0);

  await expect(flushed).resolves.toBe(true);
  expect(log.appendMany).toHaveBeenCalledTimes(2);
});

test('flush gives up after its timeout and resolves false', async () => {
  const log = { appendMany: vi.fn(() => new Promise(() => {})) }; // hangs forever
  const writer = createLogWriter(log);
  writer.enqueue('R', [cmd(1)], 1);

  const flushed = writer.flush(3000);
  await vi.advanceTimersByTimeAsync(3000);

  await expect(flushed).resolves.toBe(false);
  expect(writer.pending()).toBe(1);
});

test('flush with nothing pending resolves true immediately', async () => {
  const writer = createLogWriter({ appendMany: vi.fn() });
  await expect(writer.flush(10)).resolves.toBe(true);
});
