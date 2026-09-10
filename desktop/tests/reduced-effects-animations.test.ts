import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

// Guard: the app's own "Reduced Effects" setting must actually stop perpetual
// CSS animations.
//
// `data-reduced-effects` is written onto <html> by theme-engine.ts, but before
// 2026-07-30 it had ZERO CSS rules gating on it — it was read only in JS by
// ThemeEffects and MascotRig. Turning Reduced Effects on therefore left every
// CSS keyframe animation running, so the setting silently under-delivered on the
// thing a user turning it on most wants: the app to stop animating.
//
// The expensive one is `.flowing-word`, which animates `background-position` —
// not a compositable property, so layer promotion cannot help it (measured 43.0%
// with `will-change` vs 43.8% without). A single visible keyword costs ~43% of
// one CPU core on a 180Hz panel, and a chat full of user messages is the app's
// most common state.
//
// Each rule is deliberately duplicated across an attribute selector and a
// `prefers-reduced-motion` media block, because CSS cannot express "this selector
// OR this media condition" in one rule. This test pins BOTH halves so a future
// edit to one cannot silently drift from the other.
//
// Investigation: youcoded-dev/docs/archive/investigations/2026-07-30-idle-cpu-burn.md
const GLOBALS = join(__dirname, '..', 'src', 'renderer', 'styles', 'globals.css');

// Every perpetual animation that is NOT already gated elsewhere. The mascot rig
// loops, buddy breathing, and companion shimmer are gated in JS / by
// `.mascot-scene[data-effects-off='1']`, so they are intentionally absent here.
const GATED_SELECTORS = [
  '.flowing-word',
  '.model-load-track::after',
  '.model-load-finalize::after',
  // The stop button's glow runs for the whole of every reply (stop-button-alive, 2026-09-10).
  '.stop-live',
];

describe('Reduced Effects stops perpetual CSS animations', () => {
  const css = readFileSync(GLOBALS, 'utf8');
  // Strip comments so the WHY prose (which names these selectors) cannot satisfy
  // an assertion on its own.
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

  for (const sel of GATED_SELECTORS) {
    const escaped = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    it(`gates ${sel} on [data-reduced-effects]`, () => {
      // The attribute lives on <html>, so the rule is a descendant selector.
      const re = new RegExp(`\\[data-reduced-effects\\]\\s+${escaped}\\s*\\{[^}]*animation:\\s*none`);
      expect(code).toMatch(re);
    });

    it(`still gates ${sel} on prefers-reduced-motion`, () => {
      const re = new RegExp(`${escaped}\\s*\\{[^}]*animation:\\s*none`);
      // Must appear inside a prefers-reduced-motion block, not only the attribute rule.
      const motionBlocks = code.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/g) ?? [];
      expect(motionBlocks.some((b) => re.test(b))).toBe(true);
    });
  }

  it('keeps loading spinners spinning — they are feedback, not decoration', () => {
    // A spinner frozen mid-load reads as "the app has hung". These are transient
    // AND already cheap (layer-promoted in the same investigation), so Reduced
    // Effects deliberately leaves them alone. Pins the decision so a later
    // "stop everything" sweep has to argue with it.
    expect(code).not.toMatch(/\[data-reduced-effects\][^{]*\.animate-spin\s*\{[^}]*animation:\s*none/);
  });
});
