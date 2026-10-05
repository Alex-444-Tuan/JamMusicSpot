export function createSocketBroadcaster(io){
    return {
        // The optional 3rd argument (internal before/after states) is
        // deliberately ignored: only the diff itself goes on the wire.
        async publishDiff(roomId, diff){
            return io.to(roomId).emit('room:diff', diff);
        }
    }
}