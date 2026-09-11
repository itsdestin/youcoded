// Pins the Conversation Store composition root (conversations/service.ts):
// the startup + periodic reconciler kick, live transcript-event intake
// (debounced activity upserts + prompt mirror/push on turn-end), title/flag
// write-through, and the materialize-on-synced sweep. All collaborators
// (store, mirror, reconciler, sync-spaces) are faked via vi.hoisted, mirroring
// sync-spaces-service.test.ts — this tests ONLY the wiring, not the IO shells.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Real (pure) — used to compute the exact on-disk transcript path the service
// derives, so the quiescence tests can grow the same file the loop stats.
import { ccProjectSlug } from '../src/main/slug-encoding';
// Real (pure) — mirrors localJsonlPath's native branch so Task 8 tests can
// compute the exact ~/.youcoded/sessions/<slug>/<id>.jsonl path the service derives.
import { nativeStoreSlug } from '../src/main/slug-encoding';

// vi.mock factories are hoisted above imports, so shared fake state must be
// created via vi.hoisted for the factories to close over it.
const h = vi.hoisted(() => {
  return {
    // Single fake store instance returned by createConversationStore(root).
    // root() is (re)assigned per createConversationStore call to echo the root
    // the service computed, so spaceTranscriptPath resolution is real.
    store: {
      upsert: vi.fn(async (_p: any) => ({ id: 'x' })),
      get: vi.fn(async () => null),
      list: vi.fn(async (_provider: string): Promise<any[]> => []),
      setFlag: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
      setNote: vi.fn(async () => {}),
      // The store's only destructive op — used solely by the native
      // phantom-record cleanup (2026-07-18).
      remove: vi.fn(async (_provider: string, _id: string) => true),
      root: vi.fn(() => ''),
    },
    // Default reconciler NEVER resolves — that's how the non-blocking-start test
    // (carry-forward 2) proves startConversationStore doesn't await it. Callers
    // attach .catch, so a never-resolving promise causes no unhandled rejection.
    reconcile: vi.fn((_opts: any) => new Promise<number>(() => {})),
    // async (mirrorIn/materializeOut are now Promise-returning) — the real
    // service code calls .catch()/.then()/await on these, which a bare
    // object return would break.
    mirrorIn: vi.fn(async (_o: any) => ({ copied: true })),
    materializeOut: vi.fn(async (_o: any) => ({ copied: true })),
    syncSpacesSyncNow: vi.fn(async (_spaceId?: string) => ({ ok: true })),
    // Awaitable variant (2026-07-18): flushSessionToSpace now pushes via this, not
    // the fire-and-forget syncSpacesSyncNow, so the handoff barrier is real.
    syncSpacesSyncNowAwaited: vi.fn(async (_spaceId?: string, _timeoutMs?: number) => {}),
    // onSyncSpacesEvent subscribers — fireSync() drives them like the real
    // broadcast() fan-out would.
    syncListeners: new Set<(e: any) => void>(),
    managedRoots: null as any,
    // Saved folders returned by the mocked readFolders — configurable so the
    // knownFolders-wiring test can exercise both sources.
    savedFolders: [] as Array<{ path: string }>,
  };
});

vi.mock('../src/main/conversations/conversation-store', () => ({
  createConversationStore: (root: string) => {
    h.store.root = vi.fn(() => root);
    return h.store;
  },
}));
vi.mock('../src/main/conversations/transcript-mirror', () => ({
  mirrorIn: (o: any) => h.mirrorIn(o),
  materializeOut: (o: any) => h.materializeOut(o),
}));
vi.mock('../src/main/conversations/reconciler', () => ({
  reconcile: (o: any) => h.reconcile(o),
}));
vi.mock('../src/main/sync-spaces/service', () => ({
  onSyncSpacesEvent: (fn: (e: any) => void) => {
    h.syncListeners.add(fn);
    return () => h.syncListeners.delete(fn);
  },
  syncSpacesSyncNow: (spaceId?: string) => h.syncSpacesSyncNow(spaceId),
  syncSpacesSyncNowAwaited: (spaceId?: string, timeoutMs?: number) => h.syncSpacesSyncNowAwaited(spaceId, timeoutMs),
  getManagedRoots: () => h.managedRoots,
}));
vi.mock('../src/main/saved-folders', () => ({
  readFolders: () => h.savedFolders,
}));
// ccProjectSlug + shared/types are used REAL (pure / type-only).

function fireSync(e: any): void {
  for (const fn of h.syncListeners) fn(e);
}

async function freshService(opts?: {
  conversationsRoot?: string; projectsDir?: string; topicsDir?: string; device?: string;
  nativeHomeRoot?: string;
}) {
  vi.resetModules();
  const svc = await import('../src/main/conversations/service');
  await svc.startConversationStore(opts);
  return svc;
}

function ev(over: Partial<any>): any {
  return { type: 'user-message', sessionId: 'desktop-1', uuid: 'u', timestamp: 1_700_000_000_000, data: {}, ...over };
}

let tmpRoot = '';

describe('conversations service composition root', () => {
  beforeEach(() => {
    vi.useRealTimers();
    h.syncListeners.clear();
    h.store.upsert.mockReset().mockResolvedValue({ id: 'x' } as any);
    h.store.get.mockReset().mockResolvedValue(null as any);
    h.store.list.mockReset().mockResolvedValue([]);
    h.store.setFlag.mockReset().mockResolvedValue(undefined as any);
    h.store.setTitle.mockReset().mockResolvedValue(undefined as any);
    h.store.setNote.mockReset().mockResolvedValue(undefined as any);
    h.store.remove.mockReset().mockResolvedValue(true as any);
    h.reconcile.mockReset().mockImplementation(() => new Promise<number>(() => {}));
    h.mirrorIn.mockReset().mockResolvedValue({ copied: true } as any);
    h.materializeOut.mockReset().mockResolvedValue({ copied: true } as any);
    h.syncSpacesSyncNow.mockReset().mockResolvedValue({ ok: true } as any);
    h.syncSpacesSyncNowAwaited.mockReset().mockResolvedValue(undefined as any);
    h.savedFolders = [];
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-svc-'));
    h.managedRoots = { personalRoot: path.join(tmpRoot, 'Personal'), listProjects: () => [] };
    // Review fix (MINOR): service.ts's heldForkIds() calls resolve their
    // default state file to ~/.youcoded/slug-repair-state.json with no seam
    // plumbed through from here — without this override these tests read the
    // DEVELOPER'S REAL state file (non-hermetic; this dev machine's file
    // already holds a real fork id, which would silently change what a test
    // observes). Points every heldForkIds() call in this suite at a tmp file
    // instead. See slug-repair-state.ts's defaultStateFile.
    process.env.YOUCODED_SLUG_REPAIR_STATE = path.join(tmpRoot, 'slug-repair-state.json');
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.YOUCODED_SLUG_REPAIR_STATE;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const startOpts = () => ({
    conversationsRoot: path.join(tmpRoot, 'Conversations'),
    projectsDir: path.join(tmpRoot, 'projects'),
    topicsDir: path.join(tmpRoot, 'topics'),
    device: 'test-device',
  });

  // 1 — kicks the reconciler at start, WITHOUT awaiting it (carry-forward 2).
  it('kicks the reconciler at start and resolves even though reconcile never settles', async () => {
    await freshService(startOpts()); // resolves despite the never-resolving reconcile mock
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    const opts = h.reconcile.mock.calls[0][0];
    expect(opts.projectsDir).toBe(startOpts().projectsDir);
    expect(opts.topicsDir).toBe(startOpts().topicsDir);
    expect(opts.device).toBe('test-device');
    expect(typeof opts.mirror).toBe('function');
  });

  // 1a — reconciler-driven mirrors run ONE AT A TIME. WHY: the reconciler mirrors
  // every transcript it scans; started all at once, large copies fill libuv's 4
  // threads and queue live chat reads, lease writes and dns lookups behind them.
  it('reconciler mirrors never overlap: the next copy starts only after the previous settles', async () => {
    let failFirst!: (err: Error) => void;
    h.mirrorIn
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failFirst = reject; }))
      .mockResolvedValue({ copied: true } as any);
    await freshService(startOpts());
    const opts = h.reconcile.mock.calls[0][0];

    opts.mirror(path.join(tmpRoot, 'projects', 'alpha', 'sess-1.jsonl'), 'alpha', 'sess-1');
    opts.mirror(path.join(tmpRoot, 'projects', 'beta', 'sess-2.jsonl'), 'beta', 'sess-2');

    await vi.waitFor(() => expect(h.mirrorIn).toHaveBeenCalledTimes(1));
    // Fixed settle before a NEGATIVE assertion only: gives an overlapping second
    // copy time to start (it would start within a microtask) before we say it didn't.
    await new Promise((r) => setTimeout(r, 50));
    expect(h.mirrorIn).toHaveBeenCalledTimes(1);

    // Release the first by FAILING it — a failed copy must not stop later ones.
    failFirst(new Error('EBUSY'));
    await vi.waitFor(() => expect(h.mirrorIn).toHaveBeenCalledTimes(2));
    expect(h.mirrorIn.mock.calls[1][0].localJsonlPath).toContain('sess-2.jsonl');
  });

  // 1b — the reconciler is handed this device's known folders (managed projects
  // + saved folders) so it can recover exact projectKeys (whole-branch review
  // Finding 1). Without this wiring the reconciler truncates hyphenated names.
  it('passes managed + saved folder paths as knownFolders to the reconciler', async () => {
    h.managedRoots = {
      personalRoot: path.join(tmpRoot, 'Personal'),
      listProjects: () => [{ name: 'youcoded-dev', path: 'C:/Users/desti/youcoded-dev' }],
    };
    h.savedFolders = [{ path: 'C:/Users/desti/notes' }];
    await freshService(startOpts());
    const opts = h.reconcile.mock.calls[0][0];
    expect(opts.knownFolders).toEqual([
      'C:/Users/desti/youcoded-dev', // managed project
      'C:/Users/desti/notes',        // saved folder
    ]);
  });

  // 2 — an event upserts local-truth metadata keyed by the claude id. Asserted
  // via turn-complete (non-debounced) so the exact payload lands synchronously.
  it('an event upserts projectName/originalPath/lastActive/device', async () => {
    const svc = await freshService(startOpts());
    const cwd = path.join(tmpRoot, 'my-project');
    svc.noteSessionStarted('claude-abc', cwd, 'claude');
    svc.noteTranscriptEvent('claude-abc', ev({ type: 'turn-complete', timestamp: 1_700_000_000_000 }), 'claude');
    await Promise.resolve();
    expect(h.store.upsert).toHaveBeenCalledWith(expect.objectContaining({
      id: 'claude-abc',
      provider: 'claude',
      projectName: path.basename(cwd),
      originalPath: cwd,
      lastActive: new Date(1_700_000_000_000).toISOString(),
      device: 'test-device',
    }));
  });

  // 3 — turn-complete additionally mirrors the transcript and pushes 'personal'.
  it('turn-complete mirrors the jsonl and syncs the personal space promptly', async () => {
    const svc = await freshService(startOpts());
    const cwd = path.join(tmpRoot, 'proj-x');
    svc.noteSessionStarted('claude-xyz', cwd, 'claude');
    svc.noteTranscriptEvent('claude-xyz', ev({ type: 'turn-complete' }), 'claude');
    await Promise.resolve();
    expect(h.mirrorIn).toHaveBeenCalledTimes(1);
    const arg = h.mirrorIn.mock.calls[0][0];
    expect(arg.localJsonlPath).toContain('claude-xyz.jsonl');
    expect(arg.localJsonlPath).toContain(startOpts().projectsDir);
    // WHY vi.waitFor: the sync nudge is now CHAINED after mirrorIn resolves
    // (not fired in parallel) — see service.ts noteTranscriptEvent's WHY — so
    // it lands a promise-chain hop or two later than mirrorIn's own call.
    await vi.waitFor(() => expect(h.syncSpacesSyncNow).toHaveBeenCalledWith('personal'));
  });

  // 4 — a personal 'synced'/updated event materializes records that resolve
  // locally; records with no local match are skipped.
  it('synced(updated) event materializes only records whose project resolves locally', async () => {
    const existingDir = path.join(tmpRoot, 'alpha');
    fs.mkdirSync(existingDir, { recursive: true });
    const recA = {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', provider: 'claude',
      projectName: 'alpha', originalPath: existingDir,
      transcriptRef: 'claude/transcripts/alpha/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl',
    };
    const recB = {
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', provider: 'claude',
      projectName: 'ghost', originalPath: path.join(tmpRoot, 'nope-does-not-exist'),
      transcriptRef: 'claude/transcripts/ghost/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl',
    };
    // Set the store records AFTER start so the startup catch-up sweep (which
    // calls store.list synchronously during startConversationStore, before this
    // line) sees an empty list — this test isolates the SYNCED-event sweep.
    const svc = await freshService(startOpts());
    // Task 8: the sweep now lists BOTH provider buckets — gate the fake on the
    // provider arg so these claude-only records aren't double-counted under
    // the native bucket too.
    h.store.list.mockImplementation(async (p: string) => (p === 'claude' ? [recA, recB] : []));
    fireSync({ type: 'synced', spaceId: 'personal', updated: true, pushed: false });
    await vi.waitFor(() => expect(h.materializeOut).toHaveBeenCalled());
    expect(h.materializeOut).toHaveBeenCalledTimes(1);
    const arg = h.materializeOut.mock.calls[0][0];
    expect(arg.spaceTranscriptPath).toContain(recA.transcriptRef.replace(/\//g, path.sep));
    expect(arg.localJsonlPath).toContain(`${recA.id}.jsonl`);
    void svc;
  });

  // 4b — Part 1 (2026-07-13 dogfood): a catch-up sweep runs at STARTUP with no
  // synced event, so a peer version already sitting in the local space from a
  // previous run is materialized on launch. Records are set BEFORE start here so
  // the synchronous startup sweep observes them.
  it('runs a catch-up materialize sweep on startup (no synced event needed)', async () => {
    const dir = path.join(tmpRoot, 'startup-proj');
    fs.mkdirSync(dir, { recursive: true });
    const rec = {
      id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', provider: 'claude',
      projectName: 'startup-proj', originalPath: dir,
      transcriptRef: 'claude/transcripts/startup-proj/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee.jsonl',
    };
    h.store.list.mockImplementation(async (p: string) => (p === 'claude' ? [rec] : []));
    await freshService(startOpts()); // startup sweep fires — no fireSync
    await vi.waitFor(() => expect(h.materializeOut).toHaveBeenCalled());
    expect(h.materializeOut.mock.calls[0][0].localJsonlPath).toContain(`${rec.id}.jsonl`);
  });

  // Review fix 1: the sweep must NEVER touch a LIVE session's transcript. A
  // same-conversation-on-two-devices pull would otherwise materializeOut over
  // the JSONL Claude Code is actively appending to (Windows EPERM containment
  // is unreliable — libuv opens with FILE_SHARE_DELETE; on POSIX the rename
  // always succeeds and CC keeps appending to the unlinked inode → chat view
  // freezes, local turns lost on handle close).
  it('the sweep SKIPS records whose id is a live session; others still materialize', async () => {
    const liveDir = path.join(tmpRoot, 'live-proj');
    const idleDir = path.join(tmpRoot, 'idle-proj');
    fs.mkdirSync(liveDir, { recursive: true });
    fs.mkdirSync(idleDir, { recursive: true });
    const liveRec = {
      id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', provider: 'claude',
      projectName: 'live-proj', originalPath: liveDir,
      transcriptRef: 'claude/transcripts/live-proj/cccccccc-cccc-cccc-cccc-cccccccccccc.jsonl',
    };
    const idleRec = {
      id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', provider: 'claude',
      projectName: 'idle-proj', originalPath: idleDir,
      transcriptRef: 'claude/transcripts/idle-proj/dddddddd-dddd-dddd-dddd-dddddddddddd.jsonl',
    };
    // Records set AFTER start (as in the previous test) so the startup catch-up
    // sweep sees an empty list and this test isolates the SYNCED-event sweep.
    const svc = await freshService(startOpts());
    h.store.list.mockImplementation(async (p: string) => (p === 'claude' ? [liveRec, idleRec] : []));
    svc.noteSessionStarted(liveRec.id, liveDir, 'claude'); // liveRec is a LIVE session here
    fireSync({ type: 'synced', spaceId: 'personal', updated: true, pushed: false });
    await vi.waitFor(() => expect(h.materializeOut).toHaveBeenCalled());
    expect(h.materializeOut).toHaveBeenCalledTimes(1);
    expect(h.materializeOut.mock.calls[0][0].localJsonlPath).toContain(`${idleRec.id}.jsonl`);
  });

  // New (review round 1, IMPORTANT finding): the live-session check at the top
  // of the sweep and materializeOut's actual rename are no longer adjacent —
  // several threadpool steps separate them, and a resume can land in that gap
  // (SessionStart re-acquiring this id, or a takeover resuming right after
  // materializeOne). service.ts passes `shouldCommit: () => !sessions.has(id)`
  // so the real transcript-mirror re-checks liveness right before its rename.
  // Since materializeOut is mocked here, this test instead proves the WIRING:
  // the closure reads LIVE state at call time, not a value snapshotted when
  // the sweep started — calling it again after a session starts must flip.
  it('the shouldCommit passed to materializeOut reflects a session that starts WHILE the copy is pending', async () => {
    const idleDir = path.join(tmpRoot, 'resume-mid-copy-proj');
    fs.mkdirSync(idleDir, { recursive: true });
    const rec = {
      id: 'aaaabbbb-cccc-dddd-eeee-ffff00001111', provider: 'claude',
      projectName: 'resume-mid-copy-proj', originalPath: idleDir,
      transcriptRef: 'claude/transcripts/resume-mid-copy-proj/aaaabbbb-cccc-dddd-eeee-ffff00001111.jsonl',
    };
    const svc = await freshService(startOpts());
    h.store.list.mockImplementation(async (p: string) => (p === 'claude' ? [rec] : []));
    fireSync({ type: 'synced', spaceId: 'personal', updated: true, pushed: false });
    await vi.waitFor(() => expect(h.materializeOut).toHaveBeenCalled());
    const shouldCommit = h.materializeOut.mock.calls[0][0].shouldCommit;
    expect(typeof shouldCommit).toBe('function');
    expect(shouldCommit()).toBe(true); // no live session yet — safe to commit
    svc.noteSessionStarted(rec.id, idleDir, 'claude'); // resume lands mid-copy
    expect(shouldCommit()).toBe(false); // same closure, now refuses the rename
  });

  // Bug 2 Part 2 (Plan 2b Task 7): noteSessionEnded releases the per-session
  // materialize guard. A record that was SKIPPED while its session was live
  // must materialize once the session ends — proven here via the full sweep
  // (store.get returns null by default, so the targeted materialize is a no-op
  // and the sweep is the sole materializer).
  it('noteSessionEnded releases the guard so a later sweep materializes the record', async () => {
    const dir = path.join(tmpRoot, 'ended-proj');
    fs.mkdirSync(dir, { recursive: true });
    const rec = {
      id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', provider: 'claude',
      projectName: 'ended-proj', originalPath: dir,
      transcriptRef: 'claude/transcripts/ended-proj/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee.jsonl',
    };
    const svc = await freshService(startOpts());
    svc.noteSessionStarted(rec.id, dir, 'claude'); // now LIVE → guarded
    // Records set AFTER start + guard (as in the sweep tests above) so the
    // startup catch-up sweep sees an empty list — this test isolates the
    // SYNCED-event sweep and the guard-release path.
    h.store.list.mockImplementation(async (p: string) => (p === 'claude' ? [rec] : []));
    fireSync({ type: 'synced', spaceId: 'personal', updated: true, pushed: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.materializeOut).not.toHaveBeenCalled(); // skipped while live
    svc.noteSessionEnded(rec.id); // releases the guard
    fireSync({ type: 'synced', spaceId: 'personal', updated: true, pushed: false });
    await vi.waitFor(() => expect(h.materializeOut).toHaveBeenCalled());
    expect(h.materializeOut.mock.calls[0][0].localJsonlPath).toContain(`${rec.id}.jsonl`);
  });

  // The targeted materialize gates on the LOCAL transcript being quiescent:
  // session-exit fires before CC finishes flushing its final turn, so the copy
  // waits until the file's size stops changing across one probe interval.
  it('materialize-after-end waits for the local file size to stabilize', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const svc = await import('../src/main/conversations/service');
    await svc.startConversationStore(startOpts());
    const dir = path.join(tmpRoot, 'quiesce-proj');
    fs.mkdirSync(dir, { recursive: true });
    const id = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const rec = {
      id, provider: 'claude', projectName: 'quiesce-proj', originalPath: dir,
      transcriptRef: `claude/transcripts/quiesce-proj/${id}.jsonl`,
    };
    h.store.get.mockResolvedValue(rec as any);
    // The exact on-disk path the loop stats — mirror localJsonlPath's derivation.
    const localPath = path.join(startOpts().projectsDir, ccProjectSlug(dir), `${id}.jsonl`);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, 'aaaa'); // initial size

    svc.noteSessionStarted(id, dir, 'claude');
    svc.noteSessionEnded(id);            // kicks the async targeted materialize
    await vi.advanceTimersByTimeAsync(0); // flush get() → first stat → arm probe
    // Grow the file mid-wait: the next probe sees a DIFFERENT size, so the copy
    // must NOT have happened yet.
    fs.writeFileSync(localPath, 'aaaabbbbcccc');
    await vi.advanceTimersByTimeAsync(750); // probe 2: size changed → keep waiting
    expect(h.materializeOut).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(750); // probe 3: size stable → copy now
    expect(h.materializeOut).toHaveBeenCalledTimes(1);
    expect(h.materializeOut.mock.calls[0][0].localJsonlPath).toBe(localPath);
    svc.stopConversationStore();
    vi.useRealTimers();
  });

  // The targeted materialize touches ONLY the ended session's record — it is
  // NOT a full-store scan (that's materializeSweep's job).
  it('materialize-after-end is targeted to the ended session only', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const svc = await import('../src/main/conversations/service');
    await svc.startConversationStore(startOpts());
    const dirA = path.join(tmpRoot, 'targ-a');
    const dirB = path.join(tmpRoot, 'targ-b');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    const recA = {
      id: 'aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa', provider: 'claude',
      projectName: 'targ-a', originalPath: dirA,
      transcriptRef: 'claude/transcripts/targ-a/aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl',
    };
    const recB = {
      id: 'bbbb2222-bbbb-bbbb-bbbb-bbbbbbbbbbbb', provider: 'claude',
      projectName: 'targ-b', originalPath: dirB,
      transcriptRef: 'claude/transcripts/targ-b/bbbb2222-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl',
    };
    // get resolves the requested id; list (the sweep path) would return BOTH —
    // asserting a single materializeOut proves the ended path never full-scans.
    h.store.get.mockImplementation(async (_p: string, gid: string) => (gid === recA.id ? recA : recB) as any);
    h.store.list.mockResolvedValue([recA, recB] as any);

    svc.noteSessionStarted(recA.id, dirA, 'claude');
    svc.noteSessionEnded(recA.id);
    await vi.advanceTimersByTimeAsync(0);   // flush get() → first stat (absent → size 0) → arm probe
    await vi.advanceTimersByTimeAsync(750); // probe 2: size 0 stable → copy recA only
    expect(h.materializeOut).toHaveBeenCalledTimes(1);
    expect(h.materializeOut.mock.calls[0][0].localJsonlPath).toContain(`${recA.id}.jsonl`);
    svc.stopConversationStore();
    vi.useRealTimers();
  });

  // Data-loss guard: if the local transcript NEVER stops growing before
  // QUIESCE_MAX_MS, CC is still flushing — the materialize must SKIP, never
  // rename over the file CC still has open (POSIX inode-detach → chat freeze +
  // lost turns). The reconciler/startup sweep catch up once it's quiet.
  it('materialize-after-end SKIPS (does not materialize) when the file never stabilizes', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const svc = await import('../src/main/conversations/service');
    await svc.startConversationStore(startOpts());
    const dir = path.join(tmpRoot, 'grow-forever');
    fs.mkdirSync(dir, { recursive: true });
    const id = '11111111-1111-1111-1111-111111111111';
    const rec = {
      id, provider: 'claude', projectName: 'grow-forever', originalPath: dir,
      transcriptRef: `claude/transcripts/grow-forever/${id}.jsonl`,
    };
    h.store.get.mockResolvedValue(rec as any);
    // Make statSync report an ever-growing size on EVERY probe so quiescence is
    // never reached (simulates CC still flushing the whole time).
    let sz = 100;
    const statSpy = vi.spyOn(fs, 'statSync').mockImplementation(() => ({ size: (sz += 100) } as any));

    svc.noteSessionStarted(id, dir, 'claude');
    svc.noteSessionEnded(id);
    // Advance well past QUIESCE_MAX_MS (6s) — every probe sees a bigger size.
    for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(750);
    expect(h.materializeOut).not.toHaveBeenCalled();

    statSpy.mockRestore();
    svc.stopConversationStore();
    vi.useRealTimers();
  });

  // Re-open guard: if the SAME session restarts during the quiescence wait, the
  // live guard wins — the targeted materialize must NOT touch the transcript CC
  // is now appending to again.
  it('materialize-after-end skips when the session is re-opened during the wait', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const svc = await import('../src/main/conversations/service');
    await svc.startConversationStore(startOpts());
    const dir = path.join(tmpRoot, 'reopen-proj');
    fs.mkdirSync(dir, { recursive: true });
    const id = '22222222-2222-2222-2222-222222222222';
    const rec = {
      id, provider: 'claude', projectName: 'reopen-proj', originalPath: dir,
      transcriptRef: `claude/transcripts/reopen-proj/${id}.jsonl`,
    };
    h.store.get.mockResolvedValue(rec as any);
    // Local file absent (size 0), so it would reach quiescence on probe 2 — but
    // we re-open the session first, and the post-wait guard must win.
    svc.noteSessionStarted(id, dir, 'claude');
    svc.noteSessionEnded(id);              // deletes guard, kicks async materialize
    await vi.advanceTimersByTimeAsync(0);  // flush get() → first probe (size 0) → arm sleep
    svc.noteSessionStarted(id, dir, 'claude');       // session re-opens mid-wait → re-adds the guard
    await vi.advanceTimersByTimeAsync(750); // probe 2: size 0 stable → quiesced, but guard is set
    expect(h.materializeOut).not.toHaveBeenCalled();
    svc.stopConversationStore();
    vi.useRealTimers();
  });

  // Plan 2b Task 8: flushSessionToSpace waits for the local transcript to go
  // quiescent, then mirrors local->space and nudges a personal-space sync. Used
  // by the holder-side takeover to push the FINAL interrupted turn before the
  // lease releases. Unlike materializeEndedSession it pushes REGARDLESS of the
  // quiescence result (mirrorIn is grow-only, never touches CC's open file).
  it('flushSessionToSpace mirrors local->space after quiescence and pushes personal', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const svc = await import('../src/main/conversations/service');
    await svc.startConversationStore(startOpts());
    const dir = path.join(tmpRoot, 'flush-proj');
    fs.mkdirSync(dir, { recursive: true });
    const id = '33333333-3333-3333-3333-333333333333';
    // Seed the local transcript at the exact path the service derives, stable size.
    const localPath = path.join(startOpts().projectsDir, ccProjectSlug(dir), `${id}.jsonl`);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, 'the-final-turn');

    svc.noteSessionStarted(id, dir, 'claude'); // learn the cwd so flush can locate the file
    const p = svc.flushSessionToSpace(id);
    await vi.advanceTimersByTimeAsync(0);   // first stat → arm the probe sleep
    await vi.advanceTimersByTimeAsync(750); // probe 2: size stable → quiescent → mirror + push
    await p;
    expect(h.mirrorIn).toHaveBeenCalledTimes(1);
    expect(h.mirrorIn.mock.calls[0][0].localJsonlPath).toBe(localPath);
    // Space transcript path is <root>/claude/transcripts/<projectKey>/<id>.jsonl.
    expect(h.mirrorIn.mock.calls[0][0].spaceTranscriptPath).toContain(`${id}.jsonl`);
    // flush pushes via the AWAITABLE variant (mirror-before-release barrier), not
    // the fire-and-forget syncSpacesSyncNow.
    expect(h.syncSpacesSyncNowAwaited).toHaveBeenCalledWith('personal', expect.any(Number));
    svc.stopConversationStore();
    vi.useRealTimers();
  });

  // No known cwd for the id → flush is a silent no-op (can't locate the transcript).
  it('flushSessionToSpace with no known session is a no-op', async () => {
    const svc = await freshService(startOpts());
    await svc.flushSessionToSpace('never-announced');
    expect(h.mirrorIn).not.toHaveBeenCalled();
    expect(h.syncSpacesSyncNowAwaited).not.toHaveBeenCalled();
  });

  // Store not started (or stopped) → noteSessionEnded must be a silent no-op,
  // never a throw (it's called from the session-exit IPC handler).
  it('noteSessionEnded with no store is a no-op and never throws', async () => {
    vi.resetModules();
    const svc = await import('../src/main/conversations/service');
    // store is null (startConversationStore never called this module instance).
    expect(() => svc.noteSessionEnded('claude-no-store')).not.toThrow();
    expect(h.materializeOut).not.toHaveBeenCalled();
  });

  // Review fix 4: start must be idempotent — a second start without stop must
  // not leak the first sync-spaces subscription (duplicate sweeps forever) or
  // the first periodic interval.
  it('a second start without stop leaves exactly ONE subscription and ONE interval', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const svc = await import('../src/main/conversations/service');
    await svc.startConversationStore(startOpts());
    await svc.startConversationStore(startOpts()); // double start — no stop between
    // Exactly one sweep per synced event ⇒ store.list called once PER PROVIDER
    // bucket (Task 8 widened the sweep to list both 'claude' and 'native').
    h.store.list.mockClear();
    fireSync({ type: 'synced', spaceId: 'personal', updated: true, pushed: false });
    await vi.waitFor(() => expect(h.store.list).toHaveBeenCalled());
    expect(h.store.list).toHaveBeenCalledTimes(2);
    expect(h.store.list).toHaveBeenCalledWith('claude');
    expect(h.store.list).toHaveBeenCalledWith('native');
    // Exactly one periodic interval ⇒ one reconcile per 30-min tick.
    h.reconcile.mockClear();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    svc.stopConversationStore();
    vi.useRealTimers();
  });

  // Security: transcriptRef arrives from synced peer records (and is reachable
  // over remote WS). A crafted record must never let materialize join outside
  // the space root — same refuse-on-escape stance as providerDir/recordPath in
  // conversation-store.ts.
  describe('transcriptRef containment guard', () => {
    it('containedTranscriptPath accepts a normal relative ref and refuses traversal/absolute/empty refs', async () => {
      const svc = await freshService(startOpts());
      const root = path.join(tmpRoot, 'space-root');
      expect(svc.containedTranscriptPath(root, 'claude/transcripts/a/b.jsonl'))
        .toBe(path.resolve(root, 'claude/transcripts/a/b.jsonl'));
      expect(svc.containedTranscriptPath(root, '../../outside/x.jsonl')).toBeNull();
      expect(svc.containedTranscriptPath(root, path.resolve(tmpRoot, 'outside', 'y.jsonl'))).toBeNull();
      expect(svc.containedTranscriptPath(root, '')).toBeNull();
    });

    // I1 (final review): pins the trailing `+ path.sep` in containedTranscriptPath.
    // A SIBLING-PREFIX dir shares the root's string prefix but is a DIFFERENT
    // directory — root `<p>/space`, ref resolving to `<p>/space-evil`. A bare
    // `startsWith(resolvedRoot)` (dropping `+ path.sep`) would WRONGLY accept it;
    // the sep-terminated boundary is what refuses it. Mutation-verified: without
    // the `+ path.sep` this assertion goes red (the escape is accepted).
    it('containedTranscriptPath refuses a sibling-prefix dir that shares the root name (pins the trailing path.sep)', async () => {
      const svc = await freshService(startOpts());
      const root = path.join(tmpRoot, 'x', 'space');
      // Resolves to <p>/space-evil/t.jsonl — same string prefix as <p>/space,
      // different dir. MUST be refused.
      expect(svc.containedTranscriptPath(root, path.join('..', 'space-evil', 't.jsonl'))).toBeNull();
      // Control: a subdir LITERALLY named the same is genuinely inside (under
      // root + sep), so it must still be accepted — proves the guard refuses the
      // sibling specifically, not everything containing 'space-evil'.
      expect(svc.containedTranscriptPath(root, path.join('space-evil', 't.jsonl')))
        .toBe(path.resolve(root, 'space-evil', 't.jsonl'));
    });

    // I1 integration twin: the same sibling-prefix escape refused at the
    // materializeOne level. The ref keeps its `claude/` lane prefix (so it clears
    // the lane assertion that runs FIRST) yet resolves to a sibling of the space
    // root — proving the containment guard, not the lane check, is what stops the
    // materialize. root here is <tmpRoot>/Conversations, so the sibling is
    // <tmpRoot>/Conversations-evil. Mutation-verified alongside the unit case.
    it('materializeOne refuses a sibling-prefix escape that still passes the lane check', async () => {
      const svc = await freshService(startOpts());
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const dir = path.join(tmpRoot, 'sibling-proj');
      fs.mkdirSync(dir, { recursive: true });
      const rec = {
        id: 'sibling-escape-1', provider: 'claude', projectName: 'sibling-proj', originalPath: dir,
        // Starts with 'claude/' (passes the lane assertion) but resolves to
        // <tmpRoot>/Conversations-evil/... — a sibling-prefix of the space root.
        transcriptRef: 'claude/../../Conversations-evil/sibling-escape-1.jsonl',
      };
      h.store.get.mockResolvedValue(rec as any);
      await svc.materializeOne('sibling-escape-1', dir);
      expect(h.materializeOut).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('escaping space root'), 'sibling-escape-1');
      warnSpy.mockRestore();
    });

    it('materializeOne refuses a transcriptRef that escapes the space root', async () => {
      const svc = await freshService(startOpts());
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const dir = path.join(tmpRoot, 'escape-proj');
      fs.mkdirSync(dir, { recursive: true });
      const rec = {
        id: 'escaping-1', provider: 'claude', projectName: 'escape-proj', originalPath: dir,
        transcriptRef: '../../outside/x.jsonl',
      };
      h.store.get.mockResolvedValue(rec as any);
      await svc.materializeOne('escaping-1', dir);
      expect(h.materializeOut).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('refused transcriptRef'), 'escaping-1');
      warnSpy.mockRestore();
    });

    it('materializeOne refuses an absolute transcriptRef', async () => {
      const svc = await freshService(startOpts());
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const dir = path.join(tmpRoot, 'escape-proj-abs');
      fs.mkdirSync(dir, { recursive: true });
      const rec = {
        id: 'escaping-2', provider: 'claude', projectName: 'escape-proj-abs', originalPath: dir,
        transcriptRef: path.resolve(tmpRoot, 'outside', 'y.jsonl'),
      };
      h.store.get.mockResolvedValue(rec as any);
      await svc.materializeOne('escaping-2', dir);
      expect(h.materializeOut).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('refused transcriptRef'), 'escaping-2');
      warnSpy.mockRestore();
    });

    it('materializeSweep refuses an escaping record but still materializes a valid one', async () => {
      await freshService(startOpts());
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const goodDir = path.join(tmpRoot, 'good-proj');
      const badDir = path.join(tmpRoot, 'bad-proj');
      fs.mkdirSync(goodDir, { recursive: true });
      fs.mkdirSync(badDir, { recursive: true });
      const badRec = {
        id: 'bad-rec', provider: 'claude', projectName: 'bad-proj', originalPath: badDir,
        transcriptRef: '../../outside/z.jsonl',
      };
      const goodRec = {
        id: 'good-rec', provider: 'claude', projectName: 'good-proj', originalPath: goodDir,
        transcriptRef: 'claude/transcripts/good-proj/good-rec.jsonl',
      };
      h.store.list.mockImplementation(async (p: string) => (p === 'claude' ? [badRec, goodRec] : []));
      fireSync({ type: 'synced', spaceId: 'personal', updated: true, pushed: false });
      await vi.waitFor(() => expect(h.materializeOut).toHaveBeenCalled());
      expect(h.materializeOut).toHaveBeenCalledTimes(1);
      expect(h.materializeOut.mock.calls[0][0].localJsonlPath).toContain('good-rec.jsonl');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('refused transcriptRef'), 'bad-rec');
      warnSpy.mockRestore();
    });
  });

  it('a non-personal or non-updated synced event does NOT materialize', async () => {
    h.store.list.mockResolvedValue([{ id: 'x', provider: 'claude', projectName: 'a', originalPath: '/x', transcriptRef: 'claude/transcripts/a/x.jsonl' }] as any);
    await freshService(startOpts());
    fireSync({ type: 'synced', spaceId: 'project:alpha', updated: true, pushed: false }); // wrong space
    fireSync({ type: 'synced', spaceId: 'personal', updated: false, pushed: true });      // not updated
    await new Promise((r) => setTimeout(r, 20));
    expect(h.materializeOut).not.toHaveBeenCalled();
  });

  // 5 — title write-through.
  it('noteTitleChanged writes through to store.setTitle', async () => {
    const svc = await freshService(startOpts());
    svc.noteTitleChanged('claude-t', 'My Title', 'claude');
    expect(h.store.setTitle).toHaveBeenCalledWith('claude', 'claude-t', 'My Title');
  });

  // 6 — flag write-through. The 4th arg is now `knownNative` (boolean): false
  // means "not live/on-disk native" → the write probes the store's native bucket
  // and, finding nothing (default mock returns null), lands in the claude bucket.
  it('noteFlagChanged writes through to store.setFlag (knownNative=false, no native record → claude)', async () => {
    const svc = await freshService(startOpts());
    await svc.noteFlagChanged('claude-f', 'complete', true, false);
    expect(h.store.setFlag).toHaveBeenCalledWith('claude', 'claude-f', 'complete', true);
  });

  // C1: knownNative=true (live/on-disk native id) routes the write to native
  // without probing the store.
  it('noteFlagChanged routes to the native bucket when knownNative=true', async () => {
    const svc = await freshService(startOpts());
    await svc.noteFlagChanged('nat-f', 'complete', true, true);
    expect(h.store.setFlag).toHaveBeenCalledWith('native', 'nat-f', 'complete', true);
  });

  // C1: the core misroute fix — knownNative=false, but a native record EXISTS in
  // the store (a store-only native browse row: synced, transcript not local, so
  // isNativeSessionId is false). The write must probe the native bucket and land
  // there, NOT seed a claude phantom.
  it('noteFlagChanged probes the store and routes to native when a store-only native record exists', async () => {
    const svc = await freshService(startOpts());
    h.store.get.mockResolvedValue({ id: 'store-only-nat', provider: 'native' } as any);
    await svc.noteFlagChanged('store-only-nat', 'complete', true, false);
    expect(h.store.get).toHaveBeenCalledWith('native', 'store-only-nat');
    expect(h.store.setFlag).toHaveBeenCalledWith('native', 'store-only-nat', 'complete', true);
    expect(h.store.setFlag).not.toHaveBeenCalledWith('claude', 'store-only-nat', 'complete', true);
  });

  // --- noteModelUsed (Task 3) ------------------------------------------------
  // Never seeds a record on its own (a model-only upsert would be exactly the
  // §3.2 phantom shape) — it either upserts into an EXISTING record right
  // away, or stashes on ctx and rides the next transcript-event upsert.
  describe('noteModelUsed', () => {
    const ref = { modelId: 'claude-opus-4-7', providerType: 'anthropic', providerLabel: 'Claude Pro' };

    it('upserts lastUsedModel immediately when a record already exists', async () => {
      const svc = await freshService(startOpts());
      const dir = path.join(tmpRoot, 'model-proj');
      svc.noteSessionStarted('claude-m1', dir, 'claude');
      h.store.get.mockResolvedValue({ id: 'claude-m1', provider: 'claude' } as any);
      svc.noteModelUsed('claude-m1', ref);
      await new Promise((r) => setTimeout(r, 0));
      expect(h.store.get).toHaveBeenCalledWith('claude', 'claude-m1');
      expect(h.store.upsert).toHaveBeenCalledWith({ id: 'claude-m1', provider: 'claude', lastUsedModel: ref });
    });

    it('does NOT upsert (never seeds a record) when no record exists yet — it rides the next transcript upsert instead', async () => {
      const svc = await freshService(startOpts());
      const dir = path.join(tmpRoot, 'model-proj-2');
      svc.noteSessionStarted('claude-m2', dir, 'claude');
      h.store.get.mockResolvedValue(null); // no record yet
      svc.noteModelUsed('claude-m2', ref);
      await new Promise((r) => setTimeout(r, 0));
      expect(h.store.upsert).not.toHaveBeenCalled();
      // The stashed ref rides the NEXT transcript-event upsert.
      svc.noteTranscriptEvent('claude-m2', ev({ type: 'turn-complete' }), 'claude');
      await Promise.resolve();
      expect(h.store.upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'claude-m2', lastUsedModel: ref }));
    });

    it('is a no-op for a session that never announced itself (no ctx, no provider known)', async () => {
      const svc = await freshService(startOpts());
      svc.noteModelUsed('never-announced', ref);
      await new Promise((r) => setTimeout(r, 0));
      expect(h.store.get).not.toHaveBeenCalled();
      expect(h.store.upsert).not.toHaveBeenCalled();
    });
  });

  // --- Native transcript events (Task 4) -------------------------------------
  // Native sessions ride the SAME noteTranscriptEvent/noteModelUsed entry points
  // as CC, just keyed by sessionProvider:'native' — ipc-handlers.ts's native
  // listener calls noteTranscriptEvent(event.sessionId, event, 'native') directly
  // (native ids are identity-mapped in sessionIdMap, no lookup needed). This pins
  // that the native lane upserts provider:'native' with the native transcriptRef
  // shape and folds in a stashed lastUsedModel — exactly like the CC lane, just
  // parameterized by the threaded provider (Task 3), not a separate code path.
  describe('native transcript events (Task 4)', () => {
    it('native turn-complete upserts a native-lane record carrying lastUsedModel', async () => {
      const svc = await freshService(startOpts());
      svc.noteSessionStarted('nat-1', path.join('/home/d', 'proj'), 'native');
      svc.noteModelUsed('nat-1', { modelId: 'qwen-3', providerType: 'local-engine', providerLabel: 'Local models (llama.cpp)' });
      svc.noteTranscriptEvent('nat-1', ev({ type: 'turn-complete', sessionId: 'nat-1' }), 'native');
      await Promise.resolve();
      const up = h.store.upsert.mock.calls.at(-1)![0];
      expect(up.provider).toBe('native');
      expect(up.transcriptRef).toBe('native/transcripts/proj/nat-1.jsonl');
      expect(up.lastUsedModel?.modelId).toBe('qwen-3');
    });

    // Ordering hazard the plan pins explicitly: the SAME debounce-clear rule the
    // CC path relies on (test above, "turn-complete cancels a pending debounce
    // timer") must also hold for a native-keyed session — it's the same code
    // path keyed by session id, not a provider-specific branch, but the plan
    // asks to confirm rather than assume.
    it('native: turn-complete cancels a pending debounce timer (same ordering rule as CC)', async () => {
      vi.useFakeTimers();
      vi.resetModules();
      const svc = await import('../src/main/conversations/service');
      await svc.startConversationStore(startOpts());
      svc.noteSessionStarted('nat-2', path.join(tmpRoot, 'np'), 'native');
      svc.noteTranscriptEvent('nat-2', ev({ type: 'assistant-text', sessionId: 'nat-2' }), 'native'); // arms debounce
      svc.noteTranscriptEvent('nat-2', ev({ type: 'turn-complete', sessionId: 'nat-2' }), 'native');   // immediate upsert + cancel
      await Promise.resolve();
      expect(h.store.upsert).toHaveBeenCalledTimes(1);
      // The stale debounce timer must NOT fire a second (stale) upsert 5s later.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.store.upsert).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });
  });

  // --- Native flush / materialize (Task 8) -----------------------------------
  // flushSessionToSpace/materializeOne/materializeSweep go fully provider-aware:
  // native sessions mirror their ~/.youcoded/sessions/ transcript into the
  // native/ space lane, and the materialize direction respects the SAME lane
  // (D5, never cross-materialize) plus the live-session guard, kept for native
  // for a different reason than CC's (see the WHY comments in service.ts).
  describe('native flush / materialize (Task 8)', () => {
    it('flushes a native session from ~/.youcoded/sessions into the native/ space lane', async () => {
      vi.useFakeTimers();
      vi.resetModules();
      const svc = await import('../src/main/conversations/service');
      const nativeHomeRoot = path.join(tmpRoot, 'native-home');
      await svc.startConversationStore({ ...startOpts(), nativeHomeRoot });
      const dir = path.join(tmpRoot, 'native-flush-proj');
      fs.mkdirSync(dir, { recursive: true });
      const id = '44444444-4444-4444-4444-444444444444';
      // Seed the local NATIVE transcript at the exact path localJsonlPath derives
      // for provider:'native' — ~/.youcoded/sessions/<nativeStoreSlug(cwd)>/<id>.jsonl.
      const localPath = path.join(nativeHomeRoot, '.youcoded', 'sessions', nativeStoreSlug(dir), `${id}.jsonl`);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, 'native-final-turn');

      svc.noteSessionStarted(id, dir, 'native'); // learn the cwd + NATIVE provider
      const p = svc.flushSessionToSpace(id);
      await vi.advanceTimersByTimeAsync(0);   // first stat → arm the probe sleep
      await vi.advanceTimersByTimeAsync(750); // probe 2: size stable → quiescent → mirror + push
      await p;
      expect(h.mirrorIn).toHaveBeenCalledTimes(1);
      const arg = h.mirrorIn.mock.calls[0][0];
      // Source: the NATIVE local path, not a claude/ projectsDir path.
      expect(arg.localJsonlPath).toBe(localPath);
      // Dest: the native/ space lane, not claude/.
      expect(arg.spaceTranscriptPath).toContain(`native${path.sep}transcripts`);
      expect(arg.spaceTranscriptPath).toContain(`${id}.jsonl`);
      expect(h.syncSpacesSyncNowAwaited).toHaveBeenCalledWith('personal', expect.any(Number));
      svc.stopConversationStore();
      vi.useRealTimers();
    });

    // Honest no-op: a missing local source must never throw and must never
    // block the handoff barrier — flushSessionToSpace doesn't inspect mirrorIn's
    // return value at all, it always proceeds to the awaited sync push. This
    // pins that "copied:false" (the real mirrorIn's answer for a missing local
    // file — see transcript-mirror.test.ts) is a legitimate, silent outcome here.
    it('flush against a MISSING local source discards {copied:false} and pushes nothing, but still syncs (honest no-op, no throw)', async () => {
      vi.useFakeTimers();
      vi.resetModules();
      const svc = await import('../src/main/conversations/service');
      await svc.startConversationStore(startOpts());
      const dir = path.join(tmpRoot, 'missing-source-proj');
      fs.mkdirSync(dir, { recursive: true }); // project dir exists; the TRANSCRIPT file does not
      const id = 'missing-source-1';
      h.mirrorIn.mockResolvedValueOnce({ copied: false }); // what the real mirrorIn returns for an absent local file
      svc.noteSessionStarted(id, dir, 'native');
      const p = svc.flushSessionToSpace(id);
      // Absent local file reads size 0 on every probe → quiescent immediately
      // (waitForQuiescence's own "absent local is quiescent" branch).
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(750);
      await expect(p).resolves.toBeUndefined(); // never throws
      expect(h.mirrorIn).toHaveBeenCalledTimes(1);
      // The push still runs regardless of mirrorIn's result — no early return.
      expect(h.syncSpacesSyncNowAwaited).toHaveBeenCalledWith('personal', expect.any(Number));
      svc.stopConversationStore();
      vi.useRealTimers();
    });

    // Lane assertion (D5): a record's transcriptRef must live under ITS OWN
    // provider's lane. A native record carrying a claude/ ref is mislabeled —
    // refuse rather than materialize it as if it were a CC transcript.
    it('materializeOne refuses a claude/ transcriptRef on a native record (lane mismatch)', async () => {
      const svc = await freshService(startOpts());
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const dir = path.join(tmpRoot, 'lane-mismatch-proj');
      fs.mkdirSync(dir, { recursive: true });
      const rec = {
        id: 'lane-mismatch-1', provider: 'native', projectName: 'lane-mismatch-proj', originalPath: dir,
        // WRONG lane: a native record must be 'native/transcripts/...', not 'claude/...'.
        transcriptRef: 'claude/transcripts/lane-mismatch-proj/lane-mismatch-1.jsonl',
      };
      h.store.get.mockResolvedValue(rec as any);
      await svc.materializeOne('lane-mismatch-1', dir);
      expect(h.materializeOut).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('lane mismatch'), 'lane-mismatch-1');
      warnSpy.mockRestore();
    });

    // materializeOne falls back to the 'native' bucket when 'claude' has no hit,
    // so a native-only id still resolves (proves the try-claude-then-native
    // fallback, not just the shared-mock path the lane-mismatch test rides).
    it('materializeOne finds a native-only id via the claude→native fallback', async () => {
      const svc = await freshService(startOpts());
      const dir = path.join(tmpRoot, 'native-fallback-proj');
      fs.mkdirSync(dir, { recursive: true });
      const rec = {
        id: 'native-fallback-1', provider: 'native', projectName: 'native-fallback-proj', originalPath: dir,
        transcriptRef: 'native/transcripts/native-fallback-proj/native-fallback-1.jsonl',
      };
      h.store.get.mockImplementation(async (p: string, gid: string) => (p === 'native' && gid === rec.id ? rec : null) as any);
      await svc.materializeOne(rec.id, dir);
      expect(h.store.get).toHaveBeenCalledWith('claude', rec.id);
      expect(h.store.get).toHaveBeenCalledWith('native', rec.id);
      expect(h.materializeOut).toHaveBeenCalledTimes(1);
      expect(h.materializeOut.mock.calls[0][0].localJsonlPath).toContain(`${rec.id}.jsonl`);
    });

    // Live-session guard, kept for native for a DIFFERENT reason than CC (no
    // long-lived fd; a mid-session materializeOut would redirect subsequent
    // native appends onto the freshly-materialized file instead of losing an
    // inode) — see the WHY comment in materializeSweep. This proves the sweep
    // actually widens to list('native') AND still honors the guard there.
    it('materialize sweep skips a LIVE native session; an idle native record still materializes', async () => {
      const liveDir = path.join(tmpRoot, 'native-live-proj');
      const idleDir = path.join(tmpRoot, 'native-idle-proj');
      fs.mkdirSync(liveDir, { recursive: true });
      fs.mkdirSync(idleDir, { recursive: true });
      const liveRec = {
        id: 'native-live-1', provider: 'native', projectName: 'native-live-proj', originalPath: liveDir,
        transcriptRef: 'native/transcripts/native-live-proj/native-live-1.jsonl',
      };
      const idleRec = {
        id: 'native-idle-1', provider: 'native', projectName: 'native-idle-proj', originalPath: idleDir,
        transcriptRef: 'native/transcripts/native-idle-proj/native-idle-1.jsonl',
      };
      const svc = await freshService(startOpts());
      h.store.list.mockImplementation(async (p: string) => (p === 'native' ? [liveRec, idleRec] : []));
      svc.noteSessionStarted(liveRec.id, liveDir, 'native'); // liveRec is a LIVE native session
      fireSync({ type: 'synced', spaceId: 'personal', updated: true, pushed: false });
      await vi.waitFor(() => expect(h.materializeOut).toHaveBeenCalled());
      expect(h.materializeOut).toHaveBeenCalledTimes(1);
      expect(h.materializeOut.mock.calls[0][0].localJsonlPath).toContain(`${idleRec.id}.jsonl`);
    });

    // Sweep-level counterpart to "materializeOne refuses a claude/ transcriptRef
    // on a native record" above: the SAME lane assertion runs inside
    // materializeSweep (service.ts ~:479), but until now that copy had ZERO
    // test coverage — neutralizing it broke nothing, silently reopening
    // cross-lane materialization on every 'synced' event AND at every startup
    // sweep (unattended paths, not just the one-off materializeOne call).
    // Proves SKIP-not-abort: the mismatched record is silently skipped while a
    // well-formed sibling in the SAME sweep still materializes.
    it('materializeSweep refuses a lane-mismatched native record but still materializes a valid native sibling', async () => {
      const badDir = path.join(tmpRoot, 'native-lane-bad-proj');
      const goodDir = path.join(tmpRoot, 'native-lane-good-proj');
      fs.mkdirSync(badDir, { recursive: true });
      fs.mkdirSync(goodDir, { recursive: true });
      const badRec = {
        id: 'native-lane-bad-1', provider: 'native', projectName: 'native-lane-bad-proj', originalPath: badDir,
        // WRONG lane: a native record must be 'native/transcripts/...', not 'claude/...'.
        transcriptRef: 'claude/transcripts/native-lane-bad-proj/native-lane-bad-1.jsonl',
      };
      const goodRec = {
        id: 'native-lane-good-1', provider: 'native', projectName: 'native-lane-good-proj', originalPath: goodDir,
        transcriptRef: 'native/transcripts/native-lane-good-proj/native-lane-good-1.jsonl',
      };
      await freshService(startOpts());
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      h.store.list.mockImplementation(async (p: string) => (p === 'native' ? [badRec, goodRec] : []));
      fireSync({ type: 'synced', spaceId: 'personal', updated: true, pushed: false });
      await vi.waitFor(() => expect(h.materializeOut).toHaveBeenCalled());
      expect(h.materializeOut).toHaveBeenCalledTimes(1);
      expect(h.materializeOut.mock.calls[0][0].localJsonlPath).toContain(`${goodRec.id}.jsonl`);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('lane mismatch'), badRec.id);
      warnSpy.mockRestore();
    });
  });

  // --- Meta-write honesty (Item 6) ------------------------------------------
  // IPC meta handlers go live (main.ts:745) before the store starts
  // (main.ts:1701, fire-and-forget) — a tag/flag/note set in that boot window
  // used to silently vanish while the store?. chains no-op'd and the IPC
  // handler still answered ok:true (the 2026-07-19 incident class, for the
  // store-availability dimension). These pin the buffer-until-ready /
  // honest-ok:false behavior at the composition root.
  describe('meta-write buffering (Item 6)', () => {
    it('buffers a flag write made before the store starts, flushes it in order, resolves ok:true', async () => {
      vi.resetModules();
      const svc = await import('../src/main/conversations/service');
      const p1 = svc.noteFlagChanged('id1', 'complete', true, false);   // store not started yet
      const p2 = svc.noteSessionNote('id1', 'note-2', false);
      await svc.startConversationStore(startOpts());
      expect(await p1).toEqual({ ok: true });
      expect(await p2).toEqual({ ok: true });
      const flagOrder = h.store.setFlag.mock.invocationCallOrder[0];
      const noteOrder = h.store.setNote.mock.invocationCallOrder[0];
      expect(flagOrder).toBeLessThan(noteOrder);             // arrival order preserved
      svc.stopConversationStore();
    });

    it('resolves buffered writes ok:false when the store never comes up', async () => {
      vi.resetModules();
      const svc = await import('../src/main/conversations/service');
      const p = svc.noteFlagChanged('id1', 'complete', true, false);
      h.managedRoots = null;                                  // no personal root
      await svc.startConversationStore();
      expect(await p).toEqual({ ok: false });
    });

    it('a rejecting store write resolves ok:false, not ok:true', async () => {
      const svc = await freshService(startOpts());
      h.store.setFlag.mockRejectedValue(new Error('lock timeout'));
      expect(await svc.noteFlagChanged('id1', 'complete', true, false)).toEqual({ ok: false });
    });

    it('a ready store resolves a flag write ok:true immediately (no buffering)', async () => {
      const svc = await freshService(startOpts());
      expect(await svc.noteFlagChanged('id1', 'complete', true, false)).toEqual({ ok: true });
    });

    // stopConversationStore's idempotent-teardown call (fired at the top of
    // EVERY startConversationStore, including the very first) must NOT settle
    // writes that arrived before the store ever got a chance to come up — only
    // a stop of an ALREADY-RUNNING store (app quit / explicit restart) does.
    it('after stopConversationStore on a running store, a NEW write re-buffers instead of resolving', async () => {
      vi.resetModules();
      const svc = await import('../src/main/conversations/service');
      await svc.startConversationStore(startOpts());
      svc.stopConversationStore();
      let settled = false;
      const p = svc.noteFlagChanged('id2', 'complete', true, false).then((r) => { settled = true; return r; });
      await new Promise((r) => setTimeout(r, 10));
      expect(settled).toBe(false);          // still buffered, not resolved yet
      await svc.startConversationStore(startOpts());
      expect(await p).toEqual({ ok: true }); // the restart flushes it
      svc.stopConversationStore();
    });
  });

  // 7 — stop() unsubscribes, clears the periodic timer AND pending debounce timers.
  it('stopConversationStore unsubscribes, stops the periodic reconciler and pending debounces', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const svc = await import('../src/main/conversations/service');
    await svc.startConversationStore(startOpts());
    expect(h.reconcile).toHaveBeenCalledTimes(1); // start kick
    // Advance one periodic interval — reconcile fires again.
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(h.reconcile).toHaveBeenCalledTimes(2);
    // Arm a pending debounce for a chatty event, then stop BEFORE its 5s window.
    svc.noteSessionStarted('claude-s', path.join(tmpRoot, 'p'), 'claude');
    svc.noteTranscriptEvent('claude-s', ev({ type: 'assistant-text' }), 'claude');
    svc.stopConversationStore();
    // A synced event after stop does nothing (unsubscribed + store nulled).
    fireSync({ type: 'synced', spaceId: 'personal', updated: true, pushed: false });
    // Advance well past the periodic interval AND the debounce window.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(h.reconcile).toHaveBeenCalledTimes(2);   // periodic timer cleared
    expect(h.materializeOut).not.toHaveBeenCalled(); // unsubscribed
    expect(h.store.upsert).not.toHaveBeenCalled();   // pending debounce cleared
    vi.useRealTimers();
  });

  // 8 — events for sessions never announced still upsert (no cwd known).
  it('an event for an unannounced session upserts with no originalPath', async () => {
    const svc = await freshService(startOpts());
    svc.noteTranscriptEvent('claude-unknown', ev({ type: 'turn-complete' }), 'claude');
    await Promise.resolve();
    expect(h.store.upsert).toHaveBeenCalledTimes(1);
    const arg = h.store.upsert.mock.calls[0][0];
    expect(arg.id).toBe('claude-unknown');
    expect(arg.provider).toBe('claude');
    expect(arg.originalPath).toBeUndefined();
    expect(arg.projectName).toBeUndefined();
  });

  // 9 — chatty events debounce to ONE upsert; turn-complete cancels the pending one.
  it('two rapid chatty events coalesce into ONE upsert after the debounce window', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const svc = await import('../src/main/conversations/service');
    await svc.startConversationStore(startOpts());
    svc.noteSessionStarted('claude-d', path.join(tmpRoot, 'd'), 'claude');
    svc.noteTranscriptEvent('claude-d', ev({ type: 'assistant-text', uuid: 'a1' }), 'claude');
    svc.noteTranscriptEvent('claude-d', ev({ type: 'assistant-text', uuid: 'a2' }), 'claude');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.store.upsert).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('turn-complete cancels a pending debounce timer (no extra upsert later)', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const svc = await import('../src/main/conversations/service');
    await svc.startConversationStore(startOpts());
    svc.noteSessionStarted('claude-c', path.join(tmpRoot, 'c'), 'claude');
    svc.noteTranscriptEvent('claude-c', ev({ type: 'assistant-text' }), 'claude'); // arms debounce
    svc.noteTranscriptEvent('claude-c', ev({ type: 'turn-complete' }), 'claude');   // immediate upsert + cancel
    await Promise.resolve();
    expect(h.store.upsert).toHaveBeenCalledTimes(1);
    // The stale debounce timer must NOT fire a second upsert 5s later.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.store.upsert).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  // 10 — a store.upsert rejection does not produce an unhandled rejection.
  it('a rejecting store.upsert is swallowed (no unhandled rejection)', async () => {
    h.store.upsert.mockRejectedValue(new Error('lock timeout'));
    const svc = await freshService(startOpts());
    svc.noteSessionStarted('claude-r', path.join(tmpRoot, 'r'), 'claude');
    svc.noteTranscriptEvent('claude-r', ev({ type: 'turn-complete' }), 'claude');
    await new Promise((r) => setTimeout(r, 10));
    // World keeps turning: the prompt push still fired despite the upsert reject.
    expect(h.syncSpacesSyncNow).toHaveBeenCalledWith('personal');
  });

  // --- Native phantom-record cleanup (2026-07-18) -------------------------
  //
  // PR #176 started mapping native sessions in sessionIdMap, which defeated the
  // phantom-record gate in ipc-handlers: flagging or noting a NATIVE session
  // seeded a record under claude/ with a hardcoded provider and blank metadata,
  // which synced everywhere and was never pruned. These pin the cleanup that
  // clears the ones already written — and, just as importantly, that it does
  // NOT touch anything else (it is the store's only destructive caller).
  describe('pruneNativePhantomRecords', () => {
    // A record with the phantom signature: blank refs/metadata, EPOCH lastActive.
    const phantom = (id: string) => ({
      schema: 1, id, provider: 'claude', projectName: '', originalPath: '', title: '',
      lastActive: '1970-01-01T00:00:00.000Z', device: '', flags: { complete: { value: true, updatedAt: 'x' } },
      transcriptRef: '', createdAt: 'x', note: '', noteUpdatedAt: 'x',
    });
    // Lay down ~/.youcoded/sessions/<slug>/<id>.jsonl so the id reads as native.
    function seedNativeSession(homeRoot: string, id: string) {
      const dir = path.join(homeRoot, '.youcoded', 'sessions', 'proj-slug');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${id}.jsonl`), '{"v":1}\n');
    }

    it('removes a phantom whose id is a real native session', async () => {
      const homeRoot = path.join(tmpRoot, 'nh-hit');
      seedNativeSession(homeRoot, 'native-1');
      h.store.list.mockResolvedValue([phantom('native-1')]);
      const svc = await freshService({ ...startOpts(), nativeHomeRoot: homeRoot });
      const pruned = await svc.pruneNativePhantomRecords({ nativeHomeRoot: homeRoot });
      expect(pruned).toBe(1);
      expect(h.store.remove).toHaveBeenCalledWith('claude', 'native-1');
    });

    it('leaves a phantom-shaped record alone when no native session file exists', async () => {
      const homeRoot = path.join(tmpRoot, 'nh-miss');
      fs.mkdirSync(homeRoot, { recursive: true });   // exists, but no sessions
      h.store.list.mockResolvedValue([phantom('not-native')]);
      const svc = await freshService({ ...startOpts(), nativeHomeRoot: homeRoot });
      // The shape alone must never be enough — confirmation that the id IS
      // native is what separates junk from a record we simply can't explain.
      expect(await svc.pruneNativePhantomRecords({ nativeHomeRoot: homeRoot })).toBe(0);
      expect(h.store.remove).not.toHaveBeenCalled();
    });

    it('never removes a record carrying real data, even for a native id', async () => {
      const homeRoot = path.join(tmpRoot, 'nh-real');
      seedNativeSession(homeRoot, 'native-2');
      h.store.list.mockResolvedValue([
        // Each of these differs from the phantom signature by ONE field. All must survive.
        { ...phantom('native-2'), transcriptRef: 'claude/transcripts/p/native-2.jsonl' },
        { ...phantom('native-2'), projectName: 'youcoded-dev' },
        { ...phantom('native-2'), originalPath: '/home/d/p' },
        { ...phantom('native-2'), lastActive: '2026-07-18T00:00:00.000Z' },
      ]);
      const svc = await freshService({ ...startOpts(), nativeHomeRoot: homeRoot });
      expect(await svc.pruneNativePhantomRecords({ nativeHomeRoot: homeRoot })).toBe(0);
      expect(h.store.remove).not.toHaveBeenCalled();
    });

    it('is idempotent — a second pass finds nothing', async () => {
      const homeRoot = path.join(tmpRoot, 'nh-idem');
      seedNativeSession(homeRoot, 'native-3');
      h.store.list.mockResolvedValue([phantom('native-3')]);
      const svc = await freshService({ ...startOpts(), nativeHomeRoot: homeRoot });
      expect(await svc.pruneNativePhantomRecords({ nativeHomeRoot: homeRoot })).toBe(1);
      h.store.list.mockResolvedValue([]);   // the record is gone now
      expect(await svc.pruneNativePhantomRecords({ nativeHomeRoot: homeRoot })).toBe(0);
    });

    // Task 4 regression: now that Task 4 wires real native/ records into the
    // store (provider:'native'), this MUST never list or remove from that
    // bucket — a legit native/ record is never even candidate-listed because
    // the cleanup lists ONLY 'claude' (see the WHY comment at its list() call).
    it('never lists or touches the native bucket — a legit native/ record survives untouched', async () => {
      const homeRoot = path.join(tmpRoot, 'nh-native-safe');
      seedNativeSession(homeRoot, 'native-4');
      // Start with a benign list() so startup's own materializeSweep — which
      // Task 8 legitimately widened to list BOTH provider buckets — doesn't
      // trip the throwing impl below. That widening is a DIFFERENT function's
      // job; this test only asserts about pruneNativePhantomRecords's own
      // list() call, so the throwing mock is swapped in AFTER start, isolating
      // it to the explicit prune call made below.
      h.store.list.mockResolvedValue([]);
      const svc = await freshService({ ...startOpts(), nativeHomeRoot: homeRoot });
      h.store.list.mockReset();
      h.store.list.mockImplementation(async (provider: string) => {
        if (provider === 'native') throw new Error('pruneNativePhantomRecords must never list the native bucket');
        return [];
      });
      expect(await svc.pruneNativePhantomRecords({ nativeHomeRoot: homeRoot })).toBe(0);
      expect(h.store.list).toHaveBeenCalledWith('claude');
      expect(h.store.list).not.toHaveBeenCalledWith('native');
      expect(h.store.remove).not.toHaveBeenCalled();
    });
  });

  // Guard: no managed roots + no explicit root → store stays off (no reconcile).
  it('stays off when neither an explicit root nor managed roots are available', async () => {
    h.managedRoots = null;
    vi.resetModules();
    const svc = await import('../src/main/conversations/service');
    await svc.startConversationStore(); // no opts, no managed roots
    expect(h.reconcile).not.toHaveBeenCalled();
    svc.stopConversationStore();
  });
});
