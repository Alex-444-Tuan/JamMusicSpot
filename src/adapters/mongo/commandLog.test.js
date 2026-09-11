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
    { command, version: 1, recordedAt: expect.any(Date) },
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
