// probe.mjs
import Redis from 'ioredis';
import { createRedisRoomStore } from '../src/adapters/redis/roomStore.js';

const redis = new Redis();
const store = createRedisRoomStore(redis);

const addResult = await store.applyCommand('test-room', {
  type: 'ADD_TRACK',
  payload: { trackId: 'abc1', addedBy: 'Tuan', addedAt: 12345 },
});
console.log('ADD_TRACK result:', JSON.stringify(addResult, null, 2));

const state1 = await store.getState('test-room');
console.log('getState after add:', JSON.stringify(state1, null, 2));

console.log('--- upvote from userA (new vote) ---');
const vote1 = await store.applyCommand('test-room', {
  type: 'UPVOTE',
  payload: { trackId: 'abc1', userId: 'userA' },
});
console.log(JSON.stringify(vote1, null, 2));

console.log('--- upvote from userB (new vote) ---');
const vote2 = await store.applyCommand('test-room', {
  type: 'UPVOTE',
  payload: { trackId: 'abc1', userId: 'userB' },
});
console.log(JSON.stringify(vote2, null, 2));

console.log('--- upvote from userA again (duplicate, should NOT change score/version) ---');
const vote3 = await store.applyCommand('test-room', {
  type: 'UPVOTE',
  payload: { trackId: 'abc1', userId: 'userA' },
});
console.log(JSON.stringify(vote3, null, 2));

await redis.quit();
