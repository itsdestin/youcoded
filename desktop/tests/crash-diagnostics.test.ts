/**
 * Guards the diagnostics added after the 2026-09-03 macOS incident, where a
 * tester's app wedged, was force quit, and left NO artifact of any kind — no
 * crash report, and nothing in our own log saying the app had stopped
 * responding. Each test below pins one of those blind spots shut.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';

const appOn = vi.fn();
const crashStart = vi.fn();
let crashDumpsDir = '/nonexistent';

vi.mock('electron', () => ({
  app: {
    on: (...args: unknown[]) => appOn(...args),
    getPath: (name: string) => {
      if (name === 'crashDumps') return crashDumpsDir;
      return '/tmp';
    },
  },
  crashReporter: { start: (...args: unknown[]) => crashStart(...args) },
}));

const logged: Array<{ level: string; msg: string; extra?: Record<string, unknown> }> = [];
vi.mock('../src/main/logger', () => ({
  log: (level: string, _c: string, msg: string, extra?: Record<string, unknown>) => {
    logged.push({ level, msg, extra });
  },
  rotateLog: vi.fn(),
}));

import {
  installCrashDiagnostics,
  reportPreviousCrashes,
  wireWindowHangDiagnostics,
} from '../src/main/crash-diagnostics';

beforeEach(() => {
  logged.length = 0;
  appOn.mockClear();
  crashStart.mockClear();
});

describe('installCrashDiagnostics', () => {
  it('starts the crash reporter with uploading OFF and no submit URL', () => {
    installCrashDiagnostics();
    expect(crashStart).toHaveBeenCalledTimes(1);
    const opts = crashStart.mock.calls[0][0] as Record<string, unknown>;
    // The privacy contract: dumps stay on the machine. A submitURL would send
    // them somewhere, and uploadToServer defaults to TRUE if omitted.
    expect(opts.uploadToServer).toBe(false);
    expect(opts.submitURL).toBeUndefined();
  });

  it('listens for renderer and child process deaths', () => {
    installCrashDiagnostics();
    const events = appOn.mock.calls.map((c) => c[0]);
    expect(events).toContain('render-process-gone');
    expect(events).toContain('child-process-gone');
  });

  it('logs a renderer crash at ERROR, and a clean exit at INFO', () => {
    installCrashDiagnostics();
    const handler = appOn.mock.calls.find((c) => c[0] === 'render-process-gone')![1] as
      (e: unknown, wc: unknown, d: { reason: string; exitCode: number }) => void;

    handler({}, {}, { reason: 'crashed', exitCode: 139 });
    expect(logged.at(-1)).toMatchObject({ level: 'ERROR', extra: { reason: 'crashed', exitCode: 139 } });

    handler({}, {}, { reason: 'clean-exit', exitCode: 0 });
    expect(logged.at(-1)!.level).toBe('INFO');
  });

  it('records which child process died and why', () => {
    installCrashDiagnostics();
    const handler = appOn.mock.calls.find((c) => c[0] === 'child-process-gone')![1] as
      (e: unknown, d: Record<string, unknown>) => void;

    handler({}, { type: 'GPU', reason: 'oom', exitCode: 9, name: 'GPU Process' });
    expect(logged.at(-1)).toMatchObject({
      level: 'ERROR',
      extra: { type: 'GPU', reason: 'oom', exitCode: 9 },
    });
  });

  it('does not throw when the crash reporter cannot start', () => {
    crashStart.mockImplementationOnce(() => {
      throw new Error('crashpad unavailable');
    });
    expect(() => installCrashDiagnostics()).not.toThrow();
    expect(logged.some((l) => l.level === 'WARN')).toBe(true);
  });
});

describe('reportPreviousCrashes', () => {
  it('says nothing when there are no dumps', () => {
    crashDumpsDir = path.join(os.tmpdir(), 'yc-nodumps-' + process.pid);
    reportPreviousCrashes();
    expect(logged).toHaveLength(0);
  });

  it('finds a dump nested inside Crashpad subdirectories', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-dumps-'));
    const nested = path.join(dir, 'completed');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'abc.dmp'), 'x');
    crashDumpsDir = dir;

    reportPreviousCrashes();

    expect(logged).toHaveLength(1);
    expect(logged[0].level).toBe('WARN');
    expect(logged[0].extra).toMatchObject({ count: 1 });
    expect(String(logged[0].extra!.newest)).toContain('abc.dmp');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('wireWindowHangDiagnostics', () => {
  it('logs a hang, then how long it lasted', () => {
    const win = new EventEmitter();
    wireWindowHangDiagnostics(win as never, 'main');

    win.emit('unresponsive');
    expect(logged.at(-1)).toMatchObject({ level: 'ERROR', msg: 'window stopped responding' });

    win.emit('responsive');
    expect(logged.at(-1)!.msg).toBe('window responded again');
    expect(typeof logged.at(-1)!.extra!.hungForMs).toBe('number');
  });

  it('records a window closed while still hung — the force-quit shape', () => {
    const win = new EventEmitter();
    wireWindowHangDiagnostics(win as never, 'main');

    win.emit('unresponsive');
    win.emit('closed');

    expect(logged.at(-1)!.msg).toBe('window closed while still unresponsive');
  });

  it('stays quiet when a healthy window closes', () => {
    const win = new EventEmitter();
    wireWindowHangDiagnostics(win as never, 'main');
    win.emit('closed');
    expect(logged).toHaveLength(0);
  });
});
