/**
 * Persists the room queue and applies domain commands atomically.
 * All mutations must go through a single atomic Redis operation —
 * no read-modify-write. See src/domain/roomReducer.js for the pure
 * (state, command) => newState logic this wraps.
 *
 * @typedef {Object} RoomStorePort
 * @property {(roomId: string, command: object) => Promise<{state: object, version: number}>} applyCommand
 *   Atomically apply a command to the room's queue and persist the result.
 * @property {(roomId: string) => Promise<{state: object, version: number}>} getState
 *   Fetch the current queue state and its version.
 */

// No runtime export needed — this file exists so other modules can
// reference the shape via `@type {import('./roomStore.js').RoomStorePort}`.
// `export {}` marks it as an ES module rather than a global script.
export {};
