// src/server.js — process entry point: read the environment, build the
// app (src/app.js holds all the wiring), listen, and shut down cleanly on
// SIGTERM/SIGINT.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createJamServer } from './app.js';

// .env is optional (absent in Docker/Fly, where env vars come from the
// platform). Resolved against the project root, not the cwd. Variables
// already set in the environment win over .env.
const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

const R2_VARS = ['R2_ENDPOINT_URL', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'BUCKET'];
const missingR2 = R2_VARS.filter((name) => !process.env[name]);
if (missingR2.length > 0) {
    console.warn(`[server] missing ${missingR2.join(', ')} — audio URLs (GET /api/tracks/:trackId/url) will fail.`);
}

const PORT = Number(process.env.PORT ?? 3000);
const HOST = '0.0.0.0';
// Force-exit if graceful shutdown stalls. Kept under Fly's kill_timeout
// (10s) so we exit on our own terms — with a logged reason — before the
// platform SIGKILLs us. Inside it: up to 3s of command-log flush.
const SHUTDOWN_HARD_TIMEOUT_MS = 8_000;

const jam = createJamServer({
    config: {
        redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
        mongoUrl: process.env.MONGO_URL ?? 'mongodb://localhost:27017',
        mongoDb: process.env.MONGO_DB ?? 'jammusicspot',
        r2: {
            endpoint: process.env.R2_ENDPOINT_URL,
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
            bucket: process.env.BUCKET,
        },
    },
});

await jam.listen(PORT, HOST);
console.log(`server listening on ${HOST}:${PORT}`);

let shuttingDown = false;
async function onSignal(signal){
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} received, shutting down`);
    const hardStop = setTimeout(() => {
        console.error(`[server] shutdown did not finish within ${SHUTDOWN_HARD_TIMEOUT_MS}ms; forcing exit`);
        process.exit(1);
    }, SHUTDOWN_HARD_TIMEOUT_MS);
    hardStop.unref();
    try {
        const { logFlushed, logPending } = await jam.shutdown();
        console.log(`[server] shutdown complete (command log ${logFlushed ? 'flushed' : `NOT flushed, ${logPending} pending`})`);
        process.exit(0);
    } catch (err) {
        console.error('[server] shutdown failed:', err);
        process.exit(1);
    }
}
process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('SIGINT', () => onSignal('SIGINT'));
