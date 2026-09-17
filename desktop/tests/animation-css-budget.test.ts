import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { RENDERER, readSource, readStripped } from './helpers/guard-scope';

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
// Plan B (2026-09-16): split out of tests/animation-frame-budget.test.ts, whose
// two generic "walk every .tsx" sweeps ("bans NEW inline infinite animations…",
// "bans Tailwind arbitrary-value infinite animations…") converted to the
// ast-grep rule no-unstepped-infinite-animation. These 13 cases are per-file
// pins — a specific CSS selector or a specific component's inline style — that
// a generic ast-grep shape can't express without one rule per component; kept
// as source-text reads here (readStripped/readSource per each case's original
// helper, matching the original file's own mix). animation-frame-budget.test.ts
// itself is unchanged apart from losing these 13 + the 2 converted cases: its
// remaining "motion vocabulary" describe block is SessionStrip drag/hover
// mechanics, unrelated to frame budgets, and is the named guard for
// .claude/rules/session-strip-motion.md — do not move or rename it.

describe('perpetual animations are frame-budgeted', () => {
  const globals = readStripped(join(RENDERER, 'styles', 'globals.css'));

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

  it('quantizes the SessionStrip breathing dot (inline animation)', () => {
    // Inline TSX animations are invisible to a CSS-file sweep — this dot runs
    // for every non-idle session in the always-visible header, making it the
    // app's most persistent animation.
    const src = readSource(join(RENDERER, 'components', 'SessionStrip.tsx'));
    expect(src).toMatch(/animation:\s*'breathe[^']*steps\(/);
    expect(src).not.toMatch(/animation:\s*'breathe[^']*ease/);
  });

  it('quantizes the HeaderBar challenge pulse (inline animation)', () => {
    const src = readSource(join(RENDERER, 'components', 'HeaderBar.tsx'));
    expect(src).toMatch(/animation:\s*'challenge-pulse[^']*steps\(/);
    expect(src).not.toMatch(/animation:\s*'challenge-pulse[^']*ease/);
  });

  // ── JS animation drivers ──
  // A requestAnimationFrame chain wakes at the display's refresh rate (180/sec
  // on a 180Hz panel). These three drivers do slow work (12.5fps spinner, 30fps
  // particles, ambient sway) and were each converted to interval-driven ticks —
  // rAF remains legitimate ONLY for genuinely full-rate work (MascotRig's
  // drag-trailing) and one-shot next-frame coalescing.

  it('BrailleSpinner is interval-driven, not a rAF chain', () => {
    const src = readStripped(join(RENDERER, 'components', 'BrailleSpinner.tsx'));
    expect(src).toMatch(/setInterval\(tick/);
    expect(src).not.toMatch(/requestAnimationFrame/);
  });

  it('ThemeEffects draws from an interval, not a rAF chain', () => {
    const src = readStripped(join(RENDERER, 'components', 'ThemeEffects.tsx'));
    expect(src).toMatch(/setInterval\(draw/);
    // The one-shot resize coalescer may keep rAF; the draw loop may not.
    expect(src).not.toMatch(/requestAnimationFrame\(draw/);
  });

  it('MascotRig runs rAF only for the drag chain, idle from an interval', () => {
    const src = readStripped(join(RENDERER, 'components', 'mascot', 'MascotRig.tsx'));
    expect(src).toMatch(/setInterval\(/);
    // Every rAF request must belong to the drag-gated chain (rafTick) — an
    // unconditional `requestAnimationFrame(tick)`-style self-chain regressing
    // here would resume 180 presented frames/sec of ambient sway forever.
    const rafCalls = [...src.matchAll(/requestAnimationFrame\(\s*(\w+)/g)].map((m) => m[1]);
    expect(rafCalls.length).toBeGreaterThan(0);
    expect(rafCalls.every((fn) => fn === 'rafTick')).toBe(true);
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
    'rig-breathe': 'character motion — steps() reads as juddering; gated on visibilitychange instead (MascotRig)',
    'rig-bounce-loop': 'character motion — see rig-breathe',
    'rig-float-loop': 'character motion — see rig-breathe',
    'rig-sleep-loop': 'character motion — see rig-breathe',
    'rig-dizzy-sway': 'character motion — see rig-breathe',
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
      const css = readStripped(join(RENDERER, 'styles', sheet));
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
    const globalsHere = readStripped(join(RENDERER, 'styles', 'globals.css'));
    expect(globalsHere).toMatch(/\.stepped-hover\s*\{[^}]*transition-timing-function:\s*steps\(/);
    expect(globalsHere).toMatch(/\.hover-lift\s*\{[^}]*steps\(/);
    expect(globalsHere).toMatch(/\.card-interactive\s*\{[^}]*steps\(/);

    const settingRow = readSource(join(RENDERER, 'components', 'ui', 'SettingRow.tsx'));
    expect(settingRow).toMatch(/ROW_BASE\s*=\s*'[^']*stepped-hover/);

    const strip = readSource(join(RENDERER, 'components', 'SessionStrip.tsx'));
    expect(strip).toMatch(/transition:\s*'opacity 150ms steps\(4\), background 150ms steps\(4\)'/);
  });

  it('transitions explicit properties on session pills, never `all`', () => {
    // `transition: all` animates every animatable property that changes,
    // layout properties included, and each one presents at the full refresh
    // rate. Only transform/border-color/background-color change on these pills.
    // Match the value, not `transition:` + value — the declaration is a
    // multi-line ternary, so an adjacency regex passes vacuously.
    const strip = readStripped(join(RENDERER, 'components', 'SessionStrip.tsx'));
    expect(strip).not.toMatch(/'all \d+ms/);
  });

  it('sweeps the model-load bar with transform, not left', () => {
    // `left` is not compositable and forces a layout pass on every presented
    // frame — the most expensive per-frame shape in the app, running for the
    // whole duration of a local model load.
    const globalsHere = readStripped(join(RENDERER, 'styles', 'globals.css'));
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
    const rig = readStripped(join(RENDERER, 'components', 'mascot', 'MascotRig.tsx'));
    expect(rig).toMatch(/visibilitychange/);
    expect(rig).toMatch(/last\s*=\s*performance\.now\(\)/);

    const mascotCss = readStripped(join(RENDERER, 'styles', 'mascot.css'));
    expect(mascotCss).toMatch(/data-doc-hidden[^{]*\{[^}]*animation-play-state:\s*paused/);
  });
});
