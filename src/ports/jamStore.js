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
 */

export {};
