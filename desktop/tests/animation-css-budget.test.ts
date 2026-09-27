import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { RENDERER, readSource } from './helpers/guard-scope';

// WHY this reader (t6a review fix, 2026-09-16): these pins were written against a
// read that normalised line endings and DELETED block comments only (not
// readStripped, which also blanks `//` — a URL in a stylesheet would shift).
const readCss = (...p: string[]) => readSource(join(RENDERER, ...p)).replace(/\/\*[\s\S]*?\*\//g, '');

// Guard for the 2026-07-30 idle-CPU investigation's actual conclusion.
//
// On a high-refresh display, ANY smoothly-animating element makes Chromium
// produce and present a frame at the full refresh rate — measured ~1.5-1.9ms of
// CPU per frame (~29% of one core at 180Hz) for a single 64px pulsing dot. The
// cost is per-FRAME, not per-element, and not app-specific (bare Electron:
// 33.7%; plain Chrome: 26.7% for the identical div). Layer promotion via
// `will-change` was tried first, shipped briefly, and then MEASURED USELESS
// (29.8% -> 27.8%); an 8px layer-promoted transform animation still cost 31.9%.
//
// The only levers that work:
//   1. present fewer frames  -> steps() timing (28.75% -> 9.33% at steps(8))
//   2. present zero frames   -> finite iteration counts / Reduced Effects
//
// These are source-text assertions because the failure mode is cosmetic-looking:
// someone "smooths out" a stepped animation back to ease-in-out, or makes a
// finite animation infinite again. Nothing breaks visually — the app just
// quietly resumes burning ~30% of a core whenever that element is on screen.
//
// Investigation: youcoded-dev/docs/archive/investigations/2026-07-30-idle-cpu-burn.md
//
// Plan B (2026-09-16): split out of tests/animation-frame-budget.test.ts. Every
// component-side (.tsx) pin of this block is an ast-grep rule now
// (scripts/ast-grep/rules/): no-unstepped-infinite-animation (inline and
// Tailwind infinite animations, which also covers the SessionStrip breathing
// dot and the HeaderBar challenge pulse), braille-spinner-interval-driven,
// theme-effects-draws-from-interval, mascot-rig-raf-only-for-drag,
// mascot-rig-pauses-when-hidden, setting-row-base-is-stepped-hover,
// session-strip-menu-rows-stepped-hover and session-strip-no-transition-all.
// What stays here reads STYLESHEETS only — CSS is not an ast-grep language in
// this workspace's rule set.

describe('perpetual animations are frame-budgeted', () => {
  const globals = readCss('styles', 'globals.css');

  it('quantizes .animate-pulse with steps() timing', () => {
    expect(globals).toMatch(/\.animate-pulse\s*\{[^}]*animation-timing-function:\s*steps\(/);
  });

  it('quantizes .animate-spin with steps() timing', () => {
    expect(globals).toMatch(/\.animate-spin\s*\{[^}]*animation-timing-function:\s*steps\(/);
  });

  it('keeps .flowing-word finite — its background-position paint cannot be budgeted', () => {
    // Main-thread-painted property: steps() helps far less (still ~40% of a
    // core), so the fix is a finite iteration count. `infinite` here would
    // reintroduce a permanent ~44-66%-of-a-core cost per visible keyword.
    expect(globals).not.toMatch(/animation:\s*flowing-word-pan[^;]*infinite/);
    expect(globals).toMatch(/animation:\s*flowing-word-pan[^;]*\b\d+;/);
  });

  // ── Blind spots closed 2026-08-07 ──
  // The assertions below exist because a real violation
  // (`animate-[version-glow_2s_ease-in-out_infinite]`, StatusBar.tsx) sat
  // undetected in a suite written specifically to catch it. Both class-string
  // shapes now go through the ast-grep rule no-unstepped-infinite-animation
  // instead; this file keeps only the whole-stylesheet sweep below, which
  // scopes exemptions by keyframe NAME (ANIMATION_EXCEPTIONS) rather than a
  // class-attribute shape.

  // Infinite animations that deliberately do NOT carry steps(), each with the
  // reason. An entry here is a decision, not an oversight — adding one should
  // take the same thought as quantizing the animation instead.
  const ANIMATION_EXCEPTIONS: Record<string, string> = {
    'comp-twinkle': 'theme companion SVG — visibility-gated with the scene',
    'comp-spin': 'theme companion SVG — 26s period, visibility-gated with the scene',
    'comp-pulse': 'theme companion SVG — visibility-gated with the scene',
    'comp-bob': 'theme companion SVG — visibility-gated with the scene',
    'mascot-comp-float': 'theme companion float — visibility-gated with the scene',
    'buddy-breathe': 'buddy window is alwaysOnTop so visibilitychange never fires, and quantizing breathing is visible; accepted cost of an opt-in feature',
    'model-load-sweep': 'bounded by the model load, and already disabled by Reduced Effects + prefers-reduced-motion',
  };

  it('sweeps every stylesheet for unbudgeted infinite animations', () => {
    // Replaces three-by-name spot checks with an actual sweep, so a NEW
    // infinite keyframe in any stylesheet has to be a deliberate decision.
    const sheets = ['globals.css', 'mascot.css', 'buddy.css'];
    const offenders: string[] = [];
    for (const sheet of sheets) {
      const css = readCss('styles', sheet);
      for (const m of css.matchAll(/animation:\s*([\w-]+)([^;]*infinite[^;]*);/g)) {
        const [, name, rest] = m;
        if (!/steps\(/.test(rest) && !(name in ANIMATION_EXCEPTIONS)) {
          offenders.push(`${sheet}: ${name}${rest}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('defines .stepped-hover and applies it to the dense hover surfaces', () => {
    // The transcript hover fix (steps(4) scoped to .timeline-entry) generalises
    // to any surface where many hover targets are swept by one pointer motion.
    // These are the app's dense lists; a one-off button is deliberately NOT in
    // scope — it animates once, and a smooth fade there is free.
    // The two component halves (SettingRow's base class, SessionStrip's menu
    // rows) are the ast-grep rules named at the top of this file.
    const globalsHere = readCss('styles', 'globals.css');
    expect(globalsHere).toMatch(/\.stepped-hover\s*\{[^}]*transition-timing-function:\s*steps\(/);
    expect(globalsHere).toMatch(/\.hover-lift\s*\{[^}]*steps\(/);
    expect(globalsHere).toMatch(/\.card-interactive\s*\{[^}]*steps\(/);
  });

  it('sweeps the model-load bar with transform, not left', () => {
    // `left` is not compositable and forces a layout pass on every presented
    // frame — the most expensive per-frame shape in the app, running for the
    // whole duration of a local model load.
    const globalsHere = readCss('styles', 'globals.css');
    const kf = globalsHere.match(/@keyframes model-load-sweep\s*\{[^}]*\}[^}]*\}/);
    expect(kf, '@keyframes model-load-sweep not found').toBeTruthy();
    expect(kf![0]).toMatch(/translateX\(/);
    expect(kf![0]).not.toMatch(/\bleft:/);
  });

  it('pauses mascot motion when the document is hidden', () => {
    // The rig loops are character motion, so they are exempt from steps() in
    // ANIMATION_EXCEPTIONS above. That exemption is only honest if they stop
    // when nobody can see them. The interval must also reset its timestamp on
    // resume, or stepSpring integrates the entire hidden period as one dt and
    // the springs fling off-model on the first visible frame.
    // MascotRig's half (the visibilitychange listener and the clock reset) is
    // the ast-grep rule mascot-rig-pauses-when-hidden.
    const mascotCss = readCss('styles', 'mascot.css');
    expect(mascotCss).toMatch(/data-doc-hidden[^{]*\{[^}]*animation-play-state:\s*paused/);
  });
});
