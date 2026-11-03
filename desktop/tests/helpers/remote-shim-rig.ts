// Shared fakes for the remote-shim test files: the globals they all install, and a fake WebSocket.
import { beforeAll, afterAll, vi } from 'vitest';

// WHY each describe calls isolateGlobals(): the sections install fakes on globalThis (WebSocket, window, location,
// localStorage, document…) and not all of them remove every one; putting the globals back after each section, and
// dropping the loaded shim, keeps one section's fakes from leaking into the next.
const ISOLATED_GLOBALS = ['WebSocket', 'window', 'location', 'localStorage', 'document', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'claude'];
export function isolateGlobals() {
  let saved: [string, PropertyDescriptor | undefined][] = [];
  beforeAll(() => { saved = ISOLATED_GLOBALS.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]); });
  afterAll(() => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete (globalThis as Record<string, unknown>)[k];
    }
    vi.resetModules();
  });
}

export interface FakeSocketOptions {
  /** send() throws unless the socket is open, like a real WebSocket. */
  strictSend?: boolean;
  /** close(): 'fire' tells onclose at once; 'fire-once' does so only the first time; 'closing' only starts
   *  closing (the test calls fireClose); 'silent' marks it closed without telling anyone. */
  close?: 'fire' | 'fire-once' | 'closing' | 'silent';
}

export function makeFakeWebSocket({ strictSend = true, close = 'fire' }: FakeSocketOptions = {}) {
  return class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = FakeWebSocket.CONNECTING;
    sent: string[] = [];
    protocol = '';
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: ((e: { code: number; reason: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string, public protocols?: string[]) { FakeWebSocket.instances.push(this); }
    send(data: string) {
      if (strictSend && this.readyState !== FakeWebSocket.OPEN) throw new Error('WebSocket is not OPEN');
      this.sent.push(data);
    }
    close(code = 1000, reason = '') {
      if (close === 'fire-once' && this.readyState === 3) return;
      if (close === 'closing') { if (this.readyState !== 3) this.readyState = 2; return; }
      this.readyState = 3;
      if (close !== 'silent') this.onclose?.({ code, reason });
    }
    fireClose(code = 1006) { this.readyState = 3; this.onclose?.({ code, reason: '' }); }
    open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
    receive(msg: any) { this.onmessage?.({ data: JSON.stringify(msg) }); }
    frames(): any[] { return this.sent.map((s) => JSON.parse(s)); }
    types(): string[] { return this.frames().map((m) => m.type); }
    sentOf(type: string) { return this.frames().filter((m) => m.type === type); }
  };
}

export type FakeSocket = InstanceType<ReturnType<typeof makeFakeWebSocket>>;
