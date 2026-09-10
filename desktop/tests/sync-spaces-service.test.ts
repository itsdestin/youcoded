// Pins the enable/disable transition serialization in sync-spaces/service.ts:
// enable(true) racing enable(false) must run strictly sequentially, and a
// superseded engine start must stop its own instance (no orphaned watchers).
// All collaborators are mocked — this tests ONLY the composition root's
// transition chaining, not the engine/transport themselves.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';

// vi.mock factories are hoisted above imports, so shared fake state must be
// created via vi.hoisted for the factories to close over it.
const h = vi.hoisted(() => {
  class FakeEngine {
    stopped = false;
    added: string[] = [];
    synced: string[] = [];
    removed: string[] = [];
    // syncSpace is a spy so the per-space / sync-everything tests can assert
    // which spaces were reconciled; it also records the target id in `synced`
    // (survives mockClear) so the rename/stop tests can prove Personal was pushed.
    syncSpace = vi.fn(async (space: { id: string }): Promise<void> => { this.synced.push(space.id); });
    // Test releases this to let a blocked addSpace proceed — simulates the
    // real engine suspending on chokidar's ready await mid-startEngine.
    releaseAddSpace: (() => void) | null = null;
    // Capture the onEvent callback (service.broadcast) so a test can fire an
    // engine event the way the real engine would, and assert on the stamp.
    constructor(_transport?: unknown, opts?: { onEvent?: (e: unknown) => void }) {
      h.onEvent = opts?.onEvent ?? null;
      h.engines.push(this);
    }
    async addSpace(space: { id: string }): Promise<void> {
      // The timestamp/per-space tests want enable() to resolve without manual
      // gating; the serialization tests keep the blocking gate (autoAddSpace off).
      if (h.autoAddSpace) { this.added.push(space.id); return; }
      await new Promise<void>((res) => { this.releaseAddSpace = res; });
      this.added.push(space.id);
    }
    // Cross-device discovery (2026-07-12): liveSpaceIds/removeSpace mirror the
    // real engine so runDiscovery's plan sees this device's live spaces; `synced`
    // records every syncSpace target so the rename/stop tests can assert Personal
    // was pushed, `removed` records detaches so the stop test can assert it.
    liveSpaceIds(): string[] { return this.added.filter((id) => !this.removed.includes(id)); }
    async removeSpace(id: string): Promise<void> { this.removed.push(id); }
    async stop(): Promise<void> { this.stopped = true; }
  }
  return {
    engines: [] as InstanceType<typeof FakeEngine>[],
    FakeEngine,
    // Default single space keeps the existing serialization tests unchanged;
    // the per-space tests widen this to two projects.
    spaces: [{ id: 'personal', kind: 'personal', root: '/fake/personal' }] as Array<{ id: string; kind: string; root: string }>,
    // Cross-device discovery (2026-07-12): the stateful ManagedRoots mock derives
    // its project spaces from this list, so a mid-test createProject is visible to
    // a later spaces()/listProjects(). `registry` is what the mocked
    // readProjectRegistry returns; the spies capture registry writes.
    projects: [] as string[],
    registry: [] as any[],
    ensureEntry: vi.fn(),
    setDisplay: vi.fn(),
    setStopped: vi.fn(),
    ensureRemoteFails: false,
    autoAddSpace: false,
    // When true, the fake SpaceManager reports enabled at construction time —
    // makes startSyncSpaces launch its UNCHAINED boot startEngine, the only
    // path where a run can be superseded mid-flight by a disable/enable pair.
    initialEnabled: false,
    onEvent: null as null | ((e: unknown) => void),
    // SyncHub fake (Task 5): captures the opts createSyncHubSocket was called
    // with (so a test can read deviceName + fire opts.onEvent the way the real
    // socket would) plus spies for the surface the service drives.
    hub: {
      opts: null as any,
      setDesired: vi.fn(),
      sendSignal: vi.fn(() => true),
      isConnected: vi.fn(() => false),
      destroy: vi.fn(),
      // Lease transport (Task 8): hubLeaseRequest routes through this when the
      // socket exists. Default resolves a fake LeaseResult so the passthrough
      // test can assert it reached the socket.
      request: vi.fn(async (_op: string, sessionId: string, deviceId: string) => ({ ok: true, op: _op, sessionId, holder: { deviceId, device: 'd', expiresAt: 0 } })),
    },
  };
});

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../src/main/sync-spaces/engine', () => ({ SpaceSyncEngine: h.FakeEngine }));
// Stateful ManagedRoots (2026-07-12): project spaces derive from h.projects so a
// mid-test createProject is visible to a later spaces()/listProjects(). personal
// is fixed. (Serialization/per-space tests that set h.spaces are unaffected —
// spaces() no longer reads it; personal is always present.)
vi.mock('../src/main/sync-spaces/managed-roots', () => ({
  ManagedRoots: class {
    readonly personalRoot = '/fake/personal';
    readonly projectsRoot = '/fake/projects';
    readonly youcodedRoot = '/fake';
    ensure(): void {}
    listProjects(): Array<{ name: string; path: string }> {
      return h.projects.map((n: string) => ({ name: n, path: `/fake/projects/${n}` }));
    }
    createProject(name: string): { ok: true; path: string } | { ok: false; error: string } {
      if (h.projects.includes(name)) return { ok: false, error: 'A project with that name already exists' };
      h.projects.push(name);
      return { ok: true, path: `/fake/projects/${name}` };
    }
    spaces(): Array<{ id: string; kind: string; root: string }> {
      return [
        { id: 'personal', kind: 'personal', root: '/fake/personal' },
        ...h.projects.map((n: string) => ({ id: `project:${n}`, kind: 'project', root: `/fake/projects/${n}` })),
      ];
    }
  },
}));
vi.mock('../src/main/sync-spaces/project-registry', () => ({
  PROJECT_REGISTRY_SCHEMA: 1,
  readProjectRegistry: () => h.registry,
  ensureProjectEntry: (_root: string, input: any) => { h.ensureEntry(input); },
  setProjectDisplayName: async (_r: string, name: string, repo: string, dn: string) => { h.setDisplay({ name, repo, dn }); },
  setProjectStopped: async (_r: string, name: string, repo: string) => { h.setStopped({ name, repo }); },
}));
vi.mock('../src/main/sync-spaces/space-manager', () => ({
  SpaceManager: class {
    private enabled = h.initialEnabled; // read at construction — see h.initialEnabled comment
    isEnabled(): boolean { return this.enabled; }
    setEnabled(v: boolean): void { this.enabled = v; }
    remoteFor(): string | null { return null; }
    // Honest-state-machine (2026-07-22): the service records per-space sync
    // evidence on every real 'synced' broadcast and exposes it on status.
    private lastSync: Record<string, number> = {};
    lastSyncFor(id: string): number | null { return this.lastSync[id] ?? null; }
    recordSyncSuccess(id: string, at: number): void { this.lastSync[id] = at; }
    // ensureRemoteFails knob (2026-07-12) simulates a gh-auth failure so the
    // materialize-failure discovery test can assert nothing is created.
    async ensureRemote(): Promise<string> {
      if (h.ensureRemoteFails) throw new Error('gh not signed in');
      return 'https://github.com/x/y.git';
    }
  },
  // The real repoNameForSpace hashes the id; the service only needs a stable
  // space-id → repo-name mapping, so a deterministic stub keeps the signal
  // spaceKey assertions readable ('repo-project:beta' etc.).
  repoNameForSpace: (s: { id: string }) => `repo-${s.id}`,
}));
vi.mock('../src/main/sync-spaces/git-transport', () => ({
  GitTransport: class {
    async init(): Promise<void> {}
    async setRemote(): Promise<void> {}
  },
}));
vi.mock('../src/main/sync-spaces/daily-backup', () => ({
  DailyBackup: class { async runIfDue(): Promise<void> {} },
}));
vi.mock('../src/main/sync-hub-socket', () => ({
  // Return the shared spy surface; capture the opts so tests can drive the
  // socket's onEvent callback (connected / disconnected / signal).
  createSyncHubSocket: (opts: any) => {
    h.hub.opts = opts;
    return {
      setDesired: h.hub.setDesired,
      sendSignal: h.hub.sendSignal,
      isConnected: h.hub.isConnected,
      destroy: h.hub.destroy,
      request: h.hub.request,
    };
  },
}));

async function freshService() {
  vi.resetModules();
  h.engines.length = 0;
  const svc = await import('../src/main/sync-spaces/service');
  await svc.startSyncSpaces(async () => [], () => {});
  return svc;
}

/** Wait until the Nth engine exists AND is suspended inside addSpace. Polls
 *  the live array — the engine is constructed asynchronously (inside the
 *  chained transition), so it can't be captured before calling this. */
async function waitForGate(index: number): Promise<void> {
  await vi.waitFor(() => {
    expect(h.engines.length).toBeGreaterThan(index);
    expect(h.engines[index].releaseAddSpace).toBeTruthy();
  });
}

describe('sync-spaces service transition serialization', () => {
  beforeEach(() => {
    h.engines.length = 0;
    // Reset per-test knobs so the serialization tests keep the default single
    // space + blocking addSpace gate they were written against.
    h.spaces = [{ id: 'personal', kind: 'personal', root: '/fake/personal' }];
    h.projects = [];
    h.registry = [];
    h.ensureEntry.mockClear();
    h.setDisplay.mockClear();
    h.setStopped.mockClear();
    h.ensureRemoteFails = false;
    h.autoAddSpace = false;
    h.initialEnabled = false;
    h.onEvent = null;
    // Reset the SyncHub fake so setDesired/sendSignal/destroy call counts and
    // the captured opts don't bleed across tests.
    h.hub.opts = null;
    h.hub.setDesired.mockClear();
    h.hub.sendSignal.mockClear();
    h.hub.isConnected.mockClear();
    h.hub.destroy.mockClear();
    h.hub.request.mockClear();
  });

  it('disable issued mid-start waits for the start, then stops that engine (no interleave)', async () => {
    const svc = await freshService();
    const p1 = svc.syncSpacesEnable(true);
    await waitForGate(0);
    const e1 = h.engines[0];
    // Disable while the start is suspended inside addSpace. Serialization
    // means this must NOT stop the engine yet.
    const p2 = svc.syncSpacesEnable(false);
    await new Promise((r) => setTimeout(r, 10));
    expect(e1.stopped).toBe(false);
    // Release the start; it completes, THEN the queued disable stops it.
    e1.releaseAddSpace!();
    const [s1, s2] = await Promise.all([p1, p2]);
    expect(e1.added).toEqual(['personal']); // start finished cleanly, not abandoned mid-loop
    expect(e1.stopped).toBe(true);          // queued disable then stopped it
    expect(s1.enabled).toBe(false);         // status reads run after BOTH queued transitions
    expect(s2.enabled).toBe(false);
    expect((await svc.syncSpacesStatus()).enabled).toBe(false);
  });

  it('rapid enable→disable→enable leaves exactly one live engine, all others stopped', async () => {
    const svc = await freshService();
    const p1 = svc.syncSpacesEnable(true);
    await waitForGate(0);
    const p2 = svc.syncSpacesEnable(false);
    const p3 = svc.syncSpacesEnable(true);
    h.engines[0].releaseAddSpace!();
    // Second start blocks on its own addSpace gate once the disable ran.
    await waitForGate(1);
    h.engines[1].releaseAddSpace!();
    await Promise.all([p1, p2, p3]);
    expect(h.engines[0].stopped).toBe(true);
    expect(h.engines[1].stopped).toBe(false);
    expect(h.engines[1].added).toEqual(['personal']);
    expect((await svc.syncSpacesStatus()).enabled).toBe(true);
  });

  // ---- Per-space sync-now + event timestamps (Project View UX, Task 2) ----

  // These use autoAddSpace so enable() resolves without manual gating, and a
  // two-project space set so "sync one" vs "sync everything" are distinguishable.
  async function enabledMultiSpaceService() {
    h.autoAddSpace = true;
    // Spaces now derive from h.projects (stateful ManagedRoots mock) — personal
    // is always present.
    h.projects = ['alpha', 'beta'];
    const svc = await freshService();
    await svc.syncSpacesEnable(true);
    return svc;
  }

  it('syncSpacesSyncNow(spaceId) syncs ONLY the matching space', async () => {
    const svc = await enabledMultiSpaceService();
    const engine = h.engines[0];
    engine.syncSpace.mockClear(); // drop the initial-reconcile calls from enable
    await svc.syncSpacesSyncNow('project:beta');
    expect(engine.syncSpace).toHaveBeenCalledTimes(1);
    expect(engine.syncSpace.mock.calls[0][0].id).toBe('project:beta');
  });

  it('syncSpacesSyncNow() with no arg still syncs every space', async () => {
    const svc = await enabledMultiSpaceService();
    const engine = h.engines[0];
    engine.syncSpace.mockClear();
    await svc.syncSpacesSyncNow();
    expect(engine.syncSpace.mock.calls.length).toBeGreaterThan(1);
  });

  it('syncSpacesSyncNow rejects while Backup & Sync is turned off', async () => {
    const svc = await freshService();
    await expect(svc.syncSpacesSyncNow()).rejects.toThrow('Turn on Backup & Sync before trying again.');
  });

  it('syncSpacesSyncNow rejects when its requested space no longer exists', async () => {
    const svc = await enabledMultiSpaceService();
    await expect(svc.syncSpacesSyncNow('project:missing')).rejects.toThrow(
      'This synced space is no longer available. Refresh and try again.',
    );
  });

  // ---- Awaitable sync variant (2026-07-18 takeover mirror-before-release fix) ----
  // syncSpacesSyncNowAwaited backs the takeover handoff barrier: it must NOT resolve
  // until the targeted space's push settles (unlike fire-and-forget syncSpacesSyncNow).

  it('syncSpacesSyncNowAwaited does NOT resolve until the targeted space sync settles', async () => {
    const svc = await enabledMultiSpaceService();
    const engine = h.engines[0];
    // Gate the matching space's sync so we control when it "lands".
    let releaseSync!: () => void;
    engine.syncSpace = vi.fn((space: { id: string }) =>
      space.id === 'project:beta'
        ? new Promise<void>((r) => { releaseSync = r; })
        : Promise.resolve()) as any;

    let resolved = false;
    const p = svc.syncSpacesSyncNowAwaited('project:beta', 10_000).then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 20)); // let the call reach the engine
    expect(engine.syncSpace).toHaveBeenCalled();
    expect(resolved).toBe(false); // parked awaiting the push — must not have resolved

    releaseSync();
    await p;
    expect(resolved).toBe(true);
  });

  it('syncSpacesSyncNowAwaited resolves after the timeout even if the sync never settles', async () => {
    const svc = await enabledMultiSpaceService();
    const engine = h.engines[0];
    engine.syncSpace = vi.fn(() => new Promise<void>(() => { /* never settles */ })) as any;
    const start = Date.now();
    // 50ms timeout: the handoff must never hard-block on a stuck push.
    await svc.syncSpacesSyncNowAwaited('project:beta', 50);
    expect(Date.now() - start).toBeLessThan(5_000); // resolved via the timeout, not the sync
  });

  it('syncSpacesSyncNowAwaited targets ONLY the matching space', async () => {
    const svc = await enabledMultiSpaceService();
    const engine = h.engines[0];
    engine.syncSpace.mockClear();
    await svc.syncSpacesSyncNowAwaited('project:alpha', 10_000);
    expect(engine.syncSpace).toHaveBeenCalledTimes(1);
    expect(engine.syncSpace.mock.calls[0][0].id).toBe('project:alpha');
  });

  it('broadcast stamps events with an `at` timestamp', async () => {
    const svc = await enabledMultiSpaceService();
    // Fire the engine's onEvent hook (= service.broadcast) the way the real
    // engine would when a space finishes syncing.
    h.onEvent!({ type: 'synced', spaceId: 'project:beta', pushed: true, updated: false });
    const st = await svc.syncSpacesStatus();
    const e = st.recentEvents.find((x: any) => x.spaceId === 'project:beta');
    expect(typeof (e as any).at).toBe('number');
  });

  // ---- SyncHub wiring (Task 5): signals in/out, reconcile, status ----

  it('enabling sync creates the hub socket (deviceName=hostname, setDesired true); disabling tears it down', async () => {
    const svc = await enabledMultiSpaceService();
    expect(h.hub.opts).toBeTruthy();
    expect(h.hub.opts.deviceName).toBe(os.hostname());
    expect(h.hub.setDesired).toHaveBeenCalledWith(true);
    await svc.syncSpacesEnable(false);
    expect(h.hub.setDesired).toHaveBeenCalledWith(false);
    expect(h.hub.destroy).toHaveBeenCalled();
  });

  it('a hub signal for a known repo name syncs exactly that space; unknown is a no-op', async () => {
    const svc = await enabledMultiSpaceService();
    const engine = h.engines[0];
    engine.syncSpace.mockClear(); // drop the initial-reconcile calls from enable
    h.hub.opts.onEvent({ type: 'signal', kind: 'space-updated', spaceKey: 'repo-project:beta' });
    expect(engine.syncSpace).toHaveBeenCalledTimes(1);
    expect(engine.syncSpace.mock.calls[0][0].id).toBe('project:beta');
    engine.syncSpace.mockClear();
    h.hub.opts.onEvent({ type: 'signal', kind: 'space-updated', spaceKey: 'repo-nope' });
    expect(engine.syncSpace).not.toHaveBeenCalled();
    // Keep the service in a clean state for teardown; unrelated to the assertion.
    void svc;
  });

  it('hub connected reconciles every space and flips syncHub to connected', async () => {
    const svc = await enabledMultiSpaceService();
    const engine = h.engines[0];
    engine.syncSpace.mockClear();
    h.hub.opts.onEvent({ type: 'connected' });
    const ids = engine.syncSpace.mock.calls.map((c: any) => c[0].id).sort();
    expect(ids).toEqual(['personal', 'project:alpha', 'project:beta']);
    expect((await svc.syncSpacesStatus()).syncHub).toBe('connected');
  });

  it('a push (synced, pushed:true) signals the room; pushed:false sends nothing', async () => {
    const svc = await enabledMultiSpaceService();
    h.hub.sendSignal.mockClear();
    h.onEvent!({ type: 'synced', spaceId: 'project:beta', pushed: true, updated: false });
    expect(h.hub.sendSignal).toHaveBeenCalledWith('space-updated', 'repo-project:beta');
    h.hub.sendSignal.mockClear();
    h.onEvent!({ type: 'synced', spaceId: 'project:beta', pushed: false, updated: true });
    expect(h.hub.sendSignal).not.toHaveBeenCalled();
    void svc;
  });

  it('syncHub is "off" when sync is disabled', async () => {
    h.autoAddSpace = true;
    h.spaces = [{ id: 'personal', kind: 'personal', root: '/fake/personal' }];
    const svc = await freshService();
    expect((await svc.syncSpacesStatus()).syncHub).toBe('off');
  });

  it('hub connect/disconnect emit stamped hub-status events into recentEvents', async () => {
    const svc = await enabledMultiSpaceService();
    h.hub.opts.onEvent({ type: 'connected' });
    h.hub.opts.onEvent({ type: 'disconnected' });
    const evs = (await svc.syncSpacesStatus()).recentEvents.filter((e: any) => e.type === 'hub-status');
    expect(evs.map((e: any) => e.status)).toEqual(['connected', 'disconnected']);
    expect(typeof (evs[0] as any).at).toBe('number');
  });

  it('a superseded boot start must not clobber hubStatus set by the newer live socket', async () => {
    // Boot with sync already enabled so startSyncSpaces launches an UNCHAINED
    // startEngine — the only run not serialized through `transition`, so it
    // can resume AFTER a disable/enable pair has installed a newer engine +
    // socket. The superseded run must bail without touching hubStatus (or
    // creating a socket): stamping 'connecting'/'off' here would make
    // syncSpacesStatus() lie about a live connection until the next reconnect.
    h.initialEnabled = true;
    vi.resetModules();
    h.engines.length = 0;
    const svc = await import('../src/main/sync-spaces/service');
    // Don't await — the boot start is suspended inside engines[0].addSpace.
    const bootP = svc.startSyncSpaces(async () => [], () => {});
    await waitForGate(0);
    // Rapid disable → enable while the boot start is still suspended. These are
    // chained, so the enable's start (engines[1]) runs after the disable.
    const pOff = svc.syncSpacesEnable(false);
    const pOn = svc.syncSpacesEnable(true);
    await waitForGate(1);
    h.engines[1].releaseAddSpace!();
    await Promise.all([pOff, pOn]);
    // The newer run's socket connects.
    h.hub.opts.onEvent({ type: 'connected' });
    expect((await svc.syncSpacesStatus()).syncHub).toBe('connected');
    // Now the superseded boot run resumes and bails — status must be untouched.
    h.engines[0].releaseAddSpace!();
    await bootP;
    expect((await svc.syncSpacesStatus()).syncHub).toBe('connected');
  });

  // ---- Main-process listener hook (Task 5): onSyncSpacesEvent ----
  // behavior contract:
  // 1. onSyncSpacesEvent(fn) subscribes; an engine event reaches fn with the
  //    stamped `at` field; the returned unsubscribe fn stops delivery.
  // 2. a listener that THROWS does not break other listeners or the window/
  //    remote/hub fan-outs (assert a second listener still fires and the event
  //    still lands in recentEvents).

  it('onSyncSpacesEvent delivers stamped events; unsubscribe stops delivery', async () => {
    const svc = await enabledMultiSpaceService();
    const received: any[] = [];
    const unsub = svc.onSyncSpacesEvent((e: any) => received.push(e));
    // Fire an engine event (= service.broadcast) the way the real engine would.
    h.onEvent!({ type: 'synced', spaceId: 'project:beta', pushed: false, updated: true });
    expect(received.length).toBe(1);
    expect(received[0].spaceId).toBe('project:beta');
    expect(typeof received[0].at).toBe('number'); // stamped by broadcast()
    unsub();
    h.onEvent!({ type: 'synced', spaceId: 'project:alpha', pushed: false, updated: true });
    expect(received.length).toBe(1); // no delivery after unsubscribe
  });

  it('a throwing listener does not strand other listeners, the hub send, or recentEvents', async () => {
    const svc = await enabledMultiSpaceService();
    h.hub.sendSignal.mockClear();
    const good: any[] = [];
    // First listener throws; second must still fire (per-listener isolation).
    svc.onSyncSpacesEvent(() => { throw new Error('bad listener'); });
    svc.onSyncSpacesEvent((e: any) => good.push(e));
    // pushed:true so the hub send (which runs AFTER the local fan-out) also fires.
    h.onEvent!({ type: 'synced', spaceId: 'project:beta', pushed: true, updated: false });
    expect(good.length).toBe(1); // second listener still delivered
    // Hub send comes after the local listeners — a throwing listener must not
    // strand it.
    expect(h.hub.sendSignal).toHaveBeenCalledWith('space-updated', 'repo-project:beta');
    // And the event still landed in recentEvents.
    const st = await svc.syncSpacesStatus();
    expect(st.recentEvents.some((x: any) => x.spaceId === 'project:beta')).toBe(true);
  });

  // ---- Cross-device project discovery / register (2026-07-12) ----

  it('creating a project registers it (name + deterministic repoName)', async () => {
    h.autoAddSpace = true;
    const svc = await freshService();
    await svc.syncSpacesEnable(true);
    await svc.syncSpacesCreateProject('delta');
    // repoNameForSpace is stubbed to `repo-${id}` in this harness, so the
    // deterministic repo name derived from the project id is 'repo-project:delta'.
    expect(h.ensureEntry).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'delta', repoName: 'repo-project:delta' }),
    );
  });

  // ---- Discovery / materialize / stop gate / triggers (2026-07-12) ----

  async function enabledSvc() {
    h.autoAddSpace = true;
    const svc = await freshService();
    await svc.syncSpacesEnable(true);
    return svc;
  }

  it('discovery materializes a registered active project missing locally', async () => {
    const svc = await enabledSvc();
    h.registry = [{ schemaVersion: 1, name: 'gamma', repoName: 'r-gamma', displayName: 'gamma', state: 'active', updatedAt: 1 }];
    const engine = h.engines[0];
    engine.added.length = 0;
    h.hub.opts.onEvent({ type: 'connected' }); // reconcile-on-connect → runDiscovery
    await vi.waitFor(() => expect(h.projects).toContain('gamma'));
    expect(engine.added).toContain('project:gamma');
    void svc;
  });

  it('discovery skips an already-local project', async () => {
    h.autoAddSpace = true;
    h.projects = ['alpha'];
    const svc = await freshService();
    await svc.syncSpacesEnable(true);
    h.registry = [{ schemaVersion: 1, name: 'alpha', repoName: 'r-alpha', displayName: 'alpha', state: 'active', updatedAt: 1 }];
    const before = [...h.projects];
    h.hub.opts.onEvent({ type: 'connected' });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.projects).toEqual(before); // no new create
    void svc;
  });

  it('a materialize failure (ensureRemote rejects) emits an error and creates no space', async () => {
    const svc = await enabledSvc();
    h.registry = [{ schemaVersion: 1, name: 'gamma', repoName: 'r-gamma', displayName: 'gamma', state: 'active', updatedAt: 1 }];
    h.ensureRemoteFails = true;
    const engine = h.engines[0];
    engine.added.length = 0;
    h.hub.opts.onEvent({ type: 'connected' });
    await vi.waitFor(async () => {
      const st = await svc.syncSpacesStatus();
      expect(st.recentEvents.some((e: any) => e.type === 'error' && String(e.spaceId).includes('gamma'))).toBe(true);
    });
    expect(engine.added).not.toContain('project:gamma');
    expect(h.projects).not.toContain('gamma');
    void svc;
  });

  it('a Personal synced+updated event triggers discovery', async () => {
    const svc = await enabledSvc();
    h.registry = [{ schemaVersion: 1, name: 'gamma', repoName: 'r-gamma', displayName: 'gamma', state: 'active', updatedAt: 1 }];
    // Simulate the engine emitting a Personal-space applied-changes event.
    h.onEvent!({ type: 'synced', spaceId: 'personal', pushed: false, updated: true });
    await vi.waitFor(() => expect(h.projects).toContain('gamma'));
    void svc;
  });

  it('the active-space gate keeps a stopped project out at engine start', async () => {
    h.autoAddSpace = true;
    h.projects = ['beta'];
    h.registry = [{ schemaVersion: 1, name: 'beta', repoName: 'r-beta', displayName: 'beta', state: 'stopped', updatedAt: 1 }];
    const svc = await freshService();
    await svc.syncSpacesEnable(true);
    const engine = h.engines[0];
    expect(engine.added).not.toContain('project:beta'); // gated out
    void svc;
  });

  // ---- Rename + stop + payload overlay (2026-07-12) ----

  it('syncSpacesRenameProject writes displayName + pushes Personal', async () => {
    h.autoAddSpace = true; h.projects = ['app'];
    const svc = await freshService();
    await svc.syncSpacesEnable(true);
    await svc.syncSpacesRenameProject('app', 'Cool App');
    expect(h.setDisplay).toHaveBeenCalledWith(expect.objectContaining({ name: 'app', dn: 'Cool App' }));
    // Personal was synced to push the rename (engine.syncSpace called for personal).
    expect(h.engines[0].synced).toContain('personal');
  });

  it('syncSpacesStopProject tombstones, pushes Personal, and removes the live space', async () => {
    h.autoAddSpace = true; h.projects = ['app'];
    const svc = await freshService();
    await svc.syncSpacesEnable(true);
    const engine = h.engines[0];
    await svc.syncSpacesStopProject('app');
    expect(h.setStopped).toHaveBeenCalledWith(expect.objectContaining({ name: 'app' }));
    expect(engine.removed).toContain('project:app'); // detached, folder kept
    expect(h.engines[0].synced).toContain('personal'); // pushed
  });

  it('status spaces carry displayName + state for synced projects', async () => {
    h.autoAddSpace = true; h.projects = ['app'];
    h.registry = [{ schemaVersion: 1, name: 'app', repoName: 'r-app', displayName: 'Cool App', state: 'active', updatedAt: 1 }];
    const svc = await freshService();
    await svc.syncSpacesEnable(true);
    const st = await svc.syncSpacesStatus();
    const row = st.spaces.find((s: any) => s.id === 'project:app');
    expect(row.displayName).toBe('Cool App');
    expect(row.state).toBe('active');
  });

  // ---- Lease bridge (Task 8): hubLeaseRequest passthrough + lease-event facade ----

  it('hubLeaseRequest resolves null when no hub socket exists (sync disabled)', async () => {
    const svc = await freshService(); // not enabled → no hub socket created
    await expect(svc.hubLeaseRequest('get', 's1', 'dev-a')).resolves.toBeNull();
  });

  it('hubLeaseRequest routes through the hub socket when enabled', async () => {
    const svc = await enabledMultiSpaceService();
    const res = await svc.hubLeaseRequest('acquire', 's2', 'dev-a');
    expect(h.hub.request).toHaveBeenCalledWith('acquire', 's2', 'dev-a');
    expect(res).toMatchObject({ ok: true, op: 'acquire', sessionId: 's2' });
  });

  it('a hub lease-event reaches the registered lease-event listener', async () => {
    const svc = await enabledMultiSpaceService();
    const received: any[] = [];
    svc.setSyncSpacesLeaseEventListener((ev: any) => received.push(ev));
    const leaseEvent = { type: 'lease-event', kind: 'takeover-request', sessionId: 's3', from: { deviceId: 'dev-b', device: 'Laptop-B' } };
    h.hub.opts.onEvent(leaseEvent);
    expect(received).toEqual([leaseEvent]);
    // Non-lease events (signal/connected/disconnected) must NOT reach it.
    received.length = 0;
    h.hub.opts.onEvent({ type: 'connected' });
    expect(received).toEqual([]);
    svc.setSyncSpacesLeaseEventListener(null); // clean up module facade
  });
});
