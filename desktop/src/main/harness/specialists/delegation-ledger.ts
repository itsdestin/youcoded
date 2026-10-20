// DelegationLedger — the durable, per-parent record of every specialist
// delegation (plan 1b Task 2). Plan 1a's foreground flow could get away with
// in-memory-only bookkeeping: the Task tool call blocks until the child
// reports, so the report never has to survive anything. A BACKGROUND
// specialist (plan 1b) keeps working after its Task call returns, so its
// eventual report needs somewhere durable that (a) survives an app restart
// and (b) every later consumer — background delivery, restart recovery, the
// per-turn status block, card replay (Tasks 4/5/6/7/9) — can read the same
// way. This is that somewhere: one sidecar JSON file per parent session,
// written EXCLUSIVELY through NativeHome.mutateJson (the one lock-guarded
// read-modify-write path — dev instance and built app can share one home dir,
// same cross-process risk every other ~/.youcoded/ JSON file has).
//
// A CLAIM IS A LEASE, NOT A DELIVERY (external review 2026-08-12). The
// earlier design had claimUndelivered() eagerly set delivered: true — but if
// the app died between that claim and the claimed report actually reaching
// the parent's conversation (the injected turn), the report was gone
// forever: on disk it already read as "delivered", so nothing would ever
// retry it. That is the exact failure mode this ledger exists to close.
// claimUndelivered() below only ever stamps claimedBy/claimedAt; delivered
// stays false until confirmDelivered() is called AFTER the injected turn has
// actually run. releaseClaim() clears the lease when a delivery attempt fails
// so the next pass can retry. isOwnerAlive() means a lease held by a dead
// process (the app crashed mid-delivery) does not block redelivery forever.
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { NativeHome } from '../../native-home';
import { log } from '../../logger';
// nativeStoreSlug (NOT ccProjectSlug): this ledger is an app-private sidecar
// under ~/.youcoded/sessions/<slug>/ — nothing CC created or reads it, so it
// takes the FROZEN native-store slug like every other file under sessions/,
// never the CC-mirroring one (slug-encoding.ts).
import { nativeStoreSlug } from '../../slug-encoding';
import { SPECIALIST_NOTE_MAX_CHARS } from './limits';
import type { SpecialistNote, SpecialistRunView } from '../../../shared/types';

export type OwnerStamp = { pid: number; instanceId: string };

export interface DelegationRecord {
  childId: string;
  parentToolCallId: string;
  agentType: string;
  title: string;
  workDir: string;
  description: string;
  background: boolean;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  startedAt: number;
  endedAt?: number;
  steps?: number;
  /** UNFORMATTED body, capped at RAW_REPORT_CAP_CHARS. The full body lives in
   *  the child's own JSONL transcript and, from Task 4, a reportPath spill
   *  file when it exceeds the cap. */
  rawReport?: string;
  /** Spill file — written at COMPLETION when the body exceeds the ledger cap
   *  (Task 4), or at delivery on budget truncation (Task 10). */
  reportPath?: string;
  /** status 'failed' — the real thrown message, never a guessed cause
   *  (error-message-standards.md). */
  failureText?: string;
  /** Flipped ONLY after the injected turn has actually run. See the module
   *  comment: a claim is a lease, not a delivery. */
  delivered: boolean;
  /** Durable "we are about to inject this into the parent's conversation"
   *  marker (fix pass 5) — stamped by markInjectionAttempted() strictly
   *  BEFORE runNotice() is called, never after. Exists because `claimedBy` +
   *  `delivered: false` alone can't tell apart a claim that never got as far
   *  as calling runNotice() (safe to retry) from one where runNotice()
   *  already ran and only the follow-up confirmDelivered write failed
   *  (retrying would show the same report twice). See claimUndelivered's own
   *  comment for how this gates reclaim, and markInjectionAttempted's for
   *  what happens when writing this marker itself fails. */
  injectionAttempted?: boolean;
  /** Delivery LEASE — present does not mean delivered, and does not even mean
   *  the leaseholder is still alive (see isOwnerAlive). */
  claimedBy?: OwnerStamp;
  claimedAt?: number;
  /** Exact delivery lease, distinct even across generations in one process. Legacy records omit it. */
  deliveryClaimId?: string;
  /** Receipt for a resume's atomic steer take; never authority to restore a whole old row. */
  missedSteerTakeId?: string;
  owner: OwnerStamp;
  missedSteers: string[];
  stale?: boolean;
  /** Mid-run steers sent to this hire, in order (plan 1c). Absent on a 1b
   *  record written before this field existed — every reader treats a
   *  missing array the same as an empty one, never a crash. */
  notes?: SpecialistNote[];
  /** Which model actually ran it, once resolved (plan 1c, tier fallback
   *  stated honestly). Referenced from SpecialistRunView's own field type
   *  (rather than a duplicated literal) so the two can never silently drift. */
  model?: SpecialistRunView['model'];
  /** D2 fix (2026-08-26, review Critical) — the content hash of the definition
   *  file this child was SPAWNED from, i.e. the one the user actually saw and
   *  consented to. Absent for a built-in (nothing on disk to change) and for a
   *  1b/1c record written before this field existed; both are treated as "no
   *  claim to check", never as a mismatch.
   *
   *  WHY it has to be recorded rather than re-derived: a `task_id` resume
   *  re-resolves the specialist from the LIVE roster and rebuilds the child
   *  from its current tools/charter. Without this, a helper approved as
   *  read-only could be edited to add Bash and then resumed straight into a
   *  write-capable run — in auto-edit with no card at all, because a task_id
   *  call carries no work_dir and so has no permission subject to match. */
  definitionFingerprint?: string;
}

// Full body cap for the copy that rides IN the ledger file. mutateJson is a
// read-modify-write of the ENTIRE file — every status-block read and restart
// pass loads and re-serializes the whole thing — so one chatty specialist's
// report must not be allowed to make that file (and every future read/rewrite
// of it) expensive. The full text always survives elsewhere: the child's own
// JSONL transcript, and (Task 4) a spill file at reportPath.
export const RAW_REPORT_CAP_CHARS = 64_000;

// ROADMAP L264. `missedSteers` was the one unbounded field left in this file.
// The 2,000-char note cap only clamps the RECORDED copy of a DELIVERED steer
// (native-session-host's steerFromUser path); a steer that arrives too late to
// deliver is parked here instead, at full length, in the same read-modify-write
// file RAW_REPORT_CAP_CHARS exists to keep cheap. A model steering a child that
// isn't live, in a loop, is the failure mode: every attempt appends, nothing
// drains, and every later status-block read re-parses the lot.
//
// Two bounds, because one steer being long and there being many steers are
// different problems: each entry is clamped to the same cap a delivered note
// gets, and the array keeps its most recent MISSED_STEERS_MAX_ENTRIES.
//
// WHY dropping the OLDEST is safe here: parked steers are drained and delivered
// on the child's next turn (takeMissedSteers), so in normal use this array
// holds one or two entries and never reaches the cap. Reaching 50 means nothing
// has drained across 50 attempts — the child is not coming back — so the
// entries being dropped were never going to be delivered either. The most
// recent ones are kept because they are the ones the user still means.
//
// Clamped ON WRITE only. Oversized records already on disk stay readable and
// are shortened the next time they are appended to, so no FILE_VERSION bump.
export const MISSED_STEERS_MAX_ENTRIES = 50;

/** Applies both `missedSteers` bounds. Called from INSIDE every mutate callback
 *  (never by a caller before it takes the lock) so the commutative-append
 *  guarantee documented on appendMissedSteers still holds. */
function boundMissedSteers(existing: string[], added: string[]): string[] {
  return [...existing, ...added.map((s) => s.slice(0, SPECIALIST_NOTE_MAX_CHARS))]
    .slice(-MISSED_STEERS_MAX_ENTRIES);
}

const FILE_VERSION = 1 as const;
interface LedgerFile { v: 1; delegations: DelegationRecord[] }
const EMPTY: LedgerFile = { v: FILE_VERSION, delegations: [] };

// Captured ONCE at module load — this process's identity for the lifetime of
// the run. `instanceId` (a random UUID, never persisted or derived from pid)
// is what lets isOwnerAlive recognize "this is literally the process asking"
// without a syscall; `pid` is the fallback for recognizing OTHER processes
// (see isOwnerAlive below for why pid alone isn't trustworthy in general).
export const OWNER: OwnerStamp = { pid: process.pid, instanceId: randomUUID() };

/**
 * Is the process that stamped `owner` still around?
 *
 * Same-instanceId is an exact match — no syscall needed, and it is always
 * correct because instanceId is a fresh random UUID per process (never reused
 * across a restart, unlike pid). Otherwise, a plain `process.kill(pid, 0)`
 * liveness probe (same precedent as sync-service.ts's isPidAlive, :441-454):
 * signal 0 sends nothing, it only checks whether the pid exists, and a throw
 * (ESRCH) means it doesn't.
 *
 * WHY no /proc/<pid>/stat start-time comparison (external review
 * 2026-08-12): that would close the one gap process.kill can't — pid REUSE,
 * where the OS hands a dead owner's old pid to a new, unrelated process
 * before we ever re-check. But /proc's field 22 is jiffies-since-boot, while
 * OwnerStamp carries no comparable field on purpose: converting between the
 * two is fiddly, platform-specific (no /proc on macOS/Windows), and prone to
 * either never firing or false-firing. The residual PID-reuse risk this
 * leaves is an ACCEPTED tradeoff: worst case is one stale `running` record
 * that lingers in the status block and stays interruptible via its task_id —
 * annoying, never lossy (a dead-but-undetected owner's lease is never
 * confused with a real delivery, so no report is ever silently dropped).
 */
export function isOwnerAlive(owner: OwnerStamp): boolean {
  if (owner.instanceId === OWNER.instanceId) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Plan 1c — fired after any ledger write that actually changed one or more
 *  records for a parent. `changed` is only the touched records, never the
 *  whole file, so a listener (Task 5's `specialists:event` push) can
 *  forward exactly what moved instead of re-diffing the file itself. */
export type LedgerChangeListener = (parentCwd: string, parentId: string, changed: DelegationRecord[]) => void;

export class DelegationLedger {
  // WHY: a failed rollback is still known not to have injected. Retain that proof
  // until a later successful locked write; never retry arbitrary attempted reports.
  private unstartedRollbacks = new Map<string, Map<string, { claimId: string | undefined; cancelled: boolean }>>();
  private rejectedSteerTakes = new Map<string, Map<string, { childId: string; steers: string[] }>>();
  // onChange is constructor-only, no setter (plan 1c) — the ONE place a
  // listener can be wired is at construction, so there is never a window
  // where a write happens with a listener silently unset partway through.
  constructor(private home: NativeHome, private onChange?: LedgerChangeListener) {}

  private relPath(parentCwd: string, parentId: string): string {
    return path.join('sessions', nativeStoreSlug(parentCwd), `${parentId}.delegations.json`);
  }

  /** Tolerate a missing/corrupt/wrong-shape file as "no delegations yet" —
   *  same contract as permission-store.ts — rather than throwing; a
   *  hand-edited or half-written sidecar heals on the next write. */
  private coerce(cur: unknown): LedgerFile {
    return cur && Array.isArray((cur as LedgerFile).delegations) ? (cur as LedgerFile) : EMPTY;
  }

  /** THE chokepoint (plan 1c). Every write funnels through here so the change
   *  listener sees each of them — enumerating methods in the host would go stale
   *  the day a twelfth is added. Changed = records whose object identity differs
   *  from before (the map callbacks return the same `d` for untouched records;
   *  recordStart appends) — a write that matches no record reports nothing.
   *  (A write that DOES match a record always reports it, even when the patch
   *  it applies happens to be content-identical to what was already there —
   *  the map callback still returns a new object for a matched record.) */
  private async mutate(parentCwd: string, parentId: string, fn: (data: LedgerFile) => LedgerFile): Promise<void> {
    let before: DelegationRecord[] = []; let after: DelegationRecord[] | undefined;
    const key = this.relPath(parentCwd, parentId);
    const pending = new Map(this.unstartedRollbacks.get(key));
    const rejectedTakes = new Map(this.rejectedSteerTakes.get(key));
    await this.home.mutateJson(key, (cur) => {
      let data = this.coerce(cur); before = data.delegations;
      if (pending.size) data = { ...data, delegations: data.delegations.map(record => {
        const rollback = pending.get(JSON.stringify([record.childId, record.deliveryClaimId]));
        if (!rollback || record.delivered || record.claimedBy?.instanceId !== OWNER.instanceId || record.deliveryClaimId !== rollback.claimId) return record;
        rollback.cancelled = true;
        return { ...record, injectionAttempted: undefined, claimedBy: undefined, claimedAt: undefined, deliveryClaimId: undefined };
      }) };
      if (rejectedTakes.size) data = { ...data, delegations: data.delegations.map(record => {
        const take = record.missedSteerTakeId ? rejectedTakes.get(record.missedSteerTakeId) : undefined;
        if (!take || take.childId !== record.childId) return record;
        // WHY packet-only rollback: preserve steers appended by another writer and
        // never overwrite its newer run with the stale pre-resume record.
        // Keep the existing newest-steers retention policy: repeated failed takes
        // must not grow the durable instruction list beyond its normal cap.
        return { ...record, missedSteers: boundMissedSteers(take.steers, record.missedSteers), missedSteerTakeId: undefined,
          ...(record.status === 'running' && record.owner.instanceId === OWNER.instanceId ? { status: 'interrupted' as const, endedAt: Date.now() } : {}) };
      }) };
      const next = fn(data); after = next.delegations; return next;
    });
    // A commit-then-throw keeps the intent; exact claim identity makes replay safe
    // if a different ledger acquired and injected a newer generation meanwhile.
    const current = this.unstartedRollbacks.get(key);
    for (const [childId, intent] of pending) if (current?.get(childId) === intent) current.delete(childId);
    if (current?.size === 0) this.unstartedRollbacks.delete(key);
    const takes = this.rejectedSteerTakes.get(key);
    for (const [token, take] of rejectedTakes) if (takes?.get(token) === take) takes.delete(token);
    if (takes?.size === 0) this.rejectedSteerTakes.delete(key);
    if (!after || !this.onChange) return;
    const changed = after.filter((d, i) => before[i] !== d);
    if (changed.length > 0) {
      // WHY: a disconnected subscriber is not a failed disk commit. Never make
      // callers repeat a destructive take or roll back already-durable state.
      try { this.onChange(parentCwd, parentId, changed); }
      catch (error) { log('WARN', 'DelegationLedger', 'ledger notification failed after successful write', { parentId, error: String(error) }); }
    }
  }

  async recordStart(parentCwd: string, parentId: string, rec: DelegationRecord): Promise<void> {
    await this.mutate(parentCwd, parentId, (data) => {
      return { v: FILE_VERSION, delegations: [...data.delegations, rec] };
    });
  }

  /**
   * `appendSteers` (fix pass 2 — external review: the split-write gap):
   * folded into the SAME mutateJson call as `patch`, not a second one. The
   * previous shape had runDelegation's completion/failure writers call
   * `update()`/`updateIfRunning()` for status, then AWAIT a separate
   * `appendMissedSteers()` call. Two independent lock acquisitions means two
   * independent failure points: if the first landed and the second then
   * threw, the record was durably 'completed'/'failed' while that run's own
   * drained steers were silently dropped — log-only, never retried. A single
   * mutateJson call makes both halves one atomic write rather than two
   * independent writes. Rejection can still follow a commit (for example,
   * lock cleanup fails), so callers must not infer unchanged disk from a throw.
   * Read `d.missedSteers` and append HERE,
   * inside the callback, for the same reason appendMissedSteers itself does
   * (see that method's own WHY) — so this still commutes with a concurrent
   * steerSpecialist miss-write racing the same record.
   */
  async update(parentCwd: string, parentId: string, childId: string, patch: Partial<DelegationRecord>, appendSteers: string[] = []): Promise<void> {
    // Cap rawReport HERE, not at recordStart — completion is the only place a
    // full report body ever arrives (recordStart runs before the child has
    // said anything). See RAW_REPORT_CAP_CHARS above for why the cap exists.
    const cappedPatch: Partial<DelegationRecord> =
      patch.rawReport !== undefined && patch.rawReport.length > RAW_REPORT_CAP_CHARS
        ? { ...patch, rawReport: patch.rawReport.slice(0, RAW_REPORT_CAP_CHARS) }
        : patch;
    await this.mutate(parentCwd, parentId, (data) => {
      return {
        v: FILE_VERSION,
        delegations: data.delegations.map((d) => {
          if (d.childId !== childId) return d;
          const merged = { ...d, ...cappedPatch };
          return appendSteers.length > 0 ? { ...merged, missedSteers: boundMissedSteers(d.missedSteers, appendSteers) } : merged;
        }),
      };
    });
  }

  listFor(parentCwd: string, parentId: string): DelegationRecord[] {
    return this.coerce(this.home.readJson(this.relPath(parentCwd, parentId))).delegations;
  }

  /**
   * Same as update(), but the patch is only applied while the record's
   * status is still 'running' — a conditional/compare-and-set write.
   *
   * WHY (review round 2, Finding 4): "interrupted" wins. When a parent is
   * torn down while a child is still running, two independent writers can
   * race the SAME record: destroyChildrenOf's fire-and-forget
   * `{ status: 'interrupted' }` and spawnSpecialist's catch-driven
   * `{ status: 'failed' }` (the child's abort error surfacing once the
   * interrupt propagates up through runSpecialist). Both writes are
   * individually true, but a parent teardown is the TRUE cause and the
   * child's abort error is only its SYMPTOM, so 'interrupted' must win
   * regardless of which write reaches disk last. Making ONLY the failure
   * write conditional (skip if the record is no longer 'running') while the
   * interrupted write stays a plain, unconditional update() gets that
   * outcome no matter the arrival order: if 'interrupted' lands first, this
   * write finds status !== 'running' and no-ops; if it lands second, it
   * unconditionally overwrites whatever the failure write left behind.
   *
   * `appendSteers` (fix pass 2 — same split-write fix as update() above,
   * applied to the failure path's compare-and-set write): folded into this
   * SAME mutateJson call rather than a second `appendMissedSteers()` await
   * after it, closing the identical lost-steer-on-second-write-throw gap.
   * Deliberately NOT gated behind the `status === 'running'` check the
   * `patch` half uses — a steer drained from the child's live queue in the
   * failure catch is real information worth keeping even when 'interrupted'
   * already won the status race and the patch itself no-ops (see
   * appendMissedSteers' own WHY for why there is no "X wins" arbitration for
   * this field the way there is for `status`).
   */
  async updateIfRunning(parentCwd: string, parentId: string, childId: string, patch: Partial<DelegationRecord>, appendSteers: string[] = []): Promise<void> {
    await this.mutate(parentCwd, parentId, (data) => {
      return {
        v: FILE_VERSION,
        delegations: data.delegations.map((d) => {
          if (d.childId !== childId) return d;
          const patched = d.status === 'running' ? { ...d, ...patch } : d;
          return appendSteers.length > 0 ? { ...patched, missedSteers: boundMissedSteers(d.missedSteers, appendSteers) } : patched;
        }),
      };
    });
  }

  /**
   * Append to `missedSteers` FROM INSIDE the lock-guarded read-modify-write,
   * rather than a caller computing `[...existing, ...new]` from a snapshot it
   * read before taking the lock (that was the bug — see below). Sibling to
   * updateIfRunning's compare-and-set for `status`: this record has multiple
   * independent writers that can race the SAME childId — steerSpecialist's
   * between-turn miss and runDelegation's end-of-run drain — and unlike
   * `status` there is no "X wins" arbitration for a plain array: every
   * writer's steer is real and none of them should ever silently vanish
   * because it lost a race. Reading `d.missedSteers` HERE, inside `mutate`,
   * is what makes two concurrent appends commute: whichever caller's
   * mutateFileUnderLock call wins the lock first, the other one's own read
   * (once it acquires the lock in turn) sees the first one's entry already on
   * disk and appends onto it — so the LAST writer only ever ADDS to the
   * record, never replaces it wholesale. A caller with nothing to add (e.g.
   * runDelegation's own drain came back empty) may still call this with `[]`
   * — a no-op merge, not a clobber, unlike passing `missedSteers: []` through
   * update()'s patch used to be.
   *
   * `note` (plan 1c): when a live steer can't be delivered and gets parked
   * here instead, its user-facing note lands in the SAME mutateJson call —
   * global house rule "one ledger write per related change" (see the module
   * comment on `update`'s appendSteers fold-in for the identical reasoning:
   * two independent writes means a throw between them can durably park the
   * steer while silently dropping the note the user saw, or vice versa).
   */
  async appendMissedSteers(parentCwd: string, parentId: string, childId: string, steers: string[], note?: SpecialistNote): Promise<void> {
    if (steers.length === 0) return;
    await this.mutate(parentCwd, parentId, (data) => {
      return {
        v: FILE_VERSION,
        delegations: data.delegations.map((d) => {
          if (d.childId !== childId) return d;
          const withSteers = { ...d, missedSteers: boundMissedSteers(d.missedSteers, steers) };
          return note ? { ...withSteers, notes: [...(d.notes ?? []), note] } : withSteers;
        }),
      };
    });
  }

  /** Live-delivered steer (plan 1c) — the child was reachable, so this is
   *  just a note append, never a parked steer. Sibling to
   *  appendMissedSteers' note branch, which is the SAME shape for the
   *  parked case (see that method's WHY for the one-write rule). */
  async appendNote(parentCwd: string, parentId: string, childId: string, note: SpecialistNote): Promise<void> {
    await this.mutate(parentCwd, parentId, (data) => {
      return {
        v: FILE_VERSION,
        delegations: data.delegations.map((d) => (d.childId === childId ? { ...d, notes: [...(d.notes ?? []), note] } : d)),
      };
    });
  }

  /**
   * Atomically read-and-clear `missedSteers`, returning exactly what was on
   * disk at the moment this call won the lock — the resume-time counterpart
   * to appendMissedSteers' commutative append. Also applies `patch` to the
   * SAME record, in the SAME mutateJson call.
   *
   * WHY (fix pass 2 — external review: the resume-clear race the reviewer
   * flagged but couldn't see in the diff). resumeSpecialist used to read
   * `record.missedSteers` from a snapshot `locateOwnChild` took OUTSIDE any
   * lock (well before wireChildLive makes the child live again), then MUCH
   * LATER fire a plain `update(..., { missedSteers: [] })` to clear it — two
   * independent operations with an unlocked gap in between. Anything
   * appended into that gap (e.g. a task_id steer call landing the instant
   * the resumed child goes live, before this clear-write lands) would be
   * silently wiped by the blind `[]` overwrite — the exact clobber shape the
   * appendMissedSteers fix closed for the completion-write race, just
   * between a different pair of writers, and this time the loss would be of
   * a steer the user just gave. Folding the read and the clear into ONE
   * mutateJson call removes the gap entirely: whatever is on disk when this
   * call wins the lock is exactly what gets returned AND cleared, so nothing
   * landing before or after this call can be dropped or (since it's cleared
   * here, not just read) replayed twice by a later resume.
   *
   * WHY `patch` (fix pass 3 — external review: the split-write gap survives
   * in the resume path too). resumeSpecialist used to call this take-and-
   * clear, THEN separately await a plain update() to flip status back to
   * 'running' — two mutateJson calls, two independent lock acquisitions. If
   * the take landed (steers cleared) and the status-flip write then threw,
   * the steers were gone from the ledger AND never delivered (the resumed
   * child was torn down before ever getting a turn to read them). Accepting
   * `patch` here and merging it into the SAME callback that reads and clears
   * `missedSteers` keeps them in one storage transaction; a rejected write can
   * still have committed before lock release failed. The exact take token below
   * lets a known-unstarted resume restore its packet without a stale-row overwrite.
   * The former claim that every rejection proves no commit was incorrect.
   * This is same-process recovery, not crash-proof cross-file acceptance.
   * Defaults to `{}` for callers that need no status patch.
   */
  async takeMissedSteers(parentCwd: string, parentId: string, childId: string, patch: Partial<DelegationRecord> = {}): Promise<string[]> {
    const token = randomUUID();
    let taken: string[] = [];
    try {
      await this.mutate(parentCwd, parentId, data => ({ ...data, delegations: data.delegations.map(record => {
        if (record.childId !== childId) return record;
        taken = [...record.missedSteers];
        return { ...record, ...patch, missedSteers: [], missedSteerTakeId: token };
      }) }));
      return taken;
    } catch (error) {
      // WHY: runDelegation has not begun when this rejects, so only this exact
      // packet is safe to restore. Retain intent if storage is still unavailable.
      const key = this.relPath(parentCwd, parentId);
      const pending = this.rejectedSteerTakes.get(key) ?? new Map();
      pending.set(token, { childId, steers: taken });
      this.rejectedSteerTakes.set(key, pending);
      try { await this.mutate(parentCwd, parentId, data => data); }
      catch (rollbackError) { log('WARN', 'DelegationLedger', 'resume steer rollback pending for a later write', { parentId, childId, error: String(rollbackError) }); }
      throw error;
    }
  }

  /**
   * Same shape as updateIfRunning(), but the opposite guard: skip the patch
   * ONLY when the record is already 'completed' — apply it against every
   * other status ('running', 'failed', 'interrupted'). For the two teardown
   * call sites that write `{ status: 'interrupted' }` fire-and-forget
   * (destroyChildrenOf, interruptSpecialist), NOT for update() itself, which
   * stays unconditional (the "interrupted wins" tests above call update()
   * directly and must keep passing unchanged).
   *
   * WHY (Critical 3, final review): runDelegation writes 'completed' and only
   * de-registers the child a few microtasks later. A parent
   * destroy()/quiesce() (takeover, session close, app quit) can fire its
   * teardown write in that gap, landing AFTER the completion write. A
   * 'completed' record is a real, already-reported outcome — its report sits
   * in rawReport/reportPath waiting for claimUndelivered, which only ever
   * looks at 'completed'/'failed', never 'interrupted'. Clobbering it to
   * 'interrupted' strands that report permanently, including across a
   * restart (nothing ever re-derives 'completed' from 'interrupted').
   *
   * WHY NOT also guard 'failed': the "interrupted wins" rule (see the
   * updateIfRunning describe block above) is deliberate — an abort-driven
   * 'failed' write racing the SAME teardown is only ever a SYMPTOM of that
   * teardown, and 'interrupted' must still win over it regardless of arrival
   * order. Guarding 'failed' here too would flip that outcome for exactly the
   * ordering the existing pinned test ("failure-first ordering… interrupted
   * still wins") covers. Only 'completed' — a genuinely different, already-
   * finished outcome unrelated to the interrupt — needs protecting.
   */
  async updateUnlessCompleted(parentCwd: string, parentId: string, childId: string, patch: Partial<DelegationRecord>): Promise<void> {
    await this.mutate(parentCwd, parentId, (data) => {
      return {
        v: FILE_VERSION,
        delegations: data.delegations.map((d) => (d.childId === childId && d.status !== 'completed' ? { ...d, ...patch } : d)),
      };
    });
  }

  async claimUndelivered(parentCwd: string, parentId: string): Promise<DelegationRecord | null> {
    let claimed: DelegationRecord | null = null;
    await this.mutate(parentCwd, parentId, (data) => {
      // Eligible: completed OR failed (Task 4 — a background run that dies
      // still owes the parent a typed failure notice, not silence; this
      // filter originally covered 'completed' only, written before the
      // background failure-delivery path existed), not yet delivered,
      // injection never durably ATTEMPTED (fix pass 5 — see below), and the
      // lease doesn't belong to someone else who's still around to finish
      // using it. Three ways a lease clears that LAST bar:
      //   1. never claimed (`!d.claimedBy`)
      //   2. claimed by a DEAD owner — a crash between claim and the
      //      injected turn reaching the parent (module comment: a claim is a
      //      LEASE, not a delivery, so a dead owner's claim must not block
      //      redelivery forever)
      //   3. claimed by THIS EXACT process instance (fix pass 4, Finding 3)
      //      — claimUndelivered's own write can commit to disk and then
      //      still have the call that made it throw (e.g. mutateJson's lock
      //      release failing in its own `finally`, after atomicWrite already
      //      landed). The caller never learns which childId got the lease,
      //      so it can't release() it either — the record is stuck bearing
      //      OUR OWN owner stamp, which isOwnerAlive always reports as alive
      //      (case 2 above can never fire for it). Only one delivery pass
      //      per parent runs at a time (native-session-host.ts's
      //      pendingDeliveryParents/entry.inFlight machinery), so if a LATER
      //      pass sees a lease stamped by this same process, that can only
      //      mean an EARLIER pass's claim outlived its own caller's ability
      //      to act on it — reclaiming it here is what turns that stuck
      //      state back into a normal delivery attempt instead of a report
      //      stranded forever behind a lease its own owner can't release. A
      //      lease held by a DIFFERENT live owner (case 2 does not apply,
      //      case 3 does not apply) keeps its current meaning: not eligible.
      //
      // `!d.injectionAttempted` (fix pass 5) gates ALL THREE of the branches
      // above, not just case 3. The three-case list explains when a LEASE is
      // safe to reclaim; it says nothing about whether the report was ever
      // actually SHOWN, and two disk states that look identical (some
      // claimedBy or none, delivered: false) mean opposite things:
      //   (a) the claim landed but runNotice() was never called — safe to
      //       retry, exactly what cases 1-3 above are for.
      //   (b) runNotice() already ran (the report is already in the parent's
      //       conversation) and only the FOLLOW-UP write — confirmDelivered,
      //       or the releaseClaim a failed confirmDelivered falls back to —
      //       never committed. Reclaiming here means calling runNotice() a
      //       SECOND time: the model and the user see the same report twice.
      // Before this fix, case 3 turned every (b) into a guaranteed retry, and
      // case 1 already could too whenever the catch-driven releaseClaim
      // after a failed confirmDelivered happened to succeed (that gap
      // predates fix pass 4 and was never covered by a test). injectionAttempted,
      // stamped by markInjectionAttempted() strictly BEFORE runNotice() is
      // ever called, is what tells (a) and (b) apart on disk: once it's
      // true, none of the three lease branches fire again for this record,
      // no matter what claimedBy or delivered read afterward — see
      // markInjectionAttempted's own comment for the one ambiguity this
      // can't close (its own write failing).
      // WHY `d.background` (external review 2026-08-13, the foreground
      // re-delivery finding): a FOREGROUND delegation's outcome — success OR
      // failure — is already delivered the instant the Task tool call
      // returns (spawnSpecialist's return value / thrown error IS the tool
      // result, tools/task.ts). Its ledger row still ends up 'completed' or
      // 'failed' + delivered:false forever, because confirmDelivered is only
      // called on the SUCCESS branch (spawnSpecialist) — a foreground FAILURE
      // never confirms delivery, since the failure already went back to the
      // model inline and there is no follow-up write to make. Without this
      // gate, that permanently-undelivered-looking row is eligible here
      // exactly like a real background one: reopening the conversation (or
      // any later delivery pass) claims it and formatDelivery's failed branch
      // injects "[Background specialist failed] ..." — a second delivery of
      // an outcome the model already saw, mislabeled "Background" when it
      // ran in the foreground. This is the ONE eligibility check every lane
      // (reconcileDelegations' restart queue, the live idle-boundary drain
      // loop) bottoms out in, so gating it HERE — rather than in each caller
      // — is what a future caller can't route around.
      const eligible = data.delegations.filter(
        (d) => d.background && (d.status === 'completed' || d.status === 'failed') && !d.delivered && !d.injectionAttempted &&
          (!d.claimedBy || d.claimedBy.instanceId === OWNER.instanceId || !isOwnerAlive(d.claimedBy))
      );
      if (eligible.length === 0) return data;
      const target = eligible.reduce((oldest, d) => (d.startedAt < oldest.startedAt ? d : oldest));
      // delivered stays FALSE — this stamps the LEASE only. Only
      // confirmDelivered (after the report is ACTUALLY injected into the
      // parent's conversation) may flip delivered to true.
      claimed = { ...target, claimedBy: OWNER, claimedAt: Date.now(), deliveryClaimId: randomUUID() };
      return {
        v: FILE_VERSION,
        delegations: data.delegations.map((d) => (d.childId === target.childId ? claimed! : d)),
      };
    });
    return claimed;
  }

  /** Stamp the durable "injection attempted" marker (fix pass 5). Callers
   *  (native-session-host.ts's delivery loop) MUST call this strictly BEFORE
   *  runNotice() — see the field's own comment on DelegationRecord and
   *  claimUndelivered's for why the ordering matters. A plain, unconditional
   *  update() like confirmDelivered/releaseClaim below.
   *
   *  WHAT HAPPENS IF THIS WRITE ITSELF THROWS: the caller cannot learn
   *  afterward whether it committed — the same commit-then-throw-on-lock-
   *  release shape fix pass 4 documented for claimUndelivered. The chosen
   *  behavior (implemented in native-session-host.ts, not here) is to log
   *  and proceed with runNotice() anyway, never to abandon the delivery
   *  attempt on this failure alone: this machinery's standing preference is
   *  that a silently LOST report is worse than a duplicated one, and per fix
   *  pass 4's own finding, a mutateJson throw here usually still means the
   *  write landed. The honest residual: in the narrower case where it truly
   *  didn't land AND the confirmDelivered write afterward also fails, a
   *  later claimUndelivered pass sees injectionAttempted still false,
   *  correctly looks like case (a), and retries a report that was actually
   *  already shown — one duplicate. This is real, not hypothetical, and is
   *  documented rather than silently accepted; it is markedly narrower than
   *  the exposure before this fix, where EVERY confirmDelivered failure
   *  risked a duplicate, not just this one compounding failure. */
  async markInjectionAttempted(parentCwd: string, parentId: string, childId: string): Promise<void> {
    await this.update(parentCwd, parentId, childId, { injectionAttempted: true });
  }

  async confirmDelivered(parentCwd: string, parentId: string, childId: string): Promise<void> {
    // The injected turn has ACTUALLY run at this point — only now is it safe
    // to say the report was delivered.
    await this.update(parentCwd, parentId, childId, { delivered: true });
  }

  /** Call ONLY before runNotice/spliceNotice: no model/history injection may have begun. */
  async cancelUnstartedInjection(parentCwd: string, parentId: string, childId: string, claimId?: string): Promise<boolean> {
    const key = this.relPath(parentCwd, parentId);
    const pending = this.unstartedRollbacks.get(key) ?? new Map();
    const intent = { claimId, cancelled: false };
    pending.set(JSON.stringify([childId, claimId]), intent);
    this.unstartedRollbacks.set(key, pending);
    await this.mutate(parentCwd, parentId, data => data);
    return intent.cancelled;
  }

  /** Cleanup uses a snapshot only as a comparison token, never as write authority. */
  async reconcileOwner(parentCwd: string, parentId: string, snapshot: DelegationRecord): Promise<void> {
    await this.mutate(parentCwd, parentId, data => ({ ...data, delegations: data.delegations.map(record => {
      if (record.childId !== snapshot.childId) return record;
      let next = record;
      // WHY: another process may have resumed/reclaimed between the read and this lock.
      if (snapshot.status === 'running' && record.status === 'running' && record.owner.instanceId === snapshot.owner.instanceId
        && record.startedAt === snapshot.startedAt && !isOwnerAlive(record.owner)) next = { ...next, status: 'interrupted', endedAt: Date.now() };
      if (snapshot.claimedBy && record.claimedBy?.instanceId === snapshot.claimedBy.instanceId
        && record.deliveryClaimId === snapshot.deliveryClaimId && !isOwnerAlive(record.claimedBy)) {
        next = { ...next, claimedBy: undefined, claimedAt: undefined, deliveryClaimId: undefined };
      }
      return next;
    }) }));
  }

  async releaseClaim(parentCwd: string, parentId: string, childId: string, expectedClaimId?: string): Promise<void> {
    // Delivery attempt failed (or was abandoned) after claiming — clear the
    // lease so a later pass can claim it again. Explicit undefined (rather
    // than omitting the keys) so the patch actually overwrites whatever lease
    // is on disk; JSON.stringify drops undefined-valued keys on write, so the
    // record reads back exactly like "never claimed".
    // WHY: an outgoing pass may finish after a replacement acquired a new claim.
    await this.mutate(parentCwd, parentId, data => ({ ...data, delegations: data.delegations.map(record =>
      record.childId !== childId || (expectedClaimId !== undefined && record.deliveryClaimId !== expectedClaimId) ? record
        : { ...record, claimedBy: undefined, claimedAt: undefined, deliveryClaimId: undefined }) }));
  }
}

/** The renderer's view of one record: the record MINUS delivery bookkeeping
 *  (delivered, injectionAttempted, claimedBy, claimedAt, owner, missedSteers,
 *  rawReport, reportPath) — those are the host's business, never the card's.
 *  Fields are picked explicitly rather than spread-then-delete so the
 *  omitted set is visible right here in the code, not hidden behind a
 *  runtime `delete`. */
/**
 * ROADMAP L259's monotonic stamp. A single module-level counter rather than a
 * Map keyed by childId: ordering only ever has to be comparable WITHIN one
 * record (the reducer compares an incoming view against the same card's
 * current one), and a globally increasing number is trivially monotonic
 * within every record — while a per-child Map would be a second unbounded
 * structure to evict from, for no extra guarantee.
 *
 * NOT `Date.now()`: two projections inside one millisecond tie, and a tie
 * reads as "not newer", which would drop a real update. Not persisted either
 * — it resets to 0 on restart, which is correct, because the renderer's cards
 * are rebuilt from replay at the same moment.
 */
let runViewSeq = 0;

export function toRunView(rec: DelegationRecord): SpecialistRunView {
  return {
    seq: ++runViewSeq,
    childId: rec.childId,
    parentToolCallId: rec.parentToolCallId,
    agentType: rec.agentType,
    title: rec.title,
    description: rec.description,
    background: rec.background,
    status: rec.status,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    steps: rec.steps,
    stale: rec.stale,
    model: rec.model,
    notes: rec.notes,
  };
}
