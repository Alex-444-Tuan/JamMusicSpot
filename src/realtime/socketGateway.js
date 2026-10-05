// Translates Socket.IO events into jamService calls and service results
// into ack envelopes. No business rules live here.
//
//   'jam:join'     {jamId, userId, name, hostToken?}
//                  → ack {ok:true, isHost, hostToken?, host:{userId,name},
//                         you:{userId,name}, snapshot}
//   'jam:claimHost' {hostToken}
//                  → ack {ok:true, isHost}   (a member promoted to host hands
//                    the token it received in 'jam:promoted' to its socket)
//   'room:command' {type, payload}
//                  → ack {ok:true, version}
//   'jam:resync'   {}
//                  → ack {ok:true, snapshot}   (read under the room lock;
//                    clients send this when a room:diff doesn't continue
//                    from their version)
// Failures ack {ok:false, error:{code, message}}.
// A command that changes nothing — a repeat vote, an illegal PLAY/PAUSE
// (e.g. PLAY while already playing), a SKIP from IDLE with an empty queue —
// still acks {ok:true, version}, repeating the room's current version, and
// emits no room:diff. So versions in acks can repeat; they never go back.
// Server-initiated: 'jam:host' {hostUserId, hostName} to the room when host
// changes hands; 'jam:promoted' {jamId, hostToken} only to the new host.
// After every join and every disconnect the gateway asks the service to
// re-check the host (reassessHost), which is what drives succession.
// An event sent without an ack callback can't be answered normally, so the
// server emits 'jam:error' {code:'NO_ACK', message} to this socket only
// and ignores the event.

import { JamError } from '../services/errors.js';
import { userRoom } from '../adapters/socketPresence.js';

function recheckHost(service, jamId){
    if(!jamId || typeof service.reassessHost !== 'function') return;
    service.reassessHost(jamId).catch((err) => {
        console.warn('[socketGateway] host re-check failed', { jamId, code: err.code ?? err.message });
    });
}

function rejectNoAck(socket, event){
    socket.emit('jam:error', { code: 'NO_ACK', message: `'${event}' must be sent with an acknowledgement callback` });
}

function toErrorEnvelope(err, event){
    if(err instanceof JamError){
        return { ok: false, error: { code: err.code, message: err.message } };
    }
    console.error(`[socketGateway] ${event} failed:`, err);
    return { ok: false, error: { code: 'INTERNAL', message: 'Something went wrong' } };
}

export function bindJamHandlers(socket, service){
    socket.on('jam:join', async (payload, ack) => {
        if(typeof ack !== 'function'){ rejectNoAck(socket, 'jam:join'); return; }
        try{
            const req = payload !== null && typeof payload === 'object' ? payload : {};
            const joined = await service.joinJam({
                jamId: req.jamId, userId: req.userId, name: req.name, hostToken: req.hostToken,
            });
            const { isHost, userId, name } = joined;
            // Moving to a different jam (or identity) on the same socket: leave the old rooms.
            const previous = socket.data.jamId;
            if(previous){
                await socket.leave(previous);
                await socket.leave(userRoom(previous, socket.data.userId));
            }
            // Join BEFORE reading the snapshot, so any diff produced after
            // the read is delivered to this socket — nothing falls in the gap.
            await socket.join([req.jamId, userRoom(req.jamId, userId)]);
            socket.data.jamId = req.jamId;
            socket.data.userId = userId;
            socket.data.name = name;
            socket.data.hostToken = isHost ? joined.hostToken : null;
            const snapshot = await service.getSnapshot(req.jamId);
            ack({
                ok: true, isHost, ...(isHost ? { hostToken: joined.hostToken } : {}),
                host: joined.host, you: { userId, name }, snapshot,
            });
            if(previous && previous !== req.jamId) recheckHost(service, previous);
            recheckHost(service, req.jamId);
        } catch (err){
            ack(toErrorEnvelope(err, 'jam:join'));
        }
    });

    socket.on('room:command', async (raw, ack) => {
        if(typeof ack !== 'function'){ rejectNoAck(socket, 'room:command'); return; }
        try{
            const { jamId, userId, name, hostToken } = socket.data;
            if(!jamId){
                ack({ ok: false, error: { code: 'NOT_JOINED', message: 'Join a jam first' } });
                return;
            }
            const { version } = await service.handleCommand({ jamId, userId, name, hostToken }, raw);
            ack({ ok: true, version });
        } catch (err){
            ack(toErrorEnvelope(err, 'room:command'));
        }
    });

    socket.on('jam:claimHost', async (payload, ack) => {
        if(typeof ack !== 'function'){ rejectNoAck(socket, 'jam:claimHost'); return; }
        try{
            const { jamId, userId } = socket.data;
            if(!jamId){
                ack({ ok: false, error: { code: 'NOT_JOINED', message: 'Join a jam first' } });
                return;
            }
            const token = payload !== null && typeof payload === 'object' ? payload.hostToken : undefined;
            const isHost = await service.verifyHost(jamId, userId, token);
            if(isHost) socket.data.hostToken = token;
            ack({ ok: true, isHost });
        } catch (err){
            ack(toErrorEnvelope(err, 'jam:claimHost'));
        }
    });

    // The socket has already left its rooms here, so presence no longer lists it.
    socket.on('disconnect', () => recheckHost(service, socket.data.jamId));

    socket.on('jam:resync', async (payload, ack) => {
        if(typeof ack !== 'function'){ rejectNoAck(socket, 'jam:resync'); return; }
        try{
            const { jamId } = socket.data;
            if(!jamId){
                ack({ ok: false, error: { code: 'NOT_JOINED', message: 'Join a jam first' } });
                return;
            }
            const snapshot = await service.getSnapshot(jamId);
            ack({ ok: true, snapshot });
        } catch (err){
            ack(toErrorEnvelope(err, 'jam:resync'));
        }
    });
}
