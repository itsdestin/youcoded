import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readSource } from './helpers/guard-scope';

/**
 * Built-in theme JSON (src/renderer/themes/builtin/<slug>.json) is what the theme engine
 * applies at runtime. Whether it matches the anti-FOUC copy in globals.css is a look
 * question, judged by screenshot review, so it is not asserted here; the checks below are
 * the legibility properties (contrast, link colours, text ladder).
 */

const builtinDir = resolve(__dirname, '..', 'src', 'renderer', 'themes', 'builtin');

function loadBuiltins() {
  return readdirSync(builtinDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readSource(join(builtinDir, f))));
}

describe('built-in theme sources', () => {
  const builtins = loadBuiltins();

  it('finds the six built-in themes', () => {
    expect(builtins.map((t) => t.slug).sort()).toEqual(['creme', 'dark', 'light', 'midnight', 'youcoded', 'youcoded-night']);
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

describe('built-in text ladder', () => {
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

describe('Minimalist layout control outline', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rules = require('../scripts/vendor/contrast-rules.js');
  const outline = (tokens: Record<string, string>) =>
    rules.evaluate(tokens, {}).results.SOFT.find((r: { rule: string }) => r.rule === 'float control outline vs canvas');

  // Any theme can be shown in the Minimalist layout (the user's Look setting), so the
  // check must run for every built-in, not only packs that ship chrome-style "float".
  for (const theme of loadBuiltins()) {
    it(`${theme.slug}: floating buttons stay visible on its flat background`, () => {
      expect(outline(theme.tokens)?.status).toBe('PASS');
    });
  }

  it('warns when a floating button would vanish into the background', () => {
    const invisible = { ...loadBuiltins()[0].tokens };
    invisible.edge = invisible.canvas;
    invisible.inset = invisible.canvas;
    expect(outline(invisible)?.status).toBe('FAIL');
  });
});
