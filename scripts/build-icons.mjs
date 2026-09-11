#!/usr/bin/env node
// build-icons.mjs — every app, installer and Android launcher icon, from ONE mascot drawing.
//
//   node scripts/build-icons.mjs        (from the youcoded repo root)
//
// WHY a script: an icon ships in nine files across three platforms (a 1024px PNG, a Windows
// .ico, two macOS .icns, the SVG sources, and ten Android density bitmaps). Edited by hand
// they drift — the Android launcher kept the old "YC" square for months after desktop art
// moved on. Everything below is derived from desktop/assets/icon-mascot.svg, so changing the
// mascot means editing that one file and rerunning this.
//
// Needs on PATH: rsvg-convert (librsvg), magick (ImageMagick 7), python3 with Pillow.
// Lives outside desktop/ on purpose: electron-builder packages desktop/scripts/** into the app.
//
// Writes:
//   desktop/assets/icon.svg, icon.png (1024), icon.ico   app + window icon (Windows, Linux)
//   desktop/assets/icon-mac.svg, icon-mac.icns           macOS app icon (Apple's ~80% grid)
//   desktop/assets/installer-icon.svg/.ico/.icns         Windows installer + the opened Mac disk
//   app/src/main/res/mipmap-*dpi/ic_launcher_foreground.png, ic_launcher_monochrome.png
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'desktop', 'assets');
const RES = path.join(ROOT, 'app', 'src', 'main', 'res');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-icons-'));

// Tile colours come from the youcoded.ai header mark in its Cotton Candy Sky theme, which is
// the look Destin picked: a lavender tile, a hairline lavender edge, a faint top highlight.
const TILE = '#E7D4EF', EDGE = '#D6C0E2', HI = '#F7F1FA', PURPLE = '#8B47B8', WHITE = '#FFFFFF';

const src = fs.readFileSync(path.join(ASSETS, 'icon-mascot.svg'), 'utf8');
const ART = src.slice(src.indexOf('>', src.indexOf('<svg')) + 1, src.lastIndexOf('</svg>'))
  .replace(/<!--[\s\S]*?-->/g, '').trim();

const svg = (size, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>\n`;
// Place the mascot (drawn in the rig's 24-unit art box) at scale k, centred on (cx, cy).
const mascotAt = (k, cx, cy, art = ART) =>
  `<g transform="translate(${(cx - 12 * k).toFixed(2)} ${(cy - 12.4 * k).toFixed(2)}) scale(${k})">${art}</g>`;
const tile = `<rect x="0.3" y="0.3" width="47.4" height="47.4" rx="15.3" fill="${TILE}" stroke="${EDGE}" stroke-width="0.6"/>`
  + `<path d="M16.5 1.3 H31.5" stroke="${HI}" stroke-width="0.6" stroke-opacity="0.7" stroke-linecap="round"/>`;

const APP = tile + mascotAt(1.55, 24, 24.5);
const sources = {
  'icon.svg': svg(48, APP),
  // macOS draws no tile of its own, so an edge-to-edge square looks oversized in the Dock.
  'icon-mac.svg': svg(48, `<g transform="translate(4.69 4.69) scale(0.8047)">${APP}</g>`),
  // Destin's installer pick ("arrow strip"): the mascot raised so its feet clear the band.
  'installer-icon.svg': svg(48,
    `<clipPath id="strip"><rect x="0.3" y="0.3" width="47.4" height="47.4" rx="15.3"/></clipPath>${tile}`
    + mascotAt(1.22, 24, 18.6)
    + `<g clip-path="url(#strip)"><rect x="0" y="35" width="48" height="13" fill="${PURPLE}"/>`
    + `<path d="M24 37 V45 M20.3 41.6 L24 45.3 L27.7 41.6" stroke="${WHITE}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></g>`
    + `<rect x="0.3" y="0.3" width="47.4" height="47.4" rx="15.3" fill="none" stroke="${EDGE}" stroke-width="0.6"/>`),
};

function render(svgPath, px, out) {
  execFileSync('rsvg-convert', ['-w', String(px), '-h', String(px), svgPath, '-o', out]);
  return out;
}
// Each size is rendered from the vector, not shrunk from the biggest one, so 16px stays crisp.
function ico(svgPath, out) {
  const pngs = [16, 24, 32, 48, 64, 128, 256].map((px) => render(svgPath, px, path.join(TMP, `${path.basename(out)}-${px}.png`)));
  execFileSync('magick', [...pngs, out]);
}
function icns(svgPath, out) {
  const pngs = [1024, 512, 256, 128, 64, 32, 16].map((px) => render(svgPath, px, path.join(TMP, `${path.basename(out)}-${px}.png`)));
  execFileSync('python3', ['-c',
    'import sys; from PIL import Image\n'
    + 'imgs = [Image.open(p) for p in sys.argv[2:]]\n'
    + 'imgs[0].save(sys.argv[1], format="ICNS", append_images=imgs[1:])', out, ...pngs]);
}

for (const [name, body] of Object.entries(sources)) fs.writeFileSync(path.join(ASSETS, name), body);
render(path.join(ASSETS, 'icon.svg'), 1024, path.join(ASSETS, 'icon.png'));
ico(path.join(ASSETS, 'icon.svg'), path.join(ASSETS, 'icon.ico'));
icns(path.join(ASSETS, 'icon-mac.svg'), path.join(ASSETS, 'icon-mac.icns'));
ico(path.join(ASSETS, 'installer-icon.svg'), path.join(ASSETS, 'installer-icon.ico'));
icns(path.join(ASSETS, 'installer-icon.svg'), path.join(ASSETS, 'installer-icon.icns'));

// ── Android adaptive icon ──
// The launcher masks a 108dp layer to a circle, squircle or rounded square; only the centre
// 66dp circle is guaranteed visible. k = 2.3 puts the tip of the waving arm on that circle's
// edge (measured: ~33dp from centre), so no launcher shape cuts the mascot. The lavender
// background is its own vector layer (drawable/ic_launcher_background.xml).
const K_ANDROID = 2.3;
const foreground = svg(108, mascotAt(K_ANDROID, 54, 54));
// Monochrome (Android 13 themed icons) reads ALPHA only: a solid silhouette with the face cut
// out, or the mascot would be a faceless blob tinted by the wallpaper.
const recolor = (s, c) => s.replace(/\b(fill|stroke)="(?!none)[^"]*"/g, `$1="${c}"`);
const faceStart = ART.indexOf('<g id="rig-face-welcome">');
const faceEnd = ART.indexOf('<g id="slot-eyewear"');
if (faceStart < 0 || faceEnd < faceStart) throw new Error('icon-mascot.svg has no rig-face-welcome group before slot-eyewear');
const face = ART.slice(faceStart, faceEnd);
const monochrome = svg(108,
  `<mask id="cut" maskUnits="userSpaceOnUse" x="0" y="0" width="108" height="108">`
  + mascotAt(K_ANDROID, 54, 54, recolor(ART, WHITE)) + mascotAt(K_ANDROID, 54, 54, recolor(face, '#000000'))
  + `</mask><rect width="108" height="108" fill="${WHITE}" mask="url(#cut)"/>`);
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [layer, body] of [['ic_launcher_foreground', foreground], ['ic_launcher_monochrome', monochrome]]) {
  const svgPath = path.join(TMP, `${layer}.svg`);
  fs.writeFileSync(svgPath, body);
  for (const [bucket, scale] of Object.entries(DENSITIES)) {
    const dir = path.join(RES, `mipmap-${bucket}`);
    fs.mkdirSync(dir, { recursive: true });
    render(svgPath, Math.round(108 * scale), path.join(dir, `${layer}.png`));
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('icons written: desktop/assets (icon, icon-mac, installer-icon) + app/src/main/res/mipmap-*');
