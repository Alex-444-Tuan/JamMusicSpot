// Benchmark for claim 5: bytes sent to ONE client during a burst of votes.
//
//   node scripts/bench/payload.mjs             (needs Redis on localhost:6379)
//
// Drives the real jamService (real Redis stores, real lock) with a burst of
// votes and captures every publishDiff call, then compares three strategies on
// the same traffic:
//   snapshots    : a full {version, queue, playback} after every mutation
//   raw diffs    : one {fromVersion, toVersion, ops} per mutation, no batching
//   coalesced    : the real createCoalescingBroadcaster (100 ms window)
// Bytes are JSON.stringify length of the payload (what Socket.IO would put in a
// message body, before its own framing/compression).

import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { createRedisRoomStore } from '../../src/adapters/redis/roomStore.js';
import { createRedisPlaybackStore } from '../../src/adapters/redis/playbackStore.js';
import { createRedisJamStore } from '../../src/adapters/redis/jamStore.js';
import { createRedisRoomLock } from '../../src/adapters/redis/roomLock.js';
import { createJamService } from '../../src/services/jamService.js';
import { createCoalescingBroadcaster } from '../../src/realtime/broadcastCoalescer.js';
import { catalog } from '../../src/catalog/catalog.js';
import { cryptoRandomId } from '../../src/adapters/cryptoRandomId.js';

const redis = new Redis();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bytes = (v) => Buffer.byteLength(JSON.stringify(v));

async function run({ tracks, votes, windowMs, burstMs }) {
    const rawDiffs = [];
    const snapshots = [];
    const coalescedOut = [];
    const coalescer = createCoalescingBroadcaster({ publishDiff: async (_room, diff) => coalescedOut.push(diff) }, windowMs);
    const broadcaster = {
        async publishDiff(room, diff, states) {
            rawDiffs.push(diff);
            snapshots.push({ version: diff.toVersion, queue: states.after.queue, playback: states.after.playback });
            await coalescer.publishDiff(room, diff, states);
        },
    };
    const service = createJamService({
        jamStore: createRedisJamStore(redis), roomStore: createRedisRoomStore(redis),
        playbackStore: createRedisPlaybackStore(redis), roomLock: createRedisRoomLock(redis),
        logWriter: { enqueue() {} }, broadcaster, clock: { now: () => Date.now() },
        catalog, randomId: cryptoRandomId,
    });
    const { jamId } = await service.createJam();
    const host = { jamId, userId: 'host', name: 'Host', isHost: true };
    for (const t of catalog.slice(0, tracks)) await service.handleCommand(host, { type: 'ADD_TRACK', payload: { trackId: t.trackId } });
    rawDiffs.length = 0; snapshots.length = 0; coalescedOut.length = 0; // measure the burst only
    await sleep(windowMs + 20);
    coalescedOut.length = 0;

    // The burst: `votes` distinct users voting on random tracks, spread evenly over burstMs.
    const ids = catalog.slice(0, tracks).map((t) => t.trackId);
    const jobs = [];
    for (let i = 0; i < votes; i++) {
        jobs.push((async () => {
            await sleep((i / votes) * burstMs);
            await service.handleCommand({ jamId, userId: `u${i}`, name: `U${i}`, isHost: false },
                { type: 'UPVOTE', payload: { trackId: ids[i % ids.length] } });
        })());
    }
    await Promise.all(jobs);
    await sleep(windowMs + 50);

    const keys = await redis.keys(`room:${jamId}:*`);
    if (keys.length) await redis.del(...keys);
    return {
        messages: { snapshots: snapshots.length, raw: rawDiffs.length, coalesced: coalescedOut.length },
        bytes: { snapshots: snapshots.reduce((a, s) => a + bytes(s), 0), raw: rawDiffs.reduce((a, d) => a + bytes(d), 0), coalesced: coalescedOut.reduce((a, d) => a + bytes(d), 0) },
    };
}

console.log('payload benchmark: real jamService + Redis, bytes to ONE client during a vote burst (JSON body size)');
for (const cfg of [
    { tracks: 8, votes: 50, burstMs: 1000, windowMs: 100 },
    { tracks: 8, votes: 200, burstMs: 1000, windowMs: 100 },
    { tracks: 30, votes: 200, burstMs: 1000, windowMs: 100 },
    { tracks: 8, votes: 1, burstMs: 1, windowMs: 100 },
]) {
    const r = await run(cfg);
    const pct = (a, b) => `${(100 * (1 - a / b)).toFixed(0)}% smaller`;
    console.log(
        `${String(cfg.tracks).padStart(2)} tracks, ${String(cfg.votes).padStart(3)} votes over ${cfg.burstMs} ms | ` +
        `snapshots ${r.messages.snapshots} msgs/${r.bytes.snapshots} B | raw diffs ${r.messages.raw} msgs/${r.bytes.raw} B | ` +
        `coalesced ${r.messages.coalesced} msgs/${r.bytes.coalesced} B ` +
        `(${pct(r.bytes.coalesced, r.bytes.snapshots)} than snapshots, ${pct(r.bytes.coalesced, r.bytes.raw)} than raw diffs)`,
    );
}
await redis.quit();
