/**
 * Connect-GitHub orchestrator (main process).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `github-auth.ts` is a set of pure-ish step functions (start the device flow,
 * poll for a token, hand it to `gh`). This module is the tiny STATEFUL glue that
 * sequences them into the single in-flight "connect" flow the UI drives, and
 * keeps that state out of ipc-handlers.ts so it stays thin AND unit-testable.
 *
 * At most ONE flow runs at a time (a single modal). `start()` returns the public
 * device-flow fields the modal renders (code + URL + expiry) and, in the
 * background, drives poll → login → detect, calling `emitDone` exactly once with
 * a public payload. `cancel()` aborts the in-flight poll.
 *
 * TOKEN HYGIENE (load-bearing)
 * ----------------------------
 * The token returned by `pollForToken` flows ONLY into `storeToken` (the app's
 * github-client keychain custody) and `completeLogin` (gh bootstrap). It is
 * NEVER placed into an `emitDone` payload, never logged, never returned. The
 * done payload carries only `login` (a public handle) and a typed `error`
 * reason string. A unit test asserts the token never appears in any emitDone.
 *
 * PHASE 2 (2026-07-22 sync-setup overhaul): the app's own token store is the
 * PRIMARY destination — a machine with no `gh` completes the connect fully
 * in-app. Piping the token into `gh auth login --with-token` is now the
 * BEST-EFFORT half of the two-way bootstrap (when gh exists, the terminal and
 * Claude Code sessions inside YouCoded get an authed gh for free). The flow
 * fails only if BOTH destinations fail.
 */

import { returnToApp } from './headless/host-bridge';
import {
  startDeviceFlow as realStartDeviceFlow,
  pollForToken as realPollForToken,
  completeLogin as realCompleteLogin,
  detectGh as realDetectGh,
  type DeviceFlow,
  type GhStatus,
} from './github-auth';
import { getGithubClient, fetchGithubLogin as realFetchGithubLogin } from './github-client';

/** Public payload pushed on `github:connect-done`. Never carries the token. */
export interface ConnectDonePayload {
  ok: boolean;
  login?: string;
  /** Typed reason: 'expired' | 'denied' | 'network' | 'cancelled' | 'login-failed'. */
  error?: string;
}

/** Public fields returned by `start()` — exactly what the modal needs to render. */
export interface ConnectStartResult {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}

/**
 * Injectable github-auth dependencies. Default to the real implementations;
 * tests pass fakes so the whole flow runs with no network / no spawn.
 */
export interface GithubConnectDeps {
  startDeviceFlow?: typeof realStartDeviceFlow;
  pollForToken?: typeof realPollForToken;
  completeLogin?: typeof realCompleteLogin;
  detectGh?: typeof realDetectGh;
  /** Persist the token in the app's own store (github-client). */
  storeToken?: (token: string, login?: string) => Promise<void>;
  /** REST GET /user → login, so the success payload works with no gh at all. */
  fetchLogin?: (token: string) => Promise<string | undefined>;
  /** Told once when GitHub approves and the connect succeeds. Defaults to bringing YouCoded back on the phone. */
  onConnected?: () => void;
}

export interface GithubConnect {
  /** Begin a flow: returns the modal's render fields and kicks off polling. */
  start(): Promise<ConnectStartResult>;
  /** Abort the in-flight flow (poll rejects 'cancelled' → emitDone). */
  cancel(): void;
}

export function createGithubConnect(
  emitDone: (p: ConnectDonePayload) => void,
  deps: GithubConnectDeps = {},
): GithubConnect {
  const startDeviceFlow = deps.startDeviceFlow ?? realStartDeviceFlow;
  const pollForToken = deps.pollForToken ?? realPollForToken;
  const completeLogin = deps.completeLogin ?? realCompleteLogin;
  const detectGh = deps.detectGh ?? realDetectGh;
  // WHY (Destin, final review Q-12): after the person approves on github.com the phone's browser is left on
  // GitHub's page; bring YouCoded back. returnToApp does nothing unless the Android app started this backend.
  // Success only: a denial or an expiry happens with nobody watching, and must not pull the app forward.
  const onConnected = deps.onConnected ?? returnToApp;
  // Default resolves the client PER CALL (not at create time): ipc-handlers
  // constructs this orchestrator during registration, and the client singleton
  // is registered from main.ts — capture-at-create would race that ordering.
  const storeToken = deps.storeToken ?? (async (token: string, login?: string) => {
    const client = getGithubClient();
    if (!client) throw new Error('github-client not initialized');
    await client.setToken(token, login);
  });
  const fetchLogin = deps.fetchLogin ?? realFetchGithubLogin;

  // The single in-flight flow's abort handle. Non-null only while a flow runs.
  let controller: AbortController | null = null;
  // Monotonic id identifying the CURRENT flow. Each start() bumps it, which both
  // supersedes any prior flow (its finish becomes a no-op) and, once a flow
  // finishes, blocks that same flow from settling twice. This is per-flow rather
  // than a single shared `settled` bool because the orchestrator is a singleton
  // shared by desktop AND remote clients: two connect-starts without an
  // intervening cancel (double-click, or desktop+remote racing) must not let an
  // aborted old flow emit a spurious 'cancelled' that also blocks the new flow.
  let activeFlowId = 0;

  async function start(): Promise<ConnectStartResult> {
    // A new flow supersedes any prior one — abort it AND bump the id so its
    // detached chain's finish() becomes a no-op (only an explicit user cancel of
    // the CURRENT flow should emit). (start() is the modal opening; at most one.)
    controller?.abort();
    const myId = ++activeFlowId;
    const myController = new AbortController();
    controller = myController;

    // Settles THIS flow exactly once. A superseded flow (myId !== activeFlowId)
    // is silenced; a completed flow bumps the id so it can't re-settle.
    const finish = (p: ConnectDonePayload) => {
      if (myId !== activeFlowId) return;
      activeFlowId++;
      if (controller === myController) controller = null;
      emitDone(p);
    };

    // startDeviceFlow throws Error('network') — let it reject start() so the
    // modal shows the network-error state immediately (no flow to run).
    let flow: DeviceFlow;
    try {
      flow = await startDeviceFlow();
    } catch (err) {
      if (controller === myController) controller = null;
      throw err;
    }

    const signal = myController.signal;

    // Detached background chain: poll → login → detect → emitDone. We do NOT
    // await this; start() returns the render fields immediately. Any throw maps
    // to a typed done payload. The token lives only inside this closure.
    void (async () => {
      let token: string;
      try {
        const result = await pollForToken(flow.deviceCode, {
          intervalMs: flow.interval * 1000,
          expiresAt: flow.expiresAt,
          signal,
        });
        token = result.token;
      } catch (err) {
        // pollForToken rejects Error('expired'|'denied'|'network'|'cancelled') —
        // map the reason straight through.
        finish({ ok: false, error: reasonOf(err) });
        return;
      }

      // Login handle first (REST — works with zero gh): it labels the success
      // payload AND gets recorded next to the stored token so github:status
      // can show "Connected as X" without a network call. Best-effort.
      let login: string | undefined;
      try {
        login = await fetchLogin(token);
      } catch {
        /* offline blip — leave undefined, detectGh below may still fill it */
      }

      // Two destinations, in priority order. The APP STORE is primary: it is
      // what sync/publishing read from now. The gh login is the best-effort
      // half of the two-way bootstrap — when gh exists, the user's terminal
      // (and Claude Code sessions inside YouCoded) get an authed gh from the
      // same single sign-in; when gh is absent this fails quietly and that's
      // fine. Only BOTH failing is a failed connect.
      let stored = false;
      try {
        await storeToken(token, login);
        stored = true;
      } catch {
        /* keychain/disk failure — gh below may still save the flow */
      }
      let ghLoggedIn = false;
      try {
        await completeLogin(token);
        ghLoggedIn = true;
      } catch {
        /* gh missing or choked — fine when the app store took the token */
      }
      if (!stored && !ghLoggedIn) {
        finish({ ok: false, error: 'login-failed' });
        return;
      }

      // Fallback login source when REST didn't answer: gh's own view. A
      // failure here must NOT downgrade the success — we just omit `login`.
      if (!login) {
        try {
          const status: GhStatus = await detectGh();
          if (status.login) login = status.login;
        } catch {
          /* leave login undefined */
        }
      }
      // Only when this flow really settles (not superseded or cancelled), so the app is never pulled forward twice.
      const stillCurrent = myId === activeFlowId;
      finish({ ok: true, login });
      if (stillCurrent) { try { onConnected(); } catch { /* a return hook must never break the connect */ } }
    })();

    return {
      userCode: flow.userCode,
      verificationUri: flow.verificationUri,
      expiresAt: flow.expiresAt,
    };
  }

  function cancel(): void {
    // Aborting makes the in-flight poll reject Error('cancelled'), which routes
    // through finish({ok:false, error:'cancelled'}). If no flow is running this
    // is a harmless no-op.
    controller?.abort();
  }

  return { start, cancel };
}

// ---------------------------------------------------------------------------
// Module singleton
// ---------------------------------------------------------------------------
//
// ipc-handlers.ts creates the ONE orchestrator (its emitDone fans the done
// event out to both Electron windows and remote clients) and registers it here.
// remote-server.ts reads it so a remote browser's connect-start/cancel drives
// the SAME in-flight flow — matching how the syncspaces:* rows share a single
// service singleton. Without this, a remote-started flow and a desktop-started
// flow would be two independent orchestrators and cancel would miss.

let singleton: GithubConnect | null = null;

/** Register the process-wide orchestrator (called once from ipc-handlers). */
export function setGithubConnect(gc: GithubConnect): void {
  singleton = gc;
}

/** Read the process-wide orchestrator (remote-server uses this). */
export function getGithubConnect(): GithubConnect | null {
  return singleton;
}

// ---------------------------------------------------------------------------
// Disconnect (Settings → GitHub → Disconnect)
// ---------------------------------------------------------------------------

/**
 * Delete the app's stored GitHub token. Deliberately does NOT touch a gh CLI
 * login — the app doesn't own that credential, and the client's acquisition
 * order will keep borrowing it (which the Connected-accounts UI states).
 *
 * If sync is enabled, kick an immediate sync so the panel reflects the
 * consequence NOW — on a device with no gh fallback the next pull/push fails
 * with the coded 'github-auth' error, landing sync in the honest
 * red-with-Reconnect state instead of waiting for the 120s poll to reveal it.
 */
export async function disconnectGithub(): Promise<{ ok: true }> {
  getGithubClient()?.clearToken();
  try {
    // Dynamic import: service.ts imports github-client, and a static import
    // here would put this module in every sync test's import graph for no gain.
    const { isSyncSpacesEnabled, syncSpacesSyncNow } = await import('./sync-spaces/service');
    if (isSyncSpacesEnabled()) void syncSpacesSyncNow();
  } catch { /* sync service not started — nothing to surface */ }
  return { ok: true };
}

/** Map a thrown value to its typed reason string, defaulting to 'network'. */
function reasonOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === 'expired' || msg === 'denied' || msg === 'cancelled' || msg === 'network') {
    return msg;
  }
  return 'network';
}
