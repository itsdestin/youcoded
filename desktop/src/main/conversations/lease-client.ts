// Lease client (Plan 2b, Task 6). Owns the per-held-session heartbeat renew
// timers, the acquire/release/query/takeover operations, and a best-effort
// lease-FILE fallback so a device can still answer "who holds this session?"
// while the SyncHub is transiently disconnected.
//
// Design notes (why this shape):
//   - The HUB is the source of truth. The lease file at
//     Personal/Leases/<sessionId>.json is a best-effort mirror consulted ONLY
//     when the hub returns null (down). It uses the same 300s stale rule via the
//     LOCAL clock — good enough because a wrong file answer just means one extra
//     query round-trip, never data loss.
//   - NEVER block the caller and NEVER throw from a fire-and-forget path. A hub
//     request that returns null (disconnected) is treated as an optimistic local
//     hold rather than a failure — sync must degrade gracefully, never wedge.
//   - Every timer is unref()'d so a lingering renew timer can't keep the Electron
//     main process alive on quit; all fs ops are try/caught (best-effort).
// WHY default import (review round 1): a namespace import (`import * as fs`)
// produces properties vitest's `vi.spyOn` cannot intercept from an outside
// test file spying on the mutable default-exported `fs` object — proven by
// swapping a write to `fs.writeFileSync` here and watching the test-file spy
// on `fs.writeFileSync` fail to see it. `conversation-store.ts` (spied on
// successfully by its own test) already uses this same default-import form.
import fs from 'fs';
import * as path from 'path';
import type { LeaseResult } from '../sync-hub-socket';

// Match the worker's contract: 300s lease expiry, 30s heartbeat.
const LEASE_TTL_MS = 300_000;
const RENEW_MS = 30_000;

export interface LeaseClientOpts {
  deviceId: string;
  deviceName: string;
  // Returns the DIRECTORY that holds lease files, or null when it can't be
  // resolved (=> skip all file ops).
  //
  // This MUST resolve outside any sync space. It used to be
  // `<personalRoot>/Leases`, which meant every 30s renew was a file change the
  // sync watcher committed to git: 93% of all file-changes in the real Personal
  // repo were lease renews, 30k commits / 673 MB, and the resulting bloat pushed
  // catch-up syncs past GIT_TIMEOUT so a device that fell behind could never
  // recover (2026-07-30). Ephemeral heartbeat state does not belong in a
  // permanent versioned store — the hub is the source of truth for leases.
  leaseDir: () => string | null;
  // Injected transport (the SyncHub socket's request()). Resolves a LeaseResult,
  // or null when the hub is disconnected / timed out — never rejects.
  hubRequest: (op: string, sessionId: string, deviceId: string) => Promise<LeaseResult | null>;
  // Upward callback the caller (Task 8 service) supplies to trigger holder-side
  // teardown (interrupt -> mirror -> release -> destroy). `from` is OPTIONAL — a
  // deliberate deviation from the plan's non-optional shape: renew-failure
  // teardowns attribute the takeover from the reply's holder when the hub
  // reports one, but a race where the holder is unknown still has no `from`.
  onTakeoverRequest: (sessionId: string, from?: { deviceId: string; device: string }) => void;
}

export interface LeaseQueryResult {
  held: boolean;
  device?: string;
  // The per-install device id of the holder (NOT the label). `self` is derived
  // from it — a caller MUST NOT infer self-identity from `device` (the hostname
  // label), which collides when two installs share a hostname (the dev instance
  // + built app, or two same-hostname machines). deviceId is unique per install.
  deviceId?: string;
  // True when the holder is THIS install (holder deviceId === our deviceId). This
  // is the correct "is it me?" signal — see deviceId above for why the label isn't.
  self?: boolean;
  expiresAt?: number;
  source: 'hub' | 'file' | 'none';
}

export interface LeaseClient {
  acquire(sessionId: string): Promise<LeaseResult | null>;
  release(sessionId: string): Promise<void>;
  query(sessionId: string): Promise<LeaseQueryResult>;
  takeover(sessionId: string): Promise<LeaseResult | null>;
  // Inbound: the service calls this when the hub delivers a takeover-request
  // lease-event. Filtered HERE because the client is the only thing that knows
  // which sessions THIS device holds.
  handleTakeoverRequest(sessionId: string, from?: { deviceId: string; device: string }): void;
  isHeld(sessionId: string): boolean;
  destroy(): void;
}

interface LeaseFileContent { deviceId: string; device: string; expiresAt: number }

/** Parse a lease file, or null when it is missing/malformed/not a lease. */
function tryParseLease(file: string): LeaseFileContent | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed.expiresAt === 'number' && Number.isFinite(parsed.expiresAt)) {
      return { deviceId: String(parsed.deviceId ?? ''), device: String(parsed.device ?? ''), expiresAt: parsed.expiresAt };
    }
  } catch { /* missing / malformed */ }
  return null;
}

/** Delete expired (and unparseable) lease files from the ACTIVE lease dir.
 *  Returns how many were removed.
 *
 *  WHY: nothing else ever deleted these. deleteLeaseFile only runs on a clean
 *  release, so every crash, force-quit or killed session leaked a file forever —
 *  59 of 60 lease files on the machine that surfaced this bug were long expired.
 *  An unparseable file is removed too: readLeaseFile treats it as "no lease", so
 *  it can never expire out on its own.
 *
 *  Only touches `*.json` REGULAR files (dirent.isFile() does not follow symlinks)
 *  and never recurses — same discipline as sweepProjectSymlinks. */
export function sweepExpiredLeases(dir: string): number {
  let removed = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return 0; } // dir absent — nothing to sweep
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const file = path.join(dir, e.name);
    const lease = tryParseLease(file);
    if (lease && lease.expiresAt > Date.now()) continue; // still live
    try { fs.rmSync(file, { force: true }); removed++; } catch { /* best-effort */ }
  }
  return removed;
}

/** One-time migration: empty the LEGACY in-space lease dir (`<personalRoot>/Leases`).
 *  Returns how many lease files were removed.
 *
 *  WHY: before 2026-07-30 leases were written inside the personal sync space, so
 *  the pre-existing files are tracked in that space's git repo. Removing them
 *  produces ONE final delete-commit and then permanent silence — whereas leaving
 *  them tracked means `git add -A` keeps re-staging them (exclude rules only
 *  silence UNTRACKED files).
 *
 *  Deletes regardless of expiry: a still-live lease is re-written to the new
 *  userData location within one renew (30s), so nothing is actually lost.
 *
 *  Deliberately conservative — this runs inside the user's own synced folder, so
 *  it removes ONLY regular `*.json` files that positively parse as leases, never
 *  recurses into subdirectories, and drops the directory itself only once it is
 *  completely empty. */
export function sweepLegacyLeaseDir(personalRoot: string): number {
  const dir = path.join(personalRoot, 'Leases');
  let removed = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return 0; } // never existed (fresh install) — nothing to migrate
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const file = path.join(dir, e.name);
    if (!tryParseLease(file)) continue; // not ours — leave the user's file alone
    try { fs.rmSync(file, { force: true }); removed++; } catch { /* best-effort */ }
  }
  // Only remove the dir when nothing at all survived; rmdirSync fails loudly on a
  // non-empty dir, which is exactly the guard we want (never a recursive delete).
  try { fs.rmdirSync(dir); } catch { /* something survived — correct to keep it */ }
  return removed;
}

export function createLeaseClient(opts: LeaseClientOpts): LeaseClient {
  // sessionId -> renew timer. Membership IS "this device holds the lease".
  const held = new Map<string, NodeJS.Timeout>();
  // sessionId -> monotonically-increasing generation. Bumped on every acquire /
  // fresh renew loop. A renew tick captures the gen it was scheduled under and
  // bails if the current gen has moved on — this is what makes a re-acquire
  // genuinely idempotent even if a PRIOR tick for the same session is still
  // awaiting hubRequest (its resumed schedule() would otherwise leak a second
  // heartbeat loop, double-renewing).
  const gen = new Map<string, number>();

  // ---- lease-file helpers (all best-effort, all try/caught, all OFF the event loop) ----
  //
  // WHY async: on 2026-09-08 the whole app froze for 6+ minutes right after a
  // `[lease] acquire` log line. writeLeaseFile used fs.mkdirSync/writeFileSync —
  // the only blocking calls in a module whose contract is "never block". A disk
  // stall inside a blocking write halts every timer and every IPC handler in the
  // main process at once. fs.promises moves the wait onto libuv's threadpool.
  //
  // WHY a per-session chain: sync calls were implicitly ordered. Now
  // acquire()'s write and release()'s delete could race, and a delete that
  // finishes before the write would resurrect the lease file. Each session's
  // file ops run strictly one after another.
  const fileChain = new Map<string, Promise<void>>();
  function enqueueFileOp(sessionId: string, op: () => Promise<void>): Promise<void> {
    const prev = fileChain.get(sessionId) ?? Promise.resolve();
    const next = prev.then(op, op).catch(() => { /* best-effort */ });
    fileChain.set(sessionId, next);
    // Drop the entry once this op is the last one, so the map cannot grow forever.
    void next.finally(() => { if (fileChain.get(sessionId) === next) fileChain.delete(sessionId); });
    return next;
  }

  function leaseFile(sessionId: string): string | null {
    const dir = opts.leaseDir();
    if (!dir) return null; // dir unavailable — hub is the primary path anyway
    return path.join(dir, `${sessionId}.json`);
  }

  // The raw write, no queue position of its own — callers place it in the chain
  // (writeLeaseFile below, or a reserved slot — see reserveFileSlot's WHY).
  async function writeLeaseFileBody(sessionId: string, expiresAt: number): Promise<void> {
    const file = leaseFile(sessionId);
    if (!file) return;
    const body: LeaseFileContent = { deviceId: opts.deviceId, device: opts.deviceName, expiresAt };
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, JSON.stringify(body));
  }

  function writeLeaseFile(sessionId: string, expiresAt: number): Promise<void> {
    if (!leaseFile(sessionId)) return Promise.resolve();
    return enqueueFileOp(sessionId, () => writeLeaseFileBody(sessionId, expiresAt));
  }

  // INVARIANT: a session's queue position is claimed at CALL time, before any
  // await — never at "value known" time. enqueueFileOp orders ops by when they
  // are ENQUEUED, and acquire() can't know whether/what to write until the hub
  // round-trip resolves, so a naive `writeLeaseFile(...)` call placed after
  // that await would enqueue LATE. A release() fired in the same tick with no
  // await between calls deleteLeaseFile synchronously, before any await, so
  // its delete would otherwise win the queue position and run BEFORE the write
  // it was logically supposed to follow — the file would end up WRITTEN, not
  // gone. Reserving a slot synchronously, before the hub call, makes queue
  // order match call order regardless of how long the hub takes to answer.
  function reserveFileSlot(sessionId: string): { settle: (op: (() => Promise<void>) | null) => void; done: Promise<void> } {
    let settle!: (op: (() => Promise<void>) | null) => void;
    const opPromise = new Promise<(() => Promise<void>) | null>((resolve) => { settle = resolve; });
    const done = enqueueFileOp(sessionId, async () => {
      const op = await opPromise;
      if (op) await op();
    });
    return { settle, done };
  }

  function deleteLeaseFile(sessionId: string): Promise<void> {
    const file = leaseFile(sessionId);
    if (!file) return Promise.resolve();
    return enqueueFileOp(sessionId, () => fs.promises.rm(file, { force: true }));
  }

  async function readLeaseFile(sessionId: string): Promise<LeaseFileContent | null> {
    const file = leaseFile(sessionId);
    if (!file) return null;
    try {
      const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      if (parsed && typeof parsed.expiresAt === 'number' && Number.isFinite(parsed.expiresAt)) {
        return { deviceId: String(parsed.deviceId ?? ''), device: String(parsed.device ?? ''), expiresAt: parsed.expiresAt };
      }
      return null;
    } catch { return null; } // missing / malformed -> treat as no lease
  }

  // ---- renew timer ----

  // Clears the renew TIMER only — it does NOT remove `held`/`gen` membership.
  // Callers must pair it with `held.delete(sessionId)` (and let the gen bump on
  // the next acquire) to fully release the session.
  function stopTimer(sessionId: string): void {
    const t = held.get(sessionId);
    if (t) clearTimeout(t);
  }

  function startRenewTimer(sessionId: string): void {
    // Bump the generation so any in-flight tick from a prior loop becomes a
    // no-op when it resumes. `myGen` is captured by this loop's schedule/tick.
    const myGen = (gen.get(sessionId) ?? 0) + 1;
    gen.set(sessionId, myGen);

    // Self-rescheduling setTimeout (not setInterval) so an async renew that runs
    // long can't stack overlapping renews. Each tick reschedules itself.
    const schedule = () => {
      const timer = setTimeout(() => { void renewTick(sessionId); }, RENEW_MS);
      timer.unref?.(); // don't keep the Electron main process alive just for a renew
      held.set(sessionId, timer);
    };

    async function renewTick(sessionId: string): Promise<void> {
      // The whole body is wrapped so an unexpected throw in a timer callback can
      // never become a fatal unhandled rejection in Electron main.
      try {
        // Stale-generation guard: a re-acquire (or fresh renew loop) since this
        // tick was scheduled means we're an orphaned loop — bail silently so we
        // never leak a second heartbeat that double-renews.
        if (gen.get(sessionId) !== myGen) return;
        if (!held.has(sessionId)) return; // released/destroyed between scheduling and firing
        const r = await opts.hubRequest('renew', sessionId, opts.deviceId);
        if (gen.get(sessionId) !== myGen) return; // superseded while the renew was in flight
        if (!held.has(sessionId)) return; // released while the renew was in flight

        if (r && !r.ok) {
          // A failed renew has TWO distinct causes and only one is a takeover:
          //   holder present (≠ us) → another device force-acquired it (spec §3
          //     step 5). Tear down and attribute the takeover to that device.
          //   holder null → the lease lazily EXPIRED server-side because our
          //     heartbeat was suspended past the 300s TTL (system sleep, screen
          //     lock, OS throttling an idle process) and NOBODY has taken it.
          //     That's a lapse, not a takeover — re-acquire in place. Treating
          //     it as a takeover showed a spurious "session was taken over on
          //     another device" on idle sessions (2026-07-16).
          const holder = r.holder;
          if (holder && holder.deviceId && holder.deviceId !== opts.deviceId) {
            stopTimer(sessionId);
            held.delete(sessionId);
            void deleteLeaseFile(sessionId); // fire-and-forget: best-effort, already try/caught in the chain
            opts.onTakeoverRequest(sessionId, { deviceId: holder.deviceId, device: holder.device });
            return;
          }

          const re = await opts.hubRequest('acquire', sessionId, opts.deviceId);
          if (gen.get(sessionId) !== myGen) return; // superseded while re-acquiring
          if (!held.has(sessionId)) return; // released while re-acquiring
          if (re && !re.ok) {
            // Raced: another device claimed the lapsed lease between the expiry
            // and our re-acquire. Genuine loss — tear down with attribution.
            stopTimer(sessionId);
            held.delete(sessionId);
            void deleteLeaseFile(sessionId); // fire-and-forget: best-effort, already try/caught in the chain
            const h = re.holder;
            opts.onTakeoverRequest(
              sessionId,
              h && h.deviceId && h.deviceId !== opts.deviceId
                ? { deviceId: h.deviceId, device: h.device }
                : undefined,
            );
            return;
          }
          // Re-acquired (re.ok), or hub went down mid-recovery (re === null) —
          // on the null path we hold optimistically, same never-block rule as
          // the transient-null branch below.
          void writeLeaseFile(sessionId, re?.holder?.expiresAt ?? Date.now() + LEASE_TTL_MS); // fire-and-forget: renew tick, already try/caught in the chain
          schedule();
          return;
        }

        if (r && r.ok) {
          // Still ours — extend the file fallback with the hub's fresh deadline.
          void writeLeaseFile(sessionId, r.holder?.expiresAt ?? Date.now() + LEASE_TTL_MS); // fire-and-forget
        } else {
          // r === null: hub transiently disconnected. Do NOT drop the lease on a
          // blip — keep renewing and keep the file fallback fresh with a local
          // deadline (never-block / tolerate transient hub loss).
          void writeLeaseFile(sessionId, Date.now() + LEASE_TTL_MS); // fire-and-forget
        }
        schedule(); // reschedule the next heartbeat only if we still hold it
      } catch {
        // Swallow — a renew failure must never crash main. Reschedule so a one-off
        // error doesn't silently kill the heartbeat, but only if we're still the
        // live loop (gen unchanged) and still hold the session.
        if (gen.get(sessionId) === myGen && held.has(sessionId)) schedule();
      }
    }

    schedule();
  }

  // ---- public ops ----

  return {
    async acquire(sessionId) {
      // Reserve this call's place in the file-op chain BEFORE the hub round-trip
      // — see reserveFileSlot's WHY. Must happen before ANY await in this
      // function, so a release() fired back-to-back (no await between) can
      // never enqueue its delete ahead of this write.
      const slot = reserveFileSlot(sessionId);

      // WHY try/finally: the reserved slot blocks every LATER file op for this
      // session until it is settled. If anything between here and the settle
      // below threw, that session's queue would hang forever — a later release()
      // would await its delete and never reach the hub. The finally always
      // settles; settle is a promise resolver, so when the write was already
      // handed over this second call is a no-op, and otherwise it releases the
      // slot with no write.
      try {
        let res: LeaseResult | null = null;
        try { res = await opts.hubRequest('acquire', sessionId, opts.deviceId); }
        catch { res = null; } // never throw from acquire

        if (res && !res.ok) {
          // Someone else holds it. Don't start a timer, don't write a file — the
          // caller inspects res.holder to decide whether to request a takeover.
          // The finally below releases our reserved slot — no write.
          return res;
        }

        // res.ok OR res === null (hub down). On the disconnected path we hold
        // OPTIMISTICALLY: sync must never block on the hub, so we take a local hold
        // and let the next renew reconcile once the hub is back.
        const expiresAt = res?.holder?.expiresAt ?? Date.now() + LEASE_TTL_MS;
        // Genuinely idempotent re-acquire: stopTimer clears the old timer, and
        // startRenewTimer bumps the generation so any PRIOR renew tick still
        // awaiting hubRequest becomes a no-op when it resumes (no leaked 2nd loop).
        stopTimer(sessionId);
        held.delete(sessionId);
        slot.settle(() => writeLeaseFileBody(sessionId, expiresAt));
        // WHY start the timer BEFORE awaiting the write (review round 1): if the
        // disk stalls inside writeLeaseFileBody, the heartbeat must still fire on
        // schedule — otherwise the hub lease lapses at 300s while the session is
        // genuinely live and held. startRenewTimer only touches in-memory state
        // (`held`/`gen`) and arms a setTimeout; it does no I/O of its own.
        startRenewTimer(sessionId);
        // Still awaited: the existing "writes the lease file" test and the
        // hub-down fallback both assert the file exists right after acquire()
        // resolves — awaiting a promise here does not block the event loop, only
        // the caller.
        await slot.done;
        return res ?? { ok: true, op: 'acquire', sessionId, holder: { deviceId: opts.deviceId, device: opts.deviceName, expiresAt } };
      } finally {
        slot.settle(null);
      }
    },

    async release(sessionId) {
      // Stop local state FIRST so a late renew can't re-arm anything, then tell
      // the hub best-effort. Release must never throw. Awaited so the existing
      // test ("file is gone after `await release()`") stays true, and so a
      // caller that awaits release() before re-acquiring never races its own
      // delete against a later write.
      stopTimer(sessionId);
      held.delete(sessionId);
      await deleteLeaseFile(sessionId);
      try { await opts.hubRequest('release', sessionId, opts.deviceId); } catch { /* best-effort */ }
    },

    async query(sessionId) {
      let r: LeaseResult | null = null;
      try { r = await opts.hubRequest('get', sessionId, opts.deviceId); }
      catch { r = null; }

      if (r !== null) {
        // Hub answered — authoritative. `self` keys on the per-install deviceId,
        // never the hostname label (which collides across installs).
        if (r.holder) return {
          held: true,
          device: r.holder.device,
          deviceId: r.holder.deviceId,
          expiresAt: r.holder.expiresAt,
          self: r.holder.deviceId === opts.deviceId,
          source: 'hub',
        };
        return { held: false, self: false, source: 'hub' };
      }

      // Hub down — consult the file fallback with the 300s stale rule (local clock).
      // The lease file stores the holder's deviceId too, so self keys on it here as well.
      const file = await readLeaseFile(sessionId);
      if (file && file.expiresAt > Date.now()) {
        console.log(`[lease] query ${sessionId.slice(0, 8)}: hub down — FILE fallback says held by ${file.deviceId.slice(0, 8)} (a takeover request cannot be delivered in this state)`);
        return {
          held: true,
          device: file.device,
          deviceId: file.deviceId,
          expiresAt: file.expiresAt,
          self: file.deviceId === opts.deviceId,
          source: 'file',
        };
      }
      // Missing or expired file => free.
      return { held: false, self: false, source: 'none' };
    },

    async takeover(sessionId) {
      // Thin passthrough: the DO relays this as a takeover-request to the current
      // holder, who answers by releasing. The requester (Task 9) then polls query.
      try { return await opts.hubRequest('takeover', sessionId, opts.deviceId); }
      catch { return null; }
    },

    handleTakeoverRequest(sessionId, from) {
      // Only act if THIS device currently holds the session — otherwise the
      // request isn't for us (the hub broadcasts to the whole account).
      if (!held.has(sessionId)) {
        console.log(`[lease] takeover-request for ${sessionId.slice(0, 8)} ignored — not held here (held: ${held.size})`);
        return;
      }
      console.log(`[lease] takeover-request for ${sessionId.slice(0, 8)} accepted — starting holder teardown (from ${from?.deviceId?.slice(0, 8) ?? 'unknown'})`);
      // The callback is caller-supplied (untrusted) and dispatched synchronously
      // from the service's hub-event handler — a throw here would propagate to
      // Electron main. Swallow so a bad handler can never crash the process.
      try { opts.onTakeoverRequest(sessionId, from); } catch { /* never crash main */ }
    },

    isHeld(sessionId) { return held.has(sessionId); },

    destroy() {
      for (const timer of held.values()) clearTimeout(timer);
      held.clear();
    },
  };
}
