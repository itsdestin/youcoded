// Remote access batch 2, design §1 C and §7 (T2): the shim keeps terminal
// frames that arrive before the terminal is mounted, in order and bounded, and
// reports how much of each session's terminal it has drawn so a reconnect sends
// only what is missing.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWebSocket.instances.push(this); }
  send(data: string) { if (this.readyState !== FakeWebSocket.OPEN) throw new Error('not open'); this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }); }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  receive(msg: any) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  sentOf(type: string) { return this.sent.map((s) => JSON.parse(s)).filter((m) => m.type === type); }
}

describe('remote-shim terminal backlog and offsets', () => {
  let shim: typeof import('../src/renderer/remote-shim');
  let ws: FakeWebSocket;
  beforeEach(async () => {
    vi.resetModules();
    FakeWebSocket.instances = [];
    (globalThis as any).WebSocket = FakeWebSocket;
    (globalThis as any).window = globalThis;
    (globalThis as any).location = { protocol: 'http:', host: 'localhost', search: '' };
    (globalThis as any).localStorage = {
      _s: {} as Record<string, string>,
      getItem(k: string) { return this._s[k] ?? null; },
      setItem(k: string, v: string) { this._s[k] = v; },
      removeItem(k: string) { delete this._s[k]; },
    };
    shim = await import('../src/renderer/remote-shim');
    shim.installShim();
    const p = shim.connect('pw', false);
    ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: 'auth:ok', deviceId: 'dev-1', secret: 's', platform: 'desktop' });
    await p;
  });
  afterEach(() => { vi.useRealTimers(); delete (globalThis as any).WebSocket; });

  const output = (sessionId: string, data: string, offset: number, epoch = 'e1') =>
    ws.receive({ type: 'pty:output', payload: { sessionId, data, epoch, offset } });

  it('delivers pty:output and pty:reset that arrived before any listener, in order, on the first listener', () => {
    output('s1', 'old ', 0);
    ws.receive({ type: 'pty:reset', payload: { sessionId: 's1', epoch: 'e2' } });
    output('s1', 'fresh', 0, 'e2');

    const seen: string[] = [];
    (window as any).claude.on.ptyResetForSession('s1', () => seen.push('<RESET>'));
    expect(seen).toEqual([]);                                   // the reset listener alone does not drain
    (window as any).claude.on.ptyOutputForSession('s1', (d: string) => seen.push(d));
    expect(seen).toEqual(['old ', '<RESET>', 'fresh']);

    output('s1', ' live', 5, 'e2');                             // after the drain, frames go straight through
    expect(seen).toEqual(['old ', '<RESET>', 'fresh', ' live']);
  });

  it('keeps the backlog per session', () => {
    output('s1', 'one', 0);
    output('s2', 'two', 0);
    const s2: string[] = [];
    (window as any).claude.on.ptyOutputForSession('s2', (d: string) => s2.push(d));
    expect(s2).toEqual(['two']);
    const s1: string[] = [];
    (window as any).claude.on.ptyOutputForSession('s1', (d: string) => s1.push(d));
    expect(s1).toEqual(['one']);
  });

  it('caps the backlog at 256 KB of units by trimming the OLDEST output, keeping its tail and everything after', () => {
    // A restore's replay is one frame of up to 4M units. Dropping whole entries threw the
    // entire replay away the moment one more frame arrived — while the saved offset still
    // counted it as drawn, so no reconnect ever brought the history back (T2 review, 5).
    const replay = 'old-line\n'.repeat(40 * 1024);              // 360 KB, line-shaped
    output('s1', replay, 0);
    output('s1', 'live', replay.length);
    const seen: string[] = [];
    (window as any).claude.on.ptyOutputForSession('s1', (d: string) => seen.push(d));
    const total = seen.reduce((n, d) => n + d.length, 0);
    expect(total).toBeLessThanOrEqual(256 * 1024);
    expect(seen[seen.length - 1]).toBe('live');
    expect(seen[0].startsWith('old-line\n')).toBe(true);        // cut at a line break, not mid-line
    expect(replay.endsWith(seen[0])).toBe(true);                   // the TAIL of the replay survived
  });

  it('reports the epoch and the units it has drawn per session in client:ready, and 0 after a reset', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    (window as any).claude.on.chatHydrate(() => {});
    output('s1', 'abc', 0);
    output('s1', 'de', 3);
    output('s2', 'zzzz', 0, 'e9');
    ws.receive({ type: 'pty:reset', payload: { sessionId: 's2', epoch: 'e10' } });
    ws.receive({ type: 'session:destroyed', payload: { sessionId: 's3', exitCode: 0 } });

    ws.close();
    vi.advanceTimersByTime(1000);
    const ws2 = FakeWebSocket.instances[1];
    ws2.open();
    ws2.receive({ type: 'auth:ok', deviceId: 'dev-1', platform: 'desktop' });
    await Promise.resolve();
    const readyMsg = ws2.sentOf('client:ready')[0];
    expect(readyMsg.payload.ptyOffsets).toEqual({ s1: { epoch: 'e1', units: 5 }, s2: { epoch: 'e10', units: 0 } });
  });

  it('forgets a destroyed session\'s offsets and backlog', () => {
    output('s1', 'abc', 0);
    ws.receive({ type: 'session:destroyed', payload: { sessionId: 's1', exitCode: 0 } });
    const seen: string[] = [];
    (window as any).claude.on.ptyOutputForSession('s1', (d: string) => seen.push(d));
    expect(seen).toEqual([]);
  });

  it('an old host that sends no epoch leaves the offsets unreported rather than wrong', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    ws.receive({ type: 'pty:output', payload: { sessionId: 's1', data: 'abc' } });
    const seen: string[] = [];
    (window as any).claude.on.ptyOutputForSession('s1', (d: string) => seen.push(d));
    expect(seen).toEqual(['abc']);
    (window as any).claude.on.chatHydrate(() => {});
    ws.close();
    vi.advanceTimersByTime(1000);
    const ws2 = FakeWebSocket.instances[1];
    ws2.open();
    ws2.receive({ type: 'auth:ok', deviceId: 'dev-1', platform: 'desktop' });
    await Promise.resolve();
    expect(ws2.sentOf('client:ready')[0].payload.ptyOffsets).toEqual({});
  });

  it('the line-break search is bounded: a replay with no nearby line break keeps its full tail', () => {
    // An Ink redraw can run hundreds of KB without a newline; an unbounded search kept
    // only what followed a far-off break — a handful of units of a 4M replay (T2 re-review, 10).
    const replay = 'x'.repeat(300 * 1024) + '\n' + 'y'.repeat(10);
    output('s1', replay, 0);
    const seen: string[] = [];
    (window as any).claude.on.ptyOutputForSession('s1', (d: string) => seen.push(d));
    const total = seen.reduce((n, d) => n + d.length, 0);
    expect(total).toBeGreaterThan(250 * 1024);
    expect(total).toBeLessThanOrEqual(256 * 1024);
  });

  it('a live frame from a NEW buffer (another epoch) resets the terminal before drawing', () => {
    // A host restart or a recreated session: no restore pass saw it, so the first frame of
    // the new stream is the only signal. Appending it to the old screen was the bug (T2 review, 12).
    const seen: string[] = [];
    (window as any).claude.on.ptyResetForSession('s1', () => seen.push('<RESET>'));
    (window as any).claude.on.ptyOutputForSession('s1', (d: string) => seen.push(d));
    output('s1', 'old', 0, 'e1');
    output('s1', 'new', 0, 'e2');
    output('s1', '!', 3, 'e2');
    expect(seen).toEqual(['old', '<RESET>', 'new', '!']);
  });

  it('pairing to a different host forgets every terminal position', async () => {
    output('s1', 'abc', 0);
    (window as any).claude.on.chatHydrate(() => {});
    (globalThis as any).location.host = 'other-desktop:9900';
    const p2 = shim.connect('pw', false);
    const ws2 = FakeWebSocket.instances[1];
    ws2.open();
    ws2.receive({ type: 'auth:ok', deviceId: 'dev-1', secret: 's', platform: 'desktop' });
    await p2;
    expect(ws2.sentOf('client:ready')[0].payload.ptyOffsets).toEqual({});
  });
});
