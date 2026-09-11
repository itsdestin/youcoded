// @vitest-environment jsdom
//
// Remote access batch 3, design §10 — the phone's half of Download: the shim
// asks the host for a link, makes it ABSOLUTE (the paired target's origin when
// one is stored, else the page's own), and opens it through an `<a download>`
// click so the browser's own download UI shows progress and the finished file
// (contract R9, R18). A download is saved, never displayed (R20): the anchor
// carries `download`, and the host's headers do the rest.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  frames(): any[] { return this.sent.map((s) => JSON.parse(s)); }
}

let shim: typeof import('../src/renderer/remote-shim');
let clicks: { href: string; download: string }[];

async function loadShim(storedTarget: string | null) {
  vi.resetModules();
  FakeWebSocket.instances = [];
  (globalThis as any).WebSocket = FakeWebSocket;
  const store: Record<string, string> = {};
  if (storedTarget) store['youcoded-remote-target'] = storedTarget;
  (globalThis as any).localStorage = {
    getItem(k: string) { return store[k] ?? null; },
    setItem(k: string, v: string) { store[k] = v; },
    removeItem(k: string) { delete store[k]; },
  };
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { protocol: 'http:', search: '', host: 'desk:9900', origin: 'http://desk:9900', href: 'http://desk:9900/' },
  });
  delete (window as any).claude;
  // jsdom does not navigate on an anchor click; record what would have opened.
  clicks = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicks.push({ href: this.href, download: this.getAttribute('download') ?? '' });
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  shim = await import('../src/renderer/remote-shim');
  shim.installShim();
  const p = shim.connect('dev-1:secret', true);
  const ws = FakeWebSocket.instances[0];
  ws.open();
  ws.receive({ type: 'auth:ok', deviceId: 'dev-1', platform: 'desktop' });
  await p;
  return ws;
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (globalThis as any).WebSocket;
});

describe('window.claude.artifacts.download over remote', () => {
  it('asks the host, absolutizes the link on the page origin, and opens it as a download', async () => {
    const ws = await loadShim(null);
    const pending = (window as any).claude.artifacts.download('/home/me/proj/report.pdf');
    const req = ws.frames().find((f) => f.type === 'artifacts:download');
    expect(req.payload).toEqual({ absolutePath: '/home/me/proj/report.pdf' });
    ws.receive({ type: 'artifacts:download:response', id: req.id, payload: { ok: true, url: '/download/tok123/report.pdf', name: 'report.pdf', sizeBytes: 12 } });
    const res = await pending;
    expect(res).toMatchObject({ ok: true, name: 'report.pdf', sizeBytes: 12, url: 'http://desk:9900/download/tok123/report.pdf' });
    expect(clicks).toEqual([{ href: 'http://desk:9900/download/tok123/report.pdf', download: 'report.pdf' }]);
    // The anchor is not left in the document.
    expect(document.querySelectorAll('a[download]').length).toBe(0);
  });

  it('uses the paired target host when one is stored (the Android pairing path), not the file:// page', async () => {
    const ws = await loadShim('ws://100.64.0.9:9900/ws');
    const pending = (window as any).claude.artifacts.download('/home/me/proj/a.zip', { projectRoot: '/home/me/proj', artifactId: 'art-1' });
    const req = ws.frames().find((f) => f.type === 'artifacts:download');
    expect(req.payload).toEqual({ absolutePath: '/home/me/proj/a.zip', projectRoot: '/home/me/proj', artifactId: 'art-1' });
    ws.receive({ type: 'artifacts:download:response', id: req.id, payload: { ok: true, url: '/download/tok456/a.zip', name: 'a.zip', sizeBytes: 1 } });
    const res = await pending;
    expect(res.url).toBe('http://100.64.0.9:9900/download/tok456/a.zip');
    expect(clicks[0].href).toBe('http://100.64.0.9:9900/download/tok456/a.zip');
  });

  it('a refusal is handed back as data, and nothing is opened', async () => {
    const ws = await loadShim(null);
    const pending = (window as any).claude.artifacts.download('/home/me/proj/x');
    const req = ws.frames().find((f) => f.type === 'artifacts:download');
    ws.receive({ type: 'artifacts:download:response', id: req.id, payload: { ok: false, error: 'busy' } });
    await expect(pending).resolves.toEqual({ ok: false, error: 'busy' });
    expect(clicks).toEqual([]);
  });
});
