# JamMusicSpot

Real-time collaborative listening rooms. Members queue and upvote tracks
together; playback stays synchronized across every client in a room.

## What this project demonstrates

- Redis sorted sets hold the shared queue state; pub/sub fan-out keeps
  rooms consistent across horizontally scaled Socket.IO instances.
- Vote race conditions are impossible because every queue mutation is
  one atomic Redis operation, with a composite score encoding vote
  count and insertion time for deterministic ordering.
- Playback is synchronized by an NTP-style clock-offset handshake
  (Cristian's algorithm): position derives from one server timestamp,
  drift is corrected by playbackRate nudges instead of hard seeks.
- Mutations are replayable command objects, logged to MongoDB for
  audit/recovery. Playback transitions live in an explicit state
  machine.
- Broadcasts are coalesced into short windows and carry versioned
  diffs, not full room snapshots.
- Express serves only metadata; audio is delivered via presigned
  Cloudflare R2 URLs.
- CI runs tests against ephemeral Mongo/Redis containers, builds the
  Docker image, and deploys to Fly.io.

## Stack

Node.js, Express, Socket.IO, Redis, MongoDB, Cloudflare R2, Docker,
GitHub Actions, Fly.io, Vitest.

## Architecture

```
src/
  domain/       pure business logic, no I/O — roomReducer, commands
  ports/        interfaces adapters implement — RoomStore, Broadcaster,
                Clock, CommandLog
  adapters/     Redis-backed room queue, MongoDB-backed command log
  realtime/     Socket.IO time-sync protocol handler (clockSync)
```

- `domain/` never imports from `adapters/` — the reducer is
  deterministic and synchronous, so it's fully tested without Redis or
  Mongo running at all.
- Services depend on `ports/`, never on Redis or Mongo clients
  directly; concrete adapters are injected at bootstrap.
- No queue mutation is ever a read-modify-write — every mutation is a
  single atomic Redis operation.

## Development

See [COMMANDS.md](./COMMANDS.md) for the full local dev command
reference (Docker, Vitest, Redis CLI, the manual smoke test).

```
npm install
docker compose up -d   # local Redis + Mongo
npm test
```
