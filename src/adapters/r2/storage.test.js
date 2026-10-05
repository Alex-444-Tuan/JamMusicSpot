import { expect, test } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { createR2Storage } from './storage.js';

function createFakeS3Client() {
  return new S3Client({
    region: 'auto',
    endpoint: 'https://fake-account-id.r2.cloudflarestorage.com',
    credentials: { accessKeyId: 'fake-access-key', secretAccessKey: 'fake-secret-key' },
  });
}

test('getURL returns a signed URL pointing at the right bucket and key', async () => {
  const storage = createR2Storage(createFakeS3Client(), 'my-bucket');

  const url = await storage.getURL('tracks/track-123.mp3');
  const parsed = new URL(url);

  expect(parsed.host).toBe('my-bucket.fake-account-id.r2.cloudflarestorage.com');
  expect(parsed.pathname).toBe('/tracks/track-123.mp3');
});

test('getURL produces a real signature and an expiry, not a bare path', async () => {
  const storage = createR2Storage(createFakeS3Client(), 'my-bucket');

  const url = await storage.getURL('tracks/track-123.mp3');
  const parsed = new URL(url);

  expect(parsed.searchParams.has('X-Amz-Signature')).toBe(true);
  expect(parsed.searchParams.get('X-Amz-Expires')).toBe('3600');
});

test('different keys produce different paths in the signed URL', async () => {
  const storage = createR2Storage(createFakeS3Client(), 'my-bucket');

  const urlA = await storage.getURL('tracks/track-a.mp3');
  const urlB = await storage.getURL('tracks/track-b.mp3');

  expect(new URL(urlA).pathname).toBe('/tracks/track-a.mp3');
  expect(new URL(urlB).pathname).toBe('/tracks/track-b.mp3');
});
