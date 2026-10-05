// ui/controls.js — host-only transport. Guests see a read-only note.
//   IDLE + non-empty queue → Play  = SKIP {expectedTrackId: null}  (loads the top track)
//   PLAYING                → Pause = PAUSE {}
//   PAUSED                 → Play  = PLAY {}
//   Skip (always)          →         SKIP {expectedTrackId: currentTrackId}

import { state, subscribe } from '../state.js';

let els = null;
let send = null;
let busy = false;

const ICON_PLAY = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>';

function primaryAction(s) {
  const { status } = s.playback;
  if (status === 'PLAYING') return { type: 'PAUSE', payload: {}, label: 'Pause', icon: ICON_PAUSE, enabled: true };
  if (status === 'PAUSED') return { type: 'PLAY', payload: {}, label: 'Play', icon: ICON_PLAY, enabled: true };
  return { type: 'SKIP', payload: { expectedTrackId: null }, label: 'Play', icon: ICON_PLAY, enabled: s.queue.length > 0 };
}

function render(s) {
  els.host.hidden = !s.isHost;
  els.guest.hidden = s.isHost;
  if (!s.isHost) return;

  const a = primaryAction(s);
  els.primary.innerHTML = a.icon;
  els.primary.setAttribute('aria-label', a.label);
  els.primary.title = a.label;
  els.primary.disabled = !s.joined || busy || !a.enabled;

  const canSkip = !!s.playback.currentTrackId || s.queue.length > 0;
  els.skip.disabled = !s.joined || busy || !canSkip;
}

function run(type, payload) {
  busy = true;
  render(state);
  send(type, payload).finally(() => {
    busy = false;
    render(state);
  });
}

export function initControls({ root, sendCommand }) {
  els = {
    host: root.querySelector('[data-ctl="host"]'),
    guest: root.querySelector('[data-ctl="guest"]'),
    primary: root.querySelector('[data-ctl="primary"]'),
    skip: root.querySelector('[data-ctl="skip"]'),
  };
  send = sendCommand;
  els.primary.addEventListener('click', () => {
    const a = primaryAction(state);
    if (a.enabled) run(a.type, a.payload);
  });
  els.skip.addEventListener('click', () => {
    run('SKIP', { expectedTrackId: state.playback.currentTrackId ?? null });
  });
  subscribe(render);
  render(state);
}
