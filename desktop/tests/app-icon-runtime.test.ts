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

vi.mock('electron', () => ({ nativeImage: {} }));
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
    // The Mac default is the PNG twin of the .icns (nativeImage cannot be relied on for .icns).
    expect(defaultAppIconFile('darwin')).toBe(String(CONFIG.mac.icon).replace(/\.icns$/, '.png'));
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
    for (const file of ['src/main/ipc-handlers.ts', 'src/main/main.ts']) {
      const src = readSource(path.join(DESKTOP, file));
      expect(src, `${file} must load its icon through app-icon.ts`).not.toMatch(/assets\/icon\.png/);
      expect(src).toContain('loadDefaultAppIcon(');
    }
    expect(readSource(path.join(DESKTOP, 'src/main/ipc-handlers.ts'))).toContain('app.dock.setIcon(fitForMacDock(');
  });

  it('a single faint pixel on the border does not count as art reaching the edge', () => {
    const size = 100, bmp = Buffer.alloc(size * size * 4);
    bmp[3] = 8; // alpha 8 at the top-left corner, below the threshold (anti-alias haze)
    expect(reachesEdge(bmp, size, size)).toBe(false);
    bmp[3] = 200;
    expect(reachesEdge(bmp, size, size)).toBe(true);
  });
});
