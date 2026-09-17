import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { readSource } from './helpers/guard-scope';

// WHY this file exists: the app icon lives in nine generated files across three platforms,
// named from electron-builder.yml and two Android XML files. None of those readers fail a
// build when a file is missing or the wrong format — electron-builder quietly falls back to a
// default icon, and Android shows its green robot — so a broken icon ships with every check
// green. These tests pin the wiring; scripts/build-icons.mjs owns the pixels.

const DESKTOP = path.join(__dirname, '..');
const ASSETS = path.join(DESKTOP, 'assets');
const RES = path.join(DESKTOP, '..', 'app', 'src', 'main', 'res');

// WHY a real parser: the hand-rolled line scanner returned null for every key on a
// CRLF checkout and made two "must be absent" cases pass for the wrong reason
// (Windows CI, 2026-09-16 review). electron-builder reads this file with a YAML
// parser; so does this test now.
const CONFIG: Record<string, any> = parseYaml(readSource(path.join(DESKTOP, 'electron-builder.yml')));
function sectionValue(section: string, key: string): string | null {
  const v = CONFIG?.[section]?.[key];
  return v === undefined || v === null ? null : String(v);
}

const bytes = (file: string) => fs.readFileSync(path.join(ASSETS, file));

describe('desktop icons (electron-builder.yml)', () => {
  it.each([
    ['win', 'icon', 'icon.ico'],
    ['mac', 'icon', 'icon-mac.icns'],
    ['nsis', 'installerIcon', 'installer-icon.ico'],
    ['nsis', 'installerHeaderIcon', 'installer-icon.ico'],
    ['dmg', 'icon', 'installer-icon.icns'],
  ])('%s.%s points at %s, which exists', (section, key, file) => {
    expect(sectionValue(section, key)).toBe(file);
    expect(fs.existsSync(path.join(ASSETS, file)), `assets/${file} missing — run scripts/build-icons.mjs`).toBe(true);
  });

  it('the .ico files are real icons carrying 16px through 256px', () => {
    for (const file of ['icon.ico', 'installer-icon.ico']) {
      const b = bytes(file);
      // ICONDIR: reserved 0, type 1 (icon), then the entry count.
      expect(b.readUInt16LE(0)).toBe(0);
      expect(b.readUInt16LE(2)).toBe(1);
      const widths = Array.from({ length: b.readUInt16LE(4) }, (_, i) => b[6 + i * 16] || 256);
      expect(widths).toEqual(expect.arrayContaining([16, 24, 32, 48, 256]));
    }
  });

  it('the .icns files are real Apple icons', () => {
    for (const file of ['icon-mac.icns', 'installer-icon.icns']) {
      expect(bytes(file).subarray(0, 4).toString('latin1')).toBe('icns');
    }
  });

  it('icon.png is 1024px square (the window icon, and the source for Linux)', () => {
    const b = bytes('icon.png');
    expect(b.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect([b.readUInt32BE(16), b.readUInt32BE(20)]).toEqual([1024, 1024]);
  });
});

describe('Android launcher icon', () => {
  it.each(['ic_launcher.xml', 'ic_launcher_round.xml'])('%s uses the generated mascot layers', (file) => {
    const xml = fs.readFileSync(path.join(RES, 'mipmap-anydpi-v26', file), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    expect(xml).toContain('android:drawable="@mipmap/ic_launcher_foreground"');
    expect(xml).toContain('android:drawable="@mipmap/ic_launcher_monochrome"');
    expect(xml).toContain('android:drawable="@drawable/ic_launcher_background"');
  });

  it('every density carries both layers at 108dp', () => {
    const densities: Record<string, number> = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
    for (const [bucket, px] of Object.entries(densities)) {
      for (const layer of ['ic_launcher_foreground', 'ic_launcher_monochrome']) {
        const file = path.join(RES, `mipmap-${bucket}`, `${layer}.png`);
        expect(fs.existsSync(file), `${bucket}/${layer}.png missing — run scripts/build-icons.mjs`).toBe(true);
        const b = fs.readFileSync(file);
        expect([b.readUInt32BE(16), b.readUInt32BE(20)]).toEqual([px, px]);
      }
    }
  });
});
