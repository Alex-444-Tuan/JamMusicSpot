import playbackReducer from "../../domain/playbackMachine.js";
import { roomStoreKeys, VOTERS_SUFFIX } from "./roomStore.js";

// SKIP is the one playback command that also mutates the queue, so it is
// a single Lua script: check expectedTrackId, pop the next track (with its
// metadata hash and voters set), write the new playback state — all
// atomic. It implements exactly playbackMachine's SKIP transition
// (enforced by playbackStore.skip.test.js). Returns {status, trackId}:
//   STALE — currentTrackId ≠ expected; nothing changed
//   NOOP  — IDLE with an empty queue; nothing changed
//   OK    — trackId is the new current track, or false → went IDLE
// The new state is concatenated rather than cjson.encode'd. cjson prints 14
// significant digits, which a 13-digit ms epoch would survive, so this is a
// defensive choice (no reliance on cjson's number formatting), not a bug fix.
const SKIP_LUA = `
-- KEYS: 1 queue zset, 2 playback, 3 playback version, 4 room (queue) version
-- ARGV: 1 expected currentTrackId ('\\0' = null), 2 now (ms), 3 track key prefix, 4 voters suffix
local raw = redis.call('GET', KEYS[2])
local status = 'IDLE'
local current = '\\0'
if raw then
  local p = cjson.decode(raw)
  status = p.status
  if type(p.currentTrackId) == 'string' then current = p.currentTrackId end
end
if current ~= ARGV[1] then
  return {'STALE'}
end
local popped = redis.call('ZPOPMIN', KEYS[1])
if #popped == 0 and status == 'IDLE' then
  return {'NOOP'}
end
if #popped == 0 then
  redis.call('SET', KEYS[2], '{"status":"IDLE","currentTrackId":null,"startedAt":null,"pausedAt":null}')
  redis.call('INCR', KEYS[3])
  return {'OK'}
end
local member = popped[1]
local trackId = redis.call('HGET', member, 'trackId') or string.sub(member, string.len(ARGV[3]) + 1)
redis.call('DEL', member, member .. ARGV[4])
redis.call('INCR', KEYS[4])
redis.call('SET', KEYS[2], '{"status":"PLAYING","currentTrackId":' .. cjson.encode(trackId) .. ',"startedAt":' .. ARGV[2] .. ',"pausedAt":null}')
redis.call('INCR', KEYS[3])
return {'OK', trackId}
`;

const NULL_TRACK = '\0';

export function createRedisPlaybackStore(redis) {
  if (typeof redis.jamSkip !== 'function') {
    redis.defineCommand('jamSkip', { numberOfKeys: 4, lua: SKIP_LUA });
  }

  return {
    async applyCommand(roomId, command) {
      const { state, version } = await this.getState(roomId);
      const newState = playbackReducer(state, command);

      if (newState === state) {
        return { state, version };
      }

      await redis.set(`room:${roomId}:playback`, JSON.stringify(newState));
      const newVersion = await redis.incr(`room:${roomId}:playback:version`);

      return { state: newState, version: newVersion };
    },

    async skipNext(roomId, expectedTrackId, at) {
      const [status, trackId] = await redis.jamSkip(
        roomStoreKeys.queueKey(roomId),
        `room:${roomId}:playback`,
        `room:${roomId}:playback:version`,
        roomStoreKeys.versionKey(roomId),
        expectedTrackId ?? NULL_TRACK,
        String(Math.trunc(at)),
        roomStoreKeys.trackPrefix(roomId),
        VOTERS_SUFFIX,
      );
      return { status, trackId: trackId ?? null };
    },

    async getState(roomId) {
      const raw = await redis.get(`room:${roomId}:playback`);
      const version = Number(await redis.get(`room:${roomId}:playback:version`));

      if (raw === null) {
        return { state: { status: 'IDLE', currentTrackId: null, startedAt: null, pausedAt: null }, version };
      }
      return { state: JSON.parse(raw), version };
    },
  };
}
