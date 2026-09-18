// desktop/tests/sync-spaces-engine.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SpaceSyncEngine } from '../src/main/sync-spaces/engine';
import type { SyncSpace, SyncTransport, SpaceSyncEvent } from '../src/main/sync-spaces/types';
import { REPO_REPAIR_FAILED_ERROR_CODE } from '../src/main/sync-error-classifier';

function fakeTransport(): SyncTransport & { pushes: string[]; pulls: string[] } {
  const t: any = {
    pushes: [] as string[], pulls: [] as string[],
    init: vi.fn(async () => {}),
    hasRemote: vi.fn(async () => true),
    setRemote: vi.fn(async () => {}),
    push: vi.fn(async (s: SyncSpace) => { t.pushes.push(s.id); return { pushed: true, oversize: [] }; }),
    pull: vi.fn(async (s: SyncSpace) => { t.pulls.push(s.id); return { updated: false, conflictCopies: [] }; }),
    history: vi.fn(async () => []),
  };
  return t;
}

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-eng-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

// These are fs.watch INTEGRATION tests — they wait on real filesystem events,
// so their wall-clock scales with machine load and vitest's parallel pool
// guarantees load. The 5000ms literal these replaced took the macOS leg of beta
// run 29701441150 red TWICE on 2026-07-19, with a DIFFERENT victim test each
// run ('debounces file changes…' then 'emits error events…') — the signature of
// a too-tight budget, not a broken assertion. Windows and Linux passed both times.
//
// Note for whoever touches this next: PR #163 swapped this family's fixed
// sleep()s for vi.waitFor bounded-retry polling, which was right — but
// vi.waitFor carries its OWN fixed ceiling, so the budget moved rather than
// disappeared. One named knob per file; do NOT reintroduce inline literals (an
// inline third arg on it() silently overrides vi.setConfig — the #163 trap).
const WAIT_MS = 60_000;

// The knob above bounds the vi.waitFor POLLING. It does NOT bound the test, and
// without this line the file inherits vitest's default 5000ms testTimeout — so
// every 60s wait above was in fact capped at 5s and PR #180's ceiling was
// unreachable. That is the "Test timed out in 5000ms" macOS flake on PR #181
// (ROADMAP :252): #180 replaced the six inline `{ timeout: 5000 }` literals here
// but never added the setConfig its two sibling files got in #163
// (sync-spaces-project-discovery.test.ts:23, sync-spaces-git-transport.test.ts
// :18). Both knobs are required — one bounds the poll, one bounds the test.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe('SpaceSyncEngine', () => {
  it('debounces file changes into one sync (pull then push)', async () => {
    const t = fakeTransport();
    const events: SpaceSyncEvent[] = [];
    const engine = new SpaceSyncEngine(t, { debounceMs: 150, pollMs: 0, onEvent: e => events.push(e) });
    const space: SyncSpace = { id: 'project:x', kind: 'project', root: tmp };
    await engine.addSpace(space);
    fs.writeFileSync(path.join(tmp, 'a.md'), '1');
    fs.writeFileSync(path.join(tmp, 'b.md'), '2');
    await vi.waitFor(() => expect(t.pushes.length).toBe(1), { timeout: WAIT_MS });
    expect(t.pulls.length).toBe(1);                 // pull-before-push ordering
    expect(events.some(e => e.type === 'synced')).toBe(true);
    await engine.stop();
  });


  // The debounce test above can no longer tell a live watcher from a dead one:
  // addSpace() syncs once by design, so it would pass with chokidar delivering
  // nothing. This is the test that fails if watching itself breaks — the write
  // happens after the startup sync has landed, so only a real event can cause
  // the second one.
  it('syncs a change made after the startup sync has landed', async () => {
    const t = fakeTransport();
    const engine = new SpaceSyncEngine(t, { debounceMs: 100, pollMs: 0, onEvent: () => {} });
    await engine.addSpace({ id: 'project:x', kind: 'project', root: tmp });
    await drainStartupSync(t);
    fs.writeFileSync(path.join(tmp, 'later.md'), 'written after the watch is armed');
    await vi.waitFor(() => expect(t.pushes.length).toBe(1), { timeout: WAIT_MS });
    await engine.stop();
  });

// addSpace() deliberately schedules ONE sync (engine.ts — it closes the macOS
// window where fs.watch has returned but the OS watch is not armed yet, during
// which changes are dropped entirely). Tests that assert "this change caused NO
// sync" must let that one land first, or they are really asserting the
// reconcile away. Draining it keeps them testing the ignore filter, which is
// what they are for.
async function drainStartupSync(t: { pushes: unknown[] }): Promise<void> {
  await vi.waitFor(() => expect(t.pushes.length).toBe(1), { timeout: WAIT_MS });
  t.pushes.length = 0;
}

  it('ignores changes under .youcoded/ and node_modules/', async () => {
    const t = fakeTransport();
    const engine = new SpaceSyncEngine(t, { debounceMs: 100, pollMs: 0, onEvent: () => {} });
    await engine.addSpace({ id: 'project:x', kind: 'project', root: tmp });
    await drainStartupSync(t);
    fs.mkdirSync(path.join(tmp, '.youcoded'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.youcoded', 'sync.log'), 'x');
    fs.mkdirSync(path.join(tmp, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'node_modules', 'y.js'), 'x');
    await new Promise(r => setTimeout(r, 500));
    expect(t.pushes.length).toBe(0);
    await engine.stop();
  });

  it('ignores the ephemeral *.json.lock dirs cas-write creates', async () => {
    const t = fakeTransport();
    const engine = new SpaceSyncEngine(t, { debounceMs: 100, pollMs: 0, onEvent: () => {} });
    await engine.addSpace({ id: 'personal', kind: 'personal', root: tmp });
    await drainStartupSync(t);
    // cas-write.ts takes a mkdir-based lock (`<file>.json.lock`) around every
    // conversation/registry write and removes it milliseconds later. Chokidar
    // racing that rmdir on Windows throws EPERM, which surfaced to the user as
    // a red "Couldn't sync" on a sync that was working fine.
    fs.mkdirSync(path.join(tmp, 'e4b946bb-f310-4499-b677-e6c890453ca5.json.lock'), { recursive: true });
    await new Promise(r => setTimeout(r, 500));
    expect(t.pushes.length).toBe(0);
    await engine.stop();
  });

  it('still syncs real lockfiles a user keeps in a project (Cargo.lock)', async () => {
    const t = fakeTransport();
    const engine = new SpaceSyncEngine(t, { debounceMs: 100, pollMs: 0, onEvent: () => {} });
    await engine.addSpace({ id: 'project:x', kind: 'project', root: tmp });
    // The lock-dir ignore is scoped to `.json.lock` precisely so real lockfiles
    // (Cargo.lock, Gemfile.lock, poetry.lock) keep triggering an instant sync.
    fs.writeFileSync(path.join(tmp, 'Cargo.lock'), 'x');
    await vi.waitFor(() => expect(t.pushes.length).toBe(1), { timeout: WAIT_MS });
    await engine.stop();
  });

  it('poll timer pulls without local changes', async () => {
    const t = fakeTransport();
    const engine = new SpaceSyncEngine(t, { debounceMs: 5000, pollMs: 120, onEvent: () => {} });
    await engine.addSpace({ id: 'personal', kind: 'personal', root: tmp });
    await vi.waitFor(() => expect(t.pulls.length).toBeGreaterThanOrEqual(1), { timeout: WAIT_MS });
    await engine.stop();
  });

  it('single-flight: overlapping sync requests coalesce into exactly one rerun', async () => {
    const t = fakeTransport();
    // Make the FIRST pull hang until we release it, so we can pile up sync
    // requests while a sync is genuinely in flight.
    let releaseFirstPull: () => void = () => {};
    let firstPull = true;
    (t.pull as any).mockImplementation(async (s: SyncSpace) => {
      t.pulls.push(s.id);
      if (firstPull) {
        firstPull = false;
        await new Promise<void>(r => { releaseFirstPull = r; });
      }
      return { updated: false, conflictCopies: [] };
    });
    const engine = new SpaceSyncEngine(t, { debounceMs: 60_000, pollMs: 0, onEvent: () => {} });
    const space: SyncSpace = { id: 'project:x', kind: 'project', root: tmp };
    await engine.addSpace(space);
    const first = engine.syncSpace(space);                       // starts, blocks inside pull
    await vi.waitFor(() => expect(t.pulls.length).toBe(1), { timeout: WAIT_MS });
    void engine.syncSpace(space);                                // mid-sync: sets the rerun flag
    void engine.syncSpace(space);                                // mid-sync again: must NOT queue a second rerun
    releaseFirstPull();
    await first;
    // Exactly two syncs total: the original + one coalesced rerun.
    await vi.waitFor(() => expect(t.pushes.length).toBe(2), { timeout: WAIT_MS });
    await new Promise(r => setTimeout(r, 300));                  // settle: no third sync sneaks in
    expect(t.pushes.length).toBe(2);
    expect(t.pulls.length).toBe(2);
    await engine.stop();
  });

  // "Try again" awaits this promise to show "Syncing…". Resolving before the
  // follow-up ran made the button look dead (2026-09-16).
  it('a request made mid-sync resolves only after the follow-up sync it queued has finished', async () => {
    const t = fakeTransport();
    // Every pull waits for its own release, so each run can be held open.
    const releases: Array<() => void> = [];
    t.pull = vi.fn(async (s: SyncSpace) => {
      t.pulls.push(s.id);
      await new Promise<void>(r => { releases.push(r); });
      return { updated: false, conflictCopies: [] };
    });
    const engine = new SpaceSyncEngine(t, { debounceMs: 60_000, pollMs: 0, onEvent: () => {} });
    const space: SyncSpace = { id: 'project:x', kind: 'project', root: tmp };
    await engine.addSpace(space);
    const first = engine.syncSpace(space);
    await vi.waitFor(() => expect(releases.length).toBe(1), { timeout: WAIT_MS });
    let retryDone = false;
    const retry = engine.syncSpace(space).then(() => { retryDone = true; });
    releases[0]();
    await first;
    // The follow-up run is now in flight, held inside its pull.
    await vi.waitFor(() => expect(releases.length).toBe(2), { timeout: WAIT_MS });
    expect(retryDone).toBe(false);
    releases[1]();
    await retry;
    expect(t.pushes.length).toBe(2);
    await engine.stop();
  });

  it('reports each over-limit file once per launch, not on every sync', async () => {
    const t = fakeTransport();
    t.push = vi.fn(async (s: SyncSpace) => { t.pushes.push(s.id); return { pushed: true, oversize: ['chat.jsonl'] }; });
    const events: SpaceSyncEvent[] = [];
    const engine = new SpaceSyncEngine(t, { debounceMs: 60_000, pollMs: 0, onEvent: e => events.push(e) });
    const space: SyncSpace = { id: 'personal', kind: 'personal', root: tmp };
    await engine.addSpace(space);
    await engine.syncSpace(space);
    await engine.syncSpace(space);
    t.push = vi.fn(async () => ({ pushed: true, oversize: ['chat.jsonl', 'other.jsonl'] }));
    await engine.syncSpace(space);
    const reports = events.filter(e => e.type === 'oversize') as Array<Extract<SpaceSyncEvent, { type: 'oversize' }>>;
    expect(reports.map(r => r.files)).toEqual([['chat.jsonl'], ['other.jsonl']]);
    await engine.stop();
  });

  it('warns ONCE per launch when the hidden history exceeds the size threshold', async () => {
    const t = fakeTransport();
    (t as any).maybeGc = vi.fn(async () => {});
    (t as any).gitDirSizeBytes = vi.fn(async () => 600); // > injected 500-byte threshold
    const events: SpaceSyncEvent[] = [];
    const engine = new SpaceSyncEngine(t, { debounceMs: 50, pollMs: 0, sizeWarnBytes: 500, onEvent: e => events.push(e) });
    const space: SyncSpace = { id: 'project:big', kind: 'project', root: tmp };
    await engine.addSpace(space);
    // Two independent syncs — the warning must fire on the first only.
    await engine.syncSpace(space);
    await engine.syncSpace(space);
    // Emitted as 'notice' (NOT 'error') so it never turns the sync dot red.
    const warnings = events.filter(e => e.type === 'notice' && /is large/.test((e as any).message));
    expect(warnings.length).toBe(1);
    // And crucially NO error event was produced by the healthy large space.
    expect(events.some(e => e.type === 'error')).toBe(false);
    expect((t as any).maybeGc).toHaveBeenCalled();
    await engine.stop();
  });

  it('a maybeGc failure never breaks the sync (best-effort maintenance)', async () => {
    const t = fakeTransport();
    (t as any).maybeGc = vi.fn(async () => { throw new Error('gc boom'); });
    const events: SpaceSyncEvent[] = [];
    const engine = new SpaceSyncEngine(t, { debounceMs: 50, pollMs: 0, onEvent: e => events.push(e) });
    const space: SyncSpace = { id: 'project:x', kind: 'project', root: tmp };
    await engine.addSpace(space);
    await engine.syncSpace(space);
    // The sync still reports success; the gc throw is swallowed (no error event).
    expect(events.some(e => e.type === 'synced')).toBe(true);
    expect(events.some(e => e.type === 'error')).toBe(false);
    await engine.stop();
  });

  it('folds a push-retry recovery pull into the synced event (updated) and emits its conflicts', async () => {
    const t = fakeTransport();
    // The caller-visible pull sees nothing new; the peer's changes arrive via
    // the PUSH's internal recovery pull (concurrent-push race). The engine must
    // OR the flags and emit the recovery conflicts — otherwise the materialize
    // sweep / discovery / conflict notice never fire for changes that ARE on disk.
    (t.push as any).mockImplementation(async (s: SyncSpace) => {
      t.pushes.push(s.id);
      return { pushed: true, oversize: [], updated: true, conflictCopies: ['doc (from Other, 2026-07-15).md'] };
    });
    const events: SpaceSyncEvent[] = [];
    const engine = new SpaceSyncEngine(t, { debounceMs: 50, pollMs: 0, onEvent: e => events.push(e) });
    const space: SyncSpace = { id: 'personal', kind: 'personal', root: tmp };
    await engine.addSpace(space);
    await engine.syncSpace(space);
    const synced = events.find(e => e.type === 'synced') as Extract<SpaceSyncEvent, { type: 'synced' }>;
    expect(synced).toBeDefined();
    expect(synced.updated).toBe(true);
    // A transport that never says whether it reached the remote is read as
    // contact — the pre-2026-09-16 behaviour, kept for fakes and future transports.
    expect(synced.contacted).toBe(true);
    const conflict = events.find(e => e.type === 'conflict') as Extract<SpaceSyncEvent, { type: 'conflict' }>;
    expect(conflict).toBeDefined();
    expect(conflict.copies).toEqual(['doc (from Other, 2026-07-15).md']);
    await engine.stop();
  });

  // 2026-09-16 (docs/roadmap/sync.md, "Last synced just now while offline for
  // days"): an offline cycle still completes and emits 'synced' — the panel's
  // state machine needs the cycle end — but carries contacted:false, which is
  // what service.broadcast() reads before stamping recency.
  it("an offline cycle emits 'synced' with contacted:false; any contact makes it true", async () => {
    const t = fakeTransport();
    (t.pull as any).mockImplementation(async () => ({ updated: false, conflictCopies: [], contacted: false }));
    (t.push as any).mockImplementation(async () => ({ pushed: false, oversize: [], contacted: false }));
    const events: SpaceSyncEvent[] = [];
    const engine = new SpaceSyncEngine(t, { debounceMs: 50, pollMs: 0, onEvent: e => events.push(e) });
    const space: SyncSpace = { id: 'personal', kind: 'personal', root: tmp };
    await engine.addSpace(space);
    await engine.syncSpace(space);
    const offline = events.find(e => e.type === 'synced') as Extract<SpaceSyncEvent, { type: 'synced' }>;
    expect(offline).toBeDefined();
    expect(offline.contacted).toBe(false);
    // The push's recovery pull reached origin even though the pull did not.
    events.length = 0;
    (t.push as any).mockImplementation(async () => ({ pushed: false, oversize: [], contacted: true }));
    await engine.syncSpace(space);
    const back = events.find(e => e.type === 'synced') as Extract<SpaceSyncEvent, { type: 'synced' }>;
    expect(back.contacted).toBe(true);
    await engine.stop();
  });

  // ---- Honest-state-machine pins (2026-07-22) ----------------------------
  // A space with no remote must NEVER emit 'synced': pull/push silently no-op
  // without one, and that phantom success superseded the real provisioning
  // error under latestUnresolvedError — a fresh device showed green
  // "All synced" while it had never contacted GitHub (beta.8 macOS VM bug).

  it('never emits synced for a remote-less space (no provisioner: errors instead)', async () => {
    const t = fakeTransport();
    (t.hasRemote as any).mockImplementation(async () => false);
    const events: SpaceSyncEvent[] = [];
    const engine = new SpaceSyncEngine(t, { debounceMs: 50, pollMs: 0, onEvent: e => events.push(e) });
    const space: SyncSpace = { id: 'personal', kind: 'personal', root: tmp };
    await engine.addSpace(space);
    await engine.syncSpace(space);
    expect(events.some(e => e.type === 'synced')).toBe(false);
    expect(events.some(e => e.type === 'error')).toBe(true);
    // And it never reached the (silently no-opping) pull/push.
    expect(t.pulls.length).toBe(0);
    expect(t.pushes.length).toBe(0);
    await engine.stop();
  });

  it('provisions a remote-less space via ensureProvisioned, then really syncs', async () => {
    const t = fakeTransport();
    let provisioned = false;
    (t.hasRemote as any).mockImplementation(async () => provisioned);
    const ensureProvisioned = vi.fn(async () => { provisioned = true; });
    const events: SpaceSyncEvent[] = [];
    const engine = new SpaceSyncEngine(t, { debounceMs: 50, pollMs: 0, onEvent: e => events.push(e), ensureProvisioned });
    const space: SyncSpace = { id: 'personal', kind: 'personal', root: tmp };
    await engine.addSpace(space);
    await engine.syncSpace(space);
    expect(ensureProvisioned).toHaveBeenCalledTimes(1);
    expect(t.pulls.length).toBe(1);
    expect(t.pushes.length).toBe(1);
    expect(events.some(e => e.type === 'synced')).toBe(true);
    expect(events.some(e => e.type === 'error')).toBe(false);
    // Already-provisioned spaces don't re-provision on the next cycle.
    await engine.syncSpace(space);
    expect(ensureProvisioned).toHaveBeenCalledTimes(1);
    await engine.stop();
  });

  it('self-heals: provisioning failure surfaces VERBATIM each cycle until it succeeds', async () => {
    const t = fakeTransport();
    let provisioned = false;
    (t.hasRemote as any).mockImplementation(async () => provisioned);
    // First two cycles fail like a stock machine (gh absent); third succeeds
    // (user installed gh / connected GitHub) — no restart, no toggle-cycle.
    const ensureProvisioned = vi.fn()
      .mockRejectedValueOnce(new Error('GitHub CLI (gh) is not installed — sync needs it to create your private repos'))
      .mockRejectedValueOnce(new Error('GitHub CLI (gh) is not installed — sync needs it to create your private repos'))
      .mockImplementation(async () => { provisioned = true; });
    const events: SpaceSyncEvent[] = [];
    const engine = new SpaceSyncEngine(t, { debounceMs: 50, pollMs: 0, onEvent: e => events.push(e), ensureProvisioned });
    const space: SyncSpace = { id: 'personal', kind: 'personal', root: tmp };
    await engine.addSpace(space);
    await engine.syncSpace(space);
    await engine.syncSpace(space);
    // The plain-language cause reaches the event stream verbatim, EVERY cycle —
    // re-emission is what keeps it alive past latestUnresolvedError's
    // "a later synced supersedes" rule.
    const errs = events.filter(e => e.type === 'error') as Extract<SpaceSyncEvent, { type: 'error' }>[];
    expect(errs.length).toBe(2);
    expect(errs[0].message).toMatch(/GitHub CLI \(gh\) is not installed/);
    expect(events.some(e => e.type === 'synced')).toBe(false);
    // Cause fixed → the very next cycle provisions and completes a real sync.
    await engine.syncSpace(space);
    expect(events.some(e => e.type === 'synced')).toBe(true);
    await engine.stop();
  });

  it('emits error events instead of throwing, so sync never blocks', async () => {
    const t = fakeTransport();
    (t.push as any).mockImplementation(async () => { throw new Error('boom'); });
    const events: SpaceSyncEvent[] = [];
    const engine = new SpaceSyncEngine(t, { debounceMs: 100, pollMs: 0, onEvent: e => events.push(e) });
    await engine.addSpace({ id: 'project:x', kind: 'project', root: tmp });
    fs.writeFileSync(path.join(tmp, 'a.md'), '1');
    await vi.waitFor(() => expect(events.some(e => e.type === 'error')).toBe(true), { timeout: WAIT_MS });
    await engine.stop();
  });
});

// Phase 2 (2026-07-22): the typed marker on thrown errors must reach the event
// stream — it is what lets the panel show "Connect GitHub…" for auth failures
// without string-matching prose.
describe('SpaceSyncEngine errorCode passthrough', () => {
  it("copies a thrown error's syncErrorCode onto the 'error' event; uncoded errors omit it", async () => {
    const t = fakeTransport();
    (t.pull as any).mockImplementation(async () => {
      throw Object.assign(new Error('GitHub sign-in expired — reconnect your GitHub account in the Sync settings'), { syncErrorCode: 'github-auth' });
    });
    const events: SpaceSyncEvent[] = [];
    const engine = new SpaceSyncEngine(t, { debounceMs: 50, pollMs: 0, onEvent: e => events.push(e) });
    const space: SyncSpace = { id: 'personal', kind: 'personal', root: tmp };
    await engine.addSpace(space);
    await engine.syncSpace(space);
    const coded = events.find(e => e.type === 'error') as Extract<SpaceSyncEvent, { type: 'error' }>;
    expect(coded.errorCode).toBe('github-auth');
    expect(coded.message).toContain('GitHub sign-in expired');

    // Uncoded throw → errorCode stays undefined (never invented).
    (t.pull as any).mockImplementation(async () => { throw new Error('boom'); });
    await engine.syncSpace(space);
    const plain = (events.filter(e => e.type === 'error') as Extract<SpaceSyncEvent, { type: 'error' }>[]).at(-1)!;
    expect(plain.errorCode).toBeUndefined();
    await engine.stop();
  });
});

describe('corruption self-heal', () => {
  function corruptOnce(t: ReturnType<typeof fakeTransport>) {
    // First push throws coded repo-corrupt; after repair() runs, pushes succeed.
    let repaired = false;
    (t as any).repair = vi.fn(async () => { repaired = true; });
    t.push = vi.fn(async (s: SyncSpace) => {
      if (!repaired) { const e: any = new Error('Sync data needs repair (git commit: bad object HEAD)'); e.syncErrorCode = 'repo-corrupt'; throw e; }
      t.pushes.push(s.id); return { pushed: true, oversize: [] };
    }) as any;
    return t;
  }

  it('repairs once, emits the notice, and the rerun sync succeeds', async () => {
    const t = corruptOnce(fakeTransport());
    const events: SpaceSyncEvent[] = [];
    const engine = new SpaceSyncEngine(t, { onEvent: (e) => events.push(e), pollMs: 0, debounceMs: 50 });
    const space: SyncSpace = { id: 'project:heal', kind: 'project', root: tmp };
    await engine.addSpace(space);
    await engine.syncSpace(space);
    await vi.waitFor(() => expect(t.pushes.length).toBe(1), { timeout: WAIT_MS });
    expect((t as any).repair).toHaveBeenCalledTimes(1);
    const notice = events.find(e => e.type === 'notice');
    expect(notice).toMatchObject({ spaceId: 'project:heal', message: 'Sync repaired itself after a crash. Your files were untouched.' });
    // The healed rerun emitted a real synced event; no error event ever fired.
    await vi.waitFor(() => expect(events.some(e => e.type === 'synced')).toBe(true), { timeout: WAIT_MS });
    expect(events.filter(e => e.type === 'error')).toEqual([]);
    await engine.stop();
  });

  it('a SECOND corruption in the same launch surfaces as an error — no heal loop', async () => {
    const t = fakeTransport();
    (t as any).repair = vi.fn(async () => {});
    t.push = vi.fn(async () => { const e: any = new Error('still corrupt'); e.syncErrorCode = 'repo-corrupt'; throw e; }) as any;
    const events: SpaceSyncEvent[] = [];
    const engine = new SpaceSyncEngine(t, { onEvent: (e) => events.push(e), pollMs: 0, debounceMs: 50 });
    const space: SyncSpace = { id: 'project:loop', kind: 'project', root: tmp };
    await engine.addSpace(space);
    await engine.syncSpace(space);   // corrupt → heals (attempt 1) → rerun → corrupt AGAIN
    await vi.waitFor(() => expect(events.some(e => e.type === 'error' && e.errorCode === 'repo-corrupt')).toBe(true), { timeout: WAIT_MS });
    expect((t as any).repair).toHaveBeenCalledTimes(1);  // never a second attempt
    await engine.stop();
  });

  it('a FAILED repair surfaces repo-repair-failed, never a phantom synced', async () => {
    const t = fakeTransport();
    (t as any).repair = vi.fn(async () => { throw new Error('no network for tier 2'); });
    t.push = vi.fn(async () => { const e: any = new Error('bad object HEAD'); e.syncErrorCode = 'repo-corrupt'; throw e; }) as any;
    const events: SpaceSyncEvent[] = [];
    const engine = new SpaceSyncEngine(t, { onEvent: (e) => events.push(e), pollMs: 0, debounceMs: 50 });
    const space: SyncSpace = { id: 'project:sad', kind: 'project', root: tmp };
    await engine.addSpace(space);
    await engine.syncSpace(space);
    await vi.waitFor(() => expect(events.some(e => e.type === 'error' && e.errorCode === REPO_REPAIR_FAILED_ERROR_CODE)).toBe(true), { timeout: WAIT_MS });
    expect(events.some(e => e.type === 'synced')).toBe(false);
    // A FAILED repair still consumes the launch's one heal attempt — the guard
    // is "one attempt per launch," not "one attempt until it succeeds." Drive a
    // second cycle against the still-corrupt repo and confirm repair is NOT
    // retried: call count stays at 1, and the corruption forwards as a plain
    // repo-corrupt error (not another repo-repair-failed) — proof the engine
    // took the "already healed this launch" branch instead of re-attempting.
    events.length = 0;
    await engine.syncSpace(space);
    expect((t as any).repair).toHaveBeenCalledTimes(1);
    const secondError = events.find(e => e.type === 'error') as Extract<SpaceSyncEvent, { type: 'error' }>;
    expect(secondError).toBeDefined();
    expect(secondError.errorCode).toBe('repo-corrupt');
    await engine.stop();
  });

  it('repair succeeds but the healed re-run still fails: no phantom synced, plain error surfaces', async () => {
    // The existing "repairs once" test's push always throws, so its own
    // `expect(events.some(synced)).toBe(false)` assertion never actually
    // exercises the repair-succeeded-but-still-broken shape (synced is
    // unreachable there for an unrelated reason). Realistic case this test
    // pins: repair() itself resolves cleanly, but the healed rerun's push
    // hits a DIFFERENT, uncoded failure (e.g. disk full) — the engine must
    // still forward it as a plain error, never mistake the repair's own
    // success for a synced space.
    const t = fakeTransport();
    (t as any).repair = vi.fn(async () => {}); // Tier 1/2 succeeds
    t.push = vi.fn(async () => { throw new Error('no space left on device'); }) as any; // uncoded, unrelated to corruption
    // First push call throws the coded corruption error to trigger repair;
    // every call AFTER that (i.e. the healed rerun) throws the uncoded one.
    let first = true;
    (t.push as any).mockImplementation(async () => {
      if (first) { first = false; const e: any = new Error('bad object HEAD'); e.syncErrorCode = 'repo-corrupt'; throw e; }
      throw new Error('no space left on device');
    });
    const events: SpaceSyncEvent[] = [];
    const engine = new SpaceSyncEngine(t, { onEvent: (e) => events.push(e), pollMs: 0, debounceMs: 50 });
    const space: SyncSpace = { id: 'project:healedbutbroken', kind: 'project', root: tmp };
    await engine.addSpace(space);
    await engine.syncSpace(space);
    await vi.waitFor(() => expect(events.some(e => e.type === 'error' && e.errorCode === undefined)).toBe(true), { timeout: WAIT_MS });
    expect((t as any).repair).toHaveBeenCalledTimes(1);
    const notice = events.find(e => e.type === 'notice');
    expect(notice).toBeDefined(); // the repair itself did succeed and notify
    expect(events.some(e => e.type === 'synced')).toBe(false);
    const plainError = events.find(e => e.type === 'error') as Extract<SpaceSyncEvent, { type: 'error' }>;
    expect(plainError.message).toContain('no space left on device');
    await engine.stop();
  });

  it('a transport WITHOUT repair() falls through to the plain error event', async () => {
    const t = fakeTransport(); // no repair member — future non-git transport
    t.push = vi.fn(async () => { const e: any = new Error('bad object HEAD'); e.syncErrorCode = 'repo-corrupt'; throw e; }) as any;
    const events: SpaceSyncEvent[] = [];
    const engine = new SpaceSyncEngine(t, { onEvent: (e) => events.push(e), pollMs: 0, debounceMs: 50 });
    const space: SyncSpace = { id: 'project:norep', kind: 'project', root: tmp };
    await engine.addSpace(space);
    await engine.syncSpace(space);
    await vi.waitFor(() => expect(events.some(e => e.type === 'error' && e.errorCode === 'repo-corrupt')).toBe(true), { timeout: WAIT_MS });
    await engine.stop();
  });
});
