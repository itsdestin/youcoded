// @vitest-environment jsdom
import React, { useRef } from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useWallpaperHeaderInk } from '../src/renderer/hooks/use-wallpaper-header-ink';
import { join } from 'node:path';
import { RENDERER, readSource } from './helpers/guard-scope';

const theme = vi.hoisted(() => ({ activeTheme: { slug: 'picture', background: { type: 'image', value: '/picture.png' }, tokens: { 'fg-2': '#ffffff', panel: '#eeeeee' } }, themeApplied: 1 }));
vi.mock('../src/renderer/state/theme-context', () => ({ useTheme: () => theme }));
const cssVars = ['--wallpaper-header-ink', ...['red', 'green', 'blue', 'amber', 'gray'].map(c => `--wallpaper-status-${c}`)];
let decodes: Array<() => void>;
let observer: { notify: () => void; disconnect: () => void };
let tainted = false;
let draws: number;
let paintedColors: string[];
let wallpaperPixel: number[];
let viewportWidth: number;
let observed = 0;

function Header() {
  const ref = useRef<HTMLDivElement>(null);
  useWallpaperHeaderInk(ref);
  return <div ref={ref} className="header-bar"><div className="wide-view-toggle"><button aria-pressed="true">Icon</button></div><div className="session-strip"><span className="session-dot" data-status="green" /></div></div>;
}
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const header = () => document.querySelector<HTMLElement>('.header-bar')!;

beforeEach(() => {
  theme.activeTheme = { slug: 'picture', background: { type: 'image', value: '/picture.png' }, tokens: { 'fg-2': '#ffffff', panel: '#eeeeee' } };
  theme.themeApplied = 1;
  document.body.dataset.chromeStyle = 'float';
  document.documentElement.dataset.wallpaper = 'true';
  observed = 0;
  decodes = []; tainted = false; draws = 0; paintedColors = []; wallpaperPixel = [18, 30, 55];
  vi.stubGlobal('Image', class {
    crossOrigin = ''; naturalWidth = 800; naturalHeight = 600; src = '';
    decode() { return new Promise<void>(resolve => { decodes.push(resolve); }); }
  });
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { observer = { notify: callback, disconnect: vi.fn() }; }
    observe() { observed++; } disconnect() { observer.disconnect(); }
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    set fillStyle(value: string) { paintedColors.push(value); },
    get fillStyle() { return paintedColors.at(-1) ?? ''; },
    fillRect() {}, clearRect() {}, drawImage() { draws++; },
    getImageData(_x: number, _y: number, w: number, h: number) {
      if (tainted) throw new Error('tainted');
      return { data: new Uint8ClampedArray(Array.from({ length: w * h }, () => [...wallpaperPixel, 255]).flat()) };
    },
  }) as any);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, right: 120, bottom: 40, width: 120, height: 40, toJSON() {} }));
  // The hook coalesces its triggers on a timer; tests advance it explicitly.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  viewportWidth = 1024;
  vi.spyOn(window, 'innerWidth', 'get').mockImplementation(() => viewportWidth);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.removeAttribute('data-chrome-style'); document.documentElement.removeAttribute('data-wallpaper'); });

/** A window resize: the header's observer fires, then the coalescing timer
 *  runs the sample. A new width is a new crop of the wallpaper. */
async function resizeTo(width: number) {
  viewportWidth = width;
  await act(async () => { observer.notify(); });
  await act(async () => { vi.advanceTimersByTime(200); });
  await flush();
}

async function resolved() {
  expect(decodes.length).toBeGreaterThan(0);
  await act(async () => { decodes.at(-1)!(); });
  await flush();
}

describe('wallpaper header runtime', () => {
  it('does not sample solid, gradient or non-float chrome', () => {
    const view = render(<Header />);
    expect(decodes).toHaveLength(1);
    view.unmount();
    for (const [chrome, kind] of [['floating', 'image'], ['default', 'image'], ['float', 'gradient'], ['float', 'solid']]) {
      document.body.dataset.chromeStyle = chrome;
      theme.activeTheme = { ...theme.activeTheme, background: { type: kind, value: '/picture.png' } };
      const next = render(<Header />);
      expect(cssVars.every(v => !header().style.getPropertyValue(v))).toBe(true);
      next.unmount();
    }
    expect(decodes).toHaveLength(1);
  });

  it('sets only header variables after decode and clears immediately on a theme change or failed canvas', async () => {
    const view = render(<Header />);
    expect(header().style.getPropertyValue(cssVars[0])).toBe('');
    await resolved();
    expect(draws).toBeGreaterThan(0);
    expect(header().style.getPropertyValue(cssVars[0])).toMatch(/^rgb\(/);
    expect(header().style.getPropertyValue('--wallpaper-status-green')).toMatch(/^rgb\(/);
    expect(document.body.style.getPropertyValue(cssVars[0])).toBe('');
    theme.activeTheme = { ...theme.activeTheme, slug: 'second', background: { type: 'image', value: '/second.png' } };
    view.rerender(<Header />);
    expect(header().style.getPropertyValue(cssVars[0])).toBe('');
    expect(header().dataset.wallpaperInk).toBeUndefined();
    tainted = true;
    await resolved();
    expect(header().style.getPropertyValue(cssVars[0])).toBe('');
  });

  it('discards stale decode, resamples on resize, and disconnects on unmount', async () => {
    const view = render(<Header />);
    const stale = decodes[0];
    theme.activeTheme = { ...theme.activeTheme, slug: 'new' };
    view.rerender(<Header />);
    await act(async () => { stale(); });
    expect(header().style.getPropertyValue(cssVars[0])).toBe('');
    await resolved();
    const count = draws;
    const decodesBefore = decodes.length;
    // Three resize events in a burst are ONE sample, and the decoded image is reused.
    await act(async () => { observer.notify(); observer.notify(); window.dispatchEvent(new Event('resize')); });
    expect(draws).toBe(count);
    await resizeTo(1280);
    expect(draws).toBe(count + 1);
    expect(decodes.length).toBe(decodesBefore);
    // Same size again: the cached crop is reused, nothing is redrawn.
    await resizeTo(1280);
    expect(draws).toBe(count + 1);
    view.unmount();
    expect(observer.disconnect).toHaveBeenCalled();
    expect(header()?.style.getPropertyValue(cssVars[0])).toBeUndefined();
  });

  it('sets up no resize or session triggers outside the float style', () => {
    document.body.dataset.chromeStyle = 'default';
    const view = render(<Header />);
    expect(observed).toBe(0);
    view.unmount();
    document.body.dataset.chromeStyle = 'float';
    render(<Header />);
    expect(observed).toBe(1);
  });

  it('does not sample while its header is hidden under a screen, and catches up when shown', async () => {
    const view = render(<Header />);
    await resolved();
    const count = draws;
    header().style.visibility = 'hidden';
    await resizeTo(1280);
    expect(draws).toBe(count);
    header().style.visibility = '';
    const screen = document.createElement('div');
    document.body.append(screen);
    await act(async () => { screen.dataset.screenOpen = 'true'; });
    await act(async () => { screen.removeAttribute('data-screen-open'); });
    await act(async () => { vi.advanceTimersByTime(50); });
    await flush();
    expect(draws).toBe(count + 1);
    screen.remove();
    view.unmount();
  });

  it('retains stable ink during a resize decode and after a failed same-theme sample', async () => {
    function ClusterHeader() {
      const ref = useRef<HTMLDivElement>(null);
      useWallpaperHeaderInk(ref);
      return <div ref={ref} className="header-bar"><div className="header-controls-left"><button><svg /></button>
        <div className="session-strip"><span className="session-dot" data-status="green" /></div></div></div>;
    }
    const view = render(<ClusterHeader />);
    await resolved();
    const icon = header().querySelector<HTMLElement>('button')!;
    const dot = header().querySelector<HTMLElement>('.session-dot')!;
    const ink = header().style.getPropertyValue('--wallpaper-header-ink');
    const green = dot.style.getPropertyValue('--wallpaper-status-green');
    expect(ink).toMatch(/^rgb\(/);
    expect(icon.dataset.wallpaperControlInk).toBe('true');
    expect(green).toMatch(/^rgb\(/);
    viewportWidth = 1280;
    await act(async () => { observer.notify(); });
    // WHY: a pending replacement must not briefly expose the untuned theme ink.
    expect(header().style.getPropertyValue('--wallpaper-header-ink')).toBe(ink);
    expect(dot.style.getPropertyValue('--wallpaper-status-green')).toBe(green);
    expect(header().dataset.wallpaperInk).toBe('true');
    tainted = true;
    await act(async () => { vi.advanceTimersByTime(200); });
    await flush();
    expect(header().style.getPropertyValue('--wallpaper-header-ink')).toBe(ink);
    expect(dot.style.getPropertyValue('--wallpaper-status-green')).toBe(green);
    // Leaving the float style drops the calibration at once.
    document.body.dataset.chromeStyle = 'default';
    await flush();
    expect(header().style.getPropertyValue('--wallpaper-header-ink')).toBe('');
    expect(icon.dataset.wallpaperControlInk).toBeUndefined();
    expect(header().dataset.wallpaperInk).toBeUndefined();
    view.unmount();
  });

  it('changes the one shared tint when the wallpaper sample changes on resize', async () => {
    function TwoButtons() {
      const ref = useRef<HTMLDivElement>(null);
      useWallpaperHeaderInk(ref);
      return <div ref={ref} className="header-bar"><div className="header-controls-left"><button><svg /></button><button><svg /></button></div></div>;
    }
    render(<TwoButtons />);
    await resolved();
    const darkWallpaperInk = header().style.getPropertyValue('--wallpaper-header-ink');
    wallpaperPixel = [241, 237, 234];
    await resizeTo(1280);
    const lightWallpaperInk = header().style.getPropertyValue('--wallpaper-header-ink');
    expect(lightWallpaperInk).toMatch(/^rgb\(/);
    expect(lightWallpaperInk).not.toBe(darkWallpaperInk);
    for (const button of header().querySelectorAll('button')) {
      expect(button.dataset.wallpaperControlInk).toBe('true');
      expect(button.style.getPropertyValue('--wallpaper-header-ink')).toBe('');
    }
  });

  it('loads an image theme arriving after a solid theme without sessions', async () => {
    theme.activeTheme = { ...theme.activeTheme, background: { type: 'solid', value: '#111' } };
    const view = render(<Header />);
    expect(decodes).toHaveLength(0);
    theme.activeTheme = { ...theme.activeTheme, background: { type: 'image', value: '/picture.png' } };
    theme.themeApplied++;
    view.rerender(<Header />);
    await resolved();
    expect(header().style.getPropertyValue(cssVars[0])).toMatch(/^rgb\(/);
  });

  it('uses one adaptive light icon tint across mixed wallpaper controls while keeping strip status colors', async () => {
    theme.activeTheme = { ...theme.activeTheme, tokens: { 'fg-2': '#ECF3EA', panel: '#140e1a' } };
    const pixels: Record<number, number[]> = { 20: [177, 194, 201], 100: [48, 54, 68], 180: [219, 222, 231] };
    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({ backgroundColor: '' }) as CSSStyleDeclaration);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const x = this.dataset.x ? Number(this.dataset.x) : 100;
      return { x: x - 10, y: 0, left: x - 10, top: 0, right: x + 10, bottom: 40, width: 20, height: 40, toJSON() {} };
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      set fillStyle(value: string) { paintedColors.push(value); },
      get fillStyle() { return paintedColors.at(-1) ?? ''; },
      fillRect() {}, clearRect() {}, drawImage() { draws++; },
      getImageData(_x: number, _y: number, w: number, h: number) {
        if (w === 1 && h === 1) {
          const channels = paintedColors.at(-1)?.match(/\d+/g)?.slice(0, 3).map(Number) ?? [1, 2, 3];
          return { data: new Uint8ClampedArray([...channels, 255]) };
        }
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) {
          const color = pixels[i % w] ?? [56, 62, 78];
          data.set([...color, 255], i * 4);
        }
        return { data };
      },
    }) as any);
    function MixedHeader() {
      const ref = useRef<HTMLDivElement>(null);
      useWallpaperHeaderInk(ref);
      return <div ref={ref} className="header-bar">
        <div className="header-controls-left"><button data-x="20"><svg /></button><button data-x="100"><svg /></button><div className="session-strip" data-x="100"><span className="session-dot" data-x="100" data-status="green" /></div></div>
        <div className="header-controls-right"><div className="wide-view-toggle"><button data-x="180" aria-pressed="true"><svg /></button></div></div>
      </div>;
    }
    const view = render(<MixedHeader />);
    await resolved();
    const [left, middle, right] = [...header().querySelectorAll('button')];
    const shared = header().style.getPropertyValue('--wallpaper-header-ink');
    expect(shared).toMatch(/^rgb\(/);
    expect(left.style.getPropertyValue('--wallpaper-header-ink')).toBe('');
    expect(middle.style.getPropertyValue('--wallpaper-header-ink')).toBe('');
    expect(right.style.getPropertyValue('--wallpaper-header-ink')).toBe('');
    expect(left.dataset.wallpaperControlInk).toBe('true');
    expect(middle.dataset.wallpaperControlInk).toBe('true');
    expect(right.dataset.wallpaperControlInk).toBe('true');
    // WHY: wallpaper sampling may vary per button, but its icon ink must not.
    expect(shared).not.toBe('rgb(20 14 26)');
    expect(header().style.getPropertyValue('--wallpaper-status-green')).toBe('rgb(74 222 128)');
    expect(header().dataset.wallpaperInk).toBe('true');
    const css = readSource(join(RENDERER, 'styles/float-chrome.css'));
    expect(css).toMatch(/button\[data-wallpaper-control-ink\]:not\(\.bg-accent\)/);
    // WHY: Close is another clear header button, not a dark-colored exception.
    expect(css).not.toContain(":not([aria-label='Close'])");
    await act(async () => { observer.notify(); });
    expect(header().style.getPropertyValue('--wallpaper-header-ink')).toBe(shared);
    expect(header().dataset.wallpaperInk).toBe('true');
    await resolved();
    expect(header().style.getPropertyValue('--wallpaper-header-ink')).toBe(shared);
    view.unmount();
    expect(left.dataset.wallpaperControlInk).toBeUndefined();
    expect(right.dataset.wallpaperControlInk).toBeUndefined();
  });

  it('chooses readable ink for a bright image pixel blurred into a dark Golden header', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1440);
    theme.activeTheme = { ...theme.activeTheme, tokens: { 'fg-2': '#dcc898', panel: '#140e1a' } };
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element) => ({
      backgroundColor: '', backdropFilter: element.classList.contains('header-bar') ? 'blur(18px) saturate(1.2)' : 'none',
    }) as CSSStyleDeclaration);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      x: 1369, y: 0, left: 1369, top: 0, right: 1389, bottom: 40, width: 20, height: 40, toJSON() {},
    }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      set fillStyle(value: string) { paintedColors.push(value); },
      get fillStyle() { return paintedColors.at(-1) ?? ''; },
      fillRect() {}, clearRect() {}, drawImage() { draws++; },
      getImageData(_x: number, _y: number, w: number, h: number) {
        if (w === 1 && h === 1) return { data: new Uint8ClampedArray([1, 2, 3, 255]) };
        expect(h).toBeGreaterThan(40);
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) {
          const x = i % w, y = Math.floor(i / w);
          // WHY: the raw bright center of the maximize icon paints dark ink,
          // but its blurred neighborhood is dark and needs the light theme ink.
          data.set([...(Math.abs(x - 1379) < 3 && Math.abs(y - 20) < 3
            ? [152, 158, 184] : [104, 110, 120]), 255], i * 4);
        }
        return { data };
      },
    }) as any);
    function GoldenIcon() {
      const ref = useRef<HTMLDivElement>(null);
      useWallpaperHeaderInk(ref);
      return <div ref={ref} className="header-bar"><div className="header-controls-right"><button><svg /></button></div></div>;
    }
    render(<GoldenIcon />);
    await resolved();
    expect(header().style.getPropertyValue('--wallpaper-header-ink')).toBe('rgb(220 200 152)');
  });

  it('calibrates each actual dot and icon on a mixed Golden Sunbreak strip, including dots mounted later', async () => {
    theme.activeTheme = { ...theme.activeTheme, tokens: { 'fg-2': '#dcc898', panel: '#140e1a' } };
    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({ backgroundColor: '' }) as CSSStyleDeclaration);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const x = this.classList.contains('session-strip') ? 454 : Number(this.dataset.x ?? 63);
      const width = this.classList.contains('session-strip') ? 531 : 20;
      return { x, y: 0, left: x, top: 0, right: x + width, bottom: 40, width, height: 40, toJSON() {} };
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      set fillStyle(value: string) { paintedColors.push(value); },
      get fillStyle() { return paintedColors.at(-1) ?? ''; },
      fillRect() {}, clearRect() {}, drawImage() { draws++; },
      getImageData(_x: number, _y: number, w: number, h: number) {
        if (w === 1 && h === 1) return { data: new Uint8ClampedArray([1, 2, 3, 255]) };
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) {
          const x = i % w;
          data.set([...(x >= 700 ? [151, 164, 155] : x >= 454 ? [56, 62, 78] : [63, 68, 74]), 255], i * 4);
        }
        return { data };
      },
    }) as any);
    function GoldenHeader({ late }: { late: boolean }) {
      const ref = useRef<HTMLDivElement>(null);
      useWallpaperHeaderInk(ref);
      return <div ref={ref} className="header-bar"><div className="header-controls-left"><button data-x="63"><svg /></button>
        <div className="session-strip"><span className="session-dot" data-status="green" data-x="490" />
          {late && <span className="session-dot" data-status="red" data-x="800" />}</div></div></div>;
    }
    const view = render(<GoldenHeader late={false} />);
    await resolved();
    const icon = header().querySelector<HTMLElement>('button')!;
    const green = header().querySelector<HTMLElement>('[data-status="green"]')!;
    expect(header().style.getPropertyValue('--wallpaper-header-ink')).toMatch(/^rgb\(/);
    expect(header().dataset.wallpaperInk).toBe('true');
    expect(green.style.getPropertyValue('--wallpaper-status-green')).toMatch(/^rgb\(/);
    view.rerender(<GoldenHeader late={true} />);
    await flush();
    // A dot mounting later is sampled on the next tick, from the cached crop.
    await act(async () => { vi.advanceTimersByTime(50); });
    await flush();
    const red = header().querySelector<HTMLElement>('[data-status="red"]')!;
    expect(red.style.getPropertyValue('--wallpaper-status-red')).toMatch(/^rgb\(/);
    expect(red.style.getPropertyValue('--wallpaper-status-red')).not.toBe(green.style.getPropertyValue('--wallpaper-status-red'));
    view.unmount();
    expect(icon.style.getPropertyValue('--wallpaper-header-ink')).toBe('');
    expect(red.style.getPropertyValue('--wallpaper-status-red')).toBe('');
  });

  it('samples left controls after the Mac traffic-light decoration in both header shapes', async () => {
    function MacHeader({ bare }: { bare: boolean }) {
      const ref = useRef<HTMLDivElement>(null);
      useWallpaperHeaderInk(ref);
      return <div ref={ref} className="header-bar">
        <div className="traffic-lights" />
        <div className="header-controls-left"><button><svg /></button></div>
        {bare ? <div /> : <div className="session-strip"><span className="session-dot" data-status="green" /></div>}
        <div className="header-controls-right"><div><button><svg /></button></div></div>
      </div>;
    }
    for (const bare of [false, true]) {
      const view = render(<MacHeader bare={bare} />);
      await resolved();
      expect(header().querySelector('.header-controls-left button')?.getAttribute('data-wallpaper-control-ink')).toBe('true');
      view.unmount();
    }
  });

  it('converts rgb and oklch status swatches with a canvas while reading hex tokens directly', async () => {
    const original = window.getComputedStyle;
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element) => {
      if (element.classList.contains('bg-gray-500')) return { backgroundColor: 'oklch(0.55 0 0)' } as CSSStyleDeclaration;
      if (element.classList.contains('bg-green-400')) return { backgroundColor: 'rgb(74, 222, 128)' } as CSSStyleDeclaration;
      return original(element);
    });
    render(<Header />);
    await resolved();
    expect(paintedColors).toContain('oklch(0.55 0 0)');
    expect(paintedColors).toContain('rgb(74, 222, 128)');
    expect(paintedColors).not.toContain('#ffffff');
    expect(header().style.getPropertyValue('--wallpaper-status-gray')).toMatch(/^rgb\(/);
  });

  it('stops wallpaper dot breathing for both app and OS reduced-motion settings', () => {
    const css = readSource(join(RENDERER, 'styles/float-chrome.css')).replace(/\/\*[\s\S]*?\*\//g, '');
    const target = String.raw`\.session-strip \.session-dot\[data-wallpaper-dot-ink\]:not\(\[data-status='gray'\]\)`;
    expect(css).toMatch(new RegExp(String.raw`\[data-wallpaper\]\[data-reduced-effects\][^{}]*${target}[^{}]*\{\s*animation: none !important;`));
    expect(css).toMatch(new RegExp(String.raw`@media \(prefers-reduced-motion: reduce\)\s*\{[^{}]*${target}[^{}]*\{\s*animation: none !important;`));
  });

  it('scopes status color and animation rules to the wallpaper session strip', () => {
    const css = readSource(join(RENDERER, 'styles/float-chrome.css')).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const color of ['red', 'green', 'blue', 'amber', 'gray']) {
      expect(css).toContain(`.session-strip .session-dot[data-wallpaper-dot-ink][data-status='${color}']`);
    }
    expect(css).toContain('[data-wallpaper]');
    expect(css).toMatch(/--wallpaper-header-ink/);
    expect(css).toMatch(/--wallpaper-status-green/);
    expect(css).toMatch(/breathe/);
    expect(css).toMatch(/0\.8/);
    expect(css).not.toMatch(/StatusPill|\.status-bar \.session-dot/);
  });
});
