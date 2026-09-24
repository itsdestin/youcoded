import { useLayoutEffect, type RefObject } from 'react';
import { useTheme } from '../state/theme-context';
import { contrastRatio, deriveWallpaperHeaderInk, type RGB } from '../themes/wallpaper-header-ink';

const STATUS_CLASSES = {
  red: 'bg-red-400', green: 'bg-green-400', blue: 'bg-blue-400', amber: 'bg-amber-400', gray: 'bg-gray-500',
} as const;
const FALLBACK_STATUS: Record<keyof typeof STATUS_CLASSES, RGB> = {
  red: [248, 113, 113], green: [74, 222, 128], blue: [96, 165, 250], amber: [251, 191, 36], gray: [107, 114, 128],
};
const PROPS = ['--wallpaper-header-ink', ...Object.keys(STATUS_CLASSES).map(key => `--wallpaper-status-${key}`)];

/** Browser's color engine handles rgb(), oklch() and color(srgb); hex theme tokens avoid a canvas round trip. */
function parseColor(value: string, context: CanvasRenderingContext2D): RGB | null {
  const text = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const full = hex[1].length === 3 ? [...hex[1]].map(c => c + c).join('') : hex[1];
    return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16)) as unknown as RGB;
  }
  if (!/^(rgb\(|rgba\(|oklch\(|color\()/i.test(text)) return null;
  try {
    // WHY: canvas silently keeps its previous fillStyle when CSS is invalid.
    context.fillStyle = '#010203';
    context.fillStyle = text;
    if (context.fillStyle === '#010203' && text.toLowerCase() !== '#010203') return null;
    context.clearRect(0, 0, 1, 1);
    context.fillRect(0, 0, 1, 1);
    const data = context.getImageData(0, 0, 1, 1).data;
    return data[3] === 255 ? [data[0], data[1], data[2]] : null;
  } catch { return null; }
}

function statusColors(context: CanvasRenderingContext2D) {
  const swatch = document.createElement('span');
  swatch.style.display = 'none';
  document.body.appendChild(swatch);
  try {
    return Object.fromEntries(Object.entries(STATUS_CLASSES).map(([key, className]) => {
      swatch.className = className;
      const value = getComputedStyle(swatch).backgroundColor;
      return [key, parseColor(value, context) ?? FALLBACK_STATUS[key as keyof typeof STATUS_CLASSES]];
    })) as Record<keyof typeof STATUS_CLASSES, RGB>;
  } finally { swatch.remove(); }
}

/** When no tuned ink reads everywhere under a control, the better of the
 *  theme's own dark and light text for that spot — never an off-palette colour. */
function readableOf(a: RGB, b: RGB, pixels: readonly RGB[]): string {
  const worst = (c: RGB) => Math.min(...pixels.map(p => contrastRatio(c, p)));
  const pick = worst(a) >= worst(b) ? a : b;
  return `rgb(${pick.join(' ')})`;
}

/** CSS overrides belong to the header, not the theme tokens or the global status palette.
 *  `inkBottom: false` — for a header that does not own the chat's bottom controls
 *  (ScreenBand over Projects/Pages). WHY: every instance clears what it wrote on
 *  unmount, so a second instance inking the SAME bottom controls would strip the
 *  chat header's ink when the screen closed. */
export function useWallpaperHeaderInk(headerRef: RefObject<HTMLDivElement | null>, { inkBottom = true }: { inkBottom?: boolean } = {}) {
  const { activeTheme, themeApplied } = useTheme();
  const background = activeTheme.background;
  const src = background?.type === 'image' ? background.value : null;
  const fg2 = activeTheme.tokens['fg-2'];
  const panel = activeTheme.tokens.panel;

  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    let generation = 0;
    let tintedControls: HTMLElement[] = [];
    let tintedDots: HTMLElement[] = [];
    let inkedBottom: HTMLElement[] = [];
    const clear = () => {
      for (const control of tintedControls) {
        control.style.removeProperty('--wallpaper-header-ink');
        control.removeAttribute('data-wallpaper-control-ink');
      }
      tintedControls = [];
      for (const dot of tintedDots) {
        for (const key of Object.keys(STATUS_CLASSES)) dot.style.removeProperty(`--wallpaper-status-${key}`);
        dot.removeAttribute('data-wallpaper-dot-ink');
      }
      tintedDots = [];
      for (const name of PROPS) header.style.removeProperty(name);
      header.removeAttribute('data-wallpaper-ink');
      for (const element of inkedBottom) {
        element.style.removeProperty('--control-ink');
        delete element.dataset.bottomInk;
      }
      inkedBottom = [];
    };
    // WHY: only the float chrome style is see-through enough to need this; every
    // other theme and chrome style never runs the sampler at all.
    const eligible = () => !!src && document.body.dataset.chromeStyle === 'float';
    const sample = () => {
      const version = ++generation;
      // WHY: same-theme resize/session changes keep the last calibrated ink while
      // decode runs; leaving float must drop it immediately instead.
      if (!eligible()) { clear(); return; }
      let image: HTMLImageElement;
      try {
        image = new Image();
        // WHY: an image can paint successfully while a cross-origin canvas read is forbidden.
        image.crossOrigin = 'anonymous';
        image.src = src!;
      } catch { return; }
      // decode may throw or reject on a missing/CORS-blocked image.
      let decoding: Promise<void>;
      try { decoding = image.decode(); } catch { return; }
      void decoding.then(() => {
        if (version !== generation || !eligible() || !image.naturalWidth || !image.naturalHeight) return;
        try {
          const width = Math.max(1, Math.ceil(window.innerWidth));
          const height = Math.max(1, window.innerHeight);
          // WHY: the glass behind a narrow icon mixes nearby wallpaper; the
          // center pixel alone can pick dark ink for a visibly dark blurred patch.
          // Cap the blur footprint and sample a bounded grid per control/dot.
          const blur = /blur\(([\d.]+)px\)/.exec(getComputedStyle(header).backdropFilter);
          const radius = blur ? Math.min(36, Math.max(0, Number(blur[1]) || 0)) : 0;
          // WHY full height: the bottom chrome (chips, composer, status) needs
          // its own ink — the wallpaper there can differ entirely from the top.
          const stripHeight = height;
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = stripHeight;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) return;
          // Same viewport-fixed center/cover projection as #theme-bg, extending
          // below the header so a blurred icon near its bottom can read its neighbors.
          const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
          const paintedWidth = image.naturalWidth * scale;
          const paintedHeight = image.naturalHeight * scale;
          ctx.drawImage(image, (width - paintedWidth) / 2, (height - paintedHeight) / 2, paintedWidth, paintedHeight);
          const pixels = ctx.getImageData(0, 0, width, stripHeight).data;
          const at = (x: number, y: number): RGB => {
            const offset = (Math.max(0, Math.min(stripHeight - 1, Math.round(y))) * width
              + Math.max(0, Math.min(width - 1, Math.round(x)))) * 4;
            return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
          };
          const neighborhood = (x: number, y: number): RGB => {
            if (!radius) return at(x, y);
            const sums = [0, 0, 0];
            let count = 0;
            // At most 13 x 13 reads per element, independent of viewport size.
            const step = Math.max(3, Math.ceil(radius / 6));
            for (let dy = -radius; dy <= radius; dy += step) {
              for (let dx = -radius; dx <= radius; dx += step) {
                const pixel = at(x + dx, y + dy);
                for (let channel = 0; channel < 3; channel++) sums[channel] += pixel[channel];
                count++;
              }
            }
            return sums.map(sum => Math.round(sum / count)) as unknown as RGB;
          };
          // WHY: Mac traffic lights are a preceding decorative sibling, not the left cluster.
          const controls = header.querySelectorAll<HTMLElement>('.header-controls-left > button, .header-controls-left > div:not(.wide-view-toggle) > button, .header-controls-right > button, .header-controls-right > div > button, .wide-view-toggle > button');
          const center = (element: Element) => {
            const r = element.getBoundingClientRect();
            return r.width > 0 && r.height > 0 ? neighborhood(r.left + r.width / 2, r.top + r.height / 2) : null;
          };
          const controlPixels = [...controls].map(center).filter((pixel): pixel is RGB => !!pixel);
          const dots = header.querySelectorAll<HTMLElement>('.session-strip .session-dot');
          const strip = header.querySelector('.session-strip')?.getBoundingClientRect();
          if (!controlPixels.length) controlPixels.push(neighborhood(16, Math.min(20, stripHeight - 1)));
          const swatch = document.createElement('canvas');
          swatch.width = swatch.height = 1;
          const painter = swatch.getContext('2d', { willReadFrequently: true });
          if (!painter) return;
          const foreground = parseColor(fg2, painter);
          const surface = parseColor(panel, painter);
          if (!foreground || !surface) return;
          const palette = statusColors(painter);
          // WHY: the approved design has ONE theme-derived icon tint across the
          // header. The central session-strip sample follows wallpaper/viewport
          // changes without making adjacent buttons alternate light and dark.
          // Status dots still need their own local semantic contrast.
          const solve = (pixel: RGB) => deriveWallpaperHeaderInk({ controlPixels: [pixel], dotPixels: [pixel], fg2: foreground, panel: surface, statusColors: palette });
          const stripPixel = strip && strip.width > 0 ? neighborhood(strip.left + strip.width / 2, strip.top + strip.height / 2) : controlPixels[Math.floor(controlPixels.length / 2)];
          const stripResult = stripPixel && solve(stripPixel);
          const localDots = [...dots].map(dot => ({ dot, pixel: center(dot) }))
            .filter((entry): entry is { dot: HTMLElement; pixel: RGB } => !!entry.pixel)
            .map(({ dot, pixel }) => ({ dot, result: solve(pixel) }));
          if (version !== generation || !eligible()) return;
          // WHY: replace as one synchronous commit only after the entire new crop
          // has been read and solved. Failed reads leave the stable sample intact.
          if (!stripResult && !localDots.some(entry => entry.result)) return;
          clear();
          if (stripResult) {
            header.style.setProperty('--wallpaper-header-ink', stripResult.ink);
            for (const [key, value] of Object.entries(stripResult.statuses)) header.style.setProperty(`--wallpaper-status-${key}`, value);
          }
          if (stripResult || localDots.some(entry => entry.result)) header.dataset.wallpaperInk = 'true';
          // WHY: Destin chose see-through bottom controls (2026-09-23); their
          // theme text is tuned for a solid panel and vanished over wallpaper.
          // Each control gets its OWN ink: one shared ink found no answer on a
          // wallpaper that is dark on one side and bright on the other (Golden
          // Sunbreak), and the text fell back to invisible theme gold.
          if (inkBottom) for (const element of document.querySelectorAll<HTMLElement>('.quick-chip, .quick-chip-edit, .status-bar > button, .status-bar .status-chip, .input-bar-container form')) {
            const r = element.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            // A wide composer crosses several wallpaper areas: sample across it.
            const xs = r.width > 200 ? [.1, .3, .5, .7, .9] : [.5];
            const pixels = xs.map(f => neighborhood(r.left + r.width * f, r.top + r.height / 2));
            const solved = deriveWallpaperHeaderInk({ controlPixels: pixels, dotPixels: [pixels[0]], fg2: foreground, panel: surface, statusColors: palette });
            element.style.setProperty('--control-ink', solved?.ink ?? readableOf(foreground, surface, pixels));
            element.dataset.bottomInk = 'true';
            inkedBottom.push(element);
          }
          for (const { dot, result } of localDots) {
            if (!result) continue;
            for (const [key, value] of Object.entries(result.statuses)) dot.style.setProperty(`--wallpaper-status-${key}`, value);
            dot.dataset.wallpaperDotInk = 'true';
            tintedDots.push(dot);
          }
          if (stripResult) for (const control of controls) {
            control.dataset.wallpaperControlInk = 'true';
            tintedControls.push(control);
          }
        } catch { /* Canvas taint or unreadable colors: keep the last valid same-theme calibration. */ }
      }).catch(() => { /* Decode failed; only a theme/eligibility change clears the old calibration. */ });
    };
    sample();
    const resize = () => sample();
    const observer = new ResizeObserver(resize);
    observer.observe(header);
    const modes = new MutationObserver(resize);
    modes.observe(document.body, { attributes: true, attributeFilter: ['data-chrome-style'] });
    // WHY: session dots can mount after image decode without resizing the header.
    // Observe only strip membership; our own style/marker writes are attributes.
    const sessions = new MutationObserver(records => {
      if (records.some(record => (record.target as Element).closest?.('.session-strip')
        || [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element
          && (node.matches('.session-strip') || !!node.querySelector('.session-strip'))))) sample();
    });
    sessions.observe(header, { childList: true, subtree: true });
    window.addEventListener('resize', resize);
    return () => {
      generation++;
      clear();
      observer.disconnect();
      modes.disconnect();
      sessions.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, [headerRef, inkBottom, src, fg2, panel, activeTheme.slug, themeApplied]);
}
