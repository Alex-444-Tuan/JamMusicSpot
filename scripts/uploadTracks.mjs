// One-off helper: upload every <trackId>.mp3 in a local folder to the R2 bucket
// where the server expects them (tracks/<trackId>.mp3, see
// src/http/routes/tracks.js), and print a ready-to-paste src/catalog/catalog.js
// entry for each one with its real durationMs (the player's progress bar and
// the host's auto-advance both use it). Edit title/artist before pasting.
//
//   node scripts/uploadTracks.mjs ~/jam-audio            # dry run (default)
//   node scripts/uploadTracks.mjs ~/jam-audio --upload   # actually upload
//
// The trackId is the file name normalised to the catalog's pattern (lowercased,
// anything outside a-z0-9 becomes a dash, capped at 64 chars), so Pixabay names
// like `artist_name-some-title-123456.mp3` work as-is. Credentials come from .env (same
// variables the server uses). Keep the audio folder OUTSIDE the repo so the
// MP3s never get committed.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { TRACK_ID_PATTERN } from '../src/catalog/catalog.js';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

const args = process.argv.slice(2);
const upload = args.includes('--upload');
const dirArg = args.find((a) => !a.startsWith('--'));
if (!dirArg) {
    console.error('usage: node scripts/uploadTracks.mjs <folder-with-mp3s> [--upload]');
    process.exit(1);
}
const dir = path.resolve(dirArg.replace(/^~(?=$|\/)/, homedir()));

// macOS ships afinfo; elsewhere we just skip the duration hint.
function durationMs(file) {
    try {
        const out = execFileSync('afinfo', [file], { encoding: 'utf8' });
        const m = out.match(/estimated duration: ([\d.]+) sec/);
        return m ? Math.round(Number(m[1]) * 1000) : null;
    } catch {
        return null;
    }
}

const { R2_ENDPOINT_URL, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, BUCKET } = process.env;
let s3 = null;
if (upload) {
    const missing = ['R2_ENDPOINT_URL', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'BUCKET'].filter((n) => !process.env[n]);
    if (missing.length) {
        console.error(`missing ${missing.join(', ')} in .env`);
        process.exit(1);
    }
    s3 = new S3Client({
        region: 'auto',
        endpoint: R2_ENDPOINT_URL,
        credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    });
}

const titleCase = (slug) => slug.split('-').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64).replace(/-$/, '');
// Pixabay names look like <artist>-<title words>-<numeric id>.mp3: the artist is
// everything before the FIRST dash, the title is the words after it (minus the
// trailing numeric id). Underscores read as spaces ("alec_koff" -> "Alec Koff").
// Parsed from the original file name, not the slug, so underscores in an artist
// name survive even though the trackId can't contain them.
function parseName(baseName) {
    const words = (t) => titleCase(t.replace(/_/g, ' ').trim().split(/\s+/).join('-'));
    const parts = baseName.split('-');
    if (/^\d+$/.test(parts[parts.length - 1] ?? '')) parts.pop();
    if (parts.length < 2) return { artist: 'EDIT ME', title: words(parts.join(' ')) || 'EDIT ME' };
    const artist = parts.shift();
    return { artist: words(artist), title: words(parts.join(' ')) };
}
// Stable per-track accent colour, derived from the id.
const colorFor = (id) => {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `#${(h & 0xffffff).toString(16).padStart(6, '0')}`;
};

const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mp3')).sort();
if (files.length === 0) {
    console.error(`no .mp3 files in ${dir}`);
    process.exit(1);
}

// Re-runs skip objects that are already in the bucket with the same size.
async function alreadyUploaded(key, size) {
    try {
        const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
        return head.ContentLength === size;
    } catch {
        return false;
    }
}

const entries = [];
const seen = new Set();
let bad = 0;
for (const f of files) {
    const trackId = slugify(f.slice(0, -4));
    if (!TRACK_ID_PATTERN.test(trackId) || seen.has(trackId)) {
        console.log(`SKIP     ${f} (id "${trackId}" is empty or already used by another file)`);
        bad++;
        continue;
    }
    seen.add(trackId);
    const file = path.join(dir, f);
    const key = `tracks/${trackId}.mp3`;
    const mb = (statSync(file).size / 1e6).toFixed(1);
    const dur = durationMs(file);
    if (!upload) {
        console.log(`would upload  ${f} (${mb} MB) -> ${key}`);
    } else if (await alreadyUploaded(key, statSync(file).size)) {
        console.log(`already there  ${key}`);
    } else {
        await s3.send(new PutObjectCommand({
            Bucket: BUCKET,
            Key: key,
            Body: readFileSync(file),
            ContentType: 'audio/mpeg',
        }));
        const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
        console.log(`uploaded  ${key} (${head.ContentLength} bytes)`);
    }
    const { artist, title } = parseName(f.slice(0, -4));
    entries.push(`    { trackId: '${trackId}', title: '${title.replace(/'/g, "\\'")}', artist: '${artist.replace(/'/g, "\\'")}', durationMs: ${dur ?? 0}, color: '${colorFor(trackId)}' },`);
}

console.log('\nPaste into the catalog array in src/catalog/catalog.js (fix title/artist):\n');
console.log(entries.join('\n'));
if (!upload) console.log('\nDry run only. Re-run with --upload to send them.');
if (bad) process.exitCode = 2;
