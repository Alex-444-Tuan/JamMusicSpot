// ui/nowPlaying.js — current track card + progress bar.
// Progress is computed every frame from serverNow() and the catalog durationMs,
// never from audio.duration, and painted with transform: scaleX() (no layout).

import { state, subscribe, trackInfo } from '../state.js';
import { positionMs, durationMs, onAudioStatus } from '../player.js';
import { isSynced } from '../clock.js';
import { canAnimate } from '../motion.js';

let els = null;
let lastRenderedKey = null;
let npTl = null;   // running now-playing crossfade timeline
// Progress painter: gsap.quickSetter when GSAP is loaded (state, not decoration —
// so not gated by reduced motion), plain style.transform otherwise.
let setScale = (r) => { els.fill.style.transform = `scaleX(${r})`; };

export function formatTime(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

const STATUS_LABEL = { IDLE: 'Nothing playing', PLAYING: 'Playing', PAUSED: 'Paused' };

function render(s) {
  const pb = s.playback;
  const trackId = pb.currentTrackId;
  els.root.dataset.status = pb.status;
  els.status.textContent = STATUS_LABEL[pb.status] || pb.status;

  const key = `${trackId}|${s.catalog.size}|${trackId ? '' : s.queue.length > 0}`;
  if (key === lastRenderedKey) return;
  const isNewTrack = lastRenderedKey !== null && lastRenderedKey.split('|')[0] !== String(trackId);
  lastRenderedKey = key;

  if (!trackId) {
    settleNp(); // a crossfade interrupted by IDLE must not leave text half-faded
    els.title.textContent = s.queue.length ? 'Ready when the host is' : 'Queue something up';
    els.artist.textContent = s.queue.length ? 'Press play to start the jam' : 'Pick a track from the catalog below';
    els.art.style.setProperty('--art', 'var(--surface-3)');
    els.total.textContent = '0:00';
    return;
  }
  const t = trackInfo(trackId);
  els.title.textContent = t.title;
  els.artist.textContent = t.artist;
  els.art.style.setProperty('--art', t.color || 'var(--accent)');
  els.total.textContent = formatTime(t.durationMs);

  if (!isNewTrack) return;
  if (!canAnimate()) return settleNp();
  // fromTo (not from): explicit end values, so rapid skips that interrupt a
  // running crossfade can't capture a half-faded state as the "end".
  const gsap = window.gsap;
  const targets = [els.art, els.title, els.artist];
  npTl?.kill();
  npTl = gsap.timeline()
    .fromTo(targets, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.35, stagger: 0.05, ease: 'power2.out' })
    .fromTo(els.art, { scale: 0.96 }, { scale: 1, duration: 0.45, ease: 'power2.out' }, 0);
}

/** Kill any running crossfade and snap the card to its resting state. */
function settleNp() {
  const gsap = window.gsap;
  if (!gsap) return;
  npTl?.kill();
  npTl = null;
  gsap.set([els.art, els.title, els.artist], { autoAlpha: 1, y: 0, scale: 1 });
}

function frame() {
  const pos = positionMs();
  const dur = durationMs();
  const ratio = dur > 0 && pos != null ? Math.min(1, pos / dur) : 0;
  setScale(ratio);
  els.elapsed.textContent = formatTime(pos == null ? 0 : Math.min(pos, dur || pos));
  els.bar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));

  // Guest-only: the track is well past its end and no SKIP has arrived — the host
  // (the only auto-advancer) is likely gone or backgrounded. Recomputed every frame,
  // so it clears as soon as a diff changes currentTrackId (position resets).
  const pb = state.playback;
  const stalled = isSynced() && !state.isHost && pb.status === 'PLAYING' && dur > 0 && pos != null && pos > dur + STALL_AFTER_MS;
  if (els.stall.hidden === stalled) els.stall.hidden = !stalled;
}

const STALL_AFTER_MS = 5000;

export function initNowPlaying(root) {
  els = {
    root,
    art: root.querySelector('[data-np="art"]'),
    title: root.querySelector('[data-np="title"]'),
    artist: root.querySelector('[data-np="artist"]'),
    status: root.querySelector('[data-np="status"]'),
    bar: root.querySelector('[data-np="bar"]'),
    fill: root.querySelector('[data-np="fill"]'),
    elapsed: root.querySelector('[data-np="elapsed"]'),
    total: root.querySelector('[data-np="total"]'),
    note: root.querySelector('[data-np="note"]'),
    stall: root.querySelector('[data-np="stall"]'),
  };
  if (window.gsap) {
    window.gsap.set(els.fill, { transformOrigin: '0% 50%' });
    setScale = window.gsap.quickSetter(els.fill, 'scaleX');
  }
  subscribe(render);
  render(state);

  onAudioStatus((s) => {
    els.note.hidden = s !== 'unavailable';
  });

  if (window.gsap) window.gsap.ticker.add(frame);
  else (function loop() { frame(); requestAnimationFrame(loop); })();
}
