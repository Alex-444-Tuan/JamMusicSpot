import { expect, test } from 'vitest';
import { catalog, TRACK_ID_PATTERN } from './catalog.js';

test('catalog entries are well-formed and unique', () => {
  expect(catalog.length).toBeGreaterThanOrEqual(8);
  const ids = new Set();
  const colors = new Set();
  for (const t of catalog) {
    expect(t.trackId).toMatch(TRACK_ID_PATTERN);
    expect(typeof t.title).toBe('string');
    expect(typeof t.artist).toBe('string');
    expect(t.durationMs).toBeGreaterThanOrEqual(30000);
    expect(t.durationMs).toBeLessThanOrEqual(600000);
    expect(t.color).toMatch(/^#[0-9A-F]{6}$/i);
    ids.add(t.trackId);
    colors.add(t.color.toUpperCase());
  }
  expect(ids.size).toBe(catalog.length);
  expect(colors.size).toBe(catalog.length);
});
