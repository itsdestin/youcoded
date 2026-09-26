// running-calls.ts — the registry verify.ts's ancestor walk (design §3 item
// 3) checks against: which root pids belong to a Bash call this session
// actually spawned, and which of those calls have already received a
// password (review 2 E5's "forget on last exit" Set).
//
// Self-contained here (task 3): registration from `harness/tools/bash.ts` /
// `shell-registry.ts` on spawn/exit is task 5's wiring. This module exposes
// the interface those call sites need and the interface verify.ts needs,
// with no import of either — so the two stay decoupled and this is testable
// on its own (design §11 task 3's "no wiring" scope).
'use strict';

export interface RunningCallMeta {
  sessionId: string;
  toolCallId: string;
  specialist?: string;
}

/** What `lookup()` hands back — the pid alone is never enough (a recycled
 *  pid must not match), so `startTime` rides along for verify.ts to compare
 *  against a FRESH read of the same pid (design §3 item 0, review 2 E7:
 *  "RunningCalls stores the root's start time, so a recycled root pid never
 *  matches"). */
export interface RunningCallEntry extends RunningCallMeta {
  rootPid: number;
  startTime: number;
}

/**
 * Process-wide: root pid (the `setsid` leader — `child.pid` of the whole
 * Bash call, foreground or background) → the call it belongs to, plus which
 * calls have received at least one password so `sudo -K` fires exactly once,
 * when the LAST one exits (review 2 E5 — a Set of toolCallIds, not a count,
 * because one call can authenticate more than once via distinct sudo parent
 * pids and a count would never return to zero after that).
 */
export class RunningCalls {
  private readonly byRootPid = new Map<number, RunningCallEntry>();
  private readonly grantedToolCallIds = new Set<string>();

  /** Registered on spawn (design §2.3) — foreground AND background, so a
   *  `run_in_background` call that later hands off still resolves. Re-
   *  registering the same rootPid (should not happen in practice; the pid
   *  is freed on exit before it could be reused for a new call) simply
   *  overwrites, which is the same "last write wins" semantics a Map already
   *  gives for free. */
  register(rootPid: number, startTime: number, meta: RunningCallMeta): void {
    this.byRootPid.set(rootPid, { rootPid, startTime, ...meta });
  }

  /** Removed on exit (design §2.3). Idempotent — unregistering a pid that
   *  was never registered, or already removed, is a no-op. */
  unregister(rootPid: number): void {
    this.byRootPid.delete(rootPid);
  }

  /** verify.ts's ancestor walk calls this once per candidate pid; returns
   *  undefined for anything not currently a registered call root (including
   *  a pid that WAS one until it exited). */
  lookup(rootPid: number): RunningCallEntry | undefined {
    return this.byRootPid.get(rootPid);
  }

  /** First delivery for `toolCallId` (idempotent — a call that
   *  authenticates twice, once per distinct sudo parent pid, is added only
   *  once). */
  markGranted(toolCallId: string): void {
    this.grantedToolCallIds.add(toolCallId);
  }

  /** Called on that call's exit. Returns true iff removing `toolCallId`
   *  transitioned the set from non-empty to empty — the caller's cue to run
   *  `<sudo> -K` (design §5). Returns false when `toolCallId` was never
   *  granted (nothing to remove) OR other granted calls remain outstanding. */
  release(toolCallId: string): boolean {
    if (!this.grantedToolCallIds.has(toolCallId)) return false;
    this.grantedToolCallIds.delete(toolCallId);
    return this.grantedToolCallIds.size === 0;
  }

  /** Test/diagnostic helper — not used by verify.ts. */
  grantedCount(): number {
    return this.grantedToolCallIds.size;
  }
}
