// ui/queue.js — keyed, in-place queue rendering.
// Rows are keyed by data-track-id and reused across renders; ordering is fixed
// by re-appending existing nodes (a move, not a re-create). That keeps DOM
// identity stable, which is what lets GSAP Flip animate reorders (vote bumps).

import { state, subscribe, trackInfo } from '../state.js';
import { canAnimate, canFlip } from '../motion.js';

let activeFlip = null; // running Flip timeline; finished + killed before the next one

let list = null;
let empty = null;
let countEl = null;
let send = null;
const rows = new Map(); // trackId -> {li, title, artist, by, count, btn, art}
const pending = new Set(); // trackIds with an UPVOTE in flight

function createRow(trackId) {
  const li = document.createElement('li');
  li.className = 'q-row';
  li.dataset.trackId = trackId;
  li.innerHTML = `
    <span class="q-rank" aria-hidden="true"></span>
    <span class="art art--sm" aria-hidden="true"></span>
    <span class="q-meta">
      <span class="q-title"></span>
      <span class="q-sub"><span class="q-artist"></span> · <span class="q-by"></span></span>
    </span>
    <button type="button" class="vote-btn">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 5l7 8h-4.5v6h-5v-6H5z" fill="currentColor"/></svg>
      <span class="vote-count">0</span>
    </button>`;
  const row = {
    li,
    rank: li.querySelector('.q-rank'),
    art: li.querySelector('.art'),
    title: li.querySelector('.q-title'),
    artist: li.querySelector('.q-artist'),
    by: li.querySelector('.q-by'),
    count: li.querySelector('.vote-count'),
    btn: li.querySelector('.vote-btn'),
  };
  row.btn.addEventListener('click', () => {
    if (row.btn.disabled) return;
    pending.add(trackId);
    row.btn.disabled = true;
    send('UPVOTE', { trackId }).finally(() => {
      pending.delete(trackId);
      render(state);
    });
  });
  return row;
}

function render(s) {
  const seen = new Set(s.queue.map((q) => q.trackId));
  const myId = s.me && s.me.userId;
  const created = [];
  const pulses = [];

  // Removed rows vanish immediately (before measuring, so they don't take part in Flip).
  for (const [trackId, row] of rows) {
    if (!seen.has(trackId)) {
      row.li.remove();
      rows.delete(trackId);
    }
  }

  // Flip only when an EXISTING row changes position (not for pure adds/updates).
  const domOrder = Array.from(list.children, (li) => li.dataset.trackId);
  const newOrder = s.queue.map((q) => q.trackId).filter((id) => rows.has(id));
  const reordered = domOrder.length !== newOrder.length || domOrder.some((id, i) => id !== newOrder[i]);
  let flipState = null;
  let existingRows = null;
  if (reordered && canFlip()) {
    activeFlip?.progress(1).kill(); // finish any in-flight reorder so vote bursts can't stack
    activeFlip = null;
    existingRows = newOrder.map((id) => rows.get(id).li);
    flipState = window.Flip.getState(existingRows);
  }

  s.queue.forEach((item, i) => {
    seen.add(item.trackId);
    let row = rows.get(item.trackId);
    if (!row) {
      row = createRow(item.trackId);
      rows.set(item.trackId, row);
      created.push(row.li);
    }
    const t = trackInfo(item.trackId);
    const votes = Array.isArray(item.upvotedBy) ? item.upvotedBy : [];
    const voted = !!myId && votes.includes(myId);

    row.rank.textContent = String(i + 1);
    row.art.style.setProperty('--art', t.color || 'var(--accent)');
    row.title.textContent = t.title;
    row.artist.textContent = t.artist;
    row.by.textContent = `added by ${item.addedBy || 'someone'}`;
    row.count.textContent = String(votes.length);
    if (row.lastCount !== undefined && row.lastCount !== votes.length) pulses.push(row.count);
    if (row.lastVoted === false && voted) pulses.push(row.btn); // my own vote just landed
    row.lastCount = votes.length;
    row.lastVoted = voted;
    row.btn.classList.toggle('is-voted', voted);
    row.btn.disabled = !s.joined || voted || pending.has(item.trackId);
    row.btn.setAttribute('aria-pressed', String(voted));
    row.btn.setAttribute('aria-label', voted
      ? `You upvoted ${t.title}, ${votes.length} vote${votes.length === 1 ? '' : 's'}`
      : `Upvote ${t.title}, ${votes.length} vote${votes.length === 1 ? '' : 's'}`);

    // Move into position only if it's not already there (appendChild/insertBefore moves the node).
    const at = list.children[i];
    if (at !== row.li) list.insertBefore(row.li, at || null);
  });

  empty.hidden = s.queue.length > 0;
  if (countEl) countEl.textContent = s.queue.length ? String(s.queue.length) : '';

  if (flipState) {
    activeFlip = window.Flip.from(flipState, {
      duration: 0.45, ease: 'power2.inOut', absolute: false, targets: existingRows,
      onComplete: () => { activeFlip = null; },
    });
  }

  if (!canAnimate()) return;
  const gsap = window.gsap;
  if (created.length) {
    gsap.fromTo(created, { autoAlpha: 0, x: -12 }, { autoAlpha: 1, x: 0, duration: 0.3, stagger: 0.04, ease: 'power2.out' });
  }
  for (const el of pulses) {
    if (el.classList.contains('vote-count')) {
      gsap.fromTo(el, { scale: 1.4 }, { scale: 1, duration: 0.35, ease: 'back.out(3)', overwrite: true });
    } else {
      gsap.fromTo(el, { scale: 0.9 }, { scale: 1, duration: 0.25, ease: 'power2.out', overwrite: true });
    }
  }
}

export function initQueue({ listEl, emptyEl, countBadge, sendCommand }) {
  list = listEl;
  empty = emptyEl;
  countEl = countBadge;
  send = sendCommand;
  subscribe(render);
  render(state);
}
