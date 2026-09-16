// @vitest-environment jsdom
//
// Voice typing is the one part of the shared `window.claude` shape that the
// remote-browser client deliberately does NOT get (contract row R7). This file
// pins the two halves of that decision, because both are easy to weaken by
// accident and neither shows up in a type check:
//
//  1. The NAMESPACE is only installed for the Android app talking to its own
//     on-device bridge — `file:` page AND no remote target. `!targetUrl` alone
//     is also true of a plain browser tab, which is exactly where the mic must
//     not appear (questions deck Q-7: a browser only grants the microphone on
//     the desktop has no voice over that bridge; disconnecting brings it back).
//  2. Every method REFUSES at call time once a target is set, because pairing
//     to a desktop mid-session flips a variable without rebuilding
//     `window.claude` — a phone that paired mid-session would otherwise keep a
//     live microphone pointed at a host with no voice handlers.
//
// Built on remote-shim-unsupported.test.ts's harness (a fake WebSocket plus a
// stubbed localStorage), which is the only way to install the real shim in a
// test without an Electron main process.
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
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  receive(msg: any) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

/** Point jsdom's `location.protocol` at a scheme. The shim reads it directly,
 *  and jsdom's own location is read-only, so replace the whole object — the
 *  shim only ever reads `protocol` and `search` off it. */
function setProtocol(protocol: 'file:' | 'http:') {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { protocol, search: '', host: 'localhost:5173', href: `${protocol}//localhost/` },
  });
}

/** connectToHost() awaits a dynamic import before it opens its socket, so the
 *  fake instance does not exist on the next line. Wait for it. */
async function waitForSocket(count: number): Promise<FakeWebSocket> {
  // Bounded by TIME, not by a count of event-loop turns. Fifty turns is however
  // long fifty turns happen to take, and with the whole suite running in
  // parallel that was measured at less than one dynamic import (this file failed
  // inside a full run on 2026-09-05 and passed on its own straight after).
  // Rule: .claude/rules/test-suite-hygiene.md → "Never let a fixed sleep stand
  // in for a signal" — there is no event to wait on here, so a generous deadline
  // is the honest second best.
  const deadline = Date.now() + 10_000;
  while (FakeWebSocket.instances.length < count && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1));
  }
  if (FakeWebSocket.instances.length < count) throw new Error('no socket was opened');
  return FakeWebSocket.instances[count - 1];
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

describe('remote-shim voice gate', () => {
  const realLocation = Object.getOwnPropertyDescriptor(window, 'location')!;

  beforeEach(() => { delete (window as any).claude; });
  afterEach(() => {
    Object.defineProperty(window, 'location', realLocation);
    delete (globalThis as any).WebSocket;
    delete (window as any).claude;
  });

  it('installs the voice namespace on the Android app (file:// with no remote target)', async () => {
    setProtocol('file:');
    const shim = await loadShim();
    shim.installShim();
    expect((window as any).claude.voice).toBeDefined();
    // The whole shared shape, so a missing member can't pass as "present".
    for (const m of ['status', 'download', 'start', 'stop', 'cancel', 'onEvent']) {
      expect(typeof (window as any).claude.voice[m], `voice.${m}`).toBe('function');
    }
  });

  it('installs NO voice namespace in a plain browser tab (http:// with no remote target)', async () => {
    setProtocol('http:');
    const shim = await loadShim();
    shim.installShim();
    // The mic button is drawn from `supported`, which is `!!window.claude.voice`.
    expect((window as any).claude.voice).toBeUndefined();
    // Sanity: the shim really did install, so `undefined` above means "gated
    // out" rather than "installShim never ran".
    expect((window as any).claude.session).toBeDefined();
  });

  it('the phone-only members stay off the shim (Android owns the microphone)', async () => {
    setProtocol('file:');
    const shim = await loadShim();
    shim.installShim();
    // Absent ON PURPOSE — the exception recorded in .claude/rules/ipc-bridge.md.
    // The composer tests for them before opening a microphone itself.
    expect((window as any).claude.voice.sendAudio).toBeUndefined();
    expect((window as any).claude.voice.micAccess).toBeUndefined();
  });

  // The mid-session pairing case. `connectToHost` sets the remote target and
  // flips the connection mode; it never rebuilds `window.claude`, so the bridge
  // the composer captured at mount is still the Android one.
  describe('after pairing to a remote desktop mid-session', () => {
    let shim: typeof import('../src/renderer/remote-shim');
    let voice: any;

    beforeEach(async () => {
      setProtocol('file:');
      shim = await loadShim();
      shim.installShim();
      voice = (window as any).claude.voice;
      const pairing = shim.connectToHost('desk.local', 9900, 'pw');
      const ws = await waitForSocket(1);
      ws.open();
      ws.receive({ type: 'auth:ok', token: 'tok', platform: 'desktop' });
      await pairing;
      // The namespace object is the same one — that IS the hazard being tested.
      expect((window as any).claude.voice).toBe(voice);
    });

    it('status() answers unavailable with the reason, instead of asking the desktop', async () => {
      const before = FakeWebSocket.instances[FakeWebSocket.instances.length - 1].sent.length;
      const readiness = await voice.status();
      expect(readiness.state).toBe('unavailable');
      // The sentence must address the reader who can actually see it — a PHONE paired
      // to a desktop, not a browser — and tell them what to do about it.
      expect(readiness.reason).toMatch(/connected to another computer/);
      expect(readiness.reason).toMatch(/Disconnect/);
      expect(readiness.reason).not.toMatch(/encrypted/);
      // Nothing went over the wire: the refusal is local, so a desktop with no
      // voice:* handlers is never asked a question it cannot answer.
      expect(FakeWebSocket.instances[FakeWebSocket.instances.length - 1].sent.length).toBe(before);
    });

    it('start() refuses rather than opening a microphone', async () => {
      const before = FakeWebSocket.instances[FakeWebSocket.instances.length - 1].sent.length;
      await expect(voice.start()).rejects.toThrow(/connected to another computer/);
      expect(FakeWebSocket.instances[FakeWebSocket.instances.length - 1].sent.length).toBe(before);
    });

    it('download(), stop() and cancel() refuse too', async () => {
      await expect(voice.download()).rejects.toThrow(/connected to another computer/);
      await expect(voice.stop()).rejects.toThrow(/connected to another computer/);
      await expect(voice.cancel()).rejects.toThrow(/connected to another computer/);
    });

    it('onEvent() subscribes to nothing and still returns a usable unsubscribe', async () => {
      const seen: unknown[] = [];
      const off = voice.onEvent((e: unknown) => seen.push(e));
      const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      ws.receive({ type: 'voice:event', payload: { type: 'final', text: 'hello' } });
      expect(seen).toEqual([]);
      expect(() => off()).not.toThrow();
    });
  });

  // The other direction: on the phone, with no remote target, the calls really
  // do go to the on-device bridge. Without this the refusal tests above could
  // pass with a namespace that refuses ALWAYS.
  it('on the phone the calls actually reach the local bridge', async () => {
    setProtocol('file:');
    const shim = await loadShim();
    const connecting = shim.connect('android-local', false);
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: 'auth:ok', token: 'tok', platform: 'android' });
    await connecting;
    shim.installShim();
    const voice = (window as any).claude.voice;

    const p = voice.status();
    const msg = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(msg.type).toBe('voice:status');
    ws.receive({ type: 'voice:status:response', id: msg.id, payload: { state: 'ready', engine: 'android' } });
    expect(await p).toEqual({ state: 'ready', engine: 'android' });

    // ...and the host's push events reach an onEvent subscriber.
    const seen: any[] = [];
    voice.onEvent((e: any) => seen.push(e));
    ws.receive({ type: 'voice:event', payload: { type: 'partial', committed: 'Hello.', tail: 'there' } });
    expect(seen).toEqual([{ type: 'partial', committed: 'Hello.', tail: 'there' }]);
  });
});
