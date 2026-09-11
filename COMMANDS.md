# Commands

Quick reference for local development. Run everything from the project root.

## Setup

```
npm install
```

## Tests (Vitest — domain logic, no Redis/Mongo needed)

```
npm test                                  # run the whole suite once
npm run test:watch                        # rerun on file changes
npx vitest run src/domain/roomReducer.test.js   # run just one file
```

## Docker (Redis + Mongo, for local dev)

```
docker compose up -d          # start both containers in the background
docker compose ps             # check status/health
docker compose logs redis     # tail a service's logs (or: mongo)
docker compose down           # stop containers, keep data (named volumes)
docker compose down -v        # stop containers AND wipe all data
```

## Redis CLI (inspecting/debugging real Redis state)

```
docker compose exec redis redis-cli ping        # sanity check — should print PONG
docker compose exec redis redis-cli KEYS "*"    # list every key currently stored
docker compose exec redis redis-cli DEL <key>   # delete a specific key
docker compose exec redis redis-cli FLUSHDB     # wipe everything (local dev only!)
```

## Manual smoke test (real Redis, outside the Vitest suite)

```
node smokeTest/probe.mjs
```

Calls the Redis adapter directly against the real local container and prints
the result — useful for a quick sanity check while writing adapter code,
before it's worth writing a full integration test for it.
