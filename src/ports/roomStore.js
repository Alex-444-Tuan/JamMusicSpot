/**
 * Persists the room queue and applies domain commands atomically.
 * Every mutation is a single atomic Redis operation (one Lua script) —
 * no read-modify-write across round trips. See src/domain/roomReducer.js
 * for the pure (state, command) => newState logic this mirrors.
 *
 * Queue entries: {trackId, addedBy, addedAt, upvotedBy: string[]},
 * highest priority first.
 *
 * Errors are thrown as Error objects carrying a `.code`:
 *   DUPLICATE_TRACK — ADD_TRACK for a track already in the queue (the
 *                     existing entry, its score and its votes are untouched)
 *   NOT_IN_QUEUE    — UPVOTE for a track not in the queue (nothing is created)
 *
 * @typedef {Object} RoomStorePort
 * @property {(roomId: string, command: object) => Promise<{state: object[], version: number, changed?: boolean}>} applyCommand
 *   Atomically apply ADD_TRACK or UPVOTE. UPVOTE results also carry
 *   `changed`: false when the user had already voted (idempotent repeat —
 *   neither score nor version moves). Any other command type throws.
 * @property {(roomId: string) => Promise<{trackId: string|null, version: number}>} popNext
 *   Atomically remove the highest-priority track (lowest score) together
 *   with its metadata and voter set. trackId is null (and version is
 *   unchanged) when the queue is empty.
 * @property {(roomId: string) => Promise<{state: object[], version: number}>} getState
 *   Fetch the current queue state and its version.
 */

// No runtime export needed — this file exists so other modules can
// reference the shape via `@type {import('./roomStore.js').RoomStorePort}`.
// `export {}` marks it as an ES module rather than a global script.
export {};
