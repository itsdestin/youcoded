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
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
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
  if (opts.overrideWindowGetId != null) {
    const id = opts.overrideWindowGetId;
    (window as any).claude.window = {
      getId: async () => id,
      onCloseRequest: () => () => {},
      onCloseRequestCancelled: () => () => {},
      answerClose: () => {},
    };
  }
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

describe('App — the Welcome back screen only ever opens once, in the leader window, never remote or Android', () => {
  it('asks once when the strip is empty and this window is the leader', async () => {
    await mountApp();
    expect(await screen.findByText('Welcome back', {}, { timeout: 4000 })).toBeInTheDocument();
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
    await screen.findByText('Welcome back', {}, { timeout: 4000 });
    const store = (window as any).__workbenchStore;
    // The fixture's full offer, per scenarios.ts's 'welcome-back' case.
    expect(store.getState().reopen).toEqual(['wb-past-0', 'wb-past-1', 'wb-past-2', 'wb-past-4']);

    fireEvent.click(await screen.findByRole('button', { name: 'Start fresh' }));

    // forgetReopen mutates the SAME store field with exactly the ids
    // session:reopen-list handed the screen — this is the round trip design
    // §5's "onDone → forgetReopen(ids) with the ids shown" pins.
    await waitFor(() => expect(store.getState().reopen).toEqual([]));
  });
});
