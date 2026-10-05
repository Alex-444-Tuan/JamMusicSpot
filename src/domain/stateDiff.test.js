import { expect, test } from 'vitest';
import { diffState, applyOps, composeDiffs, chooseCompact } from './stateDiff.js';

const IDLE = { status: 'IDLE', currentTrackId: null, startedAt: null, pausedAt: null };
const item = (trackId, upvotedBy = [], addedAt = 1000, addedBy = 'Tuan') => ({ trackId, addedBy, addedAt, upvotedBy });
const state = (queue, playback = IDLE) => ({ queue, playback });

// ---------- diffState: each op type ----------

test('identical states → no ops', () => {
  const s = state([item('a'), item('b')]);
  expect(diffState(s, structuredClone(s))).toStrictEqual([]);
});

test('a removed item → queue.remove', () => {
  expect(diffState(state([item('a'), item('b')]), state([item('b')])))
    .toStrictEqual([{ op: 'queue.remove', trackId: 'a' }]);
});

test('a new item at the end → queue.upsert only (append needs no reorder)', () => {
  expect(diffState(state([item('a')]), state([item('a'), item('b')])))
    .toStrictEqual([{ op: 'queue.upsert', item: item('b') }]);
});

test('a changed item → queue.upsert with the whole new item', () => {
  expect(diffState(state([item('a'), item('b')]), state([item('a'), item('b', ['u1'])])))
    .toStrictEqual([{ op: 'queue.upsert', item: item('b', ['u1']) }]);
});

test('a reorder only → queue.order', () => {
  expect(diffState(state([item('a'), item('b'), item('c')]), state([item('c'), item('a'), item('b')])))
    .toStrictEqual([{ op: 'queue.order', trackIds: ['c', 'a', 'b'] }]);
});

test('a vote that moves an item forward → upsert then order', () => {
  expect(diffState(state([item('a'), item('b')]), state([item('b', ['u1']), item('a')]))).toStrictEqual([
    { op: 'queue.upsert', item: item('b', ['u1']) },
    { op: 'queue.order', trackIds: ['b', 'a'] },
  ]);
});

test('remove + append (a SKIP that also queues) → remove, then upsert', () => {
  expect(diffState(state([item('a'), item('b')]), state([item('b'), item('c')]))).toStrictEqual([
    { op: 'queue.remove', trackId: 'a' },
    { op: 'queue.upsert', item: item('c') },
  ]);
});

test('playback only → playback.set', () => {
  const playing = { status: 'PLAYING', currentTrackId: 'a', startedAt: 5, pausedAt: null };
  expect(diffState(state([item('b')]), state([item('b')], playing)))
    .toStrictEqual([{ op: 'playback.set', playback: playing }]);
});

test('op order is removes, upserts, order, playback', () => {
  const playing = { status: 'PLAYING', currentTrackId: 'a', startedAt: 5, pausedAt: null };
  const ops = diffState(state([item('a'), item('b'), item('c')]), state([item('d'), item('c', ['x']), item('b')], playing));
  expect(ops.map((o) => o.op)).toStrictEqual(['queue.remove', 'queue.upsert', 'queue.upsert', 'queue.order', 'playback.set']);
});

test('item comparison ignores key order', () => {
  const a = { upvotedBy: [], addedAt: 1000, addedBy: 'Tuan', trackId: 'a' };
  expect(diffState(state([item('a')]), state([a]))).toStrictEqual([]);
});

// ---------- applyOps ----------

test('applyOps never mutates its input', () => {
  const before = state([item('a', ['u']), item('b')]);
  const frozen = structuredClone(before);
  applyOps(before, [
    { op: 'queue.remove', trackId: 'a' },
    { op: 'queue.upsert', item: item('b', ['z']) },
    { op: 'queue.upsert', item: item('c') },
    { op: 'queue.order', trackIds: ['c', 'b'] },
    { op: 'playback.set', playback: { status: 'PLAYING', currentTrackId: 'a', startedAt: 1, pausedAt: null } },
  ]);
  expect(before).toStrictEqual(frozen);
});

test('applyOps returns exactly {queue, playback}', () => {
  const result = applyOps({ version: 3, queue: [item('a')], playback: IDLE }, []);
  expect(result).toStrictEqual({ queue: [item('a')], playback: IDLE });
});

test('applyOps upsert replaces in place, else appends', () => {
  const result = applyOps(state([item('a'), item('b')]), [
    { op: 'queue.upsert', item: item('a', ['u']) },
    { op: 'queue.upsert', item: item('c') },
  ]);
  expect(result.queue).toStrictEqual([item('a', ['u']), item('b'), item('c')]);
});

test('applyOps throws DIFF_MISMATCH on removing an absent track', () => {
  expect(() => applyOps(state([item('a')]), [{ op: 'queue.remove', trackId: 'zz' }])).toThrow('DIFF_MISMATCH');
});

test('applyOps throws DIFF_MISMATCH when queue.order is not a permutation', () => {
  const s = state([item('a'), item('b')]);
  expect(() => applyOps(s, [{ op: 'queue.order', trackIds: ['a'] }])).toThrow('DIFF_MISMATCH');
  expect(() => applyOps(s, [{ op: 'queue.order', trackIds: ['a', 'c'] }])).toThrow('DIFF_MISMATCH');
  expect(() => applyOps(s, [{ op: 'queue.order', trackIds: ['a', 'a'] }])).toThrow('DIFF_MISMATCH');
});

test('applyOps throws DIFF_MISMATCH on an unknown op', () => {
  expect(() => applyOps(state([]), [{ op: 'queue.nuke' }])).toThrow('DIFF_MISMATCH');
});

// ---------- property test: applyOps(before, diffState(before, after)) == after ----------

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomStep(rand, s, counter) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const queue = s.queue.map((t) => ({ ...t, upvotedBy: [...t.upvotedBy] }));
  let playback = { ...s.playback };
  const n = 1 + Math.floor(rand() * 4); // several mutations between snapshots
  for (let i = 0; i < n; i++) {
    const r = rand();
    if (r < 0.3) {
      queue.push(item(`t${counter.next++}`, [], 1000 + counter.next));
    } else if (r < 0.45 && queue.length > 0) {
      queue.splice(Math.floor(rand() * queue.length), 1);
    } else if (r < 0.65 && queue.length > 0) {
      const t = pick(queue);
      const u = `u${Math.floor(rand() * 5)}`;
      if (!t.upvotedBy.includes(u)) t.upvotedBy = [...t.upvotedBy, u].sort();
    } else if (r < 0.8 && queue.length > 1) {
      for (let k = queue.length - 1; k > 0; k--) {
        const j = Math.floor(rand() * (k + 1));
        [queue[k], queue[j]] = [queue[j], queue[k]];
      }
    } else {
      playback = pick([
        IDLE,
        { status: 'PLAYING', currentTrackId: `t${counter.next}`, startedAt: Math.floor(rand() * 1e6), pausedAt: null },
        { status: 'PAUSED', currentTrackId: 't1', startedAt: 10, pausedAt: Math.floor(rand() * 1e6) },
      ]);
    }
  }
  return { queue, playback };
}

test('property: applyOps(before, diffState(before, after)) deep-equals after (seeded, 200 iterations)', () => {
  const rand = mulberry32(20261004);
  const counter = { next: 0 };
  let before = state([]);
  let nonEmpty = 0;
  for (let i = 0; i < 200; i++) {
    const after = randomStep(rand, before, counter);
    const ops = diffState(before, after);
    if (ops.length > 0) nonEmpty++;
    expect(applyOps(before, ops)).toStrictEqual(after);
    before = after;
  }
  expect(nonEmpty).toBeGreaterThan(150); // the generator actually exercised the differ
});

// ---------- composeDiffs ----------

test('composeDiffs requires contiguity', () => {
  expect(() => composeDiffs({ fromVersion: 1, toVersion: 2, ops: [] }, { fromVersion: 3, toVersion: 4, ops: [] }))
    .toThrow();
});

test('composeDiffs concatenates ops and keeps only the last playback.set', () => {
  const p1 = { status: 'PLAYING', currentTrackId: 'a', startedAt: 1, pausedAt: null };
  const p2 = { status: 'PAUSED', currentTrackId: 'a', startedAt: 1, pausedAt: 9 };
  const a = { fromVersion: 1, toVersion: 2, ops: [{ op: 'playback.set', playback: p1 }, { op: 'queue.remove', trackId: 'a' }] };
  const b = { fromVersion: 2, toVersion: 3, ops: [{ op: 'queue.upsert', item: item('c') }, { op: 'playback.set', playback: p2 }] };
  expect(composeDiffs(a, b)).toStrictEqual({
    fromVersion: 1,
    toVersion: 3,
    ops: [{ op: 'queue.remove', trackId: 'a' }, { op: 'queue.upsert', item: item('c') }, { op: 'playback.set', playback: p2 }],
  });
});

test('composeDiffs is associative under application, and equals sequential application', () => {
  const rand = mulberry32(7);
  const counter = { next: 0 };
  for (let round = 0; round < 25; round++) {
    const s0 = randomStep(rand, state([]), counter);
    const s1 = randomStep(rand, s0, counter);
    const s2 = randomStep(rand, s1, counter);
    const s3 = randomStep(rand, s2, counter);
    const a = { fromVersion: 0, toVersion: 1, ops: diffState(s0, s1) };
    const b = { fromVersion: 1, toVersion: 2, ops: diffState(s1, s2) };
    const c = { fromVersion: 2, toVersion: 3, ops: diffState(s2, s3) };

    const left = composeDiffs(composeDiffs(a, b), c);
    const right = composeDiffs(a, composeDiffs(b, c));
    expect(left.fromVersion).toBe(0);
    expect(left.toVersion).toBe(3);
    expect(applyOps(s0, left.ops)).toStrictEqual(s3);
    expect(applyOps(s0, right.ops)).toStrictEqual(s3);
  }
});

// ---------- state.replace + chooseCompact ----------

test('state.replace swaps in the whole state and works at any position', () => {
  const playing = { status: 'PLAYING', currentTrackId: 'z', startedAt: 9, pausedAt: null };
  const result = applyOps(state([item('a'), item('b')]), [
    { op: 'queue.remove', trackId: 'a' },
    { op: 'state.replace', queue: [item('x', ['u']), item('y')], playback: playing },
    { op: 'queue.upsert', item: item('w') },
  ]);
  expect(result).toStrictEqual({ queue: [item('x', ['u']), item('y'), item('w')], playback: playing });
});

test('state.replace does not alias the op\'s arrays', () => {
  const op = { op: 'state.replace', queue: [item('x', ['u'])], playback: IDLE };
  const result = applyOps(state([]), [op]);
  result.queue[0].upvotedBy.push('mutated');
  expect(op.queue[0].upvotedBy).toStrictEqual(['u']);
});

test('chooseCompact keeps small op diffs', () => {
  const before = state([item('a'), item('b')]);
  const after = state([item('a'), item('b', ['u1'])]);
  expect(chooseCompact(before, after)).toStrictEqual(diffState(before, after));
});

test('chooseCompact switches to state.replace when the ops would be larger than the state', () => {
  const before = state([item('a'), item('b'), item('c')]);
  const after = state([item('d'), item('e')]); // 3 removes + 2 upserts > the new state itself
  const ops = chooseCompact(before, after);
  expect(ops).toStrictEqual([{ op: 'state.replace', queue: after.queue, playback: after.playback }]);
  expect(applyOps(before, ops)).toStrictEqual(after);
});

test('chooseCompact of identical states is []', () => {
  const s = state([item('a')]);
  expect(chooseCompact(s, structuredClone(s))).toStrictEqual([]);
});
