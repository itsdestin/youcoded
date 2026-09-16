// Pins the fork-hold gate added to conversations/service.ts (found on the
// real-data run, T18 run-3): a session id listed as held in slug-repair's
// state file (surfacedForks — see heldForkIds' WHY in slug-repair-state.ts)
// must be frozen out of BOTH mirror directions — materializeSweep/
// materializeOne (space -> local) and the reconciler's mirror closure
// (local -> space) — until a human resolves the fork. A non-held session in
// the SAME run must still mirror/materialize normally, proving the hold is
// per-id, not global. Mirrors the mocking setup in
// conversations-service-sweep-pause.test.ts (same collaborators faked via
// vi.hoisted), plus a mock of the new slug-repair-state leaf module.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const h = vi.hoisted(() => {
  return {
    store: {
      upsert: vi.fn(async (_p: any) => ({ id: 'x' })),
      get: vi.fn(async () => null),
      list: vi.fn(async (_provider: string): Promise<any[]> => []),
      setFlag: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
      setNote: vi.fn(async () => {}),
      remove: vi.fn(async (_provider: string, _id: string) => true),
      root: vi.fn(() => ''),
    },
    reconcile: vi.fn((_opts: any) => new Promise<number>(() => {})),
    // async — mirrorIn/materializeOut are now Promise-returning; the real
    // service code calls .catch()/await on these.
    mirrorIn: vi.fn(async (_o: any) => ({ copied: true })),
    materializeOut: vi.fn(async (_o: any) => ({ copied: true })),
    syncSpacesSyncNow: vi.fn(async (_spaceId?: string) => ({ ok: true })),
    syncSpacesSyncNowAwaited: vi.fn(async (_spaceId?: string, _timeoutMs?: number) => {}),
    syncListeners: new Set<(e: any) => void>(),
    managedRoots: null as any,
    savedFolders: [] as Array<{ path: string }>,
    // Fork-hold set the mocked heldForkIds() returns — configurable per test.
    heldForks: new Set<string>(),
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
vi.mock('../src/main/conversations/slug-repair-state', () => ({
  heldForkIds: (_stateFile?: string) => new Set(h.heldForks),
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

function fireSync(e: any): void {
  for (const fn of h.syncListeners) fn(e);
}

let tmpRoot = '';

describe('conversations service — fork hold', () => {
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
    h.heldForks = new Set<string>();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-svc-fork-hold-'));
    h.managedRoots = { personalRoot: path.join(tmpRoot, 'Personal'), listProjects: () => [] };
  });

  afterEach(() => {
    vi.useRealTimers();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const startOpts = () => ({
    conversationsRoot: path.join(tmpRoot, 'Conversations'),
    projectsDir: path.join(tmpRoot, 'projects'),
    topicsDir: path.join(tmpRoot, 'topics'),
    device: 'test-device',
  });

  async function freshService() {
    vi.resetModules();
    const svc = await import('../src/main/conversations/service');
    await svc.startConversationStore(startOpts());
    return svc;
  }

  it('materializeSweep skips a held session (space->local) but still materializes a non-held one in the same run', async () => {
    const heldDir = path.join(tmpRoot, 'held-proj');
    const freeDir = path.join(tmpRoot, 'free-proj');
    fs.mkdirSync(heldDir, { recursive: true });
    fs.mkdirSync(freeDir, { recursive: true });
    const heldRec = {
      id: 'held-session-id', provider: 'claude',
      projectName: 'held-proj', originalPath: heldDir,
      transcriptRef: 'claude/transcripts/held-proj/held-session-id.jsonl',
    };
    const freeRec = {
      id: 'free-session-id', provider: 'claude',
      projectName: 'free-proj', originalPath: freeDir,
      transcriptRef: 'claude/transcripts/free-proj/free-session-id.jsonl',
    };
    h.heldForks = new Set([heldRec.id]);
    const svc = await freshService();
    h.store.list.mockImplementation(async (p: string) => (p === 'claude' ? [heldRec, freeRec] : []));
    fireSync({ type: 'synced', spaceId: 'personal', updated: true, pushed: false });
    await vi.waitFor(() => expect(h.materializeOut).toHaveBeenCalled());
    // Only the non-held record materialized — the held one is frozen, even
    // though transcript-mirror's grow-only-by-SIZE materializeOut is mocked
    // to always "succeed": the hold must stop the CALL from happening at all.
    expect(h.materializeOut).toHaveBeenCalledTimes(1);
    expect(h.materializeOut.mock.calls[0][0].localJsonlPath).toContain(`${freeRec.id}.jsonl`);
    void svc;
  });

  it('materializeOne skips a held session entirely (no quiescence wait, no materializeOut call)', async () => {
    const svc = await freshService();
    h.heldForks = new Set(['held-session-id']);
    h.store.get.mockResolvedValue({
      id: 'held-session-id', provider: 'claude',
      projectName: 'held-proj', originalPath: path.join(tmpRoot, 'held-proj'),
      transcriptRef: 'claude/transcripts/held-proj/held-session-id.jsonl',
    } as any);
    await svc.materializeOne('held-session-id', path.join(tmpRoot, 'held-proj'));
    expect(h.materializeOut).not.toHaveBeenCalled();
  });

  it('the reconciler mirror closure does not mirror a held session local->space, but still mirrors a non-held one', async () => {
    h.heldForks = new Set(['held-session-id']);
    await freshService();
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    const opts = h.reconcile.mock.calls[0][0];
    expect(typeof opts.mirror).toBe('function');

    opts.mirror(path.join(tmpRoot, 'held-proj', 'held-session-id.jsonl'), 'held-proj', 'held-session-id');
    opts.mirror(path.join(tmpRoot, 'free-proj', 'free-session-id.jsonl'), 'free-proj', 'free-session-id');

    // WHY waitFor: reconciler mirrors now queue on one serial chain (service.ts
    // reconcileMirrorTail), so mirrorIn runs a microtask after mirror() returns
    // and a synchronous "not called" check would pass vacuously. A held session
    // that leaked through would be queued FIRST, so the first call being the
    // free session — and the only call — proves the hold.
    await vi.waitFor(() => expect(h.mirrorIn).toHaveBeenCalled());
    expect(h.mirrorIn.mock.calls[0][0].localJsonlPath).toContain('free-session-id.jsonl');
    expect(h.mirrorIn).toHaveBeenCalledTimes(1);
  });
});
