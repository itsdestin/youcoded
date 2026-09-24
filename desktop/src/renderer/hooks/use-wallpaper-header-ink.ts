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
    // True once this instance has written anything, so clear() and the triggers
    // below cost nothing for a theme or chrome style that never sampled.
    let applied = false;
    // WHY cached (code review 2026-09-24, F3/F4): every trigger re-decoded the
    // wallpaper and re-read the whole viewport. The decode is kept per effect run
    // (the effect re-runs when the theme or its image changes); the pixel strips
    // are kept until the window size or the controls' band moves.
    let decoded: Promise<HTMLImageElement> | null = null;
    let strips: { key: string; top: Uint8ClampedArray; topEnd: number; bottom: Uint8ClampedArray; bottomStart: number } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      if (!applied) return;
      applied = false;
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
    // WHY (F1): the chat header stays mounted but `visibility: hidden` under a
    // Projects/Pages screen, where ScreenBand samples for itself. A hidden header
    // keeps its last ink and resamples when the screen closes (see `screens`).
    const hidden = () => getComputedStyle(header).visibility === 'hidden';
    const decode = () => {
      decoded ??= (async () => {
        const image = new Image();
        // WHY: an image can paint successfully while a cross-origin canvas read is forbidden.
        image.crossOrigin = 'anonymous';
        image.src = src!;
        await image.decode();
        return image;
      })();
      return decoded;
    };
    const sample = () => {
      const version = ++generation;
      // WHY: same-theme resize/session changes keep the last calibrated ink while
      // decode runs; leaving float must drop it immediately instead.
      if (!eligible()) { clear(); return; }
      if (hidden()) return;
      // decode may throw or reject on a missing/CORS-blocked image.
      let decoding: Promise<HTMLImageElement>;
      try { decoding = decode(); } catch { return; }
      void decoding.then(image => {
        if (version !== generation || !eligible() || !image.naturalWidth || !image.naturalHeight) return;
        try {
          const width = Math.max(1, Math.ceil(window.innerWidth));
          const height = Math.max(1, window.innerHeight);
          // WHY: the glass behind a narrow icon mixes nearby wallpaper; the
          // center pixel alone can pick dark ink for a visibly dark blurred patch.
          // Cap the blur footprint and sample a bounded grid per control/dot.
          const blur = /blur\(([\d.]+)px\)/.exec(getComputedStyle(header).backdropFilter);
          const radius = blur ? Math.min(36, Math.max(0, Number(blur[1]) || 0)) : 0;
          const stripHeight = height;
          // Only two bands are read (F3): the header's, and — for the instance
          // that inks them — the bottom controls'. The wallpaper there can differ
          // entirely from the top, so both are real reads, not one full screen.
          const bottomControls = inkBottom
            ? [...document.querySelectorAll<HTMLElement>('.quick-chip, .quick-chip-edit, .status-bar > button, .status-bar .status-chip, .input-bar-container form')]
            : [];
          const topEnd = Math.min(height, Math.ceil(header.getBoundingClientRect().bottom + radius + 1));
          const bottomTops = bottomControls.map(element => element.getBoundingClientRect()).filter(r => r.width && r.height).map(r => r.top);
          const bottomStart = bottomTops.length ? Math.max(topEnd, Math.floor(Math.min(...bottomTops) - radius - 1)) : height;
          const key = `${width}x${height}:${topEnd}:${bottomStart}`;
          if (strips?.key !== key) {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) return;
            // Same viewport-fixed center/cover projection as #theme-bg, extending
            // below the header so a blurred icon near its bottom can read its neighbors.
            const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
            const paintedWidth = image.naturalWidth * scale;
            const paintedHeight = image.naturalHeight * scale;
            ctx.drawImage(image, (width - paintedWidth) / 2, (height - paintedHeight) / 2, paintedWidth, paintedHeight);
            strips = {
              key,
              top: ctx.getImageData(0, 0, width, Math.max(1, topEnd)).data,
              topEnd: Math.max(1, topEnd),
              bottom: bottomStart < height ? ctx.getImageData(0, bottomStart, width, height - bottomStart).data : new Uint8ClampedArray(0),
              bottomStart,
            };
          }
          const band = strips;
          const at = (x: number, y: number): RGB => {
            const column = Math.max(0, Math.min(width - 1, Math.round(x)));
            const row = Math.max(0, Math.min(stripHeight - 1, Math.round(y)));
            // A read between the bands (a blur footprint reaching past one)
            // clamps to the nearer band's edge row.
            const inBottom = band.bottom.length > 0 && row >= (band.topEnd + band.bottomStart) / 2;
            const data = inBottom ? band.bottom : band.top;
            const local = inBottom ? Math.max(0, row - band.bottomStart) : Math.min(band.topEnd - 1, row);
            const offset = (local * width + column) * 4;
            return [data[offset], data[offset + 1], data[offset + 2]];
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
          applied = true;
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
          for (const element of bottomControls) {
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
      }).catch(() => { decoded = null; /* Decode failed: retry next time; only a theme/eligibility change clears the old calibration. */ });
    };
    // WHY coalesced (F2): a window resize fires both `resize` and the header's
    // ResizeObserver, many times a second while dragging an edge. One sample
    // after the burst settles; the ink holds its last value meanwhile.
    const schedule = (delay: number) => {
      clearTimeout(timer);
      timer = setTimeout(sample, delay);
    };
    const resize = () => schedule(120);
    const observer = new ResizeObserver(resize);
    // WHY: session dots can mount after image decode without resizing the header.
    // Observe only strip membership; our own style/marker writes are attributes.
    const sessions = new MutationObserver(records => {
      if (records.some(record => (record.target as Element).closest?.('.session-strip')
        || [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element
          && (node.matches('.session-strip') || !!node.querySelector('.session-strip'))))) schedule(16);
    });
    // A Projects/Pages screen opening or closing hides or shows this header.
    const screens = new MutationObserver(() => schedule(16));
    // WHY (F5): the triggers exist only while float is on; every other style
    // keeps just the one attribute watch that notices float being turned on.
    let attached = false;
    const attach = (on: boolean) => {
      if (on === attached) return;
      attached = on;
      if (on) {
        observer.observe(header);
        sessions.observe(header, { childList: true, subtree: true });
        screens.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['data-screen-open'] });
        window.addEventListener('resize', resize);
      } else {
        observer.disconnect();
        sessions.disconnect();
        screens.disconnect();
        window.removeEventListener('resize', resize);
      }
    };
    const modeChanged = () => {
      attach(eligible());
      // Leaving float drops the ink at once (sample() clears when ineligible).
      clearTimeout(timer);
      sample();
    };
    const modes = new MutationObserver(modeChanged);
    modes.observe(document.body, { attributes: true, attributeFilter: ['data-chrome-style'] });
    modeChanged();
    return () => {
      generation++;
      clearTimeout(timer);
      clear();
      attach(false);
      modes.disconnect();
    };
  }, [headerRef, inkBottom, src, fg2, panel, activeTheme.slug, themeApplied]);
}
