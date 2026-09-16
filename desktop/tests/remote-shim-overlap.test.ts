// Review of the 2026-09-11 remote reliability fixes (fresh reviewer, findings 1–4, 6, 11).
// A browser's close() only STARTS closing; the close event arrives later. These tests keep that
// order, which the other fakes in this folder collapse, because every bug here lives in the gap.
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
  close() { if (this.readyState === 3) return; this.readyState = 2; }
  fireClose(code = 1006) { this.readyState = 3; this.onclose?.({ code, reason: '' }); }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  receive(msg: any) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  sentOf(type: string) { return this.sent.map((s) => JSON.parse(s)).filter((m) => m.type === type); }
}

const g = globalThis as any;
let shim: typeof import('../src/renderer/remote-shim');
let store: Record<string, string>;
let doc: EventTarget & { visibilityState: string };
const latest = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
const claude = () => g.claude;
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

async function setup(opts: { protocol?: string; search?: string } = {}) {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  FakeWebSocket.instances = [];
  const target = new EventTarget();
  g.WebSocket = FakeWebSocket;
  g.window = globalThis;
  g.addEventListener = target.addEventListener.bind(target);
  g.removeEventListener = target.removeEventListener.bind(target);
  g.dispatchEvent = target.dispatchEvent.bind(target);
  g.location = { protocol: opts.protocol ?? 'http:', host: 'desk:9900', search: opts.search ?? '' };
  doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  g.document = doc;
  store = {};
  g.localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  };
  await import('../src/renderer/platform');
  shim = await import('../src/renderer/remote-shim');
  shim.installShim();
}

async function signedIn() {
  store['youcoded-remote-token'] = 'dev-1:secret';
  const p = shim.connect('dev-1:secret', true);
  latest().open();
  latest().receive({ type: 'auth:ok', deviceId: 'dev-1', platform: 'desktop' });
  await p;
  return latest();
}

afterEach(() => {
  vi.useRealTimers();
  for (const k of ['WebSocket', 'document', 'addEventListener', 'removeEventListener', 'dispatchEvent']) delete g[k];
});

describe('an Android app paired to a computer that refuses it', () => {
  async function pairThenReconnectRefused(reason: string) {
    await setup({ protocol: 'file:', search: '?bridgeToken=bt&bridgePort=9901' });
    const pairing = shim.connectToHost('desk', 9900, 'pw');
    for (let i = 0; i < 200 && FakeWebSocket.instances.length === 0; i++) await new Promise((r) => setImmediate(r));
    const first = latest();
    expect(first.url).toBe('ws://desk:9900/ws');
    first.open();
    first.receive({ type: 'auth:ok', deviceId: 'dev-1', secret: 's', platform: 'desktop' });
    await pairing;
    first.fireClose(1006);                          // the computer went away
    await vi.advanceTimersByTimeAsync(1000);        // the app comes back with its key
    const retry = latest();
    expect(retry.url).toBe('ws://desk:9900/ws');
    retry.open();
    retry.receive({ type: 'auth:failed', reason });
    await settle();
    return retry;
  }

  it('ends up with ONE connection to its own runtime, even when the refused close arrives late', async () => {
    const refused = await pairThenReconnectRefused('revoked');
    refused.fireClose(4003);                        // the refused socket's close event, after the fallback began
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWebSocket.instances.filter((s) => s.url.startsWith('ws://localhost:'))).toHaveLength(1);
  });

  it('keeps the pairing when the computer only switched remote access off', async () => {
    await pairThenReconnectRefused('no-password-configured');
    expect(store['youcoded-remote-target']).toBe('ws://desk:9900/ws');
    expect(store['youcoded-remote-token']).toBe('dev-1:s');
    expect(FakeWebSocket.instances.filter((s) => s.url.startsWith('ws://localhost:'))).toHaveLength(0);
  });
});

describe('an older connection attempt cannot disturb a newer one', () => {
  it('"Enter password instead", then the old attempt gets through: still connected, still able to send', async () => {
    await setup();
    store['youcoded-remote-token'] = 'dev-1:secret';
    shim.startSavedKeySignIn(() => {});
    const stale = latest();                         // no network yet: stuck connecting
    shim.stopSavedKeySignIn();
    const login = shim.connect('pw', false);
    const fresh = latest();
    fresh.open();
    fresh.receive({ type: 'auth:ok', deviceId: 'dev-2', secret: 's2', platform: 'desktop' });
    await login;
    stale.open();                                   // the old attempt finally opens
    stale.fireClose(4000);                          // and the host's auth timeout closes it
    await vi.advanceTimersByTimeAsync(20_000);      // past its own 15 s connect timeout
    expect(claude().session.canSend()).toBe(true);
    expect(fresh.sentOf('auth')).toHaveLength(1);
  });
});

describe('the wake check does not replace a connection that is working', () => {
  it('anything arriving from the computer after the check counts as an answer', async () => {
    await setup();
    const ws = await signedIn();
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(ws.sentOf('remote:ping')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_000);
    ws.receive({ type: 'status:data', payload: {} }); // a catch-up in progress, arriving ahead of the reply
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('waits 10 s of silence, not 5, before replacing it', async () => {
    await setup();
    await signedIn();
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

describe('requests cut off by a drop', () => {
  it('fail at once, and the reconnect asks the computer whether they ran', async () => {
    await setup();
    const ws = await signedIn();
    let outcome = 'pending';
    claude().skills.list().then(() => { outcome = 'resolved'; }, (e: Error) => { outcome = e.message; });
    const req = ws.sentOf('skills:list')[0];
    ws.fireClose(1006);
    await settle();
    expect(outcome).toBe('Lost the connection before the computer answered.');
    await vi.advanceTimersByTimeAsync(1000);
    const back = latest();
    back.open();
    back.receive({ type: 'auth:ok', deviceId: 'dev-1', platform: 'desktop' });
    await settle();
    expect(back.sentOf('remote:request-outcome')[0]?.payload.ids).toContain(req.id);
  });
});

describe('the network coming back', () => {
  it('before the first sign-in, tries the saved key at once instead of waiting out the retry', async () => {
    await setup();
    store['youcoded-remote-token'] = 'dev-1:secret';
    shim.startSavedKeySignIn(() => {});
    latest().fireClose(1006);                       // no network
    await settle();
    expect(FakeWebSocket.instances).toHaveLength(1);
    g.dispatchEvent(new Event('online'));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('the real online and pageshow events run the check; a normal page load does not', async () => {
    await setup();
    const ws = await signedIn();
    g.dispatchEvent(new Event('online'));
    const first = ws.sentOf('remote:ping');
    expect(first).toHaveLength(1);
    ws.receive({ type: 'remote:ping:response', id: first[0].id, payload: { ok: true } });
    g.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
    expect(ws.sentOf('remote:ping')).toHaveLength(1);
    g.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(ws.sentOf('remote:ping')).toHaveLength(2);
  });
});

describe('a computer that stops accepting this device after it connected', () => {
  it('says so when the reconnect is refused', async () => {
    await setup();
    const refusals: string[] = [];
    shim.onCredentialRefused((r) => refusals.push(r));
    const ws = await signedIn();
    ws.fireClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    latest().open();
    latest().receive({ type: 'auth:failed', reason: 'revoked' });
    await settle();
    expect(refusals).toEqual(['revoked']);
  });

  it('says so when it unpairs the device while connected', async () => {
    await setup();
    const refusals: string[] = [];
    shim.onCredentialRefused((r) => refusals.push(r));
    const ws = await signedIn();
    ws.fireClose(4003);
    expect(refusals).toEqual(['revoked']);
  });
});
