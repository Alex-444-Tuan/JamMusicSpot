# JamMusicSpot

Real-time collaborative listening rooms. Start a jam, share the invite link,
and everyone in the room queues and upvotes tracks together while playback
stays in sync across devices. The host controls play, pause and skip.

**Live demo:** https://jammusicspot.fly.dev (two Fly.io machines, private
Redis and MongoDB apps, audio served from Cloudflare R2).

## Stack

Node.js 24, Express 5, Socket.IO 4, Redis (ioredis), MongoDB, Cloudflare R2,
Docker, GitHub Actions, Fly.io, Vitest. The frontend is vanilla ES modules
with GSAP for motion; there is no framework and no build step.

## What it demonstrates, and the evidence

Each row is a claim this project set out to back up, what the code actually
does, and how it was verified. Where a claim is weaker than it sounds, the
last column says so.

| # | Claim | What it really does | Evidence / caveat |
|---|---|---|---|
| 1 | Shared state in Redis; instances stay consistent | Queue state lives in Redis (sorted set + hashes + sets). The Socket.IO Redis adapter fans broadcasts out across instances. Per-room commands are serialized in-process and then by a Redis lease lock. | Production test with clients forced onto two different Fly machines: all clients converge to the same state. The lock is a lease with **no fencing token**, so correctness-critical mutations do not depend on it (they are single Lua scripts). Single Redis, no persistence. |
| 2 | Vote races are impossible | Add, upvote and skip are each **one Lua script** (atomic in Redis). A vote is `ZSCORE` + `SADD` (idempotency) + `ZINCRBY`. Ordering uses a composite score: `addedAt - votes * 2 days`, ascending. | `scripts/bench/voteRace.mjs`: a naive read-modify-write lost 90-99% of simultaneous votes; the Lua path lost 0. 100 duplicate votes from one user count once. The "2 days" weight is an assumption about the gap between additions in a live room. |
| 3 | Clock sync, drift fixed by playbackRate nudges | Cristian's algorithm (5 samples, lowest RTT wins). Playback position is derived from one server timestamp. Small drift is corrected by nudging `playbackRate` +-5%; a drift above 1 s, and every track load or resume, hard-seeks. | `scripts/bench/clockSync.mjs` against production: clients with random +-5 s clock skew agree on "server now" to within 4-6 ms (vs ~9.8 s uncorrected). That measures agreement between clients on one machine; it has **not** been measured on real devices or against audio output latency. |
| 4 | Replayable commands, explicit state machine | Every mutation becomes a command object, logged to MongoDB by broadcast version. Playback transitions go through a pure state machine (IDLE / PLAYING / PAUSED) that rejects illegal transitions. | Late joiners get a **snapshot from Redis** plus diffs. The log is a best-effort audit trail that nothing reads in production. `domain/roomReducer.js` is the executable specification of queue semantics (and what the tests exercise); production runs the equivalent Lua. |
| 5 | Coalesced, versioned diffs | Mutations produce `{fromVersion, toVersion, ops}`. A 100 ms per-room window merges a burst into one message, sent as the endpoint diff or a full `state.replace`, whichever is smaller. Clients buffer out-of-order diffs and resync on a gap. | `scripts/bench/payload.mjs`: 200 votes in 1 s sent 309,831 B as per-mutation snapshots vs 16,685 B coalesced (95% smaller), 50,792 B as raw diffs. A single vote is 168 B vs a 941 B snapshot. |
| 6 | Express serves metadata only | Audio never passes through the server; the browser fetches it from R2 with a presigned URL (1 h expiry). Only catalog tracks are ever signed. | Presigned URL returns `206 audio/mpeg` with range support from production. URLs are not refreshed after an hour. |
| 7 | CI, Docker image, Fly deploy | GitHub Actions: tests against ephemeral Redis and Mongo service containers, Docker build, then deploy to Fly on a push to `main` followed by a `/healthz` smoke test. Non-root image with a health check. | The pipeline has run green end to end. There is no staging environment and no automatic rollback. |

## Architecture

```
src/
  domain/      pure logic, no I/O: commands, roomReducer, playbackMachine, stateDiff
  ports/       interfaces (JSDoc): RoomStore, PlaybackStore, JamStore, CommandLog,
               Broadcaster, Clock, Storage, RoomLock
  adapters/    redis/ (Lua stores, lock), mongo/ (command log, resilient client),
               r2/ (presigned URLs), socketBroadcaster, systemClock
  services/    jamService (untrusted input -> trusted commands), logWriter
  realtime/    socketGateway, clockSync, broadcastCoalescer
  http/routes/ jams, catalog, tracks (presign), health
  catalog/     the 50 queueable tracks
  app.js       composition root;  server.js  process entry point
public/        vanilla-JS client (state replica, clock sync, player, GSAP motion)
deploy/        Fly configs for the private Redis and MongoDB apps
scripts/       uploadTracks.mjs (R2 upload helper), bench/ (the benchmarks above)
```

- `domain/` imports nothing from `adapters/`; services depend on `ports/` and
  adapters are injected in `app.js`.
- `domain/stateDiff.js` is import-free and is served to the browser at
  `/shared/stateDiff.js`, so client and server cannot disagree about what a
  diff op means.
- The server never trusts the client: timestamps are server-stamped, `userId`
  and name come from the join context, playback commands need the room's
  current host token (checked on every command, rotated on host change).

### How a vote travels

1. Client emits `room:command {UPVOTE, trackId}`.
2. `jamService` validates it and takes the room's lock (in-process chain, then
   the Redis lease lock).
3. The Lua script atomically checks the track exists, adds the voter to the
   track's set, and bumps its sorted-set score only if the voter is new.
4. The service bumps the room's version, reads the before/after state, and
   publishes `{fromVersion, toVersion, ops}` through the coalescer.
5. Socket.IO's Redis adapter delivers the diff to every instance; clients apply
   it in version order, or buffer and resync on a gap.
6. The command is appended to the Mongo log in the background; a Mongo outage
   never delays the ack.

## Measured numbers

All from this repo's own scripts, on a MacBook against local Redis or against
the live deployment. Rerun them before quoting anything.

```
node scripts/bench/voteRace.mjs      # needs local Redis
node scripts/bench/payload.mjs       # needs local Redis
node scripts/bench/clockSync.mjs     # hits the live deployment (or pass a URL)
npm test                             # 216 tests, about 4 s, real Redis + Mongo
```

## Known limitations

- The Redis lease lock has no fencing token; a command stalled past 5 s could
  let a PLAY/PAUSE (read-then-write) overwrite a concurrent SKIP.
- Redis on Fly is a single node with no persistence: a restart empties all
  rooms (clients land back on the landing page).
- No authentication: `userId` is client-generated and the host token is a bearer
  string, so votes can be spoofed. There is no rate limiting.
- Redis and MongoDB have no auth; they are reachable only on Fly's private network.
- Only the host controls playback. If the host disconnects for more than 10 s,
  host passes to the earliest-joined member still connected (with a fresh host
  token; the old one stops working). Playback pauses for at most that window.
- Scripts that derive keys inside Lua (skip) are not Redis Cluster safe.
- Clock sync has not been measured on real devices.

## Development

```
npm install
docker compose up -d     # local Redis + Mongo
npm test
```

Full command reference: [COMMANDS.md](./COMMANDS.md). To run the app locally,
copy the variables you need into `.env` (`REDIS_URL`, `MONGO_URL`, `MONGO_DB`,
`PORT`, and the R2 variables) and run `node src/server.js`.

## Deploying

Pushing to `main` runs CI and deploys with `fly deploy`. One-time setup:
create the apps in `fly.toml`, `deploy/fly.redis.toml` and
`deploy/fly.mongo.toml`, set the R2 and Mongo secrets with `fly secrets set`,
and add a deploy token to GitHub as `FLY_API_TOKEN`.

Tracks are uploaded to R2 with `node scripts/uploadTracks.mjs <folder> --upload`.

## Audio credits

The 50 tracks come from Pixabay Music and are used under the Pixabay Content
License (no attribution required; credit shown anyway: artist names appear in
the app).
