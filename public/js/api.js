// api.js — thin fetch wrappers. Non-2xx responses throw ApiError carrying the
// server's {error:{code,message}} envelope (or a synthetic one on network failure).

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      ...options,
    });
  } catch (err) {
    throw new ApiError(0, 'NETWORK', 'Could not reach the server');
  }
  let body = null;
  try { body = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) {
    const e = body && body.error ? body.error : {};
    throw new ApiError(res.status, e.code || `HTTP_${res.status}`, e.message || res.statusText);
  }
  return body;
}

/** POST /api/jams → {jamId, hostToken, inviteUrl} */
export function createJam() {
  return request('/api/jams', { method: 'POST', body: '{}' });
}

/** GET /api/jams/:jamId → {jamId}; throws ApiError code JAM_NOT_FOUND on 404 */
export function getJam(jamId) {
  return request(`/api/jams/${encodeURIComponent(jamId)}`);
}

/** GET /api/catalog → {tracks:[{trackId,title,artist,durationMs,color}]} */
export function getCatalog() {
  return request('/api/catalog');
}

/** GET /api/tracks/:trackId/url → {url} */
export function getTrackUrl(trackId) {
  return request(`/api/tracks/${encodeURIComponent(trackId)}/url`);
}
