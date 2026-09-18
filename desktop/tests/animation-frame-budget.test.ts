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

// The motion vocabulary (2026-08-31 spec §3). Source-text assertions on the
// stylesheet: nothing breaks visually when a token drifts back to a
// hand-written curve, the app just quietly grows a sixth bespoke easing again.
describe('motion vocabulary', () => {
  const globals = read('styles', 'globals.css');

  it('defines three curves, none of which overshoots', () => {
    // The first cut put a spring curve on the pill; Destin's verdict was "much
    // too bouncy/aggressive". Every --ease-* control point sits inside [0, 1],
    // which is what "never overshoots" means for a cubic-bezier. (The switch
    // ARRIVAL may overshoot — it is on the transform of one element — and its
    // curve is deliberately not an --ease-* token: see @keyframes switch-arrival.)
    expect(globals).toMatch(/--ease-reveal:\s*cubic-bezier\(0\.25,\s*0\.1,\s*0\.25,\s*1\)/);
    expect(globals).toMatch(/--ease-out:\s*cubic-bezier\(0\.16,\s*1,\s*0\.3,\s*1\)/);
    expect(globals).toMatch(/--ease-settle:/);
    expect(globals).not.toMatch(/--ease-bounce/);
    for (const m of globals.matchAll(/--ease-[a-z]+:\s*cubic-bezier\(([^)]+)\)/g)) {
      for (const n of m[1].split(',').map(Number)) expect(n).toBeLessThanOrEqual(1);
    }
  });

  it('defines three durations — Soft, with the Spring arrival\'s length', () => {
    expect(globals).toMatch(/--dur-hover:\s*180ms/);
    expect(globals).toMatch(/--dur-reveal:\s*260ms/);
    expect(globals).toMatch(/--dur-switch:\s*380ms/);
  });

  it('never draws a dot touching the pill in hand — veiled by proximity, moved while hidden', () => {
    // Destin, 2026-09-02, after a slide and then a blink: "the dragged session
    // kept visibly overlapping dots before they appeared to begin to move. it
    // would be fine if they teleport or fade in/fade out as long as they dont
    // visually touch the dragged pill." Geometric, not timed. The component
    // half is ast-grep: session-strip-dot-flows-never-touches and
    // pill-label-reveals-with-motion-tokens.
    // Hidden at once, no fade out; the class beats the inline transition list.
    expect(globals).toMatch(/\.session-pill--veiled \{ opacity: 0 !important; transition-duration: 0s !important; \}/);
    expect(globals).not.toMatch(/pill-hop|data-yield/);
  });

  it('puts them in the theme-independent :root block', () => {
    // They must NOT live in any `[data-theme=...]` palette block — a community
    // theme that redefines only colours would otherwise drop the app's motion.
    //
    // WHY sliced this way: an earlier draft of this test cut the file at
    // Tailwind's `@theme` and asserted the tokens were not above it. EVERY
    // palette block is above it, so that assertion was true no matter where
    // the tokens landed. Assert the real shape instead: present in a bare
    // `:root`, absent from every themed block.
    expect(globals).toMatch(/(^|\n):root \{[^}]*--ease-out/);
    for (const block of globals.split(/\[data-theme=/).slice(1)) {
      expect(block.slice(0, block.indexOf('}'))).not.toMatch(/--ease-out|--dur-hover/);
    }
  });

  it('keeps the rest of :root intact beside the tokens', () => {
    // 2026-09-01: the review presets had been pasted INSIDE :root, so
    // `[data-motion="crisp"]` swallowed --bottom-chrome-total and the drawer
    // width for every page that was not under review. The tokens and these
    // two app-wide variables must share one :root block.
    const root = globals.match(/(^|\n):root \{[^}]*\}/)?.[0] ?? '';
    expect(root).toMatch(/--dur-switch/);
    expect(root).toMatch(/--bottom-chrome-total:/);
    expect(root).toMatch(/--frame-edge:/);
  });

  it('has no review scaffolds left — only the picked values remain', () => {
    // The speed presets ([data-motion]), the select-on modes ([data-select]),
    // the arrival alternatives ([data-arrival], plus the `?arrival=` param in
    // index.tsx) and the yield scaffold ([data-yield]) were each picked and
    // deleted; the winners are the plain values. Spring is the arrival: 14px
    // lift on an overshooting curve.
    expect(globals).not.toMatch(/data-yield|--pill-yield/);
    expect(globals).not.toMatch(/data-motion|data-arrival|--switch-lift|--switch-ease/);
    // index.tsx's `?arrival=` param and SessionStrip's select-on scaffold are
    // ast-grep: index-no-arrival-scaffold, session-strip-no-select-on-scaffold.
    expect(globals).toMatch(/@keyframes switch-arrival \{[^}]*translateY\(14px\)/);
    expect(globals).toMatch(/\.switch-arrival \{\s*animation: switch-arrival var\(--dur-switch\) cubic-bezier\(0\.34, 1\.56, 0\.64, 1\) 1;/);
  });

  it('defines the arrival animation with a finite iteration count', () => {
    // Perpetual animation is the thing this file exists to prevent. One run.
    expect(globals).toMatch(/\.switch-arrival\s*\{[^}]*animation:[^;]*switch-arrival/);
    expect(globals).not.toMatch(/\.switch-arrival\s*\{[^}]*infinite/);
    expect(globals).not.toMatch(/session-pill--veiled[^}]*animation/);
  });

  it('gates the arrival animation on reduced motion AND Reduce Visual Effects', () => {
    expect(globals).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^}]*\.switch-arrival[^}]*\}/);
    expect(globals).toMatch(/\[data-reduced-effects\] \.switch-arrival/);
    // The veil is a plain class, not an animation — nothing to gate.
  });

  it('puts nothing but the dot and the name on a pill — the runtime lives in the menu', () => {
    // Until 2026-09-02 a native pill carried a "YouCoded · Coder" badge that
    // opened after the name on every switch — a second motion to wait for, and
    // ~96px the strip had no room for. Destin: "eliminate the 'youcoded -
    // coder' tags in session names entirely. they still cause a bit of visual
    // jank." Runtime and model now sit under the name in the All Sessions
    // menu, with the brand mark the status bar's model chip uses.
    // SessionStrip's half (no badge, runtime in the menu, the packer budgets the
    // label box) is ast-grep: session-strip-pill-is-dot-and-name.
    expect(globals).not.toMatch(/session-pill__badge|badge-in/);
  });

  it('lays the name out once and fades what does not fit', () => {
    // The label box clips; the name inside is max-content so it never
    // re-ellipsises mid-animation ("theme …", "theme cont…", "theme contra…").
    // The 12px tail is LABEL_TAIL_PX: the mask stop, the name's padding and the
    // module constant must agree or the fade lands on the last letter.
    // SessionStrip's half is ast-grep: session-strip-name-laid-out-once.
    // WHY still a text read: the tail width is READ from pill-label-style.ts at
    // run time and then looked for in globals.css — a cross-file comparison no
    // single-file ast-grep rule can make.
    const label = read('components/header', 'pill-label-style.ts');
    const tail = Number(label.match(/LABEL_TAIL_PX = (\d+)/)?.[1]);
    expect(tail).toBeGreaterThan(0);
    expect(globals).toMatch(new RegExp(`\\.session-pill__label\\s*\\{[^}]*calc\\(100% - ${tail}px\\)`));
    expect(globals).toMatch(new RegExp(`\\.session-pill__name\\s*\\{[^}]*width: max-content;[^}]*padding-right: ${tail}px`));
  });

  it('declares isBeingDragged exactly twice in SessionStrip', () => {
    // The shape (each declaration reads `dragId === s.id && dragActive`) is
    // guarded by ast-grep: session-strip-drag-visuals-are-state (re-review of
    // Task 6 batch A, 2026-09-16).
    // WHY still a text read: that rule can require the shape to be RIGHT
    // wherever it exists, but not COUNT how many times it exists — a stray
    // third copy (or a dropped one, collapsing the row pill and the menu row
    // back onto one derivation) would still pass a presence/shape check. Two:
    // one for the row pill, one for the All Sessions menu row.
    const strip = read('components', 'SessionStrip.tsx');
    expect(strip.match(/const isBeingDragged = dragId === s\.id && dragActive;/g)?.length).toBe(2);
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
