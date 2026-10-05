// motion.js — the single source of truth for "may we animate?".
// Uses gsap.matchMedia so the flag tracks live OS reduced-motion changes.
// Everything degrades to no animation if the GSAP CDN is blocked.

const gsap = window.gsap;
let allowed = false;

if (gsap) {
  if (window.Flip) gsap.registerPlugin(window.Flip);
  const mm = gsap.matchMedia();
  mm.add(
    { ok: '(prefers-reduced-motion: no-preference)', reduce: '(prefers-reduced-motion: reduce)' },
    (ctx) => { allowed = !!ctx.conditions.ok; },
  );
}

/** True when GSAP is loaded and the user hasn't asked for reduced motion. */
export function canAnimate() {
  return !!gsap && allowed;
}

/** True when GSAP + Flip are both loaded and motion is allowed. */
export function canFlip() {
  return canAnimate() && !!window.Flip;
}
