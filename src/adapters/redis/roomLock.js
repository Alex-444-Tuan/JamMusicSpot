// Redis-backed RoomLockPort: the single-instance "SET NX PX + compare-and-
// delete" lock pattern.
//   room:{r}:lock   STRING random token, PX ttl
// Acquire: SET key token NX PX ttl, retried with 5–25ms jitter until
// acquireTimeoutMs. Release: Lua GET == token → DEL, so we never delete a
// lock that expired and was taken by someone else.

import { randomBytes } from 'node:crypto';
import { JamError } from '../../services/errors.js';

const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createRedisRoomLock(redis, { ttlMs = 5000, acquireTimeoutMs = 3000 } = {}){
    if(typeof redis.jamReleaseLock !== 'function'){
        redis.defineCommand('jamReleaseLock', { numberOfKeys: 1, lua: RELEASE_LUA });
    }
    const lockKey = (roomId) => `room:${roomId}:lock`;

    async function acquire(roomId){
        const token = randomBytes(16).toString('hex');
        const deadline = Date.now() + acquireTimeoutMs;
        for(;;){
            if(await redis.set(lockKey(roomId), token, 'PX', ttlMs, 'NX') === 'OK') return token;
            if(Date.now() >= deadline){
                throw new JamError('BUSY', 'The room is busy, try again');
            }
            await sleep(5 + Math.random() * 20);
        }
    }

    async function release(roomId, token){
        return redis.jamReleaseLock(lockKey(roomId), token);
    }

    return {
        async withLock(roomId, fn){
            const token = await acquire(roomId);
            try{
                return await fn();
            } finally {
                const released = await release(roomId, token).catch((err) => {
                    console.warn('[roomLock] release failed', { roomId, err });
                    return null;
                });
                if(released === 0){
                    console.warn('[roomLock] lock expired mid-command; another holder may have run concurrently', { roomId, ttlMs });
                }
            }
        },
        _release: release,
    };
}
