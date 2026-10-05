/**
 * Records an audit trail of every command applied to a room, ordered by
 * the room's broadcast totalVersion (JamStorePort.bumpVersion) — the same
 * number stamped on the room:diff and the client's ack, so the log lines
 * up exactly with what clients saw. One broadcast can carry several
 * commands (a SKIP logs REMOVE_TRACK then SKIP); those entries share the
 * version and are ordered within it by `seq` (0, 1, …). This is a
 * secondary record (debugging, recovery), not the source of truth:
 * current state is always read via RoomStorePort.getState, not by
 * replaying this log.
 *
 * @typedef {Object} CommandLogPort
 * @property {(roomId: string, command: object, version: number, seq?: number) => Promise<void>} append
 *   Record a command that was just applied to a room. `version` is the
 *   room's broadcast totalVersion for that mutation (not a store's own
 *   version); `seq` (default 0) orders entries sharing a version.
 * @property {(roomId: string, commands: object[], version: number) => Promise<void>} appendMany
 *   Record every command produced by one mutation under the same
 *   `version`, with seq 0, 1, … in array order and a shared recordedAt.
 *   This is one round trip (an ordered bulk insert), NOT a transaction:
 *   if it fails midway, earlier entries may already be stored. That's
 *   acceptable for a best-effort audit trail.
 * @property {(roomId: string) => Promise<Array<{command: object, version: number, seq: number, recordedAt: Date}>>} getLog
 *   Fetch a room's full command history, ordered by (version, seq)
 *   ascending — the actual order those commands were applied in.
 * @property {() => Promise<void>} ensureIndexes
 *   Create the unique (roomId, version, seq) index. Idempotent.
 */

export {};
