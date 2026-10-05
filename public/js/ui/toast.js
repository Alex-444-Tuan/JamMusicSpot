// ui/toast.js — small, de-duplicated toasts in an aria-live region.

import { canAnimate } from '../motion.js';

const MAX_TOASTS = 3;
const TTL_MS = 3800;
const DEDUPE_MS = 2500;

let region = null;
const recent = new Map(); // message -> timestamp

export function initToasts(el) {
  region = el;
}

export function toast(message, kind = 'info') {
  if (!region || !message) return;
  const now = Date.now();
  const last = recent.get(message);
  if (last && now - last < DEDUPE_MS) return;
  recent.set(message, now);

  while (region.children.length >= MAX_TOASTS) region.firstElementChild.remove();

  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  region.appendChild(el);

  const gsap = window.gsap;
  if (canAnimate()) gsap.from(el, { autoAlpha: 0, y: 12, duration: 0.25, ease: 'power2.out' });

  setTimeout(() => {
    if (canAnimate() && el.isConnected) {
      gsap.to(el, { autoAlpha: 0, y: -6, duration: 0.2, onComplete: () => el.remove() });
    } else {
      el.remove();
    }
  }, TTL_MS);
}

const FRIENDLY = {
  UNKNOWN_TRACK: "That track isn't in the catalog.",
  DUPLICATE_TRACK: 'That track is already in the queue.',
  NOT_IN_QUEUE: 'That track is no longer in the queue.',
  NOT_JOINED: 'Still connecting to the jam — try again in a moment.',
  NOT_HOST: 'Only the host can control playback.',
  BAD_COMMAND: 'The server rejected that request.',
  STALE_SKIP: 'The track already changed.',
  INTERNAL: 'Something went wrong on the server. Try again.',
  BUSY: 'The jam is busy right now — try again in a moment.',
  JAM_NOT_FOUND: 'This jam no longer exists.',
  TIMEOUT: 'The server took too long to respond.',
  DISCONNECTED: "You're offline — reconnecting…",
  NETWORK: 'Could not reach the server.',
  STORAGE: 'Audio storage is unavailable right now.',
  BAD_REQUEST: "The server couldn't accept that — check your name and try again.",
  NO_ACK:"The server couldn't confirm that request. Try refreshing the page.",
};

export function friendlyMessage(error) {
  const code = error && error.code;
  return FRIENDLY[code] || (error && error.message) || 'Something went wrong.';
}
