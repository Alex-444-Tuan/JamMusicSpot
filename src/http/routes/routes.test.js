import { expect, test, vi } from 'vitest';
import { createJamsHandlers } from './jams.js';
import { createCatalogHandlers } from './catalog.js';
import { createTracksHandlers } from './tracks.js';
import { JamError } from '../../services/errors.js';

function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status: vi.fn((code) => { res.statusCode = code; return res; }),
    json: vi.fn((body) => { res.body = body; return res; }),
  };
  return res;
}

const catalog = [
  { trackId: 'song-a', title: 'A', artist: 'X', durationMs: 180000, color: '#111111', secret: 'not public' },
];

test('POST /api/jams → 201 with the created jam', async () => {
  const jam = { jamId: 'AB23CD', hostToken: 'tok', inviteUrl: '/?jam=AB23CD' };
  const res = fakeRes();
  await createJamsHandlers({ createJam: async () => jam }).create({}, res);
  expect(res.statusCode).toBe(201);
  expect(res.body).toStrictEqual(jam);
});

test('POST /api/jams failure → 500 INTERNAL envelope', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const res = fakeRes();
  await createJamsHandlers({ createJam: async () => { throw new JamError('INTERNAL', 'x'); } }).create({}, res);
  expect(res.statusCode).toBe(500);
  expect(res.body).toStrictEqual({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  spy.mockRestore();
});

test('GET /api/jams/:jamId → 200 {jamId} or 404 JAM_NOT_FOUND', async () => {
  const service = {
    getJam: async (jamId) => {
      if (jamId === 'AB23CD') return { jamId };
      throw new JamError('JAM_NOT_FOUND', 'No such jam');
    },
  };
  const handlers = createJamsHandlers(service);

  const ok = fakeRes();
  await handlers.get({ params: { jamId: 'AB23CD' } }, ok);
  expect(ok.statusCode).toBe(200);
  expect(ok.body).toStrictEqual({ jamId: 'AB23CD' });

  const missing = fakeRes();
  await handlers.get({ params: { jamId: 'ZZZZZZ' } }, missing);
  expect(missing.statusCode).toBe(404);
  expect(missing.body).toStrictEqual({ error: { code: 'JAM_NOT_FOUND', message: 'No such jam' } });
});

test('GET /api/catalog → only the contract fields', () => {
  const res = fakeRes();
  createCatalogHandlers(catalog).list({}, res);
  expect(res.body).toStrictEqual({
    tracks: [{ trackId: 'song-a', title: 'A', artist: 'X', durationMs: 180000, color: '#111111' }],
  });
});

test('GET /api/tracks/:trackId/url presigns tracks/<id>.mp3 for catalog tracks', async () => {
  const storage = { getURL: vi.fn(async (key) => `https://signed/${key}`) };
  const res = fakeRes();
  await createTracksHandlers(storage, catalog).getUrl({ params: { trackId: 'song-a' } }, res);
  expect(storage.getURL).toHaveBeenCalledWith('tracks/song-a.mp3');
  expect(res.body).toStrictEqual({ url: 'https://signed/tracks/song-a.mp3' });
});

test('GET /api/tracks/:trackId/url for a non-catalog id → 404 UNKNOWN_TRACK, nothing presigned', async () => {
  const storage = { getURL: vi.fn() };
  const res = fakeRes();
  await createTracksHandlers(storage, catalog).getUrl({ params: { trackId: '../secrets' } }, res);
  expect(res.statusCode).toBe(404);
  expect(res.body).toStrictEqual({ error: { code: 'UNKNOWN_TRACK', message: 'That track is not in the catalog' } });
  expect(storage.getURL).not.toHaveBeenCalled();
});

test('GET /api/tracks/:trackId/url storage failure → 500 STORAGE', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const res = fakeRes();
  await createTracksHandlers({ getURL: async () => { throw new Error('boom'); } }, catalog)
    .getUrl({ params: { trackId: 'song-a' } }, res);
  expect(res.statusCode).toBe(500);
  expect(res.body).toStrictEqual({ error: { code: 'STORAGE', message: 'Unable to access storage' } });
  spy.mockRestore();
});
