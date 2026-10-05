import { chooseCompact, composeDiffs } from '../domain/stateDiff.js';

// Per-room fixed window. Within a window, diffs are kept as a list of
// contiguous runs: a diff whose fromVersion continues the last run extends
// it; anything else (e.g. another instance produced the version in
// between) starts a new run. At window end each run is emitted in order,
// so a client never receives a diff that skips over a gap.
//
// A run remembers its endpoint states ({queue, playback} before its first
// diff and after its last), passed in by the service as publishDiff's 3rd
// argument. At flush the emitted ops are re-derived from those endpoints —
// chooseCompact(before, after) — so a burst of N changes costs at most
// about one snapshot instead of N diffs. The states are internal and never
// emitted. If a diff arrives without states, the run falls back to
// composing the ops.
export function createCoalescingBroadcaster(broadcast, windowMs){
    const openRoom = new Map()
    return{
        async publishDiff(roomId, diff, states){
            const existing = openRoom.get(roomId);

            if(existing) {
                const last = existing.runs[existing.runs.length - 1];
                if(diff.fromVersion === last.diff.toVersion){
                    last.diff = composeDiffs(last.diff, diff);
                    last.after = states ? states.after : undefined;
                    last.hasStates = last.hasStates && Boolean(states);
                } else {
                    existing.runs.push(newRun(diff, states));
                }
                return;
            }

            const newRoom = {runs: [newRun(diff, states)]};
            openRoom.set(roomId, newRoom);

            setTimeout(() => {
                openRoom.delete(roomId);
                for(const run of newRoom.runs){
                    // Nobody awaits this timer, so a failed broadcast must be
                    // contained here: an unhandled rejection would take the
                    // whole process down on Node 24. A client that misses a
                    // diff sees a version gap and resyncs from a snapshot.
                    try {
                        Promise.resolve(broadcast.publishDiff(roomId, {
                            fromVersion: run.diff.fromVersion,
                            toVersion: run.diff.toVersion,
                            ops: run.hasStates ? chooseCompact(run.before, run.after) : run.diff.ops,
                        })).catch((err) => reportFailedBroadcast(roomId, err));
                    } catch (err) {
                        reportFailedBroadcast(roomId, err);
                    }
                }
            }, windowMs);
        }
    }
}

function reportFailedBroadcast(roomId, err){
    console.error('[coalescer] broadcast failed; clients will resync on the version gap', { roomId, err });
}

function newRun(diff, states){
    return {
        diff,
        before: states ? states.before : undefined,
        after: states ? states.after : undefined,
        hasStates: Boolean(states),
    };
}
