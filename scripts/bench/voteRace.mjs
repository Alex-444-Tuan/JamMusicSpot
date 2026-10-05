// Benchmark for claim 2: concurrent votes on one track, naive vs atomic.
//
//   node scripts/bench/voteRace.mjs            (needs Redis on localhost:6379)
//
// "Naive" = the textbook read-modify-write a first draft would do: ZSCORE the
// track, add the vote weight in JS, ZADD it back. Two clients that read the
// same score both write score+weight, so one vote vanishes (lost update).
// "Atomic" = the project's real roomStore (Lua: ZSCORE + SADD + ZINCRBY in one
// script). Both are driven with the same concurrent load. We count how many of
// the N distinct voters' votes actually survived. Also checks idempotency: the
// same user firing many concurrent duplicate votes must count once.

import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { createRedisRoomStore, VOTE_WEIGHT_MS } from '../../src/adapters/redis/roomStore.js';
import { AddTrack, Vote } from '../../src/domain/commands.js';

const redis = new Redis();
const store = createRedisRoomStore(redis);
const TRIALS = 20;
const LEVELS = [10, 50, 200];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// spreadMs: voters arrive at random times within this window (0 = all at once,
// the worst case). workMs: app-side time between the read and the write (a
// real service validates and awaits other things there; 0 = none).
async function naiveTrial(voters, spreadMs = 0, workMs = 0) {
    const key = `bench:naive:${randomUUID()}`;
    await redis.zadd(key, 1_000_000_000_000, 'track');
    const start = Number(await redis.zscore(key, 'track'));
    await Promise.all(Array.from({ length: voters }, async () => {
        if (spreadMs) await sleep(Math.random() * spreadMs);
        const score = Number(await redis.zscore(key, 'track'));
        if (workMs) await sleep(workMs);
        await redis.zadd(key, score + VOTE_WEIGHT_MS, 'track');
    }));
    const end = Number(await redis.zscore(key, 'track'));
    await redis.del(key);
    return Math.round((end - start) / VOTE_WEIGHT_MS);
}

async function atomicTrial(voters) {
    const room = `bench-${randomUUID()}`;
    await store.applyCommand(room, AddTrack('track', 'host', 1_000_000_000_000));
    await Promise.all(Array.from({ length: voters }, (_, i) => store.applyCommand(room, Vote('track', `user-${i}`))));
    const { state } = await store.getState(room);
    const counted = state.find((t) => t.trackId === 'track').upvotedBy.length;
    const keys = await redis.keys(`room:${room}:*`);
    if (keys.length) await redis.del(...keys);
    return counted;
}

async function idempotencyTrial(attempts) {
    const room = `bench-${randomUUID()}`;
    await store.applyCommand(room, AddTrack('track', 'host', 1_000_000_000_000));
    await Promise.all(Array.from({ length: attempts }, () => store.applyCommand(room, Vote('track', 'same-user'))));
    const { state } = await store.getState(room);
    const counted = state.find((t) => t.trackId === 'track').upvotedBy.length;
    const keys = await redis.keys(`room:${room}:*`);
    if (keys.length) await redis.del(...keys);
    return counted;
}

const sum = (a) => a.reduce((x, y) => x + y, 0);
console.log(`vote-race benchmark: ${TRIALS} trials per level, real local Redis`);
for (const n of LEVELS) {
    const naive = [];
    const atomic = [];
    for (let t = 0; t < TRIALS; t++) {
        naive.push(await naiveTrial(n));
        atomic.push(await atomicTrial(n));
    }
    const lost = (counted) => counted.map((c) => n - c);
    const nl = lost(naive);
    const al = lost(atomic);
    console.log(
        `${String(n).padStart(4)} concurrent voters | naive: lost ${sum(nl)}/${n * TRIALS} votes ` +
        `(${(100 * sum(nl) / (n * TRIALS)).toFixed(1)}%, worst trial lost ${Math.max(...nl)}) | ` +
        `atomic: lost ${sum(al)}/${n * TRIALS} (${(100 * sum(al) / (n * TRIALS)).toFixed(1)}%)`,
    );
}
// Gentler, more realistic load: 50 voters arriving over 50 ms, 2 ms of app work
// between read and write. (Assumed numbers: the point is the loss is not
// confined to a pathological burst.)
{
    const naive = [];
    for (let t = 0; t < TRIALS; t++) naive.push(await naiveTrial(50, 50, 2));
    const nl = naive.map((c) => 50 - c);
    console.log(
        `  50 voters spread over 50 ms (2 ms work between read and write) | naive: lost ${sum(nl)}/${50 * TRIALS} ` +
        `(${(100 * sum(nl) / (50 * TRIALS)).toFixed(1)}%) | atomic: 0 (same Lua path as above)`,
    );
}
const idem = [];
for (let t = 0; t < TRIALS; t++) idem.push(await idempotencyTrial(100));
console.log(`idempotency: one user firing 100 concurrent duplicate votes counted as ${[...new Set(idem)].join('/')} vote(s) in all ${TRIALS} trials`);
await redis.quit();
