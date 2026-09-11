// Remote access batch 2, T2 review finding 1: the device that answers a permission
// must not show "Answered on the computer" on its own answer. For a NATIVE ask the host
// announces the resolution before it replies to the answer, so the resolution reaches
// the answering phone first; the shim knows which answers it has in flight and keeps
// that one resolution from the page. (A Claude Code ask replies first — the relay
// announces on a microtask — and the card is already answered when the resolution
// lands, so the reducer ignores it.) Every other device still gets it.
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

    ws.receive(resolved('mine'));      // arrives BEFORE the reply — a native ask's order
    ws.receive(resolved('theirs'));
    expect(seen).toEqual(['PermissionResolved:theirs']);

    ws.receive({ type: 'permission:respond:response', id: req.id, payload: true });
    await expect(answer).resolves.toBe(true);
    ws.receive(resolved('mine'));      // a later copy (a replay) is no longer ours to hide
    expect(seen).toEqual(['PermissionResolved:theirs', 'PermissionResolved:mine']);
  });
});

describe('a desktop window clears resolutions quietly', () => {
  it('App marks a resolution silent outside remote mode — cleared, never "Answered on the computer"', () => {
    // Ignoring the resolution on the desktop left a card with live buttons whenever a
    // phone's answer broadcast was lost (T2 re-review, 4); showing the note there would
    // name the wrong device. The desktop clears the card and says nothing.
    const app = readStripped(join(__dirname, '..', 'src', 'renderer', 'App.tsx'));
    const gate = /action\?\.type === 'PERMISSION_RESOLVED_ELSEWHERE' && !isRemoteMode\(\)\) action\.silent = true;/;
    assertPatternMatches(gate, "if (action?.type === 'PERMISSION_RESOLVED_ELSEWHERE' && !isRemoteMode()) action.silent = true;", 'the desktop marker');
    expect(app).toMatch(gate);
  });
});
