// The in-app quit warning's request/answer state machine (design
// docs/active/specs/2026-09-24-welcome-back-design.md §4, plan T3).
//
// WHY its own module, injected id generator, exactly like welcome-back-store.ts's
// injected fs: main.ts's window 'close' handler lives inside createAppWindow(),
// closed over a real BrowserWindow/webContents that vitest cannot construct.
// This module touches neither — it only tracks pending requests per window and
// calls the `send` effect the caller hands it — so the state machine (reuse,
// settle, late-answer-ignored) can be driven directly in tests.
//
// No timeout: the window waits for the person's answer for as long as they
// take. A 5 s "frozen app" fallback used to close the window on someone still
// reading the prompt; Destin had it removed (2026-09-24, "just remove the
// timer"). A quit from the menu or the OS still settles a pending prompt
// through settleAll().
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
  /** Mints a requestId. A real caller wants something unguessable
   *  (`randomUUID`); a test wants something deterministic. */
  genId: () => string;
}

interface PendingRequest {
  requestId: string;
  resolvers: Array<(answer: CloseAnswer) => void>;
}

/** A whole-app-quit settle: keep every owned session tracked (no untrack) and
 *  let the caller's destroy+close loop run — the same fate a crash leaves a
 *  session in. */
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
   *  settled by settleAll() — a late answer changes nothing
   *  (design §4 step 5). */
  answer(requestId: string, answer: CloseAnswer): void;
  /**
   * windowId's screen reloaded or crashed while its prompt was open, so the
   * prompt is gone and no answer will ever come. Settle it as Cancel (the
   * window stays open) so the NEXT X press sends a fresh prompt — without
   * this, every later press reused the dead request and the window could
   * never be closed with its X. A no-op when nothing is pending.
   */
  dropFor(windowId: number): void;
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

export interface CloseAnswerEffects {
  untrack: (sessionId: string) => void;
  destroySession: (sessionId: string) => void;
  releaseSession: (sessionId: string) => void;
}

/**
 * Applies a settled close-request answer against the sessions the window
 * CURRENTLY owns (design §4 step 3) — `currentlyOwned` must be a fresh read
 * taken AFTER `request()` resolves, never the snapshot passed to `request()`
 * itself. WHY: the in-app prompt does not block the strip the way the old
 * modal `dialog.showMessageBox` did, so while a prompt is awaiting an answer
 * a session can be dragged into another window, or closed with its own X —
 * destroying/untracking by a STALE list would kill or mistrack a session
 * that no longer belongs to this window by the time the answer lands (main.ts
 * close-handler review finding, T3). An empty `currentlyOwned` (everything
 * left during the prompt) is naturally a no-op loop — the window still
 * closes, nothing is destroyed twice.
 *
 * Returns whether the caller should now close the window (false only for an
 * explicit Cancel — `answer.close === false`).
 */
export function applyCloseAnswer(
  answer: { close: boolean; reopen?: boolean },
  currentlyOwned: readonly string[],
  effects: CloseAnswerEffects,
): boolean {
  if (!answer.close) return false;
  // `reopen` false (the switch was left off) means Destin said "don't bring
  // these back" — untrack so Welcome back never offers them (design §4 step
  // 3). A whole-app-quit settle resolves reopen:true (design
  // §4 step 5): keep tracked, exactly like a crash.
  if (!answer.reopen) {
    for (const sid of currentlyOwned) effects.untrack(sid);
  }
  for (const sid of currentlyOwned) {
    effects.destroySession(sid);
    effects.releaseSession(sid);
  }
  return true;
}

export function createCloseRequestManager(deps: CloseRequestManagerDeps): CloseRequestManager {
  const pending = new Map<number, PendingRequest>();

  function settle(windowId: number, answer: CloseAnswer): void {
    const entry = pending.get(windowId);
    if (!entry) return; // already settled
    pending.delete(windowId);
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
      const entry: PendingRequest = { requestId, resolvers: [] };
      pending.set(windowId, entry);
      const promise = new Promise<CloseAnswer>((resolve) => entry.resolvers.push(resolve));
      send({ requestId, sessions });
      return promise;
    },

    answer(requestId, answer) {
      for (const [windowId, entry] of pending) {
        if (entry.requestId === requestId) { settle(windowId, answer); return; }
      }
      // No matching pending entry — already settled by settleAll.
      // Ignored on purpose (design §4 step 5).
    },

    dropFor(windowId) {
      settle(windowId, { close: false });
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
