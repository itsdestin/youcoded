// @vitest-environment jsdom
// The remote shim (src/renderer/remote-shim.ts) — files over remote: downloads open through an
// <a download> link, and the file lists and watchers come back after a reconnect.
// WHY a separate file: these cases need jsdom (anchors, React hooks); remote-shim.test.ts runs in node.
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { REMOTE_RECONNECTED_EVENT } from '../src/renderer/remote-events';
import { useProjectWatch } from '../src/renderer/hooks/useProjectWatch';

// WHY each section starts with isolateGlobals(): every section below was its own file, so each
// began with a clean global object and a fresh module graph. The sections install fakes on
// globalThis (WebSocket, window, location, localStorage, document…) and not all of them remove
// every one; putting the globals back after each section, and dropping the loaded shim, keeps
// one section's fakes from leaking into the next.
const ISOLATED_GLOBALS = ['WebSocket', 'window', 'location', 'localStorage', 'document', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'claude'];
function isolateGlobals() {
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

// Remote access batch 3, design §10 — the phone's half of Download: the shim
// asks the host for a link, makes it ABSOLUTE (the paired target's origin when
// one is stored, else the page's own), and opens it through an `<a download>`
// click so the browser's own download UI shows progress and the finished file
// (contract R9, R18). A download is saved, never displayed (R20): the anchor
// carries `download`, and the host's headers do the rest.
describe('remote-shim — downloads', () => {
  isolateGlobals();

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
});

// Remote access batch 3, design test 8 (the phone's half) — after a reconnect a watcher
// event still reaches the phone, the page is told, and the Files screen's watcher hook
// re-subscribes and reloads its own list (technical design 2026-09-10 §8 "Live refresh";
// contract row R12).
//
// WHY the shim itself re-asks nothing: it used to re-send the file lists (and skills,
// / commands, the remote settings) on every reconnect, but those answers settled no caller
// and reached no screen, while the screens' own reconnect listeners asked again anyway.
describe('remote-shim — files after a reconnect', () => {
  isolateGlobals();

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
    url: string;
    constructor(url: string) { this.url = url; FakeWebSocket.instances.push(this); }
    send(data: string) {
      if (this.readyState !== FakeWebSocket.OPEN) throw new Error('WebSocket is not OPEN');
      this.sent.push(data);
    }
    close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }); }
    open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
    receive(msg: any) { this.onmessage?.({ data: JSON.stringify(msg) }); }
    types(): string[] { return this.sent.map((s) => JSON.parse(s).type); }
    frames(): any[] { return this.sent.map((s) => JSON.parse(s)); }
  }

  describe('remote-shim: the file lists after a reconnect', () => {
    let shim: typeof import('../src/renderer/remote-shim');

    beforeEach(async () => {
      vi.resetModules();
      FakeWebSocket.instances = [];
      (globalThis as any).WebSocket = FakeWebSocket;
      // jsdom's own localStorage is unavailable on an opaque origin; the shim only
      // needs get/set/remove (same fake as the phone-refusals section of remote-shim-refusals.test.ts).
      (globalThis as any).localStorage = {
        _s: {} as Record<string, string>,
        getItem(k: string) { return this._s[k] ?? null; },
        setItem(k: string, v: string) { this._s[k] = v; },
        removeItem(k: string) { delete this._s[k]; },
      };
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { protocol: 'http:', search: '', host: 'desk:9900', href: 'http://desk:9900/' },
      });
      delete (window as any).claude;
      // A closed socket schedules the shim's own reconnect (1 s). Faking timers
      // keeps it from firing into a torn-down test; nothing here advances time.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      shim = await import('../src/renderer/remote-shim');
    });
    afterEach(() => {
      vi.clearAllTimers();
      vi.useRealTimers();
      delete (globalThis as any).WebSocket;
    });

    /** Connect, open, authenticate; returns the socket. */
    async function connectOnce(token = 'dev-1:secret') {
      const p = shim.connect(token, true);
      const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      ws.open();
      ws.receive({ type: 'auth:ok', deviceId: 'dev-1', platform: 'desktop' });
      await p;
      return ws;
    }

    it('a reconnect re-sends none of the reads the phone made before the drop', async () => {
      shim.installShim();
      const first = await connectOnce();
      const api = (window as any).claude;
      // The phone opened a project's Files and a session's drawer, and read its lists, before the drop.
      void api.artifacts.listAllFiles('/home/me/proj', { force: true }).catch(() => {});
      void api.artifacts.listSession('sess-9', '/home/me/proj').catch(() => {});
      void api.skills.list().catch(() => {});
      void api.commands.list().catch(() => {});
      void api.remote.getConfig().catch(() => {});
      expect(first.types()).toEqual(expect.arrayContaining(['artifacts:list-all-files', 'artifacts:list-session', 'skills:list', 'commands:list', 'remote:get-config']));

      // The drop, then the phone's new socket authenticates.
      first.close();
      const second = await connectOnce();
      const repeated = second.types().filter((t) => /^(artifacts:list|skills:list|commands:list|remote:get-config|remote:status)/.test(t));
      expect(repeated).toEqual([]);
    });

    it('a watcher event pushed after the reconnect reaches the phone', async () => {
      shim.installShim();
      const first = await connectOnce();
      const seen: any[] = [];
      (window as any).claude.artifacts.onChanged((evt: any) => seen.push(evt));
      first.close();
      const second = await connectOnce();
      second.receive({ type: 'artifacts:changed', payload: { projectRoot: '/home/me/proj', artifactId: 'new.md', kind: 'add', by: 'external' } });
      expect(seen).toEqual([{ projectRoot: '/home/me/proj', artifactId: 'new.md', kind: 'add', by: 'external' }]);
    });

    it('announces the reconnect to the page so screens can re-subscribe, never on the first connect', async () => {
      shim.installShim();
      const heard = vi.fn();
      window.addEventListener(REMOTE_RECONNECTED_EVENT, heard);
      const first = await connectOnce();
      expect(heard).not.toHaveBeenCalled();
      first.close();
      await connectOnce();
      expect(heard).toHaveBeenCalledTimes(1);
      window.removeEventListener(REMOTE_RECONNECTED_EVENT, heard);
    });
  });

  describe('useProjectWatch re-subscribes on a reconnect', () => {
    const saved = (window as any).claude;
    afterEach(() => { (window as any).claude = saved; });

    it('issues watch-project again for the root it shows — a new socket is a new subscriber on the host — then reloads', async () => {
      const watchProject = vi.fn(async () => ({ ok: true }));
      const unwatchProject = vi.fn(async () => ({ ok: true }));
      (window as any).claude = { artifacts: { watchProject, unwatchProject } };
      const reloaded = vi.fn();
      function Host() { useProjectWatch('/home/me/proj', reloaded); return null; }
      const view = render(React.createElement(Host));
      expect(watchProject).toHaveBeenCalledTimes(1);
      // A first connect is not a reconnect: the screen's own mount fetch covers it.
      expect(reloaded).not.toHaveBeenCalled();

      window.dispatchEvent(new CustomEvent(REMOTE_RECONNECTED_EVENT));
      expect(watchProject).toHaveBeenCalledTimes(2);
      expect(watchProject).toHaveBeenLastCalledWith('/home/me/proj');
      // The events from during the drop never arrived, so the list is asked for again.
      await vi.waitFor(() => expect(reloaded).toHaveBeenCalledTimes(1));

      // Gone from the screen: a later reconnect must not resurrect the subscription.
      view.unmount();
      expect(unwatchProject).toHaveBeenCalledWith('/home/me/proj');
      window.dispatchEvent(new CustomEvent(REMOTE_RECONNECTED_EVENT));
      expect(watchProject).toHaveBeenCalledTimes(2);
    });
  });
});
