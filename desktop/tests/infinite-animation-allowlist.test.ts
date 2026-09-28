import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { RENDERER, readStripped, assertScopeIsPopulated, assertPatternMatches } from './helpers/guard-scope';

// INVERTED allowlist for perpetual animations (2026-09-16, simplification
// audit §7 G4). animation-frame-budget.test.ts pins the animations it KNOWS
// about — three named sheets, `components/` only, the shorthand shape only —
// and an `ease-in-out infinite` in globals.css:831/887 sat outside those
// assertions. This guard sweeps the other way: EVERY stylesheet under
// styles/, every inline `animation:` string and every Tailwind
// `animate-[…]` class under src/renderer, in both the shorthand form
// (`animation: name 2s ease infinite`) and the longhand form
// (`animation-name` + `animation-iteration-count: infinite` +
// `animation-timing-function`). Any `infinite` animation whose timing is not
// `steps(` fails unless its NAME is in SMOOTH_OK with a reason.
//
// WHY steps(): on a high-refresh panel a smoothly animating element makes
// Chromium present a frame at the full refresh rate — ~30% of a core at 180Hz
// for one pulsing dot. `steps(n)` presents n frames per cycle instead; the
// investigation and the measurements are in animation-frame-budget.test.ts.
//
// Deliberately NOT swept: src/renderer/index.html, components/mascot/
// default-mascot-paint.css, and the runtime theme CSS theme-engine.ts injects.
//
// SMOOTH_OK is a decision list, not an escape hatch. Every entry is an
// animation that is gated some OTHER way (paused when hidden, bounded by a
// load) and for which stepping is visibly worse. This guard changes no CSS;
// it makes the next smooth infinite animation a reviewed decision.
const SMOOTH_OK: Record<string, string> = {
  'comp-twinkle': 'theme companion SVG — visibility-gated with the scene',
  'comp-spin': 'theme companion SVG — 26s period, visibility-gated with the scene',
  'comp-pulse': 'theme companion SVG — visibility-gated with the scene',
  'comp-bob': 'theme companion SVG — visibility-gated with the scene',
  'mascot-comp-float': 'theme companion float — visibility-gated with the scene',
  'buddy-breathe': 'buddy window is alwaysOnTop so visibilitychange never fires, and quantized breathing is visible; accepted cost of an opt-in feature',
  'model-load-sweep': 'bounded by the model load (two sites: .model-load-track::after, .model-load-finalize::after), and disabled by Reduced Effects + prefers-reduced-motion',
  'boot-spin': 'bounded by the remote boot gate; ends when the app loads',
};

// Words that can appear in an `animation` shorthand and are NOT the name.
const SHORTHAND_KEYWORDS = new Set([
  'infinite', 'linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end',
  'alternate', 'alternate-reverse', 'normal', 'reverse', 'forwards', 'backwards', 'both', 'none',
  'paused', 'running', 'initial', 'inherit', 'unset', 'revert', 'auto',
]);

interface Finding { where: string; name: string; value: string }

/** Split on top-level commas only — `steps(4, end)` and `cubic-bezier(a,b,c,d)` carry commas. */
function splitTopLevel(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The animation-name out of one shorthand: the first token that is neither a keyword, a time, a number nor a function. */
function nameOf(single: string): string {
  // Blank out function calls (steps(…), cubic-bezier(…), var(…)) so their arguments are never read as a name.
  const flat = single.replace(/[\w-]+\([^)]*\)/g, ' ');
  for (const tok of flat.split(/\s+/)) {
    if (!tok || SHORTHAND_KEYWORDS.has(tok)) continue;
    if (/^[\d.+-]/.test(tok)) continue;       // 2s, 150ms, 3, .5s
    if (/^[a-zA-Z_-][\w-]*$/.test(tok)) return tok;
  }
  return '(unnamed)';
}

/** One declaration's value out of a block body, last occurrence wins as in CSS. */
function decl(body: string, prop: string): string | null {
  const re = new RegExp(`(?:^|[;\\s])${prop.replace(/-/g, '\\-')}\\s*:\\s*([^;]+)`, 'g');
  let last: string | null = null;
  for (const m of body.matchAll(re)) last = m[1].trim();
  return last;
}

function stepped(single: string, blockTiming: string | null): boolean {
  return /steps\(/.test(single) || (blockTiming !== null && /steps\(/.test(blockTiming));
}

/**
 * Every innermost `selector { declarations }` block. `[^{}]*` cannot cross a
 * brace, so nested `@media`/`@keyframes` wrappers are never matched as blocks
 * themselves — only their leaf rules are. Comments are stripped first because
 * the WHY prose here quotes the idioms it replaced.
 */
function sweepCss(sheet: string, css: string, out: Finding[]): void {
  const code = css.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, ' ');
  for (const m of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().split('\n').pop()!.trim();
    const body = m[2];
    const timing = decl(body, 'animation-timing-function');
    const iterations = decl(body, 'animation-iteration-count');
    const shorthand = decl(body, 'animation');
    if (shorthand) {
      for (const single of splitTopLevel(shorthand)) {
        const infinite = /\binfinite\b/.test(single) || iterations === 'infinite';
        if (infinite && !stepped(single, timing)) {
          out.push({ where: `${sheet} → ${selector}`, name: nameOf(single), value: single });
        }
      }
    } else if (iterations === 'infinite') {
      // Longhand only: animation-name + animation-iteration-count, no shorthand.
      const name = decl(body, 'animation-name') ?? '(unnamed)';
      if (!(timing !== null && /steps\(/.test(timing))) {
        out.push({ where: `${sheet} → ${selector}`, name, value: `animation-name: ${name}; animation-iteration-count: infinite` });
      }
    }
  }
}

function sweepTsx(file: string, src: string, out: Finding[]): void {
  // ANY string literal (either quote, or a template literal) that says
  // `infinite` — key-agnostic on purpose. The first cut required the quote to
  // follow `animation:` directly and missed remote-gate.tsx's
  // `animation: reduced ? 'none' : 'boot-spin 0.7s linear infinite'` (fresh-eyes
  // review, 2026-09-16). A shorthand lives in the literal, not next to the key.
  for (const m of src.matchAll(/(['"`])([^'"`\n]*\binfinite\b[^'"`\n]*)\1/g)) {
    for (const single of splitTopLevel(m[2])) {
      if (/\binfinite\b/.test(single) && !stepped(single, null)) {
        out.push({ where: file, name: nameOf(single), value: single });
      }
    }
  }
  // Tailwind arbitrary-value classes: `animate-[name_2s_ease-in-out_infinite]`.
  // `_` is a word character, so `\binfinite\b` can never match here — the
  // self-test below caught exactly that on the first run.
  for (const m of src.matchAll(/animate-\[([^\]]*)\]/g)) {
    const spec = m[1];
    if (/(^|_)infinite(_|$)/.test(spec) && !/steps\(/.test(spec)) {
      out.push({ where: file, name: spec.split('_')[0], value: spec });
    }
  }
}

function walk(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full, ext);
    return ext.test(full) && !full.includes('.test.') ? [full] : [];
  });
}

const rel = (abs: string) => abs.slice(RENDERER.length + 1).split('\\').join('/');

describe('every infinite animation is stepped, or in SMOOTH_OK with a reason', () => {
  const sheets = walk(join(RENDERER, 'styles'), /\.css$/);
  const tsxFiles = walk(RENDERER, /\.tsx$/);
  assertScopeIsPopulated(sheets, 3);
  assertScopeIsPopulated(tsxFiles, 200);

  const smooth: Finding[] = [];
  for (const f of sheets) sweepCss(rel(f), readFileSync(f, 'utf8'), smooth);
  for (const f of tsxFiles) sweepTsx(rel(f), readStripped(f), smooth);

  it('parses the shapes it claims to (non-vacuity)', () => {
    // Shorthand, stepped — must NOT be reported.
    const a: Finding[] = [];
    sweepCss('t.css', '.x { animation: voice-pulse 1.4s steps(10) infinite; }', a);
    expect(a).toEqual([]);
    // Shorthand, smooth — must be reported under its NAME, not its easing.
    sweepCss('t.css', '.x { animation: sweep 1.1s ease-in-out infinite; }', a);
    expect(a.map((f) => f.name)).toEqual(['sweep']);
    // Separate timing-function rescues a smooth shorthand.
    const b: Finding[] = [];
    sweepCss('t.css', '.x { animation: pulse 2s infinite; animation-timing-function: steps(8); }', b);
    expect(b).toEqual([]);
    // Longhand shape.
    const c: Finding[] = [];
    sweepCss('t.css', '.x { animation-name: glow; animation-iteration-count: infinite; animation-timing-function: ease; }', c);
    expect(c.map((f) => f.name)).toEqual(['glow']);
    // Nested in @media, and a comma list with a function containing commas.
    const d: Finding[] = [];
    sweepCss('t.css', '@media (x) { .y { animation: a 1s steps(4, end) infinite, b 2s cubic-bezier(0.1,0.2,0.3,1) infinite; } }', d);
    expect(d.map((f) => f.name)).toEqual(['b']);
    // Inline TSX, both shapes.
    const e: Finding[] = [];
    sweepTsx('t.tsx', "style={{ animation: 'breathe 2s ease infinite' }} className=\"animate-[glow_2s_ease_infinite]\"", e);
    expect(e.map((f) => f.name)).toEqual(['breathe', 'glow']);
    // The literal need not follow `animation:` — a ternary hides it behind another string.
    const g: Finding[] = [];
    sweepTsx('t.tsx', "animation: reduced ? 'none' : 'boot-spin 0.7s linear infinite',", g);
    expect(g.map((f) => f.name)).toEqual(['boot-spin']);
    assertPatternMatches(/\binfinite\b/, 'rig-breathe 4s ease-in-out infinite', 'an infinite shorthand');
  });

  it('finds the known smooth set in the real tree (non-vacuity)', () => {
    // The companion loops and model-load sweep are smooth on purpose; if the
    // sweep stops seeing them it is blind, not clean. (The rig body loops left
    // CSS on 2026-09-26 — MascotRig draws them at 30 fps, rig-body-loop.ts.)
    const names = new Set(smooth.map((f) => f.name));
    expect(names.has('comp-twinkle')).toBe(true);
    expect(names.has('model-load-sweep')).toBe(true);
  });

  it('reports no smooth infinite animation outside SMOOTH_OK', () => {
    const offenders = smooth.filter((f) => !(f.name in SMOOTH_OK)).map((f) => `${f.where}: ${f.value}`);
    expect(
      offenders,
      `Infinite animations without steps() timing that are not in SMOOTH_OK (tests/infinite-animation-allowlist.test.ts):\n  ${offenders.join('\n  ')}\n` +
        `Quantize it (steps(n), or a separate animation-timing-function: steps(n)), make it finite, ` +
        `or add its NAME to SMOOTH_OK with the reason it may present a frame at every refresh while it runs.`,
    ).toEqual([]);
  });

  it('keeps SMOOTH_OK an inventory — every entry still names a smooth infinite animation in the tree', () => {
    const present = new Set(smooth.map((f) => f.name));
    const stale = Object.keys(SMOOTH_OK).filter((n) => !present.has(n));
    expect(stale, `SMOOTH_OK entries with no smooth infinite animation left to excuse — delete them:\n  ${stale.join('\n  ')}`).toEqual([]);
    for (const [name, reason] of Object.entries(SMOOTH_OK)) {
      expect(reason.length, `${name} is in SMOOTH_OK with no reason`).toBeGreaterThan(10);
    }
  });
});
