// Application service: the only place that turns untrusted client input
// into trusted domain commands and drives the stores. Depends on ports
// only — every collaborator is injected.
//
// Mutation pipeline (per command, all under the room lock):
//   validate → read `before` snapshot → build trusted command → store mutation(s)
//   → jamStore.bumpVersion → read `after` snapshot
//   → broadcaster.publishDiff({fromVersion, toVersion, ops: diffState(before, after)})
//   → logWriter.enqueue(jamId, commands, totalVersion)  (seq 0, 1, … in order)
//
// The log is stamped with the broadcast totalVersion (not a store's own
// version, which would collide between queue and playback), and it is
// written last and best-effort: logWriter.enqueue returns immediately and
// retries in the background, so Mongo can never delay an ack or a diff.
//
// All mutations for a room run one at a time: first through a per-room
// promise chain (cheap, in-process — cuts lock contention), then under a
// cross-instance Redis lock (roomLock). That is what makes playback's
// read-then-write and SKIP's "check expectedTrackId, then pop" safe even
// with several server instances. Snapshot reads take the same path, so
// they never observe a half-applied command.

import { timingSafeEqual } from 'node:crypto';
import { JamError } from './errors.js';
import { AddTrack, Vote, RemoveTrack, Play, Pause, Skip } from '../domain/commands.js';
import { diffState } from '../domain/stateDiff.js';

export const JAM_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const JAM_ID_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;
const JAM_ID_LENGTH = 6;
const HOST_TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const HOST_TOKEN_LENGTH = 32;
const CREATE_ATTEMPTS = 5;
const MAX_NAME = 32;
const MAX_USER_ID = 64;
const MAX_TRACK_ID = 64;

const HOST_ONLY = new Set(['PLAY', 'PAUSE', 'SKIP']);

function tokensEqual(a, b){
    if(typeof a !== 'string' || typeof b !== 'string') return false;
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    return ba.length === bb.length && timingSafeEqual(ba, bb);
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {{
 *   jamStore: import('../ports/jamStore.js').JamStorePort,
 *   roomStore: import('../ports/roomStore.js').RoomStorePort,
 *   playbackStore: import('../ports/playbackStore.js').PlaybackStorePort,
 *   roomLock: import('../ports/roomLock.js').RoomLockPort,
 *   logWriter: {enqueue: (jamId: string, commands: object[], version: number) => void},
 *   broadcaster: import('../ports/broadcaster.js').BroadcasterPort,
 *   clock: import('../ports/clock.js').ClockPort,
 *   catalog: Array<{trackId: string}>,
 *   randomId: (length: number, alphabet: string) => string,
 * }} deps
 */
export function createJamService({ jamStore, roomStore, playbackStore, roomLock, logWriter, broadcaster, clock, catalog, randomId }){
    const catalogIds = new Set(catalog.map((t) => t.trackId));

    // ---- per-room serialization: local chain, then the cross-instance lock ----
    const chains = new Map();
    let closing = false;
    function runExclusive(roomId, fn){
        // Once shutdown starts, refuse new work so close() can drain: the
        // client retries BUSY and lands on another instance.
        if(closing) return Promise.reject(new JamError('BUSY', 'Server is restarting, try again'));
        const prev = chains.get(roomId) ?? Promise.resolve();
        const result = prev.then(() => roomLock.withLock(roomId, fn));
        // The tail never rejects, so one failed command can't poison the chain.
        const tail = result.then(() => {}, () => {});
        chains.set(roomId, tail);
        tail.then(() => {
            if(chains.get(roomId) === tail) chains.delete(roomId);
        });
        return result;
    }

    // ---- reads ----
    async function readSnapshot(jamId){
        const [version, queue, playback] = await Promise.all([
            jamStore.getVersion(jamId),
            roomStore.getState(jamId),
            playbackStore.getState(jamId),
        ]);
        return { version, queue: queue.state, playback: playback.state };
    }

    async function requireJam(jamId){
        if(typeof jamId !== 'string' || !JAM_ID_PATTERN.test(jamId)){
            throw new JamError('JAM_NOT_FOUND', 'No such jam');
        }
        const meta = await jamStore.get(jamId);
        if(!meta) throw new JamError('JAM_NOT_FOUND', 'No such jam');
        return meta;
    }

    // ---- write tail: bump → diff → broadcast → log ----
    async function commit(jamId, commands, before){
        const version = await jamStore.bumpVersion(jamId);
        const after = await readSnapshot(jamId);
        // Stamp the diff with the version this mutation produced, not
        // whatever getVersion read (identical while locked, but this
        // keeps the diff and the ack in agreement by construction).
        if(version !== before.version + 1){
            console.warn('[jamService] non-contiguous version; clients will resync', {
                jamId, fromVersion: before.version, toVersion: version,
            });
        }
        // The endpoint states ride along (never emitted) so the coalescer can
        // re-derive one compact diff for a whole burst.
        await broadcaster.publishDiff(jamId, {
            fromVersion: before.version,
            toVersion: version,
            ops: diffState(before, after),
        }, {
            before: { queue: before.queue, playback: before.playback },
            after: { queue: after.queue, playback: after.playback },
        });
        logWriter.enqueue(jamId, commands, version);
        return { version };
    }

    function unchanged(before){
        return { version: before.version };
    }

    // ---- command parsing (untrusted → trusted) ----
    function parse(raw){
        if(!isPlainObject(raw) || typeof raw.type !== 'string'){
            throw new JamError('BAD_COMMAND', 'Command must be {type, payload}');
        }
        const payload = raw.payload === undefined ? {} : raw.payload;
        if(!isPlainObject(payload)){
            throw new JamError('BAD_COMMAND', 'payload must be an object');
        }
        switch(raw.type){
            case 'ADD_TRACK':
            case 'UPVOTE': {
                const { trackId } = payload;
                if(typeof trackId !== 'string' || trackId.length === 0 || trackId.length > MAX_TRACK_ID){
                    throw new JamError('BAD_COMMAND', 'trackId must be a non-empty string');
                }
                return { type: raw.type, trackId };
            }
            case 'PLAY':
            case 'PAUSE':
                return { type: raw.type };
            case 'SKIP': {
                const { expectedTrackId } = payload;
                if(expectedTrackId !== null && typeof expectedTrackId !== 'string'){
                    throw new JamError('BAD_COMMAND', 'expectedTrackId must be a string or null');
                }
                return { type: 'SKIP', expectedTrackId };
            }
            default:
                throw new JamError('BAD_COMMAND', `Unknown command type`);
        }
    }

    // ---- mutations (always run inside runExclusive) ----
    async function addTrack(ctx, { trackId }, before){
        if(!catalogIds.has(trackId)){
            throw new JamError('UNKNOWN_TRACK', 'That track is not in the catalog');
        }
        const command = AddTrack(trackId, ctx.name, clock.now());
        try{
            await roomStore.applyCommand(ctx.jamId, command);
        } catch (err){
            if(err.code === 'DUPLICATE_TRACK') throw new JamError('DUPLICATE_TRACK', 'That track is already queued');
            throw err;
        }
        return commit(ctx.jamId, [command], before);
    }

    async function upvote(ctx, { trackId }, before){
        const command = Vote(trackId, ctx.userId);
        let result;
        try{
            result = await roomStore.applyCommand(ctx.jamId, command);
        } catch (err){
            if(err.code === 'NOT_IN_QUEUE') throw new JamError('NOT_IN_QUEUE', 'That track is not in the queue');
            throw err;
        }
        if(result.changed === false) return unchanged(before);
        return commit(ctx.jamId, [command], before);
    }

    async function applyPlayback(ctx, command){
        const before = await playbackStore.getState(ctx.jamId);
        const after = await playbackStore.applyCommand(ctx.jamId, command);
        if(after.version === before.version) return null; // illegal transition → no-op
        return after;
    }

    async function playOrPause(ctx, { type }, before){
        const now = clock.now();
        const command = type === 'PLAY' ? Play(now) : Pause(now);
        const after = await applyPlayback(ctx, command);
        if(!after) return unchanged(before);
        return commit(ctx.jamId, [command], before);
    }

    // The check-expected → pop → set-playback sequence is one atomic Redis
    // script (playbackStore.skipNext), so "exactly one track per skip"
    // holds even if the room lock (a lease) expired mid-command.
    async function skip(ctx, { expectedTrackId }, before){
        const at = clock.now();
        const { status, trackId } = await playbackStore.skipNext(ctx.jamId, expectedTrackId, at);
        if(status === 'STALE'){
            throw new JamError('STALE_SKIP', 'The track changed before your skip arrived');
        }
        if(status === 'NOOP'){
            return unchanged(before); // nothing playing, nothing queued
        }
        // Logged as before (RemoveTrack + Skip), so log replay is unchanged.
        const commands = [];
        if(trackId !== null){
            commands.push(RemoveTrack(trackId));
        }
        commands.push(Skip(trackId, at));
        return commit(ctx.jamId, commands, before);
    }

    const handlers = { ADD_TRACK: addTrack, UPVOTE: upvote, PLAY: playOrPause, PAUSE: playOrPause, SKIP: skip };

    return {
        async createJam(){
            for(let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++){
                const jamId = randomId(JAM_ID_LENGTH, JAM_ID_ALPHABET);
                const hostToken = randomId(HOST_TOKEN_LENGTH, HOST_TOKEN_ALPHABET);
                if(await jamStore.create(jamId, { hostToken, createdAt: clock.now() })){
                    return { jamId, hostToken, inviteUrl: `/?jam=${jamId}` };
                }
            }
            throw new JamError('INTERNAL', 'Could not allocate a jam id');
        },

        async getJam(jamId){
            await requireJam(jamId);
            return { jamId };
        },

        async joinJam({ jamId, userId, name, hostToken } = {}){
            const meta = await requireJam(jamId);
            if(typeof userId !== 'string' || userId.length === 0 || userId.length > MAX_USER_ID){
                throw new JamError('BAD_REQUEST', `userId must be a string of 1-${MAX_USER_ID} characters`);
            }
            const trimmed = typeof name === 'string' ? name.trim() : '';
            if(trimmed.length === 0 || trimmed.length > MAX_NAME){
                throw new JamError('BAD_REQUEST', `name must be 1-${MAX_NAME} characters`);
            }
            return { isHost: tokensEqual(hostToken, meta.hostToken), userId, name: trimmed };
        },

        // Runs through the room's chain and lock so a snapshot never observes
        // a half-applied command (e.g. a store already mutated but the room
        // version not yet bumped).
        // Used for jam:join and jam:resync.
        // The jam's existence is checked inside the lock too, so a jam that
        // vanished from Redis (flush, eviction) yields JAM_NOT_FOUND rather
        // than an empty version-0 snapshot.
        getSnapshot(jamId){
            return runExclusive(jamId, async () => {
                await requireJam(jamId);
                return readSnapshot(jamId);
            });
        },

        /**
         * Run one client command for the room in ctx.jamId.
         * Resolves {version}: the new room version after a change, or — for
         * a command that changes nothing (repeat vote, illegal PLAY/PAUSE,
         * SKIP from IDLE with an empty queue) — the current version
         * repeated, with no diff broadcast and nothing logged.
         * Rejects with a JamError (BAD_COMMAND, NOT_HOST, JAM_NOT_FOUND,
         * UNKNOWN_TRACK, DUPLICATE_TRACK, NOT_IN_QUEUE, STALE_SKIP, BUSY).
         */
        async handleCommand(ctx, raw){
            const parsed = parse(raw);
            if(HOST_ONLY.has(parsed.type) && !ctx.isHost){
                throw new JamError('NOT_HOST', 'Only the host can control playback');
            }
            return runExclusive(ctx.jamId, async () => {
                await requireJam(ctx.jamId); // never recreate keys for a vanished jam
                const before = await readSnapshot(ctx.jamId);
                return handlers[parsed.type](ctx, parsed, before);
            });
        },

        // Graceful shutdown: stop taking commands, then wait until every
        // queued/in-flight one has finished and released its room lock.
        // Quitting Redis before this left locks held (~5s BUSY for the room
        // on the surviving instance) and could skip a bump/broadcast.
        async close(){
            closing = true;
            await Promise.all([...chains.values()]);
        },

        // test hook: number of rooms with queued/in-flight work
        _pendingRooms: () => chains.size,
    };
}
