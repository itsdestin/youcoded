// @vitest-environment jsdom
// Remote access batch 2, design §7 (T2): on `pty:reset` the terminal clears
// and jumps to the bottom before the host's full buffer is redrawn, and the
// reset listener exists before the output listener so a backlog drains in order.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const resetSpy = vi.fn();
const scrollToBottomSpy = vi.fn();
const writeSpy = vi.fn();

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(function (this: any) {
    this.loadAddon = vi.fn();
    this.open = vi.fn();
    this.unicode = { activeVersion: '11' };
    this.attachCustomKeyEventHandler = vi.fn();
    this.onData = vi.fn();
    this.onScroll = vi.fn().mockReturnValue({ dispose: vi.fn() });
    this.write = writeSpy;
    this.reset = resetSpy;
    this.scrollToBottom = scrollToBottomSpy;
    this.refresh = vi.fn();
    this.focus = vi.fn();
    this.blur = vi.fn();
    this.dispose = vi.fn();
    this.clearTextureAtlas = vi.fn();
    this.hasSelection = vi.fn().mockReturnValue(false);
    this.getSelection = vi.fn().mockReturnValue('');
    this.paste = vi.fn();
    this.options = {};
    this.rows = 24;
    this.buffer = { active: { length: 24, viewportY: 0, ydisp: 0 } };
    this.scrollLines = vi.fn();
  }),
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(function (this: any) { this.fit = vi.fn(); this.proposeDimensions = vi.fn().mockReturnValue({ cols: 80, rows: 24 }); }),
}));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: vi.fn(function (this: any) {}) }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: vi.fn(function (this: any) { this.onContextLoss = vi.fn(); this.dispose = vi.fn(); }) }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('../src/renderer/platform', () => ({
  isAndroid: vi.fn().mockReturnValue(false),
  isTouchDevice: vi.fn().mockReturnValue(false),
  getPlatform: vi.fn().mockReturnValue('browser'),
}));
vi.mock('../src/renderer/state/theme-context', () => ({ useTheme: () => ({ activeTheme: null, reducedEffects: false }) }));
vi.mock('../src/renderer/hooks/terminal-registry', () => ({ registerTerminal: vi.fn(), unregisterTerminal: vi.fn(), notifyBufferReady: vi.fn() }));

import TerminalView from '../src/renderer/components/TerminalView';

if (typeof (globalThis as any).ResizeObserver === 'undefined') {
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}

// The order listeners were registered in, and the callbacks, as the shim would see them.
let registered: string[] = [];
let onOutput: ((data: string) => void) | null = null;
let onReset: (() => void) | null = null;

beforeEach(() => {
  registered = [];
  onOutput = null;
  onReset = null;
  resetSpy.mockReset(); scrollToBottomSpy.mockReset(); writeSpy.mockReset();
  (globalThis as any).window.claude = {
    session: { signalReady: vi.fn(), sendInput: vi.fn(), resize: vi.fn() },
    on: {
      ptyOutputForSession: (_sid: string, cb: (d: string) => void) => { registered.push('output'); onOutput = cb; return () => {}; },
      ptyResetForSession: (_sid: string, cb: () => void) => { registered.push('reset'); onReset = cb; return () => {}; },
      ptyRawBytesForSession: () => () => {},
    },
    off: vi.fn(),
  };
});
afterEach(() => { cleanup(); delete (globalThis as any).window.claude; });

describe('TerminalView on pty:reset', () => {
  it('registers the reset listener before the output listener', () => {
    render(<TerminalView sessionId="s1" visible={true} />);
    expect(registered.indexOf('reset')).toBeGreaterThan(-1);
    expect(registered.indexOf('reset')).toBeLessThan(registered.indexOf('output'));
  });

  it('clears the terminal and jumps to the bottom, then keeps drawing what follows', () => {
    render(<TerminalView sessionId="s1" visible={true} />);
    onOutput!('stale');
    onReset!();
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(scrollToBottomSpy).toHaveBeenCalledTimes(1);
    onOutput!('fresh');
    expect(writeSpy.mock.calls.map((c) => c[0])).toEqual(['stale', 'fresh']);
  });
});
