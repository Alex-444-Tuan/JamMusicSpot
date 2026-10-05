import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { createMongoCommandLog } from './commandLog.js';

let client;
let collection;
let log;
let roomId;

beforeAll(async () => {
  client = new MongoClient('mongodb://localhost:27017');
  await client.connect();
  collection = client.db('jammusicspot-test').collection('commandLog');
  log = createMongoCommandLog(collection);
});

afterAll(async () => {
  await client.close();
});

afterEach(async () => {
  await collection.deleteMany({ roomId });
});

test('getLog on a room with no entries returns an empty array', async () => {
  roomId = randomUUID();

  const result = await log.getLog(roomId);

  expect(result).toStrictEqual([]);
});

test('append then getLog returns exactly the promised shape, no extra fields', async () => {
  roomId = randomUUID();
  const command = { type: 'ADD_TRACK', payload: { trackId: 'track-1', addedBy: 'Tuan', addedAt: 1000 } };

  await log.append(roomId, command, 1);
  const result = await log.getLog(roomId);

  expect(result).toStrictEqual([
    { command, version: 1, seq: 0, recordedAt: expect.any(Date) },
  ]);
});

test('multiple entries come back ordered by version ascending, regardless of insertion order', async () => {
  roomId = randomUUID();
  const commandA = { type: 'ADD_TRACK', payload: { trackId: 'track-1' } };
  const commandB = { type: 'UPVOTE', payload: { trackId: 'track-1', userId: 'userA' } };

  // deliberately append the higher version FIRST, to prove sort is doing
  // the ordering rather than it happening to match insertion order
  await log.append(roomId, commandB, 2);
  await log.append(roomId, commandA, 1);

  const result = await log.getLog(roomId);

  expect(result.map((entry) => entry.version)).toEqual([1, 2]);
  expect(result[0].command).toStrictEqual(commandA);
  expect(result[1].command).toStrictEqual(commandB);
});

test('getLog only returns entries for the requested room, not other rooms', async () => {
  roomId = randomUUID();
  const otherRoomId = randomUUID();
  const command = { type: 'ADD_TRACK', payload: { trackId: 'track-1' } };

  await log.append(roomId, command, 1);
  await log.append(otherRoomId, command, 1);

  const result = await log.getLog(roomId);

  expect(result).toHaveLength(1);

  await collection.deleteMany({ roomId: otherRoomId });
});

test('entries sharing a version come back in seq order, even if inserted reversed', async () => {
  roomId = randomUUID();
  const remove = { type: 'REMOVE_TRACK', payload: { trackId: 'track-1' } };
  const skip = { type: 'SKIP', payload: { trackId: 'track-1', at: 5 } };

  await log.append(roomId, skip, 3, 1);
  await log.append(roomId, remove, 3, 0);
  await log.append(roomId, { type: 'ADD_TRACK', payload: {} }, 2);

  const result = await log.getLog(roomId);

  expect(result.map((e) => [e.version, e.command.type])).toEqual([[2, 'ADD_TRACK'], [3, 'REMOVE_TRACK'], [3, 'SKIP']]);
});

test('append without seq stores seq 0', async () => {
  roomId = randomUUID();

  await log.append(roomId, { type: 'ADD_TRACK', payload: {} }, 1);

  const raw = await collection.findOne({ roomId });
  expect(raw.seq).toBe(0);
});

test('after ensureIndexes, a duplicate (roomId, version, seq) is rejected; ensureIndexes is idempotent', async () => {
  roomId = randomUUID();
  // separate collection so the unique index can't collide with leftovers elsewhere
  const indexed = client.db('jammusicspot-test').collection(`commandLogIndex_${randomUUID()}`);
  const indexedLog = createMongoCommandLog(indexed);
  try {
    await indexedLog.ensureIndexes();
    await expect(indexedLog.ensureIndexes()).resolves.toBeUndefined();

    await indexedLog.append(roomId, { type: 'ADD_TRACK', payload: {} }, 1, 0);
    await indexedLog.append(roomId, { type: 'SKIP', payload: {} }, 1, 1); // same version, different seq: fine
    await expect(indexedLog.append(roomId, { type: 'UPVOTE', payload: {} }, 1, 0)).rejects.toMatchObject({ code: 11000 });

    expect(await indexedLog.getLog(roomId)).toHaveLength(2);
  } finally {
    await indexed.drop();
  }
});

test('appendMany stores the commands under one version with seq 0, 1 and a shared recordedAt', async () => {
  roomId = randomUUID();
  const remove = { type: 'REMOVE_TRACK', payload: { trackId: 'track-1' } };
  const skip = { type: 'SKIP', payload: { trackId: 'track-1', at: 5 } };

  await log.appendMany(roomId, [remove, skip], 4);
  const result = await log.getLog(roomId);

  expect(result).toStrictEqual([
    { command: remove, version: 4, seq: 0, recordedAt: expect.any(Date) },
    { command: skip, version: 4, seq: 1, recordedAt: expect.any(Date) },
  ]);
  expect(result[0].recordedAt.getTime()).toBe(result[1].recordedAt.getTime());
});

test('with the unique index, a second appendMany for the same version rejects', async () => {
  roomId = randomUUID();
  const indexed = client.db('jammusicspot-test').collection(`commandLogIndex_${randomUUID()}`);
  const indexedLog = createMongoCommandLog(indexed);
  try {
    await indexedLog.ensureIndexes();
    await indexedLog.appendMany(roomId, [{ type: 'REMOVE_TRACK', payload: {} }, { type: 'SKIP', payload: {} }], 7);

    await expect(indexedLog.appendMany(roomId, [{ type: 'ADD_TRACK', payload: {} }], 7)).rejects.toMatchObject({ code: 11000 });
    expect(await indexedLog.getLog(roomId)).toHaveLength(2);
  } finally {
    await indexed.drop();
  }
});

test('appendMany is unordered: a retried batch whose first row already exists still stores the rest', async () => {
  roomId = randomUUID();
  const indexed = client.db('jammusicspot-test').collection(`commandLogIndex_${randomUUID()}`);
  const indexedLog = createMongoCommandLog(indexed);
  try {
    await indexedLog.ensureIndexes();
    // simulate a batch whose first insert landed before the connection dropped
    await indexedLog.append(roomId, { type: 'REMOVE_TRACK', payload: {} }, 5, 0);

    await expect(indexedLog.appendMany(roomId, [{ type: 'REMOVE_TRACK', payload: {} }, { type: 'SKIP', payload: {} }], 5))
      .rejects.toMatchObject({ code: 11000 });

    expect((await indexedLog.getLog(roomId)).map((e) => `${e.seq} ${e.command.type}`)).toStrictEqual(['0 REMOVE_TRACK', '1 SKIP']);
  } finally {
    await indexed.drop();
  }
});
