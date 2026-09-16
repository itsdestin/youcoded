// warning-color-readable.test.ts — contract R30: "closed, the warning is one
// amber line, and it still reads as a warning against the theme".
//
// WHY THIS EXISTS. Warnings were drawn in ONE fixed amber. A fresh grader
// running the real app measured that amber at 9.5:1 on Halftone Dimension —
// crisp — and at 1.05:1 on Meadow Mist, where it sat on that theme's pale-green
// card at practically the same brightness as the card. Two of the four BUILT-IN
// themes were just as bad (Light 1.16:1, Creme 1.05:1) and nobody had noticed,
// because the only theme anyone reviews warnings on is a dark one.
//
// Themes are user-installable, so this cannot be fixed by picking a colour for
// Meadow Mist. The guard below is therefore written against SURFACES, not theme
// names: every bundled theme plus the two the grader used plus deliberately
// hostile invented ones, all of which must come out readable.
import { describe, it, expect } from 'vitest';
import { computeOverlayTokens, WARNING_BASE } from '../src/renderer/themes/theme-engine';
import type { ThemeTokens } from '../src/renderer/themes/theme-types';

const parse = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = (hex: string) => {
  const [r, g, b] = parse(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
  return (hi + 0.05) / (lo + 0.05);
};
const mix = (a: string, b: string, t: number) => {
  const [ar, ag, ab] = parse(a); const [br, bg, bb] = parse(b);
  return '#' + [ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t]
    .map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
};

// Everything else in ThemeTokens is irrelevant to this derivation; only the
// three surfaces a warning is ever painted on are.
const BASE_TOKENS = {
  canvas: '#0D1117', panel: '#161B22', inset: '#21262D', well: '#0D1117',
  fg: '#E6EDF3', 'fg-2': '#C9D1D9', 'fg-dim': '#8B949E', 'fg-muted': '#6E7681', 'fg-faint': '#484F58',
  accent: '#58A6FF', 'on-accent': '#0D1117', edge: '#30363D', 'edge-dim': '#21262D',
} as unknown as ThemeTokens;

const surfaces = (canvas: string, panel: string, inset: string) =>
  [canvas, panel, inset, mix(inset, panel, 0.5)];

const warningFor = (canvas: string, panel: string, inset: string) =>
  computeOverlayTokens({ ...BASE_TOKENS, canvas, panel, inset }, undefined, undefined, false)['--warning-fg'];

// The four built-in themes and the one bundled community pack, read from their
// own manifests' tokens, plus the two Destin's grader installed from the real
// marketplace (surfaces sampled from the grader's screenshots).
const THEMES: Record<string, [string, string, string]> = {
  midnight:            ['#0D1117', '#161B22', '#21262D'],
  dark:                ['#111111', '#191919', '#222222'],
  light:               ['#F2F2F2', '#EAEAEA', '#D7D7D7'],
  creme:               ['#F6EEE1', '#EBE1D1', '#D8CCB9'],
  'golden-sunbreak':   ['#08080e', '#140e1a', '#1c1428'],
  'halftone-dimension':['#08060e', '#100e1c', '#251432'],
  'meadow-mist':       ['#DCE8D8', '#CFE0C9', '#BAD0B6'],
  // Not real themes — the shape of a theme nobody has written yet. A pack this
  // pale or this washed-out is exactly what the fixed amber died on.
  'invented: near-white':  ['#FFFFFF', '#FAFAFA', '#F4F4F4'],
  'invented: amber-ish':   ['#FFF8E1', '#FFECB3', '#FFE082'],
};

describe('the warning amber is readable on every theme', () => {
  for (const [name, [canvas, panel, inset]] of Object.entries(THEMES)) {
    it(`${name} — clears AA on canvas, panel, the card, and the card over the panel`, () => {
      const fg = warningFor(canvas, panel, inset);
      for (const s of surfaces(canvas, panel, inset)) {
        expect(ratio(fg, s), `${name}: ${fg} on ${s}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('the dark themes keep the exact amber they already had', () => {
    // The point of the derivation is that it is a NO-OP where the amber already
    // works. If this ever fails, every dark theme's warnings just changed colour.
    for (const name of ['midnight', 'dark', 'golden-sunbreak', 'halftone-dimension']) {
      expect(warningFor(...THEMES[name]), name).toBe(WARNING_BASE);
    }
  });

  it('the pale themes get a darker amber, not a different hue', () => {
    // "Same amber, dimmed" — mixing toward black scales all three channels by
    // the same factor, so the hue is untouched and it still reads amber rather
    // than turning into some other colour.
    const hue = (hex: string) => {
      const [r, g, b] = parse(hex).map((v) => v / 255);
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      if (d === 0) return 0;
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    for (const name of ['light', 'creme', 'meadow-mist']) {
      const fg = warningFor(...THEMES[name]);
      expect(fg, `${name} must not be left at the unreadable base`).not.toBe(WARNING_BASE);
      expect(lum(fg), `${name} must be darker than the base`).toBeLessThan(lum(WARNING_BASE));
      expect(Math.abs(hue(fg) - hue(WARNING_BASE)), `${name} hue drift`).toBeLessThan(3);
    }
  });

  it('the fixed amber this replaces really was unreadable — the guard is measuring something', () => {
    // A guard that would pass against the OLD code proves nothing. These are the
    // grader's own measurements, reproduced from the surfaces alone.
    expect(ratio(WARNING_BASE, '#BAD0B6')).toBeLessThan(1.5);   // Meadow Mist's card
    expect(ratio(WARNING_BASE, '#D8CCB9')).toBeLessThan(1.5);   // Creme's, a BUILT-IN theme
    expect(ratio(WARNING_BASE, '#251432')).toBeGreaterThan(8);  // Halftone's, which was fine
  });
});
