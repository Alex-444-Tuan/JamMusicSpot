// ui/catalog.js — searchable catalog with Add buttons.
// Rows are built once per catalog load; renders only toggle button state.

import { state, subscribe } from '../state.js';

let list = null;
let search = null;
let send = null;
const rows = new Map(); // trackId -> {li, btn, haystack}
const pending = new Set();

function buildRows(tracks) {
  list.textContent = '';
  rows.clear();
  for (const t of tracks) {
    const li = document.createElement('li');
    li.className = 'c-row';
    li.dataset.trackId = t.trackId;
    li.innerHTML = `
      <span class="art art--sm" aria-hidden="true"></span>
      <span class="q-meta">
        <span class="q-title"></span>
        <span class="q-sub"></span>
      </span>
      <button type="button" class="add-btn">Add</button>`;
    li.querySelector('.art').style.setProperty('--art', t.color || 'var(--accent)');
    li.querySelector('.q-title').textContent = t.title;
    li.querySelector('.q-sub').textContent = t.artist;
    const btn = li.querySelector('.add-btn');
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      pending.add(t.trackId);
      update(state);
      send('ADD_TRACK', { trackId: t.trackId }).finally(() => {
        pending.delete(t.trackId);
        update(state);
      });
    });
    list.appendChild(li);
    rows.set(t.trackId, { li, btn, haystack: `${t.title} ${t.artist}`.toLowerCase() });
  }
  applyFilter();
}

function applyFilter() {
  const q = (search.value || '').trim().toLowerCase();
  let visible = 0;
  for (const { li, haystack } of rows.values()) {
    const show = !q || haystack.includes(q);
    li.hidden = !show;
    if (show) visible++;
  }
  list.dataset.empty = visible === 0 ? 'true' : 'false';
}

function update(s) {
  const queued = new Set(s.queue.map((q) => q.trackId));
  const current = s.playback.currentTrackId;
  for (const [trackId, { btn }] of rows) {
    let label = 'Add';
    let disabled = false;
    if (trackId === current) { label = 'Playing'; disabled = true; }
    else if (queued.has(trackId)) { label = 'Queued'; disabled = true; }
    else if (pending.has(trackId)) { label = 'Adding…'; disabled = true; }
    if (btn.textContent !== label) btn.textContent = label;
    btn.disabled = disabled || !s.joined;
    btn.classList.toggle('is-queued', label === 'Queued' || label === 'Playing');
  }
}

let lastCatalogSize = -1;
function render(s) {
  if (s.catalog.size !== lastCatalogSize) {
    lastCatalogSize = s.catalog.size;
    buildRows([...s.catalog.values()]);
  }
  update(s);
}

export function initCatalog({ listEl, searchEl, sendCommand }) {
  list = listEl;
  search = searchEl;
  send = sendCommand;
  search.addEventListener('input', applyFilter);
  subscribe(render);
  render(state);
}
