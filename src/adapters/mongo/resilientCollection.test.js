import { afterEach, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createResilientCollection } from './resilientCollection.js';
import { createMongoCommandLog } from './commandLog.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const topologyClosed = () => Object.assign(new Error('Topology is closed'), { name: 'MongoTopologyClosedError' });
const notConnected = () => Object.assign(new Error('not connected'), { name: 'MongoNotConnectedError' });
const selection = () => Object.assign(new Error('connect ECONNREFUSED'), { name: 'MongoServerSelectionError' });

// A fake MongoClient whose collection methods are vi.fn()s.
function fakeClient(impl = {}) {
  const coll = {
    insertOne: vi.fn(impl.insertOne ?? (async () => ({ acknowledged: true }))),
    insertMany: vi.fn(impl.insertMany ?? (async () => ({ acknowledged: true }))),
    createIndex: vi.fn(impl.createIndex ?? (async () => 'idx')),
    find: vi.fn(() => ({ toArray: impl.toArray ?? (async () => [{ x: 1 }]) })),
  };
  const client = {
    coll,
    dbNames: [],
    collNames: [],
    db: vi.fn((name) => { client.dbNames.push(name); return { collection: (n) => { client.collNames.push(n); return coll; } }; }),
    close: vi.fn(async () => {}),
  };
  return client;
}

function factoryOf(...clients) {
  const queue = [...clients];
  return vi.fn(() => queue.shift());
}

const make = (clientFactory, extra = {}) => createResilientCollection({
  url: 'mongodb://example:27017', dbName: 'jamdb', collectionName: 'commandLog', clientFactory, ...extra,
});

test('connects lazily: no client is built until the first operation', async () => {
  const factory = factoryOf(fakeClient());
  const coll = make(factory);
  expect(factory).not.toHaveBeenCalled();

  await coll.insertOne({ a: 1 });

  expect(factory).toHaveBeenCalledTimes(1);
  expect(factory).toHaveBeenCalledWith('mongodb://example:27017');
});

test('delegates insertOne / insertMany / createIndex / find().toArray() with their arguments', async () => {
  const client = fakeClient();
  const coll = make(factoryOf(client));

  await coll.insertOne({ a: 1 });
  await coll.insertMany([{ a: 1 }, { a: 2 }], { ordered: false });
  await coll.createIndex({ a: 1 }, { unique: true });
  const rows = await coll.find({ a: 1 }, { sort: { a: 1 } }).toArray();

  expect(client.coll.insertOne).toHaveBeenCalledWith({ a: 1 });
  expect(client.coll.insertMany).toHaveBeenCalledWith([{ a: 1 }, { a: 2 }], { ordered: false });
  expect(client.coll.createIndex).toHaveBeenCalledWith({ a: 1 }, { unique: true });
  expect(client.coll.find).toHaveBeenCalledWith({ a: 1 }, { sort: { a: 1 } });
  expect(rows).toStrictEqual([{ x: 1 }]);
  expect(client.dbNames.every((n) => n === 'jamdb')).toBe(true);
  expect(client.collNames.every((n) => n === 'commandLog')).toBe(true);
});

test.each([
  ['MongoTopologyClosedError', topologyClosed],
  ['MongoNotConnectedError', notConnected],
  ['a connect failure (server selection)', selection],
])('after %s the client is closed and rebuilt on the next call', async (_, makeErr) => {
  const dead = fakeClient({ insertMany: async () => { throw makeErr(); } });
  const fresh = fakeClient();
  const factory = factoryOf(dead, fresh);
  const coll = make(factory);

  await expect(coll.insertMany([{ a: 1 }])).rejects.toThrow();
  expect(dead.close).toHaveBeenCalledTimes(1);

  await coll.insertMany([{ a: 2 }]);
  expect(factory).toHaveBeenCalledTimes(2);
  expect(fresh.coll.insertMany).toHaveBeenCalledWith([{ a: 2 }]);
});

test('a non-connectivity error (duplicate key) keeps the same client', async () => {
  const client = fakeClient({ insertMany: async () => { throw Object.assign(new Error('E11000'), { code: 11000 }); } });
  const factory = factoryOf(client);
  const coll = make(factory);

  await expect(coll.insertMany([{ a: 1 }])).rejects.toMatchObject({ code: 11000 });
  await expect(coll.insertMany([{ a: 1 }])).rejects.toMatchObject({ code: 11000 });

  expect(factory).toHaveBeenCalledTimes(1);
  expect(client.close).not.toHaveBeenCalled();
});

test('onReconnect (ensureIndexes) re-runs once after a rebuilt client first succeeds — not on the first client', async () => {
  const first = fakeClient();
  let failNext = false;
  first.coll.insertOne.mockImplementation(async () => { if (failNext) throw topologyClosed(); });
  const second = fakeClient();
  const onReconnect = vi.fn(async () => {});
  const coll = make(factoryOf(first, second));
  coll.setOnReconnect(onReconnect);

  await coll.insertOne({ a: 1 });
  expect(onReconnect).not.toHaveBeenCalled();

  failNext = true;
  await expect(coll.insertOne({ a: 2 })).rejects.toThrow();
  expect(onReconnect).not.toHaveBeenCalled();

  await coll.insertOne({ a: 3 });
  await coll.insertOne({ a: 4 });
  expect(onReconnect).toHaveBeenCalledTimes(1);
});

test('a failing onReconnect only warns', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const dead = fakeClient({ insertOne: async () => { throw topologyClosed(); } });
  const coll = make(factoryOf(dead, fakeClient()));
  coll.setOnReconnect(async () => { throw new Error('dup rows'); });

  await expect(coll.insertOne({})).rejects.toThrow();
  await coll.insertOne({});
  await new Promise((r) => setImmediate(r));

  expect(warn).toHaveBeenCalled();
});

test('a factory that throws (bad URL) surfaces the error and retries a new client next time', async () => {
  const good = fakeClient();
  let calls = 0;
  const factory = vi.fn(() => { if (calls++ === 0) throw selection(); return good; });
  const coll = make(factory);

  await expect(coll.insertOne({})).rejects.toThrow();
  await coll.insertOne({});
  expect(factory).toHaveBeenCalledTimes(2);
});

test('concurrent failures on the same client close it once', async () => {
  const dead = fakeClient({ insertOne: async () => { throw topologyClosed(); } });
  const coll = make(factoryOf(dead, fakeClient()));

  await Promise.allSettled([coll.insertOne({}), coll.insertOne({}), coll.insertOne({})]);

  expect(dead.close).toHaveBeenCalledTimes(1);
});

test('close() closes the current client', async () => {
  const client = fakeClient();
  const coll = make(factoryOf(client));
  await coll.insertOne({});

  await coll.close();

  expect(client.close).toHaveBeenCalledTimes(1);
});

test('integration: the user\'s commandLog works unchanged on top of a real resilient collection', async () => {
  const collectionName = `commandLogResilient_${randomUUID()}`;
  const coll = createResilientCollection({ url: 'mongodb://localhost:27017', dbName: 'jammusicspot-test', collectionName });
  const log = createMongoCommandLog(coll);
  const roomId = randomUUID();
  try {
    await log.ensureIndexes();
    await log.appendMany(roomId, [{ type: 'REMOVE_TRACK', payload: {} }, { type: 'SKIP', payload: {} }], 3);
    await log.append(roomId, { type: 'ADD_TRACK', payload: {} }, 2);

    const rows = await log.getLog(roomId);
    expect(rows.map((r) => `${r.version}/${r.seq} ${r.command.type}`)).toStrictEqual(['2/0 ADD_TRACK', '3/0 REMOVE_TRACK', '3/1 SKIP']);
  } finally {
    await coll._withCollection((c) => c.drop());
    await coll.close();
  }
});
