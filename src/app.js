// src/app.js — composition root: build adapters, inject them into the
// service, mount HTTP routes and Socket.IO handlers. server.js only reads
// the environment and calls this; tests call it directly (several
// instances in one process, on port 0) with overrides for the parts that
// would otherwise reach Mongo or R2.

import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { S3Client } from '@aws-sdk/client-s3';

import { createRedisRoomStore } from './adapters/redis/roomStore.js';
import { createRedisPlaybackStore } from './adapters/redis/playbackStore.js';
import { createRedisJamStore } from './adapters/redis/jamStore.js';
import { createRedisRoomLock } from './adapters/redis/roomLock.js';
import { createMongoCommandLog } from './adapters/mongo/commandLog.js';
import { createResilientCollection } from './adapters/mongo/resilientCollection.js';
import { createSocketBroadcaster } from './adapters/socketBroadcaster.js';
import { createSocketPresence } from './adapters/socketPresence.js';
import { createCoalescingBroadcaster } from './realtime/broadcastCoalescer.js';
import { createR2Storage } from './adapters/r2/storage.js';
import { createSystemClock } from './adapters/systemClock.js';
import { cryptoRandomId } from './adapters/cryptoRandomId.js';
import { catalog } from './catalog/catalog.js';
import { createJamService } from './services/jamService.js';
import { createLogWriter } from './services/logWriter.js';
import { createJamsRouter } from './http/routes/jams.js';
import { createCatalogRouter } from './http/routes/catalog.js';
import { createTracksRouter } from './http/routes/tracks.js';
import { createHealthRouter } from './http/routes/health.js';
import { sendError } from './http/routes/errors.js';
import bindPingHandler from './realtime/clockSync.js';
import { bindJamHandlers } from './realtime/socketGateway.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const STATE_DIFF_PATH = fileURLToPath(new URL('./domain/stateDiff.js', import.meta.url));
const LOG_FLUSH_TIMEOUT_MS = 3000;
const COMMAND_DRAIN_TIMEOUT_MS = 3000;

/**
 * @param {{
 *   config?: {
 *     redisUrl?: string, mongoUrl?: string, mongoDb?: string,
 *     r2?: {endpoint?: string, accessKeyId?: string, secretAccessKey?: string, bucket?: string},
 *     coalesceMs?: number,
 *     hostGraceMs?: number,
 *   },
 *   overrides?: {commandLog?: object, storage?: object, clock?: object},
 * }} options
 */
export function createJamServer({ config = {}, overrides = {} } = {}){
    const {
        redisUrl = 'redis://localhost:6379',
        mongoUrl = 'mongodb://localhost:27017',
        mongoDb = 'jammusicspot',
        r2 = {},
        coalesceMs = 100,
        hostGraceMs = 10_000, // how long a disconnected host keeps host before succession
    } = config;

    // ---- infrastructure clients ----
    // One Redis client shared by all Redis adapters (distinct key names per
    // adapter), plus a pub/sub pair for Socket.IO's cross-instance fan-out.
    const redis = new Redis(redisUrl);
    const pub = redis.duplicate();
    const sub = redis.duplicate();

    // No explicit connect(): the driver connects on first use, so a Mongo
    // outage never blocks startup. The resilient collection rebuilds its
    // client after an outage, and the log writer retries in the background,
    // so Mongo can never delay an ack or a broadcast.
    let mongoCollection = null;
    let commandLog = overrides.commandLog;
    if(!commandLog){
        mongoCollection = createResilientCollection({ url: mongoUrl, dbName: mongoDb, collectionName: 'commandLog' });
        commandLog = createMongoCommandLog(mongoCollection);
        mongoCollection.setOnReconnect(() => commandLog.ensureIndexes());
        // Not awaited: startup must not wait on Mongo.
        commandLog.ensureIndexes().catch((err) => {
            // Most likely causes: Mongo unreachable, or rows written before entries
            // carried a `seq` (cycle-1 format) that collide under the unique index.
            console.warn(
                '[server] could not create the commandLog (roomId, version, seq) unique index:', err.message,
                '\n         The log is a best-effort audit trail; if it holds old-format rows you can drop it:',
                `db.getSiblingDB('${mongoDb}').commandLog.drop()`,
            );
        });
    }

    const storage = overrides.storage ?? createR2Storage(new S3Client({
        region: 'auto',
        endpoint: r2.endpoint,
        credentials: {
            accessKeyId: r2.accessKeyId,
            secretAccessKey: r2.secretAccessKey,
        },
    }), r2.bucket);
    const clock = overrides.clock ?? createSystemClock();

    // ---- adapters + service ----
    const logWriter = createLogWriter(commandLog);

    const app = express();
    const httpServer = createServer(app);
    const io = new Server(httpServer);
    // requestsTimeout bounds cross-instance fetchSockets (presence for host
    // succession), which runs inside the room lock (5 s lease): keep it well under.
    io.adapter(createAdapter(pub, sub, { requestsTimeout: 2000 }));

    // Coalescing window: bursts of votes collapse into one composed broadcast.
    const broadcaster = createCoalescingBroadcaster(createSocketBroadcaster(io), coalesceMs);

    const jamService = createJamService({
        jamStore: createRedisJamStore(redis),
        roomStore: createRedisRoomStore(redis),
        playbackStore: createRedisPlaybackStore(redis),
        roomLock: createRedisRoomLock(redis),
        logWriter,
        broadcaster,
        clock,
        catalog,
        randomId: cryptoRandomId,
        presence: createSocketPresence(io),
        hostGraceMs,
    });

    // ---- HTTP ----
    app.use(express.json());
    app.use('/healthz', createHealthRouter({ redis, logStatus: () => logWriter.status() }));
    app.use('/api/jams', createJamsRouter(jamService));
    app.use('/api/catalog', createCatalogRouter(catalog));
    app.use('/api/tracks', createTracksRouter(storage, catalog));
    app.use('/api', (req, res) => sendError(res, 404, 'NOT_FOUND', 'No such endpoint'));
    // The browser applies diffs with the exact module the server diffs with.
    app.get('/shared/stateDiff.js', (req, res) => {
        res.type('text/javascript');
        res.sendFile(STATE_DIFF_PATH);
    });
    app.use(express.static(PUBLIC_DIR));

    // Keep API errors (e.g. malformed JSON bodies) in the JSON envelope.
    app.use((err, req, res, next) => {
        if(res.headersSent) return next(err);
        const status = err.status || err.statusCode || 500;
        if(status >= 500) console.error('[http] unhandled error:', err);
        sendError(res, status, status >= 500 ? 'INTERNAL' : 'BAD_REQUEST', status >= 500 ? 'Something went wrong' : 'Bad request');
    });

    // ---- Socket.IO ----
    io.on('connection', (socket) => {
        bindPingHandler(socket, clock);
        bindJamHandlers(socket, jamService);
    });

    let shutdownPromise = null;

    return {
        httpServer,
        io,
        logWriter,

        /** Resolves with the bound address once listening. */
        listen(port, host){
            return new Promise((resolve, reject) => {
                httpServer.once('error', reject);
                httpServer.listen(port, host, () => {
                    httpServer.off('error', reject);
                    resolve(httpServer.address());
                });
            });
        },

        /**
         * Graceful shutdown: first drain in-flight room commands (up to 3s;
         * new ones get BUSY) so their locks are released and their diffs
         * leave the coalescer, then stop accepting connections and close
         * sockets, give the command log up to 3s to drain, then close Redis and
         * Mongo. Idempotent. Resolves {logFlushed, logPending}.
         */
        shutdown(){
            if(shutdownPromise) return shutdownPromise;
            shutdownPromise = (async () => {
                let drainTimer;
                await Promise.race([
                    jamService.close(),
                    new Promise((resolve) => { drainTimer = setTimeout(resolve, COMMAND_DRAIN_TIMEOUT_MS); }),
                ]);
                clearTimeout(drainTimer);
                // Let the last coalescing window flush before sockets close.
                await new Promise((resolve) => setTimeout(resolve, coalesceMs));
                await new Promise((resolve) => {
                    io.close(() => resolve()); // also closes httpServer
                    httpServer.closeIdleConnections?.();
                });
                const logFlushed = await logWriter.flush(LOG_FLUSH_TIMEOUT_MS);
                const logPending = logWriter.pending();
                if(!logFlushed){
                    console.warn(`[server] shutdown: ${logPending} command-log batch(es) not written`);
                }
                await Promise.allSettled([redis.quit(), pub.quit(), sub.quit()]);
                if(mongoCollection) await mongoCollection.close().catch(() => {});
                return { logFlushed, logPending };
            })();
            return shutdownPromise;
        },
    };
}
