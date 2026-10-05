// identity.js — stable per-browser identity + host tokens, persisted in localStorage.
// Vote idempotency on the server keys off userId, so it MUST survive refreshes.

const USER_KEY = 'jam.user';
const HOST_KEY = 'jam.hostTokens';

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode / quota — identity then lives only for this page load.
  }
}

// crypto.randomUUID only exists in secure contexts (https / localhost).
// Over plain-http LAN we fall back to a getRandomValues-based RFC 4122 v4 UUID.
export function uuidv4() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try { return crypto.randomUUID(); } catch { /* fall through */ }
  }
  const b = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(b);
  } else {
    for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  }
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let cachedUser = null;

/** Returns {userId, name}; creates and persists a userId on first call. */
export function getUser() {
  if (cachedUser) return cachedUser;
  const stored = readJson(USER_KEY, null);
  if (stored && typeof stored.userId === 'string' && stored.userId) {
    cachedUser = { userId: stored.userId, name: typeof stored.name === 'string' ? stored.name : '' };
  } else {
    cachedUser = { userId: uuidv4(), name: '' };
    writeJson(USER_KEY, cachedUser);
  }
  return cachedUser;
}

export function setName(name) {
  const user = getUser();
  cachedUser = { ...user, name };
  writeJson(USER_KEY, cachedUser);
  return cachedUser;
}

export function getHostToken(jamId) {
  const tokens = readJson(HOST_KEY, {});
  return tokens && typeof tokens[jamId] === 'string' ? tokens[jamId] : undefined;
}

export function saveHostToken(jamId, token) {
  const tokens = readJson(HOST_KEY, {}) || {};
  tokens[jamId] = token;
  writeJson(HOST_KEY, tokens);
}
