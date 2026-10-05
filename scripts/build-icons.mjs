#!/usr/bin/env node
// build-icons.mjs — every app, installer, tray and Android launcher icon, plus each marketplace
// theme's own icon set, from ONE drawing: scripts/icons/brand-icons.html.
//
//   node scripts/build-icons.mjs                       (from the youcoded repo root)
//   node scripts/build-icons.mjs --themes <dir>        also write each theme's icons into a
//                                                      wecoded-themes checkout's themes/<slug>/assets/app-icon/
//   node scripts/build-icons.mjs --site docs/brand     only the website's icons (skips the app's)
//
// WHY a script: an icon ships in a dozen files across four platforms. Edited by hand they drift —
// the Android launcher kept the old "YC" square for months after desktop art moved on.
// WHY headless Chrome: the approved icon (brand rounds 11–31) is glass — the theme's picture blurred
// inside the face, soft light, shadows all round — and CSS draws exactly that. The page is
// screenshotted on a transparent background; small sizes come from a separate "small" drawing whose
// eyes are ~20% bigger, because normal eyes blur away at 16–48px.
//
// Needs on PATH: google-chrome-stable (or set CHROME=…), rsvg-convert (librsvg), magick (ImageMagick 7),
// python3 with Pillow. Lives outside desktop/ on purpose: electron-builder packages desktop/scripts/**.
//
// Writes (desktop/assets/):
//   icon.png (1024), icon.ico                  app + window icon (Windows, Linux)
//   icon-mac.png (1024), icon-mac.icns         the flat Mac icon, on Apple's ~80% grid (older macOS)
//   icon.icon/                                 the macOS 26 Liquid Glass icon: background + face + eyes layers
//   installer-icon.ico / .icns                 Windows installer, the opened Mac disk
//   tray*.png                                  tray icon (Windows, Linux) — the app icon, shrunk
//   tray-macTemplate*.png                      Mac menu-bar icon: one colour, macOS tints it
// and app/src/main/res/mipmap-*dpi/ic_launcher_{foreground,monochrome}.png (Android).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(ROOT, 'scripts', 'icons', 'brand-icons.html');
const ASSETS = path.join(ROOT, 'desktop', 'assets');
const RES = path.join(ROOT, 'app', 'src', 'main', 'res');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-icons-'));
const ALERT = '#E5484D';

// Marketplace themes that get their own icons. Cotton Candy Sky is left out on purpose: the default
// icon is drawn from its picture, so it simply wears the default (and keeps the Mac's Liquid Glass).
const THEMES = ['golden-sunbreak', 'meadow-mist', 'strawberry-kitty', 'kuromi-dreamer', 'devils-garden', 'halftone-dimension', 'morning-rounds'];

const CHROME = process.env.CHROME || ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']
  .find((b) => { try { execFileSync('which', [b], { stdio: 'ignore' }); return true; } catch { return false; } });
if (!CHROME) throw new Error('no Chrome found — set CHROME=/path/to/chrome');

let shots = 0;
// Screenshot one icon. `small` draws the bigger eyes meant for 16–48px.
function shoot(icon, theme, px, small = false) {
  const out = path.join(TMP, `${icon}-${theme}-${px}${small ? '-s' : ''}-${shots++}.png`);
  const url = `file://${PAGE}?i=${icon}&t=${theme}&px=${px}${small ? '&small=1' : ''}`;
  execFileSync(CHROME, ['--headless=new', '--hide-scrollbars', '--force-device-scale-factor=1', `--window-size=${px},${px}`,
    '--default-background-color=00000000', '--virtual-time-budget=5000', '--allow-file-access-from-files',
    `--user-data-dir=${fs.mkdtempSync(path.join(TMP, 'chrome-'))}`, `--screenshot=${out}`, url], { stdio: 'ignore' });
  if (!fs.existsSync(out)) throw new Error(`Chrome wrote no picture for ${icon}/${theme}`);
  return out;
}
const resize = (src, px, out) => { execFileSync('magick', [src, '-filter', 'Lanczos', '-resize', `${px}x${px}`, out]); return out; };
// One icon at every size: big sizes shrunk from a 1024 drawing, ≤48px from the small drawing.
function sizes(icon, theme, list) {
  const big = shoot(icon, theme, 1024), small = shoot(icon, theme, 512, true);
  return Object.fromEntries(list.map((px) => [px, resize(px <= 48 ? small : big, px, path.join(TMP, `${icon}-${theme}-${px}-${shots++}.png`))]));
}
const ico = (pngs, out) => execFileSync('magick', [...pngs, out]);
function icns(pngs, out) {
  execFileSync('python3', ['-c',
    'import sys; from PIL import Image\n'
    + 'imgs = [Image.open(p) for p in sys.argv[2:]]\n'
    + 'imgs[0].save(sys.argv[1], format="ICNS", append_images=imgs[1:])', out, ...pngs]);
}
// Apple's grid: macOS draws no tile of its own, so an edge-to-edge square looks oversized in the Dock.
// 0.8047 matches desktop/src/main/app-icon.ts MAC_ICON_SCALE.
const onMacGrid = (src, px, out) => {
  execFileSync('magick', [src, '-filter', 'Lanczos', '-resize', `${Math.round(px * 0.8047)}x`, '-background', 'none', '-gravity', 'center', '-extent', `${px}x${px}`, out]);
  return out;
};
// The red "needs you" dot, top-right, with a white ring so it reads on dark and light bars.
const withDot = (src, px, out) => {
  const r = px * 0.17, cx = px - r - px * 0.02, cy = r + px * 0.02;
  execFileSync('magick', [src, '-fill', ALERT, '-stroke', 'white', '-strokewidth', String(Math.max(1, px * 0.045)),
    '-draw', `circle ${cx},${cy} ${cx + r},${cy}`, out]);
  return out;
};

// Tray (Windows, Linux): the app icon itself, shrunk (round 27, pick C), plus its alert twin.
// 32px base + @2x: the OS downsizes for its bar, and Linux panels (22–24px) would blur a 16px base.
function trayIcons(theme, dir, prefix = 'tray') {
  const s = sizes('app', theme, [32, 64]);
  for (const [suffix, px] of [['', 32], ['@2x', 64]]) {
    fs.copyFileSync(s[px], path.join(dir, `${prefix}${suffix}.png`));
    withDot(s[px], px, path.join(dir, `${prefix}-alert${suffix}.png`));
  }
}

// ── Mac menu-bar icon (round 31, "J1") ──
// One colour, so macOS can turn it black on a light menu bar and white on a dark one: the face's
// outline, full-size solid eyes with a sparkle cut into each top-right, the smile; eyes and smile
// raised a touch. Electron treats a file whose name ends in "Template" as a template image.
function templateSvg(dot, ink = '#000') {
  const E = [[4.3, 5.2], [9.7, 4.9]];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="-0.5 -2.5 15 15">
  <defs><mask id="ring"><rect width="14" height="12" rx="4" fill="#fff"/><rect x="1.15" y="1.15" width="11.7" height="9.7" rx="2.95" fill="#000"/></mask>
  <mask id="spark"><rect x="-1" y="-3" width="16" height="16" fill="#fff"/>${E.map(([x, y]) => `<circle cx="${x + .55}" cy="${y - .9}" r=".62" fill="#000"/>`).join('')}</mask></defs>
  <rect width="14" height="12" rx="4" fill="${ink}" mask="url(#ring)"/>
  <g mask="url(#spark)">${E.map(([x, y]) => `<ellipse cx="${x}" cy="${y}" rx="1.6" ry="2.2" fill="${ink}"/>`).join('')}</g>
  <path d="M5.6 8.35 Q7 8 8.4 8.35 Q8.9 8.5 8.7 8.95 Q8 10.25 7 10.25 Q6 10.25 5.3 8.95 Q5.1 8.5 5.6 8.35Z" fill="${ink}"/>
  ${dot ? `<circle cx="12.6" cy="-0.6" r="2.1" fill="${ink}"/>` : ''}
</svg>`;
}
function macTrayIcons() {
  for (const [name, dot] of [['tray-macTemplate', false], ['tray-alert-macTemplate', true]]) {
    const svgPath = path.join(TMP, `${name}.svg`);
    fs.writeFileSync(svgPath, templateSvg(dot));
    for (const [suffix, px] of [['', 18], ['@2x', 36]]) {
      execFileSync('rsvg-convert', ['-w', String(px), '-h', String(px), svgPath, '-o', path.join(ASSETS, `${name}${suffix}.png`)]);
    }
  }
}

// ── macOS 26 Liquid Glass icon (round 27) ──
// Icon Composer's format: a folder with icon.json and the layer pictures. macOS draws the glass edge,
// light and shadow itself, and re-colours the layers for the Dark, Clear and Tinted looks.
// electron-builder (26.x, mac.icon) compiles it with Xcode 26's actool into Assets.car, plus a flat
// .icns for older macOS.
function liquidGlass() {
  const dir = path.join(ASSETS, 'icon.icon');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'Assets'), { recursive: true });
  fs.copyFileSync(shoot('features', 'default', 1024), path.join(dir, 'Assets', 'features.png'));
  fs.copyFileSync(shoot('panel', 'default', 1024), path.join(dir, 'Assets', 'face.png'));
  const layer = (name, glass) => ({ glass, hidden: false, 'image-name': `${name}.png`, name, position: { scale: 1, 'translation-in-points': [0, 0] } });
  const group = (l) => ({ 'blur-material': null, layers: [l], lighting: 'individual', shadow: { kind: 'neutral', opacity: 0.5 }, specular: true, translucency: { enabled: false, value: 0 } });
  const json = {
    // The white-lavender tile, the middle of the approved frost gradient (#FBF6FD → #E9DCF2).
    fill: { solid: 'srgb:0.95294,0.92157,0.97255,1.00000' },
    // First group is drawn in front: the eyes and smile sit on the face.
    groups: [group(layer('features', false)), group(layer('face', true))],
    'supported-platforms': { squares: ['macOS'] },
  };
  fs.writeFileSync(path.join(dir, 'icon.json'), JSON.stringify(json, null, 2) + '\n');
}

// ── Android adaptive icon ──
// The launcher masks a 108dp layer to its own shape; only the centre 66dp circle is guaranteed
// visible. The face panel's corner is its farthest point (~0.54 of its width from the centre), so a
// 60dp-wide panel keeps every corner inside that circle. The tile is its own vector layer
// (drawable/ic_launcher_background.xml).
function android() {
  const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  const face = shoot('face', 'default', 1024);
  // Monochrome (Android 13 themed icons) reads ALPHA only: the menu-bar face, so it keeps its features.
  const monoSvg = path.join(TMP, 'mono.svg');
  fs.writeFileSync(monoSvg, templateSvg(false, '#fff'));
  for (const [bucket, scale] of Object.entries(DENSITIES)) {
    const dir = path.join(RES, `mipmap-${bucket}`), px = Math.round(108 * scale), facePx = Math.round(64 * scale);
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('magick', [face, '-filter', 'Lanczos', '-resize', `${facePx}x${facePx}`, '-background', 'none', '-gravity', 'center', '-extent', `${px}x${px}`,
      path.join(dir, 'ic_launcher_foreground.png')]);
    const mono = path.join(TMP, `mono-${bucket}.png`);
    execFileSync('rsvg-convert', ['-w', String(Math.round(66 * scale)), '-h', String(Math.round(66 * scale)), monoSvg, '-o', mono]);
    execFileSync('magick', [mono, '-background', 'none', '-gravity', 'center', '-extent', `${px}x${px}`, path.join(dir, 'ic_launcher_monochrome.png')]);
  }
}

// ── Each marketplace theme's icon set ──
// Written into the theme's own folder so it ships with a normal theme update; the theme's
// manifest.json names them (appIcon + appIconVariants — see desktop/src/renderer/themes/theme-types.ts).
function themeIcons(themesDir) {
  for (const slug of THEMES) {
    const dir = path.join(themesDir, 'themes', slug, 'assets', 'app-icon');
    if (!fs.existsSync(path.dirname(dir))) throw new Error(`no theme folder for ${slug} in ${themesDir}`);
    fs.mkdirSync(dir, { recursive: true });
    const s = sizes('app', slug, [16, 20, 24, 32, 40, 48, 64, 128, 256, 512]);
    fs.copyFileSync(s[512], path.join(dir, 'app.png'));
    ico([16, 20, 24, 32, 40, 48, 64, 128, 256].map((px) => s[px]), path.join(dir, 'app.ico'));
    resize(shoot('glass', slug, 1024), 512, path.join(dir, 'glass.png'));
    trayIcons(slug, dir);
    process.stdout.write(`${slug} `);
  }
  console.log();
}

// ── The website's icons (youcoded.ai, served from docs/) ──
// WHY: the site switches between the marketplace themes, and its header, footer and browser-tab
// icon wear the matching theme icon (brand round 23, L4). One file per theme and size, named
// <slug>-<px>.png; "default" also covers Cotton Candy Sky and the built-in themes. 32px uses the
// small drawing (a browser tab); 128 is the header/footer at 2x; 180 is the iPhone home-screen icon.
function siteIcons(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const slug of ['default', ...THEMES]) {
    const s = sizes('app', slug, [32, 128, 180]);
    for (const px of [32, 128]) fs.copyFileSync(s[px], path.join(dir, `${slug}-${px}.png`));
    if (slug === 'default') fs.copyFileSync(s[180], path.join(dir, 'apple-touch-icon.png'));
    process.stdout.write(`${slug} `);
  }
  console.log();
}

const themesArg = process.argv.indexOf('--themes');
const siteArg = process.argv.indexOf('--site');
const themesOnly = process.argv.includes('--themes-only') || siteArg > 0;
if (!themesOnly) {
  const app = sizes('app', 'default', [16, 20, 24, 32, 40, 48, 64, 128, 256, 512, 1024]);
  fs.copyFileSync(app[1024], path.join(ASSETS, 'icon.png'));
  ico([16, 20, 24, 32, 40, 48, 64, 128, 256].map((px) => app[px]), path.join(ASSETS, 'icon.ico'));
  // WHY a PNG twin of the Mac icon: on macOS before 26 the running app swaps the Dock icon per theme
  // and needs a Dock-sized default it can read; nativeImage reads PNG everywhere, not .icns.
  onMacGrid(app[1024], 1024, path.join(ASSETS, 'icon-mac.png'));
  icns([1024, 512, 256, 128, 64, 32, 16].map((px) => onMacGrid(app[px], px, path.join(TMP, `mac-${px}.png`))), path.join(ASSETS, 'icon-mac.icns'));
  const inst = sizes('installer', 'default', [16, 20, 24, 32, 40, 48, 64, 128, 256, 512, 1024]);
  ico([16, 20, 24, 32, 40, 48, 64, 128, 256].map((px) => inst[px]), path.join(ASSETS, 'installer-icon.ico'));
  icns([1024, 512, 256, 128, 64, 32, 16].map((px) => onMacGrid(inst[px], px, path.join(TMP, `imac-${px}.png`))), path.join(ASSETS, 'installer-icon.icns'));
  trayIcons('default', ASSETS);
  macTrayIcons();
  liquidGlass();
  android();
  console.log('icons written: desktop/assets + app/src/main/res/mipmap-*');
}
if (themesArg > 0) themeIcons(path.resolve(process.argv[themesArg + 1]));
if (siteArg > 0) siteIcons(path.resolve(process.argv[siteArg + 1]));
fs.rmSync(TMP, { recursive: true, force: true });
