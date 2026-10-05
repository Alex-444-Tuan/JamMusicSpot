export function createMongoCommandLog(collection){
    return {
        async append(roomId, command, version, seq = 0){
            const line = {roomId: roomId, command: command, version: version, seq: seq, recordedAt: new Date()};
            const result = await collection.insertOne(line);
        },
        async appendMany(roomId, commands, version){
            const recordedAt = new Date();
            const lines = commands.map((command, seq) => ({roomId: roomId, command: command, version: version, seq: seq, recordedAt: recordedAt}));
            await collection.insertMany(lines, {ordered: false});
        },
        async getLog(roomId){
            const query = {roomId: roomId};
            const options = {
                sort: {"version": 1, "seq": 1},
                projection: {_id: 0, command: 1, version: 1, seq: 1, recordedAt: 1}
            }

            const result = await (collection.find(query, options)).toArray();
            return result;
        },
        async ensureIndexes(){
            await collection.createIndex({roomId: 1, version: 1, seq: 1}, {unique: true});
        }
    }
}