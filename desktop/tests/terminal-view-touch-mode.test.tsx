// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

// Capture Terminal constructor args + method calls. Mocked before TerminalView import.
const terminalCtorArgs: any[] = [];
const onDataSpy = vi.fn();

// Mock factories use `function` (not arrow) so they're invokable as
// constructors with `new` — vitest's `vi.fn().mockImplementation(() => ...)`
// returns an arrow function which throws "not a constructor" when called
// with `new`.
vi.mock('@xterm/xterm', () => {
  return {
    Terminal: vi.fn(function (this: any, opts: any) {
      terminalCtorArgs.push(opts);
      this.loadAddon = vi.fn();
      this.open = vi.fn();
      this.unicode = { activeVersion: '11' };
      this.attachCustomKeyEventHandler = vi.fn();
      this.onData = onDataSpy;
      // onScroll added by the overlay-scrollbar feature (commit bf8ca6c7);
      // TerminalView subscribes to drive the synthetic scrollbar position.
      this.onScroll = vi.fn().mockReturnValue({ dispose: vi.fn() });
      this.write = vi.fn();
      this.refresh = vi.fn();
      this.focus = vi.fn();
      this.blur = vi.fn();
      this.dispose = vi.fn();
      this.hasSelection = vi.fn().mockReturnValue(false);
      this.getSelection = vi.fn().mockReturnValue('');
      this.paste = vi.fn();
      this.options = {};
      this.rows = 24;
      // Scrollback API for the overlay-scrollbar — tests don't exercise it
      // but mount-time may read it.
      this.buffer = { active: { length: 24, viewportY: 0, ydisp: 0 } };
      this.scrollLines = vi.fn();
    }),
  };
});

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(function (this: any) {
    this.fit = vi.fn();
    this.proposeDimensions = vi.fn().mockReturnValue({ cols: 80, rows: 24 });
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

// Mock the platform helper. Each test sets the return value before render.
vi.mock('../src/renderer/platform', () => ({
  isAndroid: vi.fn().mockReturnValue(false),
  isTouchDevice: vi.fn().mockReturnValue(false),
  getPlatform: vi.fn().mockReturnValue('electron'),
}));

// Avoid pulling theme context — the component reads CSS vars from
// document.documentElement; jsdom returns empty strings, the component falls
// back to its defaults.
vi.mock('../src/renderer/state/theme-context', () => ({
  useTheme: () => ({ activeTheme: null, reducedEffects: false }),
}));

// Stub the IPC + registry surfaces TerminalView calls.
vi.mock('../src/renderer/hooks/terminal-registry', () => ({
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

// Now safe to import — all dependencies are mocked.
import TerminalView from '../src/renderer/components/TerminalView';
import { Terminal } from '@xterm/xterm';
import * as platform from '../src/renderer/platform';
import { usePtyOutput } from '../src/renderer/hooks/useIpc';
import { usePtyRawBytes } from '../src/renderer/hooks/usePtyRawBytes';

// jsdom doesn't ship a ResizeObserver — TerminalView's mount effect news one
// up to track container resizes. Stub with a no-op so the effect runs cleanly.
if (typeof (globalThis as any).ResizeObserver === 'undefined') {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

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
