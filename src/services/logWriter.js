// Best-effort, non-blocking writer in front of CommandLogPort.
//
// jamService enqueues each committed mutation and moves on, so a slow or
// dead Mongo never delays acks or broadcasts (and never holds the room
// lock). Per room: FIFO, one batch in flight, retried with exponential
// backoff (500ms → 30s cap) until it lands. A duplicate-key error means
// the batch is already stored (e.g. a retry after a lost reply) and
// counts as success — this relies on appendMany being ordered:false so
// the non-duplicate rows of a batch are still written.
//
// Memory is bounded: past maxPending batches, the oldest waiting batch
// (never one in flight) is dropped with a warning. The log is an audit
// trail, not the source of truth, so losing entries under a long outage is
// the accepted trade-off.

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

function isDuplicateKey(err){
    if(!err) return false;
    if(err.code === 11000) return true;
    return Array.isArray(err.writeErrors) && err.writeErrors.length > 0
        && err.writeErrors.every((e) => e.code === 11000);
}

export function createLogWriter(commandLog, { maxPending = 5000 } = {}){
    const rooms = new Map(); // roomId → {queue, inFlight, timer, attempts}
    let pendingCount = 0;
    let droppedCount = 0;
    let nextSeq = 0;
    let lastOutcome = 'unknown';
    let drainWaiters = [];

    function notifyIfDrained(){
        if(pendingCount !== 0) return;
        const waiters = drainWaiters;
        drainWaiters = [];
        waiters.forEach((resolve) => resolve(true));
    }

    function dropOldestWaiting(){
        let victimRoom = null;
        let victimIndex = -1;
        let victimSeq = Infinity;
        for(const room of rooms.values()){
            const i = room.inFlight ? 1 : 0;
            if(room.queue.length > i && room.queue[i].seq < victimSeq){
                victimRoom = room;
                victimIndex = i;
                victimSeq = room.queue[i].seq;
            }
        }
        if(!victimRoom) return;
        const [victim] = victimRoom.queue.splice(victimIndex, 1);
        pendingCount--;
        droppedCount++;
        console.warn('[logWriter] command log backlog full; dropped oldest batch', {
            roomId: victim.roomId, version: victim.version, droppedTotal: droppedCount,
        });
    }

    function pump(roomId){
        const room = rooms.get(roomId);
        if(!room) return;
        if(room.inFlight || room.timer) return;
        if(room.queue.length === 0){
            rooms.delete(roomId);
            return;
        }
        const entry = room.queue[0];
        room.inFlight = true;

        let attempt;
        try{
            attempt = Promise.resolve(commandLog.appendMany(entry.roomId, entry.commands, entry.version));
        } catch (err){
            attempt = Promise.reject(err);
        }

        attempt.then(
            () => settle(roomId, entry, null),
            (err) => settle(roomId, entry, err),
        );
    }

    function settle(roomId, entry, err){
        const room = rooms.get(roomId);
        room.inFlight = false;

        if(!err || isDuplicateKey(err)){
            lastOutcome = 'ok';
            room.attempts = 0;
            room.queue.shift(); // entry is still at the head: overflow never drops in-flight batches
            pendingCount--;
            pump(roomId);
            notifyIfDrained();
            return;
        }

        lastOutcome = 'down';
        room.attempts++;
        const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (room.attempts - 1));
        console.warn(`[logWriter] command log append failed; retrying in ${delay}ms`, {
            roomId, version: entry.version, pending: pendingCount, err: err && err.message,
        });
        room.timer = setTimeout(() => {
            room.timer = null;
            pump(roomId);
        }, delay);
    }

    return {
        /** Queue one mutation's commands for logging. Returns synchronously. */
        enqueue(roomId, commands, version){
            let room = rooms.get(roomId);
            if(!room){
                room = { queue: [], inFlight: false, timer: null, attempts: 0 };
                rooms.set(roomId, room);
            }
            room.queue.push({ roomId, commands, version, seq: nextSeq++ });
            pendingCount++;
            if(pendingCount > maxPending) dropOldestWaiting();
            pump(roomId);
        },

        /** 'unknown' until the first write settles, then the latest outcome. */
        status(){
            return lastOutcome;
        },

        pending(){
            return pendingCount;
        },

        dropped(){
            return droppedCount;
        },

        /**
         * Retry sleeping batches now and wait until everything is written.
         * Resolves true when drained, false if timeoutMs passes first.
         */
        flush(timeoutMs){
            if(pendingCount === 0) return Promise.resolve(true);
            for(const [roomId, room] of rooms){
                if(room.timer){
                    clearTimeout(room.timer);
                    room.timer = null;
                    pump(roomId);
                }
            }
            if(pendingCount === 0) return Promise.resolve(true);
            return new Promise((resolve) => {
                const timer = setTimeout(() => {
                    drainWaiters = drainWaiters.filter((w) => w !== done);
                    resolve(false);
                }, timeoutMs);
                const done = (value) => {
                    clearTimeout(timer);
                    resolve(value);
                };
                drainWaiters.push(done);
            });
        },
    };
}
