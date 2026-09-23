// @vitest-environment jsdom
// TerminalView — the xterm pane, mounted with xterm, its addons and the IPC
// hooks faked.
// WHY a second file: TerminalView-pty-reset.test.tsx drives the REAL useIpc /
// usePtyRawBytes hooks through window.claude.on, which this file replaces with a
// file-wide vi.mock; a vi.mock cannot be scoped to part of a file.
import React from 'react';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

// One fake xterm for every section, each field a superset of what the sections
// used on their own: the constructor options are captured (touch mode,
// workbench), onData / write / clearTextureAtlas are shared spies (touch mode,
// workbench, glyph-atlas heal), and the grid size is set per section.
const terminalCtorArgs: any[] = [];
const onDataSpy = vi.fn();
const writeSpy = vi.fn();
const clearTextureAtlasSpy = vi.fn();
// Every fake Terminal constructed, newest last — the render-pause and backing
// sections read an instance's refresh / dispose / options.
const terminalInstances: any[] = [];
// Stands in for xterm's private RenderService._handleIntersectionChange — the
// pause switch attachRenderPause drives (real-xterm pin: xterm-render-pause.test.ts).
const handleIntersectionSpy = vi.fn();
let termGrid: { cols?: number; rows: number } = { rows: 24 };

// Mock factories use `function` (not arrow) so they're invokable as
// constructors with `new` — vitest's `vi.fn().mockImplementation(() => ...)`
// returns an arrow function which throws "not a constructor" when called
// with `new`.
vi.mock('@xterm/xterm', () => {
  return {
    Terminal: vi.fn(function (this: any, opts: any) {
      terminalCtorArgs.push(opts);
      terminalInstances.push(this);
      this._core = { _renderService: { _isPaused: false, _handleIntersectionChange: handleIntersectionSpy } };
      this.loadAddon = vi.fn();
      this.open = vi.fn();
      this.unicode = { activeVersion: '11' };
      this.attachCustomKeyEventHandler = vi.fn();
      this.onData = onDataSpy;
      // TerminalView subscribes to drive the overlay scrollbar's position.
      this.onScroll = vi.fn().mockReturnValue({ dispose: vi.fn() });
      this.write = writeSpy;
      this.refresh = vi.fn();
      this.focus = vi.fn();
      this.blur = vi.fn();
      this.dispose = vi.fn();
      // Lives on the CORE Terminal (not the addon), which is why TerminalView
      // can call it unguarded even on the DOM renderer. Every render-path
      // terminal must expose it: TerminalView calls it on hidden → visible and
      // on the debounced resize to heal a corrupt WebGL glyph atlas.
      this.clearTextureAtlas = clearTextureAtlasSpy;
      this.hasSelection = vi.fn().mockReturnValue(false);
      this.getSelection = vi.fn().mockReturnValue('');
      this.paste = vi.fn();
      this.options = {};
      this.cols = termGrid.cols;
      this.rows = termGrid.rows;
      // Scrollback API for the overlay-scrollbar — mount-time may read it.
      this.buffer = { active: { length: termGrid.rows, viewportY: 0, ydisp: 0 } };
      this.scrollLines = vi.fn();
    }),
  };
});

// Mutable so a test can drive a SECOND, differently-sized resize — fitAndSync
// dedups on unchanged cols/rows, so a fixed value can only ever flush once.
let proposedDims = { cols: 80, rows: 24 };

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(function (this: any) {
    this.fit = vi.fn();
    this.proposeDimensions = vi.fn(() => proposedDims);
  }),
}));

vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: vi.fn(function (this: any) {}),
}));

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn(function (this: any) {
    this.onContextLoss = vi.fn();
    this.dispose = vi.fn();
  }),
}));

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

// Mock the platform helper. The touch-mode section sets the return value
// before render.
vi.mock('../src/renderer/platform', () => ({
  isAndroid: vi.fn().mockReturnValue(false),
  isTouchDevice: vi.fn().mockReturnValue(false),
  getPlatform: vi.fn().mockReturnValue('electron'),
}));

// Avoid pulling theme context — the component reads CSS vars from
// document.documentElement; jsdom returns empty strings, the component falls
// back to its defaults. Mutable so the shipped-surface block can switch between
// a flat theme (null — the four built-ins declare no `background`) and
// wallpaper/gradient themes without re-mocking the module.
let mockActiveTheme: any = null;
vi.mock('../src/renderer/state/theme-context', () => ({
  useTheme: () => ({ activeTheme: mockActiveTheme, reducedEffects: false }),
}));

// The REAL atlas counter (noteAtlasClear / getAtlasClears) is kept — only the
// terminal bookkeeping is stubbed — so the glyph-atlas tests prove the counter
// the perf rig reads moves in step with every clearTextureAtlas() call, not a
// mock of it.
vi.mock('../src/renderer/hooks/terminal-registry', async () => ({
  ...(await vi.importActual<typeof import('../src/renderer/hooks/terminal-registry')>('../src/renderer/hooks/terminal-registry')),
  registerTerminal: vi.fn(),
  unregisterTerminal: vi.fn(),
  notifyBufferReady: vi.fn(),
}));

vi.mock('../src/renderer/hooks/useIpc', () => ({
  usePtyOutput: vi.fn(),
}));

vi.mock('../src/renderer/hooks/usePtyRawBytes', () => ({
  usePtyRawBytes: vi.fn(),
}));

import { join } from 'node:path';
import { readSource } from './helpers/guard-scope';
import TerminalView from '../src/renderer/components/TerminalView';
import * as platform from '../src/renderer/platform';
import { usePtyOutput } from '../src/renderer/hooks/useIpc';
import { usePtyRawBytes } from '../src/renderer/hooks/usePtyRawBytes';
import { getAtlasClears } from '../src/renderer/hooks/terminal-registry';
import { renderTerminalScreen } from '../src/renderer/dev/workbench/fixtures/terminal-screen';
import { applyThemeToDom } from '../src/renderer/themes/theme-engine';
import type { ThemeDefinition } from '../src/renderer/themes/theme-types';
// Side-effect import: installs window.__terminalRegistry, which is what the perf
// rig actually reads the counter through.
import '../src/renderer/bootstrap/terminal-bridge';

// jsdom doesn't ship a ResizeObserver — TerminalView's mount effect news one
// up to track container resizes. Stub with a no-op so the effect runs cleanly.
if (typeof (globalThis as any).ResizeObserver === 'undefined') {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// WHY: each section below was its own file, so the shared fakes started at
// these values in each. Reset them before every case so no section inherits
// another's grid, theme or touch setting.
beforeEach(() => {
  termGrid = { rows: 24 };
  proposedDims = { cols: 80, rows: 24 };
  mockActiveTheme = null;
  vi.mocked(platform.isTouchDevice).mockReturnValue(false);
});

// Pins the WebGL glyph-atlas heal in TerminalView.
//
// The webgl addon shares one rasterized atlas across all terminals but uploads
// it into each WebGL context's own GPU texture. When a single context's texture
// goes bad, that session renders every glyph as a solid black box and xterm
// fires NO context-loss event — so the onContextLoss recovery never runs and
// the corruption persists for the terminal's whole lifetime. The only remedy is
// calling clearTextureAtlas(), and nothing else in the app calls it.
//
// That makes this an invisible coupling: TerminalView heals because `visible`
// happens to transition, not because anything declares it must. Without these
// tests a refactor of the toggle or the resize debounce would silently remove
// the healing and nobody would notice until glyphs started rotting again.
describe('glyph-atlas heal', () => {
  // jsdom reports clientWidth/clientHeight as 0 for every element, and
  // fitAndSync early-returns on a 0x0 container (the hidden-terminal guard). The
  // resize test needs a laid-out container, so give every element a size.
  let sizeStubs: Array<() => void> = [];
  function stubLayout(): void {
    for (const prop of ['clientWidth', 'clientHeight'] as const) {
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
      Object.defineProperty(HTMLElement.prototype, prop, {
        configurable: true,
        get: () => 600,
      });
      sizeStubs.push(() => {
        if (original) Object.defineProperty(HTMLElement.prototype, prop, original);
        else delete (HTMLElement.prototype as any)[prop];
      });
    }
  }

  beforeEach(() => {
    clearTextureAtlasSpy.mockReset();
    proposedDims = { cols: 80, rows: 24 };
    (globalThis as any).window.claude = {
      session: {
        signalReady: vi.fn(),
        sendInput: vi.fn(),
        resize: vi.fn(),
      },
    };
  });

  afterEach(() => {
    cleanup();
    sizeStubs.forEach((restore) => restore());
    sizeStubs = [];
    vi.useRealTimers();
    delete (globalThis as any).window.claude;
  });

  describe('TerminalView glyph-atlas heal — visibility', () => {
    it('clears the texture atlas when the terminal becomes visible', () => {
      const { rerender } = render(<TerminalView sessionId="s1" visible={false} />);
      expect(clearTextureAtlasSpy).not.toHaveBeenCalled();

      rerender(<TerminalView sessionId="s1" visible={true} />);
      expect(clearTextureAtlasSpy).toHaveBeenCalled();
    });

    it('does not clear the texture atlas when the terminal is hidden', () => {
      const { rerender } = render(<TerminalView sessionId="s1" visible={true} />);
      clearTextureAtlasSpy.mockReset();

      rerender(<TerminalView sessionId="s1" visible={false} />);
      expect(clearTextureAtlasSpy).not.toHaveBeenCalled();
    });

    // A newly-opened session joins the atlas shared with every already-open
    // terminal, and clearing bumps each page's version — so healing on mount
    // would force every other terminal to re-rasterize. A fresh terminal has
    // nothing to heal, so the heal is gated on a real hidden → shown transition.
    it('does not clear the texture atlas on mount when already visible', () => {
      render(<TerminalView sessionId="s1" visible={true} />);
      expect(clearTextureAtlasSpy).not.toHaveBeenCalled();
    });

    it('does not clear the texture atlas on mount when hidden', () => {
      render(<TerminalView sessionId="s1" visible={false} />);
      expect(clearTextureAtlasSpy).not.toHaveBeenCalled();
    });

    // Chat → terminal → chat → terminal must heal on EACH return, not just the
    // first: a corrupt texture can appear at any point in a session's life.
    it('clears again on every return to visible', () => {
      const { rerender } = render(<TerminalView sessionId="s1" visible={false} />);

      rerender(<TerminalView sessionId="s1" visible={true} />);
      const afterFirst = clearTextureAtlasSpy.mock.calls.length;
      expect(afterFirst).toBeGreaterThan(0);

      rerender(<TerminalView sessionId="s1" visible={false} />);
      rerender(<TerminalView sessionId="s1" visible={true} />);
      expect(clearTextureAtlasSpy.mock.calls.length).toBeGreaterThan(afterFirst);
    });
  });

  describe('TerminalView glyph-atlas heal — resize', () => {
    // Resizing is the first thing a user tries when text looks wrong. The heal
    // rides the DEBOUNCED trailing resize (flushResize), not fitAndSync, so a
    // window drag re-rasterizes once after it settles rather than every tick.
    it('does not clear on the initial mount-time fit', () => {
      vi.useFakeTimers();
      stubLayout();

      render(<TerminalView sessionId="s1" visible={false} />);

      // Mount schedules fitAndSync at 100ms; fitAndSync then debounces the PTY
      // resize by a further 120ms.
      vi.advanceTimersByTime(100 + 120);
      expect(window.claude.session.resize).toHaveBeenCalledWith('s1', 80, 24);
      expect(clearTextureAtlasSpy).not.toHaveBeenCalled();
    });

    it('clears the texture atlas on a genuine resize after mount', () => {
      vi.useFakeTimers();
      stubLayout();

      render(<TerminalView sessionId="s1" visible={false} />);
      vi.advanceTimersByTime(100 + 120); // mount fit — skipped
      expect(clearTextureAtlasSpy).not.toHaveBeenCalled();

      // A real resize: new grid dimensions, so fitAndSync's dedup lets it through.
      proposedDims = { cols: 100, rows: 30 };
      window.dispatchEvent(new Event('resize'));
      expect(clearTextureAtlasSpy).not.toHaveBeenCalled(); // still debouncing

      vi.advanceTimersByTime(120);
      expect(window.claude.session.resize).toHaveBeenCalledWith('s1', 100, 30);
      expect(clearTextureAtlasSpy).toHaveBeenCalled();
    });
  });

  // The perf rig (youcoded-dev scripts/perf-lab/scenario-terminal.mjs) counts atlas
  // clears per session switch by reading window.__terminalRegistry.atlasClears. If a
  // heal site clears the atlas without counting, the rig under-reports the cost; if
  // the counter moves without a clear, it over-reports. Both sites are pinned to move
  // in lockstep with the clearTextureAtlas spy.
  describe('TerminalView glyph-atlas heal — rig counter', () => {
    it('counts every visibility heal, one for one with clearTextureAtlas', () => {
      const { rerender } = render(<TerminalView sessionId="s1" visible={false} />);
      const clears0 = getAtlasClears();
      const calls0 = clearTextureAtlasSpy.mock.calls.length;

      rerender(<TerminalView sessionId="s1" visible={true} />);
      rerender(<TerminalView sessionId="s1" visible={false} />);
      rerender(<TerminalView sessionId="s1" visible={true} />);

      const calls = clearTextureAtlasSpy.mock.calls.length - calls0;
      expect(calls).toBe(2);
      expect(getAtlasClears() - clears0).toBe(calls);
    });

    it('does not count when nothing was cleared (mount, and hide)', () => {
      const clears0 = getAtlasClears();
      const { rerender } = render(<TerminalView sessionId="s1" visible={true} />);
      rerender(<TerminalView sessionId="s1" visible={false} />);
      expect(clearTextureAtlasSpy).not.toHaveBeenCalled();
      expect(getAtlasClears()).toBe(clears0);
    });

    it('counts the debounced resize heal, one for one with clearTextureAtlas', () => {
      vi.useFakeTimers();
      stubLayout();

      render(<TerminalView sessionId="s1" visible={false} />);
      vi.advanceTimersByTime(100 + 120); // mount fit — skipped, and not counted
      const clears0 = getAtlasClears();
      expect(clearTextureAtlasSpy).not.toHaveBeenCalled();

      proposedDims = { cols: 100, rows: 30 };
      window.dispatchEvent(new Event('resize'));
      vi.advanceTimersByTime(120);

      expect(clearTextureAtlasSpy.mock.calls.length).toBe(1);
      expect(getAtlasClears() - clears0).toBe(1);
    });

    it('exposes the live count on window.__terminalRegistry.atlasClears', () => {
      const bridge = (window as unknown as { __terminalRegistry?: { atlasClears: number } }).__terminalRegistry;
      expect(bridge).toBeDefined();
      const before = bridge!.atlasClears;
      expect(before).toBe(getAtlasClears());

      const { rerender } = render(<TerminalView sessionId="s1" visible={false} />);
      rerender(<TerminalView sessionId="s1" visible={true} />);

      // A getter, not a snapshot: the rig reads it before and after each switch.
      expect(bridge!.atlasClears).toBe(before + 1);
    });
  });
});

describe('mount logic', () => {
  beforeEach(() => {
    terminalCtorArgs.length = 0;
    onDataSpy.mockReset();
    vi.mocked(usePtyOutput).mockReset();
    vi.mocked(usePtyRawBytes).mockReset();
    // Stub session.signalReady to no-op (it's called on mount).
    (globalThis as any).window.claude = {
      session: {
        signalReady: vi.fn(),
        sendInput: vi.fn(),
        resize: vi.fn(),
      },
    };
  });

  afterEach(() => {
    cleanup();
    delete (globalThis as any).window.claude;
  });

  describe('TerminalView mount logic — touch platform', () => {
    beforeEach(() => {
      vi.mocked(platform.isTouchDevice).mockReturnValue(true);
    });

    it('passes disableStdin: true to the Terminal constructor', () => {
      render(<TerminalView sessionId="s1" visible={true} />);
      expect(terminalCtorArgs[0]).toMatchObject({ disableStdin: true });
    });

    it('does not register a terminal.onData listener', () => {
      render(<TerminalView sessionId="s1" visible={true} />);
      expect(onDataSpy).not.toHaveBeenCalled();
    });

    it('uses 12px font size', () => {
      render(<TerminalView sessionId="s1" visible={true} />);
      expect(terminalCtorArgs[0]).toMatchObject({ fontSize: 12 });
    });

    // Implementation calls BOTH hooks every render (rules-of-hooks: stable hook
    // order). On touch, the raw-bytes hook gets the real sessionId and the
    // string hook gets null (early-returns inside the hook). Asserting which
    // hook got the real sessionId is the meaningful check, not which got called.
    it('passes sessionId to usePtyRawBytes and null to usePtyOutput', () => {
      render(<TerminalView sessionId="s1" visible={true} />);
      expect(usePtyRawBytes).toHaveBeenCalledWith('s1', expect.any(Function));
      expect(usePtyOutput).toHaveBeenCalledWith(null, expect.any(Function));
    });
  });

  describe('TerminalView mount logic — desktop', () => {
    beforeEach(() => {
      vi.mocked(platform.isTouchDevice).mockReturnValue(false);
    });

    it('does not pass disableStdin (or passes false)', () => {
      render(<TerminalView sessionId="s1" visible={true} />);
      const opts = terminalCtorArgs[0];
      expect(opts.disableStdin === undefined || opts.disableStdin === false).toBe(true);
    });

    it('registers a terminal.onData listener', () => {
      render(<TerminalView sessionId="s1" visible={true} />);
      expect(onDataSpy).toHaveBeenCalled();
    });

    it('uses 14px font size', () => {
      render(<TerminalView sessionId="s1" visible={true} />);
      expect(terminalCtorArgs[0]).toMatchObject({ fontSize: 14 });
    });

    it('passes sessionId to usePtyOutput and null to usePtyRawBytes', () => {
      render(<TerminalView sessionId="s1" visible={true} />);
      expect(usePtyOutput).toHaveBeenCalledWith('s1', expect.any(Function));
      expect(usePtyRawBytes).toHaveBeenCalledWith(null, expect.any(Function));
    });
  });
});

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
describe('workbench screen and terminal surface', () => {
  beforeEach(() => {
    termGrid = { cols: 100, rows: 30 };
    proposedDims = { cols: 100, rows: 30 };
  });

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
  const layoutDescriptors = (['clientWidth', 'clientHeight'] as const).map((p) => [p, Object.getOwnPropertyDescriptor(HTMLElement.prototype, p)] as const);
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 1200; } });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 700; } });
  });
  // WHY: this was a module-level override in its own file; restore jsdom's
  // 0×0 layout so it cannot reach a later section.
  afterAll(() => {
    for (const [p, d] of layoutDescriptors) {
      if (d) Object.defineProperty(HTMLElement.prototype, p, d);
      else delete (HTMLElement.prototype as any)[p];
    }
  });

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
});

// Perf batch 2026-09-23. B1: a hidden terminal's DRAWING pauses (xterm's own
// off-screen switch) while its buffer keeps receiving every write — the prompt
// detector reads hidden sessions' buffers. E5: a theme switch that changes the
// terminal backing recolours the open terminal instead of rebuilding it.
describe('hidden terminals and theme switches', () => {
  beforeEach(() => {
    terminalInstances.length = 0;
    terminalCtorArgs.length = 0;
    handleIntersectionSpy.mockReset();
    writeSpy.mockReset();
    vi.mocked(usePtyOutput).mockReset();
    (globalThis as any).window.claude = {
      session: { signalReady: vi.fn(), sendInput: vi.fn(), resize: vi.fn() },
    };
  });
  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('data-wallpaper');
    delete (globalThis as any).window.claude;
  });

  const lastPauseVerdict = () => handleIntersectionSpy.mock.calls.at(-1)?.[0];
  // The PTY output handler TerminalView registered (usePtyOutput is mocked).
  const ptyOutput = () => vi.mocked(usePtyOutput).mock.calls.at(-1)![1] as (data: string) => void;

  describe('TerminalView render pause (B1)', () => {
    it('a terminal mounted hidden starts with drawing paused', () => {
      render(<TerminalView sessionId="s1" visible={false} />);
      expect(lastPauseVerdict()).toEqual({ isIntersecting: false });
    });

    it('a terminal mounted visible is left alone', () => {
      render(<TerminalView sessionId="s1" visible={true} />);
      expect(handleIntersectionSpy).not.toHaveBeenCalled();
    });

    it('PTY output still reaches the hidden terminal (its buffer stays current)', () => {
      render(<TerminalView sessionId="s1" visible={false} />);
      ptyOutput()('Do you trust the files in this folder?');
      expect(writeSpy).toHaveBeenCalledWith('Do you trust the files in this folder?', expect.any(Function));
    });

    it('showing it resumes drawing and repaints the whole screen', () => {
      const { rerender } = render(<TerminalView sessionId="s1" visible={false} />);
      const term = terminalInstances.at(-1);
      term.refresh.mockClear();

      rerender(<TerminalView sessionId="s1" visible={true} />);
      expect(lastPauseVerdict()).toEqual({ isIntersecting: true });
      expect(term.refresh).toHaveBeenCalledWith(0, 23);
    });

    it('hiding it again pauses drawing again', () => {
      const { rerender } = render(<TerminalView sessionId="s1" visible={true} />);
      rerender(<TerminalView sessionId="s1" visible={false} />);
      expect(lastPauseVerdict()).toEqual({ isIntersecting: false });
    });
  });

  describe('TerminalView backing change (E5)', () => {
    function theme(background: any): ThemeDefinition {
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

    it('flat -> wallpaper theme recolours the open terminal in place: no dispose, no second terminal', async () => {
      const flat = theme(undefined);
      applyThemeToDom(flat);
      mockActiveTheme = flat;
      const { rerender } = render(<TerminalView sessionId="s1" visible={true} />);
      expect(terminalInstances).toHaveLength(1);
      const term = terminalInstances[0];
      expect(terminalCtorArgs[0].theme.background).toBe('#0D0F1A'); // --canvas

      const wallpaper = theme({ type: 'image', value: 'theme-asset://meadow/wallpaper.jpg' });
      applyThemeToDom(wallpaper);
      mockActiveTheme = wallpaper;
      rerender(<TerminalView sessionId="s1" visible={true} />);

      expect(terminalInstances).toHaveLength(1);
      expect(term.dispose).not.toHaveBeenCalled();
      // The theme effect recolours on the next frame, to the --panel backing.
      await waitFor(() => expect(term.options.theme?.background).toBe('#141726'));
    });
  });
});
