// @vitest-environment jsdom
//
// Remote access batch 3, design test 8 (the phone's half) — after a reconnect
// the file lists the phone was showing are asked for again, a watcher event
// still reaches the phone, and the Files screen's watcher hook re-subscribes
// (technical design 2026-09-10 §8 "Live refresh"; contract row R12).
//
// WHY the reconnect re-issue must carry the last payload: `rehydrate()` used to
// call every channel bare. That is fine for `skills:list`, which takes no
// arguments, but `artifacts:list-all-files` with no project id is a request
// the host can only refuse — a re-issue that reloads nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { REMOTE_RECONNECTED_EVENT } from '../src/renderer/remote-events';
import { useProjectWatch } from '../src/renderer/hooks/useProjectWatch';

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
    // needs get/set/remove (same fake as remote-shim-phone-refusals.test.ts).
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

  it('the two list channels are in the reconnect set, and only reads are', () => {
    expect(shim.REHYDRATE_ON_RECONNECT).toContain('artifacts:list-all-files');
    expect(shim.REHYDRATE_ON_RECONNECT).toContain('artifacts:list-session');
    for (const c of shim.REHYDRATE_ON_RECONNECT) {
      expect(shim.MESSAGE_KIND[c] === undefined || shim.MESSAGE_KIND[c] === 'read').toBe(true);
    }
  });

  it('re-issues the lists the phone was showing, with the arguments it used, and only on a reconnect', async () => {
    shim.installShim();
    const first = await connectOnce();
    const api = (window as any).claude;
    // The phone opened a project's Files and a session's drawer before the drop.
    void api.artifacts.listAllFiles('/home/me/proj', { force: true }).catch(() => {});
    void api.artifacts.listSession('sess-9', '/home/me/proj').catch(() => {});
    const firstLists = first.types().filter((t) => t.startsWith('artifacts:list'));
    expect(firstLists).toEqual(['artifacts:list-all-files', 'artifacts:list-session']);

    // The drop, then the phone's new socket authenticates.
    first.close();
    const second = await connectOnce();

    const reissued = second.frames().filter((f) => f.type === 'artifacts:list-all-files' || f.type === 'artifacts:list-session');
    expect(reissued.map((f) => f.type).sort()).toEqual(['artifacts:list-all-files', 'artifacts:list-session']);
    // The SAME question, not a bare one the host can only refuse.
    expect(reissued.find((f) => f.type === 'artifacts:list-all-files').payload).toEqual({ projectId: '/home/me/proj', opts: { force: true } });
    expect(reissued.find((f) => f.type === 'artifacts:list-session').payload).toEqual({ sessionId: 'sess-9', projectRoot: '/home/me/proj' });
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

  it('issues watch-project again for the root it shows — a new socket is a new subscriber on the host', async () => {
    const watchProject = vi.fn(async () => ({ ok: true }));
    const unwatchProject = vi.fn(async () => ({ ok: true }));
    (window as any).claude = { artifacts: { watchProject, unwatchProject } };
    function Host() { useProjectWatch('/home/me/proj'); return null; }
    const view = render(React.createElement(Host));
    expect(watchProject).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new CustomEvent(REMOTE_RECONNECTED_EVENT));
    expect(watchProject).toHaveBeenCalledTimes(2);
    expect(watchProject).toHaveBeenLastCalledWith('/home/me/proj');

    // Gone from the screen: a later reconnect must not resurrect the subscription.
    view.unmount();
    expect(unwatchProject).toHaveBeenCalledWith('/home/me/proj');
    window.dispatchEvent(new CustomEvent(REMOTE_RECONNECTED_EVENT));
    expect(watchProject).toHaveBeenCalledTimes(2);
  });
});
