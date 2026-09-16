// Destin, 2026-09-11, phone test of remote access batches 2/3: "the themes also aren't
// matching again? dev is on meadow mist and remote chose golden daybreak". Reloading the
// phone fixed it: a phone read the computer's theme once, at page load, and never heard a
// change after that — the shim's appearance.onSync/broadcast were no-ops and the host sent
// no appearance:sync to remote clients. These pin both directions.
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
  send(data: string) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('WebSocket is not OPEN');
    this.sent.push(data);
  }
  close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }); }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  receive(msg: any) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  sentOf(type: string) { return this.sent.map((s) => JSON.parse(s)).filter((m) => m.type === type); }
}

describe('remote-shim: appearance changes reach and leave a phone that is already open', () => {
  let shim: typeof import('../src/renderer/remote-shim');
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
  });
  afterEach(() => { delete (globalThis as any).WebSocket; });

  async function connected(): Promise<FakeWebSocket> {
    const p = shim.connect('pw', false);
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: 'auth:ok', deviceId: 'dev-1', secret: 's', platform: 'desktop' });
    await p;
    return ws;
  }

  it('a theme change pushed by the computer reaches onSync', async () => {
    const ws = await connected();
    const got: any[] = [];
    const off = (window as any).claude.appearance.onSync((prefs: any) => got.push(prefs));
    ws.receive({ type: 'appearance:sync', payload: { theme: 'meadow-mist' } });
    expect(got).toEqual([{ theme: 'meadow-mist' }]);

    off();
    ws.receive({ type: 'appearance:sync', payload: { theme: 'midnight' } });
    expect(got).toHaveLength(1);
  });

  it('a theme change made on the phone is sent to the computer to pass on', async () => {
    const ws = await connected();
    (window as any).claude.appearance.broadcast({ theme: 'golden-sunbreak' });
    expect(ws.sentOf('appearance:broadcast').map((m) => m.payload)).toEqual([{ theme: 'golden-sunbreak' }]);
  });
});
