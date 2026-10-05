/**
 * Who is connected to a room right now, and private/room-wide notices that
 * are not part of the versioned state (host changes).
 *
 * listPresent must reflect live connections across ALL server instances (a
 * crashed instance's sockets must not count), which is why it is not a
 * counter kept in Redis.
 *
 * @typedef {Object} PresencePort
 * @property {(jamId: string) => Promise<string[]>} listPresent
 *   userIds with at least one live connection in the room.
 * @property {(jamId: string, event: string, payload: object) => void} toRoom
 * @property {(jamId: string, userId: string, event: string, payload: object) => void} toUser
 *   Deliver only to that member's connections (e.g. a new host token).
 */

export {};
