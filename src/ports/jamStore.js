/**
 * Jam (room) registry plus the room-wide broadcast version.
 *
 * `meta` is {hostToken, createdAt}. create() must be an atomic claim of
 * the jamId — it returns false (and changes nothing) if the id is taken,
 * so the caller can retry with a fresh id.
 *
 * The totalVersion is the single monotonic counter stamped on every
 * room:diff broadcast. It is independent of RoomStorePort's and
 * PlaybackStorePort's own versions (a sum of those could repeat).
 *
 * @typedef {Object} JamStorePort
 * @property {(jamId: string, meta: {hostToken: string, createdAt: number}) => Promise<boolean>} create
 * @property {(jamId: string) => Promise<{hostToken: string, createdAt: number}|null>} get
 * @property {(jamId: string) => Promise<number>} bumpVersion
 *   Atomically increment and return the room's totalVersion.
 * @property {(jamId: string) => Promise<number>} getVersion
 *   Current totalVersion (0 for a room that has never changed).
 * @property {(jamId: string) => Promise<{userId: string|null, token: string, absentSince: number|null}|null>} getHost
 *   The current host. userId is null while the creator has not claimed the
 *   room yet or after everyone left (vacant). token is the secret that
 *   authorizes host-only commands; it is rotated whenever host changes hands.
 *   absentSince is when the host was first seen missing (null if present).
 *   null if the jam does not exist.
 * @property {(jamId: string, host: {userId: string|null, token: string, absentSince: number|null}) => Promise<void>} setHost
 * @property {(jamId: string, userId: string, name: string, joinedAt: number) => Promise<void>} addMember
 *   Record a member; the FIRST join time is kept (later joins don't move them back).
 * @property {(jamId: string) => Promise<string[]>} membersInJoinOrder
 *   Every userId that ever joined, earliest first.
 * @property {(jamId: string, userId: string) => Promise<string|null>} getName
 */

export {};
