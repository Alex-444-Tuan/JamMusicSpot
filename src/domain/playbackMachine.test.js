import { expect, test } from 'vitest';
import playbackReducer from './playbackMachine.js';

const idle = { status: 'IDLE', currentTrackId: null, startedAt: null, pausedAt: null };
const playing = { status: 'PLAYING', currentTrackId: 'track-1', startedAt: 500, pausedAt: null };
const paused = { status: 'PAUSED', currentTrackId: 'track-1', startedAt: 500, pausedAt: 700 };

test('PLAY from PAUSED transitions to PLAYING, shifting startedAt by the paused duration', () => {
  const result = playbackReducer(paused, { type: 'PLAY', payload: { at: 900 } });

  // paused at position 200 (700 − 500); resuming at 900 → startedAt 700
  expect(result).toStrictEqual({ status: 'PLAYING', currentTrackId: 'track-1', startedAt: 700, pausedAt: null });
});

test('PLAY from IDLE is a no-op', () => {
  const result = playbackReducer(idle, { type: 'PLAY', payload: { at: 900 } });

  expect(result).toBe(idle);
});

test('PLAY from PLAYING is a no-op', () => {
  const result = playbackReducer(playing, { type: 'PLAY', payload: { at: 900 } });

  expect(result).toBe(playing);
});

test('PAUSE from PLAYING transitions to PAUSED, keeping startedAt and recording pausedAt', () => {
  const result = playbackReducer(playing, { type: 'PAUSE', payload: { at: 900 } });

  expect(result).toStrictEqual({ status: 'PAUSED', currentTrackId: 'track-1', startedAt: 500, pausedAt: 900 });
});

test('PAUSE from PAUSED is a no-op', () => {
  const result = playbackReducer(paused, { type: 'PAUSE', payload: { at: 900 } });

  expect(result).toBe(paused);
});

test('PAUSE from IDLE is a no-op', () => {
  const result = playbackReducer(idle, { type: 'PAUSE', payload: { at: 900 } });

  expect(result).toBe(idle);
});

test('SKIP with a track transitions straight to PLAYING with that track', () => {
  const result = playbackReducer(playing, { type: 'SKIP', payload: { trackId: 'track-2', at: 2000 } });

  expect(result).toStrictEqual({ status: 'PLAYING', currentTrackId: 'track-2', startedAt: 2000, pausedAt: null });
});

test('SKIP with no track (queue exhausted) transitions to IDLE', () => {
  const result = playbackReducer(playing, { type: 'SKIP', payload: { trackId: null, at: 2000 } });

  expect(result).toStrictEqual({ status: 'IDLE', currentTrackId: null, startedAt: null, pausedAt: null });
});

test('SKIP from PAUSED clears pausedAt', () => {
  const result = playbackReducer(paused, { type: 'SKIP', payload: { trackId: 'track-2', at: 2000 } });

  expect(result).toStrictEqual({ status: 'PLAYING', currentTrackId: 'track-2', startedAt: 2000, pausedAt: null });
});

test('pause then resume preserves the playback position', () => {
  const start = { status: 'PLAYING', currentTrackId: 'track-1', startedAt: 10_000, pausedAt: null };

  const afterPause = playbackReducer(start, { type: 'PAUSE', payload: { at: 25_000 } });
  const positionAtPause = afterPause.pausedAt - afterPause.startedAt;

  const afterResume = playbackReducer(afterPause, { type: 'PLAY', payload: { at: 90_000 } });
  const positionAtResume = 90_000 - afterResume.startedAt;

  expect(positionAtPause).toBe(15_000);
  expect(positionAtResume).toBe(positionAtPause);

  // and it keeps advancing normally from there
  expect(95_000 - afterResume.startedAt).toBe(20_000);
});
