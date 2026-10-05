// Redis-backed JamStorePort.
//   room:{r}:meta          STRING JSON {hostToken, createdAt}, claimed with SET NX
//   room:{r}:totalVersion  STRING broadcast version (INCR)
//   room:{r}:host          HASH   {userId, token, absentSince} — the current host.
//                                 Absent until the first change; until then the
//                                 host is the unclaimed creator token from meta.
//   room:{r}:members       ZSET   userId -> first join time (ZADD NX), the
//                                 order host succession follows
//   room:{r}:names         HASH   userId -> display name (latest)

export function createRedisJamStore(redis){
    const metaKey = (jamId) => `room:${jamId}:meta`;
    const versionKey = (jamId) => `room:${jamId}:totalVersion`;
    const hostKey = (jamId) => `room:${jamId}:host`;
    const membersKey = (jamId) => `room:${jamId}:members`;
    const namesKey = (jamId) => `room:${jamId}:names`;

    async function get(jamId){
        const raw = await redis.get(metaKey(jamId));
        return raw === null ? null : JSON.parse(raw);
    }

    return {
        async create(jamId, meta){
            const result = await redis.set(metaKey(jamId), JSON.stringify(meta), 'NX');
            return result === 'OK';
        },
        get,
        async bumpVersion(jamId){
            return redis.incr(versionKey(jamId));
        },
        async getVersion(jamId){
            return Number(await redis.get(versionKey(jamId)));
        },
        async getHost(jamId){
            const h = await redis.hgetall(hostKey(jamId));
            if(h && h.token){
                return { userId: h.userId || null, token: h.token, absentSince: h.absentSince ? Number(h.absentSince) : null };
            }
            const meta = await get(jamId);
            return meta ? { userId: null, token: meta.hostToken, absentSince: null } : null;
        },
        async setHost(jamId, { userId, token, absentSince }){
            await redis.hset(hostKey(jamId), {
                userId: userId ?? '',
                token,
                absentSince: absentSince == null ? '' : String(absentSince),
            });
        },
        async addMember(jamId, userId, name, joinedAt){
            await redis.multi()
                .zadd(membersKey(jamId), 'NX', joinedAt, userId)
                .hset(namesKey(jamId), userId, name)
                .exec();
        },
        async membersInJoinOrder(jamId){
            return redis.zrange(membersKey(jamId), 0, -1);
        },
        async getName(jamId, userId){
            return redis.hget(namesKey(jamId), userId);
        },
    };
}
