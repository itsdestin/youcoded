// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { REMOTE_HOST_CHANGED_EVENT, REMOTE_NOT_SENT, REMOTE_UNSUPPORTED_EVENT } from '../src/renderer/remote-unsupported';
import { loadRealPreload } from './helpers/real-preload';

/**
 * Specialists plans, Task 6 — the plan bridge over the shared shim.
 *
 * The one rule that differs from every other desktop-only channel: a plan
 * call's `{ok:false, unsupported:true}` is DATA, and must RESOLVE. The card and
 * Settings read it as "this device can't run plans" — controls disabled from
 * the first paint, Settings → Plans hidden. A rejection would read as an
 * ordinary failure instead: the controls stay clickable and the refusal only
 * appears after a tap (components/plans/plan-bridge.ts).
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

function setProtocol(protocol: 'file:' | 'http:') {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { protocol, search: '', host: 'localhost:5173', href: `${protocol}//localhost/` },
  });
}

async function connect(host: 'phone' | 'desktop') {
  setProtocol(host === 'phone' ? 'file:' : 'http:');
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
  const shim = await import('../src/renderer/remote-shim');
  const connecting = shim.connect(host === 'phone' ? 'android-local' : 'pw', false);
  const ws = FakeWebSocket.instances[0];
  ws.open();
  ws.receive({ type: 'auth:ok', token: 'tok', platform: host === 'phone' ? 'android' : 'desktop' });
  await connecting;
  shim.installShim();
  return { ws, shim };
}

const last = (ws: FakeWebSocket) => JSON.parse(ws.sent[ws.sent.length - 1]);

/** Each renderer method, the channel and payload it must send. */
const CALLS: Array<[string, (p: any) => Promise<unknown>, string, unknown]> = [
  ['approve', (p) => p.approve('s1', 'p1'), 'plans:approve', { sessionId: 's1', planId: 'p1' }],
  ['comment', (p) => p.comment('s1', 'p1', 'hi'), 'plans:comment', { sessionId: 's1', planId: 'p1', text: 'hi' }],
  ['addBudget', (p) => p.addBudget('s1', 'p1', 900, 'press-9'), 'plans:add-budget', { sessionId: 's1', planId: 'p1', tokens: 900, requestId: 'press-9' }],
  ['resume', (p) => p.resume('s1', 'p1'), 'plans:resume', { sessionId: 's1', planId: 'p1' }],
  ['stop', (p) => p.stop('s1', 'p1'), 'plans:stop', { sessionId: 's1', planId: 'p1' }],
  ['askAssistant', (p) => p.askAssistant('s1', 'p1', 'why?'), 'plans:ask-assistant', { sessionId: 's1', planId: 'p1', question: 'why?' }],
  ['getAutoApprove', (p) => p.getAutoApprove(), 'plans:get-auto-approve', {}],
  ['setAutoApprove', (p) => p.setAutoApprove(3000), 'plans:set-auto-approve', { underTokens: 3000 }],
];

describe('window.claude.plans over the shared shim', () => {
  const realLocation = Object.getOwnPropertyDescriptor(window, 'location')!;
  const notices: any[] = [];
  const listener = (e: Event) => notices.push((e as CustomEvent).detail);
  beforeEach(() => {
    notices.length = 0;
    window.addEventListener(REMOTE_UNSUPPORTED_EVENT, listener);
  });
  afterEach(() => {
    vi.useRealTimers();
    window.removeEventListener(REMOTE_UNSUPPORTED_EVENT, listener);
    Object.defineProperty(window, 'location', realLocation);
    delete (globalThis as any).WebSocket;
    delete (window as any).claude;
  });

  // Final review F29: the shim and the REAL preload send the same payload for
  // every call, so the desktop and phone paths reach the handler identically.
  it('sends exactly what the real preload sends, for all eight', async () => {
    const { ws } = await connect('desktop');
    const plans = (window as any).claude.plans;
    for (const [name, call, type] of CALLS) {
      const real = loadRealPreload();
      void call(real.claude.plans);
      void call(plans);
      const msg = last(ws);
      expect(real.invokes, name).toEqual([[type, msg.payload]]);
    }
  });

  it('sends each of the eight with its object payload and resolves the host’s answer', async () => {
    const { ws } = await connect('desktop');
    const plans = (window as any).claude.plans;
    for (const [name, call, type, payload] of CALLS) {
      const p = call(plans);
      const msg = last(ws);
      expect(msg.type, name).toBe(type);
      expect(msg.payload, name).toEqual(payload);
      const answer = { ok: false, error: 'Budget can only be added to a paused plan.' };
      ws.receive({ type: `${type}:response`, id: msg.id, payload: answer });
      // A refusal is data for these channels, not a thrown error.
      await expect(p, name).resolves.toEqual(answer);
    }
  });

  it('the phone’s unsupported answer RESOLVES for all eight, quietly', async () => {
    const { ws } = await connect('phone');
    // After the boot quiet window, so a notice WOULD show if one were raised.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 10_000);
    const plans = (window as any).claude.plans;
    for (const [name, call, type] of CALLS) {
      const p = call(plans);
      const msg = last(ws);
      const answer = { ok: false, unsupported: true, error: "Plans aren't available on the phone yet." };
      ws.receive({ type: `${type}:response`, id: msg.id, payload: answer });
      await expect(p, name).resolves.toEqual(answer);
    }
    // The card says it itself; a toast on top would say it twice.
    expect(notices).toEqual([]);
  });

  it('keeps plan channels out of REJECT_ON_NOT_OK', async () => {
    const { shim } = await connect('desktop');
    expect([...shim.REJECT_ON_NOT_OK].filter((c) => c.startsWith('plans:'))).toEqual([]);
    for (const [, , type] of CALLS) {
      expect(shim.responseOutcome(type, { ok: false, unsupported: true, error: 'x' })).toBe('value');
      expect(shim.responseOutcome(type, { ok: false, error: 'x' })).toBe('value');
    }
    // Every other channel keeps today's rule.
    expect(shim.responseOutcome('models:settings', { ok: false, unsupported: true })).toBe('unsupported');
  });

  // Final review F5: a plan button pressed while the connection is down is
  // refused at once and never sent later.
  it('a plan action while disconnected is refused at once and never flushed after reconnecting', async () => {
    const { ws, shim } = await connect('desktop');
    const plans = (window as any).claude.plans;
    ws.readyState = 3;
    ws.onclose?.({ code: 1006, reason: 'network' });
    const sentBefore = ws.sent.length;
    for (const [name, call, type] of CALLS) {
      if (type === 'plans:get-auto-approve') continue;
      await expect(call(plans), name).rejects.toThrow(REMOTE_NOT_SENT);
      expect(shim.MESSAGE_KIND[type], name).toBe('user-action');
    }
    // Reading the setting is safe to send again, so it waits for the connection.
    expect(shim.MESSAGE_KIND['plans:get-auto-approve']).toBe('read');
    expect(ws.sent.length).toBe(sentBefore);
    // Whatever socket comes next never receives the refused presses.
    const next = FakeWebSocket.instances.slice(1);
    for (const w of next) expect(w.sent.map((m) => JSON.parse(m).type).filter((t: string) => t.startsWith('plans:') && t !== 'plans:get-auto-approve')).toEqual([]);
  });

  // Final review F9: switching hosts without a reload tells the page.
  it('disconnecting from a remote host announces the host change', async () => {
    const { shim } = await connect('phone');
    const seen: Event[] = [];
    const onChanged = (e: Event) => seen.push(e);
    window.addEventListener(REMOTE_HOST_CHANGED_EVENT, onChanged);
    try {
      const switching = shim.disconnectFromHost();
      await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(2));
      const local = FakeWebSocket.instances[1];
      local.open();
      local.receive({ type: 'auth:ok', token: 'tok', platform: 'android' });
      await switching;
      expect(seen).toHaveLength(1);
    } finally {
      window.removeEventListener(REMOTE_HOST_CHANGED_EVENT, onChanged);
    }
  });

  it('on.planEvent delivers plans:event pushes and unsubscribes', async () => {
    const { ws } = await connect('desktop');
    const seen: any[] = [];
    const off = (window as any).claude.on.planEvent((e: any) => seen.push(e));
    const event = { sessionId: 's1', plan: { planId: 'p1', toolUseId: 't1', seq: 2, status: 'running', steps: [] } };
    ws.receive({ type: 'plans:event', payload: event });
    expect(seen).toEqual([event]);
    expect(typeof off).toBe('function');
    off();
    ws.receive({ type: 'plans:event', payload: event });
    expect(seen).toHaveLength(1);
  });
});
