// Conversation Store composition root (conversations/service.ts): the startup + periodic reconciler kick,
// live transcript-event intake (debounced upserts + mirror/push on turn-end), title/flag write-through,
// and the materialize-on-synced sweep. Every collaborator is faked via vi.hoisted — this tests ONLY the wiring.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Real (pure) — compute the exact on-disk transcript paths the service derives.
import { ccProjectSlug, nativeStoreSlug } from '../src/main/slug-encoding';

// vi.mock factories are hoisted above imports, so shared fake state must come from vi.hoisted.
const h = vi.hoisted(() => ({
  store: {
    upsert: vi.fn(async (_p: any) => ({ id: 'x' })),
    get: vi.fn(async (_provider: string, _id: string): Promise<any> => null),
    list: vi.fn(async (_provider: string): Promise<any[]> => []),
    setFlag: vi.fn(async () => {}),
    setTitle: vi.fn(async () => {}),
    setNote: vi.fn(async () => {}),
    // The store's only destructive op — used solely by the native phantom-record cleanup.
    remove: vi.fn(async (_provider: string, _id: string) => true),
    root: vi.fn(() => ''),
  },
  // Default reconciler NEVER resolves: that is how the non-blocking-start test proves start doesn't await it.
  reconcile: vi.fn((_opts: any) => new Promise<number>(() => {})),
  mirrorIn: vi.fn(async (_o: any) => ({ copied: true })),
  materializeOut: vi.fn(async (_o: any) => ({ copied: true })),
  syncSpacesSyncNow: vi.fn(async (_spaceId?: string) => ({ ok: true })),
  // Awaitable variant: flushSessionToSpace pushes via this so the handoff barrier is real.
  syncSpacesSyncNowAwaited: vi.fn(async (_spaceId?: string, _timeoutMs?: number) => {}),
  syncListeners: new Set<(e: any) => void>(),
  managedRoots: null as any,
  savedFolders: [] as Array<{ path: string }>,
}));

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
vi.mock('../src/main/conversations/reconciler', () => ({ reconcile: (o: any) => h.reconcile(o) }));
vi.mock('../src/main/sync-spaces/service', () => ({
  onSyncSpacesEvent: (fn: (e: any) => void) => {
    h.syncListeners.add(fn);
    return () => h.syncListeners.delete(fn);
  },
  syncSpacesSyncNow: (spaceId?: string) => h.syncSpacesSyncNow(spaceId),
  syncSpacesSyncNowAwaited: (spaceId?: string, timeoutMs?: number) => h.syncSpacesSyncNowAwaited(spaceId, timeoutMs),
  getManagedRoots: () => h.managedRoots,
}));
vi.mock('../src/main/saved-folders', () => ({ readFolders: () => h.savedFolders }));

type Svc = typeof import('../src/main/conversations/service');
let tmpRoot = '';
let live: Svc | undefined;

const fireSync = (e: any) => { for (const fn of h.syncListeners) fn(e); };
const fireSynced = () => fireSync({ type: 'synced', spaceId: 'personal', updated: true, pushed: false });
const ev = (over: Partial<any>): any => ({ type: 'user-message', sessionId: 'desktop-1', uuid: 'u', timestamp: 1_700_000_000_000, data: {}, ...over });
const startOpts = (extra?: Record<string, unknown>) => ({
  conversationsRoot: path.join(tmpRoot, 'Conversations'),
  projectsDir: path.join(tmpRoot, 'projects'),
  topicsDir: path.join(tmpRoot, 'topics'),
  device: 'test-device',
  ...extra,
});
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const wait750 = async () => { await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(750); };

async function freshService(opts: any = startOpts()): Promise<Svc> {
  vi.resetModules();
  const svc = await import('../src/main/conversations/service');
  live = svc;
  await svc.startConversationStore(opts);
  return svc;
}
/** Same, under fake timers (for quiescence / debounce / periodic-tick cases). */
async function fakeService(opts: any = startOpts()): Promise<Svc> {
  vi.useFakeTimers();
  return freshService(opts);
}
/** A store record whose project dir exists on disk; ref defaults to the provider's own lane. */
function mkRec(name: string, o: { id?: string; provider?: string; ref?: string; mkdir?: boolean } = {}) {
  const originalPath = path.join(tmpRoot, name);
  if (o.mkdir !== false) fs.mkdirSync(originalPath, { recursive: true });
  const id = o.id ?? name;
  const provider = o.provider ?? 'claude';
  return { id, provider, projectName: name, originalPath, transcriptRef: o.ref ?? `${provider}/transcripts/${name}/${id}.jsonl` };
}
const listOnly = (provider: string, recs: any[]) =>
  h.store.list.mockImplementation(async (p: string) => (p === provider ? recs : []));
const lastMaterialized = () => h.materializeOut.mock.calls[0][0].localJsonlPath as string;

/** Resets every fake; `reconcileImpl` differs between the two suites below. */
function resetFakes(prefix: string, reconcileImpl: () => void, sync: boolean) {
  vi.useRealTimers();
  h.syncListeners.clear();
  h.store.upsert.mockReset().mockResolvedValue({ id: 'x' } as any);
  h.store.get.mockReset().mockResolvedValue(null as any);
  h.store.list.mockReset().mockResolvedValue([]);
  h.store.setFlag.mockReset().mockResolvedValue(undefined as any);
  h.store.setTitle.mockReset().mockResolvedValue(undefined as any);
  h.store.setNote.mockReset().mockResolvedValue(undefined as any);
  h.store.remove.mockReset().mockResolvedValue(true as any);
  reconcileImpl();
  const copied = { copied: true } as any;
  if (sync) { h.mirrorIn.mockReset().mockReturnValue(copied); h.materializeOut.mockReset().mockReturnValue(copied); }
  else { h.mirrorIn.mockReset().mockResolvedValue(copied); h.materializeOut.mockReset().mockResolvedValue(copied); }
  h.syncSpacesSyncNow.mockReset().mockResolvedValue({ ok: true } as any);
  h.syncSpacesSyncNowAwaited.mockReset().mockResolvedValue(undefined as any);
  h.savedFolders = [];
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  h.managedRoots = { personalRoot: path.join(tmpRoot, 'Personal'), listProjects: () => [] };
  // Hermetic: heldForkIds() otherwise reads the developer's REAL ~/.youcoded/slug-repair-state.json.
  process.env.YOUCODED_SLUG_REPAIR_STATE = path.join(tmpRoot, 'slug-repair-state.json');
}
function teardown() {
  live?.stopConversationStore();
  live = undefined;
  vi.useRealTimers();
  delete process.env.YOUCODED_SLUG_REPAIR_STATE;
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
}

describe('conversations service composition root', () => {
  beforeEach(() => resetFakes('conv-svc-', () => h.reconcile.mockReset().mockImplementation(() => new Promise<number>(() => {})), false));
  afterEach(teardown);

  it('kicks the reconciler at start and resolves even though reconcile never settles', async () => {
    await freshService();
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    const opts = h.reconcile.mock.calls[0][0];
    expect(opts.projectsDir).toBe(startOpts().projectsDir);
    expect(opts.topicsDir).toBe(startOpts().topicsDir);
    expect(opts.device).toBe('test-device');
    expect(typeof opts.mirror).toBe('function');
  });

  // WHY: the reconciler mirrors every transcript it scans; all at once, big copies fill libuv's 4 threads
  // and queue live chat reads and lease writes behind them.
  it('reconciler mirrors never overlap: the next copy starts only after the previous settles', async () => {
    let failFirst!: (err: Error) => void;
    h.mirrorIn
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failFirst = reject; }))
      .mockResolvedValue({ copied: true } as any);
    await freshService();
    const opts = h.reconcile.mock.calls[0][0];
    opts.mirror(path.join(tmpRoot, 'projects', 'alpha', 'sess-1.jsonl'), 'alpha', 'sess-1');
    opts.mirror(path.join(tmpRoot, 'projects', 'beta', 'sess-2.jsonl'), 'beta', 'sess-2');

    await vi.waitFor(() => expect(h.mirrorIn).toHaveBeenCalledTimes(1));
    await tick(50); // settle (negative assertion): an overlapping copy would start within a microtask
    expect(h.mirrorIn).toHaveBeenCalledTimes(1);

    failFirst(new Error('EBUSY')); // a failed copy must not stop later ones
    await vi.waitFor(() => expect(h.mirrorIn).toHaveBeenCalledTimes(2));
    expect(h.mirrorIn.mock.calls[1][0].localJsonlPath).toContain('sess-2.jsonl');
  });

  // Without this the reconciler truncates hyphenated project names.
  it('passes managed + saved folder paths as knownFolders to the reconciler', async () => {
    h.managedRoots = {
      personalRoot: path.join(tmpRoot, 'Personal'),
      listProjects: () => [{ name: 'youcoded-dev', path: 'C:/Users/desti/youcoded-dev' }],
    };
    h.savedFolders = [{ path: 'C:/Users/desti/notes' }];
    await freshService();
    expect(h.reconcile.mock.calls[0][0].knownFolders).toEqual(['C:/Users/desti/youcoded-dev', 'C:/Users/desti/notes']);
  });

  it('an event upserts projectName/originalPath/lastActive/device', async () => {
    const svc = await freshService();
    const cwd = path.join(tmpRoot, 'my-project');
    svc.noteSessionStarted('claude-abc', cwd, 'claude');
    svc.noteTranscriptEvent('claude-abc', ev({ type: 'turn-complete', timestamp: 1_700_000_000_000 }), 'claude');
    await Promise.resolve();
    expect(h.store.upsert).toHaveBeenCalledWith(expect.objectContaining({
      id: 'claude-abc', provider: 'claude', projectName: path.basename(cwd), originalPath: cwd,
      lastActive: new Date(1_700_000_000_000).toISOString(), device: 'test-device',
    }));
  });

  it('turn-complete mirrors the jsonl and syncs the personal space promptly', async () => {
    const svc = await freshService();
    svc.noteSessionStarted('claude-xyz', path.join(tmpRoot, 'proj-x'), 'claude');
    svc.noteTranscriptEvent('claude-xyz', ev({ type: 'turn-complete' }), 'claude');
    await Promise.resolve();
    expect(h.mirrorIn).toHaveBeenCalledTimes(1);
    const arg = h.mirrorIn.mock.calls[0][0];
    expect(arg.localJsonlPath).toContain('claude-xyz.jsonl');
    expect(arg.localJsonlPath).toContain(startOpts().projectsDir);
    // The nudge is CHAINED after mirrorIn resolves, so it lands a promise hop later.
    await vi.waitFor(() => expect(h.syncSpacesSyncNow).toHaveBeenCalledWith('personal'));
  });

  describe('materialize sweep', () => {
    it('synced(updated) event materializes only records whose project resolves locally', async () => {
      const recA = mkRec('alpha');
      const recB = mkRec('ghost', { mkdir: false });
      await freshService(); // records set AFTER start so the startup sweep sees none
      listOnly('claude', [recA, recB]);
      fireSynced();
      await vi.waitFor(() => expect(h.materializeOut).toHaveBeenCalled());
      expect(h.materializeOut).toHaveBeenCalledTimes(1);
      const arg = h.materializeOut.mock.calls[0][0];
      expect(arg.spaceTranscriptPath).toContain(recA.transcriptRef.replace(/\//g, path.sep));
      expect(lastMaterialized()).toContain(`${recA.id}.jsonl`);
    });

    it('runs a catch-up sweep on startup (no synced event needed)', async () => {
      const rec = mkRec('startup-proj');
      listOnly('claude', [rec]); // BEFORE start so the synchronous startup sweep sees it
      await freshService();
      await vi.waitFor(() => expect(h.materializeOut).toHaveBeenCalled());
      expect(lastMaterialized()).toContain(`${rec.id}.jsonl`);
    });

    // The sweep must NEVER touch a LIVE session's transcript: on POSIX the rename succeeds and CC keeps
    // appending to the unlinked inode (chat freezes, turns lost); on Windows EPERM containment is unreliable.
    it.each(['claude', 'native'])('skips a LIVE %s session; an idle record still materializes', async (provider) => {
      const liveRec = mkRec(`${provider}-live`, { provider });
      const idleRec = mkRec(`${provider}-idle`, { provider });
      const svc = await freshService();
      listOnly(provider, [liveRec, idleRec]);
      svc.noteSessionStarted(liveRec.id, liveRec.originalPath, provider as any);
      fireSynced();
      await vi.waitFor(() => expect(h.materializeOut).toHaveBeenCalled());
      expect(h.materializeOut).toHaveBeenCalledTimes(1);
      expect(lastMaterialized()).toContain(`${idleRec.id}.jsonl`);
    });

    // A resume can land between the sweep's liveness check and the rename, so service.ts passes a
    // shouldCommit closure that must read LIVE state at call time.
    it('the shouldCommit passed to materializeOut reflects a session that starts WHILE the copy is pending', async () => {
      const rec = mkRec('resume-mid-copy-proj');
      const svc = await freshService();
      listOnly('claude', [rec]);
      fireSynced();
      await vi.waitFor(() => expect(h.materializeOut).toHaveBeenCalled());
      const shouldCommit = h.materializeOut.mock.calls[0][0].shouldCommit;
      expect(shouldCommit()).toBe(true);
      svc.noteSessionStarted(rec.id, rec.originalPath, 'claude');
      expect(shouldCommit()).toBe(false);
    });

    it('noteSessionEnded releases the guard so a later sweep materializes the record', async () => {
      const rec = mkRec('ended-proj');
      const svc = await freshService();
      svc.noteSessionStarted(rec.id, rec.originalPath, 'claude');
      listOnly('claude', [rec]);
      fireSynced();
      await tick();
      expect(h.materializeOut).not.toHaveBeenCalled(); // skipped while live
      svc.noteSessionEnded(rec.id);
      fireSynced();
      await vi.waitFor(() => expect(h.materializeOut).toHaveBeenCalled());
      expect(lastMaterialized()).toContain(`${rec.id}.jsonl`);
    });

    it('does not materialize peer bytes on exit or synced sweep while sender snapshot is pinned', async () => {
      const rec = mkRec('pinned-proj');
      const svc = await freshService();
      svc.noteSessionStarted(rec.id, rec.originalPath, 'claude');
      h.store.get.mockResolvedValue(rec);
      listOnly('claude', [rec]);
      const pin = svc.pinHandoffDestination(rec.id);
      expect(pin?.active()).toBe(true);
      svc.noteSessionEnded(rec.id);
      fireSynced();
      await vi.waitFor(() => expect(h.store.list).toHaveBeenCalled());
      expect(h.materializeOut).not.toHaveBeenCalled();
      pin?.release();
      fireSynced();
      await vi.waitFor(() => expect(h.materializeOut).toHaveBeenCalled());
    });

    it('a non-personal or non-updated synced event does NOT materialize', async () => {
      h.store.list.mockResolvedValue([mkRec('a', { id: 'x', mkdir: false })] as any);
      await freshService();
      fireSync({ type: 'synced', spaceId: 'project:alpha', updated: true, pushed: false });
      fireSync({ type: 'synced', spaceId: 'personal', updated: false, pushed: true });
      await tick();
      expect(h.materializeOut).not.toHaveBeenCalled();
    });

    // Both sweep and materializeOne refuse a record whose ref escapes the space root or sits in the wrong
    // provider lane, with SKIP-not-abort: a valid sibling in the same sweep still materializes.
    it.each([
      ['claude', 'a native record carrying a claude/ ref (lane mismatch)', 'native', 'claude/transcripts/p/r.jsonl', 'lane mismatch'],
      ['native', 'a ../ traversal ref', 'claude', '../../outside/z.jsonl', 'refused transcriptRef'],
    ])('materializeSweep refuses %s: %s but still materializes a valid sibling', async (_l, _d, provider, badRef, warning) => {
      const bad = mkRec('bad-proj', { id: 'bad-rec', provider, ref: badRef });
      const good = mkRec('good-proj', { id: 'good-rec', provider });
      await freshService();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      listOnly(provider, [bad, good]);
      fireSynced();
      await vi.waitFor(() => expect(h.materializeOut).toHaveBeenCalled());
      expect(h.materializeOut).toHaveBeenCalledTimes(1);
      expect(lastMaterialized()).toContain('good-rec.jsonl');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(warning), 'bad-rec');
      warnSpy.mockRestore();
    });

    it('materializeOne finds a native-only id via the claude→native fallback', async () => {
      const svc = await freshService();
      const rec = mkRec('native-fallback-proj', { provider: 'native', id: 'native-fallback-1' });
      h.store.get.mockImplementation(async (p: string, gid: string) => (p === 'native' && gid === rec.id ? rec : null) as any);
      await svc.materializeOne(rec.id, rec.originalPath);
      expect(h.store.get).toHaveBeenCalledWith('claude', rec.id);
      expect(h.store.get).toHaveBeenCalledWith('native', rec.id);
      expect(h.materializeOut).toHaveBeenCalledTimes(1);
      expect(lastMaterialized()).toContain(`${rec.id}.jsonl`);
    });
  });

  // The targeted materialize waits for the local transcript to go quiescent: session-exit fires before CC
  // finishes flushing its final turn, so it copies only once the file size stops changing for a probe interval.
  describe('materialize-after-end quiescence', () => {
    it('waits for the local file size to stabilize', async () => {
      const svc = await fakeService();
      const rec = mkRec('quiesce-proj', { id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' });
      h.store.get.mockResolvedValue(rec as any);
      const localPath = path.join(startOpts().projectsDir, ccProjectSlug(rec.originalPath), `${rec.id}.jsonl`);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, 'aaaa');

      svc.noteSessionStarted(rec.id, rec.originalPath, 'claude');
      svc.noteSessionEnded(rec.id);
      await vi.advanceTimersByTimeAsync(0); // flush get() → first stat → arm probe
      fs.writeFileSync(localPath, 'aaaabbbbcccc'); // grows mid-wait
      await vi.advanceTimersByTimeAsync(750); // probe 2: size changed → keep waiting
      expect(h.materializeOut).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(750); // probe 3: stable → copy now
      expect(h.materializeOut).toHaveBeenCalledTimes(1);
      expect(lastMaterialized()).toBe(localPath);
    });

    it('is targeted to the ended session only (never a full-store scan)', async () => {
      const svc = await fakeService();
      const recA = mkRec('targ-a', { id: 'aaaa1111' });
      const recB = mkRec('targ-b', { id: 'bbbb2222' });
      h.store.get.mockImplementation(async (_p: string, gid: string) => (gid === recA.id ? recA : recB) as any);
      h.store.list.mockResolvedValue([recA, recB] as any); // a sweep would copy BOTH
      svc.noteSessionStarted(recA.id, recA.originalPath, 'claude');
      svc.noteSessionEnded(recA.id);
      await wait750(); // absent file → size 0 stable
      expect(h.materializeOut).toHaveBeenCalledTimes(1);
      expect(lastMaterialized()).toContain(`${recA.id}.jsonl`);
    });

    // Data-loss guard: a file that never stops growing means CC is still flushing — SKIP, never rename over it.
    it('SKIPS when the file never stabilizes', async () => {
      const svc = await fakeService();
      const rec = mkRec('grow-forever', { id: '11111111' });
      h.store.get.mockResolvedValue(rec as any);
      let sz = 100;
      const statSpy = vi.spyOn(fs, 'statSync').mockImplementation(() => ({ size: (sz += 100) } as any));
      svc.noteSessionStarted(rec.id, rec.originalPath, 'claude');
      svc.noteSessionEnded(rec.id);
      for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(750); // well past QUIESCE_MAX_MS (6s)
      expect(h.materializeOut).not.toHaveBeenCalled();
      statSpy.mockRestore();
    });

    it('skips when the session is re-opened during the wait', async () => {
      const svc = await fakeService();
      const rec = mkRec('reopen-proj', { id: '22222222' });
      h.store.get.mockResolvedValue(rec as any);
      svc.noteSessionStarted(rec.id, rec.originalPath, 'claude');
      svc.noteSessionEnded(rec.id);
      await vi.advanceTimersByTimeAsync(0);
      svc.noteSessionStarted(rec.id, rec.originalPath, 'claude'); // re-adds the live guard mid-wait
      await vi.advanceTimersByTimeAsync(750); // quiesced, but the guard wins
      expect(h.materializeOut).not.toHaveBeenCalled();
    });
  });

  // flushSessionToSpace is how the holder side of a takeover pushes the FINAL interrupted turn before the
  // lease releases. Unlike materialize it pushes regardless of the quiescence result (mirrorIn is grow-only).
  describe('flushSessionToSpace', () => {
    it.each([
      ['claude', (dir: string, id: string) => path.join(startOpts().projectsDir, ccProjectSlug(dir), `${id}.jsonl`), undefined, 'claude'],
      ['native', (dir: string, id: string, home: string) => path.join(home, '.youcoded', 'sessions', nativeStoreSlug(dir), `${id}.jsonl`), 'native-home', `native${path.sep}transcripts`],
    ])('mirrors a %s session local->space lane after quiescence and pushes personal', async (provider, pathFor, homeName, lane) => {
      const nativeHomeRoot = homeName ? path.join(tmpRoot, homeName) : undefined;
      const svc = await fakeService(startOpts(nativeHomeRoot ? { nativeHomeRoot } : {}));
      const dir = path.join(tmpRoot, `flush-${provider}`);
      fs.mkdirSync(dir, { recursive: true });
      const id = `flush-${provider}-1`;
      const localPath = pathFor(dir, id, nativeHomeRoot!);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, 'the-final-turn');
      svc.noteSessionStarted(id, dir, provider as any); // learn cwd + provider so flush can locate the file
      const p = svc.flushSessionToSpace(id);
      await wait750();
      await p;
      expect(h.mirrorIn).toHaveBeenCalledTimes(1);
      const arg = h.mirrorIn.mock.calls[0][0];
      expect(arg.localJsonlPath).toBe(localPath);
      expect(arg.spaceTranscriptPath).toContain(lane);
      expect(arg.spaceTranscriptPath).toContain(`${id}.jsonl`);
      // AWAITABLE variant (mirror-before-release barrier), not fire-and-forget syncSpacesSyncNow.
      expect(h.syncSpacesSyncNowAwaited).toHaveBeenCalledWith('personal', expect.any(Number));
    });

    it('a MISSING local source discards {copied:false} but still syncs (honest no-op, no throw)', async () => {
      const svc = await fakeService();
      const dir = path.join(tmpRoot, 'missing-source-proj');
      fs.mkdirSync(dir, { recursive: true }); // the project exists; the TRANSCRIPT does not
      h.mirrorIn.mockResolvedValueOnce({ copied: false });
      svc.noteSessionStarted('missing-source-1', dir, 'native');
      const p = svc.flushSessionToSpace('missing-source-1');
      await wait750();
      await expect(p).resolves.toBeUndefined();
      expect(h.mirrorIn).toHaveBeenCalledTimes(1);
      expect(h.syncSpacesSyncNowAwaited).toHaveBeenCalledWith('personal', expect.any(Number));
    });

    it('with no known session is a no-op', async () => {
      const svc = await freshService();
      await svc.flushSessionToSpace('never-announced');
      expect(h.mirrorIn).not.toHaveBeenCalled();
      expect(h.syncSpacesSyncNowAwaited).not.toHaveBeenCalled();
    });
  });

  it('noteSessionEnded with no store is a no-op and never throws', async () => {
    vi.resetModules();
    const svc = await import('../src/main/conversations/service');
    expect(() => svc.noteSessionEnded('claude-no-store')).not.toThrow();
    expect(h.materializeOut).not.toHaveBeenCalled();
  });

  // Start must be idempotent: a second start must not leak the first subscription (duplicate sweeps) or interval.
  it('a second start without stop leaves exactly ONE subscription and ONE interval', async () => {
    const svc = await fakeService();
    await svc.startConversationStore(startOpts());
    h.store.list.mockClear();
    fireSynced();
    await vi.waitFor(() => expect(h.store.list).toHaveBeenCalled());
    expect(h.store.list).toHaveBeenCalledTimes(2); // once per provider bucket
    expect(h.store.list).toHaveBeenCalledWith('claude');
    expect(h.store.list).toHaveBeenCalledWith('native');
    h.reconcile.mockClear();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  // Security: transcriptRef arrives from synced peer records, so a crafted one must never let materialize
  // join outside the space root (same refuse-on-escape stance as conversation-store.ts).
  describe('transcriptRef containment guard', () => {
    it('containedTranscriptPath accepts a normal relative ref and refuses traversal/absolute/empty refs', async () => {
      const svc = await freshService();
      const root = path.join(tmpRoot, 'space-root');
      expect(svc.containedTranscriptPath(root, 'claude/transcripts/a/b.jsonl')).toBe(path.resolve(root, 'claude/transcripts/a/b.jsonl'));
      expect(svc.containedTranscriptPath(root, '../../outside/x.jsonl')).toBeNull();
      expect(svc.containedTranscriptPath(root, path.resolve(tmpRoot, 'outside', 'y.jsonl'))).toBeNull();
      expect(svc.containedTranscriptPath(root, '')).toBeNull();
    });

    // Pins the trailing `+ path.sep`: a sibling dir sharing the root's string prefix must be refused.
    it('containedTranscriptPath refuses a sibling-prefix dir that shares the root name', async () => {
      const svc = await freshService();
      const root = path.join(tmpRoot, 'x', 'space');
      expect(svc.containedTranscriptPath(root, path.join('..', 'space-evil', 't.jsonl'))).toBeNull();
      // Control: a subdir literally named the same IS inside, so the guard refuses the sibling specifically.
      expect(svc.containedTranscriptPath(root, path.join('space-evil', 't.jsonl'))).toBe(path.resolve(root, 'space-evil', 't.jsonl'));
    });

    it.each([
      ['a sibling-prefix escape that still passes the lane check', 'claude', 'claude/../../Conversations-evil/e.jsonl', 'escaping space root'],
      ['a transcriptRef that escapes the space root', 'claude', '../../outside/x.jsonl', 'refused transcriptRef'],
      ['an absolute transcriptRef', 'claude', path.resolve(os.tmpdir(), 'outside', 'y.jsonl'), 'refused transcriptRef'],
      ['a claude/ ref on a native record (lane mismatch)', 'native', 'claude/transcripts/p/e.jsonl', 'lane mismatch'],
    ])('materializeOne refuses %s', async (_d, provider, ref, warning) => {
      const svc = await freshService();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const rec = mkRec('escape-proj', { id: 'escaping-1', provider, ref });
      h.store.get.mockResolvedValue(rec as any);
      await svc.materializeOne(rec.id, rec.originalPath);
      expect(h.materializeOut).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(warning), rec.id);
      warnSpy.mockRestore();
    });
  });

  describe('title and flag write-through', () => {
    it('noteTitleChanged writes through to store.setTitle', async () => {
      const svc = await freshService();
      svc.noteTitleChanged('claude-t', 'My Title', 'claude');
      expect(h.store.setTitle).toHaveBeenCalledWith('claude', 'claude-t', 'My Title');
    });

    // 4th arg is knownNative: false probes the store's native bucket, then falls back to claude.
    it('noteFlagChanged writes through to store.setFlag (knownNative=false, no native record → claude)', async () => {
      const svc = await freshService();
      await svc.noteFlagChanged('claude-f', 'complete', true, false);
      expect(h.store.setFlag).toHaveBeenCalledWith('claude', 'claude-f', 'complete', true);
    });

    it('noteFlagChanged routes to the native bucket when knownNative=true', async () => {
      const svc = await freshService();
      await svc.noteFlagChanged('nat-f', 'complete', true, true);
      expect(h.store.setFlag).toHaveBeenCalledWith('native', 'nat-f', 'complete', true);
    });

    // Misroute fix: a store-only native browse row (synced, transcript not local) must land in native, not seed a claude phantom.
    it('noteFlagChanged probes the store and routes to native when a store-only native record exists', async () => {
      const svc = await freshService();
      h.store.get.mockResolvedValue({ id: 'store-only-nat', provider: 'native' } as any);
      await svc.noteFlagChanged('store-only-nat', 'complete', true, false);
      expect(h.store.get).toHaveBeenCalledWith('native', 'store-only-nat');
      expect(h.store.setFlag).toHaveBeenCalledWith('native', 'store-only-nat', 'complete', true);
      expect(h.store.setFlag).not.toHaveBeenCalledWith('claude', 'store-only-nat', 'complete', true);
    });
  });

  // noteModelUsed never seeds a record on its own (a model-only upsert is a phantom): it upserts into an
  // EXISTING record, or stashes on ctx and rides the next transcript-event upsert.
  describe('noteModelUsed', () => {
    const ref = { modelId: 'claude-opus-4-7', providerType: 'anthropic', providerLabel: 'Claude Pro' };

    it('upserts lastUsedModel immediately when a record already exists', async () => {
      const svc = await freshService();
      svc.noteSessionStarted('claude-m1', path.join(tmpRoot, 'model-proj'), 'claude');
      h.store.get.mockResolvedValue({ id: 'claude-m1', provider: 'claude' } as any);
      svc.noteModelUsed('claude-m1', ref);
      await tick(0);
      expect(h.store.get).toHaveBeenCalledWith('claude', 'claude-m1');
      expect(h.store.upsert).toHaveBeenCalledWith({ id: 'claude-m1', provider: 'claude', lastUsedModel: ref });
    });

    it('does NOT upsert when no record exists yet — it rides the next transcript upsert instead', async () => {
      const svc = await freshService();
      svc.noteSessionStarted('claude-m2', path.join(tmpRoot, 'model-proj-2'), 'claude');
      svc.noteModelUsed('claude-m2', ref);
      await tick(0);
      expect(h.store.upsert).not.toHaveBeenCalled();
      svc.noteTranscriptEvent('claude-m2', ev({ type: 'turn-complete' }), 'claude');
      await Promise.resolve();
      expect(h.store.upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'claude-m2', lastUsedModel: ref }));
    });

    it('is a no-op for a session that never announced itself', async () => {
      const svc = await freshService();
      svc.noteModelUsed('never-announced', ref);
      await tick(0);
      expect(h.store.get).not.toHaveBeenCalled();
      expect(h.store.upsert).not.toHaveBeenCalled();
    });
  });

  it('native turn-complete upserts a native-lane record carrying lastUsedModel', async () => {
    const svc = await freshService();
    svc.noteSessionStarted('nat-1', path.join('/home/d', 'proj'), 'native');
    svc.noteModelUsed('nat-1', { modelId: 'qwen-3', providerType: 'local-engine', providerLabel: 'Local models (llama.cpp)' });
    svc.noteTranscriptEvent('nat-1', ev({ type: 'turn-complete', sessionId: 'nat-1' }), 'native');
    await Promise.resolve();
    const up = h.store.upsert.mock.calls.at(-1)![0];
    expect(up.provider).toBe('native');
    expect(up.transcriptRef).toBe('native/transcripts/proj/nat-1.jsonl');
    expect(up.lastUsedModel?.modelId).toBe('qwen-3');
  });

  // Callers can write a flag/note before the store starts (IPC handlers go live first); those must be
  // buffered and flushed, or answered honestly ok:false — never silently dropped while answering ok:true.
  describe('meta-write buffering', () => {
    it('buffers a flag write made before the store starts, flushes it in order, resolves ok:true', async () => {
      vi.resetModules();
      const svc = await import('../src/main/conversations/service');
      live = svc;
      const p1 = svc.noteFlagChanged('id1', 'complete', true, false);
      const p2 = svc.noteSessionNote('id1', 'note-2', false);
      await svc.startConversationStore(startOpts());
      expect(await p1).toEqual({ ok: true });
      expect(await p2).toEqual({ ok: true });
      expect(h.store.setFlag.mock.invocationCallOrder[0]).toBeLessThan(h.store.setNote.mock.invocationCallOrder[0]);
    });

    it('resolves buffered writes ok:false when the store never comes up', async () => {
      vi.resetModules();
      const svc = await import('../src/main/conversations/service');
      const p = svc.noteFlagChanged('id1', 'complete', true, false);
      h.managedRoots = null;
      await svc.startConversationStore();
      expect(await p).toEqual({ ok: false });
    });

    it('a rejecting store write resolves ok:false, not ok:true', async () => {
      const svc = await freshService();
      h.store.setFlag.mockRejectedValue(new Error('lock timeout'));
      expect(await svc.noteFlagChanged('id1', 'complete', true, false)).toEqual({ ok: false });
    });

    it('a ready store resolves a flag write ok:true immediately (no buffering)', async () => {
      const svc = await freshService();
      expect(await svc.noteFlagChanged('id1', 'complete', true, false)).toEqual({ ok: true });
    });

    // The idempotent stop at the top of EVERY start must not settle writes that arrived before first start;
    // only stopping an ALREADY-RUNNING store does.
    it('after stopConversationStore on a running store, a NEW write re-buffers instead of resolving', async () => {
      const svc = await freshService();
      svc.stopConversationStore();
      let settled = false;
      const p = svc.noteFlagChanged('id2', 'complete', true, false).then((r) => { settled = true; return r; });
      await tick(10); // settle (negative assertion): the write must stay buffered
      expect(settled).toBe(false);
      await svc.startConversationStore(startOpts());
      expect(await p).toEqual({ ok: true });
    });
  });

  describe('debounced upserts and stop', () => {
    it('stopConversationStore unsubscribes, stops the periodic reconciler and pending debounces', async () => {
      const svc = await fakeService();
      expect(h.reconcile).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(h.reconcile).toHaveBeenCalledTimes(2);
      svc.noteSessionStarted('claude-s', path.join(tmpRoot, 'p'), 'claude');
      svc.noteTranscriptEvent('claude-s', ev({ type: 'assistant-text' }), 'claude'); // arms a 5s debounce
      svc.stopConversationStore();
      fireSynced(); // unsubscribed: does nothing
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(h.reconcile).toHaveBeenCalledTimes(2);
      expect(h.materializeOut).not.toHaveBeenCalled();
      expect(h.store.upsert).not.toHaveBeenCalled();
    });

    it('an event for an unannounced session upserts with no originalPath', async () => {
      const svc = await freshService();
      svc.noteTranscriptEvent('claude-unknown', ev({ type: 'turn-complete' }), 'claude');
      await Promise.resolve();
      expect(h.store.upsert).toHaveBeenCalledTimes(1);
      const arg = h.store.upsert.mock.calls[0][0];
      expect(arg.id).toBe('claude-unknown');
      expect(arg.provider).toBe('claude');
      expect(arg.originalPath).toBeUndefined();
      expect(arg.projectName).toBeUndefined();
    });

    it('two rapid chatty events coalesce into ONE upsert after the debounce window', async () => {
      const svc = await fakeService();
      svc.noteSessionStarted('claude-d', path.join(tmpRoot, 'd'), 'claude');
      svc.noteTranscriptEvent('claude-d', ev({ type: 'assistant-text', uuid: 'a1' }), 'claude');
      svc.noteTranscriptEvent('claude-d', ev({ type: 'assistant-text', uuid: 'a2' }), 'claude');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.store.upsert).toHaveBeenCalledTimes(1);
    });

    // Same code path for both providers, keyed by session id: the stale debounce timer must not fire a 2nd upsert.
    it.each(['claude', 'native'] as const)('%s: turn-complete cancels a pending debounce timer (no extra upsert later)', async (provider) => {
      const svc = await fakeService();
      const id = `${provider}-c`;
      svc.noteSessionStarted(id, path.join(tmpRoot, 'c'), provider);
      svc.noteTranscriptEvent(id, ev({ type: 'assistant-text', sessionId: id }), provider); // arms debounce
      svc.noteTranscriptEvent(id, ev({ type: 'turn-complete', sessionId: id }), provider); // immediate upsert + cancel
      await Promise.resolve();
      expect(h.store.upsert).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.store.upsert).toHaveBeenCalledTimes(1);
    });

    it('a rejecting store.upsert is swallowed (no unhandled rejection)', async () => {
      h.store.upsert.mockRejectedValue(new Error('lock timeout'));
      const svc = await freshService();
      svc.noteSessionStarted('claude-r', path.join(tmpRoot, 'r'), 'claude');
      svc.noteTranscriptEvent('claude-r', ev({ type: 'turn-complete' }), 'claude');
      await vi.waitFor(() => expect(h.syncSpacesSyncNow).toHaveBeenCalledWith('personal')); // the push still fired
    });
  });

  // Mapping native sessions in sessionIdMap once defeated the phantom gate, so flagging a NATIVE session seeded
  // a blank claude/ record that synced everywhere. This cleanup clears those — and must touch nothing else
  // (it is the store's only destructive caller).
  describe('pruneNativePhantomRecords', () => {
    const phantom = (id: string) => ({
      schema: 1, id, provider: 'claude', projectName: '', originalPath: '', title: '',
      lastActive: '1970-01-01T00:00:00.000Z', device: '', flags: { complete: { value: true, updatedAt: 'x' } },
      transcriptRef: '', createdAt: 'x', note: '', noteUpdatedAt: 'x',
    });
    /** Lays down ~/.youcoded/sessions/<slug>/<id>.jsonl so the id reads as native; returns the home root. */
    function nativeHome(name: string, seedId?: string) {
      const homeRoot = path.join(tmpRoot, name);
      fs.mkdirSync(homeRoot, { recursive: true });
      if (seedId) {
        const dir = path.join(homeRoot, '.youcoded', 'sessions', 'proj-slug');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${seedId}.jsonl`), '{"v":1}\n');
      }
      return homeRoot;
    }
    const prune = async (nativeHomeRoot: string) => {
      const svc = await freshService(startOpts({ nativeHomeRoot }));
      return { svc, run: () => svc.pruneNativePhantomRecords({ nativeHomeRoot }) };
    };

    it('removes a phantom whose id is a real native session', async () => {
      h.store.list.mockResolvedValue([phantom('native-1')]);
      const { run } = await prune(nativeHome('nh-hit', 'native-1'));
      expect(await run()).toBe(1);
      expect(h.store.remove).toHaveBeenCalledWith('claude', 'native-1');
    });

    it('leaves a phantom-shaped record alone when no native session file exists (shape alone is never enough)', async () => {
      h.store.list.mockResolvedValue([phantom('not-native')]);
      const { run } = await prune(nativeHome('nh-miss'));
      expect(await run()).toBe(0);
      expect(h.store.remove).not.toHaveBeenCalled();
    });

    it('never removes a record carrying real data, even for a native id', async () => {
      // Each differs from the phantom signature by ONE field; all must survive.
      h.store.list.mockResolvedValue([
        { ...phantom('native-2'), transcriptRef: 'claude/transcripts/p/native-2.jsonl' },
        { ...phantom('native-2'), projectName: 'youcoded-dev' },
        { ...phantom('native-2'), originalPath: '/home/d/p' },
        { ...phantom('native-2'), lastActive: '2026-07-18T00:00:00.000Z' },
      ]);
      const { run } = await prune(nativeHome('nh-real', 'native-2'));
      expect(await run()).toBe(0);
      expect(h.store.remove).not.toHaveBeenCalled();
    });

    it('is idempotent — a second pass finds nothing', async () => {
      h.store.list.mockResolvedValue([phantom('native-3')]);
      const { run } = await prune(nativeHome('nh-idem', 'native-3'));
      expect(await run()).toBe(1);
      h.store.list.mockResolvedValue([]);
      expect(await run()).toBe(0);
    });

    it('never lists or touches the native bucket — a legit native/ record survives untouched', async () => {
      const { run } = await prune(nativeHome('nh-native-safe', 'native-4'));
      // Throwing mock goes in AFTER start: the startup sweep legitimately lists both buckets.
      h.store.list.mockReset();
      h.store.list.mockImplementation(async (provider: string) => {
        if (provider === 'native') throw new Error('pruneNativePhantomRecords must never list the native bucket');
        return [];
      });
      expect(await run()).toBe(0);
      expect(h.store.list).toHaveBeenCalledWith('claude');
      expect(h.store.list).not.toHaveBeenCalledWith('native');
      expect(h.store.remove).not.toHaveBeenCalled();
    });
  });

  it('stays off when neither an explicit root nor managed roots are available', async () => {
    h.managedRoots = null;
    vi.resetModules();
    const svc = await import('../src/main/conversations/service');
    live = svc;
    await svc.startConversationStore();
    expect(h.reconcile).not.toHaveBeenCalled();
  });
});

// pauseSweeps/resumeSweeps: startup reconcile + materialize sweeps must not run while paused (main.ts runs
// the one-shot slug repair without racing them); any trigger while paused coalesces into ONE deferred run.
// Here reconcile RESOLVES so a resumed run is observable as completed.
describe('conversations service — sweep pause/resume gate', () => {
  beforeEach(() => resetFakes('conv-svc-pause-', () => h.reconcile.mockReset().mockResolvedValue(0 as any), true));
  afterEach(teardown);

  const nativeListed = () => h.store.list.mock.calls.filter((c) => c[0] === 'native');
  const settleStartup = async () => {
    await vi.waitFor(() => expect(h.reconcile).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(h.store.list).toHaveBeenCalledWith('native'));
    h.reconcile.mockClear();
    h.store.list.mockClear();
  };

  it('startConversationStore({ pauseSweeps: true }) defers the startup reconcile and materialize; resumeSweeps runs each exactly once', async () => {
    const svc = await freshService(startOpts({ pauseSweeps: true }));
    expect(h.reconcile).not.toHaveBeenCalled();
    expect(h.store.list).not.toHaveBeenCalledWith('native');
    svc.resumeSweeps();
    await vi.waitFor(() => expect(h.reconcile).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(h.store.list).toHaveBeenCalledWith('native'));
    expect(h.reconcile).toHaveBeenCalledTimes(1); // not one per pending trigger
    expect(nativeListed()).toHaveLength(1);
  });

  it('a trigger while paused is deferred and coalesced: pause, trigger twice, resume — runs once', async () => {
    const svc = await fakeService();
    await settleStartup(); // isolates the test to triggers arriving AFTER startup
    svc.pauseSweeps();
    fireSynced();
    fireSynced();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(h.reconcile).not.toHaveBeenCalled();
    expect(h.store.list).not.toHaveBeenCalledWith('native');
    svc.resumeSweeps();
    await vi.waitFor(() => expect(h.reconcile).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(h.store.list).toHaveBeenCalledWith('native'));
    expect(h.reconcile).toHaveBeenCalledTimes(1); // coalesced, not one per tick
    expect(nativeListed()).toHaveLength(1);
  });

  it('resumeSweeps() with nothing pending is a no-op and resets the flag', async () => {
    const svc = await freshService();
    await settleStartup();
    expect(() => svc.resumeSweeps()).not.toThrow();
    await tick(10);
    expect(h.reconcile).not.toHaveBeenCalled();
    expect(h.store.list).not.toHaveBeenCalled();
    // The flag really reset: a later trigger runs immediately rather than staying "paused".
    fireSynced();
    await vi.waitFor(() => expect(h.store.list).toHaveBeenCalledWith('native'));
  });
});
