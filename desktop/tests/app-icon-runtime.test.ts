import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { parse as parseYaml } from 'yaml';
import { readSource } from './helpers/guard-scope';

// WHY this file exists: the RUNNING app resets its taskbar / Dock icon every time a theme
// loads. It reset to icon.png, the edge-to-edge Windows tile, so on a Mac the Dock icon grew a
// size bigger than every other app right after launch (2026-09-27). These tests pin that the
// runtime default matches what electron-builder.yml ships per platform, and that the Mac
// default really leaves Apple's margin while the Windows tile does not.

vi.mock('electron', () => ({ nativeImage: {}, app: { on: () => {} }, systemPreferences: {} }));
import { defaultAppIconFile, reachesEdge, centerOnCanvas, MAC_ICON_SCALE } from '../src/main/app-icon';

const DESKTOP = path.join(__dirname, '..');
const ASSETS = path.join(DESKTOP, 'assets');
const CONFIG: Record<string, any> = parseYaml(readSource(path.join(DESKTOP, 'electron-builder.yml')));

// Minimal PNG reader: 8-bit RGBA, non-interlaced — what rsvg-convert writes for every icon.
function readRgbaPng(file: string): { width: number; height: number; data: Buffer } {
  const b = fs.readFileSync(file);
  let pos = 8, width = 0, height = 0;
  const idat: Buffer[] = [];
  while (pos < b.length) {
    const len = b.readUInt32BE(pos), type = b.toString('latin1', pos + 4, pos + 8), body = b.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      expect([body[8], body[9], body[12]], `${path.basename(file)} must be 8-bit RGBA, non-interlaced`).toEqual([8, 6, 0]);
    }
    if (type === 'IDAT') idat.push(body);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = width * 4, data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? data[y * stride + x - 4] : 0, up = y ? data[(y - 1) * stride + x] : 0, c = x >= 4 && y ? data[(y - 1) * stride + x - 4] : 0;
      const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
      const pred = [0, a, up, (a + up) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? up : c][f];
      data[y * stride + x] = (row[x] + pred) & 0xff;
    }
  }
  return { width, height, data };
}

describe('runtime app icon (app-icon.ts)', () => {
  it('uses the same file per platform that electron-builder.yml ships', () => {
    expect(defaultAppIconFile('win32')).toBe(CONFIG.win.icon);
    // The Mac ships the layered Liquid Glass icon (icon.icon), which nativeImage cannot read; the
    // running app's Mac default is the flat PNG of the same design on Apple's grid.
    expect(CONFIG.mac.icon).toBe('icon.icon');
    expect(defaultAppIconFile('darwin')).toBe('icon-mac.png');
    expect(defaultAppIconFile('linux')).toBe('icon.png');
    for (const p of ['win32', 'darwin', 'linux'] as const) {
      expect(fs.existsSync(path.join(ASSETS, defaultAppIconFile(p))), `${defaultAppIconFile(p)} missing — run scripts/build-icons.mjs`).toBe(true);
    }
  });

  it('the Mac default leaves Apple\'s margin; the Windows tile runs edge to edge', () => {
    const mac = readRgbaPng(path.join(ASSETS, 'icon-mac.png'));
    expect([mac.width, mac.height]).toEqual([1024, 1024]);
    expect(reachesEdge(mac.data, mac.width, mac.height)).toBe(false);
    const win = readRgbaPng(path.join(ASSETS, 'icon.png'));
    expect(reachesEdge(win.data, win.width, win.height)).toBe(true);
  });

  it('an edge-to-edge square shrunk by MAC_ICON_SCALE and centred no longer reaches the edge', () => {
    const size = 200, inner = Math.round(size * MAC_ICON_SCALE);
    const opaque = Buffer.alloc(inner * inner * 4, 0xff);
    expect(reachesEdge(Buffer.alloc(size * size * 4, 0xff), size, size)).toBe(true);
    const placed = centerOnCanvas(opaque, inner, inner, size, size);
    expect(reachesEdge(placed, size, size)).toBe(false);
    // Centred: the same transparent margin on the left and the right of the middle row.
    const row = Math.floor(size / 2), alphaAt = (x: number) => placed[(row * size + x) * 4 + 3];
    const xs = Array.from({ length: size }, (_, x) => x).filter((x) => alphaAt(x) > 0);
    const leftMargin = xs[0], rightMargin = size - 1 - xs[xs.length - 1];
    expect(leftMargin).toBeGreaterThan(0);
    expect(Math.abs(leftMargin - rightMargin)).toBeLessThanOrEqual(1);
  });

  it('the theme icon swap and window creation never hard-code the Windows tile', () => {
    // WHY theme-icon-swap.ts: window:set-icon (ipc/window.ts, one-core R3-8) hands the swap there.
    for (const file of ['src/main/theme-icon-swap.ts', 'src/main/main.ts']) {
      const src = readSource(path.join(DESKTOP, file));
      expect(src, `${file} must load its icon through app-icon.ts`).not.toMatch(/assets\/icon\.png/);
      expect(src).toContain('loadDefaultAppIcon(');
    }
    // A theme icon is shrunk onto Apple's grid; no theme hands the Dock back to the bundled
    // (Liquid Glass) icon with null, never with a flat file that would replace it.
    const handlers = readSource(path.join(DESKTOP, 'src/main/theme-icon-swap.ts'));
    expect(handlers).toMatch(/app\.dock\.setIcon\(img \? fitForMacDock\(img\) : \(null/);
  });

  it('a single faint pixel on the border does not count as art reaching the edge', () => {
    const size = 100, bmp = Buffer.alloc(size * size * 4);
    bmp[3] = 8; // alpha 8 at the top-left corner, below the threshold (anti-alias haze)
    expect(reachesEdge(bmp, size, size)).toBe(false);
    bmp[3] = 200;
    expect(reachesEdge(bmp, size, size)).toBe(true);
  });
});

// Brand round 28: which icon the Mac Dock shows while a theme is on, per the user's icon look.
import { chooseDockIcon, hasLiquidGlass } from '../src/main/app-icon';
import { parseMacIconLook } from '../src/main/mac-icon-look';
describe('Mac Dock rule (chooseDockIcon)', () => {
  it('no theme icon → the bundled icon, in every look', () => {
    for (const look of ['default', 'dark', 'clear', 'tinted', 'unknown'] as const) expect(chooseDockIcon(look, false, false)).toBe('bundle');
  });
  it('Default → the theme icon; Dark and Clear → the glass version; Tinted and unknown → no swap', () => {
    expect(chooseDockIcon('default', true, true)).toBe('app');
    expect(chooseDockIcon('dark', true, true)).toBe('glass');
    expect(chooseDockIcon('clear', true, true)).toBe('glass');
    expect(chooseDockIcon('tinted', true, true)).toBe('bundle');
    expect(chooseDockIcon('unknown', true, true)).toBe('bundle');
  });
  it('reads the Mac icon-look setting (AppleIconAppearanceTheme, seen on macOS 26.7.1)', () => {
    // Default removes the setting entirely; Electron reports a missing string as ''.
    expect(parseMacIconLook(undefined)).toBe('default');
    expect(parseMacIconLook('')).toBe('default');
    expect(parseMacIconLook('ClearLight')).toBe('clear');
    expect(parseMacIconLook('ClearDark')).toBe('clear');
    expect(parseMacIconLook('TintedDark')).toBe('tinted');
    expect(parseMacIconLook('RegularDark')).toBe('dark');
    expect(parseMacIconLook('somethingNew')).toBe('unknown');
  });
  it('a theme without a glass version uses its normal icon in Dark and Clear', () => {
    expect(chooseDockIcon('dark', true, false)).toBe('app');
  });
  it('Liquid Glass starts at macOS 26 (Darwin 25)', () => {
    expect(hasLiquidGlass('24.6.0')).toBe(false);
    expect(hasLiquidGlass('25.0.0')).toBe(true);
  });
});
