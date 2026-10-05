import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { randomInt } from 'node:crypto';
import Redis from 'ioredis';
import { createRedisRoomStore } from '../adapters/redis/roomStore.js';
import { createRedisPlaybackStore } from '../adapters/redis/playbackStore.js';
import { createRedisJamStore } from '../adapters/redis/jamStore.js';
import { createRedisRoomLock } from '../adapters/redis/roomLock.js';
import { createJamService, JAM_ID_PATTERN } from './jamService.js';
import { createLogWriter } from './logWriter.js';
import { applyOps } from '../domain/stateDiff.js';
import { bindJamHandlers } from '../realtime/socketGateway.js';

const catalog = [
  { trackId: 'song-a', title: 'A', artist: 'X', durationMs: 180000, color: '#111111' },
  { trackId: 'song-b', title: 'B', artist: 'X', durationMs: 180000, color: '#222222' },
  { trackId: 'song-c', title: 'C', artist: 'X', durationMs: 180000, color: '#333333' },
  { trackId: 'song-x', title: 'X', artist: 'X', durationMs: 180000, color: '#444444' },
];

const realRandomId = (length, alphabet) =>
  Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join('');

let redis;
let jamStore;
let roomStore;
let playbackStore;
let roomLock;
let log;
let diffs;
let now;
let service;
const createdJams = [];

beforeAll(() => {
  redis = new Redis();
  jamStore = createRedisJamStore(redis);
  roomStore = createRedisRoomStore(redis);
  playbackStore = createRedisPlaybackStore(redis);
  roomLock = createRedisRoomLock(redis);
});

afterAll(async () => {
  await redis.quit();
});

// Forwards straight to a fake CommandLogPort, synchronously, so tests can
// inspect appendMany calls right after handleCommand resolves. The real
// queueing/retry writer is covered in logWriter.test.js.
const forwardingWriter = (commandLog) => ({
  enqueue(jamId, commands, version) {
    Promise.resolve(commandLog.appendMany(jamId, commands, version)).catch(() => {});
  },
});

function build(overrides = {}) {
  const { commandLog = log, ...rest } = overrides;
  return createJamService({
    jamStore,
    roomStore,
    playbackStore,
    roomLock,
    logWriter: forwardingWriter(commandLog),
    broadcaster: { publishDiff: async (roomId, diff) => { diffs.push({ roomId, diff }); } },
    clock: { now: () => now },
    catalog,
    randomId: realRandomId,
    ...rest,
  });
}

beforeEach(() => {
  diffs = [];
  now = 1_000_000;
  log = { append: vi.fn(async () => {}), appendMany: vi.fn(async () => {}) };
  service = build();
});

afterEach(async () => {
  for (const jamId of createdJams.splice(0)) {
    const keys = await redis.keys(`room:${jamId}:*`);
    if (keys.length > 0) await redis.del(...keys);
  }
});

async function newJam() {
  const jam = await service.createJam();
  createdJams.push(jam.jamId);
  const host = { jamId: jam.jamId, userId: 'host-user', name: 'Host', isHost: true };
  const guest = { jamId: jam.jamId, userId: 'guest-user', name: 'Guest', isHost: false };
  return { ...jam, host, guest };
}

// ---------- createJam / joinJam ----------

test('createJam returns a well-formed id, a host token, and an invite url', async () => {
  const { jamId, hostToken, inviteUrl } = await newJam();

  expect(jamId).toMatch(JAM_ID_PATTERN);
  expect(JAM_ID_PATTERN.source).toBe('^[A-HJ-NP-Z2-9]{6}$');
  expect(typeof hostToken).toBe('string');
  expect(hostToken.length).toBeGreaterThanOrEqual(24);
  expect(inviteUrl).toBe(`/?jam=${jamId}`);
  expect(await jamStore.get(jamId)).toStrictEqual({ hostToken, createdAt: now });
});

test('createJam retries with a fresh id when the first one is taken', async () => {
  const taken = await newJam();
  const fresh = realRandomId(6, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789');
  const ids = [taken.jamId, fresh];
  const svc = build({
    randomId: (length, alphabet) => (length === 6 ? ids.shift() : realRandomId(length, alphabet)),
  });

  const jam = await svc.createJam();
  createdJams.push(jam.jamId);

  expect(jam.jamId).toBe(fresh);
});

test('createJam gives up with INTERNAL after 5 collisions', async () => {
  const taken = await newJam();
  const svc = build({
    randomId: (length, alphabet) => (length === 6 ? taken.jamId : realRandomId(length, alphabet)),
  });

  await expect(svc.createJam()).rejects.toMatchObject({ code: 'INTERNAL' });
});

test('joinJam on an unknown or malformed jam → JAM_NOT_FOUND', async () => {
  await expect(service.joinJam({ jamId: 'ZZZZZZ', userId: 'u', name: 'n' })).rejects.toMatchObject({ code: 'JAM_NOT_FOUND' });
  await expect(service.joinJam({ jamId: 'abc', userId: 'u', name: 'n' })).rejects.toMatchObject({ code: 'JAM_NOT_FOUND' });
  await expect(service.getJam('ZZZZZZ')).rejects.toMatchObject({ code: 'JAM_NOT_FOUND' });
});

test('joinJam validates name and userId → BAD_REQUEST', async () => {
  const { jamId } = await newJam();
  await expect(service.joinJam({ jamId, userId: 'u', name: '   ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  await expect(service.joinJam({ jamId, userId: 'u', name: 'x'.repeat(33) })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  await expect(service.joinJam({ jamId, userId: 'x'.repeat(65), name: 'n' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  await expect(service.joinJam({ jamId, userId: 42, name: 'n' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

test('joinJam: right hostToken → host, wrong or missing token → guest; name is trimmed', async () => {
  const { jamId, hostToken } = await newJam();

  expect(await service.joinJam({ jamId, userId: 'u1', name: '  Tuan  ', hostToken }))
    .toStrictEqual({ isHost: true, userId: 'u1', name: 'Tuan' });
  expect((await service.joinJam({ jamId, userId: 'u2', name: 'A', hostToken: 'nope' })).isHost).toBe(false);
  expect((await service.joinJam({ jamId, userId: 'u3', name: 'B' })).isHost).toBe(false);
});

test('getSnapshot of a fresh jam is empty and IDLE at version 0', async () => {
  const { jamId } = await newJam();
  expect(await service.getSnapshot(jamId)).toStrictEqual({
    version: 0,
    queue: [],
    playback: { status: 'IDLE', currentTrackId: null, startedAt: null, pausedAt: null },
  });
});

// ---------- command trust & validation ----------

test('ADD_TRACK ignores client-supplied addedAt/addedBy; server stamps them', async () => {
  const { jamId, guest } = await newJam();

  await service.handleCommand(guest, { type: 'ADD_TRACK', payload: { trackId: 'song-a', addedAt: 0, addedBy: 'Mallory' } });

  const { queue } = await service.getSnapshot(jamId);
  expect(queue).toStrictEqual([{ trackId: 'song-a', addedBy: 'Guest', addedAt: now, upvotedBy: [] }]);
});

test('ADD_TRACK: not in catalog → UNKNOWN_TRACK; already queued → DUPLICATE_TRACK', async () => {
  const { guest } = await newJam();
  await expect(service.handleCommand(guest, { type: 'ADD_TRACK', payload: { trackId: 'nope' } }))
    .rejects.toMatchObject({ code: 'UNKNOWN_TRACK' });

  await service.handleCommand(guest, { type: 'ADD_TRACK', payload: { trackId: 'song-a' } });
  await expect(service.handleCommand(guest, { type: 'ADD_TRACK', payload: { trackId: 'song-a' } }))
    .rejects.toMatchObject({ code: 'DUPLICATE_TRACK' });
});

test('UPVOTE votes as ctx.userId, not a client-supplied userId', async () => {
  const { jamId, guest } = await newJam();
  await service.handleCommand(guest, { type: 'ADD_TRACK', payload: { trackId: 'song-a' } });

  await service.handleCommand(guest, { type: 'UPVOTE', payload: { trackId: 'song-a', userId: 'someone-else' } });

  const { queue } = await service.getSnapshot(jamId);
  expect(queue[0].upvotedBy).toStrictEqual(['guest-user']);
});

test('UPVOTE on a track not in the queue → NOT_IN_QUEUE', async () => {
  const { guest } = await newJam();
  await expect(service.handleCommand(guest, { type: 'UPVOTE', payload: { trackId: 'song-a' } }))
    .rejects.toMatchObject({ code: 'NOT_IN_QUEUE' });
});

test('a repeat UPVOTE is ok with no version bump, no log entry, no broadcast', async () => {
  const { guest } = await newJam();
  await service.handleCommand(guest, { type: 'ADD_TRACK', payload: { trackId: 'song-a' } });
  const first = await service.handleCommand(guest, { type: 'UPVOTE', payload: { trackId: 'song-a' } });
  const logCalls = log.append.mock.calls.length + log.appendMany.mock.calls.length;
  const diffCount = diffs.length;

  const repeat = await service.handleCommand(guest, { type: 'UPVOTE', payload: { trackId: 'song-a' } });

  expect(repeat).toStrictEqual({ version: first.version });
  expect(log.append.mock.calls.length + log.appendMany.mock.calls.length).toBe(logCalls);
  expect(diffs.length).toBe(diffCount);
});

test('guest PLAY / PAUSE / SKIP → NOT_HOST', async () => {
  const { guest } = await newJam();
  for (const raw of [
    { type: 'PLAY', payload: {} },
    { type: 'PAUSE', payload: {} },
    { type: 'SKIP', payload: { expectedTrackId: null } },
  ]) {
    await expect(service.handleCommand(guest, raw)).rejects.toMatchObject({ code: 'NOT_HOST' });
  }
});

test('malformed commands → BAD_COMMAND', async () => {
  const { host } = await newJam();
  for (const raw of [
    null,
    'ADD_TRACK',
    { type: 'NUKE', payload: {} },
    { type: 'REMOVE_TRACK', payload: { trackId: 'song-a' } }, // internal-only command
    { type: 'ADD_TRACK', payload: { trackId: 42 } },
    { type: 'UPVOTE' },
    { type: 'SKIP', payload: {} }, // expectedTrackId must be string|null
  ]) {
    await expect(service.handleCommand(host, raw)).rejects.toMatchObject({ code: 'BAD_COMMAND' });
  }
});

// ---------- SKIP semantics ----------

test('SKIP null from IDLE starts the first queued track and removes it from the queue', async () => {
  const { jamId, host } = await newJam();
  await service.handleCommand(host, { type: 'ADD_TRACK', payload: { trackId: 'song-a' } });
  now += 10;
  await service.handleCommand(host, { type: 'ADD_TRACK', payload: { trackId: 'song-b' } });
  now = 2_000_000;

  await service.handleCommand(host, { type: 'SKIP', payload: { expectedTrackId: null } });

  const snap = await service.getSnapshot(jamId);
  expect(snap.playback).toStrictEqual({ status: 'PLAYING', currentTrackId: 'song-a', startedAt: 2_000_000, pausedAt: null });
  expect(snap.queue.map((t) => t.trackId)).toStrictEqual(['song-b']);
});

test('SKIP logs RemoveTrack for the dequeued track, then the Skip, in one appendMany at the ack version', async () => {
  const { jamId, host } = await newJam();
  await service.handleCommand(host, { type: 'ADD_TRACK', payload: { trackId: 'song-a' } });
  log.appendMany.mockClear();

  const ack = await service.handleCommand(host, { type: 'SKIP', payload: { expectedTrackId: null } });

  expect(log.appendMany.mock.calls).toStrictEqual([
    [jamId, [
      { type: 'REMOVE_TRACK', payload: { trackId: 'song-a' } },
      { type: 'SKIP', payload: { trackId: 'song-a', at: now } },
    ], ack.version],
  ]);
  expect(log.append).not.toHaveBeenCalled();
});

test('SKIP with an expectedTrackId that is not current → STALE_SKIP, queue untouched', async () => {
  const { jamId, host } = await newJam();
  await service.handleCommand(host, { type: 'ADD_TRACK', payload: { trackId: 'song-a' } });

  await expect(service.handleCommand(host, { type: 'SKIP', payload: { expectedTrackId: 'song-z' } }))
    .rejects.toMatchObject({ code: 'STALE_SKIP' });
  expect((await service.getSnapshot(jamId)).queue).toHaveLength(1);
});

test('two back-to-back SKIPs with the same expectedTrackId consume only one track', async () => {
  const { jamId, host } = await newJam();
  for (const trackId of ['song-a', 'song-b', 'song-c']) {
    await service.handleCommand(host, { type: 'ADD_TRACK', payload: { trackId } });
    now += 1;
  }
  await service.handleCommand(host, { type: 'SKIP', payload: { expectedTrackId: null } }); // plays song-a

  // Fired without awaiting in between — both carry the same view of "current".
  const results = await Promise.allSettled([
    service.handleCommand(host, { type: 'SKIP', payload: { expectedTrackId: 'song-a' } }),
    service.handleCommand(host, { type: 'SKIP', payload: { expectedTrackId: 'song-a' } }),
  ]);

  expect(results.map((r) => r.status).sort()).toStrictEqual(['fulfilled', 'rejected']);
  expect(results.find((r) => r.status === 'rejected').reason.code).toBe('STALE_SKIP');
  const snap = await service.getSnapshot(jamId);
  expect(snap.playback.currentTrackId).toBe('song-b');
  expect(snap.queue.map((t) => t.trackId)).toStrictEqual(['song-c']);
});

test('SKIP on the last track goes IDLE; SKIP null while IDLE with an empty queue is a no-op', async () => {
  const { jamId, host } = await newJam();
  await service.handleCommand(host, { type: 'ADD_TRACK', payload: { trackId: 'song-a' } });
  await service.handleCommand(host, { type: 'SKIP', payload: { expectedTrackId: null } });

  await service.handleCommand(host, { type: 'SKIP', payload: { expectedTrackId: 'song-a' } });
  const idle = await service.getSnapshot(jamId);
  expect(idle.playback).toStrictEqual({ status: 'IDLE', currentTrackId: null, startedAt: null, pausedAt: null });

  const again = await service.handleCommand(host, { type: 'SKIP', payload: { expectedTrackId: null } });
  expect(again).toStrictEqual({ version: idle.version });
});

test('host PAUSE then PLAY preserves position using server time', async () => {
  const { jamId, host } = await newJam();
  await service.handleCommand(host, { type: 'ADD_TRACK', payload: { trackId: 'song-a' } });
  now = 10_000;
  await service.handleCommand(host, { type: 'SKIP', payload: { expectedTrackId: null } });
  now = 25_000;
  await service.handleCommand(host, { type: 'PAUSE', payload: { at: 1 } }); // client `at` ignored
  now = 90_000;
  await service.handleCommand(host, { type: 'PLAY', payload: {} });

  const { playback } = await service.getSnapshot(jamId);
  expect(playback).toStrictEqual({ status: 'PLAYING', currentTrackId: 'song-a', startedAt: 75_000, pausedAt: null });
});

// ---------- versions, broadcasts, serialization ----------

test('each mutation bumps the total version and broadcasts an op diff from the previous version', async () => {
  const { jamId, guest } = await newJam();

  const r = await service.handleCommand(guest, { type: 'ADD_TRACK', payload: { trackId: 'song-a' } });

  expect(r).toStrictEqual({ version: 1 });
  expect(diffs).toStrictEqual([{
    roomId: jamId,
    diff: {
      fromVersion: 0,
      toVersion: 1,
      ops: [{ op: 'queue.upsert', item: { trackId: 'song-a', addedBy: 'Guest', addedAt: now, upvotedBy: [] } }],
    },
  }]);
});

test('a SKIP diff removes the dequeued track and sets playback in one version step', async () => {
  const { jamId, host } = await newJam();
  await service.handleCommand(host, { type: 'ADD_TRACK', payload: { trackId: 'song-a' } });
  diffs.length = 0;

  await service.handleCommand(host, { type: 'SKIP', payload: { expectedTrackId: null } });

  expect(diffs).toStrictEqual([{
    roomId: jamId,
    diff: {
      fromVersion: 1,
      toVersion: 2,
      ops: [
        { op: 'queue.remove', trackId: 'song-a' },
        { op: 'playback.set', playback: { status: 'PLAYING', currentTrackId: 'song-a', startedAt: now, pausedAt: null } },
      ],
    },
  }]);
});

test('applying every broadcast diff to the initial snapshot reproduces the live snapshot', async () => {
  const { jamId, host, guest } = await newJam();
  let state = await service.getSnapshot(jamId);
  const commands = [
    [guest, { type: 'ADD_TRACK', payload: { trackId: 'song-a' } }],
    [guest, { type: 'ADD_TRACK', payload: { trackId: 'song-b' } }],
    [host, { type: 'ADD_TRACK', payload: { trackId: 'song-c' } }],
    [guest, { type: 'UPVOTE', payload: { trackId: 'song-c' } }],
    [host, { type: 'UPVOTE', payload: { trackId: 'song-b' } }],
    [guest, { type: 'UPVOTE', payload: { trackId: 'song-b' } }],
    [host, { type: 'SKIP', payload: { expectedTrackId: null } }],
    [host, { type: 'PAUSE', payload: {} }],
    [host, { type: 'PLAY', payload: {} }],
    [guest, { type: 'ADD_TRACK', payload: { trackId: 'song-b' } }],
    [host, { type: 'SKIP', payload: { expectedTrackId: 'song-b' } }],
  ];
  for (const [ctx, raw] of commands) {
    now += 7;
    await service.handleCommand(ctx, raw);
  }

  let version = state.version;
  for (const { diff } of diffs) {
    expect(diff.fromVersion).toBe(version);
    state = { ...applyOps(state, diff.ops), version: diff.toVersion };
    version = diff.toVersion;
  }
  expect(state).toStrictEqual(await service.getSnapshot(jamId));
});

test('diff versions are strictly monotonic under concurrent commands, and a failing command does not break the chain', async () => {
  const { jamId, host, guest } = await newJam();

  const results = await Promise.allSettled([
    service.handleCommand(guest, { type: 'ADD_TRACK', payload: { trackId: 'song-a' } }),
    service.handleCommand(guest, { type: 'ADD_TRACK', payload: { trackId: 'song-a' } }), // DUPLICATE
    service.handleCommand(guest, { type: 'ADD_TRACK', payload: { trackId: 'song-b' } }),
    service.handleCommand(guest, { type: 'UPVOTE', payload: { trackId: 'song-b' } }),
    service.handleCommand(host, { type: 'UPVOTE', payload: { trackId: 'song-b' } }),
    service.handleCommand(guest, { type: 'UPVOTE', payload: { trackId: 'nope' } }), // NOT_IN_QUEUE
    service.handleCommand(host, { type: 'SKIP', payload: { expectedTrackId: null } }),
    service.handleCommand(guest, { type: 'ADD_TRACK', payload: { trackId: 'song-c' } }),
  ]);

  expect(results.filter((r) => r.status === 'rejected').map((r) => r.reason.code))
    .toStrictEqual(['DUPLICATE_TRACK', 'NOT_IN_QUEUE']);

  const versions = diffs.map((d) => d.diff.toVersion);
  expect(versions).toStrictEqual([1, 2, 3, 4, 5, 6]);
  expect(diffs.map((d) => d.diff.fromVersion)).toStrictEqual([0, 1, 2, 3, 4, 5]);
  const acked = results.filter((r) => r.status === 'fulfilled').map((r) => r.value.version);
  expect(acked).toStrictEqual([1, 2, 3, 4, 5, 6]);

  // commands ran in submission order: song-b (2 votes) was skipped to, song-a remains, then song-c
  const snap = await service.getSnapshot(jamId);
  expect(snap.version).toBe(6);
  expect(snap.playback.currentTrackId).toBe('song-b');
  expect(snap.queue.map((t) => t.trackId)).toStrictEqual(['song-a', 'song-c']);
});

test('the per-room chain is cleaned up once a room goes idle', async () => {
  const { guest } = await newJam();
  await service.handleCommand(guest, { type: 'ADD_TRACK', payload: { trackId: 'song-a' } });
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  expect(service._pendingRooms()).toBe(0);
});

// ---------- command log: versions line up with broadcasts ----------

function recordingLog() {
  const entries = [];
  return {
    entries,
    append: vi.fn(async (roomId, command, version, seq = 0) => { entries.push({ roomId, command, version, seq }); }),
    appendMany: vi.fn(async (roomId, commands, version) => {
      commands.forEach((command, seq) => entries.push({ roomId, command, version, seq }));
    }),
  };
}

test('logged versions equal ack versions; a SKIP logs REMOVE_TRACK + SKIP under one version with seq 0/1', async () => {
  const rec = recordingLog();
  service = build({ commandLog: rec });
  const { jamId, host, guest } = await newJam();

  const acks = [];
  acks.push((await service.handleCommand(guest, { type: 'ADD_TRACK', payload: { trackId: 'song-a' } })).version);
  now += 1;
  acks.push((await service.handleCommand(guest, { type: 'ADD_TRACK', payload: { trackId: 'song-b' } })).version);
  acks.push((await service.handleCommand(host, { type: 'SKIP', payload: { expectedTrackId: null } })).version);
  acks.push((await service.handleCommand(guest, { type: 'UPVOTE', payload: { trackId: 'song-b' } })).version);
  acks.push((await service.handleCommand(host, { type: 'SKIP', payload: { expectedTrackId: 'song-a' } })).version);

  expect(acks).toStrictEqual([1, 2, 3, 4, 5]);
  expect(rec.entries.map((e) => [e.roomId, e.version, e.seq, e.command.type])).toStrictEqual([
    [jamId, 1, 0, 'ADD_TRACK'],
    [jamId, 2, 0, 'ADD_TRACK'],
    [jamId, 3, 0, 'REMOVE_TRACK'],
    [jamId, 3, 1, 'SKIP'],
    [jamId, 4, 0, 'UPVOTE'],
    [jamId, 5, 0, 'REMOVE_TRACK'],
    [jamId, 5, 1, 'SKIP'],
  ]);
  expect(new Set(acks)).toStrictEqual(new Set(rec.entries.map((e) => e.version)));

  const keys = rec.entries.map((e) => `${e.version}:${e.seq}`);
  expect(new Set(keys).size).toBe(keys.length);

  // replay order (version, seq) never skips to a track before it was added
  const sorted = [...rec.entries].sort((x, y) => x.version - y.version || x.seq - y.seq);
  const added = new Set();
  for (const { command } of sorted) {
    if (command.type === 'ADD_TRACK') added.add(command.payload.trackId);
    if (command.type === 'SKIP' && command.payload.trackId !== null) {
      expect(added.has(command.payload.trackId)).toBe(true);
    }
  }
});

test('a hanging command log never delays the command: ack ok, one diff, snapshot at the ack version', async () => {
  // Real logWriter in front of a Mongo that never answers. (Retry/backoff
  // and failure reporting are covered in logWriter.test.js.)
  const hanging = vi.fn(() => new Promise(() => {}));
  const writer = createLogWriter({ appendMany: hanging });
  service = build({ logWriter: writer });
  const { jamId, guest } = await newJam();

  const ack = await service.handleCommand(guest, { type: 'ADD_TRACK', payload: { trackId: 'song-a' } });

  expect(ack).toStrictEqual({ version: 1 });
  expect(diffs).toHaveLength(1);
  expect(diffs[0].diff.toVersion).toBe(1);
  expect((await service.getSnapshot(jamId)).version).toBe(ack.version);
  expect(hanging).toHaveBeenCalledTimes(1);
  expect(hanging).toHaveBeenCalledWith(jamId, [expect.objectContaining({ type: 'ADD_TRACK' })], 1);
  expect(writer.pending()).toBe(1);

  // the mutation really was applied, and the next command isn't blocked either
  await expect(service.handleCommand(guest, { type: 'ADD_TRACK', payload: { trackId: 'song-a' } }))
    .rejects.toMatchObject({ code: 'DUPLICATE_TRACK' });
  expect((await service.handleCommand(guest, { type: 'ADD_TRACK', payload: { trackId: 'song-b' } })).version).toBe(2);
});

// ---------- skip idempotency under concurrency ----------

test('5 concurrent SKIPs with the same expectedTrackId: exactly 1 ok, 4 STALE_SKIP', async () => {
  const { jamId, host } = await newJam();
  await service.handleCommand(host, { type: 'ADD_TRACK', payload: { trackId: 'song-x' } });
  await service.handleCommand(host, { type: 'SKIP', payload: { expectedTrackId: null } }); // song-x playing
  for (const trackId of ['song-a', 'song-b', 'song-c']) {
    now += 1;
    await service.handleCommand(host, { type: 'ADD_TRACK', payload: { trackId } });
  }

  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => service.handleCommand(host, { type: 'SKIP', payload: { expectedTrackId: 'song-x' } })),
  );

  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.filter((r) => r.status === 'rejected');
  expect(rejected).toHaveLength(4);
  rejected.forEach((r) => expect(r.reason.code).toBe('STALE_SKIP'));
  const snap = await service.getSnapshot(jamId);
  expect(snap.playback.currentTrackId).toBe('song-a');
  expect(snap.queue.map((t) => t.trackId)).toStrictEqual(['song-b', 'song-c']);
});

test('commit hands the broadcaster the endpoint {queue, playback} states as an internal 3rd argument', async () => {
  const calls = [];
  service = build({ broadcaster: { publishDiff: async (...args) => { calls.push(args); } } });
  const { jamId, guest } = await newJam();

  await service.handleCommand(guest, { type: 'ADD_TRACK', payload: { trackId: 'song-a' } });

  expect(calls).toHaveLength(1);
  const [roomId, diff, states] = calls[0];
  expect(roomId).toBe(jamId);
  expect(Object.keys(diff).sort()).toStrictEqual(['fromVersion', 'ops', 'toVersion']);
  expect(states).toStrictEqual({
    before: { queue: [], playback: { status: 'IDLE', currentTrackId: null, startedAt: null, pausedAt: null } },
    after: {
      queue: [{ trackId: 'song-a', addedBy: 'Guest', addedAt: now, upvotedBy: [] }],
      playback: { status: 'IDLE', currentTrackId: null, startedAt: null, pausedAt: null },
    },
  });
});

// ---------- a jam deleted from Redis (FLUSHDB, eviction, expiry) ----------

async function flushJam(jamId) {
  const keys = await redis.keys(`room:${jamId}:*`);
  if (keys.length) await redis.del(...keys);
}

test('getSnapshot / handleCommand on a flushed jam → JAM_NOT_FOUND, and no keys are recreated', async () => {
  const { jamId, host, guest } = await newJam();
  await service.handleCommand(guest, { type: 'ADD_TRACK', payload: { trackId: 'song-a' } });
  await flushJam(jamId);

  await expect(service.getSnapshot(jamId)).rejects.toMatchObject({ code: 'JAM_NOT_FOUND' });
  await expect(service.handleCommand(guest, { type: 'ADD_TRACK', payload: { trackId: 'song-b' } }))
    .rejects.toMatchObject({ code: 'JAM_NOT_FOUND' });
  await expect(service.handleCommand(host, { type: 'SKIP', payload: { expectedTrackId: null } }))
    .rejects.toMatchObject({ code: 'JAM_NOT_FOUND' });
  await expect(service.handleCommand(host, { type: 'PLAY', payload: {} }))
    .rejects.toMatchObject({ code: 'JAM_NOT_FOUND' });

  expect(await redis.keys(`room:${jamId}:*`)).toStrictEqual([]);
  expect(diffs).toHaveLength(1); // only the ADD_TRACK from before the flush
});

test('gateway jam:resync for a jam flushed after joining → JAM_NOT_FOUND, no keys recreated', async () => {
  const { jamId } = await newJam();
  const handlers = {};
  const socket = { data: {}, on: (e, fn) => { handlers[e] = fn; }, emit: vi.fn(), join: async () => {}, leave: async () => {} };
  bindJamHandlers(socket, service);
  const joined = vi.fn();
  await handlers['jam:join']({ jamId, userId: 'u1', name: 'Tuan' }, joined);
  expect(joined.mock.calls[0][0].ok).toBe(true);
  await flushJam(jamId);

  const ack = vi.fn();
  await handlers['jam:resync']({}, ack);

  expect(ack).toHaveBeenCalledWith({ ok: false, error: { code: 'JAM_NOT_FOUND', message: 'No such jam' } });
  expect(await redis.keys(`room:${jamId}:*`)).toStrictEqual([]);
});

test('close() waits for in-flight commands to finish (lock released), then rejects new ones with BUSY', async () => {
  const { jamId, host } = await newJam();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const svc = build({
    broadcaster: { publishDiff: async (roomId, diff) => { await gate; diffs.push({ roomId, diff }); } },
  });

  const inFlight = svc.handleCommand(host, { type: 'ADD_TRACK', payload: { trackId: 'song-a' } });
  await vi.waitFor(async () => expect(await redis.exists(`room:${jamId}:lock`)).toBe(1));

  let closed = false;
  const closing = svc.close().then(() => { closed = true; });
  await expect(svc.handleCommand(host, { type: 'ADD_TRACK', payload: { trackId: 'song-b' } }))
    .rejects.toMatchObject({ code: 'BUSY' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(closed).toBe(false); // still waiting on the in-flight command

  release();
  await expect(inFlight).resolves.toStrictEqual({ version: 1 });
  await closing;
  expect(await redis.exists(`room:${jamId}:lock`)).toBe(0);
  expect(diffs).toHaveLength(1);
});
