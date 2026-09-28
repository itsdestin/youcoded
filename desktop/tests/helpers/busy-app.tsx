// The busy-app harness: the REAL app shell (App.tsx, every provider it mounts)
// running under jsdom against the UI Workbench's fake backend
// (src/renderer/dev/workbench/mock-shim.ts), with several sessions open and a
// way to push what a live machine pushes — streamed replies, terminal output,
// file writes — into any of them, plus the counters to see what that redrew.
//
// WHY the whole app and not a component: the lag this guards against comes
// from how the pieces meet (a root re-render reaching every tab, one listener
// per tab, a timer in a tab nobody can see). A test of one component cannot
// see any of that, and a new surface mounted in the app is covered by the
// budgets in tests/busy-app-render-budget.test.tsx without anyone writing a
// test for it.
//
// The test file installs the probes with vi.mock BEFORE anything imports the
// app (busy-app-probes.tsx says why they live in their own module). Timers must
// be faked before mountBusyApp: every wait here advances the fake clock, so a
// 10-second idle costs milliseconds and nothing depends on the machine's load.
import React from 'react';
import { vi } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { installMock } from '../../src/renderer/dev/workbench/install-mock';
import type { MockStore } from '../../src/renderer/dev/workbench/mock-store';
import { resetSubtreeRenders, subtreeRenders, lastVisible, terminalWrites } from './busy-app-probes';

/** The timers the harness drives. Not React's scheduler (setImmediate /
 *  MessageChannel): faking those would stop React itself. */
export const FAKE_TIMERS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] as const;

/** One animation frame. */
export const FRAME_MS = 16;

export interface Reply {
  /** `n` text deltas, one per animation frame (native shape: one partId). */
  words(n: number): Promise<void>;
  /** A tool call and its result. */
  tool(): Promise<void>;
  end(): Promise<void>;
}

export interface BusyApp {
  /** Ids in the order they were opened: odd positions are Claude Code
   *  sessions (they own a terminal), even positions native ones. */
  sessionIds: string[];
  /** The session the user is looking at. */
  visibleId(): string;
  /** Renders of AppInner itself (App.tsx's DEV counter). */
  shellRenders(): number;
  /** Commits that touched one session's chat / terminal subtree since the last reset. */
  chatRenders(id: string): number;
  terminalRenders(id: string): number;
  /** Both subtrees, every session except `except`, summed. */
  otherTabRenders(...except: string[]): Record<string, number>;
  resetCounts(): void;
  /** ErrorBoundary catches since mount — a budget met by a crashed subtree proves nothing. */
  crashes(): string[];
  /** Listeners on window + document, net of removals, by event type, after
   *  each session opened (index 0 = one session). */
  listenersAfterOpening: Array<Record<string, number>>;
  /** Bridge calls the app made, as "namespace.method". */
  bridgeCalls: string[];
  /** Starts a reply in `id` (the user's message lands; the session starts thinking). */
  beginReply(id: string): Promise<Reply>;
  /** PTY bytes for one session. */
  ptyOutput(id: string, data: string): void;
  /** A Write tool call on a file inside the session's folder (what drives its file list). */
  writeFile(id: string, name: string): Promise<void>;
  /** Types into the visible session's composer, the whole value at once. */
  type(value: string): Promise<void>;
  /** Switches tabs through the session strip's All Sessions menu. */
  switchTo(id: string): Promise<void>;
  /** Advances the fake clock `ms`, letting frames, timers, promises and effects run. */
  wait(ms?: number): Promise<void>;
}

// ── storage ─────────────────────────────────────────────────────────────────
// Node's own experimental `localStorage` global (no backing file) shadows
// jsdom's and throws on every call; the app reads storage at boot. A fresh
// in-memory Storage per mount also keeps one test's saved state out of the next.
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

// ── browser APIs jsdom lacks ────────────────────────────────────────────────
// Inert on purpose: an IntersectionObserver that never fires keeps folded
// timelines folded, so counts do not depend on invented layout.
// Crashes are collected, not swallowed: a subtree that threw into its
// ErrorBoundary renders nothing, and "renders nothing" meets every budget.
// mountBusyApp refuses to hand back an app with a tripped boundary.
const crashes: string[] = [];
let stubsInstalled = false;
function installBrowserStubs(): void {
  if (stubsInstalled) return;
  stubsInstalled = true;
  if (!(globalThis as any).IntersectionObserver) {
    (globalThis as any).IntersectionObserver = class {
      observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
    };
  }
  // jsdom logs "Not implemented" for every canvas; the app already treats a
  // null context as "no canvas".
  HTMLCanvasElement.prototype.getContext = (() => null) as any;
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    const first = String(args[0] ?? '');
    if (first.includes('ErrorBoundary')) crashes.push(`${first} ${String(args[1] ?? '')}`);
    realError(...args);
  };
}

// ── listener accounting ─────────────────────────────────────────────────────
// Wraps add/removeEventListener on window and document once per file. A Set
// keyed by (target, type, handler, capture) mirrors the browser's own dedup,
// so re-adding the same handler does not inflate the count.
const live = new Set<string>();
const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;
const idOf = (o: object) => {
  let v = objectIds.get(o);
  if (!v) { v = nextObjectId++; objectIds.set(o, v); }
  return v;
};
function listenerKey(target: object, type: string, fn: object, opts: unknown): string {
  const capture = typeof opts === 'boolean' ? opts : !!(opts as { capture?: boolean } | undefined)?.capture;
  return `${idOf(target)}|${type}|${idOf(fn)}|${capture}`;
}
function listenersByType(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of live) { const type = k.split('|')[1]; out[type] = (out[type] ?? 0) + 1; }
  return out;
}
let listenersWrapped = false;
function wrapListeners(): void {
  if (listenersWrapped) return;
  listenersWrapped = true;
  for (const target of [window, document] as EventTarget[]) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    target.addEventListener = (type: string, fn: any, opts?: any) => {
      if (fn) live.add(listenerKey(target, type, fn, opts));
      add(type, fn, opts);
    };
    target.removeEventListener = (type: string, fn: any, opts?: any) => {
      if (fn) live.delete(listenerKey(target, type, fn, opts));
      remove(type, fn, opts);
    };
  }
}

// ── the fake backend ────────────────────────────────────────────────────────
// The workbench shim answers every `on.*` registrar, but only a few can be
// fired from outside (the rest hand back a no-op unsubscribe). This wraps `on`
// so EVERY registration is recorded and can be driven, while still forwarding
// to the shim so its push-on-subscribe channels (chatHydrate, statusData)
// behave exactly as in the workbench.
type Cb = (...a: any[]) => void;
interface Registration { args: unknown[]; cb: Cb }
const registry = new Map<string, Set<Registration>>();

function fire(key: string, match: (r: Registration) => boolean, ...payload: unknown[]): void {
  for (const r of [...(registry.get(key) ?? [])]) if (match(r)) r.cb(...payload);
}

function wrapBridge(claude: any, calls: string[]): void {
  const realOn = claude.on;
  const onCache = new Map<string, Cb>();
  const onProxy = new Proxy({}, {
    get(_t, key) {
      if (typeof key === 'symbol' || key === 'then') return undefined;
      if (!onCache.has(key)) {
        onCache.set(key, (...args: unknown[]) => {
          const reg: Registration = { args: args.slice(0, -1), cb: args[args.length - 1] as Cb };
          if (!registry.has(key)) registry.set(key, new Set());
          registry.get(key)!.add(reg);
          const off = realOn[key]?.(...args);
          return () => { registry.get(key)?.delete(reg); if (typeof off === 'function') off(); };
        });
      }
      return onCache.get(key);
    },
  });
  // App removes a few feeds with the bridge's `off(channel, handler)` instead
  // of the returned unsubscribe; map those channel names to registry keys.
  const offKeys: Record<string, string> = {
    'session:created': 'sessionCreated', 'session:destroyed': 'sessionDestroyed',
    'hook:event': 'hookEvent', 'pty:output': 'ptyOutput', 'status:data': 'statusData',
    'session:renamed': 'sessionRenamed',
  };
  // Only `artifacts` is logged: the file-change budget needs proof that the
  // write reached the file list; logging every namespace would re-wrap
  // functions the app compares by identity.
  const artifactsCache = new Map<string, unknown>();
  const artifacts = new Proxy(claude.artifacts, {
    get(t, k) {
      const v = t[k];
      if (typeof k !== 'string' || typeof v !== 'function') return v;
      if (!artifactsCache.has(k)) artifactsCache.set(k, (...a: unknown[]) => { calls.push(`artifacts.${k}`); return v(...a); });
      return artifactsCache.get(k);
    },
  });
  window.claude = new Proxy(claude, {
    get(t, k) {
      if (k === 'on') return onProxy;
      if (k === 'artifacts') return artifacts;
      if (k === 'off') {
        return (channel: string, handler: unknown) => {
          const set = registry.get(offKeys[channel] ?? '');
          set?.forEach((r) => { if (r.cb === handler) set.delete(r); });
          return t.off?.(channel, handler);
        };
      }
      return t[k];
    },
  });
}

// ── clock ───────────────────────────────────────────────────────────────────
async function wait(ms = 50): Promise<void> {
  if (!vi.isFakeTimers()) throw new Error('busy-app: fake the timers (FAKE_TIMERS) before mounting');
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

/** Awaits a promise from the fake backend, advancing the clock while it is
 *  pending — the shim answers after a fake-timer latency, so a bare await
 *  would wait forever. */
async function drive<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 200 && !done; i++) await wait(10);
  return p;
}

// ── mounting ────────────────────────────────────────────────────────────────
let seq = 0;
const CWD = '/home/destin/busy-app';

/** Mounts <App/> with ONE session, then opens the rest the way the app opens
 *  them (session.create → on.sessionCreated), so everything a new tab
 *  attaches is attached through the real path. Ends on the FIRST session,
 *  settled, with every counter at zero.
 *
 *  `beforeMount`, if given, runs right after the bridge is wrapped but before
 *  <App/> renders — the only window to swap in a test double for something
 *  App reads once on mount (e.g. `window.claude.window.onCloseRequest`, which
 *  App subscribes to in a `useEffect` with an empty dep array, so patching it
 *  AFTER mount would be too late). Replace the whole namespace object
 *  (`claude.window = {...}`), never a single member on it
 *  (`claude.window.onCloseRequest = fn`) — every namespace off `claude` is a
 *  caching catch-all Proxy with no `set` trap (mock-shim.ts's withCatchAll),
 *  so a member write silently lands on the Proxy's own throwaway target and
 *  the `get` trap goes on answering from its closed-over impl forever. */
export async function mountBusyApp(
  { sessions, beforeMount }: { sessions: number; beforeMount?: (claude: any) => void },
): Promise<BusyApp> {
  installStorage();
  installBrowserStubs();
  wrapListeners();
  crashes.length = 0;
  live.clear();
  registry.clear();
  lastVisible.clear();
  terminalWrites.length = 0;
  resetSubtreeRenders();
  delete (window as any).claude;
  delete (window as any).__workbenchStore;
  installMock();
  const store = (window as any).__workbenchStore as MockStore;
  const bridgeCalls: string[] = [];
  wrapBridge(window.claude, bridgeCalls);
  beforeMount?.(window.claude);
  store.setState((s) => ({
    ...s,
    sessions: [{
      id: 'busy-1', name: 'session 1', cwd: CWD, permissionMode: 'normal', skipPermissions: false,
      status: 'active', createdAt: 1_753_800_000_000, provider: 'claude', model: 'claude-sonnet-4-6',
    } as any],
    past: [],
  }));

  const { default: App } = await import('../../src/renderer/App');
  // The real mount point: several menus portal to #root (not body) so they
  // inherit the theme — the session strip's All Sessions menu among them.
  document.getElementById('root')?.remove();
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  await act(async () => { render(<App />, { container: root }); });
  await wait(500);

  // A Claude Code session is "Initializing…" until its first hook event.
  const ready = (id: string) => act(async () => {
    fire('hookEvent', () => true, { type: 'SessionStart', sessionId: id, payload: {} });
  });
  const sessionIds = ['busy-1'];
  await ready('busy-1');
  await wait(500);
  const listenersAfterOpening = [listenersByType()];
  for (let i = 2; i <= sessions; i++) {
    const provider = i % 2 === 0 ? 'native' : 'claude';
    const created: any = await drive((window.claude as any).session.create({
      name: `session ${i}`, cwd: CWD, provider, harnessId: provider === 'native' ? 'coder' : undefined,
    }));
    sessionIds.push(created.id);
    if (provider === 'claude') await ready(created.id);
    await wait(500);
    listenersAfterOpening.push(listenersByType());
  }
  if (crashes.length) throw new Error(`busy-app: the app crashed while mounting:\n${crashes.join('\n')}`);

  const renders = (id: string) => (subtreeRenders.chat.get(id) ?? 0) + (subtreeRenders.terminal.get(id) ?? 0);
  const app: BusyApp = {
    sessionIds,
    visibleId: () => [...lastVisible].find(([, v]) => v)?.[0] ?? '',
    shellRenders: () => window.__appInnerProfile?.appInnerRenders ?? 0,
    chatRenders: (id) => subtreeRenders.chat.get(id) ?? 0,
    terminalRenders: (id) => subtreeRenders.terminal.get(id) ?? 0,
    otherTabRenders: (...except) => Object.fromEntries(
      sessionIds.filter((id) => !except.includes(id)).map((id) => [id, renders(id)])),
    resetCounts: () => { resetSubtreeRenders(); window.__appInnerProfile?.reset(); },
    crashes: () => [...crashes],
    listenersAfterOpening,
    bridgeCalls,
    wait,

    async beginReply(id) {
      const n = ++seq;
      const part = `part-${n}`;
      let w = 0;
      const event = (e: Record<string, unknown>) => fire('transcriptEvent', () => true, { sessionId: id, timestamp: Date.now(), ...e });
      await act(async () => { event({ type: 'user-message', uuid: `u-${n}`, data: { text: 'hello' } }); });
      await wait(FRAME_MS);
      return {
        async words(count) {
          for (let i = 0; i < count; i++, w++) {
            await act(async () => { event({ type: 'assistant-text', uuid: `t-${n}-${w}`, data: { text: 'word ', partId: part } }); });
            await wait(FRAME_MS);
          }
        },
        async tool() {
          await act(async () => {
            event({ type: 'tool-use', uuid: `tu-${n}-${w}`, data: { toolUseId: `tool-${n}-${w}`, toolName: 'Bash', toolInput: { command: 'ls' } } });
            event({ type: 'tool-result', uuid: `tr-${n}-${w}`, data: { toolUseId: `tool-${n}-${w}`, toolResult: 'a\nb', isError: false } });
          });
          await wait(FRAME_MS);
        },
        async end() {
          await act(async () => { event({ type: 'turn-complete', uuid: `tc-${n}`, data: {} }); });
          await wait(FRAME_MS);
        },
      };
    },

    ptyOutput(id, data) {
      act(() => {
        fire('ptyOutputForSession', (r) => r.args[0] === id, data);
        fire('ptyOutput', () => true, id, data);
      });
    },

    async writeFile(id, name) {
      const n = ++seq;
      await act(async () => {
        fire('transcriptEvent', () => true, {
          type: 'tool-use', sessionId: id, uuid: `w-${n}`, timestamp: Date.now(),
          data: { toolUseId: `write-${n}`, toolName: 'Write', toolInput: { file_path: `${CWD}/${name}`, content: 'x' } },
        });
      });
    },

    async type(value) {
      const box = document.querySelector<HTMLTextAreaElement>('#root textarea.input-bar-textarea');
      if (!box) throw new Error('busy-app: no composer on screen');
      await act(async () => { fireEvent.change(box, { target: { value } }); });
      await wait(FRAME_MS);
    },

    async switchTo(id) {
      // The path a mouse user takes: the strip's All Sessions menu, then the
      // row. (In a zero-width jsdom header the strip packs every pill except
      // the active one into that menu.)
      const trigger = document.querySelector('[data-session-strip] path[d="M19 9l-7 7-7-7"]')?.closest('button');
      if (!trigger) throw new Error('busy-app: no All Sessions button in the session strip');
      await act(async () => { fireEvent.click(trigger); });
      const row = document.querySelector(`[data-session-id="${id}"] [role="button"]`);
      if (!row) throw new Error(`busy-app: no row for ${id} in the All Sessions menu`);
      await act(async () => { fireEvent.click(row); });
      await wait(500);
      if (app.visibleId() !== id) throw new Error(`busy-app: switched to ${id} but ${app.visibleId()} is showing`);
    },
  };

  await app.switchTo(sessionIds[0]);
  await wait(3000);
  app.resetCounts();
  return app;
}
