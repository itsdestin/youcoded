// Renderer half of the hitch recorder, which lives INLINE in the sandboxed preload (it cannot
// import modules). Same approach as buddy-zoom.test.ts: transpile the real preload and run it in a
// vm with fake browser objects, so what is tested is the code that ships.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const preload = ts.transpileModule(
  readFileSync(new URL('../src/main/preload.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } },
).outputText;

/** A PerformanceObserver double that lets the test push entries by type. */
function fakePO(types: string[]) {
  const observers: Array<{ cb: (l: any) => void; type: string; opts: any }> = [];
  class PO {
    static supportedEntryTypes = types;
    cb: (l: any) => void;
    constructor(cb: (l: any) => void) { this.cb = cb; }
    observe(opts: any) { observers.push({ cb: this.cb, type: opts.type, opts }); }
  }
  const emit = (type: string, entries: any[]) => observers.filter((o) => o.type === type).forEach((o) => o.cb({ getEntries: () => entries }));
  return { PO, observers, emit };
}

function boot(opts: { types?: string[]; env?: Record<string, string>; search?: string } = {}) {
  const po = fakePO(opts.types ?? ['long-animation-frame', 'event', 'longtask']);
  const sent: any[] = [];
  const timers: Array<{ f: () => void; ms: number; done?: boolean }> = [];
  const exposed: any[] = [];
  const listeners: Record<string, () => void> = {};
  let nowMs = 1_800_000_000_000;
  const sandbox: any = {
    exports: {}, process: { env: opts.env ?? {}, platform: 'linux' }, location: { search: opts.search ?? '' }, URLSearchParams,
    PerformanceObserver: po.PO,
    performance: { timeOrigin: 1_800_000_000_000 - 5000, getEntriesByType: () => [{ name: 'yc:app-mounted', startTime: 2100.6 }, { name: 'other', startTime: 1 }], getEntriesByName: () => [{ startTime: 640.2 }] },
    document: {
      visibilityState: 'visible', hasFocus: () => true, documentElement: { dataset: { viewMode: 'chat' } },
      querySelector: (sel: string) => (sel.includes('dialog') ? {} : null), getElementsByTagName: () => ({ length: 1234 }),
    },
    window: { devicePixelRatio: 2, addEventListener: (n: string, f: () => void) => { listeners[n] = f; } },
    Date: { now: () => nowMs },
    setTimeout: (f: () => void, ms: number) => { const t = { f, ms }; timers.push(t); return t; },
    require: () => ({
      contextBridge: { exposeInMainWorld: (_n: string, api: any) => exposed.push(api) },
      ipcRenderer: { on: vi.fn(), invoke: vi.fn(), send: (ch: string, b: any) => sent.push({ ch, b }) },
      webFrame: { setZoomFactor: vi.fn() },
    }),
  };
  vm.runInNewContext(preload, sandbox);
  const fire = (ms: number) => { for (const t of timers.filter((x) => !x.done && x.ms === ms)) { t.done = true; t.f(); } };
  return { ...po, sent, timers, exposed, listeners, sandbox, fire, advance: (ms: number) => { nowMs += ms; } };
}
const loaf = (over: Record<string, unknown> = {}) => ({
  startTime: 5000, duration: 300, blockingDuration: 250, renderStart: 5200, styleAndLayoutStart: 5260, firstUIEventTimestamp: 4990,
  scripts: [
    { invokerType: 'event-listener', invoker: 'BUTTON#send-btn.onclick', sourceFunctionName: 'small', sourceURL: 'app://x/assets/index-abc123.js?v=3#frag', sourceCharPosition: 10, duration: 5, forcedStyleAndLayoutDuration: 0 },
    { invokerType: 'user-callback', invoker: 'TimerHandler:setTimeout', sourceFunctionName: 'big', sourceURL: 'blob:app://secret-id', sourceCharPosition: 99, duration: 200, forcedStyleAndLayoutDuration: 30 },
    { invokerType: 'resolve-promise', invoker: 'Promise.resolve', sourceFunctionName: 'mid', sourceURL: '', sourceCharPosition: 1, duration: 50, forcedStyleAndLayoutDuration: 0 },
    { invokerType: 'x', invoker: 'y', sourceFunctionName: 'fourth', sourceURL: 'a.js', sourceCharPosition: 1, duration: 1, forcedStyleAndLayoutDuration: 0 },
  ], ...over,
});

describe('renderer hitch recorder (inlined in preload)', () => {
  it('adds nothing to window.claude', () => {
    const { exposed } = boot();
    const keys = Object.keys(exposed[0]);
    expect(keys.filter((k) => /hitch/i.test(k))).toEqual([]);
  });

  it('observes LoAF (buffered) and slow events (104 ms threshold), and nothing else', () => {
    const { observers } = boot();
    expect(observers.map((o) => o.type).sort()).toEqual(['event', 'long-animation-frame']);
    expect(observers.find((o) => o.type === 'long-animation-frame')!.opts.buffered).toBe(true);
    expect(observers.find((o) => o.type === 'event')!.opts.durationThreshold).toBe(104);
  });

  it('records a long frame with top-3 scripts, sanitised', () => {
    const t = boot();
    t.emit('long-animation-frame', [loaf()]);
    expect(t.sent).toHaveLength(0); // batched, not sent per entry
    t.fire(5000);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].ch).toBe('perf:hitch-batch');
    const b = t.sent[0].b;
    expect(b).toMatchObject({ v: 1, mode: 'loaf', kind: null, dropped: 0 });
    const e = b.entries[0];
    expect(e).toMatchObject({ k: 'frame', d: 300, b: 250, inp: true, sl: 40, rd: 60 });
    expect(e.sc.map((s: any) => s.fn)).toEqual(['big', 'mid', 'small']);
    expect(e.sc[0]).toMatchObject({ src: 'inline', fl: 30, d: 200 });
    expect(e.sc[2].src).toBe('index-abc123.js');
    expect(e.sc[2].iv).toBe('BUTTON#.onclick'); // element id removed
    expect(e.ctx).toMatchObject({ vis: 'visible', foc: true, vm: 'chat', dlg: true, scr: false, dpr: 2, els: 1234 });
  });

  it('only tallies 50-100 ms frames (no per-frame entry)', () => {
    const t = boot();
    t.emit('long-animation-frame', [loaf({ duration: 60 }), loaf({ duration: 99 })]);
    t.fire(5000);
    expect(t.sent[0].b.entries).toEqual([]);
    expect(t.sent[0].b.tally).toMatchObject({ f: 2, fms: 159 });
  });

  it('records slow interactions with a coarse target and never any text or key', () => {
    const t = boot();
    const target = (m: Record<string, boolean>) => ({ closest: (sel: string) => (Object.entries(m).find(([k]) => sel.includes(k))?.[1] ? {} : null), textContent: 'MY SECRET DRAFT', value: 'secret' });
    t.emit('event', [
      { name: 'keydown', startTime: 100, duration: 200, processingStart: 130, processingEnd: 250, target: target({ '.xterm': true }), key: 'a' },
      { name: 'pointermove', startTime: 100, duration: 500, processingStart: 100, processingEnd: 120, target: target({}) },
      { name: 'click', startTime: 100, duration: 150, processingStart: 110, processingEnd: 200, target: target({ textarea: true }) },
      { name: 'input', startTime: 100, duration: 150, processingStart: 110, processingEnd: 200, target: null },
    ]);
    t.fire(5000);
    const es = t.sent[0].b.entries;
    expect(es.map((e: any) => [e.type, e.tgt])).toEqual([['keydown', 'terminal'], ['click', 'text-input'], ['input', 'other']]);
    expect(es[0]).toMatchObject({ d: 200, delay: 30, proc: 120, pres: 50 });
    const json = JSON.stringify(t.sent);
    expect(json).not.toContain('SECRET'); expect(json).not.toContain('"key"'); expect(json).not.toContain('secret');
  });

  it('hard-caps detailed entries at 30 per minute per window and tallies the rest', () => {
    const t = boot();
    t.emit('long-animation-frame', Array.from({ length: 80 }, () => loaf()));
    t.fire(5000);
    expect(t.sent[0].b.entries).toHaveLength(30);
    expect(t.sent[0].b.tally.over).toBe(50);
    t.advance(61_000);
    t.emit('long-animation-frame', [loaf()]);
    t.fire(5000);
    expect(t.sent[1].b.entries).toHaveLength(1);
  });

  it('sends at most every 5 s (one timer for any burst) and arms nothing while nothing is slow', () => {
    const t = boot();
    expect(t.timers.map((x) => x.ms)).toEqual([10_000]); // only the one-shot startup report
    t.emit('long-animation-frame', [loaf(), loaf(), loaf()]);
    t.emit('long-animation-frame', [loaf()]);
    expect(t.timers.filter((x) => x.ms === 5000)).toHaveLength(1);
  });

  it('flushes on pagehide', () => {
    const t = boot();
    t.emit('long-animation-frame', [loaf()]);
    t.listeners.pagehide();
    expect(t.sent).toHaveLength(1);
  });

  it('computes the element count at most once per 10 s', () => {
    const t = boot();
    const spy = vi.spyOn(t.sandbox.document, 'getElementsByTagName');
    t.emit('long-animation-frame', [loaf(), loaf(), loaf()]);
    expect(spy).toHaveBeenCalledTimes(1);
    t.advance(11_000);
    t.emit('long-animation-frame', [loaf()]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('falls back to longtask when LoAF is unsupported, and says so', () => {
    const t = boot({ types: ['longtask', 'event'] });
    expect(t.observers.map((o) => o.type).sort()).toEqual(['event', 'longtask']);
    t.emit('longtask', [{ startTime: 5000, duration: 180 }, { startTime: 5000, duration: 70 }]);
    t.fire(5000);
    expect(t.sent[0].b.mode).toBe('longtask');
    expect(t.sent[0].b.entries).toMatchObject([{ k: 'task', d: 180 }]);
    expect(t.sent[0].b.tally.f).toBe(1);
  });

  it('does nothing at all without any supported entry type', () => {
    const t = boot({ types: [] });
    expect(t.observers).toEqual([]);
    expect(t.timers).toEqual([]);
  });

  it('YOUCODED_HITCH_LOG=0 installs nothing', () => {
    const t = boot({ env: { YOUCODED_HITCH_LOG: '0' } });
    expect(t.observers).toEqual([]);
    expect(t.timers).toEqual([]);
  });

  it('reports the app marks and first paint once, 10 s after load', () => {
    const t = boot();
    t.fire(10_000);
    expect(t.sent[0].b.startup).toEqual({ marks: { 'yc:app-mounted': 2101 }, fcp: 640 });
    expect(t.sent[0].b.entries).toEqual([]);
  });

  it('tells main which buddy window it is', () => {
    const t = boot({ search: '?mode=buddy-chat' });
    t.emit('long-animation-frame', [loaf()]);
    t.fire(5000);
    expect(t.sent[0].b.kind).toBe('buddy-chat');
  });

  it('a missing browser API never breaks the preload', () => {
    const sandbox: any = { exports: {}, process: { env: {} }, location: { search: '' }, URLSearchParams, require: () => ({ contextBridge: { exposeInMainWorld: vi.fn() }, ipcRenderer: { on: vi.fn() }, webFrame: {} }) };
    expect(() => vm.runInNewContext(preload, sandbox)).not.toThrow();
  });
});
