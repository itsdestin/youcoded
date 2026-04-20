import type { ThemeTokens } from './theme-types';

/**
 * Builds a theme-tinted variant of the default YouCoded app icon as an SVG
 * string. Same shape as desktop/assets/icon.svg — the canonical Y/C terminal
 * glyph — recolored with the active theme's own tokens so every theme gets a
 * matching window + dock icon without shipping per-theme artwork.
 *
 * Pure function. Safe to call on any thread. Handles light and dark themes by
 * leaning on `canvas` (background) and `fg` (foreground) — their contrast is
 * already guaranteed by the theme's own readability.
 */
export function buildDefaultIconSvg(tokens: ThemeTokens): string {
  const bg = tokens.canvas;
  const chrome = tokens['fg-muted']; // terminal bars + border — low-contrast line art
  const accent = tokens.accent;      // chevron + cursor — adds the theme's pop color
  const letter1 = tokens.fg;         // 'Y' — primary foreground
  const letter2 = tokens['fg-2'];    // 'C' — secondary foreground, subtle separation
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 40 40">
  <rect width="40" height="40" rx="4" fill="${bg}"/>
  <rect x="0.75" y="0.75" width="38.5" height="38.5" rx="4" fill="none" stroke="${chrome}" stroke-opacity="0.45" stroke-width="1.2"/>
  <line x1="5" y1="6" x2="35" y2="6" stroke="${chrome}" stroke-opacity="0.4" stroke-width="0.8" stroke-linecap="round"/>
  <line x1="5" y1="34" x2="35" y2="34" stroke="${chrome}" stroke-opacity="0.4" stroke-width="0.8" stroke-linecap="round"/>
  <path d="M4.2,17.2 L6.4,17.2 L9.2,20.5 L6.4,23.8 L4.2,23.8 L7,20.5 Z" fill="${accent}"/>
  <g transform="translate(12.8,24.0) scale(0.00550,-0.00550)">
    <path d="M1114,1307 L685,463 L685,0 L435,0 L435,461 L10,1307 L283,1307 L475,903 L563,705 L651,909 L852,1307 L1114,1307 Z" fill="${letter1}" stroke="${letter1}" stroke-width="25" stroke-linejoin="round"/>
  </g>
  <g transform="translate(19.6,24.0) scale(0.00550,-0.00550)">
    <path d="M1004,51 Q917,16 835.5,-1 Q754,-18 666,-18 Q525,-18 416.5,23.5 Q308,65 233.5,147 Q159,229 120.5,350.5 Q82,472 82,633 Q82,798 124,926.5 Q166,1055 244,1143.5 Q322,1232 433.5,1278.5 Q545,1325 684,1325 Q729,1325 768.5,1323 Q808,1321 846,1315.5 Q884,1310 923,1301 Q962,1292 1004,1278 L1004,1034 Q919,1074 842,1091 Q765,1108 702,1108 Q609,1108 543,1074.5 Q477,1041 434.5,980.5 Q392,920 372,836.5 Q352,753 352,653 Q352,547 372.5,463.5 Q393,380 436,322 Q479,264 546,233.5 Q613,203 705,203 Q738,203 776.5,209.5 Q815,216 854.5,226.5 Q894,237 932.5,251.5 Q971,266 1004,281 Z" fill="${letter2}" stroke="${letter2}" stroke-width="25" stroke-linejoin="round"/>
  </g>
  <rect x="30" y="15" width="6" height="11" rx="0.5" fill="${accent}" fill-opacity="0.6"/>
</svg>`;
}

/**
 * Rasterizes an SVG string to a PNG data URL via an offscreen canvas.
 * Browser-only — depends on Image, Blob, URL, and HTMLCanvasElement.
 * Returns null if anything fails (caller should fall back to the bundled icon).
 */
export async function rasterizeSvgToPngDataUrl(svg: string, size = 256): Promise<string | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.width = size;
    img.height = size;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('svg image load failed'));
      img.src = objectUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, size, size);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
