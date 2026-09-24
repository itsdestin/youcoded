// The in-app quit warning's request/answer state machine (design
// docs/active/specs/2026-09-24-welcome-back-design.md §4, plan T3).
//
// WHY its own module, injected timer + id generator, exactly like
// welcome-back-store.ts's injected fs: main.ts's window 'close' handler lives
// inside createAppWindow(), closed over a real BrowserWindow/webContents that
// vitest cannot construct. This module touches neither — it only tracks
// pending requests per window and calls the two effects (`send`, a timer) the
// caller hands it — so the state machine itself (reuse, timeout, settle,
// late-answer-ignored) can be driven directly in tests with fake timers and a
// deterministic id generator, with no Electron in the loop at all.
// Not exported: nothing outside this module needs the shape by name — main.ts
// and the test file both pass/read plain object literals structurally
// (knip flags an exported type with no outside importer as dead).
interface CloseAnswer {
  /** false = Cancel — the window stays open, nothing else happens. */
  close: boolean;
  /** Only meaningful when `close` is true. true = keep tracked (the caller
   *  must skip `untrack` — Welcome back offers these sessions again, same as
   *  after a crash). Missing/false = Destin said "don't resume": the caller
   *  untracks each owned session before destroying it. */
  reopen?: boolean;
}

export interface CloseRequestPush {
  requestId: string;
  sessions: number;
}

export interface CloseRequestManagerDeps {
  /** Schedules the "renderer might be frozen" fallback (design §4 step 2). */
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Mints a requestId. A real caller wants something unguessable
   *  (`randomUUID`); a test wants something deterministic. */
  genId: () => string;
  /** Default 5s (design §4 step 2: "a frozen renderer cannot draw it"). */
  timeoutMs?: number;
}

interface PendingRequest {
  requestId: string;
  resolvers: Array<(answer: CloseAnswer) => void>;
  timer: unknown;
}

/** Timeout and a whole-app-quit settle resolve identically: keep every owned
 *  session tracked (no untrack) and let the caller's destroy+close loop run
 *  anyway — the same fate a crash already leaves a session in. */
const KEEP_TRACKED: CloseAnswer = { close: true, reopen: true };

export interface CloseRequestManager {
  /**
   * Ask (or re-ask) windowId's renderer to confirm closing `sessions` active
   * sessions. `send` delivers the push exactly once per NEW request — a
   * second call for the SAME windowId while one is still outstanding reuses
   * it (design §4 step 4: "no stacking") and never calls `send` again; both
   * callers' promises resolve together when the one request finally settles.
   */
  request(windowId: number, sessions: number, send: (push: CloseRequestPush) => void): Promise<CloseAnswer>;
  /** The renderer answered `requestId`. A no-op if that request already
   *  settled (by timeout or by settleAll()) — a late answer changes nothing
   *  (design §4 step 5). */
  answer(requestId: string, answer: CloseAnswer): void;
  /**
   * Whole-app quit wins over every prompt still in flight (design §4 step 5).
   * Resolves each pending request as `{close:true, reopen:true}` and calls
   * `cancelled(windowId, requestId)` for each so the caller can push
   * `window:close-request-cancelled` to that window. Call once, at the top
   * of shutdownApp() — the one function every quit route (before-quit AND
   * SIGTERM/SIGINT) passes through.
   */
  settleAll(cancelled: (windowId: number, requestId: string) => void): void;
}

export function createCloseRequestManager(deps: CloseRequestManagerDeps): CloseRequestManager {
  const timeoutMs = deps.timeoutMs ?? 5_000;
  const pending = new Map<number, PendingRequest>();

  function settle(windowId: number, answer: CloseAnswer): void {
    const entry = pending.get(windowId);
    if (!entry) return; // already settled — e.g. the timer fired after settleAll() beat it there
    pending.delete(windowId);
    deps.clearTimer(entry.timer);
    for (const resolve of entry.resolvers) resolve(answer);
  }

  return {
    request(windowId, sessions, send) {
      const existing = pending.get(windowId);
      if (existing) {
        // Re-use (design §4 step 4): no new requestId, no second push — just
        // another resolver on the SAME pending entry.
        return new Promise((resolve) => existing.resolvers.push(resolve));
      }
      const requestId = deps.genId();
      const entry: PendingRequest = { requestId, resolvers: [], timer: undefined };
      // A frozen renderer can never draw the prompt, so the window must not
      // wait on it forever (design §4 step 2, review 1 D4: no orphaned
      // process behind a closed window) — settle exactly like "keep tracked",
      // the same fate a crash leaves the session in.
      entry.timer = deps.setTimer(() => settle(windowId, KEEP_TRACKED), timeoutMs);
      pending.set(windowId, entry);
      const promise = new Promise<CloseAnswer>((resolve) => entry.resolvers.push(resolve));
      send({ requestId, sessions });
      return promise;
    },

    answer(requestId, answer) {
      for (const [windowId, entry] of pending) {
        if (entry.requestId === requestId) { settle(windowId, answer); return; }
      }
      // No matching pending entry — already settled by timeout or settleAll.
      // Ignored on purpose (design §4 step 5).
    },

    settleAll(cancelled) {
      // Snapshot first: settle() deletes from `pending` mid-loop otherwise.
      for (const [windowId, entry] of [...pending]) {
        cancelled(windowId, entry.requestId);
        settle(windowId, KEEP_TRACKED);
      }
    },
  };
}
