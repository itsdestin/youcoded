// @vitest-environment jsdom
// v0.1.39 (Destin: "scrollbars still aren't updating consistently" after theme switches): the
// editor is told about a theme change by watchOfficeTheme. It used to notice only a change of the
// colours a Page uses, so a change of the scrollbar colours, the wallpaper or the glass settings
// alone never reached the editor.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchOfficeTheme } from '../../src/renderer/components/office/office-theme';

const root = document.documentElement;
const flush = () => new Promise((r) => setTimeout(r, 0));
afterEach(() => { root.removeAttribute('style'); root.removeAttribute('data-wallpaper'); });

describe('watchOfficeTheme', () => {
  it('tells the editor when only the scrollbar colours change', async () => {
    root.style.setProperty('--panel', '#111111');
    root.style.setProperty('--scrollbar-thumb', '#333333');
    const seen = vi.fn();
    const stop = watchOfficeTheme(seen);
    root.style.setProperty('--scrollbar-thumb', '#aa3355');
    await flush();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0][0].tokens['scrollbar-thumb']).toBe('#aa3355');
    stop();
  });

  it('tells the editor when only the wallpaper or the glass changes, and not when nothing it reads did', async () => {
    root.style.setProperty('--panel', '#111111');
    const seen = vi.fn();
    const stop = watchOfficeTheme(seen);
    root.setAttribute('data-wallpaper', '');
    await flush();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0][0].wallpaper).toBe(true);
    root.style.setProperty('--panels-opacity', '0.5');
    await flush();
    expect(seen).toHaveBeenCalledTimes(2);
    root.setAttribute('data-unrelated', 'x');
    await flush();
    expect(seen).toHaveBeenCalledTimes(2);
    root.removeAttribute('data-unrelated');
    stop();
  });
});
