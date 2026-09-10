// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { REMOTE_UNSUPPORTED_EVENT } from '../src/renderer/remote-unsupported';

/**
 * The phone's OWN bridge as a refusing host (2026-09-10).
 *
 * Two behaviours, both born from the same bug: SessionService.kt's catch-all
 * used to answer an unknown channel with a bare `{error}` object, which the shim
 * RESOLVES as an ordinary value — Project View crashed on a sync "status" with
 * no `spaces`, and the chat reducer threw on every launch when the first
 * transcript page came back as junk.
 *
 *  1. A refusal from the phone reads "on the phone", never "via remote access".
 *  2. The two channels asked for AUTOMATICALLY (transcript:page on launch,
 *     syncspaces:status on opening Settings / Project View) are refused by the
 *     shim itself, quietly: they reject like any unsupported channel, but no
 *     notice fires and nothing is sent to the bridge.
 */

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
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  receive(msg: any) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

/** `file:` + no remote target is how the shim recognises the phone's own bridge. */
function setProtocol(protocol: 'file:' | 'http:') {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { protocol, search: '', host: 'localhost:5173', href: `${protocol}//localhost/` },
  });
}

async function loadShim() {
  vi.resetModules();
  FakeWebSocket.instances = [];
  (globalThis as any).WebSocket = FakeWebSocket;
  (globalThis as any).localStorage = {
    _s: {} as Record<string, string>,
    getItem(k: string) { return this._s[k] ?? null; },
    setItem(k: string, v: string) { this._s[k] = v; },
    removeItem(k: string) { delete this._s[k]; },
  };
  delete (window as any).claude;
  return import('../src/renderer/remote-shim');
}

async function connectPhone() {
  setProtocol('file:');
  const shim = await loadShim();
  const connecting = shim.connect('android-local', false);
  const ws = FakeWebSocket.instances[0];
  ws.open();
  ws.receive({ type: 'auth:ok', token: 'tok', platform: 'android' });
  await connecting;
  shim.installShim();
  return ws;
}

const settle = (p: Promise<unknown>) => p.then(
  (result) => ({ result, error: null as Error | null }),
  (error: Error) => ({ result: undefined, error }),
);

describe('remote-shim on the phone\'s own bridge', () => {
  const realLocation = Object.getOwnPropertyDescriptor(window, 'location')!;
  const notices: any[] = [];
  const listener = (e: Event) => notices.push((e as CustomEvent).detail);

  beforeEach(() => {
    notices.length = 0;
    delete (window as any).claude;
    window.addEventListener(REMOTE_UNSUPPORTED_EVENT, listener);
  });
  afterEach(() => {
    vi.useRealTimers();
    window.removeEventListener(REMOTE_UNSUPPORTED_EVENT, listener);
    Object.defineProperty(window, 'location', realLocation);
    delete (globalThis as any).WebSocket;
    delete (window as any).claude;
  });

  it('a refusal from the phone says "on the phone", not "via remote access"', async () => {
    const ws = await connectPhone();
    // WHY the clock moves: nothing is announced for the first seconds after a connection,
    // because the app's own boot fetches are not something the person did
    // (remote-shim-unsupported.test.ts covers that window). This test is about a tap the
    // user made AFTER the app settled, so it has to happen after the window closes.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 10_000);
    const p = (window as any).claude.syncSpaces.enable(true);
    const msg = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(msg.type).toBe('syncspaces:enable');
    // Exactly what SessionService.kt's catch-all now answers.
    ws.receive({
      type: 'syncspaces:enable:response',
      id: msg.id,
      payload: { ok: false, unsupported: true, error: 'not-implemented-on-mobile (no handler for syncspaces:enable)' },
    });
    const { error } = await settle(p);
    expect(error?.message).toBe('remote-unsupported: syncspaces:enable');
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toBe("Syncing across your devices isn't available on the phone yet.");
  });

  it('refuses transcript:page and syncspaces:status quietly, without touching the bridge', async () => {
    const ws = await connectPhone();
    const sentBefore = ws.sent.length;
    const page = await settle((window as any).claude.detach.requestTranscriptPage({ sessionId: 's1' }));
    const status = await settle((window as any).claude.syncSpaces.status());
    expect(page.error?.message).toBe('remote-unsupported: transcript:page');
    expect(status.error?.message).toBe('remote-unsupported: syncspaces:status');
    expect(ws.sent.length).toBe(sentBefore);
    expect(notices).toHaveLength(0);
  });

  it('still sends both to a desktop over remote access', async () => {
    setProtocol('http:');
    const shim = await loadShim();
    const connecting = shim.connect('pw', false);
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: 'auth:ok', token: 'tok', platform: 'desktop' });
    await connecting;
    shim.installShim();
    void (window as any).claude.syncSpaces.status().catch(() => {});
    void (window as any).claude.detach.requestTranscriptPage({ sessionId: 's1' }).catch(() => {});
    const types = ws.sent.map((s) => JSON.parse(s).type);
    expect(types).toContain('syncspaces:status');
    expect(types).toContain('transcript:page');
  });
});
