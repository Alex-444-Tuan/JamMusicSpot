export function createRedisRoomStore(redis){
    return {
        async applyCommand(roomId, command){
            if(command.type === 'ADD_TRACK'){
                const roomIdKey = `room:${roomId}:queue`
                const trackKey = `room:${roomId}:trackId:${command.payload.trackId}`;
                const version = await redis.incr(`room:${roomId}:version`);
                // we need a score formula here to determine how it will be ordered
                // for now set everything to payload.addedAt
                // const score = ;
                await redis
                .multi()
                .hset(trackKey, command.payload)
                .zadd(roomIdKey, command.payload.addedAt, trackKey)
                .exec();
                const state = (await this.getState(roomId)).state;
                return { state, version };
            } else if(command.type === 'UPVOTE'){
                const identity = `room:${roomId}:trackId:${command.payload.trackId}:voter:${command.payload.userId}`;
                const wasAdded = await redis.sadd(`room:${roomId}:identity`, identity);
                let version = 0;
                if(wasAdded === 1){
                    const trackKey = `room:${roomId}:trackId:${command.payload.trackId}`;
                    const newScore = await redis.zincrby(`room:${roomId}:queue`, -172800000, trackKey);
                    version = await redis.incr(`room:${roomId}:version`);
                } else {
                    version = Number(await redis.get(`room:${roomId}:version`));
                }
                const state = (await this.getState(roomId)).state;
                return {state, version};

            } else {
                throw new Error(`not supported yet: ${command.type}`);
            }
        },
        async getState(roomId){
            const allIds = await redis.zrange(`room:${roomId}:queue`, 0 , -1);
            const countTotal = await redis.zcard(`room:${roomId}:queue`);
            const version = Number(await redis.get(`room:${roomId}:version`));
            if(countTotal === 0){
                return {state: [], version};
            } else {
                const pipeline = redis.pipeline();
                allIds.forEach(id => {
                    pipeline.hgetall(id);
                });
                const result = await pipeline.exec();
                const items = result.map(([error, hash]) => {
                    if(error){
                        throw new Error(`failed to fetch item: ${error.message}`);
                    }
                    return {
                        trackId: hash.trackId,
                        addedBy: hash.addedBy,
                        addedAt: Number(hash.addedAt),
                        upvotedBy: []
                    }
                })
                return {state: items, version};
            }
    
        }
    }
}