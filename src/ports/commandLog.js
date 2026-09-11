/**
 * Records an audit trail of every command applied to a room, ordered by
 * the same version number RoomStorePort produces for each mutation —
 * this keeps the log's order anchored to the real state store rather
 * than inventing a second, independent ordering scheme. This is a
 * secondary record (debugging, recovery), not the source of truth:
 * current state is always read via RoomStorePort.getState, not by
 * replaying this log.
 *
 * @typedef {Object} CommandLogPort
 * @property {(roomId: string, command: object, version: number) => Promise<void>} append
 *   Record a command that was just applied to a room, alongside the
 *   version number RoomStorePort.applyCommand returned for that mutation.
 * @property {(roomId: string) => Promise<Array<{command: object, version: number, recordedAt: Date}>>} getLog
 *   Fetch a room's full command history, ordered by version ascending —
 *   the actual order those commands were applied in.
 */

export {};
