// app-icon.ts — which icon the RUNNING app hands the OS for its taskbar / Dock button.
//
// WHY this exists: the installed app's icon is chosen per platform by electron-builder.yml
// (Windows .ico, Mac .icns on Apple's ~80% grid). But the app also swaps that icon at runtime
// for themes, and every swap used to reset to assets/icon.png — the edge-to-edge Windows tile.
// On a Mac, which draws no tile of its own, that made the Dock icon jump a size bigger than
// every other app about a second after launch (reported by Mac users, 2026-09-27). This file
// keeps the runtime icon matching what the installer ships, and makes theme icons fit too.
import path from 'path';
import { nativeImage, type NativeImage } from 'electron';

// The share of the canvas Apple's grid gives the icon's body. Same number build-icons.mjs uses
// for icon-mac.svg (translate 4.69, scale 0.8047 on a 48 box), so a scaled theme icon lands
// exactly where the shipped Mac icon sits.
export const MAC_ICON_SCALE = 0.8047;

/** The bundled default icon file for each platform. Mirrors electron-builder.yml. */
export function defaultAppIconFile(platform: NodeJS.Platform): string {
  // WHY .ico on Windows: it carries 16–256px each drawn from the vector, so the taskbar's
  // small sizes keep the mascot's eyes sharp. A 1024px PNG shrunk to 16px blurs them.
  if (platform === 'win32') return 'icon.ico';
  if (platform === 'darwin') return 'icon-mac.png';
  return 'icon.png';
}

/** The default icon, loaded. Falls back to icon.png if the platform file will not load
 *  (e.g. an Electron build that cannot read .ico), so the app never ends up iconless. */
export function loadDefaultAppIcon(assetsDir: string, platform: NodeJS.Platform = process.platform): NativeImage {
  const img = nativeImage.createFromPath(path.join(assetsDir, defaultAppIconFile(platform)));
  return img.isEmpty() ? nativeImage.createFromPath(path.join(assetsDir, 'icon.png')) : img;
}

/** True when any visible pixel sits in the outer `band` of the canvas — i.e. the art runs
 *  edge to edge rather than already leaving Apple's margin. Works on raw 4-byte-per-pixel
 *  bitmaps; alpha is byte 3 in both BGRA and RGBA, so the channel order does not matter. */
export function reachesEdge(bitmap: Uint8Array, width: number, height: number, band = 0.05, alphaMin = 16): boolean {
  const bx = Math.max(1, Math.round(width * band));
  const by = Math.max(1, Math.round(height * band));
  for (let y = 0; y < height; y++) {
    const edgeRow = y < by || y >= height - by;
    for (let x = 0; x < width; x++) {
      if (!edgeRow && x >= bx && x < width - bx) { x = width - bx - 1; continue; } // skip the interior
      if (bitmap[(y * width + x) * 4 + 3] >= alphaMin) return true;
    }
  }
  return false;
}

/** Copy a smaller bitmap into the centre of a transparent canvas. */
export function centerOnCanvas(src: Uint8Array, sw: number, sh: number, cw: number, ch: number): Buffer {
  const out = Buffer.alloc(cw * ch * 4); // zero = fully transparent
  const ox = Math.floor((cw - sw) / 2);
  const oy = Math.floor((ch - sh) / 2);
  for (let y = 0; y < sh; y++) {
    out.set(src.subarray(y * sw * 4, (y + 1) * sw * 4), ((oy + y) * cw + ox) * 4);
  }
  return out;
}

/** The icon as the Mac Dock should show it. Art that runs edge to edge (the Windows tile, or a
 *  theme's square) is shrunk onto Apple's grid; art that already leaves the margin — like
 *  icon-mac.png — is returned untouched, so nothing is ever shrunk twice. */
export function fitForMacDock(img: NativeImage): NativeImage {
  const { width, height } = img.getSize();
  const bitmap = img.toBitmap();
  // WHY bail on a size mismatch: a multi-resolution image can hand back a bitmap that is not
  // width×height×4. Showing it unscaled beats reading pixels at the wrong offsets.
  if (!width || !height || bitmap.length !== width * height * 4) return img;
  if (!reachesEdge(bitmap, width, height)) return img;
  const scaled = img.resize({ width: Math.round(width * MAC_ICON_SCALE), height: Math.round(height * MAC_ICON_SCALE), quality: 'best' });
  const s = scaled.getSize();
  const sBitmap = scaled.toBitmap();
  if (sBitmap.length !== s.width * s.height * 4) return img;
  return nativeImage.createFromBitmap(centerOnCanvas(sBitmap, s.width, s.height, width, height), { width, height });
}

// ── The Mac Dock while a theme is on (brand round 28) ──
// macOS 26 ("Tahoe") draws the bundled Liquid Glass icon itself and re-colours it for the user's
// icon look (Default, Dark, Clear, Tinted). A picture the app swaps in while it runs is flat — the
// Mac adds no glass to it — so Destin chose, per look:
//   Default        → the theme's icon (white tile, theme face)
//   Dark, Clear    → the theme's face on see-through glass (`macGlass`)
//   Tinted         → no swap: the Liquid Glass icon stays, tinted like every other app
// When the look can't be read, the Dock is left alone (the one choice that never clashes).
// Macs before 26 have no looks and no Liquid Glass: they always get the theme's icon.
export type MacIconLook = 'default' | 'dark' | 'clear' | 'tinted' | 'unknown';
export type DockChoice = 'bundle' | 'app' | 'glass';

export function chooseDockIcon(look: MacIconLook, hasTheme: boolean, hasGlass: boolean): DockChoice {
  if (!hasTheme) return 'bundle';
  if (look === 'default') return 'app';
  if (look === 'dark' || look === 'clear') return hasGlass ? 'glass' : 'app';
  return 'bundle';
}

/** macOS 26 is Darwin 25. `os.release()` gives the Darwin version. */
export function hasLiquidGlass(darwinRelease: string): boolean {
  return parseInt(darwinRelease, 10) >= 25;
}
