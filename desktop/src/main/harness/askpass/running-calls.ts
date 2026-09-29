// running-calls.ts — the registry verify.ts's ancestor walk (design §3 item
// 3) checks against: which root pids belong to a Bash call this session
// actually spawned, and which of those calls have already received a
// password (review 2 E5's "forget on last exit" Set).
//
// Task 5 wires registration in from `harness/tools/bash.ts` /
// `shell-registry.ts` on spawn/exit, and adds `registerPid` (reads the
// pid's start time itself, via the SAME koffi-backed ProcReader every other
// part of this feature uses, so a call site only ever needs a bare pid) and
// `recordSudoPath`/`verifiedSudoPath` (the forget step's `-K` target, design
// §5 — "the path from the verifier's genuine-sudo check, never PATH").
//
// Review fix T5-4: `hasGranted` (a bare "was this call EVER delivered a
// password") existed here to seed ShellRegistry's `admin` flag, but a
// delivery that turns out WRONG is still a delivery — seeding from it let
// the "Running as admin" strip show before sudo actually accepted anything.
// ShellRegistry now tracks acceptance itself (`acceptedToolCallIds`, fed by
// its own `markAdmin`); this class stays the granted-Set/`-K` bookkeeping
// only.
'use strict';

import type { ProcReader } from './proc-info';
import { createProcReader } from './proc-info';

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
  private readonly reader: ProcReader;
  /** design §5's `-K` target — the EXACT path verify.ts's genuine-sudo check
   *  validated for the most recent delivery, never a PATH lookup. Last
   *  writer wins: in practice there is exactly one genuine sudo binary on
   *  the machine, so every delivery agrees. */
  private verifiedSudoPathValue: string | undefined;

  constructor(reader: ProcReader = createProcReader()) {
    this.reader = reader;
  }

  /** Convenience for call sites (bash.ts, shell-registry.ts) that only have
   *  a bare pid, not yet its start time — reads it via the same reader every
   *  other part of this feature shares, and registers only when the read
   *  succeeds (a pid that already exited before this ran never becomes a
   *  garbage entry). */
  async registerPid(rootPid: number, meta: RunningCallMeta): Promise<void> {
    const startTime = await this.reader.startTime(rootPid);
    if (startTime === null) return;
    this.register(rootPid, startTime, meta);
  }

  /** Recorded by AdminPasswordService on every delivery (design §5). */
  recordSudoPath(sudoExePath: string): void {
    this.verifiedSudoPathValue = sudoExePath;
  }

  get verifiedSudoPath(): string | undefined {
    return this.verifiedSudoPathValue;
  }

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
