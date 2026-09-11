/**
 * Publishes versioned diffs to every client in a room.
 *
 * @typedef {Object} BroadcasterPort
 * @property {(roomId: string, diff: {version: number, changes: object}) => Promise<void>} publishDiff
 *   Broadcast a versioned diff to every client subscribed to the room.
 */

export {};
