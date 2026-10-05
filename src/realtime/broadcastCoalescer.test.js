import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createCoalescingBroadcaster } from './broadcastCoalescer.js';
import { diffState, applyOps } from '../domain/stateDiff.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const upsert = (trackId) => ({ op: 'queue.upsert', item: { trackId, addedBy: 'u', addedAt: 1, upvotedBy: [] } });
const diff = (fromVersion, toVersion, ops = [upsert(`t${toVersion}`)]) => ({ fromVersion, toVersion, ops });

test('contiguous diffs within the window compose into one broadcast spanning all of them', () => {
  const fakeBroadcaster = { publishDiff: vi.fn() };
  const coalescer = createCoalescingBroadcaster(fakeBroadcaster, 100);

  coalescer.publishDiff('room-1', diff(0, 1));
  coalescer.publishDiff('room-1', diff(1, 2));
  coalescer.publishDiff('room-1', diff(2, 3));

  vi.advanceTimersByTime(100);

  expect(fakeBroadcaster.publishDiff).toHaveBeenCalledTimes(1);
  expect(fakeBroadcaster.publishDiff).toHaveBeenCalledWith('room-1', {
    fromVersion: 0,
    toVersion: 3,
    ops: [upsert('t1'), upsert('t2'), upsert('t3')],
  });
});

test('does not broadcast before the window has fully elapsed', () => {
  const fakeBroadcaster = { publishDiff: vi.fn() };
  const coalescer = createCoalescingBroadcaster(fakeBroadcaster, 100);

  coalescer.publishDiff('room-1', diff(0, 1));

  vi.advanceTimersByTime(99);

  expect(fakeBroadcaster.publishDiff).not.toHaveBeenCalled();
});

test('different rooms coalesce independently of each other', () => {
  const fakeBroadcaster = { publishDiff: vi.fn() };
  const coalescer = createCoalescingBroadcaster(fakeBroadcaster, 100);

  coalescer.publishDiff('room-1', diff(0, 1));
  coalescer.publishDiff('room-2', diff(0, 1));

  vi.advanceTimersByTime(100);

  expect(fakeBroadcaster.publishDiff).toHaveBeenCalledTimes(2);
  expect(fakeBroadcaster.publishDiff).toHaveBeenCalledWith('room-1', diff(0, 1));
  expect(fakeBroadcaster.publishDiff).toHaveBeenCalledWith('room-2', diff(0, 1));
});

test('a new window opens after the previous one flushes', () => {
  const fakeBroadcaster = { publishDiff: vi.fn() };
  const coalescer = createCoalescingBroadcaster(fakeBroadcaster, 100);

  coalescer.publishDiff('room-1', diff(0, 1));
  vi.advanceTimersByTime(100);

  coalescer.publishDiff('room-1', diff(1, 2));
  vi.advanceTimersByTime(100);

  expect(fakeBroadcaster.publishDiff).toHaveBeenCalledTimes(2);
  expect(fakeBroadcaster.publishDiff).toHaveBeenNthCalledWith(1, 'room-1', diff(0, 1));
  expect(fakeBroadcaster.publishDiff).toHaveBeenNthCalledWith(2, 'room-1', diff(1, 2));
});

test('a non-contiguous diff starts a new run: two broadcasts, in order, never merged across the gap', () => {
  const fakeBroadcaster = { publishDiff: vi.fn() };
  const coalescer = createCoalescingBroadcaster(fakeBroadcaster, 100);

  coalescer.publishDiff('room-1', diff(0, 1));
  coalescer.publishDiff('room-1', diff(1, 2));
  coalescer.publishDiff('room-1', diff(3, 4)); // 2→3 was produced by another instance
  coalescer.publishDiff('room-1', diff(4, 5));

  vi.advanceTimersByTime(100);

  expect(fakeBroadcaster.publishDiff).toHaveBeenCalledTimes(2);
  expect(fakeBroadcaster.publishDiff).toHaveBeenNthCalledWith(1, 'room-1', { fromVersion: 0, toVersion: 2, ops: [upsert('t1'), upsert('t2')] });
  expect(fakeBroadcaster.publishDiff).toHaveBeenNthCalledWith(2, 'room-1', { fromVersion: 3, toVersion: 5, ops: [upsert('t4'), upsert('t5')] });
});

test('a composed run keeps only the last playback.set', () => {
  const fakeBroadcaster = { publishDiff: vi.fn() };
  const coalescer = createCoalescingBroadcaster(fakeBroadcaster, 100);
  const play = { op: 'playback.set', playback: { status: 'PLAYING', currentTrackId: 'a', startedAt: 1, pausedAt: null } };
  const pause = { op: 'playback.set', playback: { status: 'PAUSED', currentTrackId: 'a', startedAt: 1, pausedAt: 5 } };

  coalescer.publishDiff('room-1', diff(0, 1, [play]));
  coalescer.publishDiff('room-1', diff(1, 2, [pause]));
  vi.advanceTimersByTime(100);

  expect(fakeBroadcaster.publishDiff).toHaveBeenCalledWith('room-1', { fromVersion: 0, toVersion: 2, ops: [pause] });
});

// ---------- endpoint diffs: a coalesced run costs at most about a snapshot ----------


const IDLE = { status: 'IDLE', currentTrackId: null, startedAt: null, pausedAt: null };
const track = (i) => ({ trackId: `track-${String(i).padStart(2, '0')}`, addedBy: `user${i % 5}`, addedAt: 1_791_169_000_000 + i, upvotedBy: [] });

// Each vote bumps one track to the front — worst case for op diffs (every
// step needs an upsert and a full queue.order).
function voteBurst(trackCount, votes) {
  const states = [{ queue: Array.from({ length: trackCount }, (_, i) => track(i)), playback: IDLE }];
  for (let v = 0; v < votes; v++) {
    const prev = states[states.length - 1];
    const idx = trackCount - 1 - (v % trackCount);
    const voted = { ...prev.queue[idx], upvotedBy: [...prev.queue[idx].upvotedBy, `voter-${v}`].sort() };
    const queue = [voted, ...prev.queue.filter((_, i) => i !== idx)];
    states.push({ queue, playback: prev.playback });
  }
  return states;
}

function publishStates(coalescer, roomId, states, firstVersion = 0) {
  for (let i = 1; i < states.length; i++) {
    const before = states[i - 1];
    const after = states[i];
    coalescer.publishDiff(roomId, {
      fromVersion: firstVersion + i - 1,
      toVersion: firstVersion + i,
      ops: diffState(before, after),
    }, { before, after });
  }
}

test.each([8, 30])('a coalesced 10-vote burst on %i tracks is no bigger than a full snapshot (+64 bytes)', (trackCount) => {
  const fakeBroadcaster = { publishDiff: vi.fn() };
  const coalescer = createCoalescingBroadcaster(fakeBroadcaster, 100);
  const states = voteBurst(trackCount, 10);

  publishStates(coalescer, 'room-1', states);
  vi.advanceTimersByTime(100);

  expect(fakeBroadcaster.publishDiff).toHaveBeenCalledTimes(1);
  const wire = fakeBroadcaster.publishDiff.mock.calls[0][1];
  const last = states[states.length - 1];
  const snapshot = { version: 10, queue: last.queue, playback: last.playback };
  expect(JSON.stringify(wire).length).toBeLessThanOrEqual(JSON.stringify(snapshot).length + 64);
  expect(applyOps(states[0], wire.ops)).toStrictEqual(last);
});

test('the emitted diff carries only {fromVersion, toVersion, ops} — internal states never leak', () => {
  const fakeBroadcaster = { publishDiff: vi.fn() };
  const coalescer = createCoalescingBroadcaster(fakeBroadcaster, 100);
  publishStates(coalescer, 'room-1', voteBurst(4, 3));
  vi.advanceTimersByTime(100);

  const [roomId, wire, ...rest] = fakeBroadcaster.publishDiff.mock.calls[0];
  expect(roomId).toBe('room-1');
  expect(rest).toStrictEqual([]);
  expect(Object.keys(wire).sort()).toStrictEqual(['fromVersion', 'ops', 'toVersion']);
  expect(wire.fromVersion).toBe(0);
  expect(wire.toVersion).toBe(3);
});

test('endpoint diffs: non-contiguous runs stay separate, each spanning its own endpoints', () => {
  const fakeBroadcaster = { publishDiff: vi.fn() };
  const coalescer = createCoalescingBroadcaster(fakeBroadcaster, 100);
  const states = voteBurst(5, 6);
  publishStates(coalescer, 'room-1', states.slice(0, 3), 0); // 0→1, 1→2
  publishStates(coalescer, 'room-1', states.slice(3), 3); // 3→4 … (2→3 came from elsewhere)
  vi.advanceTimersByTime(100);

  const calls = fakeBroadcaster.publishDiff.mock.calls.map((c) => c[1]);
  expect(calls.map((d) => [d.fromVersion, d.toVersion])).toStrictEqual([[0, 2], [3, 6]]);
  expect(applyOps(states[0], calls[0].ops)).toStrictEqual(states[2]);
  expect(applyOps(states[3], calls[1].ops)).toStrictEqual(states[6]);
});

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomNext(rand, s, counter) {
  const queue = s.queue.map((t) => ({ ...t, upvotedBy: [...t.upvotedBy] }));
  let playback = s.playback;
  const r = rand();
  if (r < 0.3 || queue.length === 0) {
    queue.push(track(100 + counter.next++));
  } else if (r < 0.45) {
    queue.splice(Math.floor(rand() * queue.length), 1);
  } else if (r < 0.75) {
    const i = Math.floor(rand() * queue.length);
    queue[i].upvotedBy = [...new Set([...queue[i].upvotedBy, `u${Math.floor(rand() * 6)}`])].sort();
    if (rand() < 0.7) queue.unshift(queue.splice(i, 1)[0]);
  } else {
    playback = rand() < 0.5
      ? IDLE
      : { status: 'PLAYING', currentTrackId: `track-${counter.next}`, startedAt: Math.floor(rand() * 1e12), pausedAt: null };
  }
  return { queue, playback };
}

test('property: applyOps(firstBefore, coalesced.ops) deep-equals lastAfter (seeded, 200 iterations)', () => {
  const rand = mulberry32(31337);
  const counter = { next: 0 };
  let start = { queue: [track(0), track(1)], playback: IDLE };
  let replaced = 0;
  for (let i = 0; i < 200; i++) {
    const fakeBroadcaster = { publishDiff: vi.fn() };
    const coalescer = createCoalescingBroadcaster(fakeBroadcaster, 100);
    const states = [start];
    const steps = 1 + Math.floor(rand() * 8);
    for (let k = 0; k < steps; k++) states.push(randomNext(rand, states[states.length - 1], counter));

    publishStates(coalescer, 'room-1', states, i * 10);
    vi.advanceTimersByTime(100);

    expect(fakeBroadcaster.publishDiff).toHaveBeenCalledTimes(1);
    const wire = fakeBroadcaster.publishDiff.mock.calls[0][1];
    expect(wire.fromVersion).toBe(i * 10);
    expect(wire.toVersion).toBe(i * 10 + steps);
    expect(applyOps(start, wire.ops)).toStrictEqual(states[states.length - 1]);
    if (wire.ops.some((o) => o.op === 'state.replace')) replaced++;
    start = states[states.length - 1];
  }
  expect(replaced).toBeGreaterThan(0); // both representations were exercised
  expect(replaced).toBeLessThan(200);
});
