import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readSource } from './helpers/guard-scope';

/**
 * Built-in theme colors exist in two places and MUST agree:
 *
 *   1. src/renderer/themes/builtin/<slug>.json  — the source of truth. The theme
 *      engine applies these at runtime, so these are the values users actually see.
 *   2. styles/globals.css [data-theme="<slug>"] — anti-FOUC only. Applied before
 *      React mounts so the first paint isn't unstyled; overwritten moments later
 *      by the engine.
 *
 * They drifted before, and it shipped: creme's fg-muted (#9E9283, 2.47:1) and
 * fg-faint (#BEB3A4, 1.67:1) were corrected in globals.css but not in the JSON.
 * Because the JSON is what renders, users kept seeing the failing values while
 * the CSS and the contrast audit both claimed they were fixed.
 *
 * A third copy used to live in scripts/audit-theme-contrast.mjs; it now reads the
 * JSON directly, so this test only has two sources left to reconcile.
 */

const builtinDir = resolve(__dirname, '..', 'src', 'renderer', 'themes', 'builtin');
const globalsCss = readSource(
  resolve(__dirname, '..', 'src', 'renderer', 'styles', 'globals.css'),
);

/** Pulls the CSS custom properties out of the `[data-theme="<slug>"]` block. */
function parseThemeBlock(slug: string): Record<string, string> {
  const re = new RegExp(`\\[data-theme="${slug}"\\][^{]*\\{([^}]*)\\}`);
  const match = globalsCss.match(re);
  if (!match) throw new Error(`globals.css has no [data-theme="${slug}"] block`);

  const vars: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const decl = line.match(/^\s*(--[\w-]+)\s*:\s*([^;]+);/);
    if (decl) vars[decl[1]] = decl[2].trim();
  }
  return vars;
}

function loadBuiltins() {
  return readdirSync(builtinDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readSource(join(builtinDir, f))));
}

describe('built-in theme sources agree', () => {
  const builtins = loadBuiltins();

  it('finds the four built-in themes', () => {
    expect(builtins.map((t) => t.slug).sort()).toEqual(['creme', 'dark', 'light', 'midnight']);
  });

  for (const theme of loadBuiltins()) {
    describe(theme.slug, () => {
      const cssVars = parseThemeBlock(theme.slug);

      for (const [token, value] of Object.entries(theme.tokens as Record<string, string>)) {
        it(`--${token} matches globals.css`, () => {
          // Hex is case-insensitive in CSS, so compare case-folded — we care
          // about the color drifting, not the letter casing.
          expect(cssVars[`--${token}`]?.toLowerCase()).toBe(value.toLowerCase());
        });
      }
    });
  }
});

describe('creme legibility fix stays fixed', () => {
  // The exact values that shipped broken — a straight revert must stay caught.
  it('does not reintroduce the failing fg-muted / fg-faint', () => {
    const creme = loadBuiltins().find((t) => t.slug === 'creme')!;
    expect(creme.tokens['fg-muted']).not.toBe('#9E9283');
    expect(creme.tokens['fg-faint']).not.toBe('#BEB3A4');
  });
});

/**
 * Every built-in must satisfy the shared contrast rules.
 *
 * This replaced a pair of exact-hex pins (creme's fg-muted === '#8A7E6E',
 * fg-faint === '#B0A595'). Those were a PROXY for the real invariant, which the
 * old test stated in its own comment: "fg-muted needs >= 3:1, fg-faint >= 1.8:1".
 * Pinning the hex meant any legitimate repalette failed the test while an
 * illegitimate one that happened to keep those two values passed — and it did
 * fail, on the 2026-07-19 contrast solve. Asserting the property instead is both
 * stricter (every text tier against every surface, not two tokens against canvas)
 * and stable across future palette work.
 *
 * Rules come from scripts/vendor/contrast-rules.js, vendored from the
 * theme-builder skill. Do not edit that copy by hand — see its header.
 */
describe('built-in themes satisfy the contrast rules', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rules = require('../scripts/vendor/contrast-rules.js');

  for (const theme of loadBuiltins()) {
    describe(theme.slug, () => {
      // Built-ins are opaque (no wallpaper), so flat tokens ARE what gets
      // painted. Community themes composite over their wallpaper — that case is
      // covered by wecoded-themes/scripts/audit-contrast.mjs.
      const result = rules.evaluate(theme.tokens, {});

      it('has no HARD failures', () => {
        const fails = result.results.HARD.filter((r: { status: string }) => r.status === 'FAIL');
        expect(fails.map((f: { rule: string; actual: string }) => `${f.rule} (${f.actual})`)).toEqual([]);
      });

      it('has no SURFACE failures', () => {
        const fails = result.results.SURFACE.filter((r: { status: string }) => r.status === 'FAIL');
        expect(fails.map((f: { rule: string; actual: string }) => `${f.rule} (${f.actual})`)).toEqual([]);
      });
    });
  }
});

describe('built-ins declare their own link colors', () => {
  // link/link-hover are optional pack tokens the engine derives when absent.
  // The four built-ins have hand-picked values that must NOT fall back to
  // derivation, or their links would visibly change color.
  it('every built-in sets link and link-hover', () => {
    for (const theme of loadBuiltins()) {
      expect(theme.tokens.link, `${theme.slug} link`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(theme.tokens['link-hover'], `${theme.slug} link-hover`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});

describe('built-in text ladder (P-11, 2026-08-25 UI audit)', () => {
  // fg-muted is the smallest text people are meant to READ (status bar, hints,
  // timestamps) and it sits on raised surfaces, so it must clear AA there; the
  // audit found every built-in at 3.0–3.3:1 on inset. fg-faint stays at ~2:1 on
  // purpose — it is decorative-only (dividers, disabled glyphs), never words.
  // The ladder order pins that the bump did not fold two steps into one.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rules = require('../scripts/vendor/contrast-rules.js');
  const ratio = (a: string, b: string) =>
    rules.contrastRatio(rules.luminance(rules.parseHex(a)), rules.luminance(rules.parseHex(b)));

  for (const theme of loadBuiltins()) {
    it(`${theme.slug}: fg-muted ≥ 4.5:1 on inset and well, ladder stays ordered`, () => {
      const t = theme.tokens;
      expect(ratio(t['fg-muted'], t.inset)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t['fg-muted'], t.well)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t['fg-dim'], t.inset)).toBeGreaterThan(ratio(t['fg-muted'], t.inset) + 0.5);
      expect(ratio(t['fg-2'], t.inset)).toBeGreaterThan(ratio(t['fg-dim'], t.inset) + 0.5);
      expect(ratio(t['fg-faint'], t.inset)).toBeLessThan(3);
    });
  }
});
