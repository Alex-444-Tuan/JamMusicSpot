// Versioned room diffs: what changed between two room snapshots, as a list
// of ops a client applies in order. PURE and import-free on purpose — the
// browser loads this exact file from GET /shared/stateDiff.js, so server
// and client can never disagree about what an op means.
//
// State:  {queue: [{trackId, addedBy, addedAt, upvotedBy}], playback: {...}}
// Ops (applied in order):
//   {op:'queue.remove', trackId}          item must exist
//   {op:'queue.upsert', item}             replace in place, else append
//   {op:'queue.order',  trackIds:[...]}   must be a permutation of current ids
//   {op:'playback.set', playback}
//   {op:'state.replace', queue, playback}  whole state; valid at any position
// Diff:   {fromVersion, toVersion, ops}

// JSON with object keys sorted, so equal values compare equal regardless
// of the key order their source happened to produce.
function canonical(value){
    if(Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if(value !== null && typeof value === 'object'){
        return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function mismatch(){
    return new Error('DIFF_MISMATCH');
}

/**
 * Ops that turn `before` into `after`: removes, then upserts (new or
 * changed items, in `after` order), then queue.order if the resulting
 * order still differs, then playback.set if playback changed. [] = no change.
 */
export function diffState(before, after){
    const ops = [];
    const afterIds = new Set(after.queue.map((t) => t.trackId));
    const beforeById = new Map(before.queue.map((t) => [t.trackId, t]));

    for(const t of before.queue){
        if(!afterIds.has(t.trackId)) ops.push({ op: 'queue.remove', trackId: t.trackId });
    }

    // Order the client will have after removes + upserts (upserts of new items append).
    const projected = before.queue.filter((t) => afterIds.has(t.trackId)).map((t) => t.trackId);
    for(const t of after.queue){
        const prev = beforeById.get(t.trackId);
        if(!prev){
            ops.push({ op: 'queue.upsert', item: t });
            projected.push(t.trackId);
        } else if(canonical(prev) !== canonical(t)){
            ops.push({ op: 'queue.upsert', item: t });
        }
    }

    const target = after.queue.map((t) => t.trackId);
    if(projected.some((id, i) => id !== target[i])){
        ops.push({ op: 'queue.order', trackIds: target });
    }

    if(canonical(before.playback) !== canonical(after.playback)){
        ops.push({ op: 'playback.set', playback: after.playback });
    }
    return ops;
}

/**
 * Apply ops in order. Returns a new {queue, playback}; never mutates the
 * input. Throws Error('DIFF_MISMATCH') if an op doesn't fit the state —
 * the caller should then resync from a snapshot.
 */
export function applyOps(state, ops){
    let queue = state.queue.slice();
    let playback = state.playback;

    for(const o of ops){
        switch(o && o.op){
            case 'queue.remove': {
                const i = queue.findIndex((t) => t.trackId === o.trackId);
                if(i === -1) throw mismatch();
                queue.splice(i, 1);
                break;
            }
            case 'queue.upsert': {
                const copy = { ...o.item, upvotedBy: o.item.upvotedBy.slice() };
                const i = queue.findIndex((t) => t.trackId === copy.trackId);
                if(i === -1) queue.push(copy);
                else queue[i] = copy;
                break;
            }
            case 'queue.order': {
                const byId = new Map(queue.map((t) => [t.trackId, t]));
                const ids = o.trackIds;
                if(!Array.isArray(ids) || ids.length !== queue.length || new Set(ids).size !== ids.length
                    || !ids.every((id) => byId.has(id))){
                    throw mismatch();
                }
                queue = ids.map((id) => byId.get(id));
                break;
            }
            case 'playback.set':
                playback = { ...o.playback };
                break;
            case 'state.replace':
                queue = o.queue.map((t) => ({ ...t, upvotedBy: t.upvotedBy.slice() }));
                playback = { ...o.playback };
                break;
            default:
                throw mismatch();
        }
    }
    return { queue, playback };
}

/**
 * The smaller of two equivalent encodings of before → after: the op diff,
 * or a single state.replace carrying the whole `after` state. A long burst
 * (e.g. ten votes, each reordering the queue) can make the op list bigger
 * than the state itself; this caps a coalesced diff at about one snapshot.
 */
export function chooseCompact(before, after){
    const ops = diffState(before, after);
    const replace = [{ op: 'state.replace', queue: after.queue, playback: after.playback }];
    return JSON.stringify(ops).length > JSON.stringify(replace).length ? replace : ops;
}

/**
 * Compose two contiguous diffs (a.toVersion === b.fromVersion) into one.
 * Ops are concatenated; the only compaction is dropping a playback.set
 * that a later playback.set supersedes.
 */
export function composeDiffs(a, b){
    if(a.toVersion !== b.fromVersion){
        throw new Error(`DIFF_NOT_CONTIGUOUS: ${a.toVersion} → ${b.fromVersion}`);
    }
    const ops = [...a.ops, ...b.ops];
    const lastPlayback = ops.map((o) => o.op).lastIndexOf('playback.set');
    return {
        fromVersion: a.fromVersion,
        toVersion: b.toVersion,
        ops: ops.filter((o, i) => o.op !== 'playback.set' || i === lastPlayback),
    };
}
