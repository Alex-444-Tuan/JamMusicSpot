// Translates Socket.IO events into jamService calls and service results
// into ack envelopes. No business rules live here.
//
//   'jam:join'     {jamId, userId, name, hostToken?}
//                  → ack {ok:true, isHost, you:{userId,name}, snapshot}
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
// An event sent without an ack callback can't be answered normally, so the
// server emits 'jam:error' {code:'NO_ACK', message} to this socket only
// and ignores the event.

import { JamError } from '../services/errors.js';

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
            const { isHost, userId, name } = await service.joinJam({
                jamId: req.jamId, userId: req.userId, name: req.name, hostToken: req.hostToken,
            });
            // Moving to a different jam on the same socket: leave the old room.
            const previous = socket.data.jamId;
            if(previous && previous !== req.jamId) await socket.leave(previous);
            // Join BEFORE reading the snapshot, so any diff produced after
            // the read is delivered to this socket — nothing falls in the gap.
            await socket.join(req.jamId);
            socket.data.jamId = req.jamId;
            socket.data.userId = userId;
            socket.data.name = name;
            socket.data.isHost = isHost;
            const snapshot = await service.getSnapshot(req.jamId);
            ack({ ok: true, isHost, you: { userId, name }, snapshot });
        } catch (err){
            ack(toErrorEnvelope(err, 'jam:join'));
        }
    });

    socket.on('room:command', async (raw, ack) => {
        if(typeof ack !== 'function'){ rejectNoAck(socket, 'room:command'); return; }
        try{
            const { jamId, userId, name, isHost } = socket.data;
            if(!jamId){
                ack({ ok: false, error: { code: 'NOT_JOINED', message: 'Join a jam first' } });
                return;
            }
            const { version } = await service.handleCommand({ jamId, userId, name, isHost }, raw);
            ack({ ok: true, version });
        } catch (err){
            ack(toErrorEnvelope(err, 'room:command'));
        }
    });

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
