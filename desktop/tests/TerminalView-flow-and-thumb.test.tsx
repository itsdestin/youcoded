// @vitest-environment jsdom
// TerminalView + flow control (2026-10-04): (1) xterm scrolls on EVERY line of a flood, and the overlay scroll
// thumb used to write a style then read layout on each one — a forced layout per line, ~40% of the window's time
// (CPU profile, flood's first 1.5 s). It must update once per animation frame, and not at all while hidden.
// (2) The real component acknowledges drawn text to main (session.ackOutput) from xterm's write callback.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const scrollCbs: Array<() => void> = [];
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
    this.onScroll = vi.fn((cb: () => void) => { scrollCbs.push(cb); return { dispose: vi.fn() }; });
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
    this.buffer = { active: { length: 5000, viewportY: 100, ydisp: 100 } };
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
  isRemoteMode: vi.fn().mockReturnValue(false),
  getPlatform: vi.fn().mockReturnValue('browser'),
}));
vi.mock('../src/renderer/state/theme-context', () => ({ useTheme: () => ({ activeTheme: null, reducedEffects: false }) }));
vi.mock('../src/renderer/hooks/terminal-registry', () => ({ registerTerminal: vi.fn(), unregisterTerminal: vi.fn(), notifyBufferReady: vi.fn() }));

import TerminalView from '../src/renderer/components/TerminalView';

if (typeof (globalThis as any).ResizeObserver === 'undefined') {
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}

let onOutput: ((data: string) => void) | null = null;
const ackSpy = vi.fn();
let rafQueue: Array<() => void> = [];

beforeEach(() => {
  onOutput = null; scrollCbs.length = 0; ackSpy.mockReset(); writeSpy.mockReset(); rafQueue = [];
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { rafQueue.push(fn); return rafQueue.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  (globalThis as any).window.claude = {
    session: { signalReady: vi.fn(), sendInput: vi.fn(), resize: vi.fn(), ackOutput: ackSpy },
    on: {
      ptyOutputForSession: (_sid: string, cb: (d: string) => void) => { onOutput = cb; return () => {}; },
      ptyResetForSession: () => () => {},
      ptyRawBytesForSession: () => () => {},
    },
    off: vi.fn(),
  };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (globalThis as any).window.claude; });

describe('TerminalView scroll thumb', () => {
  it('a flood of scroll events costs one thumb update per frame, not one per line', () => {
    render(<TerminalView sessionId="s1" visible={true} />);
    rafQueue.length = 0;
    for (let i = 0; i < 2000; i++) scrollCbs.forEach((cb) => cb());
    expect(rafQueue.length).toBe(1);                      // one frame scheduled for 2,000 scrolls
    rafQueue.shift()!();
    for (let i = 0; i < 10; i++) scrollCbs.forEach((cb) => cb());
    expect(rafQueue.length).toBe(1);                      // and the next frame can schedule again
  });

  it('a hidden terminal schedules nothing at all', () => {
    render(<TerminalView sessionId="s1" visible={false} />);
    rafQueue.length = 0;
    for (let i = 0; i < 500; i++) scrollCbs.forEach((cb) => cb());
    expect(rafQueue.length).toBe(0);
  });
});

describe('TerminalView acknowledges what xterm drew', () => {
  it('reports the characters of each write once its callback fires', () => {
    writeSpy.mockImplementation((_d: string, cb?: () => void) => { cb?.(); });
    render(<TerminalView sessionId="s1" visible={true} />);
    onOutput!('hello');
    onOutput!('world!!');
    expect(ackSpy.mock.calls).toEqual([['s1', 5], ['s1', 7]]);
  });

  it('does not acknowledge a write xterm has not finished', () => {
    writeSpy.mockImplementation(() => { /* callback never fires */ });
    render(<TerminalView sessionId="s1" visible={true} />);
    onOutput!('hello');
    expect(ackSpy).not.toHaveBeenCalled();
  });
});

describe('TerminalView wiring the feeder to the repaint request', () => {
  it('passes onRepaintNeeded through the real window API (an optional hook the component forgot to supply would do nothing)', async () => {
    const fs = await import('node:fs'), path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'components', 'TerminalView.tsx'), 'utf8');
    expect(src).toMatch(/onRepaintNeeded:\s*\(\)\s*=>\s*window\.claude\.session\.requestRepaint\?\.\(sessionId\)/);
    expect(src).toMatch(/isAlive:\s*\(\)\s*=>\s*terminalRef\.current !== null/);
  });
});
