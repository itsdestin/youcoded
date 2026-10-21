// @vitest-environment jsdom
// App.tsx's gate on the Welcome back effect (design §5,
// docs/active/specs/2026-09-24-welcome-back-design.md in the workspace): the
// screen must ask only once, only when the strip is empty, and only in the
// ONE window allowed to show it — never in remote mode, never on Android,
// never in a window that isn't the directory's leader.
//
// WHY a dedicated lightweight mount rather than tests/helpers/busy-app.tsx:
// that harness always seeds one live session ('busy-1') before <App/> ever
// renders, so a strip-empty case is unreachable through it. This file mounts
// the real App directly against the workbench's fake backend
// (installMock()), using its 'welcome-back' scenario (sessions: [],
// reopen: [...] — built for exactly this) for the empty-strip cases, and
// overrides the store's `sessions` directly for the non-empty case.
import React from 'react';
import { beforeAll, describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// jsdom has no xterm renderer. A live session's terminal can mount once it is
// the active session (Claude Code / shell mount at once; see
// SessionTerminal.tsx) — faked the same way tests/app-close-request-prompt.test.tsx
// fakes it for the same reason.
vi.mock('@xterm/xterm', async () => (await import('./helpers/busy-app-probes')).fakeXtermModule());
vi.mock('@xterm/addon-fit', async () => (await import('./helpers/busy-app-probes')).fakeAddonModule('FitAddon'));
vi.mock('@xterm/addon-unicode11', async () => (await import('./helpers/busy-app-probes')).fakeAddonModule('Unicode11Addon'));
vi.mock('@xterm/addon-webgl', async () => (await import('./helpers/busy-app-probes')).fakeAddonModule('WebglAddon'));

import { installMock } from '../src/renderer/dev/workbench/install-mock';
import { setConnectionMode } from '../src/renderer/platform';

function installBrowserStubs(): void {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  if (!(globalThis as any).IntersectionObserver) {
    (globalThis as any).IntersectionObserver = class {
      observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
    };
  }
  if (typeof window.ResizeObserver === 'undefined') {
    window.ResizeObserver = class {
      observe() {} unobserve() {} disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  // jsdom logs "Not implemented" for every canvas; the app treats a null
  // context as "no canvas".
  HTMLCanvasElement.prototype.getContext = (() => null) as any;
}

// Node's experimental localStorage (no backing file) shadows jsdom's and
// throws on every call; App reads storage at boot. A fresh in-memory Storage
// keeps one test's saved state out of the next (same fix as busy-app.tsx).
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
  };
}
function installStorage(): void {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    const store = memoryStorage();
    Object.defineProperty(window, name, { value: store, configurable: true, writable: true });
    Object.defineProperty(globalThis, name, { value: store, configurable: true, writable: true });
  }
}

const crashes: string[] = [];
let consoleWrapped = false;
function wrapConsoleForCrashes(): void {
  if (consoleWrapped) return;
  consoleWrapped = true;
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    const first = String(args[0] ?? '');
    if (first.includes('ErrorBoundary')) crashes.push(`${first} ${String(args[1] ?? '')}`);
    realError(...args);
  };
}

/** Mounts the real App against the workbench fake backend.
 *  `search` picks the mock scenario (`?scenario=welcome-back` seeds an empty
 *  strip with four rows in `reopen` — the exact fixture this feature exists
 *  to show). `overrideSessions` replaces the store's live-session list AFTER
 *  install, for the "strip is not empty" case. `overrideWindowGetId` replaces
 *  `window.claude.window.getId` (a non-leader window) — the whole namespace,
 *  per the documented gotcha (app-close-request-prompt.test.tsx): every
 *  namespace off `claude` is a caching Proxy with no `set` trap, so mutating a
 *  single member silently lands on the Proxy's own throwaway target. */
async function mountApp(opts: {
  search?: string;
  platform?: string;
  overrideSessions?: unknown[];
  overrideWindowGetId?: number;
  /** Merged into the fake's session defaults before App mounts (App reads them once at start). */
  overrideDefaults?: Record<string, unknown>;
  beforeRender?: () => void;
} = {}): Promise<HTMLElement> {
  installStorage();
  installBrowserStubs();
  wrapConsoleForCrashes();
  crashes.length = 0;
  delete (window as any).claude;
  delete (window as any).__workbenchStore;
  if (opts.platform) (window as any).__PLATFORM__ = opts.platform;
  window.history.pushState({}, '', `/?${opts.search ?? 'scenario=welcome-back'}`);
  installMock();
  if (opts.overrideSessions) {
    const store = (window as any).__workbenchStore;
    store.setState((s: any) => ({ ...s, sessions: opts.overrideSessions }));
  }
  if (opts.overrideDefaults) {
    const store = (window as any).__workbenchStore;
    store.setState((s: any) => ({ ...s, defaults: { ...s.defaults, ...opts.overrideDefaults } }));
  }
  if (opts.overrideWindowGetId != null) {
    const id = opts.overrideWindowGetId;
    (window as any).claude.window = {
      getId: async () => id,
      onCloseRequest: () => () => {},
      onCloseRequestCancelled: () => () => {},
      answerClose: () => {},
    };
  }
  opts.beforeRender?.();
  const { default: App } = await import('../src/renderer/App');
  document.getElementById('root')?.remove();
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  render(<App />, { container: root });
  return root;
}

afterEach(() => {
  cleanup();
  setConnectionMode('local');
  delete (window as any).__PLATFORM__;
  document.documentElement.removeAttribute('data-platform');
  expect(crashes).toEqual([]);
});

// The app's one-time cost — importing the whole App — is warmed before the tests under its
// own budget (test-suite-hygiene: "warmed in beforeAll ... never inside the first test"):
// ≈10 s alone on 2026-10-04, and a full run on a busy machine timed the first test out.
const APP_IMPORT_MS = 60_000;
beforeAll(async () => { await import('../src/renderer/App'); }, APP_IMPORT_MS);
// WHY 20 s (2026-10-09): a full run at load average ~38, just after a restart, needed more
// than 4 s for the mounted App to show the screen; the three positive waits failed while the
// file passed alone. A found screen returns at once, so only a broken one pays the wait (under
// the 30 s test timeout); the negative checks do not use this number.
const APPEAR_MS = 20_000;

describe('App — the Welcome back screen only ever opens once, in the leader window, never remote or Android', () => {
  it('asks once when the strip is empty and this window is the leader', async () => {
    await mountApp();
    expect(await screen.findByText('Welcome back', {}, { timeout: APPEAR_MS })).toBeInTheDocument();
  });

  it('skips when this window is not the directory leader', async () => {
    // Workbench default: getDirectory() answers leaderWindowId 1. Naming a
    // different id for THIS window's getId makes it decisively not the leader
    // (not merely "not yet resolved" — both settle from the mock's fixed
    // values, so there is no race to wait out).
    await mountApp({ overrideWindowGetId: 999 });
    // Give every async hop (session list, directory, reopen list) room to
    // settle before trusting the negative — an app that hasn't finished
    // booting yet would also show nothing, which would prove nothing.
    await screen.findByLabelText('Settings');
    await new Promise((r) => setTimeout(r, 1000));
    expect(screen.queryByText('Welcome back')).not.toBeInTheDocument();
  });

  it('skips in remote mode', async () => {
    setConnectionMode('remote');
    await mountApp();
    await screen.findByLabelText('Settings');
    await new Promise((r) => setTimeout(r, 1000));
    expect(screen.queryByText('Welcome back')).not.toBeInTheDocument();
  });

  it('skips on Android', async () => {
    await mountApp({ platform: 'android' });
    await screen.findByLabelText('Settings');
    await new Promise((r) => setTimeout(r, 1000));
    expect(screen.queryByText('Welcome back')).not.toBeInTheDocument();
  });

  it('skips when the strip is not empty', async () => {
    await mountApp({
      overrideSessions: [{
        id: 'active-1', name: 'Active session', cwd: '/tmp/active', permissionMode: 'normal',
        skipPermissions: false, status: 'active', createdAt: Date.now(), provider: 'native',
        harnessId: 'coder', model: 'qwen2.5-coder:14b',
      }],
    });
    await screen.findByLabelText('Settings');
    await new Promise((r) => setTimeout(r, 1000));
    expect(screen.queryByText('Welcome back')).not.toBeInTheDocument();
  });

  it('onDone (Start fresh) forgets exactly the ids the screen showed', async () => {
    await mountApp();
    await screen.findByText('Welcome back', {}, { timeout: APPEAR_MS });
    const store = (window as any).__workbenchStore;
    // The fixture's full offer, per scenarios.ts's 'welcome-back' case.
    expect(store.getState().reopen).toEqual(['wb-past-0', 'wb-past-1', 'wb-past-2', 'wb-past-4']);

    fireEvent.click(await screen.findByRole('button', { name: 'Start fresh' }));

    // forgetReopen mutates the SAME store field with exactly the ids
    // session:reopen-list handed the screen — this is the round trip design
    // §5's "onDone → forgetReopen(ids) with the ids shown" pins.
    await waitFor(() => expect(store.getState().reopen).toEqual([]));
  });

  it('starts independent restores before a slow restore acknowledges', async () => {
    await mountApp();
    await screen.findByText('Welcome back', {}, { timeout: APPEAR_MS });
    const api = window.claude.session;
    const release: Array<() => void> = [];
    const create = vi.fn((args: Parameters<typeof api.create>[0]) => new Promise<Awaited<ReturnType<typeof api.create>>>((resolve, reject) => {
      release.push(() => { void api.create(args).then(resolve, reject); });
    }));
    window.claude.session = new Proxy(api, { get: (target, key) => key === 'create' ? create : Reflect.get(target, key) });
    fireEvent.click(await screen.findByRole('button', { name: /^Resume all/ }));
    try {
      // No clock budget: the slow create is deliberately unresolved. Other
      // conversations must reach backend admission without waiting for it.
      await waitFor(() => expect(create).toHaveBeenCalledTimes(3));
      expect(new Set(create.mock.calls.map(([args]) => args.resumeSessionId)).size).toBe(3);
    } finally {
      // Drain the original serial implementation too, so a red test leaves no work behind.
      window.claude.session = api;
      await act(async () => { for (const done of release) done(); });
      await waitFor(() => expect(screen.queryByText('Reopening…')).not.toBeInTheDocument(), { timeout: 8000 });
    }
  });

  it.each(['local', 'remote'] as const)('keeps one recovered chat selected while the other restores arrive (%s)', async (mode) => {
    let choose!: (payload: { sessionId: string; refocusOnly: boolean }) => void;
    await mountApp({ beforeRender: () => {
      const detach = window.claude.detach;
      window.claude.detach = new Proxy(detach, { get: (target, key) => key === 'onOwnershipAcquired'
        ? (cb: typeof choose) => { choose = cb; return () => {}; } : Reflect.get(target, key) });
    } });
    await screen.findByText('Welcome back', {}, { timeout: APPEAR_MS });
    // Welcome back is desktop-only. Switch after it opens to exercise the
    // remote reply-adoption path as well as the normal created announcement.
    setConnectionMode(mode);
    const api = window.claude.session;
    const release: Array<() => Promise<unknown>> = [];
    const create = vi.fn((args: Parameters<typeof api.create>[0]) => new Promise<Awaited<ReturnType<typeof api.create>>>((resolve, reject) => {
      let result: ReturnType<typeof api.create> | undefined;
      release.push(() => { result ??= api.create(args).then(value => { resolve(value); return value; }, reject); return result; });
    }));
    window.claude.session = new Proxy(api, { get: (target, key) => key === 'create' ? create : Reflect.get(target, key) });
    const active = () => document.querySelector('[data-chat-session-id]:not([aria-hidden="true"])')?.getAttribute('data-chat-session-id');
    fireEvent.click(await screen.findByRole('button', { name: /^Resume all/ }));
    try {
      await waitFor(() => expect(create).toHaveBeenCalledTimes(3));
      await act(async () => { await release[0](); });
      await waitFor(() => expect(active()).toBeTruthy());
      const first = active();
      await act(async () => { await release[1](); });
      expect(active()).toBe(first);
      const second = (window as any).__workbenchStore.getState().sessions.find((s: any) => s.id !== first).id;
      // The session switcher's explicit focus-existing-session choice.
      act(() => { choose({ sessionId: second, refocusOnly: true }); });
      await waitFor(() => expect(active()).toBe(second));
      // An already-open writer emits only a focus request, not sessionCreated.
      // Its late acknowledgement is automatic too, not a new manual choice.
      await act(async () => { expect(await api.create(create.mock.calls[0][0])).toMatchObject({ id: first, reused: true }); });
      expect(active()).toBe(second);
      await act(async () => { await release[2](); });
      expect(active()).toBe(second);
    } finally {
      window.claude.session = api;
      await act(async () => { await Promise.all(release.map(done => done())); });
      await waitFor(() => expect(screen.queryByText('Reopening…')).not.toBeInTheDocument(), { timeout: 8000 });
    }
  });

  it.each(['local', 'remote'] as const)('does not refocus late created pushes delivered after recovery replies (%s)', async (mode) => {
    const pushes: Array<() => void> = [];
    await mountApp({ beforeRender: () => {
      const api = window.claude.on;
      window.claude.on = new Proxy(api, { get: (target, key) => key === 'sessionCreated'
        ? (cb: (...args: any[]) => void) => api.sessionCreated((...args: any[]) => { pushes.push(() => cb(...args)); })
        : Reflect.get(target, key) });
    } });
    await screen.findByText('Welcome back', {}, { timeout: APPEAR_MS });
    act(() => { setConnectionMode(mode); });
    fireEvent.click(await screen.findByRole('button', { name: /^Resume all/ }));
    await waitFor(() => expect(screen.queryByText('Reopening…')).not.toBeInTheDocument(), { timeout: 8000 });
    await waitFor(() => expect(pushes).toHaveLength(3));
    const active = () => document.querySelector('[data-chat-session-id]:not([aria-hidden="true"])')?.getAttribute('data-chat-session-id');
    await waitFor(() => expect(active()).toBeTruthy());
    const first = active();
    await act(async () => { for (const push of pushes) push(); });
    expect(active()).toBe(first);
  });

  it('does not create on a new host when an old resume lease query resolves late', async () => {
    let answer!: (value: any) => void;
    const query = vi.fn(() => new Promise<any>(resolve => { answer = resolve; }));
    const create = vi.fn();
    await mountApp({ beforeRender: () => {
      const api = window.claude.session, sync = window.claude.syncSpaces!;
      window.claude.session = new Proxy(api, { get: (target, key) => key === 'create' ? create : Reflect.get(target, key) });
      window.claude.syncSpaces = new Proxy(sync, { get: (target, key) => key === 'leaseQuery' ? query : Reflect.get(target, key) });
    } });
    await screen.findByText('Welcome back', {}, { timeout: APPEAR_MS });
    act(() => { setConnectionMode('remote'); window.dispatchEvent(new CustomEvent('youcoded:resume-session', { detail: {
      claudeSessionId: 'old-conversation', projectSlug: 'old', projectPath: '/tmp/old', provider: 'claude',
    } })); });
    await waitFor(() => expect(query).toHaveBeenCalledOnce());
    act(() => { setConnectionMode('local'); });
    await act(async () => { answer({ held: false }); });
    expect(create).not.toHaveBeenCalled();
  });

  it('does not begin a handoff when old consent is accepted after the host changes', async () => {
    const begin = vi.fn();
    const create = vi.fn();
    await mountApp({ beforeRender: () => {
      const api = window.claude.session, sync = window.claude.syncSpaces!;
      const handoff = new Proxy(api.handoff, { get: (target, key) => key === 'begin' ? begin : Reflect.get(target, key) });
      window.claude.session = new Proxy(api, { get: (target, key) => key === 'handoff' ? handoff
        : key === 'create' ? create : Reflect.get(target, key) });
      window.claude.syncSpaces = new Proxy(sync, { get: (target, key) => key === 'leaseQuery'
        ? async () => ({ held: true, self: false, device: 'old computer' }) : Reflect.get(target, key) });
    } });
    await screen.findByText('Welcome back', {}, { timeout: APPEAR_MS });
    act(() => { setConnectionMode('remote'); window.dispatchEvent(new CustomEvent('youcoded:resume-session', { detail: {
      claudeSessionId: 'old-conversation', projectSlug: 'old', projectPath: '/tmp/old', provider: 'claude',
    } })); });
    await screen.findByRole('button', { name: 'Take over' });
    // Capture the pending consent before the host reset. Accepting it must not
    // route its old conversation into the new host's PendingHandoff owner.
    act(() => { setConnectionMode('local'); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Take over' })); });
    expect(begin).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('does not launch an old recovery batch after its provider lookup crosses a host change', async () => {
    await mountApp();
    await screen.findByText('Welcome back', {}, { timeout: APPEAR_MS });
    const providers = window.claude.providers, api = window.claude.session;
    let finish!: (value: any[]) => void;
    // WHY only hold the batch lookup: ResumeBrowser also refreshes its model picker.
    const list = vi.fn(providers.list).mockImplementationOnce(() => new Promise<any[]>(resolve => { finish = resolve; }));
    const create = vi.fn();
    window.claude.providers = new Proxy(providers, { get: (target, key) => key === 'list' ? list : Reflect.get(target, key) });
    window.claude.session = new Proxy(api, { get: (target, key) => key === 'create' ? create : Reflect.get(target, key) });
    fireEvent.click(await screen.findByRole('button', { name: /^Resume all/ }));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    act(() => { setConnectionMode('remote'); });
    await act(async () => { finish([]); });
    expect(create).not.toHaveBeenCalled();
  });

  it('clears the new-chat starting state when the connection host changes', async () => {
    let reply!: (info: any) => void;
    const create = vi.fn(() => new Promise<any>(resolve => { reply = resolve; }));
    await mountApp({ beforeRender: () => {
      const api = window.claude.session;
      window.claude.session = new Proxy(api, { get: (target, key) => key === 'create' ? create : Reflect.get(target, key) });
    } });
    fireEvent.click(await screen.findByRole('button', { name: 'Start fresh' }));
    fireEvent.click(await screen.findByRole('button', { name: /^New session$/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^(Create|Start) session$/ }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(screen.getByText('Starting your session…')).toBeInTheDocument();
    act(() => { setConnectionMode('remote'); });
    await act(async () => { reply({ id: 'old-new-chat', name: 'Old chat', cwd: '/tmp/old', provider: 'claude', model: 'sonnet' }); });
    await waitFor(() => expect(screen.queryByText('Starting your session…')).not.toBeInTheDocument());
  });

  it.each(['local', 'remote'] as const)('selects an explicit manual resume while an unrelated recovery reply is still pending (%s)', async (mode) => {
    await mountApp();
    await screen.findByText('Welcome back', {}, { timeout: APPEAR_MS });
    act(() => { setConnectionMode(mode); });
    const api = window.claude.session;
    const release: Array<() => Promise<unknown>> = [];
    const create = vi.fn((args: any) => args.resumeSessionId === 'manual-conversation' ? api.create(args)
      : new Promise<any>((resolve, reject) => { let result: Promise<any> | undefined;
        release.push(() => { result ??= api.create(args).then(value => { resolve(value); return value; }, reject); return result; }); }));
    window.claude.session = new Proxy(api, { get: (target, key) => key === 'create' ? create : Reflect.get(target, key) });
    const active = () => document.querySelector('[data-chat-session-id]:not([aria-hidden="true"])')?.getAttribute('data-chat-session-id');
    fireEvent.click(await screen.findByRole('button', { name: /^Resume all/ }));
    try {
      await waitFor(() => expect(create).toHaveBeenCalledTimes(3));
      await act(async () => { await release[0](); });
      await waitFor(() => expect(active()).toBeTruthy());
      act(() => { window.dispatchEvent(new CustomEvent('youcoded:resume-session', { detail: {
        claudeSessionId: 'manual-conversation', projectSlug: 'manual', projectPath: '/tmp/manual', provider: 'claude',
      } })); });
      await waitFor(() => expect(create).toHaveBeenCalledTimes(4));
      const info = await create.mock.results[3].value;
      await waitFor(() => expect(active()).toBe(info.id));
    } finally {
      window.claude.session = api;
      await act(async () => { await Promise.all(release.map(done => done())); });
    }
  });

  it.each(['local', 'remote'] as const)('selects an explicit new chat during a held recovery batch (%s)', async (mode) => {
    await mountApp();
    await screen.findByText('Welcome back', {}, { timeout: APPEAR_MS });
    act(() => { setConnectionMode(mode); });
    const api = window.claude.session;
    const release: Array<() => Promise<unknown>> = [];
    const create = vi.fn((args: any) => !args.resumeSessionId ? api.create(args)
      : new Promise<any>((resolve, reject) => { let result: Promise<any> | undefined;
        release.push(() => { result ??= api.create(args).then(value => { resolve(value); return value; }, reject); return result; }); }));
    window.claude.session = new Proxy(api, { get: (target, key) => key === 'create' ? create : Reflect.get(target, key) });
    const active = () => document.querySelector('[data-chat-session-id]:not([aria-hidden="true"])')?.getAttribute('data-chat-session-id');
    fireEvent.click(await screen.findByRole('button', { name: /^Resume all/ }));
    try {
      await waitFor(() => expect(create).toHaveBeenCalledTimes(3));
      await act(async () => { await release[0](); });
      await waitFor(() => expect(active()).toBeTruthy());
      fireEvent.keyDown(document.body, { key: 'Shift' });
      fireEvent.click(await screen.findByRole('button', { name: /New session$/ }));
      fireEvent.click(await screen.findByRole('button', { name: /^(Create|Start) session$/ }));
      await waitFor(() => expect(create).toHaveBeenCalledTimes(4));
      const info = await create.mock.results[3].value;
      await waitFor(() => expect(active()).toBe(info.id));
      await act(async () => { await Promise.all(release.map(done => done())); });
      expect(active()).toBe(info.id);
    } finally {
      window.claude.session = api;
      await act(async () => { await Promise.all(release.map(done => done())); });
    }
  });

  it.each(['host change', 'unmount'] as const)('ignores a remote resume reply after %s', async (invalidate) => {
    let reply!: (info: any) => void;
    const create = vi.fn(() => new Promise<any>((resolve) => { reply = resolve; }));
    let open!: ReturnType<typeof vi.fn>;
    await mountApp({ beforeRender: () => {
      const api = window.claude.session;
      open = vi.fn(api.open);
      window.claude.session = new Proxy(api, { get: (target, key) => key === 'create' ? create
        : key === 'open' ? open : Reflect.get(target, key) });
    } });
    await screen.findByText('Welcome back', {}, { timeout: APPEAR_MS });
    act(() => { setConnectionMode('remote'); });
    act(() => { window.dispatchEvent(new CustomEvent('youcoded:resume-session', { detail: {
      claudeSessionId: 'old-conversation', projectSlug: 'old-project', projectPath: '/tmp/old-project', provider: 'claude',
    } })); });
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    if (invalidate === 'unmount') cleanup();
    else act(() => { setConnectionMode('local'); setConnectionMode('remote'); });
    await act(async () => { reply({ id: 'stale-writer', name: 'Old writer', cwd: '/tmp/old-project', provider: 'claude', permissionMode: 'normal', model: 'sonnet' }); });
    expect(document.querySelector('[data-chat-session-id="stale-writer"]')).toBeNull();
    expect(open.mock.calls.some(([req]) => req.sessionId === 'stale-writer')).toBe(false);
  });

  it('keeps successful restores when another startup fails later', async () => {
    await mountApp();
    await screen.findByText('Welcome back', {}, { timeout: APPEAR_MS });
    const api = window.claude.session;
    let fail!: () => void;
    const create = vi.fn((args: Parameters<typeof api.create>[0]) => args.resumeSessionId === 'wb-past-0'
      ? new Promise<Awaited<ReturnType<typeof api.create>>>((_, reject) => { fail = () => reject(new Error('startup failed')); })
      : api.create(args));
    window.claude.session = new Proxy(api, { get: (target, key) => key === 'create' ? create : Reflect.get(target, key) });
    fireEvent.click(await screen.findByRole('button', { name: /^Resume all/ }));
    try {
      await waitFor(() => expect(create).toHaveBeenCalledTimes(3));
      const store = (window as any).__workbenchStore;
      await waitFor(() => expect(store.getState().sessions).toHaveLength(2));
      expect(screen.getByText('Reopening…')).toBeInTheDocument();
      await act(async () => { fail(); });
      expect(await screen.findByText('2 reopened. The 2 left didn’t reopen.')).toBeInTheDocument();
      expect(store.getState().sessions).toHaveLength(2);
    } finally {
      await act(async () => { fail?.(); });
      window.claude.session = api;
      await waitFor(() => expect(screen.queryByText('Reopening…')).not.toBeInTheDocument(), { timeout: 8000 });
    }
  });

  it('queues ownership questions without blocking an unrelated restore', async () => {
    await mountApp();
    await screen.findByText('Welcome back', {}, { timeout: APPEAR_MS });
    const api = window.claude.syncSpaces!;
    const queried: string[] = [];
    window.claude.syncSpaces = new Proxy(api, { get: (target, key) => key === 'leaseQuery'
      ? async (id: string) => {
        queried.push(id);
        return id === 'wb-past-4' ? { held: false } : { held: true, self: false, device: `device-${id}` };
      } : Reflect.get(target, key) });
    fireEvent.click(await screen.findByRole('button', { name: /^Resume all/ }));
    try {
      await waitFor(() => expect(queried).toHaveLength(3));
      const store = (window as any).__workbenchStore;
      await waitFor(() => expect(store.getState().sessions).toHaveLength(1));
      expect(await screen.findByText('device-wb-past-0')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Never mind' }));
      expect(await screen.findByText('device-wb-past-1')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Never mind' }));
    } finally {
      // Settle any dialog still open after a failed assertion, without consenting to takeover.
      while (screen.queryByRole('button', { name: 'Never mind' })) {
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Never mind' })); });
      }
      await waitFor(() => expect(screen.queryByText('Reopening…')).not.toBeInTheDocument(), { timeout: 8000 });
      window.claude.syncSpaces = api;
    }
  });

  it.each(['local', 'remote'] as const)('keeps the active transfer selected and explains why a second must wait (%s)', async (mode) => {
    let release!: () => Promise<unknown>;
    const begin = vi.fn(async () => ({ id: 'transfer-1', status: 'waiting' as const }));
    let finish!: () => void;
    const waiting = new Promise<any>((resolve) => { finish = () => resolve({ id: 'transfer-1', status: 'cancelled' }); });
    await mountApp({ beforeRender: () => {
      const sessionApi = window.claude.session;
      const syncApi = window.claude.syncSpaces!;
      // PendingHandoff captures its API during App's first render.
      const handoff = new Proxy(sessionApi.handoff, { get: (target, key) => key === 'begin' ? begin
        : key === 'wait' ? () => waiting : Reflect.get(target, key) });
      const create = (args: Parameters<typeof sessionApi.create>[0]) => new Promise<Awaited<ReturnType<typeof sessionApi.create>>>((resolve, reject) => {
        let result: ReturnType<typeof sessionApi.create> | undefined;
        release = () => { result ??= sessionApi.create(args).then(value => { resolve(value); return value; }, reject); return result; };
      });
      window.claude.session = new Proxy(sessionApi, { get: (target, key) => key === 'handoff' ? handoff
        : key === 'create' ? create : Reflect.get(target, key) });
      window.claude.syncSpaces = new Proxy(syncApi, { get: (target, key) => key === 'leaseQuery'
        ? async (id: string) => id === 'wb-past-4' ? { held: false }
          : { held: true, self: false, device: `device-${id}` } : Reflect.get(target, key) });
    } });
    await screen.findByText('Welcome back', {}, { timeout: APPEAR_MS });
    setConnectionMode(mode);
    fireEvent.click(await screen.findByRole('button', { name: /^Resume all/ }));
    try {
      await screen.findByText('device-wb-past-0');
      fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
      await waitFor(() => expect(begin).toHaveBeenCalledOnce());
      await waitFor(() => expect(release).toBeTypeOf('function'));
      await act(async () => { await release(); });
      // The unrelated admitted writer is listed, but must not replace the
      // selected read/draft transfer tab before that transfer is admitted.
      expect(document.querySelector('[data-chat-session-id]:not([aria-hidden="true"])')).toBeNull();
      await screen.findByText('device-wb-past-1');
      fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
      expect(await screen.findByText('Finish the current conversation transfer, then try reopening this one again.')).toBeInTheDocument();
      expect(begin).toHaveBeenCalledOnce();
    } finally {
      while (screen.queryByRole('button', { name: 'Never mind' })) {
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Never mind' })); });
      }
      await act(async () => { await release?.(); finish(); });
      await waitFor(() => expect(screen.queryByText('Reopening…')).not.toBeInTheDocument(), { timeout: 8000 });
    }
  });

  // The screen shows no Skip permissions switch, so Resume all must never
  // carry a "skip" default into every reopened session unseen.
  it('Resume all reopens sessions with approvals on even when the default is to skip them', async () => {
    await mountApp({ overrideDefaults: { skipPermissions: true } });
    const store = (window as any).__workbenchStore;
    await screen.findByText('Welcome back', {}, { timeout: APPEAR_MS });
    const before = store.getState().sessions.length;

    fireEvent.click(await screen.findByRole('button', { name: /^Resume all/ }));

    await waitFor(() => expect(store.getState().sessions.length).toBeGreaterThan(before), { timeout: 8000 });
    const opened = store.getState().sessions.slice(before);
    expect(opened.every((s: any) => s.skipPermissions === false)).toBe(true);
    // WHY wait for the button to leave "Reopening…" (2026-10-02): the sessions appear
    // before Resume all's own finally-block runs, so the test used to end mid-resume and
    // its last state updates landed after the file's jsdom was torn down — two
    // "window is not defined" unhandled errors that failed verify.sh at random.
    await waitFor(() => expect(screen.queryByText('Reopening…')).not.toBeInTheDocument(), { timeout: 8000 });
  });
});
