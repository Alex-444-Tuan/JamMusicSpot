/**
 * Cross-instance mutual exclusion per room. jamService runs every room
 * mutation (and snapshot read) inside withLock, so two server instances
 * can never interleave a read-then-write on the same room — e.g. two
 * SKIPs that both see the same "current track" and each pop one.
 *
 * The lock has a TTL, so a crashed holder can't wedge a room forever. The
 * price: a holder that outlives its TTL loses exclusivity mid-command;
 * the adapter detects that on release and warns.
 *
 * @typedef {Object} RoomLockPort
 * @property {<T>(roomId: string, fn: () => Promise<T>) => Promise<T>} withLock
 *   Run fn while holding the room's lock; always release afterwards (also
 *   when fn throws). Throws JamError('BUSY') if the lock can't be acquired
 *   in time.
 */

export {};
