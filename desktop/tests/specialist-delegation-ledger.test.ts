// Tests for DelegationLedger — the durable, per-parent record of every
// specialist delegation (plan 1b Task 2). Real filesystem (temp dir per
// test), same fixture style as permission-store.test.ts: NativeHome(dir)
// against a fresh temp root, no fs mocking.
import { deadPid } from './helpers/dead-pid';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { DelegationLedger, OWNER, isOwnerAlive, toRunView, type DelegationRecord } from '../src/main/harness/specialists/delegation-ledger';
import { MISSED_STEERS_MAX_ENTRIES } from '../src/main/harness/specialists/delegation-ledger';
import { SPECIALIST_NOTE_MAX_CHARS } from '../src/main/harness/specialists/limits';
import type { SpecialistNote } from '../src/shared/types';

const DEAD_PID = deadPid();

let home: NativeHome; let ledger: DelegationLedger; let dir: string;
const CWD = '/some/project';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-ledger-'));
  home = new NativeHome(dir);
  ledger = new DelegationLedger(home);
});

// Minimal valid record, override per test. `owner: OWNER` matches what the
// real host always stamps (this very process); tests that need a DEAD owner
// override it explicitly.
function makeRecord(overrides: Partial<DelegationRecord> & { childId: string }): DelegationRecord {
  return {
    parentToolCallId: 'tc-1',
    agentType: 'explorer',
    title: 'Fig the Explorer',
    workDir: CWD,
    description: 'Explores the codebase',
    // WHY true: claimUndelivered (fix, external review 2026-08-13) only ever
    // leases BACKGROUND records — a foreground delegation's outcome is
    // already delivered inline as the Task tool's own result, so claiming it
    // here would re-deliver it. Every test below is exercising the
    // claim/lease/release mechanism itself, which is now inherently a
    // background-lane concept; the one test that needs a foreground record
    // (proving it's NEVER eligible) overrides this explicitly.
    background: true,
    status: 'running',
    startedAt: Date.now(),
    delivered: false,
    owner: OWNER,
    missedSteers: [],
    ...overrides,
  };
}

describe('DelegationLedger', () => {
  it('makes an owned report claimable again when its marked injection never began', async () => {
    await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c1', status: 'completed', claimedBy: OWNER, claimedAt: Date.now(), injectionAttempted: true }));
    expect(await ledger.cancelUnstartedInjection(CWD, 'p1', 'c1')).toBe(true);
    expect(ledger.listFor(CWD, 'p1')[0]).toMatchObject({ delivered: false });
    expect(ledger.listFor(CWD, 'p1')[0].injectionAttempted).toBeUndefined();
    expect((await ledger.claimUndelivered(CWD, 'p1'))?.childId).toBe('c1');
  });
  it('retains a failed unstarted rollback for the next claim without retrying injected reports', async () => {
    await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c1', status: 'completed' }));
    const claimed = (await ledger.claimUndelivered(CWD, 'p1'))!;
    await ledger.markInjectionAttempted(CWD, 'p1', 'c1');
    const write = vi.spyOn(home, 'mutateJson').mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    await expect(ledger.cancelUnstartedInjection(CWD, 'p1', 'c1', claimed.deliveryClaimId)).rejects.toThrow('disk full');
    expect(ledger.listFor(CWD, 'p1')[0].injectionAttempted).toBe(true);
    write.mockRestore();
    expect((await ledger.claimUndelivered(CWD, 'p1'))?.childId).toBe('c1');
    await ledger.markInjectionAttempted(CWD, 'p1', 'c1');
    // A genuine attempted injection has no rollback intent and stays non-claimable.
    expect(await ledger.claimUndelivered(CWD, 'p1')).toBeNull();
  });
  it('cannot apply an old rollback to a newer same-process delivery claim after a commit-then-throw', async () => {
    await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c1', status: 'completed' }));
    const old = (await ledger.claimUndelivered(CWD, 'p1'))!;
    await ledger.markInjectionAttempted(CWD, 'p1', 'c1');
    const mutate = home.mutateJson.bind(home);
    vi.spyOn(home, 'mutateJson').mockImplementationOnce(async (...args) => { await mutate(...args); throw new Error('after commit'); });
    await expect(ledger.cancelUnstartedInjection(CWD, 'p1', 'c1', old.deliveryClaimId)).rejects.toThrow('after commit');
    // A different ledger instance in the same process advances the claim while old cleanup remains pending.
    const other = new DelegationLedger(home);
    const fresh = (await other.claimUndelivered(CWD, 'p1'))!;
    expect(fresh.deliveryClaimId).not.toBe(old.deliveryClaimId);
    await other.markInjectionAttempted(CWD, 'p1', 'c1');
    expect(await ledger.claimUndelivered(CWD, 'p1')).toBeNull();
    expect(ledger.listFor(CWD, 'p1')[0]).toMatchObject({ injectionAttempted: true, deliveryClaimId: fresh.deliveryClaimId });
  });
  it('rechecks dead-owner reconciliation inside the lock so newer claims and runs survive', async () => {
    const dead = { pid: DEAD_PID, instanceId: 'old-dead-owner' };
    const old = makeRecord({ childId: 'c1', status: 'running', owner: dead, claimedBy: dead, deliveryClaimId: 'old-claim' });
    await ledger.recordStart(CWD, 'p1', old);
    await ledger.update(CWD, 'p1', 'c1', { owner: OWNER, startedAt: old.startedAt + 1,
      claimedBy: OWNER, deliveryClaimId: 'fresh-claim', injectionAttempted: true });
    await ledger.reconcileOwner(CWD, 'p1', old);
    expect(ledger.listFor(CWD, 'p1')[0]).toMatchObject({ status: 'running', owner: OWNER,
      claimedBy: OWNER, deliveryClaimId: 'fresh-claim', injectionAttempted: true });
  });
  it('reconciles an unchanged dead owner without clearing an attempted injection', async () => {
    const dead = { pid: DEAD_PID, instanceId: 'old-dead-owner' };
    const old = makeRecord({ childId: 'c1', status: 'running', owner: dead, claimedBy: dead,
      deliveryClaimId: 'old-claim', injectionAttempted: true });
    await ledger.recordStart(CWD, 'p1', old);
    await ledger.reconcileOwner(CWD, 'p1', old);
    expect(ledger.listFor(CWD, 'p1')[0]).toMatchObject({ status: 'interrupted', injectionAttempted: true });
    expect(ledger.listFor(CWD, 'p1')[0].claimedBy).toBeUndefined();
    expect(await ledger.claimUndelivered(CWD, 'p1')).toBeNull();
  });
  it('does not reject a successful storage change when its notification listener throws', async () => {
    const onChange = vi.fn(() => { throw new Error('disconnected screen'); });
    const observed = new DelegationLedger(home, onChange);
    await expect(observed.recordStart(CWD, 'p1', makeRecord({ childId: 'c1' }))).resolves.toBeUndefined();
    expect(observed.listFor(CWD, 'p1')[0].childId).toBe('c1');
    expect(onChange).toHaveBeenCalledOnce();
  });
  it('cannot clear another owner or an already delivered injection', async () => {
    await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'foreign', status: 'completed', claimedBy: { ...OWNER, instanceId: 'other-owner' }, injectionAttempted: true }));
    await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'delivered', status: 'completed', claimedBy: OWNER, injectionAttempted: true, delivered: true }));
    expect(await ledger.cancelUnstartedInjection(CWD, 'p1', 'foreign')).toBe(false);
    expect(await ledger.cancelUnstartedInjection(CWD, 'p1', 'delivered')).toBe(false);
    expect(ledger.listFor(CWD, 'p1').every(record => record.injectionAttempted)).toBe(true);
  });
  it('recordStart + listFor round-trips a record', async () => {
    await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c1' }));
    const rows = ledger.listFor(CWD, 'p1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ childId: 'c1', agentType: 'explorer', status: 'running' });
  });

  it('listFor returns [] when no file exists yet', () => {
    expect(ledger.listFor(CWD, 'never-delegated')).toEqual([]);
  });

  it('update patches one record by childId and leaves siblings alone', async () => {
    await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c1' }));
    await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c2' }));
    await ledger.update(CWD, 'p1', 'c1', { status: 'completed', endedAt: 999, rawReport: 'done' });

    const rows = ledger.listFor(CWD, 'p1');
    const c1 = rows.find((r) => r.childId === 'c1');
    const c2 = rows.find((r) => r.childId === 'c2');
    expect(c1).toMatchObject({ status: 'completed', endedAt: 999, rawReport: 'done' });
    expect(c2).toMatchObject({ status: 'running' }); // untouched sibling
  });

  it('update caps rawReport at RAW_REPORT_CAP_CHARS (full body survives elsewhere)', async () => {
    const { RAW_REPORT_CAP_CHARS } = await import('../src/main/harness/specialists/delegation-ledger');
    await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c1' }));
    const huge = 'x'.repeat(RAW_REPORT_CAP_CHARS + 5_000);
    await ledger.update(CWD, 'p1', 'c1', { rawReport: huge });
    const rec = ledger.listFor(CWD, 'p1').find((r) => r.childId === 'c1');
    expect(rec?.rawReport?.length).toBe(RAW_REPORT_CAP_CHARS);
  });

  it('claimUndelivered LEASES the oldest completed+undelivered record — delivered stays false', async () => {
    await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'running-one', status: 'running', startedAt: 50 }));
    await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'old', status: 'completed', startedAt: 100 }));
    await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'new', status: 'completed', startedAt: 200 }));

    const first = await ledger.claimUndelivered(CWD, 'p1');
    expect(first?.childId).toBe('old');
    const rec = ledger.listFor(CWD, 'p1').find((r) => r.childId === 'old');
    expect(rec?.delivered).toBe(false);
    expect(rec?.claimedBy).toEqual(OWNER);
    expect(typeof rec?.claimedAt).toBe('number');
  });

  it('claimUndelivered returns null when nothing is eligible', async () => {
    await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'still-running', status: 'running' }));
    expect(await ledger.claimUndelivered(CWD, 'p1')).toBeNull();
  });

  // Fix (external review 2026-08-13, the foreground re-delivery finding): a
  // FOREGROUND delegation's outcome — success or failure — is already
  // delivered the instant the Task tool call returns; nothing ever calls
  // confirmDelivered on a foreground FAILURE (only the success branch does),
  // so its row can sit 'completed'/'failed' + delivered:false forever. Before
  // this fix that made it indistinguishable on disk from a genuinely
  // undelivered background report — claimUndelivered would hand it out and
  // the caller would inject it a SECOND time, mislabeled "background".
  it('claimUndelivered never leases a FOREGROUND record, no matter how undelivered it looks', async () => {
    await ledger.recordStart(CWD, 'p1', makeRecord({
      childId: 'fg-failed', background: false, status: 'failed', startedAt: 100,
      failureText: 'boom', delivered: false,
    }));
    expect(await ledger.claimUndelivered(CWD, 'p1')).toBeNull();
  });

  it('confirmDelivered flips delivered; a confirmed record is never claimable again', async () => {
    await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c1', status: 'completed', startedAt: 100 }));
    const claimed = await ledger.claimUndelivered(CWD, 'p1');
    expect(claimed?.childId).toBe('c1');

    await ledger.confirmDelivered(CWD, 'p1', 'c1');
    const rec = ledger.listFor(CWD, 'p1').find((r) => r.childId === 'c1');
    expect(rec?.delivered).toBe(true);

    // Nothing left to claim — the only record is now delivered.
    expect(await ledger.claimUndelivered(CWD, 'p1')).toBeNull();
  });

  it('releaseClaim clears the lease so a failed injection retries', async () => {
    await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c1', status: 'completed', startedAt: 100 }));
    const claimed = await ledger.claimUndelivered(CWD, 'p1');
    expect(claimed?.childId).toBe('c1');

    await ledger.releaseClaim(CWD, 'p1', 'c1');
    const released = ledger.listFor(CWD, 'p1').find((r) => r.childId === 'c1');
    expect(released?.claimedBy).toBeUndefined();
    expect(released?.delivered).toBe(false); // release never delivers — only confirmDelivered may

    // A second claim picks the SAME record back up.
    const reclaimed = await ledger.claimUndelivered(CWD, 'p1');
    expect(reclaimed?.childId).toBe('c1');
  });

  it('a record leased by a DEAD owner is claimable again — crash between claim and injection re-delivers', async () => {
    await ledger.recordStart(CWD, 'p1', makeRecord({
      childId: 'the-orphaned-one',
      status: 'completed',
      startedAt: 100,
      delivered: false,
      claimedBy: { pid: DEAD_PID, instanceId: 'a-process-that-is-long-gone' },
      claimedAt: 1,
    }));
    const rec = await ledger.claimUndelivered(CWD, 'p1');
    expect(rec?.childId).toBe('the-orphaned-one');
    // The re-claim re-stamps OUR owner, not the dead one.
    expect(rec?.claimedBy).toEqual(OWNER);
  });

  // Fix pass 4, Finding 3: claimUndelivered's own write (inside mutateJson)
  // can commit to disk and THEN have the surrounding call still throw — e.g.
  // mutateFileUnderLock's lock-release (fs.rm on the .lock dir) fails in its
  // `finally`, AFTER atomicWrite already landed the claimedBy stamp. The
  // caller (native-session-host.ts's delivery loop) sees only the throw and
  // never learns which childId got claimed, so it can't release it either —
  // the record is left with a lease stamped by THIS process, which
  // isOwnerAlive always reports as alive. Without this branch, nothing would
  // ever reclaim it short of a restart, stranding the report forever in a
  // live, running session. This test seeds that exact stuck state directly
  // (no need to reproduce the lock-release race itself) and asserts the next
  // claimUndelivered call reclaims it anyway.
  it('a record leased by OUR OWN process instance is reclaimable — only one delivery pass per parent runs at a time, so seeing our own stale lease means our earlier attempt never finished', async () => {
    await ledger.recordStart(CWD, 'p1', makeRecord({
      childId: 'self-claimed-stale',
      status: 'completed',
      startedAt: 100,
      delivered: false,
      claimedBy: OWNER, // exactly this process's own stamp, not a stranger's
      claimedAt: 1,
    }));
    const rec = await ledger.claimUndelivered(CWD, 'p1');
    expect(rec?.childId).toBe('self-claimed-stale');
    expect(rec?.claimedBy).toEqual(OWNER); // re-stamped, same owner either way
  });

  it('a record leased by a LIVE owner (not us) is NOT claimable', async () => {
    await ledger.recordStart(CWD, 'p1', makeRecord({
      childId: 'someone-else-has-it',
      status: 'completed',
      startedAt: 100,
      delivered: false,
      // Our own live pid+a different instanceId — same process, different
      // "instance" — isOwnerAlive can't use the fast path but process.kill
      // on our own real pid succeeds, so this reads as genuinely alive.
      claimedBy: { pid: process.pid, instanceId: 'some-other-instance' },
      claimedAt: 1,
    }));
    expect(await ledger.claimUndelivered(CWD, 'p1')).toBeNull();
  });

  it('isOwnerAlive: our own stamp is alive; an absurd pid+instanceId is not', () => {
    expect(isOwnerAlive(OWNER)).toBe(true);
    expect(isOwnerAlive({ pid: DEAD_PID, instanceId: 'nonexistent-owner' })).toBe(false);
  });

  // ---- Review round 2, Finding 4: "interrupted" always wins a teardown/
  // failure race. When a parent is torn down while a child is still running,
  // two writers can race the SAME record: destroyChildrenOf's unconditional
  // `update(..., { status: 'interrupted' })` and spawnSpecialist's catch-
  // driven `updateIfRunning(..., { status: 'failed' })`. Both orderings must
  // land on 'interrupted' — a parent teardown is the true cause, the child's
  // abort error is only its symptom.
  describe('updateIfRunning — the conditional write behind the "interrupted wins" rule', () => {
    it('applies the patch when the record is still running (the normal case)', async () => {
      await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c1', status: 'running' }));
      await ledger.updateIfRunning(CWD, 'p1', 'c1', { status: 'failed', endedAt: 1, failureText: 'boom' });
      const rec = ledger.listFor(CWD, 'p1').find((r) => r.childId === 'c1');
      expect(rec).toMatchObject({ status: 'failed', endedAt: 1, failureText: 'boom' });
    });

    it('teardown-first ordering: an interrupted write followed by the failure write — interrupted still wins', async () => {
      await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c1', status: 'running' }));
      await ledger.update(CWD, 'p1', 'c1', { status: 'interrupted', endedAt: 1 }); // teardown lands first
      await ledger.updateIfRunning(CWD, 'p1', 'c1', { status: 'failed', endedAt: 2, failureText: 'aborted' }); // catch's write arrives after — must no-op
      const rec = ledger.listFor(CWD, 'p1').find((r) => r.childId === 'c1');
      expect(rec?.status).toBe('interrupted');
      expect(rec?.failureText).toBeUndefined(); // the no-op write never touched the record
    });

    it('failure-first ordering: the failure write followed by the interrupted write — interrupted still wins', async () => {
      await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c1', status: 'running' }));
      await ledger.updateIfRunning(CWD, 'p1', 'c1', { status: 'failed', endedAt: 1, failureText: 'aborted' }); // catch's write lands first
      await ledger.update(CWD, 'p1', 'c1', { status: 'interrupted', endedAt: 2 }); // teardown's unconditional write always applies, even over a terminal status
      const rec = ledger.listFor(CWD, 'p1').find((r) => r.childId === 'c1');
      expect(rec?.status).toBe('interrupted');
    });
  });

  // ---- Fix (Critical 3, final review): a teardown's `{status:'interrupted'}`
  // write is fire-and-forget and can land AFTER runDelegation's own
  // 'completed' write (that write happens first, then the child is
  // de-registered a few microtasks later — a parent destroy()/quiesce() firing
  // its own teardown write can slip in between). Unlike a 'failed' status
  // (which is honestly just a SYMPTOM of the same interrupt, per the
  // "interrupted wins" rule above — update() itself must keep clobbering it,
  // pinned by the describe block above), a 'completed' record is a REAL,
  // already-reported outcome: its report is sitting in rawReport/reportPath
  // waiting to be delivered, and only claimUndelivered ever looks at
  // 'completed'/'failed', never 'interrupted' — so overwriting it silently
  // strands that report forever, including across a restart. This is a NEW,
  // narrower primitive for the two call sites that fire a teardown-driven
  // interrupted write (destroyChildrenOf, interruptSpecialist) — update()
  // itself is untouched and stays unconditional, exactly as the tests above
  // pin.
  describe('updateUnlessCompleted — teardown must never clobber an already-completed record', () => {
    it('applies the patch when the record is still running (the normal teardown case)', async () => {
      await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c1', status: 'running' }));
      await ledger.updateUnlessCompleted(CWD, 'p1', 'c1', { status: 'interrupted', endedAt: 1 });
      const rec = ledger.listFor(CWD, 'p1').find((r) => r.childId === 'c1');
      expect(rec?.status).toBe('interrupted');
    });

    it('skips the patch entirely when the record is already completed — the report survives untouched', async () => {
      await ledger.recordStart(CWD, 'p1', makeRecord({
        childId: 'c1', status: 'completed', startedAt: 100, endedAt: 200, rawReport: 'the real report',
      }));
      await ledger.updateUnlessCompleted(CWD, 'p1', 'c1', { status: 'interrupted', endedAt: 9999 });
      const rec = ledger.listFor(CWD, 'p1').find((r) => r.childId === 'c1');
      expect(rec?.status).toBe('completed');       // NOT clobbered
      expect(rec?.endedAt).toBe(200);               // the real completion time, not the late teardown's
      expect(rec?.rawReport).toBe('the real report');
      // And still claimable — the outcome that actually matters: the report
      // is not stranded behind a status claimUndelivered never looks at.
      const claimed = await ledger.claimUndelivered(CWD, 'p1');
      expect(claimed?.childId).toBe('c1');
    });

    it('still applies over a failed record — only "completed" is protected, "interrupted wins" over "failed" is preserved', async () => {
      await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c1', status: 'failed', startedAt: 100, endedAt: 150, failureText: 'aborted' }));
      await ledger.updateUnlessCompleted(CWD, 'p1', 'c1', { status: 'interrupted', endedAt: 200 });
      const rec = ledger.listFor(CWD, 'p1').find((r) => r.childId === 'c1');
      expect(rec?.status).toBe('interrupted');
    });
  });

  describe('rejected resume steer packets', () => {
    it.each(['before', 'after'] as const)('replays packet rollback once when rollback itself fails %s commit', async failure => {
      await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c1', status: 'completed', missedSteers: ['saved'] }));
      const mutate = home.mutateJson.bind(home);
      const storage = vi.spyOn(home, 'mutateJson')
        .mockImplementationOnce(async (...args) => { await mutate(...args); throw new Error('take rejected after commit'); })
        .mockImplementationOnce(async (...args) => { if (failure === 'after') await mutate(...args); throw new Error('rollback rejected'); });
      await expect(ledger.takeMissedSteers(CWD, 'p1', 'c1', { status: 'running', owner: OWNER })).rejects.toThrow('take rejected');
      storage.mockRestore();
      await ledger.appendMissedSteers(CWD, 'p1', 'c1', ['newer']);
      expect(ledger.listFor(CWD, 'p1')[0].missedSteers).toEqual(['saved', 'newer']);
      expect(await ledger.takeMissedSteers(CWD, 'p1', 'c1')).toEqual(['saved', 'newer']);
      await ledger.appendMissedSteers(CWD, 'p1', 'c1', ['latest']);
      expect(ledger.listFor(CWD, 'p1')[0].missedSteers).toEqual(['latest']);
    });
    it('keeps the existing newest-steers bound across repeated rejected-take recovery', async () => {
      await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c1', missedSteers:
        Array.from({ length: MISSED_STEERS_MAX_ENTRIES }, (_, i) => `original-${i}`) }));
      const mutate = home.mutateJson.bind(home);
      for (let cycle = 0; cycle < 3; cycle++) {
        const newer = Array.from({ length: MISSED_STEERS_MAX_ENTRIES }, (_, i) => `cycle-${cycle}-${i}`);
        const storage = vi.spyOn(home, 'mutateJson').mockImplementationOnce(async (...args) => {
          await mutate(...args);
          await ledger.appendMissedSteers(CWD, 'p1', 'c1', newer);
          throw new Error('take committed then rejected');
        });
        await expect(ledger.takeMissedSteers(CWD, 'p1', 'c1')).rejects.toThrow('take committed');
        storage.mockRestore();
        expect(ledger.listFor(CWD, 'p1')[0].missedSteers).toEqual(newer);
      }
    });
    it('never restores an old rejected packet into a newer take generation', async () => {
      await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c1', missedSteers: ['saved'] }));
      const mutate = home.mutateJson.bind(home);
      const other = new DelegationLedger(home);
      let newerToken: string | undefined;
      vi.spyOn(home, 'mutateJson').mockImplementationOnce(async (...args) => {
        await mutate(...args);
        await other.appendMissedSteers(CWD, 'p1', 'c1', ['newer']);
        expect(await other.takeMissedSteers(CWD, 'p1', 'c1')).toEqual(['newer']);
        newerToken = other.listFor(CWD, 'p1')[0].missedSteerTakeId;
        throw new Error('old take rejected');
      });
      await expect(ledger.takeMissedSteers(CWD, 'p1', 'c1')).rejects.toThrow('old take rejected');
      expect(ledger.listFor(CWD, 'p1')[0]).toMatchObject({ missedSteers: [], missedSteerTakeId: newerToken });
    });
  });

  // ---- Fix pass 5 — distinguishing "claimed, never injected" from
  // "injected, never confirmed". Two on-disk states look identical
  // (claimedBy = some owner, delivered = false) but mean opposite things:
  // (a) the claim landed but runNotice() was never called — safe to retry;
  // (b) runNotice() already ran (the report reached the parent's
  // conversation) and only the follow-up confirmDelivered write failed —
  // retrying means showing the same report twice. injectionAttempted, set by
  // markInjectionAttempted() strictly BEFORE runNotice() is ever called, is
  // what tells them apart on disk.
  describe('injectionAttempted', () => {
    it('markInjectionAttempted durably stamps the marker', async () => {
      await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c1', status: 'completed', startedAt: 100 }));
      await ledger.markInjectionAttempted(CWD, 'p1', 'c1');
      const rec = ledger.listFor(CWD, 'p1').find((r) => r.childId === 'c1');
      expect(rec?.injectionAttempted).toBe(true);
    });

    it('case (a): a record whose injection was NEVER attempted is still reclaimable by its own process', async () => {
      await ledger.recordStart(CWD, 'p1', makeRecord({
        childId: 'never-injected', status: 'completed', startedAt: 100, delivered: false,
        claimedBy: OWNER, claimedAt: 1, // injectionAttempted intentionally omitted — never set
      }));
      const rec = await ledger.claimUndelivered(CWD, 'p1');
      expect(rec?.childId).toBe('never-injected');
    });

    it('case (b): a record whose injection WAS attempted is never reclaimed again by its own live process', async () => {
      await ledger.recordStart(CWD, 'p1', makeRecord({
        childId: 'already-injected', status: 'completed', startedAt: 100, delivered: false,
        claimedBy: OWNER, claimedAt: 1, injectionAttempted: true,
      }));
      expect(await ledger.claimUndelivered(CWD, 'p1')).toBeNull();
    });

    it('case (b) also blocks the dead-owner and never-claimed lease branches — injectionAttempted gates all three, not just self-reclaim', async () => {
      await ledger.recordStart(CWD, 'p1', makeRecord({
        childId: 'dead-owner-already-injected', status: 'completed', startedAt: 100, delivered: false,
        claimedBy: { pid: DEAD_PID, instanceId: 'a-process-that-is-long-gone' }, claimedAt: 1, injectionAttempted: true,
      }));
      expect(await ledger.claimUndelivered(CWD, 'p1')).toBeNull();

      await ledger.recordStart(CWD, 'p1', makeRecord({
        childId: 'released-already-injected', status: 'completed', startedAt: 200, delivered: false,
        injectionAttempted: true, // claimedBy already cleared, e.g. by a releaseClaim after a failed confirmDelivered
      }));
      expect(await ledger.claimUndelivered(CWD, 'p1')).toBeNull();
    });
  });

  // ---- Plan 1c Task 1: every write funnels through one private mutate()
  // chokepoint so a single onChange listener sees every touched record —
  // Task 5 wires this into the live `specialists:run-changed` push. These
  // tests exercise the listener contract itself; the workspace ast-grep rule
  // ledger-single-mutatejson-call (Plan B, 2026-09-16 — it replaced a
  // source-text guard here) enforces the mechanism (one mutateJson call site)
  // that makes it true by construction rather than by convention.
  describe('change listener', () => {
    it('recordStart fires with the new record', async () => {
      const onChange = vi.fn();
      const l = new DelegationLedger(home, onChange);
      await l.recordStart(CWD, 'p1', makeRecord({ childId: 'c1' }));
      expect(onChange).toHaveBeenCalledTimes(1);
      const [calledCwd, calledParentId, changed] = onChange.mock.calls[0];
      expect(calledCwd).toBe(CWD);
      expect(calledParentId).toBe('p1');
      expect(changed).toHaveLength(1);
      expect((changed[0] as DelegationRecord).childId).toBe('c1');
    });

    // Every other write, aimed at 'c1' with 'c2' seeded as an untouched
    // sibling — each must report changed=[c1] and nothing else.
    it.each<[string, (l: DelegationLedger) => Promise<unknown>]>([
      ['update', (l) => l.update(CWD, 'p1', 'c1', { status: 'completed', endedAt: 1 })],
      ['updateIfRunning', (l) => l.updateIfRunning(CWD, 'p1', 'c1', { status: 'failed', endedAt: 1 })],
      ['updateUnlessCompleted', (l) => l.updateUnlessCompleted(CWD, 'p1', 'c1', { status: 'interrupted', endedAt: 1 })],
      ['appendMissedSteers', (l) => l.appendMissedSteers(CWD, 'p1', 'c1', ['steer'])],
      ['takeMissedSteers', (l) => l.takeMissedSteers(CWD, 'p1', 'c1')],
      ['markInjectionAttempted', (l) => l.markInjectionAttempted(CWD, 'p1', 'c1')],
      ['confirmDelivered', (l) => l.confirmDelivered(CWD, 'p1', 'c1')],
      ['releaseClaim', (l) => l.releaseClaim(CWD, 'p1', 'c1')],
      ['appendNote', (l) => l.appendNote(CWD, 'p1', 'c1', { text: 'hi', from: 'user', at: 1 })],
    ])('%s fires the listener with only the touched record', async (_name, run) => {
      // Seeded through a listener-less ledger sharing the same home/file, so
      // the setup writes themselves never reach the onChange under test.
      await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c1' }));
      await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c2' }));
      const onChange = vi.fn();
      const l = new DelegationLedger(home, onChange);
      await run(l);
      expect(onChange).toHaveBeenCalledTimes(1);
      const [calledCwd, calledParentId, changed] = onChange.mock.calls[0];
      expect(calledCwd).toBe(CWD);
      expect(calledParentId).toBe('p1');
      expect(changed).toHaveLength(1);
      expect((changed[0] as DelegationRecord).childId).toBe('c1');
    });

    it('claimUndelivered fires the listener with only the touched (oldest eligible) record', async () => {
      await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c1', status: 'completed', startedAt: 100 }));
      await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c2', status: 'completed', startedAt: 200 }));
      const onChange = vi.fn();
      const l = new DelegationLedger(home, onChange);
      await l.claimUndelivered(CWD, 'p1');
      expect(onChange).toHaveBeenCalledTimes(1);
      const [, , changed] = onChange.mock.calls[0];
      expect(changed).toHaveLength(1);
      expect((changed[0] as DelegationRecord).childId).toBe('c1'); // oldest wins
    });

    it('listFor never fires the listener', async () => {
      const onChange = vi.fn();
      const l = new DelegationLedger(home, onChange);
      await l.recordStart(CWD, 'p1', makeRecord({ childId: 'c1' }));
      onChange.mockClear();
      l.listFor(CWD, 'p1');
      expect(onChange).not.toHaveBeenCalled();
    });

    it('a write that changes nothing (update on an unknown childId) does not fire', async () => {
      const onChange = vi.fn();
      const l = new DelegationLedger(home, onChange);
      await l.recordStart(CWD, 'p1', makeRecord({ childId: 'c1' }));
      onChange.mockClear();
      await l.update(CWD, 'p1', 'no-such-child', { status: 'completed' });
      expect(onChange).not.toHaveBeenCalled();
    });

  });

  it('appendNote appends in order; a 1b record with no notes reads as []', async () => {
    await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c1' })); // no `notes` field — a pre-1c record
    const note1: SpecialistNote = { text: 'first', from: 'user', at: 1 };
    const note2: SpecialistNote = { text: 'second', from: 'assistant', at: 2 };
    await ledger.appendNote(CWD, 'p1', 'c1', note1);
    await ledger.appendNote(CWD, 'p1', 'c1', note2);
    const rec = ledger.listFor(CWD, 'p1').find((r) => r.childId === 'c1');
    expect(rec?.notes).toEqual([note1, note2]);
  });

  it('appendMissedSteers with a note lands steer + note in ONE write (listener fires once, both present)', async () => {
    const onChange = vi.fn();
    const l = new DelegationLedger(home, onChange);
    await l.recordStart(CWD, 'p1', makeRecord({ childId: 'c1' }));
    onChange.mockClear();

    const note: SpecialistNote = { text: 'parked steer', from: 'user', at: 5 };
    await l.appendMissedSteers(CWD, 'p1', 'c1', ['parked steer'], note);

    expect(onChange).toHaveBeenCalledTimes(1); // one write, not two
    const rec = l.listFor(CWD, 'p1').find((r) => r.childId === 'c1');
    expect(rec?.missedSteers).toEqual(['parked steer']);
    expect(rec?.notes).toEqual([note]);
  });

  // ROADMAP L264: missedSteers was the last unbounded field in a file that is
  // read-modify-written in full on every status-block read. Both bounds are
  // applied INSIDE the mutate callback, so all three append paths get them.
  describe('missedSteers is bounded (ROADMAP L264)', () => {
    it('clamps each parked steer to the note cap, on every append path', async () => {
      const long = 'x'.repeat(SPECIALIST_NOTE_MAX_CHARS + 500);
      await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c1' }));

      await ledger.appendMissedSteers(CWD, 'p1', 'c1', [long]);
      await ledger.update(CWD, 'p1', 'c1', {}, [long]);
      await ledger.updateIfRunning(CWD, 'p1', 'c1', {}, [long]);

      const rec = ledger.listFor(CWD, 'p1').find((r) => r.childId === 'c1');
      expect(rec?.missedSteers).toHaveLength(3);
      for (const s of rec!.missedSteers) expect(s).toHaveLength(SPECIALIST_NOTE_MAX_CHARS);
    });

    it('keeps the most recent MISSED_STEERS_MAX_ENTRIES and drops the oldest', async () => {
      await ledger.recordStart(CWD, 'p1', makeRecord({ childId: 'c1' }));
      // One at a time, which is how the loop this guards against actually
      // arrives — and proves the bound is re-applied on every append, not
      // only when a single call oversteps it.
      for (let i = 0; i < MISSED_STEERS_MAX_ENTRIES + 5; i++) {
        await ledger.appendMissedSteers(CWD, 'p1', 'c1', [`steer-${i}`]);
      }
      const rec = ledger.listFor(CWD, 'p1').find((r) => r.childId === 'c1');
      expect(rec?.missedSteers).toHaveLength(MISSED_STEERS_MAX_ENTRIES);
      expect(rec?.missedSteers[0]).toBe('steer-5');
      expect(rec?.missedSteers.at(-1)).toBe(`steer-${MISSED_STEERS_MAX_ENTRIES + 4}`);
    });

    it('leaves an oversized record already on disk readable, and shortens it on the next append', async () => {
      // Clamped on write only — no FILE_VERSION bump, so a record written
      // before this change must still load rather than being rejected.
      await ledger.recordStart(CWD, 'p1', makeRecord({
        childId: 'c1',
        missedSteers: Array.from({ length: 60 }, (_, i) => `old-${i}`),
      }));
      expect(ledger.listFor(CWD, 'p1')[0].missedSteers).toHaveLength(60);

      await ledger.appendMissedSteers(CWD, 'p1', 'c1', ['new']);
      const rec = ledger.listFor(CWD, 'p1').find((r) => r.childId === 'c1');
      expect(rec?.missedSteers).toHaveLength(MISSED_STEERS_MAX_ENTRIES);
      expect(rec?.missedSteers.at(-1)).toBe('new');
    });
  });

  it('toRunView strips delivery bookkeeping and carries notes/model/steps/stale', () => {
    const note: SpecialistNote = { text: 'steer', from: 'user', at: 1 };
    const rec: DelegationRecord = makeRecord({
      childId: 'c1',
      description: 'does a thing',
      status: 'failed',
      endedAt: 200,
      steps: 7,
      stale: true,
      rawReport: 'the raw report',
      reportPath: '/spill/path.txt',
      failureText: 'boom',
      delivered: true,
      injectionAttempted: true,
      claimedBy: OWNER,
      claimedAt: 123,
      missedSteers: ['s1'],
      notes: [note],
      model: { label: 'Sonnet 5', via: 'named', fallback: false },
    });

    const view = toRunView(rec);

    // ROADMAP L259: `seq` is an ORDERING stamp, not part of the record — it is
    // minted fresh on every projection, so this comparison asserts the field
    // set minus that one, then checks the stamp separately below.
    const { seq, ...projected } = view;
    expect(projected).toEqual({
      childId: 'c1',
      parentToolCallId: 'tc-1',
      agentType: 'explorer',
      title: 'Fig the Explorer',
      description: 'does a thing',
      background: true,
      status: 'failed',
      startedAt: rec.startedAt,
      endedAt: 200,
      steps: 7,
      stale: true,
      model: { label: 'Sonnet 5', via: 'named', fallback: false },
      notes: [note],
      // Audit 2026-10-22: resume + report-freshness facts (a never-resumed run is run 1 on its own card).
      runNumber: 1,
      activeToolCallId: 'tc-1',
      reportStale: false,
      // delivered: true, so nothing is pending (reportPending omitted by toEqual's undefined handling).
      resumedAt: undefined,
      reportPending: undefined,
    });
    // Monotonic, and it advances on every projection — that is what lets the
    // reducer tell a straggler from a real update.
    expect(seq).toBeGreaterThan(0);
    expect(toRunView(rec).seq!).toBeGreaterThan(seq!);
    // Delivery bookkeeping must not leak into the renderer's view.
    expect((view as unknown as Record<string, unknown>).delivered).toBeUndefined();
    expect((view as unknown as Record<string, unknown>).injectionAttempted).toBeUndefined();
    expect((view as unknown as Record<string, unknown>).claimedBy).toBeUndefined();
    expect((view as unknown as Record<string, unknown>).claimedAt).toBeUndefined();
    expect((view as unknown as Record<string, unknown>).owner).toBeUndefined();
    expect((view as unknown as Record<string, unknown>).missedSteers).toBeUndefined();
    expect((view as unknown as Record<string, unknown>).rawReport).toBeUndefined();
    expect((view as unknown as Record<string, unknown>).reportPath).toBeUndefined();
  });
});
