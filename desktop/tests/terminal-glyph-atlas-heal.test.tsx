// @vitest-environment jsdom
//
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
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const clearTextureAtlasSpy = vi.fn();

// Mock factories use `function` (not arrow) so they're invokable with `new` —
// vi.fn().mockImplementation(() => ...) returns an arrow and throws
// "not a constructor". Same pattern as terminal-view-touch-mode.test.tsx.
vi.mock('@xterm/xterm', () => {
  return {
    Terminal: vi.fn(function (this: any) {
      this.loadAddon = vi.fn();
      this.open = vi.fn();
      this.unicode = { activeVersion: '11' };
      this.attachCustomKeyEventHandler = vi.fn();
      this.onData = vi.fn();
      this.onScroll = vi.fn().mockReturnValue({ dispose: vi.fn() });
      this.write = vi.fn();
      this.refresh = vi.fn();
      this.focus = vi.fn();
      this.blur = vi.fn();
      this.dispose = vi.fn();
      this.hasSelection = vi.fn().mockReturnValue(false);
      this.getSelection = vi.fn().mockReturnValue('');
      this.paste = vi.fn();
      // The API under test. Lives on the CORE Terminal (not the addon), which
      // is why TerminalView can call it unguarded even on the DOM renderer.
      this.clearTextureAtlas = clearTextureAtlasSpy;
      this.options = {};
      this.rows = 24;
      this.buffer = { active: { length: 24, viewportY: 0, ydisp: 0 } };
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

vi.mock('../src/renderer/platform', () => ({
  isAndroid: vi.fn().mockReturnValue(false),
  isTouchDevice: vi.fn().mockReturnValue(false),
  getPlatform: vi.fn().mockReturnValue('electron'),
}));

vi.mock('../src/renderer/state/theme-context', () => ({
  useTheme: () => ({ activeTheme: null, reducedEffects: false }),
}));

// The REAL atlas counter (noteAtlasClear / getAtlasClears) is kept — only the
// terminal bookkeeping is stubbed — so the tests below prove the counter the perf
// rig reads moves in step with every clearTextureAtlas() call, not a mock of it.
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

import TerminalView from '../src/renderer/components/TerminalView';
import { getAtlasClears } from '../src/renderer/hooks/terminal-registry';
// Side-effect import: installs window.__terminalRegistry, which is what the perf
// rig actually reads the counter through.
import '../src/renderer/bootstrap/terminal-bridge';

if (typeof (globalThis as any).ResizeObserver === 'undefined') {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

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
