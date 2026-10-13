// @vitest-environment jsdom
// Office wears the same frost as pages and follows the SAME global Appearance switch. The editor (add-on, not ours) keys its
// see-through bands on `wallpaper`, so with the switch OFF the host must report wallpaper:false — no add-on change needed.
import { afterEach, expect, it } from 'vitest';
import { readOfficeTheme } from '../src/renderer/components/office/office-theme';

afterEach(() => { document.documentElement.removeAttribute('data-wallpaper'); document.documentElement.removeAttribute('data-pages-solid'); });

it('reports a wallpaper only while the global switch is on', () => {
  expect(readOfficeTheme().wallpaper).toBe(false);
  document.documentElement.setAttribute('data-wallpaper', '');
  expect(readOfficeTheme().wallpaper).toBe(true);
  document.documentElement.setAttribute('data-pages-solid', '');
  expect(readOfficeTheme().wallpaper).toBe(false);
});

it('makes the frame behind a page or Office solid while the switch is off, in both glass layouts', async () => {
  // WHY (2026-10-05: "office is still transparent with the switch off"): an older rule makes every screen pane glass in
  // wallpaper themes, so the switch must also override it on the frame pane, or Office keeps showing the wallpaper.
  const { readFileSync } = await import('node:fs');
  const css = (f: string) => readFileSync(new URL(`../src/renderer/styles/${f}`, import.meta.url), 'utf8').replace(/\s+/g, ' ');
  expect(css('globals.css')).toContain("[data-wallpaper][data-pages-solid] [data-chrome-style='floating'] .screen-pane--frame { background-color: var(--canvas); }");
  expect(css('float-chrome.css')).toContain("[data-pages-solid] [data-chrome-style='float'] .screen-pane--frame { background-color: var(--canvas) !important; }");
});
