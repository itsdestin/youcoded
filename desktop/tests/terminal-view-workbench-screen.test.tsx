// @vitest-environment jsdom
//
// UI Workbench terminal mock-ups (ledger P-20.1 / P-20.2, 2026-08-27):
//   1. under `?mode=workbench` TerminalView writes the canned Claude Code screen
//      (there is no PTY, so the pane used to be blank);
//   2. `?termBacking=solid90` switches xterm to an opaque --panel background at
//      grid opacity 0.9; `today` (or no param) applies no override — it is the
//      theme engine's shipped surface;
//   3. outside workbench mode — the app — NOTHING is written and no variant is
//      applied, whatever the URL says.
//
// The SHIPPED surface (P-20.2, decided 2026-08-27), pinned in the last block:
//   - wallpaper / gradient theme → xterm paints --panel, the grid container is
//     filled with var(--panel) at var(--terminal-xterm-opacity), which the
//     engine floors at 0.8 (a pack's 0.4 becomes 0.8; its 0.9 is honoured);
//   - flat theme → byte-identical to before: --canvas, opacity 1 (or the
//     theme's own value when it only declares panels-blur).
//
// xterm mocks mirror tests/terminal-view-touch-mode.test.tsx.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

const terminalCtorArgs: any[] = [];
const writeSpy = vi.fn();

vi.mock('@xterm/xterm', () => {
  return {
    Terminal: vi.fn(function (this: any, opts: any) {
      terminalCtorArgs.push(opts);
      this.loadAddon = vi.fn();
      this.open = vi.fn();
      this.unicode = { activeVersion: '11' };
      this.attachCustomKeyEventHandler = vi.fn();
      this.onData = vi.fn();
      this.onScroll = vi.fn().mockReturnValue({ dispose: vi.fn() });
      this.write = writeSpy;
      this.refresh = vi.fn();
      this.focus = vi.fn();
      this.blur = vi.fn();
      this.dispose = vi.fn();
      this.clearTextureAtlas = vi.fn();
      this.hasSelection = vi.fn().mockReturnValue(false);
      this.getSelection = vi.fn().mockReturnValue('');
      this.paste = vi.fn();
      this.options = {};
      this.cols = 100;
      this.rows = 30;
      this.buffer = { active: { length: 30, viewportY: 0, ydisp: 0 } };
      this.scrollLines = vi.fn();
    }),
  };
});

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(function (this: any) {
    this.fit = vi.fn();
    this.proposeDimensions = vi.fn().mockReturnValue({ cols: 100, rows: 30 });
  }),
}));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: vi.fn(function (this: any) {}) }));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn(function (this: any) {
    this.onContextLoss = vi.fn();
    this.dispose = vi.fn();
  }),
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('../src/renderer/platform', () => ({
  isAndroid: vi.fn().mockReturnValue(false),
  isTouchDevice: vi.fn().mockReturnValue(false),
  getPlatform: vi.fn().mockReturnValue('electron'),
}));
// Mutable so the shipped-surface block below can switch between a flat theme
// (null — the four built-ins declare no `background`) and wallpaper/gradient
// themes without re-mocking the module.
let mockActiveTheme: any = null;
vi.mock('../src/renderer/state/theme-context', () => ({
  useTheme: () => ({ activeTheme: mockActiveTheme, reducedEffects: false }),
}));
vi.mock('../src/renderer/hooks/terminal-registry', () => ({
  registerTerminal: vi.fn(),
  unregisterTerminal: vi.fn(),
  notifyBufferReady: vi.fn(),
}));
vi.mock('../src/renderer/hooks/useIpc', () => ({ usePtyOutput: vi.fn() }));
vi.mock('../src/renderer/hooks/usePtyRawBytes', () => ({ usePtyRawBytes: vi.fn() }));

import { join } from 'node:path';
import { readSource } from './helpers/guard-scope';
import TerminalView from '../src/renderer/components/TerminalView';
import { renderTerminalScreen } from '../src/renderer/dev/workbench/fixtures/terminal-screen';
import { applyThemeToDom } from '../src/renderer/themes/theme-engine';
import type { ThemeDefinition } from '../src/renderer/themes/theme-types';

// A minimal valid theme. Tokens are only needed so applyThemeToDom can write
// them; the values are irrelevant to what is asserted here.
function makeTheme(background: ThemeDefinition['background']): ThemeDefinition {
  return {
    name: 'T', slug: 't', dark: true,
    tokens: {
      canvas: '#0D0F1A', panel: '#141726', inset: '#1F2440', well: '#0D0F1A',
      accent: '#7C6AF7', 'on-accent': '#FFFFFF',
      fg: '#C4BFFF', 'fg-2': '#9090C0', 'fg-dim': '#6060A0',
      'fg-muted': '#404070', 'fg-faint': '#282848',
      edge: '#2A2F55', 'edge-dim': '#2A2F5580',
      'scrollbar-thumb': '#2A2F55', 'scrollbar-hover': '#3A3F70',
    },
    background,
  };
}
const WALLPAPER = { type: 'image' as const, value: 'theme-asset://meadow/wallpaper.jpg' };

// The detection reads `location.search` at mount, exactly as index.tsx and
// WorkbenchFrame do — so the tests drive it through the real URL rather than a
// mocked helper. `import.meta.env.DEV` is true under vitest.
function setUrl(search: string) {
  window.history.replaceState({}, '', `/${search}`);
}

// jsdom lays nothing out, so every element is 0×0 and TerminalView's fit
// guard ("skip when collapsed") would never run a fit — and the canned screen
// is written on the first fit that runs. Give the grid container a size so the
// mount-timer fit goes through, exactly as it does once the pane is visible.
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 1200; } });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 700; } });

const container = () => document.querySelector('[data-term-backing]') as HTMLElement;

beforeEach(() => {
  terminalCtorArgs.length = 0;
  writeSpy.mockReset();
  mockActiveTheme = null;
  (globalThis as any).window.claude = {
    session: { signalReady: vi.fn(), sendInput: vi.fn(), resize: vi.fn() },
  };
});

afterEach(() => {
  cleanup();
  setUrl('');
  delete (globalThis as any).window.claude;
});

describe('TerminalView in the UI Workbench (?mode=workbench)', () => {
  it('writes the canned Claude Code screen once, sized to the terminal grid', async () => {
    setUrl('?mode=workbench');
    render(<TerminalView sessionId="s1" visible={true} />);
    // The write is scheduled behind the 100ms initial-fit timer plus a dynamic
    // import; waitFor polls until it lands.
    await waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1));
    const text: string = writeSpy.mock.calls[0][0];
    expect(text).toContain('Claude Code v2');
    expect(text).toContain('/home/destin/youcoded-dev/youcoded');
    expect(text).toContain('› ');
    expect(text).toContain('? for shortcuts');
    // Built for the mocked 100×30 grid — the fixture pads to the row count and
    // rules the prompt box across the column count.
    expect(text).toBe(renderTerminalScreen(100, 30));
    // Later fits (window resize → fitAndSync) must not write it again.
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 50));
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it('writes nothing until a fit actually runs (a collapsed 0×0 container skips the fit)', async () => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 0; } });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 0; } });
    try {
      setUrl('?mode=workbench');
      render(<TerminalView sessionId="s1" visible={true} />);
      await new Promise((r) => setTimeout(r, 300));
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 1200; } });
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 700; } });
    }
  });

  // jsdom's getComputedStyle returns '' for every CSS variable, so xterm's
  // theme falls back to getXtermTheme's literal defaults: '#0A0A0A' for the
  // canvas token, '#191919' for the panel token. Asserting those tells the two
  // tokens apart without a real stylesheet.
  const CANVAS_FALLBACK = '#0A0A0A';
  const PANEL_FALLBACK = '#191919';

  it('`today` (the default) applies no override: the shipped surface — on a flat theme, opacity 1 and a --canvas xterm', () => {
    setUrl('?mode=workbench&termBacking=today');
    render(<TerminalView sessionId="s1" visible={true} />);
    expect(container().dataset.termBacking).toBe('today');
    // Flat theme (activeTheme null) → shipped path forces opacity 1 and paints
    // --canvas on the grid container.
    expect(container().style.opacity).toBe('1');
    expect(container().style.backgroundColor).toBe('var(--canvas)');
    expect(terminalCtorArgs[0].allowTransparency).toBeUndefined();
    expect(terminalCtorArgs[0].theme.background).toBe(CANVAS_FALLBACK);
  });

  it('`solid90` paints an opaque --panel xterm with the grid at 0.9', () => {
    setUrl('?mode=workbench&termBacking=solid90');
    render(<TerminalView sessionId="s1" visible={true} />);
    expect(container().dataset.termBacking).toBe('solid90');
    expect(container().style.opacity).toBe('0.9');
    expect(container().style.backgroundColor).toBe('var(--panel)');
    // Still opaque — no allowTransparency (see workbench-mode.ts for why).
    expect(terminalCtorArgs[0].allowTransparency).toBeUndefined();
    expect(terminalCtorArgs[0].theme.background).toBe(PANEL_FALLBACK);
  });

  it('`solid100` is the same --panel xterm, fully opaque', () => {
    setUrl('?mode=workbench&termBacking=solid100');
    render(<TerminalView sessionId="s1" visible={true} />);
    expect(container().dataset.termBacking).toBe('solid100');
    expect(container().style.opacity).toBe('1');
    expect(container().style.backgroundColor).toBe('var(--panel)');
    expect(terminalCtorArgs[0].theme.background).toBe(PANEL_FALLBACK);
  });

  it('`today` on a wallpaper theme is the shipped P-20.2 surface: --panel xterm, panel-filled grid at the engine\'s opacity', () => {
    mockActiveTheme = makeTheme(WALLPAPER);
    setUrl('?mode=workbench&termBacking=today');
    render(<TerminalView sessionId="s1" visible={true} />);
    expect(container().dataset.termBacking).toBe('today');
    expect(container().style.opacity).toBe('var(--terminal-xterm-opacity)');
    expect(container().style.backgroundColor).toBe('var(--panel)');
    expect(terminalCtorArgs[0].theme.background).toBe(PANEL_FALLBACK);
    // No variant → the engine's --terminal-backing is left alone.
    expect(container().style.getPropertyValue('--terminal-backing')).toBe('');
  });

  it('`legacy` reproduces the pre-decision surface for Before shots: --canvas xterm at a literal 0.6, even on a wallpaper theme', () => {
    mockActiveTheme = makeTheme(WALLPAPER);
    setUrl('?mode=workbench&termBacking=legacy');
    render(<TerminalView sessionId="s1" visible={true} />);
    expect(container().dataset.termBacking).toBe('legacy');
    expect(container().style.opacity).toBe('0.6');
    // A canvas variant on a see-through theme leaves the container unfilled
    // (the wallpaper layer shows through), exactly as the old code did.
    expect(container().style.backgroundColor).toBe('');
    expect(terminalCtorArgs[0].theme.background).toBe(CANVAS_FALLBACK);
    // The variant re-points the viewport-strip token at its own colour so the
    // engine's panel value can't leak a mismatched strip under a canvas grid.
    expect(container().style.getPropertyValue('--terminal-backing')).toBe('var(--canvas)');
  });

  it('`scrim` keeps the --canvas xterm (the legacy mechanism) and raises the grid opacity to 0.85', () => {
    setUrl('?mode=workbench&termBacking=scrim');
    render(<TerminalView sessionId="s1" visible={true} />);
    expect(container().dataset.termBacking).toBe('scrim');
    expect(container().style.opacity).toBe('0.85');
    expect(container().style.backgroundColor).toBe('var(--canvas)');
    expect(terminalCtorArgs[0].theme.background).toBe(CANVAS_FALLBACK);
  });

  it('an unknown termBacking value falls back to `today`', () => {
    setUrl('?mode=workbench&termBacking=nonsense');
    render(<TerminalView sessionId="s1" visible={true} />);
    expect(container().dataset.termBacking).toBe('today');
    expect(container().style.backgroundColor).toBe('var(--canvas)');
  });
});

describe('TerminalView in the app (no ?mode=workbench)', () => {
  it('writes nothing and applies no variant even if ?termBacking= is present', async () => {
    setUrl('?termBacking=solid90');
    render(<TerminalView sessionId="s1" visible={true} />);
    // Give the 100ms initial-fit timer (and any import it might have kicked
    // off) ample time to run before asserting the negative.
    await new Promise((r) => setTimeout(r, 300));
    expect(writeSpy).not.toHaveBeenCalled();
    expect(container().dataset.termBacking).toBe('today');
    expect(container().style.opacity).toBe('1');
    expect(container().style.backgroundColor).toBe('var(--canvas)');
    expect(terminalCtorArgs[0].allowTransparency).toBeUndefined();
    expect(terminalCtorArgs[0].theme.background).toBe('#0A0A0A');
  });
});

describe('the shipped terminal surface (P-20.2 guarantee, app mode)', () => {
  const root = () => document.documentElement;

  // applyThemeToDom writes the theme's tokens as inline custom properties on
  // <html>, and jsdom's getComputedStyle DOES return those — so here xterm
  // receives the theme's actual --panel / --canvas colour (from makeTheme's
  // tokens), not getXtermTheme's literal fallbacks. That is the real contract:
  // xterm paints the theme's panel token under a wallpaper.
  const THEME_PANEL = '#141726';
  const THEME_CANVAS = '#0D0F1A';

  afterEach(() => {
    // Drop every inline token/var the engine wrote so cases can't bleed.
    root().removeAttribute('style');
    root().removeAttribute('data-wallpaper');
  });

  it('flat theme: byte-identical to before — --canvas xterm, container filled with var(--canvas) at opacity 1, engine emits 0.6 / var(--canvas)', () => {
    const theme = makeTheme(undefined);
    applyThemeToDom(theme);
    mockActiveTheme = theme;
    render(<TerminalView sessionId="s1" visible={true} />);
    expect(root().hasAttribute('data-wallpaper')).toBe(false);
    expect(root().style.getPropertyValue('--terminal-xterm-opacity')).toBe('0.6');
    expect(root().style.getPropertyValue('--terminal-backing')).toBe('var(--canvas)');
    expect(container().style.opacity).toBe('1');
    expect(container().style.backgroundColor).toBe('var(--canvas)');
    expect(terminalCtorArgs[0].allowTransparency).toBeUndefined();
    expect(terminalCtorArgs[0].theme.background).toBe(THEME_CANVAS);
  });

  it('flat theme with only panels-blur: still the old see-through canvas path (unfilled container at the theme opacity)', () => {
    const theme = makeTheme({ type: 'solid', value: '#000', 'panels-blur': 12, 'terminal-opacity': 0.5 });
    applyThemeToDom(theme);
    mockActiveTheme = theme;
    render(<TerminalView sessionId="s1" visible={true} />);
    // No background layer → no [data-wallpaper], no floor, canvas backing.
    expect(root().hasAttribute('data-wallpaper')).toBe(false);
    expect(root().style.getPropertyValue('--terminal-xterm-opacity')).toBe('0.5');
    expect(root().style.getPropertyValue('--terminal-backing')).toBe('var(--canvas)');
    expect(container().style.opacity).toBe('var(--terminal-xterm-opacity)');
    expect(container().style.backgroundColor).toBe('');
    expect(terminalCtorArgs[0].theme.background).toBe(THEME_CANVAS);
  });

  it('wallpaper theme: xterm paints --panel, the container is filled with var(--panel) at the engine opacity, which defaults to the 0.8 floor', () => {
    const theme = makeTheme(WALLPAPER);
    applyThemeToDom(theme);
    mockActiveTheme = theme;
    render(<TerminalView sessionId="s1" visible={true} />);
    // The signal is the one that gates every glass rule: [data-wallpaper].
    expect(root().hasAttribute('data-wallpaper')).toBe(true);
    expect(root().style.getPropertyValue('--terminal-xterm-opacity')).toBe('0.8');
    expect(root().style.getPropertyValue('--terminal-backing')).toBe('var(--panel)');
    expect(container().style.opacity).toBe('var(--terminal-xterm-opacity)');
    expect(container().style.backgroundColor).toBe('var(--panel)');
    // Opaque xterm, on purpose (WebGL paints black cells behind dim glyphs
    // when transparent — see workbench-mode.ts).
    expect(terminalCtorArgs[0].allowTransparency).toBeUndefined();
    expect(terminalCtorArgs[0].theme.background).toBe(THEME_PANEL);
  });

  it('a pack declaring terminal-opacity 0.4 under a wallpaper is floored to 0.8', () => {
    applyThemeToDom(makeTheme({ ...WALLPAPER, 'terminal-opacity': 0.4 }));
    expect(root().style.getPropertyValue('--terminal-xterm-opacity')).toBe('0.8');
  });

  it('a pack declaring terminal-opacity 0.9 under a wallpaper is honoured (the floor only raises)', () => {
    applyThemeToDom(makeTheme({ ...WALLPAPER, 'terminal-opacity': 0.9 }));
    expect(root().style.getPropertyValue('--terminal-xterm-opacity')).toBe('0.9');
  });

  it('gradient theme: same guarantee as a wallpaper — it stamps [data-wallpaper] and the terminal follows that signal', () => {
    const theme = makeTheme({ type: 'gradient', value: 'linear-gradient(#000, #fff)' });
    applyThemeToDom(theme);
    mockActiveTheme = theme;
    render(<TerminalView sessionId="s1" visible={true} />);
    expect(root().hasAttribute('data-wallpaper')).toBe(true);
    expect(root().style.getPropertyValue('--terminal-xterm-opacity')).toBe('0.8');
    expect(root().style.getPropertyValue('--terminal-backing')).toBe('var(--panel)');
    expect(container().style.backgroundColor).toBe('var(--panel)');
    expect(terminalCtorArgs[0].theme.background).toBe(THEME_PANEL);
    // The header-gap backdrop (gradient themes have no terminalBg image) uses
    // the same panel token, so the strip above the grid reads as one sheet.
    const gap = container().parentElement!.querySelector('div[aria-hidden]') as HTMLElement;
    expect(gap.style.backgroundColor).toBe('var(--panel)');
    expect(gap.style.opacity).toBe('var(--terminal-xterm-opacity, 0.6)');
  });

  it('the .xterm-viewport strip follows --terminal-backing (falling back to --canvas)', () => {
    // xterm.css ships `background-color: #000` on the viewport; globals.css
    // overrides it. Under a wallpaper that strip must be panel-coloured or a
    // canvas line shows under the last cell row.
    // WHY still a text read (Plan B, 2026-09-16): a stylesheet declaration, and CSS is not an
    // ast-grep language in this rule set; readSource strips \r so a CRLF checkout matches too.
    const css = readSource(join(__dirname, '../src/renderer/styles/globals.css'));
    const rule = css.slice(css.indexOf('.xterm-viewport {'));
    expect(rule).toMatch(/background-color:\s*var\(--terminal-backing,\s*var\(--canvas\)\)\s*!important/);
  });
});
