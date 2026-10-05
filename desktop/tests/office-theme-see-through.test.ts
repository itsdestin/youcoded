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
