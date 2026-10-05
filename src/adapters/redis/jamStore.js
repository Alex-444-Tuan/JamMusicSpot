// Redis-backed JamStorePort.
//   room:{r}:meta          STRING JSON {hostToken, createdAt}, claimed with SET NX
//   room:{r}:totalVersion  STRING broadcast version (INCR)

export function createRedisJamStore(redis){
    const metaKey = (jamId) => `room:${jamId}:meta`;
    const versionKey = (jamId) => `room:${jamId}:totalVersion`;

    return {
        async create(jamId, meta){
            const result = await redis.set(metaKey(jamId), JSON.stringify(meta), 'NX');
            return result === 'OK';
        },
        async get(jamId){
            const raw = await redis.get(metaKey(jamId));
            return raw === null ? null : JSON.parse(raw);
        },
        async bumpVersion(jamId){
            return redis.incr(versionKey(jamId));
        },
        async getVersion(jamId){
            return Number(await redis.get(versionKey(jamId)));
        },
    };
}
