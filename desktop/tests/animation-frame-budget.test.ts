import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { RENDERER, readSource } from './helpers/guard-scope';

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
// Investigation: youcoded-dev/docs/archive/investigations/2026-07-30-idle-cpu-burn.md
//
// Plan B (2026-09-16): this file's first block moved to
// tests/animation-css-budget.test.ts, and every COMPONENT-side (.tsx/.ts) pin
// of the two blocks below is an ast-grep rule now (scripts/ast-grep/rules/):
// the SessionStrip drag/hover/label mechanics are the session-strip-* rules
// (see .claude/rules/session-strip-motion.md for which guards what), plus
// index-no-arrival-scaffold, chatview-arrival-only-on-incoming,
// pill-label-reveals-with-motion-tokens and voice-button-level-ring-stepped.
// What stays here reads STYLESHEETS (CSS is not an ast-grep language in this
// workspace's rule set), plus one cross-file comparison a rule cannot make.
//
// WHY this reader: the pins were written against a read that normalised line
// endings (a Windows checkout failed every literal-`\n` regex, youcoded#404 CI,
// 2026-09-03) and DELETED block comments only — not readStripped, which also
// blanks `//`.
const read = (...p: string[]) => readSource(join(RENDERER, ...p)).replace(/\/\*[\s\S]*?\*\//g, '');

// Perpetual-animation and reduced-motion guards on the stylesheet. Exact curves,
// durations and token values are judged by screenshot review, not pinned here.
describe('motion budget', () => {
  const globals = read('styles', 'globals.css');

  it('defines the arrival animation with a finite iteration count', () => {
    // Perpetual animation is the thing this file exists to prevent. One run.
    expect(globals).toMatch(/\.switch-arrival\s*\{[^}]*animation:[^;]*switch-arrival/);
    expect(globals).not.toMatch(/\.switch-arrival\s*\{[^}]*infinite/);
    expect(globals).not.toMatch(/session-pill--veiled[^}]*animation/);
  });

  it('gates the arrival animation on reduced motion AND Reduce visual effects', () => {
    expect(globals).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^}]*\.switch-arrival[^}]*\}/);
    expect(globals).toMatch(/\[data-reduced-effects\] \.switch-arrival/);
    // The veil is a plain class, not an animation — nothing to gate.
  });

});

describe('the microphone budgets every frame it presents', () => {
  // Guard for whole-branch review F3. The mic is the app's only element that
  // animates for MINUTES at a time under the user's direct attention, so it is
  // the worst possible place to lose this. The comment in globals.css claimed
  // this file pinned it and this file said nothing about voice at all.
  // VoiceButton's inline level ring (stepped, whole-pixel) is ast-grep:
  // voice-button-level-ring-stepped.
  const globals = read('styles', 'globals.css');

  it('steps the breathing ring rather than smoothing it', () => {
    expect(globals).toMatch(/\.voice-mic-on\s*\{[^}]*steps\(/);
  });

  it('steps the recording dot', () => {
    expect(globals).toMatch(/\.voice-rec-dot\s*\{[^}]*steps\(/);
  });

  it('steps the loudness bars, which move for the whole dictation', () => {
    // `linear` here is a frame every refresh for as long as the mic is open:
    // the height transition retriggers on every level event, ten a second.
    expect(globals).toMatch(/\.voice-bar\s*\{\s*transition:\s*height\s+\d+ms\s+steps\(/);
    expect(globals).not.toMatch(/\.voice-bar\s*\{\s*transition:[^}]*linear/);
  });

});
