// Remote access batch 2, T2 review finding 1: the device that answers a permission
// must not show "Answered on the computer" on its own answer. The host announces the
// resolution before it replies to the answer, so the resolution always reaches the
// answering phone first; the shim knows which answers it has in flight and keeps that
// one resolution from the page. Every other device still gets it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { readStripped, assertPatternMatches } from './helpers/guard-scope';

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

describe('a permission answered from this phone', () => {
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
  afterEach(() => { delete (globalThis as any).WebSocket; });

  const resolved = (requestId: string) => ({ type: 'hook:event', payload: { type: 'PermissionResolved', sessionId: 's1', payload: { _requestId: requestId }, timestamp: 1 } });

  it('keeps the resolution of its own in-flight answer from the page, and only that one', async () => {
    const seen: string[] = [];
    (window as any).claude.on.hookEvent((e: any) => seen.push(`${e.type}:${e.payload._requestId}`));
    const answer = (window as any).claude.session.respondToPermission('mine', { decision: { behavior: 'allow' } });
    const req = ws.sentOf('permission:respond')[0];

    ws.receive(resolved('mine'));      // arrives BEFORE the reply — the host's real order
    ws.receive(resolved('theirs'));
    expect(seen).toEqual(['PermissionResolved:theirs']);

    ws.receive({ type: 'permission:respond:response', id: req.id, payload: true });
    await expect(answer).resolves.toBe(true);
    ws.receive(resolved('mine'));      // a later copy (a replay) is no longer ours to hide
    expect(seen).toEqual(['PermissionResolved:theirs', 'PermissionResolved:mine']);
  });
});

describe('the desktop window ignores resolutions', () => {
  it('App dispatches PermissionResolved only in remote mode', () => {
    // A desktop window learns of a phone's answer from the phone's broadcast
    // PERMISSION_RESPONDED; acting on the host's resolution as well would name the
    // wrong device ("Answered on the computer") on the computer itself.
    const app = readStripped(join(__dirname, '..', 'src', 'renderer', 'App.tsx'));
    const gate = /event\.type === 'PermissionResolved' && !isRemoteMode\(\)\) return;/;
    assertPatternMatches(gate, "if (event.type === 'PermissionResolved' && !isRemoteMode()) return;", 'the remote-only gate');
    expect(app).toMatch(gate);
  });
});
