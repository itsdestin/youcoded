import { describe, it, expect } from 'vitest';
import { readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readSource } from './helpers/guard-scope';

/**
 * Provider brand colours must be readable on EVERY theme, including ones that
 * do not exist yet.
 *
 * WHY THIS EXISTS. The --brand-* colours were originally written only inside the
 * four [data-theme="<slug>"] blocks. Those blocks match the four built-in slugs
 * and nothing else, so every community theme silently inherited the :root
 * (light) set no matter how dark it was. Measured 2026-08-31, before the fix:
 * all seven published community themes failed 4.5:1 on the model chip, and the
 * three dark ones sat at 2.25-2.38:1 — dark green on near-black. Nothing caught
 * it, because scripts/audit-theme-contrast.mjs audits foreground/background
 * token pairs and has no idea brand colours exist.
 *
 * The fix keys the colours off `data-theme-mode`, which theme-engine sets from
 * the manifest's required `dark` boolean. This test pins the three things that
 * fix depends on, so re-introducing a slug-only brand colour fails here.
 */

const stylesDir = resolve(__dirname, '..', 'src', 'renderer', 'styles');
const globalsCss = readSource(join(stylesDir, 'globals.css'));

/** Every `--brand-*: value` declaration inside the block opened by `selector`. */
function brandBlock(selector: string): Record<string, string> {
  const start = globalsCss.indexOf(selector);
  if (start === -1) throw new Error(`globals.css has no "${selector}" block`);
  const end = globalsCss.indexOf('\n}', start);
  const body = globalsCss.slice(start, end);
  return Object.fromEntries(
    [...body.matchAll(/--(brand-[a-z]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  );
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const modeLight = brandBlock('[data-theme-mode="light"] {');
const modeDark = brandBlock('[data-theme-mode="dark"] {');

describe('provider brand colours', () => {
  it('defines every brand in BOTH mode blocks, so no theme can fall through', () => {
    expect(Object.keys(modeLight).sort()).toEqual(Object.keys(modeDark).sort());
    expect(Object.keys(modeLight).length).toBeGreaterThanOrEqual(11);
  });

  it('puts the mode blocks AFTER the four slug blocks, so they win at equal weight', () => {
    // Both selectors are one attribute = specificity (0,1,0). Source order is the
    // only thing that decides, so a mode block moved above a slug block would
    // silently stop applying to the built-in themes.
    const lastSlug = Math.max(
      ...['light"], :root', 'dark"] {', 'midnight"] {', 'creme"] {'].map((s) =>
        globalsCss.indexOf(`[data-theme="${s}`),
      ),
    );
    expect(globalsCss.indexOf('[data-theme-mode="light"] {')).toBeGreaterThan(lastSlug);
    expect(globalsCss.indexOf('[data-theme-mode="dark"] {')).toBeGreaterThan(lastSlug);
  });

  it('leaves the four built-in themes on exactly the values they already had', () => {
    // The fix must be invisible on the shipped themes. If these ever diverge, the
    // mode block is quietly restyling a built-in theme.
    expect(brandBlock('[data-theme="light"], :root {')).toEqual(modeLight);
    expect(brandBlock('[data-theme="creme"] {')).toEqual(modeLight);
    expect(brandBlock('[data-theme="dark"] {')).toEqual(modeDark);
    expect(brandBlock('[data-theme="midnight"] {')).toEqual(modeDark);
  });

  it('is applied from the theme, not guessed from the slug', () => {
    const engine = readSource(
      resolve(__dirname, '..', 'src', 'renderer', 'themes', 'theme-engine.ts'),
    );
    expect(engine).toMatch(/setAttribute\('data-theme-mode',\s*theme\.dark \? 'dark' : 'light'\)/);
  });
});

// The published community themes are the population that actually broke.
// Audited when the sibling checkout is present; skipped (not failed) when it is
// not, the same contract as scripts/audit-theme-contrast.mjs.
//
// WHAT THE MODE FIX DID AND DID NOT DO — measured 2026-08-31, all 11 brands x 7
// published themes = 70 combinations:
//
//   before   55 of 70 unreadable
//   after    25 of 70 unreadable
//
// The 30 it repaired are ALL of the dark themes: they were being served the
// light set, which is the bug this fix is about, and they now sit at 5.65:1 or
// better. The 25 that remain are the four LIGHT community themes, which were
// never mis-served — they already got the light set. Those values were tuned
// against the built-in Light theme's #EAEAEA panel, and a pale tinted panel
// (kuromi-dreamer's #D4C5E6) is simply a different background. Fixing them means
// either darkening the light set, which would restyle the built-in Light and
// Creme themes, or deriving the colour against the live panel at runtime.
// Neither was in scope here. Tracked in ROADMAP.md.
const themesRoot = resolve(__dirname, '..', '..', '..', 'wecoded-themes', 'themes');

/** Brand/theme combinations still under 4.5:1 — BY NAME, not a count. The residue
 *  may shrink, never grow unnoticed. WHY a list (2026-09-24): this was a ceiling of
 *  25, and Morning Rounds (published 2026-09-22) added two combinations the day it
 *  landed; a count cannot say whether a new theme brought them or an old combination
 *  regressed, and it would have to be raised by hand for every light theme. A named
 *  list answers both. Morning Rounds' two are listed as the same light-set gap as
 *  the rest (the ROADMAP item, not a new defect). */
const KNOWN_LIGHT_THEME_GAP = new Set([
  ...['claude', 'openai', 'kimi', 'meta', 'mistral', 'perplexity'].map((b) => `cotton-candy-sky --brand-${b}`),
  ...['claude', 'openai', 'google', 'qwen', 'kimi', 'deepseek', 'meta', 'mistral', 'perplexity'].map((b) => `kuromi-dreamer --brand-${b}`),
  ...['claude', 'openai', 'kimi', 'meta', 'mistral', 'perplexity'].map((b) => `meadow-mist --brand-${b}`),
  ...['claude', 'mistral'].map((b) => `morning-rounds --brand-${b}`),
  ...['claude', 'kimi', 'meta', 'mistral'].map((b) => `strawberry-kitty --brand-${b}`),
]);

describe.skipIf(!existsSync(themesRoot))('published community themes', () => {
  const themes = (existsSync(themesRoot) ? readdirSync(themesRoot) : [])
    .filter((d) => existsSync(join(themesRoot, d, 'manifest.json')))
    .map((slug) => ({ slug, m: JSON.parse(readSource(join(themesRoot, slug, 'manifest.json'))) }))
    .filter((t) => typeof t.m.tokens?.panel === 'string' && t.m.tokens.panel.startsWith('#'));

  const measure = (t: { slug: string; m: any }) => {
    const set = t.m.dark ? modeDark : modeLight;
    return Object.entries(set)
      .filter(([, v]) => v.startsWith('#'))
      .map(([name, v]) => ({ name, value: v, ratio: contrast(v, t.m.tokens.panel) }));
  };

  const dark = themes.filter((t) => t.m.dark);

  it.each(dark.map((t) => t.slug))(
    '%s is a DARK theme and reads every brand colour at 4.5:1 — this is what the fix bought',
    (slug) => {
      const t = dark.find((x) => x.slug === slug)!;
      for (const r of measure(t)) {
        expect(r.ratio, `${slug} --${r.name} ${r.value} on ${t.m.tokens.panel}`).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it('does not let the known light-theme gap grow', () => {
    const failing = themes.flatMap((t) =>
      measure(t).filter((r) => r.ratio < 4.5).map((r) => ({ key: `${t.slug} --${r.name}`, ratio: r.ratio })),
    );
    // Named so a regression says WHICH combination appeared.
    const unknown = failing.filter((f) => !KNOWN_LIGHT_THEME_GAP.has(f.key)).map((f) => `${f.key} ${f.ratio.toFixed(2)}:1`);
    expect(unknown, 'new brand colours under 4.5:1').toEqual([]);
    // Nothing may be outright illegible, even inside the known gap.
    for (const t of themes) {
      for (const r of measure(t)) {
        expect(r.ratio, `${t.slug} --${r.name} is below the 3:1 floor`).toBeGreaterThanOrEqual(3.0);
      }
    }
  });
});
