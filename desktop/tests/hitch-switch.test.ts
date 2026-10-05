// Switch marks, renderer half: the state machine inside the sandboxed preload (start -> first frame -> settled / interrupted /
// streaming / cap / hidden / closed), driven with a virtual clock, fake timers, a fake requestAnimationFrame, a fake
// MutationObserver and fake PerformanceObservers. Same approach as hitch-preload.test.ts: the REAL preload source is transpiled and run
// in a vm, so what is tested is the code that ships.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const preload = ts.transpileModule(
  readFileSync(new URL('../src/main/preload.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } },
).outputText;

const ORIGIN = 1_800_000_000_000 - 5000;
const FRAME = 16;

function rig(opts: { panes?: Record<string, number>; types?: string[] } = {}) {
  let clock = 5000; // performance.now()
  const timers: Array<{ id: number; at: number; f: () => void; ms: number; done: boolean; cancelled: boolean }> = [];
  let nextTimer = 1;
  const addTimer = (f: () => void, ms: number) => { const t = { id: nextTimer++, at: clock + ms, f, ms, done: false, cancelled: false }; timers.push(t); return t; };
  const sent: any[] = [];
  const observers: any[] = [];       // PerformanceObservers
  const mos: any[] = [];             // MutationObservers
  const listeners: Record<string, Array<(e: any) => void>> = {};
  const winListeners: Record<string, () => void> = {};
  const panes = opts.panes ?? { s1: 12, s2: 40, s3: 0 };

  class PO {
    static supportedEntryTypes = opts.types ?? ['long-animation-frame', 'event', 'longtask', 'layout-shift'];
    cb: (l: any) => void; type = ''; queue: any[] = []; disconnected = false;
    constructor(cb: (l: any) => void) { this.cb = cb; observers.push(this); }
    observe(o: any) { this.type = o.type; }
    takeRecords() { const q = this.queue; this.queue = []; return q; }
    disconnect() { this.disconnected = true; }
  }
  class MO {
    cb: (r: any[]) => void; target: any = null; opts: any = null; queue: any[] = []; disconnected = false;
    constructor(cb: (r: any[]) => void) { this.cb = cb; mos.push(this); }
    observe(t: any, o: any) { this.target = t; this.opts = o; }
    takeRecords() { const q = this.queue; this.queue = []; return q; }
    disconnect() { this.disconnected = true; }
  }
  const document: any = {
    visibilityState: 'visible', hasFocus: () => true, documentElement: { dataset: { viewMode: 'chat' } },
    querySelector: (sel: string) => {
      const m = /data-chat-session-id="([^"]*)"/.exec(sel);
      if (m) {
        const n = panes[m[1]];
        if (n === undefined) return null;
        return { querySelector: () => (n > 0 ? { parentElement: { childElementCount: n } } : null) };
      }
      return null;
    },
    getElementsByTagName: () => ({ length: 100 }),
    addEventListener: (n: string, f: (e: any) => void) => { (listeners[n] ??= []).push(f); },
  };
  const sandbox: any = {
    exports: {}, process: { env: {}, platform: 'linux' }, location: { search: '', href: 'file:///opt/app/dist/renderer/index.html' }, URLSearchParams,
    PerformanceObserver: PO, MutationObserver: MO,
    performance: { timeOrigin: ORIGIN, now: () => clock, getEntriesByType: () => [], getEntriesByName: () => [] },
    document,
    window: { devicePixelRatio: 1, addEventListener: (n: string, f: () => void) => { winListeners[n] = f; } },
    Date: { now: () => ORIGIN + clock },
    setTimeout: (f: () => void, ms: number) => addTimer(f, ms),
    clearTimeout: (t: any) => { if (t) t.cancelled = true; },
    requestAnimationFrame: (f: () => void) => { const at = (Math.floor(clock / FRAME) + 1) * FRAME; const t = { id: nextTimer++, at, f, ms: -1, done: false, cancelled: false }; timers.push(t); return t; },
    cancelAnimationFrame: (t: any) => { if (t) t.cancelled = true; },
    require: () => ({
      contextBridge: { exposeInMainWorld: () => {} },
      ipcRenderer: { on: vi.fn(), invoke: vi.fn(), send: (ch: string, b: any) => sent.push({ ch, b }) },
      webFrame: { setZoomFactor: vi.fn() },
    }),
  };
  vm.runInNewContext(preload, sandbox);

  /** Run every timer/frame due up to `ms` from now, in time order (virtual time). */
  const advance = (ms: number) => {
    const end = clock + ms;
    for (;;) {
      const due = timers.filter((t) => !t.done && !t.cancelled && t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      clock = Math.max(clock, due.at);
      due.done = true;
      due.f();
    }
    clock = end;
  };
  const detail = (o: Record<string, unknown>) => ({ detail: JSON.stringify(o) });
  const fire = (name: string, o: Record<string, unknown>) => (listeners[name] ?? []).forEach((f) => f(detail(o)));
  const start = (o: Record<string, unknown> = {}) => fire('yc:switch', { q: 1, r: 1, id: 's1', vm: 'chat', k: 'claude', s: 0, n: 3, c: 'pill', t: clock - 4, ...o });
  /** Every switch line the window has reported, after flushing. */
  const lines = (): any[] => { advance(6000); return sent.flatMap((s) => s.b.sw ?? []); };
  const pending = () => timers.filter((t) => !t.done && !t.cancelled);
  const raw = (name: string, d: unknown) => (listeners[name] ?? []).forEach((f) => f({ detail: d }));
  return { advance, fire, raw, start, lines, sent, observers, mos, panes, document, winListeners, pending, now: () => clock, sandbox };
}

describe('switch marks: the state machine', () => {
  it('start -> first frame -> settled, measuring from the input event', () => {
    const r = rig();
    r.advance(100);
    r.start({ t: r.now() - 6 }); // the click happened 6 ms before the page noticed
    r.advance(1000);
    const [l] = r.lines();
    expect(l).toMatchObject({ cause: 'pill', vm: 'chat', dk: 'claude', str: false, cold: true, open: 3, end: 'settled', e1: 12, e2: 12, mut: 0, ls: 0, loaf: 0, ind: null, gap: null });
    // first frame = next 16 ms boundary after the page noticed + 6 ms already elapsed since the input
    expect(l.ff).toBeGreaterThanOrEqual(6);
    expect(l.ff).toBeLessThanOrEqual(6 + FRAME + 1);
    expect(l.st).toBe(l.ff); // nothing changed after the first frame: settled AT the first frame
  });

  it('late DOM changes push settled past the first frame (and are counted)', () => {
    const r = rig();
    r.advance(100);
    r.start();
    r.advance(40);                       // first frame has happened by now
    const mo = r.mos[0];
    expect(mo.opts).toEqual({ childList: true, subtree: true, characterData: true }); // no attributes
    r.advance(50);
    mo.cb([{}, {}, {}]);                 // 3 mutations (e.g. old messages un-blanking)
    r.advance(1000);
    const [l] = r.lines();
    expect(l.end).toBe('settled');
    expect(l.mut).toBe(3);
    expect(l.st).toBeGreaterThan(l.ff + 40);
  });

  it('counts layout shifts the user did not cause, and a shift pushes settled out', () => {
    const r = rig();
    r.start();
    r.advance(40);
    const lso = r.observers.find((o) => o.type === 'layout-shift');
    lso.cb({ getEntries: () => [{ value: 0.12, startTime: r.now(), hadRecentInput: false }, { value: 0.5, startTime: r.now(), hadRecentInput: true }] });
    r.advance(1000);
    const [l] = r.lines();
    expect(l.ls).toBe(1);
    expect(l.lsv).toBeCloseTo(0.12, 3);
    expect(l.st).toBeGreaterThan(l.ff);
  });

  it('a pane that keeps changing ends at the cap: "streaming" when the destination was streaming, else "cap"; settled is null either way', () => {
    for (const str of [1, 0]) {
      const r = rig();
      r.start({ s: str });
      for (let i = 0; i < 80; i++) { r.advance(50); r.mos[0]?.cb([{}]); }
      const [l] = r.lines();
      expect(l.end).toBe(str ? 'streaming' : 'cap');
      expect(l.st).toBeNull();
      expect(l.str).toBe(!!str);
      expect(l.ff).not.toBeNull();
      expect(l.mut).toBeGreaterThan(30);
    }
  });

  it('a switch while another is unsettled closes the first as interrupted and starts the next', () => {
    const r = rig();
    r.start({ id: 's1' });
    r.advance(5);                         // before s1's first frame
    r.start({ id: 's2', q: 2 });
    r.advance(2000);
    const ls = r.lines();
    expect(ls).toHaveLength(2);
    expect(ls[0]).toMatchObject({ end: 'interrupted', st: null, ff: null });
    expect(ls[1]).toMatchObject({ end: 'settled', e1: 40 });
    expect(ls[1].gap).toBeGreaterThanOrEqual(0);
  });

  it('ten spaced switches (200 ms apart) each settle: ten lines, none interrupted, never more than one observer alive', () => {
    const r = rig();
    const ids = ['s1', 's2'];
    for (let i = 0; i < 10; i++) {
      r.start({ id: ids[i % 2], q: i + 1 });
      r.advance(200);
      expect(r.mos.filter((m) => !m.disconnected).length).toBeLessThanOrEqual(1);
    }
    r.advance(1000);
    const ls = r.lines();
    expect(ls).toHaveLength(10);
    expect(ls.filter((l) => l.end === 'interrupted')).toHaveLength(0); // 200 ms apart: each had its first frame and its 150 ms of quiet
  });

  it('flips faster than the quiet window are interrupted, one line each', () => {
    const r = rig();
    const ids = ['s1', 's2'];
    for (let i = 0; i < 10; i++) { r.start({ id: ids[i % 2], q: i + 1 }); r.advance(100); }
    r.advance(1000);
    const ls = r.lines();
    expect(ls).toHaveLength(10);
    expect(ls.filter((l) => l.end === 'interrupted')).toHaveLength(9);
    expect(ls[9].end).toBe('settled');
    // revisits: the first two are cold, the rest are warm
    expect(ls.map((l) => l.cold)).toEqual([true, true, false, false, false, false, false, false, false, false]);
    expect(ls[3].gap).toBeGreaterThan(90);
    expect(ls[3].gap).toBeLessThan(110);
  });

  it('a hidden page ends the switch as "hidden"; losing focus does not', () => {
    const r = rig();
    r.start();
    r.advance(5);
    r.winListeners.blur?.();
    r.advance(200);
    expect(r.lines()[0].end).toBe('settled');
    const r2 = rig();
    r2.start();
    r2.advance(5);
    r2.document.visibilityState = 'hidden';
    r2.sandbox.document.addEventListener; // (listener registry lives in the rig)
    r2.fire('visibilitychange', {});
    r2.advance(10);
    const ls = r2.lines();
    expect(ls).toHaveLength(1);
    expect(ls[0].end).toBe('hidden');
    expect(r2.pending().filter((t) => t.ms >= 0 && t.ms <= 3000)).toHaveLength(0);
  });

  it('a switch that starts while the page is hidden records nothing', () => {
    const r = rig();
    r.document.visibilityState = 'hidden';
    r.start();
    r.advance(4000);
    expect(r.lines()).toHaveLength(0);
    expect(r.mos).toHaveLength(0);
  });

  it('losing the last session mid-switch ends it as "closed"', () => {
    const r = rig();
    r.start();
    r.advance(5);
    r.fire('yc:switch-none', {});
    expect(r.lines()[0]).toMatchObject({ end: 'closed', st: null });
  });

  it('a first selection (r = 0) is remembered as visited but not recorded', () => {
    const r = rig();
    r.start({ r: 0, id: 's1' });
    r.advance(1000);
    r.start({ id: 's2', q: 2 });
    r.advance(1000);
    r.start({ id: 's1', q: 3 });
    r.advance(1000);
    const ls = r.lines();
    expect(ls).toHaveLength(2);
    expect(ls.map((l) => l.cold)).toEqual([true, false]);
    expect(ls[0].gap).toBeNull();
  });

  it('terminal view: settled is when xterm has parsed the backlog; no DOM observer is created; drained chars are reported', () => {
    const r = rig();
    r.advance(100);
    r.start({ vm: 'terminal', dr: 123456, q: 7 });
    r.advance(100);                       // first frame has passed, backlog still parsing
    expect(r.mos).toHaveLength(0);
    r.advance(80);
    r.fire('yc:switch-term', { q: 7 });
    const [l] = r.lines();
    expect(l).toMatchObject({ vm: 'terminal', end: 'settled', drain: 123456, e1: null, e2: null, mut: 0 });
    expect(l.st).toBeGreaterThan(l.ff + 100);
  });

  it('terminal view: a drained report for a different switch is ignored; no report at all ends at the cap', () => {
    const r = rig();
    r.start({ vm: 'terminal', dr: 5, q: 9 });
    r.advance(100);
    r.fire('yc:switch-term', { q: 8 });
    r.advance(4000);
    expect(r.lines()[0]).toMatchObject({ end: 'cap', st: null, drain: 5 });
  });

  it('terminal view with nothing to wait for (no terminal show reported) settles at the first frame', () => {
    const r = rig();
    r.start({ vm: 'terminal' });
    r.advance(200);
    const [l] = r.lines();
    expect(l).toMatchObject({ end: 'settled', drain: null });
    expect(l.st).toBe(l.ff);
  });

  it('long frames and a slow input inside the window are counted from what the browser had queued but not yet delivered', () => {
    const r = rig();
    r.start({ t: r.now() - 4 });
    r.advance(30);
    const frames = r.observers.find((o) => o.type === 'long-animation-frame');
    const events = r.observers.find((o) => o.type === 'event');
    frames.queue.push({ startTime: r.now() - 25, duration: 70, scripts: [] });
    frames.queue.push({ startTime: 1, duration: 90, scripts: [] });     // long before the switch: not this switch's
    events.queue.push({ name: 'pointerdown', startTime: r.now() - 29, processingStart: r.now() - 29 + 130, processingEnd: r.now() - 20 + 200, duration: 250 });
    r.advance(1000);
    const [l] = r.lines();
    expect(l.loaf).toBe(1);
    expect(l.loafMs).toBe(70);
    expect(l.ind).toBe(130);
  });
});

describe('switch marks: leaves nothing behind', () => {
  it('after a switch settles, no observer is connected and no timer or frame of the tracker is pending', () => {
    const r = rig();
    r.start();
    r.advance(100);
    r.mos[0].cb([{}]);
    r.advance(2000);
    expect(r.mos.every((m) => m.disconnected)).toBe(true);
    expect(r.observers.filter((o) => o.type === 'layout-shift').every((o) => o.disconnected)).toBe(true);
    // Only the recorder's own one-shots may remain (5 s flush, 10 s startup mark): nothing short-lived, no frame callbacks.
    expect(r.pending().filter((t) => t.ms < 5000)).toHaveLength(0);
  });

  it('the same after a cap, an interrupt and a close', () => {
    const r = rig();
    r.start({ s: 1 });
    for (let i = 0; i < 70; i++) { r.advance(50); r.mos[0]?.cb([{}]); }          // never quiet: cap
    r.start({ id: 's2', q: 2 }); r.advance(3); r.start({ id: 's1', q: 3 });      // interrupt
    r.advance(3); r.fire('yc:switch-none', {});                                   // close
    r.advance(100);
    expect(r.mos.every((m) => m.disconnected)).toBe(true);
    expect(r.pending().filter((t) => t.ms < 5000)).toHaveLength(0);
  });

  it('adds no observer, timer or frame callback until a switch starts', () => {
    const r = rig();
    r.advance(8000);
    expect(r.mos).toHaveLength(0);
    expect(r.pending().filter((t) => t.ms < 5000)).toHaveLength(0);
    expect(r.observers.filter((o) => o.type === 'layout-shift')).toHaveLength(0);
  });
});

describe('switch marks: limits and hostile input', () => {
  it('window side: at most 120 switch lines a minute; the excess is only counted', () => {
    const r = rig();
    for (let i = 0; i < 130; i++) { r.start({ id: i % 2 ? 's1' : 's2', q: i + 1 }); r.advance(100); }
    r.advance(1000);
    r.advance(6000);
    const lines = r.sent.flatMap((s) => s.b.sw ?? []);
    const over = r.sent.reduce((n, s) => n + (s.b.swOver ?? 0), 0);
    expect(lines.length + over).toBe(130);
    expect(lines.length).toBe(120);
    expect(over).toBe(10);
  });

  it('ignores a detail that is not a small JSON object, and never throws', () => {
    const r = rig();
    for (const bad of [undefined, null, 5, {}, 'not json', '[1,2]', 'x'.repeat(5000), '{"id":', 'null', '"s1"']) {
      expect(() => r.raw('yc:switch', bad)).not.toThrow();
      expect(() => r.raw('yc:switch-term', bad)).not.toThrow();
    }
    r.advance(4000);
    expect(r.lines()).toHaveLength(0); // none of them was a switch (a switch needs r = 1)
    expect(r.mos).toHaveLength(0);
  });

  it('only enum strings ever leave the window; an id with quotes or a selector is not used and not sent', () => {
    const r = rig();
    r.start({ id: '"] , body [x="', c: 'DROP TABLE', k: '/etc/passwd', vm: 'a b' });
    r.advance(1000);
    const [l] = r.lines();
    expect(l.cause).toBe('other');
    expect(l.dk).toBe('claude');
    expect(l.vm).toBe('chat');
    expect(JSON.stringify(r.sent)).not.toMatch(/DROP|passwd|body|\[x=/);
    expect(l.e1).toBeNull(); // no pane could be found with a rejected id
  });
});
