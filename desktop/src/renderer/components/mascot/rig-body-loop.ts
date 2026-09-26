// The mascot's idle body loops (breathe, bounce, float, sleep, dizzy sway),
// computed for a moment in time instead of run as CSS keyframes.
//
// WHY (2026-09-26, measured on Destin's real screen, Radeon 8060S at 180 Hz):
// the welcome screen sitting idle kept the graphics chip ~36% busy and used
// about half a CPU core — almost all of it from these loops. A smooth CSS
// keyframe animation makes the browser draw a frame at the panel's FULL refresh
// rate, 180 times a second, for a movement of a few pixels. MascotRig already
// updates the limbs 30 times a second; computing the body loop in that same
// update means the whole mascot draws 30 frames a second and no more.
// Measured after, same screen and theme: graphics chip ~36% -> ~12-17% busy
// (6% with no mascot), app CPU ~2/3 of a core -> ~1/4. Stepped (steps()) CSS was
// tried first: similar cost, but it drops the ease-in-out and draws out of
// step with the limb updates.
//
// The numbers below are the old mascot.css keyframes, unchanged: same
// durations, same values, same ease-in-out per segment, same origins. Only the
// thing that drives them moved.

export type BodyLoop = 'breathe' | 'bounce' | 'float' | 'sleep' | 'dizzy';

/** One keyframe: `at` in 0–1; ty in % of the view box, multiplied by amp. */
interface Frame { at: number; ty?: number; sx?: number; sy?: number; rot?: number }
interface LoopDef { ms: number; origin: string; frames: Frame[] }

const LOOPS: Record<BodyLoop, LoopDef> = {
  breathe: { ms: 4000, origin: '', frames: [{ at: 0, ty: 0 }, { at: 0.5, ty: -1.6 }, { at: 1, ty: 0 }] },
  bounce: {
    ms: 1150, origin: '50% 85%',
    frames: [
      { at: 0, ty: 0, sx: 1, sy: 1 },
      { at: 0.28, ty: -3, sx: 0.985, sy: 1.02 },
      { at: 0.55, ty: 0, sx: 1.015, sy: 0.985 },
      { at: 0.72, ty: -0.9, sx: 1, sy: 1 },
      { at: 1, ty: 0, sx: 1, sy: 1 },
    ],
  },
  float: { ms: 5800, origin: '50% 60%', frames: [{ at: 0, ty: 1.6, rot: -1.2 }, { at: 0.5, ty: -2.8, rot: 1.2 }, { at: 1, ty: 1.6, rot: -1.2 }] },
  sleep: { ms: 6500, origin: '50% 85%', frames: [{ at: 0, ty: 0, sx: 1, sy: 1 }, { at: 0.5, ty: -2.2, sx: 1.012, sy: 0.988 }, { at: 1, ty: 0, sx: 1, sy: 1 }] },
  dizzy: { ms: 1500, origin: '50% 85%', frames: [{ at: 0, rot: -2.6 }, { at: 0.5, rot: 2.6 }, { at: 1, rot: -2.6 }] },
};

/** CSS `ease-in-out` = cubic-bezier(0.42, 0, 0.58, 1): progress → eased progress. */
export function easeInOut(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const p1 = 0.42, p2 = 0.58;
  const bx = (t: number) => 3 * (1 - t) * (1 - t) * t * p1 + 3 * (1 - t) * t * t * p2 + t * t * t;
  // x(t) is monotonic on [0,1]; bisection is exact enough (1e-6) and branch-free.
  let lo = 0, hi = 1, t = x;
  for (let i = 0; i < 30; i++) {
    t = (lo + hi) / 2;
    if (bx(t) < x) lo = t; else hi = t;
  }
  return 3 * (1 - t) * t * t + t * t * t; // y(t) with p1y = 0, p2y = 1
}

/**
 * The body transform at `nowMs`. `amp` scales the vertical travel (the old
 * `--amp` intensity); `msOverride` sets the period (hyper's fast breath, 1.8 s).
 */
export function bodyLoopAt(loop: BodyLoop, nowMs: number, amp = 1, msOverride?: number): { transform: string; origin: string } {
  const def = LOOPS[loop];
  const ms = msOverride ?? def.ms;
  const phase = (((nowMs % ms) + ms) % ms) / ms;
  const f = def.frames;
  let i = 0;
  while (i < f.length - 2 && phase >= f[i + 1].at) i++;
  const a = f[i], b = f[i + 1];
  const e = easeInOut((phase - a.at) / (b.at - a.at));
  const mix = (u: number | undefined, v: number | undefined, dflt: number) => (u ?? dflt) + ((v ?? dflt) - (u ?? dflt)) * e;
  const ty = mix(a.ty, b.ty, 0) * amp;
  const sx = mix(a.sx, b.sx, 1);
  const sy = mix(a.sy, b.sy, 1);
  const rot = mix(a.rot, b.rot, 0);
  return {
    transform: `translateY(${ty.toFixed(3)}%) scale(${sx.toFixed(4)}, ${sy.toFixed(4)}) rotate(${rot.toFixed(3)}deg)`,
    origin: def.origin,
  };
}
