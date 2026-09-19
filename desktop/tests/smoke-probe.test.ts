// The installer launch check (scripts/smoke-test.js) and the app's answer to it
// (src/main/smoke-probe.ts) must agree on two exact lines. The check is plain JS
// and cannot import the TS constants, so this pins the copies together — the
// old check silently broke when the log line it borrowed was moved.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { SMOKE_READY, SMOKE_BLANK, isSmokeTest, reportWhenRendered } from '../src/main/smoke-probe';

afterEach(() => { vi.useRealTimers(); });

function fakeWindow(answers: Array<boolean | Error>) {
  const wc = new EventEmitter() as EventEmitter & { executeJavaScript: (s: string) => Promise<boolean> };
  wc.executeJavaScript = vi.fn(async () => {
    const a = answers.length > 1 ? answers.shift()! : answers[0];
    if (a instanceof Error) throw a;
    return a;
  });
  return wc;
}

describe('installer launch check', () => {
  it('waits for exactly the lines the app prints', () => {
    const smoke = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'smoke-test.js'), 'utf8');
    expect(smoke).toContain(`const SMOKE_READY = '${SMOKE_READY}';`);
    expect(smoke).toContain(`const SMOKE_BLANK = '${SMOKE_BLANK}';`);
  });

  it('only runs when the check asks for it', () => {
    expect(isSmokeTest({ YOUCODED_SMOKE_TEST: '1' })).toBe(true);
    expect(isSmokeTest({})).toBe(false);
  });

  it('reports ready once the main window has rendered, after waiting through a blank start', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const wc = fakeWindow([false, new Error('navigating'), true]);
    reportWhenRendered(wc as any, (l) => lines.push(l));
    expect(lines).toEqual([]); // nothing before the page has loaded
    wc.emit('did-finish-load');
    await vi.advanceTimersByTimeAsync(2000);
    expect(lines).toEqual([SMOKE_READY]);
  });

  it('reports a blank window when nothing ever renders', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const wc = fakeWindow([false]);
    reportWhenRendered(wc as any, (l) => lines.push(l));
    wc.emit('did-finish-load');
    await vi.advanceTimersByTimeAsync(25_000);
    expect(lines).toEqual([SMOKE_BLANK]);
  });
});
