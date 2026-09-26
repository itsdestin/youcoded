// @vitest-environment jsdom
// Welcome back — App.tsx's side of the in-app quit warning (design §4). The
// busy-app harness (tests/helpers/busy-app.tsx) mounts the REAL App.tsx; this
// swaps in controllable fakes for window.claude.window's three close-request
// members via its `beforeMount` hook (App subscribes to them once, in a
// mount-time useEffect, so they must be in place before render).
//
// What this pins: a pushed window:close-request renders QuitSessionsPrompt
// with the count it carried, and a window:close-request-cancelled push for
// the SAME requestId clears it again — the renderer-side half of design §4
// step 5 (whole-app quit wins over a pending prompt).
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// jsdom has no xterm renderer; mountBusyApp's harness (a real App.tsx mount)
// needs the same fakes busy-app-render-budget.test.tsx installs, or every
// session's TerminalView throws into its ErrorBoundary and the mount refuses
// to hand back an app (crashes() is non-empty).
vi.mock('@xterm/xterm', async () => (await import('./helpers/busy-app-probes')).fakeXtermModule());
vi.mock('@xterm/addon-fit', async () => (await import('./helpers/busy-app-probes')).fakeAddonModule('FitAddon'));
vi.mock('@xterm/addon-unicode11', async () => (await import('./helpers/busy-app-probes')).fakeAddonModule('Unicode11Addon'));
vi.mock('@xterm/addon-webgl', async () => (await import('./helpers/busy-app-probes')).fakeAddonModule('WebglAddon'));
// mountBusyApp's final step (switch to sessionIds[0]) reads `lastVisible`,
// which only the probe wrapper populates — without it visibleId() never
// resolves and that step throws (busy-app-render-budget.test.tsx does the
// same wrapping for the same reason).
vi.mock('../src/renderer/components/ChatView', async (importOriginal) => {
  const real = await importOriginal<any>();
  return { ...real, default: (await import('./helpers/busy-app-probes')).probe(real.default, 'chat') };
});
vi.mock('../src/renderer/components/TerminalView', async (importOriginal) => {
  const real = await importOriginal<any>();
  return { ...real, default: (await import('./helpers/busy-app-probes')).probe(real.default, 'terminal') };
});

import { mountBusyApp, FAKE_TIMERS, type BusyApp } from './helpers/busy-app';

const WARM_IMPORT_BUDGET_MS = 120_000;
beforeAll(async () => { await import('../src/renderer/App'); }, WARM_IMPORT_BUDGET_MS);

type CloseRequest = { requestId: string; sessions: number };
type Cancelled = { requestId: string };

let app: BusyApp;
let fireCloseRequest: (req: CloseRequest) => void;
let fireCancelled: (payload: Cancelled) => void;
let answers: unknown[];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
  let onCloseRequestCb: ((req: CloseRequest) => void) | undefined;
  let onCancelledCb: ((payload: Cancelled) => void) | undefined;
  answers = [];
  app = await mountBusyApp({
    // mountBusyApp always ends by switching to sessionIds[0] through the
    // strip's All Sessions menu (tests/helpers/busy-app.tsx) — with a single
    // session that menu has nothing else to offer and the switch fails, so
    // this uses two sessions purely to keep that final step working; the
    // prompt itself does not care how many sessions exist.
    sessions: 2,
    // The mock shim's namespaces are wrapped in a caching catch-all Proxy with
    // no `set` trap (mock-shim.ts's withCatchAll), so mutating an individual
    // member (`claude.window.onCloseRequest = fn`) silently writes onto the
    // Proxy's own throwaway target and is never seen again — the `get` trap
    // always answers from its closed-over `impl` and a memoization cache.
    // Replacing the WHOLE `window` property works because that assignment
    // reaches the plain `bridge` object underneath (no proxy in the way at
    // that level). `getId` is forwarded to the real implementation because
    // App reads it during boot (App.tsx:2214) — everything else here is fully
    // owned by the test.
    beforeMount: (claude) => {
      const realGetId = claude.window.getId.bind(claude.window);
      claude.window = {
        getId: realGetId,
        onCloseRequest: (cb: (req: CloseRequest) => void) => { onCloseRequestCb = cb; return () => { onCloseRequestCb = undefined; }; },
        onCloseRequestCancelled: (cb: (payload: Cancelled) => void) => { onCancelledCb = cb; return () => { onCancelledCb = undefined; }; },
        answerClose: (answer: unknown) => { answers.push(answer); },
      };
    },
  });
  fireCloseRequest = (req) => onCloseRequestCb?.(req);
  fireCancelled = (payload) => onCancelledCb?.(payload);
});

afterEach(() => {
  expect(app?.crashes() ?? []).toEqual([]);
  vi.useRealTimers();
});

describe('App — the in-app quit warning', () => {
  it('renders QuitSessionsPrompt with the pushed session count', async () => {
    await act(async () => { fireCloseRequest({ requestId: 'r1', sessions: 4 }); });
    expect(screen.getByText('You have 4 active sessions - proceed?')).toBeInTheDocument();
  });

  it('answering forwards the requestId alongside the choice', async () => {
    await act(async () => { fireCloseRequest({ requestId: 'r1', sessions: 2 }); });
    await act(async () => { screen.getByRole('button', { name: 'Close window' }).click(); });
    expect(answers).toEqual([{ requestId: 'r1', close: true, reopen: false }]);
    expect(screen.queryByText('You have 2 active sessions - proceed?')).not.toBeInTheDocument();
  });

  it('a window:close-request-cancelled push for the same requestId clears the prompt', async () => {
    await act(async () => { fireCloseRequest({ requestId: 'r1', sessions: 3 }); });
    expect(screen.getByText('You have 3 active sessions - proceed?')).toBeInTheDocument();
    await act(async () => { fireCancelled({ requestId: 'r1' }); });
    expect(screen.queryByText('You have 3 active sessions - proceed?')).not.toBeInTheDocument();
  });

  it('a cancelled push for a DIFFERENT requestId leaves the visible prompt alone', async () => {
    await act(async () => { fireCloseRequest({ requestId: 'r1', sessions: 3 }); });
    await act(async () => { fireCancelled({ requestId: 'stale-request' }); });
    expect(screen.getByText('You have 3 active sessions - proceed?')).toBeInTheDocument();
  });
});
