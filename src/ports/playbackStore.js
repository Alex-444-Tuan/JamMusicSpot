/**
 * Persists playback status (IDLE/PLAYING/PAUSED, current track, start
 * time) per room. Unlike RoomStorePort, this reuses the pure
 * playbackMachine reducer directly — read current state, run it through
 * playbackMachine(state, command), write the result back — rather than
 * reimplementing transition rules as native Redis operations. That's a
 * deliberate deviation: RoomStorePort needs native atomic ops (ZINCRBY)
 * specifically to prevent a lost-vote race under concurrent voting;
 * playback control doesn't have that same concurrency profile (control
 * is effectively single-actor), so the simplicity of reusing the
 * already-tested reducer outweighs the atomicity RoomStorePort needs.
 *
 * Because PLAY/PAUSE are read-then-write, they rely on callers serializing
 * commands per room: src/services/jamService.js runs every command through
 * a per-room chain plus a cross-instance Redis lock (a lease).
 *
 * SKIP is the exception. It is the only playback command that also mutates
 * the queue (it pops the next track), and a lost race there consumes an
 * extra track — so it alone moves into one atomic Lua script, skipNext.
 * "Exactly one track per skip" therefore no longer depends on the lease
 * lock holding. The script implements the same transition as
 * playbackMachine's SKIP (checked by playbackStore.skip.test.js);
 * PLAY/PAUSE stay read-then-write through playbackMachine by choice, since
 * they touch nothing but playback.
 *
 * State: {status: 'IDLE'|'PLAYING'|'PAUSED', currentTrackId, startedAt,
 * pausedAt} — see src/domain/playbackMachine.js for the position math.
 *
 * @typedef {Object} PlaybackStorePort
 * @property {(roomId: string, command: object) => Promise<{state: object, version: number}>} applyCommand
 *   Apply a playback command (PLAY/PAUSE/SKIP) via playbackMachine and
 *   persist the result.
 * @property {(roomId: string, expectedTrackId: string|null, at: number) => Promise<{status: 'OK'|'STALE'|'NOOP', trackId: string|null}>} skipNext
 *   Atomically: if currentTrackId !== expectedTrackId → STALE (no change);
 *   else pop the next queued track (deleting its metadata and voters) and
 *   set playback to PLAYING it from `at`, or to IDLE if the queue was
 *   empty. IDLE with an empty queue → NOOP (no change). Bumps the playback
 *   version, and the queue version when a track was popped.
 * @property {(roomId: string) => Promise<{state: object, version: number}>} getState
 *   Fetch the current playback status and its version.
 */

export {};
