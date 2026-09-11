/**
 * Server time source used to compute per-client clock offsets for
 * playback sync. See src/realtime/clockSync.js for the client-facing
 * protocol built on top of this.
 *
 * @typedef {Object} ClockPort
 * @property {() => number} now
 *   Current server time in milliseconds since epoch.
 */

export {};
