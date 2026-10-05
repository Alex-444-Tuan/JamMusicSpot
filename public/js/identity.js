// identity.js — per-tab identity + host tokens.
//
// userId and host tokens live in sessionStorage: private to one tab, but they
// survive a refresh, which vote idempotency needs (the server keys votes off
// userId, so a reload must not turn one listener into a new voter).
// They must NOT be in localStorage: every tab of a browser shares it, so an
// invite link opened in a second tab came back with the host's userId (its
// votes counted as duplicates) and the host's token (it joined as host).
// Only the display name is shared across tabs, as a convenience to prefill.
// If the host leaves, the server hands host to the earliest-joined member still
// connected and sends them a new token ('jam:promoted'); the old one stops working.

const USER_KEY = 'jam.user';          // sessionStorage: {userId}
const HOST_KEY = 'jam.hostTokens';    // sessionStorage: {[jamId]: token}
const NAME_KEY = 'jam.name';          // localStorage: last used display name

function readJson(storage, key, fallback) {
  try {
    const raw = storage().getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(storage, key, value) {
  try {
    storage().setItem(key, JSON.stringify(value));
  } catch {
    // Private mode / quota — identity then lives only for this page load.
  }
}

const session = () => sessionStorage;
const local = () => localStorage;

// Before this change the name lived next to the userId in localStorage under
// jam.user; read it from there once so returning users keep their name.
function storedName() {
  const name = readJson(local, NAME_KEY, null);
  if (typeof name === 'string') return name;
  const legacy = readJson(local, USER_KEY, null);
  return legacy && typeof legacy.name === 'string' ? legacy.name : '';
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

/** Returns {userId, name}; creates and persists a per-tab userId on first call. */
export function getUser() {
  if (cachedUser) return cachedUser;
  const stored = readJson(session, USER_KEY, null);
  let userId = stored && typeof stored.userId === 'string' && stored.userId ? stored.userId : null;
  if (!userId) {
    userId = uuidv4();
    writeJson(session, USER_KEY, { userId });
  }
  cachedUser = { userId, name: storedName() };
  return cachedUser;
}

export function setName(name) {
  const user = getUser();
  cachedUser = { ...user, name };
  writeJson(local, NAME_KEY, name);
  return cachedUser;
}

export function getHostToken(jamId) {
  const tokens = readJson(session, HOST_KEY, {});
  return tokens && typeof tokens[jamId] === 'string' ? tokens[jamId] : undefined;
}

export function saveHostToken(jamId, token) {
  const tokens = readJson(session, HOST_KEY, {}) || {};
  tokens[jamId] = token;
  writeJson(session, HOST_KEY, tokens);
}

export function clearHostToken(jamId) {
  const tokens = readJson(session, HOST_KEY, {}) || {};
  if (!(jamId in tokens)) return;
  delete tokens[jamId];
  writeJson(session, HOST_KEY, tokens);
}
