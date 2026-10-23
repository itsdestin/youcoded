// The build stores each YouCoded buddy picture once (vite.config.ts shareMascotPictures): every pose drawing, put back
// together at runtime, must be the drawing on disk character for character, and the picture must not be repeated.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import config from '../vite.config';

const ASSETS = resolve(__dirname, '../src/renderer/themes/builtin/assets');
type Loader = { name: string; load(id: string): string | null };
const plugin = (config.plugins as unknown as Loader[]).find((p) => p?.name === 'youcoded-share-mascot-pictures')!;
const valueOf = (code: string) => JSON.parse(/^export default (".*");$/s.exec(code)![1]) as string;

describe('the buddy pictures in the build', () => {
  const files = readdirSync(ASSETS).filter((f) => /mascot.*\.svg$/.test(f));

  it('rebuilds every pose drawing exactly, from one shared copy of its picture', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
    const pictureIds = new Set<string>();
    for (const file of files) {
      const code = plugin.load(`${ASSETS}/${file}?raw`)!;
      const m = /^import picture from (".*");\nexport default (.*);$/s.exec(code);
      expect(m, `${file} should share its picture`).toBeTruthy();
      const id = JSON.parse(m![1]) as string;
      pictureIds.add(id);
      const picture = valueOf(plugin.load(id)!);
      const rebuilt = new Function('picture', `return ${m![2]};`)(picture) as string;
      expect(rebuilt === readFileSync(`${ASSETS}/${file}`, 'utf8'), `${file} rebuilt differs from the file`).toBe(true);
      // The pose's own part is small; the picture is what is shared.
      expect(code.length).toBeLessThan(20_000);
    }
    expect(pictureIds.size).toBe(2);   // one picture per theme (day, night), whatever the number of poses
  });

  it('leaves every other file alone', () => {
    expect(plugin.load(`${ASSETS}/youcoded-wallpaper.jpg`)).toBeNull();
    expect(plugin.load(`${ASSETS}/youcoded-mascot-rig.svg`)).toBeNull();   // only the ?raw text import is rewritten
  });
});
