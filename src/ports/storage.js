/**
 * Leverages Cloudflare R2 to deliver audio directly to clients instead of
 * proxying file bytes through Express — keeps the app server fast and
 * avoids it becoming a bandwidth bottleneck for every track played.
 * `key` stays generic (not `trackId`) so this port isn't coupled to the
 * track domain; the caller is responsible for mapping "which track" to
 * "which storage key." Expiry is intentionally not part of this contract
 * — it's an adapter-level detail, hidden from callers.
 *
 * Currently R2-specific by design; if a future need arises to not depend
 * on a third-party provider, swap in a different adapter behind this same
 * contract rather than changing this port.
 *
 * @typedef {Object} StoragePort
 * @property {(key: string) => Promise<string>} getURL
 *   Return a presigned, time-limited URL a client can fetch the object at.
 */

export {};
