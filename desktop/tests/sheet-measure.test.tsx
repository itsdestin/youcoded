// @vitest-environment jsdom
// Column widths are measured in the page's real font, from the widest-looking few texts, and measured again when the
// font or theme changes.
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { act } from 'react';

// A fake canvas: i is 3 px wide, everything else 10 px, scaled by `scale` (the "font").
let scale = 1;
HTMLCanvasElement.prototype.getContext = (() => ({
  font: '',
  measureText: (s: string) => ({ width: [...s].reduce((w, ch) => w + (ch === 'i' ? 3 : 10), 0) * scale }),
})) as any;

describe('measuring column widths', () => {
  it('takes the widest MEASURED of the top candidates, not just the heaviest by character count', async () => {
    const { ColumnFitter } = await import('../src/renderer/components/artifact-views/sheet-measure');
    const f = new ColumnFitter(1);
    // by character weight 'iiiiiiiiiiiiiiiiiiii' (20 narrow) outranks 'abcdefgh' (8) — measured, the latter is wider
    f.observe(0, 'iiiiiiiiiiiiiiiiiiii', false);
    f.observe(0, 'abcdefgh', false);
    expect(f.width(0, 0)).toBe(Math.ceil(80 * 1.04 + 18));
  });

  it('a run of m/w ranks above a longer run of narrow letters', async () => {
    const { weightedLength } = await import('../src/renderer/components/artifact-views/sheet-measure');
    expect(weightedLength('mmmmmmmm')).toBeGreaterThan(weightedLength('iiiiiiiiiiii'));
    expect(weightedLength('日本語')).toBeGreaterThan(weightedLength('abc'));
  });

  it('re-measures when the fonts or theme change', async () => {
    const { CsvView } = await import('../src/renderer/components/artifact-views/CsvView');
    const { bumpFontEpochForTest } = await import('../src/renderer/components/artifact-views/sheet-measure');
    const view = render(<CsvView path="a.csv" content={'abcdefgh,b\n1,2'} absolutePath="/a.csv" isEditable={false} />);
    const w = () => parseFloat((view.container.querySelectorAll('colgroup col')[1] as HTMLElement).style.width);
    scale = 1; act(() => bumpFontEpochForTest());
    const before = w();
    scale = 2; act(() => bumpFontEpochForTest());   // the web font arrived and is wider
    expect(w()).toBeGreaterThan(before);
  });

  it('waiting for fonts is bounded', async () => {
    const { fontsReady } = await import('../src/renderer/components/artifact-views/sheet-measure');
    (document as any).fonts = { ready: new Promise(() => {}), addEventListener() {} };
    vi.useFakeTimers();
    const p = fontsReady(1500);
    vi.advanceTimersByTime(1600);
    await expect(p).resolves.toBeUndefined();
    vi.useRealTimers();
    delete (document as any).fonts;
  });
});
