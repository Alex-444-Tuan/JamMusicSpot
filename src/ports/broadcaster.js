/**
 * Publishes versioned diffs to every client in a room.
 *
 * Wire shape (what clients receive as 'room:diff'):
 *   {fromVersion, toVersion, ops} — see src/domain/stateDiff.js.
 *
 * @typedef {Object} BroadcasterPort
 * @property {(roomId: string, diff: {fromVersion: number, toVersion: number, ops: object[]}, states?: {before: {queue: object[], playback: object}, after: {queue: object[], playback: object}}) => Promise<void>} publishDiff
 *   Broadcast a versioned diff to every client subscribed to the room.
 *   `states` (optional) are the room's {queue, playback} immediately
 *   before and after this diff. They are internal — decorators such as
 *   the coalescer use them to re-derive one compact diff for a burst —
 *   and must never be emitted to clients.
 */

export {};
