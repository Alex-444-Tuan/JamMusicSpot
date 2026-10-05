// Socket.IO-backed PresencePort. Presence is read from live sockets, not a
// counter: with @socket.io/redis-adapter, fetchSockets() asks every instance,
// so a crashed instance's sockets simply stop being listed.
//   room  <jamId>                 every socket in the jam
//   room  <jamId>:user:<userId>   one member's sockets (private notices)

export const userRoom = (jamId, userId) => `${jamId}:user:${userId}`;

export function createSocketPresence(io){
    return {
        async listPresent(jamId){
            const sockets = await io.in(jamId).fetchSockets();
            const ids = sockets
                .filter((s) => s.data && s.data.jamId === jamId && typeof s.data.userId === 'string')
                .map((s) => s.data.userId);
            return [...new Set(ids)];
        },
        toRoom(jamId, event, payload){
            io.to(jamId).emit(event, payload);
        },
        toUser(jamId, userId, event, payload){
            io.to(userRoom(jamId, userId)).emit(event, payload);
        },
    };
}
