export function createMongoCommandLog(collection){
    return {
        async append(roomId, command, version){
            const line = {roomId: roomId, command: command, version: version, recordedAt: new Date()};
            const result = await collection.insertOne(line);
        },
        async getLog(roomId){
            const query = {roomId: roomId};
            const options = {
                sort: {"version": 1},
                projection: {_id: 0, command: 1, version: 1, recordedAt: 1}
            }

            const result = await (collection.find(query, options)).toArray();
            return result;
        }
    }
}