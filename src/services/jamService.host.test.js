// Host succession: when the host leaves, the earliest-joined member who is
// still present becomes host (after a grace period, so a refresh doesn't
// hand host away). Real Redis stores; presence and notifications are faked so
// the tests decide exactly who is "connected".
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { randomInt } from 'node:crypto';
import Redis from 'ioredis';
import { createRedisRoomStore } from '../adapters/redis/roomStore.js';
import { createRedisPlaybackStore } from '../adapters/redis/playbackStore.js';
import { createRedisJamStore } from '../adapters/redis/jamStore.js';
import { createRedisRoomLock } from '../adapters/redis/roomLock.js';
import { createJamService } from './jamService.js';

const GRACE = 1000;
const catalog = [{ trackId: 'song-a' }, { trackId: 'song-b' }];
const randomId = (length, alphabet) => Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join('');

let redis;
let now;
let present;   // jamId -> Set(userId) currently connected
let events;    // notifications sent
let service;
const createdJams = [];

const presence = {
  async listPresent(jamId) { return [...(present.get(jamId) ?? [])]; },
  toRoom(jamId, event, payload) { events.push({ to: 'room', jamId, event, payload }); },
  toUser(jamId, userId, event, payload) { events.push({ to: userId, jamId, event, payload }); },
};

function build(overrides = {}) {
  return createJamService({
    jamStore: createRedisJamStore(redis),
    roomStore: createRedisRoomStore(redis),
    playbackStore: createRedisPlaybackStore(redis),
    roomLock: createRedisRoomLock(redis),
    logWriter: { enqueue() {} },
    broadcaster: { async publishDiff() {} },
    clock: { now: () => now },
    catalog,
    randomId,
    presence,
    hostGraceMs: GRACE,
    ...overrides,
  });
}

beforeAll(() => { redis = new Redis(); });
afterAll(async () => { await redis.quit(); });
beforeEach(() => {
  now = 1_000_000;
  present = new Map();
  events = [];
  service = build();
});
afterEach(async () => {
  await service.close();
  for (const jamId of createdJams.splice(0)) {
    const keys = await redis.keys(`room:${jamId}:*`);
    if (keys.length) await redis.del(...keys);
  }
});

async function newJam() {
  const jam = await service.createJam();
  createdJams.push(jam.jamId);
  present.set(jam.jamId, new Set());
  return jam;
}

// Join and mark connected, one ms apart so join order is unambiguous.
async function join(jamId, userId, hostToken) {
  now += 1;
  const res = await service.joinJam({ jamId, userId, name: userId.toUpperCase(), hostToken });
  present.get(jamId).add(userId);
  return res;
}
const leave = (jamId, userId) => present.get(jamId).delete(userId);
const ctx = (jamId, userId, hostToken) => ({ jamId, userId, name: userId.toUpperCase(), hostToken });
const play = (c) => service.handleCommand(c, { type: 'PAUSE' }).then(() => 'ok', (e) => e.code);
const promotions = () => events.filter((e) => e.event === 'jam:promoted');

test('the creator claims host with the token; guests and spoofers do not', async () => {
  const { jamId, hostToken } = await newJam();
  const host = await join(jamId, 'creator', hostToken);
  const guest = await join(jamId, 'guest');
  const wrong = await join(jamId, 'wrong', 'not-the-token');

  expect(host).toMatchObject({ isHost: true, hostToken, host: { userId: 'creator', name: 'CREATOR' } });
  expect(guest.isHost).toBe(false);
  expect(guest.hostToken).toBeUndefined();
  expect(wrong.isHost).toBe(false);

  expect(await play(ctx(jamId, 'creator', hostToken))).toBe('ok');
  expect(await play(ctx(jamId, 'guest'))).toBe('NOT_HOST');
  // knowing the host's userId (it is public in vote lists) is not enough
  expect(await play(ctx(jamId, 'creator'))).toBe('NOT_HOST');
});

test('when the host leaves, the earliest-joined member still present becomes host after the grace period', async () => {
  const { jamId, hostToken } = await newJam();
  await join(jamId, 'creator', hostToken);
  await join(jamId, 'alice');
  await join(jamId, 'bob');

  leave(jamId, 'creator');
  await service.reassessHost(jamId);           // absence first observed: grace starts
  expect(promotions()).toHaveLength(0);
  now += GRACE - 1;
  await service.reassessHost(jamId);
  expect(promotions()).toHaveLength(0);         // still within grace
  now += 1;
  await service.reassessHost(jamId);

  expect(promotions()).toHaveLength(1);
  const [promoted] = promotions();
  expect(promoted).toMatchObject({ to: 'alice', jamId, payload: { jamId } });
  const newToken = promoted.payload.hostToken;
  expect(newToken).toEqual(expect.any(String));
  expect(newToken).not.toBe(hostToken);         // rotated
  expect(events).toContainEqual({ to: 'room', jamId, event: 'jam:host', payload: { hostUserId: 'alice', hostName: 'ALICE' } });

  expect(await play(ctx(jamId, 'alice', newToken))).toBe('ok');
  expect(await play(ctx(jamId, 'creator', hostToken))).toBe('NOT_HOST'); // old token is dead
  expect(await play(ctx(jamId, 'bob'))).toBe('NOT_HOST');
});

test('earlier joiners who also left are skipped', async () => {
  const { jamId, hostToken } = await newJam();
  await join(jamId, 'creator', hostToken);
  await join(jamId, 'alice');
  await join(jamId, 'bob');
  leave(jamId, 'creator');
  leave(jamId, 'alice');

  await service.reassessHost(jamId);
  now += GRACE;
  await service.reassessHost(jamId);

  expect(promotions().map((e) => e.to)).toStrictEqual(['bob']);
});

test('a host who refreshes within the grace period keeps host', async () => {
  const { jamId, hostToken } = await newJam();
  await join(jamId, 'creator', hostToken);
  await join(jamId, 'alice');

  leave(jamId, 'creator');
  await service.reassessHost(jamId);
  now += GRACE / 2;
  const back = await join(jamId, 'creator', hostToken); // the refreshed tab rejoins
  await service.reassessHost(jamId);
  now += GRACE * 2;
  await service.reassessHost(jamId);

  expect(back.isHost).toBe(true);
  expect(promotions()).toHaveLength(0);
  expect(await play(ctx(jamId, 'creator', hostToken))).toBe('ok');
});

test('concurrent re-checks promote exactly once', async () => {
  const { jamId, hostToken } = await newJam();
  await join(jamId, 'creator', hostToken);
  await join(jamId, 'alice');
  await join(jamId, 'bob');
  leave(jamId, 'creator');
  await service.reassessHost(jamId);
  now += GRACE;

  const other = build(); // a second server instance
  await Promise.all([...Array(5)].flatMap(() => [service.reassessHost(jamId), other.reassessHost(jamId)]));
  await other.close();

  expect(promotions().map((e) => e.to)).toStrictEqual(['alice']);
});

test('when everyone has left, the next person to join becomes host', async () => {
  const { jamId, hostToken } = await newJam();
  await join(jamId, 'creator', hostToken);
  leave(jamId, 'creator');
  await service.reassessHost(jamId);
  now += GRACE;
  await service.reassessHost(jamId);           // nobody present: the room is vacant
  expect(promotions()).toHaveLength(0);

  await join(jamId, 'latecomer');
  await service.reassessHost(jamId);           // the gateway runs this after every join
  const [promoted] = promotions();
  expect(promoted.to).toBe('latecomer');
  expect(await play(ctx(jamId, 'latecomer', promoted.payload.hostToken))).toBe('ok');
});

test('a guest who arrives before the creator only becomes host if the creator never shows up', async () => {
  const early = await newJam();
  await join(early.jamId, 'guest');
  await service.reassessHost(early.jamId);
  expect(promotions()).toHaveLength(0);
  const creator = await join(early.jamId, 'creator', early.hostToken); // creator arrives in time
  now += GRACE * 2;
  await service.reassessHost(early.jamId);
  expect(creator.isHost).toBe(true);
  expect(promotions()).toHaveLength(0);

  const abandoned = await newJam();
  await join(abandoned.jamId, 'guest');
  await service.reassessHost(abandoned.jamId);
  now += GRACE;
  await service.reassessHost(abandoned.jamId);
  expect(promotions().map((e) => [e.jamId, e.to])).toStrictEqual([[abandoned.jamId, 'guest']]);
});

test('the grace timer promotes on its own after a host disconnect, with no further events', async () => {
  const realClock = build({ clock: { now: () => Date.now() }, hostGraceMs: 80 });
  const { jamId, hostToken } = await realClock.createJam();
  createdJams.push(jamId);
  present.set(jamId, new Set());
  await realClock.joinJam({ jamId, userId: 'creator', name: 'C', hostToken });
  present.get(jamId).add('creator');
  await new Promise((r) => setTimeout(r, 5));
  await realClock.joinJam({ jamId, userId: 'alice', name: 'A' });
  present.get(jamId).add('alice');

  leave(jamId, 'creator');
  await realClock.reassessHost(jamId); // what the gateway does on disconnect
  await new Promise((r) => setTimeout(r, 250));
  await realClock.close();

  expect(promotions().map((e) => e.to)).toStrictEqual(['alice']);
});
