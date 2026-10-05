// Redis-backed RoomStorePort.
//
// Key layout per room r:
//   room:{r}:queue                  ZSET  member = track hash key, score = composite score
//   room:{r}:trackId:{t}            HASH  {trackId, addedBy, addedAt}
//   room:{r}:trackId:{t}:voters     SET   userIds that upvoted this queue entry
//   room:{r}:version                STRING queue version (INCR)
//
// Composite score = addedAt + votes * VOTE_WEIGHT_MS, read ascending
// (lowest score plays next). Every mutation is exactly one Lua script, so
// each one is a single atomic Redis operation — no read-modify-write
// across round trips. Votes still go through ZINCRBY (inside the script).
//
// Note: the scripts touch the per-track hash/voter keys by name. For
// ADD_TRACK/UPVOTE those names are passed via KEYS[]; popNext can't know
// which track it will pop in advance, so it derives them from the popped
// member. Fine on a single Redis node; would need hash-tagged keys on a
// Redis Cluster.

export const VOTE_WEIGHT_MS = -172800000; // 2 days, per vote

const ADD_TRACK_LUA = `
-- KEYS: 1 queue, 2 track hash (also the ZSET member), 3 voters, 4 version
-- ARGV: 1 addedAt, 2 trackId, 3 addedBy
if redis.call('ZADD', KEYS[1], 'NX', ARGV[1], KEYS[2]) == 0 then
  return 0
end
redis.call('DEL', KEYS[3])
redis.call('HSET', KEYS[2], 'trackId', ARGV[2], 'addedBy', ARGV[3], 'addedAt', ARGV[1])
return redis.call('INCR', KEYS[4])
`;

const UPVOTE_LUA = `
-- KEYS: 1 queue, 2 track hash (ZSET member), 3 voters, 4 version
-- ARGV: 1 vote weight (delta), 2 userId
-- returns {status, version}: -1 not in queue, 0 repeat vote (no change), 1 counted
if not redis.call('ZSCORE', KEYS[1], KEYS[2]) then
  return {-1, 0}
end
if redis.call('SADD', KEYS[3], ARGV[2]) == 0 then
  return {0, tonumber(redis.call('GET', KEYS[4]) or '0')}
end
redis.call('ZINCRBY', KEYS[1], ARGV[1], KEYS[2])
return {1, redis.call('INCR', KEYS[4])}
`;

const POP_NEXT_LUA = `
-- KEYS: 1 queue, 2 version
-- ARGV: 1 track key prefix ("room:{r}:trackId:")
-- returns {0, version} when empty, else {1, version, trackId}
local popped = redis.call('ZPOPMIN', KEYS[1])
if #popped == 0 then
  return {0, tonumber(redis.call('GET', KEYS[2]) or '0')}
end
local member = popped[1]
local trackId = redis.call('HGET', member, 'trackId')
if not trackId then
  trackId = string.sub(member, string.len(ARGV[1]) + 1)
end
redis.call('DEL', member, member .. ':voters')
return {1, redis.call('INCR', KEYS[2]), trackId}
`;

// Key templates, exported so other adapters that must touch the queue
// atomically (playbackStore's SKIP script) build the very same names.
export const VOTERS_SUFFIX = ':voters';
const queueKey = (roomId) => `room:${roomId}:queue`;
const versionKey = (roomId) => `room:${roomId}:version`;
const trackPrefix = (roomId) => `room:${roomId}:trackId:`;
const trackKey = (roomId, trackId) => `${trackPrefix(roomId)}${trackId}`;
const votersKey = (roomId, trackId) => `${trackKey(roomId, trackId)}${VOTERS_SUFFIX}`;
export const roomStoreKeys = { queueKey, versionKey, trackPrefix, trackKey, votersKey };

function codedError(code, message){
    const err = new Error(message);
    err.code = code;
    return err;
}

export function createRedisRoomStore(redis){
    // defineCommand is idempotent per name on a client; guard anyway so
    // several stores can share one connection.
    if(typeof redis.jamAddTrack !== 'function'){
        redis.defineCommand('jamAddTrack', { numberOfKeys: 4, lua: ADD_TRACK_LUA });
        redis.defineCommand('jamUpvote', { numberOfKeys: 4, lua: UPVOTE_LUA });
        redis.defineCommand('jamPopNext', { numberOfKeys: 2, lua: POP_NEXT_LUA });
    }


    return {
        async applyCommand(roomId, command){
            if(command.type === 'ADD_TRACK'){
                const { trackId, addedBy, addedAt } = command.payload;
                const version = await redis.jamAddTrack(
                    queueKey(roomId), trackKey(roomId, trackId), votersKey(roomId, trackId), versionKey(roomId),
                    addedAt, trackId, addedBy,
                );
                if(version === 0){
                    throw codedError('DUPLICATE_TRACK', `track ${trackId} is already in the queue`);
                }
                const { state } = await this.getState(roomId);
                return { state, version };
            } else if(command.type === 'UPVOTE'){
                const { trackId, userId } = command.payload;
                const [status, version] = await redis.jamUpvote(
                    queueKey(roomId), trackKey(roomId, trackId), votersKey(roomId, trackId), versionKey(roomId),
                    VOTE_WEIGHT_MS, userId,
                );
                if(status === -1){
                    throw codedError('NOT_IN_QUEUE', `track ${trackId} is not in the queue`);
                }
                const { state } = await this.getState(roomId);
                return { state, version, changed: status === 1 };
            } else {
                throw new Error(`not supported yet: ${command.type}`);
            }
        },

        async popNext(roomId){
            const [status, version, trackId] = await redis.jamPopNext(
                queueKey(roomId), versionKey(roomId), trackPrefix(roomId),
            );
            return { trackId: status === 1 ? trackId : null, version };
        },

        async getState(roomId){
            // Round trip 1: queue order + version, read together atomically.
            const [[zErr, members], [vErr, rawVersion]] = await redis
                .multi()
                .zrange(queueKey(roomId), 0, -1)
                .get(versionKey(roomId))
                .exec();
            if(zErr || vErr) throw zErr || vErr;
            const version = Number(rawVersion);
            if(members.length === 0){
                return { state: [], version };
            }

            // Round trip 2: every track's hash and voter set in one pipeline.
            const pipeline = redis.pipeline();
            members.forEach((member) => {
                pipeline.hgetall(member);
                pipeline.smembers(`${member}:voters`);
            });
            const results = await pipeline.exec();

            const state = [];
            for(let i = 0; i < members.length; i++){
                const [hErr, hash] = results[2 * i];
                const [sErr, voters] = results[2 * i + 1];
                if(hErr || sErr){
                    throw new Error(`failed to fetch item: ${(hErr || sErr).message}`);
                }
                // A track popped between the two round trips leaves an
                // empty hash — skip it rather than emit a blank entry.
                if(!hash || !hash.trackId) continue;
                state.push({
                    trackId: hash.trackId,
                    addedBy: hash.addedBy,
                    addedAt: Number(hash.addedAt),
                    upvotedBy: voters.sort(), // SMEMBERS is unordered; sort for deterministic output
                });
            }
            return { state, version };
        },
    }
}
