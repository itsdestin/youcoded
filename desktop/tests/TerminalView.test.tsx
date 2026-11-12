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
      this.unicode = { activeVersion: '11', register: vi.fn() };
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
  Unicode11Addon: vi.fn(function (this: any) { this.activate = (t: any) => t.unicode.register({ version: '11', wcwidth: () => 1, charProperties: () => 2 }); }),
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
  isRemoteMode: vi.fn().mockReturnValue(false),
  getPlatform: vi.fn().mockReturnValue('electron'),
  // The terminal reads which stream the host sends from the screen's capabilities (R4-1), not from the platform name.
  getCapabilities: vi.fn().mockReturnValue({ terminalTransport: 'text' }),
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

// The UNMEMOISED component: this file's useTheme mock is a plain getter, and
// the theme tests deliver a "new theme" by re-rendering with identical props —
// exactly what memo exists to skip. In the app the theme arrives through
// context, which memo never blocks (same arrangement as UnmemoizedChatView).
import { UnmemoizedTerminalView as TerminalView } from '../src/renderer/components/TerminalView';
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

// WHY: each section below was its own file, so the shared fakes started at
// these values in each. Reset them before every case so no section inherits
// another's grid, theme or touch setting.
beforeEach(() => {
  termGrid = { rows: 24 };
  proposedDims = { cols: 80, rows: 24 };
  mockActiveTheme = null;
  // WHY getPlatform (2026-11-10): the terminal asks device.ts phoneTerminalLayout(), which reads the device kind.
  vi.mocked(platform.getPlatform).mockReturnValue('electron');
});

// WHY: one WebGL context's texture can go bad (solid black glyphs) with NO context-loss event; the only remedy is
// clearTextureAtlas(), which TerminalView calls only because `visible` transitions / the debounced resize fires.
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

    // WHY: a new session joins the atlas shared with every open terminal and clearing bumps each page's version,
    // so the heal is gated on a real hidden -> shown transition, never on mount.
    it.each([true, false])('does not clear the texture atlas on mount (visible=%s)', (visible) => {
      render(<TerminalView sessionId="s1" visible={visible} />);
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
      vi.mocked(platform.getPlatform).mockReturnValue('browser');
    });

    it('disables stdin and registers no onData listener', () => {
      render(<TerminalView sessionId="s1" visible={true} />);
      expect(terminalCtorArgs[0]).toMatchObject({ disableStdin: true });
      expect(onDataSpy).not.toHaveBeenCalled();
    });

    // Implementation calls BOTH hooks every render (rules-of-hooks: stable hook
    // order). On touch, the raw-bytes hook gets the real sessionId and the
    // string hook gets null (early-returns inside the hook). Asserting which
    // hook got the real sessionId is the meaningful check, not which got called.
    it('passes sessionId to usePtyRawBytes and null to usePtyOutput on the Android app', () => {
      vi.mocked(platform.getCapabilities).mockReturnValue({ terminalTransport: 'raw-bytes' } as any);
      try {
        render(<TerminalView sessionId="s1" visible={true} />);
        expect(usePtyRawBytes).toHaveBeenCalledWith('s1', expect.any(Function));
        expect(usePtyOutput).toHaveBeenCalledWith(null, expect.any(Function));
      } finally {
        vi.mocked(platform.getCapabilities).mockReturnValue({ terminalTransport: 'text' } as any);
      }
    });

    // The Android app PAIRED to a computer still reports 'android', but the computer says it sends the
    // terminal as text — waiting for raw bytes there drew a blank terminal.
    it('the Android app paired to a computer draws the text stream the computer sends', () => {
      vi.mocked(platform.isAndroid).mockReturnValue(true);
      vi.mocked(platform.isRemoteMode).mockReturnValue(true);
      try {
        render(<TerminalView sessionId="s1" visible={true} />);
        expect(usePtyOutput).toHaveBeenCalledWith('s1', expect.any(Function));
        expect(usePtyRawBytes).toHaveBeenCalledWith(null, expect.any(Function));
      } finally {
        vi.mocked(platform.isAndroid).mockReturnValue(false);
        vi.mocked(platform.isRemoteMode).mockReturnValue(false);
      }
    });

    // A phone BROWSER is a touch device too, but the computer it talks to sends the
    // terminal as text and never as raw bytes — only the Android app's own runtime
    // does. Listening for raw bytes there would draw a blank terminal.
    it('a phone browser draws the text stream the computer sends', () => {
      render(<TerminalView sessionId="s1" visible={true} />);
      expect(usePtyOutput).toHaveBeenCalledWith('s1', expect.any(Function));
      expect(usePtyRawBytes).toHaveBeenCalledWith(null, expect.any(Function));
    });
  });

  describe('TerminalView mount logic — desktop', () => {
    beforeEach(() => {
      vi.mocked(platform.getPlatform).mockReturnValue('electron');
    });

    // Destin, 2026-11-10: a mouse laptop on remote access ('desktop') gets the computer terminal, typed into directly.
    it('a mouse laptop\'s browser takes typing and the computer font size', () => {
      // WHY no literal size: the number is a look; the fact is "same size as the Electron computer terminal".
      render(<TerminalView sessionId="s1" visible={true} />);
      const electronSize = terminalCtorArgs[0].fontSize;
      cleanup();
      terminalCtorArgs.length = 0;
      vi.mocked(platform.getPlatform).mockReturnValue('desktop' as any);
      render(<TerminalView sessionId="s1" visible={true} />);
      const opts = terminalCtorArgs[0];
      expect(opts.disableStdin).toBeFalsy();
      expect(opts.fontSize).toBe(electronSize);
    });

    it('keeps stdin enabled, registers onData, and feeds the text stream to usePtyOutput', () => {
      render(<TerminalView sessionId="s1" visible={true} />);
      expect(terminalCtorArgs[0].disableStdin === undefined || terminalCtorArgs[0].disableStdin === false).toBe(true);
      expect(onDataSpy).toHaveBeenCalled();
      expect(usePtyOutput).toHaveBeenCalledWith('s1', expect.any(Function));
      expect(usePtyRawBytes).toHaveBeenCalledWith(null, expect.any(Function));
    });

    // The terminal library listens for paste even while its terminal is hidden, so a paste into the chat's message
    // box used to reach Claude Code a second time, raw. Only the terminal on screen may send.
    it('sends what is typed or pasted only while the terminal is the one on screen', () => {
      const { rerender } = render(<TerminalView sessionId="s1" visible={false} />);
      const typed = onDataSpy.mock.calls[0][0] as (data: string) => void;
      const send = (window as any).claude.session.sendInput;
      typed('pasted while hidden');
      expect(send).not.toHaveBeenCalled();
      rerender(<TerminalView sessionId="s1" visible={true} />);
      typed('typed while shown');
      expect(send).toHaveBeenCalledWith('s1', 'typed while shown');
      expect(send).toHaveBeenCalledTimes(1);
    });
  });
});

// UI Workbench terminal mock-up (ledger P-20.1, 2026-08-27): under `?mode=workbench`
// TerminalView writes the canned Claude Code screen (no PTY, so the pane used to be
// blank); outside workbench mode — the app — NOTHING is written. Colours/opacity of the
// terminal surface are judged by screenshot review; only the theme engine's legibility
// floor (a wallpaper theme never drops the terminal below 0.8) is asserted below.
describe('workbench screen and terminal surface', () => {
  beforeEach(() => {
    termGrid = { cols: 100, rows: 30 };
    proposedDims = { cols: 100, rows: 30 };
  });


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
      // settle (negative assertion): later resizes must not write it a second time.
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
  });

  describe('TerminalView in the app (no ?mode=workbench)', () => {
    it('writes nothing even if ?termBacking= is present', async () => {
      setUrl('?termBacking=solid90');
      render(<TerminalView sessionId="s1" visible={true} />);
      // Give the 100ms initial-fit timer (and any import it might have kicked
      // off) ample time to run before asserting the negative.
      await new Promise((r) => setTimeout(r, 300));
      expect(writeSpy).not.toHaveBeenCalled();
    });
  });

  describe('the shipped terminal surface (P-20.2 guarantee, app mode)', () => {
    const root = () => document.documentElement;

    afterEach(() => {
      // Drop every inline token/var the engine wrote so cases can't bleed.
      root().removeAttribute('style');
      root().removeAttribute('data-wallpaper');
    });

    it('a pack declaring terminal-opacity 0.4 under a wallpaper is floored to 0.8', () => {
      applyThemeToDom(makeTheme({ ...WALLPAPER, 'terminal-opacity': 0.4 }));
      expect(root().style.getPropertyValue('--terminal-xterm-opacity')).toBe('0.8');
    });

    it('a pack declaring terminal-opacity 0.9 under a wallpaper is honoured (the floor only raises)', () => {
      applyThemeToDom(makeTheme({ ...WALLPAPER, 'terminal-opacity': 0.9 }));
      expect(root().style.getPropertyValue('--terminal-xterm-opacity')).toBe('0.9');
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
    it('flat -> wallpaper theme recolours the open terminal in place: no dispose, no second terminal', async () => {
      const flat = makeTheme(undefined);
      applyThemeToDom(flat);
      mockActiveTheme = flat;
      const { rerender } = render(<TerminalView sessionId="s1" visible={true} />);
      expect(terminalInstances).toHaveLength(1);
      const term = terminalInstances[0];
      expect(terminalCtorArgs[0].theme.background).toBe('#0D0F1A'); // --canvas

      const wallpaper = makeTheme(WALLPAPER);
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

// Claude Code redraws its screen on every new size, and when its conversation is taller than the screen the redraw
// prints lines twice or loses them (measured with the phone's Claude Code 2.1.300; terminal-size-lock.ts). On a touch
// screen the terminal's box shrinks whenever the message box floating over it grows a line — that must NOT resize the
// program; only a change of the window or of the column count may. Desktop (Electron) keeps fitting every change.
describe('program size when the chrome over the terminal changes', () => {
  let boxHeight = 600;
  let restores: Array<() => void> = [];
  const stubBox = () => {
    for (const [prop, get] of [['clientWidth', () => 360], ['clientHeight', () => boxHeight]] as const) {
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
      Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get });
      restores.push(() => { if (original) Object.defineProperty(HTMLElement.prototype, prop, original); else delete (HTMLElement.prototype as any)[prop]; });
    }
  };
  const setWindow = (w: number, h: number) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
  };
  /** The shown terminal is re-fitted (as its ResizeObserver or a window resize would do), then the debounce passes. */
  const refit = () => { window.dispatchEvent(new Event('resize')); vi.advanceTimersByTime(120); };

  beforeEach(() => {
    vi.useFakeTimers();
    boxHeight = 600;
    stubBox();
    setWindow(360, 788);
    (globalThis as any).window.claude = { session: { signalReady: vi.fn(), sendInput: vi.fn(), resize: vi.fn() } };
  });
  afterEach(() => {
    cleanup();
    restores.forEach((r) => r()); restores = [];
    vi.useRealTimers();
    vi.mocked(platform.getPlatform).mockReturnValue('electron');
    delete (globalThis as any).window.claude;
  });

  it('on a phone, a taller message box keeps the program at its size', () => {
    vi.mocked(platform.getPlatform).mockReturnValue('android');
    proposedDims = { cols: 47, rows: 35 };
    render(<TerminalView sessionId="s1" visible={true} />);
    vi.advanceTimersByTime(100 + 120);
    expect(window.claude.session.resize).toHaveBeenCalledTimes(1);
    expect(window.claude.session.resize).toHaveBeenLastCalledWith('s1', 47, 35);

    // A second line in the message box: the box over the terminal grows, the grid's box shrinks by two rows.
    boxHeight = 570;
    proposedDims = { cols: 47, rows: 33 };
    refit();
    // And back to one line.
    boxHeight = 600;
    proposedDims = { cols: 47, rows: 35 };
    refit();
    expect(window.claude.session.resize).toHaveBeenCalledTimes(1);
  });

  it('on a phone, turning or folding it (a new window size) still resizes the program', () => {
    vi.mocked(platform.getPlatform).mockReturnValue('android');
    proposedDims = { cols: 47, rows: 35 };
    render(<TerminalView sessionId="s1" visible={true} />);
    vi.advanceTimersByTime(100 + 120);

    setWindow(788, 360);
    proposedDims = { cols: 110, rows: 12 };
    refit();
    expect(window.claude.session.resize).toHaveBeenLastCalledWith('s1', 110, 12);
  });

  it('on desktop, every new fit still resizes the program', () => {
    vi.mocked(platform.getPlatform).mockReturnValue('electron');
    proposedDims = { cols: 100, rows: 35 };
    render(<TerminalView sessionId="s1" visible={true} />);
    vi.advanceTimersByTime(100 + 120);
    proposedDims = { cols: 100, rows: 33 };
    refit();
    expect(window.claude.session.resize).toHaveBeenLastCalledWith('s1', 100, 33);
  });
});
