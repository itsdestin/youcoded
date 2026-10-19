import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { LinuxPackager } from 'electron-builder';
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
    ['mac', 'icon', 'icon.icon'],
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

  it('the Liquid Glass icon names layer pictures that exist', () => {
    // WHY: actool compiles icon.icon on the Mac build machine only; a layer the JSON names but the
    // folder lacks would fail there, long after every Linux check passed.
    const dir = path.join(ASSETS, 'icon.icon');
    const json = JSON.parse(fs.readFileSync(path.join(dir, 'icon.json'), 'utf8'));
    const images: string[] = json.groups.flatMap((g: any) => g.layers.map((l: any) => l['image-name']));
    expect(images.length).toBeGreaterThanOrEqual(2);
    for (const name of images) expect(fs.existsSync(path.join(dir, 'Assets', name)), `icon.icon/Assets/${name} missing`).toBe(true);
  });

  it('the tray icons exist for every platform, with their @2x twins', () => {
    // buddy-tray.ts: tray / tray-alert on Windows and Linux, the one-colour "-macTemplate" pair on macOS.
    for (const base of ['tray', 'tray-alert', 'tray-macTemplate', 'tray-alert-macTemplate']) {
      for (const f of [`${base}.png`, `${base}@2x.png`]) expect(fs.existsSync(path.join(ASSETS, f)), `${f} missing — run scripts/build-icons.mjs`).toBe(true);
    }
  });

  it('icon.png is 1024px square (the window icon, and the source for Linux)', () => {
    const b = bytes('icon.png');
    expect(b.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect([b.readUInt32BE(16), b.readUInt32BE(20)]).toEqual([1024, 1024]);
  });
});

describe('Linux launcher icons', () => {
  // Retain the old 1024px package path too, so existing absolute links do not break.
  const sizes = [16, 24, 32, 48, 64, 96, 128, 256, 512, 1024];

  it('Linux explicitly selects its own icon directory', () => {
    expect(sectionValue('linux', 'icon')).toBe('icons');
  });

  it.each(sizes)('ships a correctly sized %ipx PNG for hicolor lookup', (size) => {
    const b = bytes(`icons/${size}x${size}.png`);
    expect(b.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect([b.readUInt32BE(16), b.readUInt32BE(20)]).toEqual([size, size]);
  });

  it('electron-builder resolves all standard Linux sizes without falling back to another platform', async () => {
    // WHY exercise builder's real resolver: a single 1024px PNG passed our asset checks,
    // but builder installed only that unindexed hicolor size, which KDE/Qt could not find.
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-linux-icons-'));
    try {
      // Supply only filesystem context, not a fake conversion. Use the public dependency
      // entry point so the test does not rely on a hoisted, undeclared app-builder-lib.
      const packager = {
        config: { directories: { output: outDir } },
        projectDir: DESKTOP,
        buildResourcesDir: ASSETS,
        expandMacro: (value: string) => value,
      } as LinuxPackager;
      const icons = await LinuxPackager.prototype.resolveIcon.call(
        packager,
        [CONFIG.linux?.icon, CONFIG.mac?.icon, CONFIG.icon].filter(Boolean),
        [],
        'set',
      );
      expect(icons.map(icon => icon.size)).toEqual(sizes);
      for (const icon of icons) {
        expect(path.relative(ASSETS, icon.file)).toBe(path.join('icons', `${icon.size}x${icon.size}.png`));
      }
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 3 });
    }
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
