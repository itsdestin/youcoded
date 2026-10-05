// Main half of the hitch recorder: rate limits, stall + minute + startup lines, off switch, IPC trace.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHistogram } from 'node:perf_hooks';
import { HitchRecorder, startHitchRecorder, traceIpc, HITCH_CHANNEL, hitchLogDisabled, type RecorderDeps } from '../src/main/hitch-recorder';

const NOW = 1_800_000_000_000;
afterEach(() => vi.useRealTimers());

/** A histogram double: value() sets what the "event loop" saw this second, in ms. */
function fakeHist() {
  const h: any = { count: 0, max: 0, enable: () => true, disable: () => true, reset() { h.count = 0; h.max = 0; }, percentile: () => 0, percentiles: new Map<number, number>() };
  h.set = (ms: number) => { h.count = 50; h.max = ms * 1e6; h.percentiles = new Map([[0, ms * 1e6], [50, ms * 1e6], [100, ms * 1e6]]); };
  return h;
}
function setup(over: Partial<RecorderDeps> = {}) {
  const lines: any[] = [];
  const ipc = new EventEmitter();
  let clock = NOW;
  const hist = fakeHist();
  const rec = new HitchRecorder({
    userDataDir: '/nowhere', appVersion: '9.9.9', ipcMain: ipc as any,
    getWindowCount: () => 2, getSessionCount: () => 5,
    getAppMetrics: () => [
      { type: 'Browser', memory: { workingSetSize: 204800 }, cpu: { percentCPUUsage: 3.04 } },
      { type: 'Tab', memory: { workingSetSize: 512000 }, cpu: { percentCPUUsage: 10 } },
      { type: 'Tab', memory: { workingSetSize: 102400 }, cpu: { percentCPUUsage: 1 } },
      { type: 'GPU', memory: { workingSetSize: 307200 }, cpu: { percentCPUUsage: 2 } },
      { type: 'Utility', memory: { workingSetSize: 51200 }, cpu: { percentCPUUsage: 0 } },
    ],
    getMarks: () => [{ name: 'main:imports-done', t: NOW + 400 }, { name: 'main:when-ready', t: NOW + 900 }],
    processStartMs: () => NOW,
    now: () => clock,
    env: { YOUCODED_HITCH_LOOP_MS: '20' },
    writer: { append: (r: any) => lines.push(r), flush: async () => {} },
    histogram: () => hist, minuteHistogram: () => createHistogram(),
    ...over,
  });
  const send = (batch: unknown, id = 1) => ipc.emit(HITCH_CHANNEL, { sender: { id } }, batch);
  return { rec, lines, ipc, hist, send, advance: (ms: number) => { clock += ms; }, setClock: (t: number) => { clock = t; } };
}
const frame = (d = 200) => ({ k: 'frame', t: NOW, d, b: d - 50, sl: 5, rd: 5, inp: false, sc: [{ it: 'x', iv: 'y', fn: 'doWork', src: 'index-1.js', pos: 7, d: d - 10, fl: 0 }], ctx: { vis: 'visible', foc: true, vm: 'chat' } });
const batch = (entries: unknown[], extra: Record<string, unknown> = {}) => ({ v: 1, mode: 'loaf', kind: null, entries, tally: { f: 4, fms: 300, over: 0 }, dropped: 0, ...extra });

describe('renderer batches', () => {
  it('writes one line per entry with common fields, window id, session and window counts', () => {
    const { lines, send } = setup();
    send(batch([frame(), frame(300)]));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ v: '9.9.9', kind: 'frame', win: 'w1', d: 200, sessions: 5, windows: 2, src: 'loaf' });
    expect(lines[0].launch).toMatch(/^[0-9a-f]{8}$/);
    expect(new Date(lines[0].ts).toISOString()).toBe(lines[0].ts);
    expect(lines[0].sc[0].fn).toBe('doWork');
  });

  it('gives different windows different ids', () => {
    const { lines, send } = setup();
    send(batch([frame()]), 1); send(batch([frame()]), 2); send(batch([frame()]), 1);
    expect(lines.map((l) => l.win)).toEqual(['w1', 'w2', 'w1']);
  });

  it('hard rate limit: at most 30 detailed entries per minute per window, the rest tallied', () => {
    const { lines, send, advance, rec } = setup();
    // 5 batches of 20 within the minute (the renderer would never send this; main must not trust it)
    for (let i = 0; i < 5; i++) { send(batch(Array.from({ length: 20 }, () => frame()))); advance(1000); }
    expect(lines).toHaveLength(30);
    advance(60_000);
    send(batch([frame()]));
    expect(lines).toHaveLength(31); // a new minute starts a new allowance
    rec.onMinute();
    const minute = lines.at(-1);
    expect(minute.rend.over).toBe(70);
    expect(minute.rend.overMs).toBe(70 * 200);
  });

  it('limits batches per window per minute', () => {
    const { lines, send } = setup();
    for (let i = 0; i < 100; i++) send(batch([]));
    for (let i = 0; i < 100; i++) send(batch([frame()], { tally: { f: 0, fms: 0, over: 0 } }));
    expect(lines.length).toBe(0); // all after the 40th batch refused
  });

  it('ignores garbage without throwing and counts it', () => {
    const { lines, send, rec } = setup();
    for (const g of [null, 'x', 42, [], { v: 9 }, { v: 1, entries: 'no' }]) expect(() => send(g)).not.toThrow();
    expect(lines).toHaveLength(0);
    rec.onMinute();
    expect(lines[0].rend.rejected).toBeGreaterThanOrEqual(5);
  });
});

describe('main-process stalls', () => {
  it('writes main-stall at >=100 ms (minus the monitor tick) with the last IPC channel', () => {
    const origHandle = vi.fn();
    const ipcMain = Object.assign(new EventEmitter(), { handle: origHandle });
    let t = NOW;
    const trace = traceIpc(ipcMain as any, () => t);
    ipcMain.handle('session:create', () => 1);
    const h = origHandle.mock.calls[0][1];
    t = NOW + 10; h({});
    t = NOW + 410;
    const { lines, hist, rec } = setup({ trace });
    hist.set(420); rec.onSecond();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'main-stall', ms: 410, resMs: 20, lastIpc: 'session:create', sessions: 5 });
    expect(lines[0].lastIpcAgoMs).toBe(400);
  });

  it('writes nothing for a quiet second or a small hiccup', () => {
    const { lines, hist, rec } = setup();
    hist.set(20); rec.onSecond();
    hist.set(100); rec.onSecond(); // 100 - 20 tick + 10 = 90 ms < 100
    expect(lines).toHaveLength(0);
  });
});

describe('stall resolution', () => {
  it('defaults to a 100 ms sampler and estimates the stall at delay + half a tick', () => {
    const { lines, hist, rec } = setup({ env: {} });
    hist.set(150); rec.onSecond(); // 150 - 100 = 50 late, +50 = 100 -> written
    expect(lines[0]).toMatchObject({ kind: 'main-stall', ms: 100, resMs: 100 });
    hist.set(140); rec.onSecond(); // 40 late + 50 = 90 -> not written
    expect(lines).toHaveLength(1);
  });
  it('accepts a 10-1000 ms override and ignores nonsense', async () => {
    const { loopResolution } = await import('../src/main/hitch-recorder');
    expect(loopResolution({ YOUCODED_HITCH_LOOP_MS: '250' })).toBe(250);
    expect(loopResolution({ YOUCODED_HITCH_LOOP_MS: '1' })).toBe(100);
    expect(loopResolution({ YOUCODED_HITCH_LOOP_MS: 'abc' })).toBe(100);
    expect(loopResolution({})).toBe(100);
  });
});

describe('minute line', () => {
  it('is written on the 60th second with memory, CPU by process type, and tallies', () => {
    const { lines, hist, rec, send } = setup();
    send(batch([], { tally: { f: 7, fms: 500, over: 2 }, dropped: 1 }));
    for (let i = 0; i < 60; i++) { hist.set(25); rec.onSecond(); }
    const m = lines.filter((l) => l.kind === 'minute');
    expect(m).toHaveLength(1);
    expect(m[0].procs.browser).toEqual({ n: 1, ws: 200, cpu: 3 });
    expect(m[0].procs.gpu.ws).toBe(300);
    expect(m[0].procs.renderer).toEqual([{ ws: 500, cpu: 10 }, { ws: 100, cpu: 1 }]);
    expect(m[0].windows).toBe(2); expect(m[0].sessions).toBe(5);
    expect(m[0].rend).toMatchObject({ frames: 7, framesMs: 500, over: 2, dropped: 1 });
    expect(m[0].main.rss).toBeGreaterThan(0);
    expect(m[0].loop).toBeDefined();
    // the tally resets for the next minute
    for (let i = 0; i < 60; i++) rec.onSecond();
    expect(lines.filter((l) => l.kind === 'minute')[1].rend.frames).toBe(0);
  });

  it('is skipped while no window exists', () => {
    const { lines, rec } = setup({ getWindowCount: () => 0 });
    rec.onMinute();
    expect(lines).toHaveLength(0);
  });

  it('survives getAppMetrics throwing', () => {
    const { lines, rec } = setup({ getAppMetrics: () => { throw new Error('shutting down'); } });
    expect(() => rec.onMinute()).not.toThrow();
    expect(lines[0].kind).toBe('minute');
  });
});

describe('startup line', () => {
  it('is written once, when the renderer reports, with main mark deltas and renderer marks', () => {
    const { lines, send, rec, advance } = setup();
    advance(1500);
    rec.noteMainWindowLoaded();
    advance(3000);
    send(batch([], { startup: { marks: { 'yc:app-mounted': 2100, 'bad': 1 }, fcp: 800 } }));
    send(batch([], { startup: { marks: { 'yc:app-mounted': 9 }, fcp: 1 } })); // a reload later: not a second startup line
    const s = lines.filter((l) => l.kind === 'startup');
    expect(s).toHaveLength(1);
    expect(s[0].main).toEqual({ 'main:imports-done': 400, 'main:when-ready': 900 });
    expect(s[0].loadedMs).toBe(1500);
    expect(s[0].renderer).toEqual({ marks: { 'yc:app-mounted': 2100 }, fcp: 800 });
  });

  it('falls back to the main half after 30 s if the renderer never reports', () => {
    vi.useFakeTimers();
    const { lines, rec } = setup();
    rec.noteMainWindowLoaded();
    vi.advanceTimersByTime(29_000);
    expect(lines).toHaveLength(0);
    vi.advanceTimersByTime(2_000);
    expect(lines[0]).toMatchObject({ kind: 'startup', renderer: null });
  });

  it('ignores startup reports from buddy windows', () => {
    const { lines, send } = setup();
    send(batch([], { kind: 'buddy-mascot', startup: { marks: {}, fcp: 1 } }));
    expect(lines.filter((l) => l.kind === 'startup')).toHaveLength(0);
  });
});

describe('off switch and timers', () => {
  it('YOUCODED_HITCH_LOG=0 starts nothing', () => {
    expect(hitchLogDisabled({ YOUCODED_HITCH_LOG: '0' })).toBe(true);
    expect(hitchLogDisabled({})).toBe(false);
    const ipc = new EventEmitter();
    const r = startHitchRecorder({ env: { YOUCODED_HITCH_LOG: '0' }, ipcMain: ipc as any } as any);
    expect(r).toBeNull();
    expect(ipc.listenerCount(HITCH_CHANNEL)).toBe(0);
  });

  it('exactly one 1-second timer, unref\'d, cleared on stop', async () => {
    vi.useFakeTimers();
    const { rec } = setup({ startTimer: true });
    expect(vi.getTimerCount()).toBe(1);
    await rec.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('real perf_hooks histogram works end to end', async () => {
    const lines: any[] = [];
    const rec = new HitchRecorder({
      userDataDir: '/x', appVersion: '1', ipcMain: new EventEmitter() as any, getWindowCount: () => 1, getSessionCount: () => 0,
      getAppMetrics: () => [], getMarks: () => [], processStartMs: () => NOW, writer: { append: (r: any) => lines.push(r), flush: async () => {} },
    });
    await new Promise((r) => setTimeout(r, 300)); // let the monitor take its first samples
    const end = Date.now() + 300; while (Date.now() < end) { /* block the loop ~300 ms */ }
    await new Promise((r) => setTimeout(r, 250));
    rec.onSecond();
    await rec.stop();
    expect(lines.find((l) => l.kind === 'main-stall')?.ms).toBeGreaterThanOrEqual(100);
  });
});

describe('traceIpc', () => {
  it('does not trace the recorder\'s own channel', () => {
    const ipcMain: any = new EventEmitter();
    const orig = vi.fn(); ipcMain.handle = orig;
    const trace = traceIpc(ipcMain, () => 5);
    const fn = vi.fn();
    ipcMain.on(HITCH_CHANNEL, fn);
    ipcMain.emit(HITCH_CHANNEL, {}, 1);
    expect(fn).toHaveBeenCalled();
    expect(trace.last()).toBeNull();
  });
  it('records channel + age for handle and on, keeps off(original) working, masks id-like names', () => {
    const ipcMain: any = new EventEmitter();
    const origHandle = vi.fn();
    ipcMain.handle = origHandle;
    let t = 1000;
    const trace = traceIpc(ipcMain, () => t);
    expect(trace.last()).toBeNull();
    const fn = vi.fn();
    ipcMain.on('terminal:ack', fn);
    t = 1500; ipcMain.emit('terminal:ack', {}, 1);
    expect(fn).toHaveBeenCalledWith({}, 1);
    t = 1800;
    expect(trace.last()).toEqual({ channel: 'terminal:ack', agoMs: 300 });
    ipcMain.off('terminal:ack', fn);
    expect(ipcMain.listenerCount('terminal:ack')).toBe(0);
    ipcMain.handle('out:12345678-aaaa-bbbb-cccc-1234567890ab', () => 1);
    origHandle.mock.calls[0][1]({});
    expect(trace.last()!.channel).toBe('out:*');
  });
  it('preserves handler return values and this/args', async () => {
    const ipcMain: any = new EventEmitter();
    let registered: any;
    ipcMain.handle = (_c: string, f: any) => { registered = f; };
    traceIpc(ipcMain);
    ipcMain.handle('a:b', async (e: any, x: number) => x + 1);
    expect(await registered({}, 1)).toBe(2);
  });
});

describe('suspend / resume', () => {
  it('a 6-hour sleep is not a stall and does not pollute the minute line', () => {
    const { lines, hist, rec, advance } = setup();
    hist.set(25); rec.onSecond();
    advance(6 * 3600_000);              // wall clock jumped across a suspend
    hist.set(6 * 3600_000);             // Windows: the monotonic clock includes sleep
    rec.onSecond();
    expect(lines.filter((l) => l.kind === 'main-stall')).toEqual([]);
    for (let i = 0; i < 60; i++) { advance(1000); hist.set(25); rec.onSecond(); }
    const m = lines.find((l) => l.kind === 'minute');
    expect(m.loop.max).toBeLessThan(1000);
  });
  it('the OS suspend/resume signal resets the monitor and skips the next tick', () => {
    const { lines, hist, rec } = setup();
    hist.set(500);                      // measured stall already sitting in the histogram
    rec.noteSleep();
    hist.set(900); rec.onSecond();      // first tick after resume is late: skipped
    expect(lines.filter((l) => l.kind === 'main-stall')).toEqual([]);
    hist.set(900); rec.onSecond();      // a later real stall is recorded again
    expect(lines.filter((l) => l.kind === 'main-stall')).toHaveLength(1);
  });
  it('a stall longer than a minute is never real', () => {
    const { lines, hist, rec } = setup();
    hist.set(90_000); rec.onSecond();
    expect(lines).toHaveLength(0);
  });
});

describe('window bookkeeping', () => {
  it('prunes a window when its webContents is destroyed, so ids never run out; overflow is counted', () => {
    const { lines, rec, ipc } = setup();
    const senders: any[] = [];
    for (let i = 0; i < 200; i++) {
      const listeners: Array<() => void> = [];
      const sender = { id: i, once: (_: string, f: () => void) => listeners.push(f) };
      senders.push({ sender, listeners });
      ipc.emit(HITCH_CHANNEL, { sender }, batch([frame()]));
      listeners.forEach((f) => f()); // window closed
    }
    expect(lines).toHaveLength(200);
    // 70 windows alive at once: the extra ones are dropped AND counted
    const alive = Array.from({ length: 70 }, (_, i) => ({ id: 1000 + i, once: () => {} }));
    const before = lines.length;
    for (const s of alive) ipc.emit(HITCH_CHANNEL, { sender: s }, batch([frame()]));
    expect(lines.length - before).toBe(64);
    rec.onMinute();
    expect(lines.at(-1).rend.rejected).toBeGreaterThanOrEqual(6);
  });
});

describe('traceIpc with once/off', () => {
  it('ipcMain.once fires once and ipcMain.off(ch, original) removes a pending one', () => {
    const ipcMain: any = new EventEmitter();
    ipcMain.handle = vi.fn();
    traceIpc(ipcMain, () => 1);
    const a = vi.fn();
    ipcMain.once('x:y', a);
    ipcMain.emit('x:y', {}); ipcMain.emit('x:y', {});
    expect(a).toHaveBeenCalledTimes(1);
    const b = vi.fn();
    ipcMain.once('x:z', b);
    ipcMain.off('x:z', b);
    ipcMain.emit('x:z', {});
    expect(b).not.toHaveBeenCalled();
    expect(ipcMain.listenerCount('x:z')).toBe(0);
  });
});
