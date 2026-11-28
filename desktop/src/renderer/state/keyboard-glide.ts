// The keyboard glide's arithmetic: where a value is, on its way from one height to another (card #213).
// One of three parts the keyboard code was split into on 2026-11-09 (it had been one 180-line block doing five jobs):
//   state/keyboard-glide.ts      this file: the timing curve, no page access, unit-tested
//   hooks/keyboard-live-lift.ts  what moves on the page during a glide and at its end
//   hooks/useVisualViewport.ts   where the height comes from, and the frame clock that drives the other two
// Behaviour is pinned by tests/keyboard-offset-hook.test.tsx, written against the code before the split.

/** The Android keyboard's slide: ~340 ms measured on a Galaxy Z Flip7; Android's keyboard curve (fast start, gentle stop). */
const IME_GLIDE_MS = 300;

/** cubic-bezier(0.2, 0, 0, 1) at progress t (0-1): x(u) is solved for u by bisection, then y(u). */
function imeEase(t: number): number {
  const bez = (a: number, b: number, u: number) => 3 * a * u * (1 - u) ** 2 + 3 * b * u * u * (1 - u) + u ** 3;
  let lo = 0, hi = 1, u = t;
  for (let i = 0; i < 20; i++) { u = (lo + hi) / 2; if (bez(0.2, 0, u) < t) lo = u; else hi = u; }
  return bez(0, 1, u);
}

export type Glide = { from: number; to: number; start: number; cur: number };
export const newGlide = (): Glide => ({ from: 0, to: 0, start: 0, cur: 0 });

/** Point the glide at a new height. `glide: false` jumps there at once. */
export function aimGlide(g: Glide, to: number, glide: boolean, now: number): void {
  if (to === g.to) return;
  g.from = g.cur; g.to = to; g.start = now;
  if (!glide) g.cur = to;
}

/** Advance to `now`. True while the glide is still moving. */
export function stepGlide(g: Glide, now: number): boolean {
  if (g.cur === g.to) return false;
  const t = Math.min(1, (now - g.start) / IME_GLIDE_MS);
  g.cur = t >= 1 ? g.to : g.from + (g.to - g.from) * imeEase(t);
  return t < 1;
}
