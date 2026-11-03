// openFilepath is the ONE resolve-and-open path shared by FilepathToken clicks and the deliverable auto-open.
// Click mode opens the drawer up front; `drawerOpensImmediately: false` (auto-open) defers it until a match and
// dispatches NOTHING on a miss. Step 2 asks the cheap tracked list before the full-disk scan. A test that installs NO
// `resolvePath` stub is a bridge without artifacts:resolve-path (older host) and exercises the list-based lookup.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { openFilepath } from '../src/renderer/hooks/useOpenFilepath';
import { isRemoteMode, setConnectionMode } from '../src/renderer/platform';
import { DESKTOP_WINDOW_CAPABILITIES, REMOTE_SCREEN_CAPABILITIES } from '../src/shared/capabilities';
import type { ArtifactState } from '../src/renderer/state/artifact-tracker';
import type { ArtifactAction } from '../src/renderer/state/artifact-actions';
import type { ArtifactRecord } from '../src/shared/artifacts/types';

function makeState(overrides: Partial<ArtifactState> = {}): ArtifactState {
  return {
    sessionArtifacts: {},
    sessionCwd: {},
    ...overrides,
  } as ArtifactState;
}

function makeCtx(state: ArtifactState) {
  const dispatched: ArtifactAction[] = [];
  const dispatch = (action: ArtifactAction) => dispatched.push(action);
  return { ctx: { state, dispatch }, dispatched };
}

function record(id: string, path: string): ArtifactRecord {
  return {
    id,
    kind: 'internal',
    path,
    absolutePath: null,
  } as unknown as ArtifactRecord;
}

/** The record the host answers for an on-disk file nobody tracked. */
function discoveredRecord(path: string): ArtifactRecord {
  return {
    id: path, path, kind: 'internal', absolutePath: null, lastModified: '',
    status: 'active', versions: [], comments: [], tags: [], discovered: true,
  };
}

function installClaudeArtifacts(stubs: {
  listProject?: (cwd: string) => Promise<any>;
  listAllFiles?: (cwd: string) => Promise<any>;
  listSession?: (sessionId: string, cwd: string) => Promise<any>;
  appendVersion?: (cwd: string, sessionId: string, args: any) => Promise<any>;
  resolvePath?: (cwd: string, path: string, sessionId?: string) => Promise<any>;
}) {
  const listProject = vi.fn(stubs.listProject ?? (async () => ({ ok: true, artifacts: [] })));
  const listAllFiles = vi.fn(stubs.listAllFiles ?? (async () => ({ ok: true, files: [] })));
  const listSession = vi.fn(stubs.listSession ?? (async () => ({ ok: true, artifacts: [] })));
  const appendVersion = vi.fn(stubs.appendVersion ?? (async () => ({ ok: true })));
  const resolvePath = stubs.resolvePath ? vi.fn(stubs.resolvePath) : undefined;
  (globalThis as any).window = {
    ...(globalThis as any).window,
    claude: {
      // The host's answer for this screen: a screen watching a computer may not write (`projectWrites`). Picked by the
      // connection mode each test sets before installing, so the cases keep naming the screen they are about.
      capabilities: isRemoteMode() ? REMOTE_SCREEN_CAPABILITIES : DESKTOP_WINDOW_CAPABILITIES,
      artifacts: { listProject, listAllFiles, listSession, appendVersion, ...(resolvePath ? { resolvePath } : {}) },
    },
  };
  return { listProject, listAllFiles, listSession, appendVersion, resolvePath };
}

afterEach(() => { setConnectionMode('local'); });

const types = (d: ArtifactAction[]) => d.map((a) => a.type);
const selectedIds = (d: ArtifactAction[]) => d.filter((a) => a.type === 'ACTIVE_ARTIFACT_SET').map((a) => (a as any).artifactId);
const last = (d: ArtifactAction[]) => d[d.length - 1] as any;

describe('openFilepath — default mode (click behaviour) is unchanged', () => {
  it('dispatches DRAWER_OPENED before the lookup resolves', async () => {
    let resolveProject!: (v: any) => void;
    installClaudeArtifacts({
      listProject: () => new Promise((res) => { resolveProject = res; }),
      listAllFiles: async () => ({ ok: true, files: [] }), // reached on the miss path once listProject settles
    });
    const state = makeState({ sessionCwd: { s1: '/proj' } });
    const { ctx, dispatched } = makeCtx(state);

    const p = openFilepath(ctx, 's1', '/proj/a.md');
    // Drawer + error-clear + the pending note must be synchronous, well before any await settles.
    expect(types(dispatched)).toEqual(['DRAWER_OPENED', 'PILL_ERROR_CLEARED', 'PILL_RESOLVE_STARTED']);

    resolveProject({ ok: true, artifacts: [] });
    await p;
  });

  it('still dispatches PILL_RESOLVE_FAILED on a total miss (buildArtifactifyArgs rejects the path)', async () => {
    installClaudeArtifacts({
      listProject: async () => ({ ok: true, artifacts: [] }),
      listAllFiles: async () => ({ ok: true, files: [] }),
    });
    const state = makeState({ sessionCwd: { s1: '/proj' } });
    const { ctx, dispatched } = makeCtx(state);

    // '~' paths always make buildArtifactifyArgs return null: the early-return failure branch.
    await openFilepath(ctx, 's1', '~/no-such-file.md');
    expect(types(dispatched)).toEqual([
      'DRAWER_OPENED',
      'PILL_ERROR_CLEARED',
      'PILL_RESOLVE_STARTED',
      'PILL_RESOLVE_FAILED',
    ]);
  });

  it('dispatches PILL_RESOLVE_FAILED when artifactify runs but the refreshed session list still has no match', async () => {
    installClaudeArtifacts({
      listProject: async () => ({ ok: true, artifacts: [] }),
      listAllFiles: async () => ({ ok: true, files: [] }),
      // artifactify succeeds but the refreshed list has nothing matching the clicked path
      listSession: async () => ({ ok: true, artifacts: [] }),
    });
    const state = makeState({ sessionCwd: { s1: '/proj' } });
    const { ctx, dispatched } = makeCtx(state);

    await openFilepath(ctx, 's1', '/proj/orphan.md');
    expect(types(dispatched)).toEqual([
      'DRAWER_OPENED',
      'PILL_ERROR_CLEARED',
      'PILL_RESOLVE_STARTED',
      'SESSION_ARTIFACTS_LOADED',
      'PILL_RESOLVE_FAILED',
    ]);
  });

  it('dispatches SESSION_ARTIFACTS_LOADED then ACTIVE_ARTIFACT_SET on artifactify success', async () => {
    installClaudeArtifacts({
      listProject: async () => ({ ok: true, artifacts: [] }),
      listAllFiles: async () => ({ ok: true, files: [] }),
      // refreshed list holds the just-artifactified file (stored relative, clicked absolute)
      listSession: async () => ({ ok: true, artifacts: [record('art-5', 'new-doc.md')] }),
    });
    const state = makeState({ sessionCwd: { s1: '/proj' } });
    const { ctx, dispatched } = makeCtx(state);

    await openFilepath(ctx, 's1', '/proj/new-doc.md');
    expect(types(dispatched)).toEqual([
      'DRAWER_OPENED',
      'PILL_ERROR_CLEARED',
      'PILL_RESOLVE_STARTED',
      'SESSION_ARTIFACTS_LOADED',
      'ACTIVE_ARTIFACT_SET',
    ]);
    expect((dispatched[4] as any).artifactId).toBe('art-5');
  });
});

describe('openFilepath — deferred mode (drawerOpensImmediately: false)', () => {
  it('session-list hit: no dispatch before the match, then DRAWER_OPENED before ACTIVE_ARTIFACT_SET', async () => {
    const state = makeState({
      sessionArtifacts: { s1: [record('art-1', 'a.md')] },
      sessionCwd: { s1: '/proj' },
    });
    installClaudeArtifacts({});
    const { ctx, dispatched } = makeCtx(state);

    expect(dispatched.length).toBe(0); // nothing before the call
    await openFilepath(ctx, 's1', 'a.md', { drawerOpensImmediately: false });
    expect(types(dispatched)).toEqual(['DRAWER_OPENED', 'ACTIVE_ARTIFACT_SET']);
    expect((dispatched[1] as any).artifactId).toBe('art-1');
  });

  it('project hit (step 2): no dispatch before the match, then DRAWER_OPENED before the upsert/select pair', async () => {
    const state = makeState({ sessionCwd: { s1: '/proj' } });
    installClaudeArtifacts({
      listProject: async () => ({ ok: true, artifacts: [record('art-2', 'b.md')] }),
      listAllFiles: async () => ({ ok: true, files: [] }),
    });
    const { ctx, dispatched } = makeCtx(state);

    await openFilepath(ctx, 's1', 'b.md', { drawerOpensImmediately: false });
    expect(types(dispatched)).toEqual([
      'DRAWER_OPENED',
      'SESSION_ARTIFACT_UPSERTED',
      'ACTIVE_ARTIFACT_SET',
    ]);
  });

  it('total miss: dispatch is never called at all', async () => {
    const state = makeState({ sessionCwd: { s1: '/proj' } });
    installClaudeArtifacts({
      listProject: async () => ({ ok: true, artifacts: [] }),
      listAllFiles: async () => ({ ok: true, files: [] }),
    });
    const { ctx, dispatched } = makeCtx(state);

    await openFilepath(ctx, 's1', '/proj/nowhere.md', { drawerOpensImmediately: false });
    expect(dispatched.length).toBe(0);
  });

  it('no cwd (immediate failure path): dispatch is never called at all', async () => {
    const state = makeState(); // no sessionCwd entry
    installClaudeArtifacts({});
    const { ctx, dispatched } = makeCtx(state);

    await openFilepath(ctx, 's1', '/proj/x.md', { drawerOpensImmediately: false });
    expect(dispatched.length).toBe(0);
  });

  it('tracked miss: never selects an ephemeral discovered record — listAllFiles is not consulted and the eventual selection is the persisted sidecar id, not the relative-path discovered id', async () => {
    const state = makeState({ sessionCwd: { s1: '/proj' } });
    // WHY: a DISCOVERED record's id is the ephemeral relative path a tracker refresh would wipe from under ACTIVE_ARTIFACT_SET.
    const { listAllFiles, listProject, appendVersion } = installClaudeArtifacts({
      listProject: async () => ({ ok: true, artifacts: [] }), // tracked miss
      listAllFiles: async () => ({ ok: true, files: [record('e.md', 'e.md')] }),
      // artifactify's own refresh comes back with a real sidecar id.
      listSession: async () => ({ ok: true, artifacts: [record('art-9', 'e.md')] }),
    });
    const { ctx, dispatched } = makeCtx(state);

    await openFilepath(ctx, 's1', '/proj/e.md', { drawerOpensImmediately: false });

    expect(listProject).toHaveBeenCalledTimes(1);
    // deferred mode must not ask the disk-scan question on a tracked miss
    expect(listAllFiles).not.toHaveBeenCalled();
    expect(appendVersion).toHaveBeenCalledTimes(1);
    const selected = dispatched.find((a) => a.type === 'ACTIVE_ARTIFACT_SET') as any;
    expect(selected?.artifactId).toBe('art-9');
    expect(selected?.artifactId).not.toBe('e.md');
  });

  it('artifactify success: no dispatch before the match, then DRAWER_OPENED, SESSION_ARTIFACTS_LOADED, ACTIVE_ARTIFACT_SET', async () => {
    const state = makeState({ sessionCwd: { s1: '/proj' } });
    installClaudeArtifacts({
      listProject: async () => ({ ok: true, artifacts: [] }),
      listAllFiles: async () => ({ ok: true, files: [] }),
      listSession: async () => ({ ok: true, artifacts: [record('art-6', 'new-doc.md')] }),
    });
    const { ctx, dispatched } = makeCtx(state);

    expect(dispatched.length).toBe(0); // nothing before the call
    await openFilepath(ctx, 's1', '/proj/new-doc.md', { drawerOpensImmediately: false });
    expect(types(dispatched)).toEqual([
      'DRAWER_OPENED',
      'SESSION_ARTIFACTS_LOADED',
      'ACTIVE_ARTIFACT_SET',
    ]);
    expect((dispatched[2] as any).artifactId).toBe('art-6');
  });
});

describe('openFilepath — step 2 asks the cheap question first', () => {
  it.each([
    ['tracked hit', [record('art-3', 'c.md')], [], 'art-3', 0],
    ['tracked miss (full-disk scan runs and its match is used)', [], [record('art-4', 'c.md')], 'art-4', 1],
  ])('%s', async (_n, tracked, scanned, id, scans) => {
    const { listAllFiles, listProject } = installClaudeArtifacts({
      listProject: async () => ({ ok: true, artifacts: tracked }),
      listAllFiles: async () => ({ ok: true, files: scanned }),
    });
    const { ctx, dispatched } = makeCtx(makeState({ sessionCwd: { s1: '/proj' } }));
    await openFilepath(ctx, 's1', 'c.md');
    expect(listProject).toHaveBeenCalledTimes(1);
    expect(listAllFiles).toHaveBeenCalledTimes(scans);
    expect(selectedIds(dispatched)).toContain(id);
  });
});

// WHY: a phone tap once downloaded the whole project list (~1 MB) and then attempted a write it may not make; one host question replaces it.
describe('openFilepath — one host lookup replaces listing the project', () => {
  const WS = '/home/destin/youcoded-dev';
  const TAPPED = `${WS}/wecoded-themes/CLAUDE.md`;

  it('a resolved file opens with no project listing and no write; the pending note is set, then cleared by the selection', async () => {
    const stubs = installClaudeArtifacts({ resolvePath: async () => ({ ok: true, artifact: discoveredRecord('wecoded-themes/CLAUDE.md') }) });
    // The session list holds the ROOT CLAUDE.md — the file the old matcher opened instead.
    const state = makeState({ sessionCwd: { s1: WS }, sessionArtifacts: { s1: [record('root-claude', 'CLAUDE.md')] } });
    const { ctx, dispatched } = makeCtx(state);

    await openFilepath(ctx, 's1', TAPPED);

    // A tap names its chat, so the host can look beside that chat's files for a short path.
    expect(stubs.resolvePath).toHaveBeenCalledWith(WS, TAPPED, 's1');
    expect(types(dispatched)).toEqual([
      'DRAWER_OPENED', 'PILL_ERROR_CLEARED', 'PILL_RESOLVE_STARTED', 'SESSION_ARTIFACT_UPSERTED', 'ACTIVE_ARTIFACT_SET',
    ]);
    expect(dispatched[2]).toMatchObject({ type: 'PILL_RESOLVE_STARTED', sessionId: 's1', name: 'CLAUDE.md' });
    expect((dispatched[4] as any).artifactId).toBe('wecoded-themes/CLAUDE.md');
    expect(stubs.listProject).not.toHaveBeenCalled();
    expect(stubs.listAllFiles).not.toHaveBeenCalled();
    expect(stubs.appendVersion).not.toHaveBeenCalled();
    expect(stubs.listSession).not.toHaveBeenCalled();
  });

  it('each refusal ends the pending note with words that say what is actually true, and never writes', async () => {
    const cases: Array<[mode: 'local' | 'remote', error: string, words: RegExp]> = [
      ['local', 'not-found', /no file exists at that path/],
      ['local', 'not-a-file', /isn’t a file/],
      ['local', 'protected-path', /protected location/],
      // two gates, two truths: a folder not shared at all vs a chat-only folder sharing only its recorded files
      ['remote', 'not-allowed', /isn’t available to remote devices/],
      ['remote', 'not-tracked', /already worked with/],
      ['remote', 'outside-project', /outside this chat’s project folder/],
      // A code this client does not know is shown as the host said it — never replaced with a guess.
      ['remote', 'EACCES: permission denied', /EACCES: permission denied/],
    ];
    for (const [mode, error, words] of cases) {
      setConnectionMode(mode);
      const stubs = installClaudeArtifacts({ resolvePath: async () => ({ ok: false, error }) });
      const { ctx, dispatched } = makeCtx(makeState({ sessionCwd: { s1: WS } }));
      await openFilepath(ctx, 's1', TAPPED);
      const msg = last(dispatched);
      expect(msg.type, error).toBe('PILL_RESOLVE_FAILED');
      expect(msg.message, error).toMatch(words);
      expect(msg.message, error).toContain('CLAUDE.md');
      expect(stubs.appendVersion, error).not.toHaveBeenCalled();
      expect(stubs.listProject, error).not.toHaveBeenCalled();
    }
  });

  it('on the desktop, a file outside the folder is still recorded and opened, as before', async () => {
    const stubs = installClaudeArtifacts({
      resolvePath: async () => ({ ok: false, error: 'outside-project' }),
      listSession: async () => ({
        ok: true,
        artifacts: [{ ...record('art-x', 'report.xlsx'), kind: 'external', absolutePath: '/tmp/out/report.xlsx' }],
      }),
    });
    const { ctx, dispatched } = makeCtx(makeState({ sessionCwd: { s1: '/proj' } }));
    await openFilepath(ctx, 's1', '/tmp/out/report.xlsx');
    expect(stubs.appendVersion).toHaveBeenCalledWith('/proj', 's1', expect.objectContaining({ kind: 'external', absolutePath: '/tmp/out/report.xlsx' }));
    expect(stubs.listProject).not.toHaveBeenCalled();
    expect(last(dispatched)).toMatchObject({ type: 'ACTIVE_ARTIFACT_SET', artifactId: 'art-x' });
  });

  it('over remote access, a file outside the folder gets a note — no write is attempted', async () => {
    setConnectionMode('remote');
    const stubs = installClaudeArtifacts({ resolvePath: async () => ({ ok: false, error: 'outside-project' }) });
    const { ctx, dispatched } = makeCtx(makeState({ sessionCwd: { s1: '/proj' } }));
    await openFilepath(ctx, 's1', '/tmp/out/report.xlsx');
    expect(stubs.appendVersion).not.toHaveBeenCalled();
    expect(last(dispatched)).toMatchObject({ type: 'PILL_RESOLVE_FAILED' });
  });

  it('a bridge that REJECTS the lookup (older host, timeout) falls back to the list-based lookup', async () => {
    const stubs = installClaudeArtifacts({
      resolvePath: async () => { throw new Error('remote-unsupported: artifacts:resolve-path'); },
      listProject: async () => ({ ok: true, artifacts: [] }),
      listAllFiles: async () => ({ ok: true, files: [record('d.md', 'd.md')] }),
    });
    const { ctx, dispatched } = makeCtx(makeState({ sessionCwd: { s1: '/proj' } }));
    await openFilepath(ctx, 's1', '/proj/d.md');
    expect(stubs.listProject).toHaveBeenCalledTimes(1);
    expect(stubs.listAllFiles).toHaveBeenCalledTimes(1);
    expect(last(dispatched)).toMatchObject({ type: 'ACTIVE_ARTIFACT_SET', artifactId: 'd.md' });
  });

  it("the Android app's answer (not-implemented-on-mobile, which the bridge RESOLVES as data) falls back too", async () => {
    const stubs = installClaudeArtifacts({
      resolvePath: async () => ({ ok: false, error: 'not-implemented-on-mobile' }),
      listProject: async () => ({ ok: true, artifacts: [record('art-2', 'b.md')] }),
    });
    const { ctx, dispatched } = makeCtx(makeState({ sessionCwd: { s1: '/proj' } }));
    await openFilepath(ctx, 's1', '/proj/b.md');
    expect(stubs.listProject).toHaveBeenCalledTimes(1);
    expect(dispatched.some((a) => a.type === 'PILL_RESOLVE_FAILED')).toBe(false);
    expect(last(dispatched)).toMatchObject({ type: 'ACTIVE_ARTIFACT_SET', artifactId: 'art-2' });
  });
});

describe('openFilepath — a slow tap never lands after a newer one', () => {
  it('tap A, then tap B: A answering late changes nothing', async () => {
    let releaseA!: (v: any) => void;
    installClaudeArtifacts({
      resolvePath: (_cwd, p) => (p.endsWith('/a.md')
        ? new Promise((r) => { releaseA = r; })
        : Promise.resolve({ ok: true, artifact: discoveredRecord('b.md') })),
    });
    const { ctx, dispatched } = makeCtx(makeState({ sessionCwd: { s1: '/proj' } }));

    const tapA = openFilepath(ctx, 's1', '/proj/a.md');
    await openFilepath(ctx, 's1', '/proj/b.md');
    const afterB = dispatched.length;
    releaseA({ ok: true, artifact: discoveredRecord('a.md') });
    await tapA;

    expect(dispatched.length).toBe(afterB);
    expect(selectedIds(dispatched)).toEqual(['b.md']);
  });

  it("a stale tap's failure neither shows a note nor records anything", async () => {
    let releaseA!: (v: any) => void;
    const stubs = installClaudeArtifacts({
      resolvePath: (_cwd, p) => (p.endsWith('/a.md')
        ? new Promise((r) => { releaseA = r; })
        : Promise.resolve({ ok: true, artifact: discoveredRecord('b.md') })),
    });
    const { ctx, dispatched } = makeCtx(makeState({ sessionCwd: { s1: '/proj' } }));

    const tapA = openFilepath(ctx, 's1', '/proj/a.md');
    await openFilepath(ctx, 's1', '/proj/b.md');
    const afterB = dispatched.length;
    // On the desktop an outside-project answer would record the file — not for a stale tap.
    releaseA({ ok: false, error: 'outside-project' });
    await tapA;

    expect(dispatched.length).toBe(afterB);
    expect(stubs.appendVersion).not.toHaveBeenCalled();
  });

  it('a tap in another chat does not cancel this one', async () => {
    let releaseA!: (v: any) => void;
    installClaudeArtifacts({
      resolvePath: (_cwd, p) => (p.endsWith('/a.md')
        ? new Promise((r) => { releaseA = r; })
        : Promise.resolve({ ok: true, artifact: discoveredRecord('b.md') })),
    });
    const { ctx, dispatched } = makeCtx(makeState({ sessionCwd: { s1: '/proj', s2: '/proj' } }));

    const tapA = openFilepath(ctx, 's1', '/proj/a.md');
    await openFilepath(ctx, 's2', '/proj/b.md');
    releaseA({ ok: true, artifact: discoveredRecord('a.md') });
    await tapA;

    expect(dispatched).toContainEqual({ type: 'ACTIVE_ARTIFACT_SET', sessionId: 's1', artifactId: 'a.md' });
  });
});

describe('openFilepath — deferred mode with the host lookup', () => {
  it('a TRACKED answer opens, revealing the drawer only with the file', async () => {
    const tracked = { ...record('art-7', 'notes.md'), versions: [{ id: 'v1' }] } as unknown as ArtifactRecord;
    const stubs = installClaudeArtifacts({ resolvePath: async () => ({ ok: true, artifact: tracked }) });
    const { ctx, dispatched } = makeCtx(makeState({ sessionCwd: { s1: '/proj' } }));
    await openFilepath(ctx, 's1', '/proj/notes.md', { drawerOpensImmediately: false });
    expect(types(dispatched)).toEqual(['DRAWER_OPENED', 'SESSION_ARTIFACT_UPSERTED', 'ACTIVE_ARTIFACT_SET']);
    expect(stubs.appendVersion).not.toHaveBeenCalled();
  });

  it('a DISCOVERED answer is never selected: on the desktop the file is recorded first, and the persisted id is opened', async () => {
    const stubs = installClaudeArtifacts({
      resolvePath: async () => ({ ok: true, artifact: discoveredRecord('e.md') }),
      listSession: async () => ({ ok: true, artifacts: [record('art-9', 'e.md')] }),
    });
    const { ctx, dispatched } = makeCtx(makeState({ sessionCwd: { s1: '/proj' } }));
    await openFilepath(ctx, 's1', '/proj/e.md', { drawerOpensImmediately: false });
    expect(stubs.appendVersion).toHaveBeenCalledTimes(1);
    const selected = selectedIds(dispatched);
    expect(selected).toEqual(['art-9']);
  });

  it('a DISCOVERED answer over remote access (no write possible) is a silent no-op', async () => {
    setConnectionMode('remote');
    const stubs = installClaudeArtifacts({ resolvePath: async () => ({ ok: true, artifact: discoveredRecord('e.md') }) });
    const { ctx, dispatched } = makeCtx(makeState({ sessionCwd: { s1: '/proj' } }));
    await openFilepath(ctx, 's1', '/proj/e.md', { drawerOpensImmediately: false });
    expect(dispatched).toEqual([]);
    expect(stubs.appendVersion).not.toHaveBeenCalled();
  });

  it('a refusal dispatches nothing at all', async () => {
    installClaudeArtifacts({ resolvePath: async () => ({ ok: false, error: 'not-found' }) });
    const { ctx, dispatched } = makeCtx(makeState({ sessionCwd: { s1: '/proj' } }));
    await openFilepath(ctx, 's1', '/proj/gone.md', { drawerOpensImmediately: false });
    expect(dispatched).toEqual([]);
  });
});

// Review 2026-09-11, findings 3, 5 and 6.
describe('openFilepath — a tap and an auto-open in the same chat', () => {
  function gatedResolve() {
    const release: Record<string, (v: any) => void> = {};
    const resolvePath = (_cwd: string, p: string) => new Promise((r) => { release[p] = r; });
    return { release, resolvePath };
  }

  it('an auto-open that arrives while a tap is still looking up yields: the tap lands, the auto-open does nothing', async () => {
    const gate = gatedResolve();
    const stubs = installClaudeArtifacts({ resolvePath: gate.resolvePath });
    const { ctx, dispatched } = makeCtx(makeState({ sessionCwd: { s1: '/proj' } }));

    const tap = openFilepath(ctx, 's1', '/proj/tapped.md');
    const auto = openFilepath(ctx, 's1', '/proj/deliverable.md', { drawerOpensImmediately: false });
    await auto;
    expect(stubs.resolvePath).toHaveBeenCalledTimes(1); // the auto-open never even asked
    gate.release['/proj/tapped.md']({ ok: true, artifact: discoveredRecord('tapped.md') });
    await tap;

    expect(selectedIds(dispatched)).toEqual(['tapped.md']);
  });

  it('a tap during an auto-open wins; the auto-open answering late changes nothing', async () => {
    const gate = gatedResolve();
    installClaudeArtifacts({ resolvePath: gate.resolvePath });
    const { ctx, dispatched } = makeCtx(makeState({ sessionCwd: { s1: '/proj' } }));

    const auto = openFilepath(ctx, 's1', '/proj/deliverable.md', { drawerOpensImmediately: false });
    const tap = openFilepath(ctx, 's1', '/proj/tapped.md');
    gate.release['/proj/tapped.md']({ ok: true, artifact: discoveredRecord('tapped.md') });
    await tap;
    const afterTap = dispatched.length;
    gate.release['/proj/deliverable.md']({ ok: true, artifact: { ...discoveredRecord('deliverable.md'), discovered: undefined } });
    await auto;

    expect(dispatched.length).toBe(afterTap);
    expect(selectedIds(dispatched)).toEqual(['tapped.md']);
  });
});

describe('openFilepath — a failed lookup is not a missing file', () => {
  it('a timeout shows what happened, and does NOT fall back to downloading the project list', async () => {
    setConnectionMode('remote');
    const stubs = installClaudeArtifacts({
      resolvePath: async () => { throw new Error('Request artifacts:resolve-path timed out'); },
    });
    const { ctx, dispatched } = makeCtx(makeState({ sessionCwd: { s1: '/proj' } }));
    await openFilepath(ctx, 's1', '/proj/a.md');
    const msg = last(dispatched);
    expect(msg.type).toBe('PILL_RESOLVE_FAILED');
    expect(msg.message).toContain('timed out');
    expect(msg.message).not.toMatch(/wasn’t found/);
    expect(stubs.listProject).not.toHaveBeenCalled();
    expect(stubs.listAllFiles).not.toHaveBeenCalled();
  });

  it('on the desktop, a ~ path outside the folder says it is outside — not "not found"', async () => {
    const stubs = installClaudeArtifacts({ resolvePath: async () => ({ ok: false, error: 'outside-project' }) });
    const { ctx, dispatched } = makeCtx(makeState({ sessionCwd: { s1: '/proj' } }));
    await openFilepath(ctx, 's1', '~/Downloads/report.md');
    const msg = last(dispatched);
    expect(msg.type).toBe('PILL_RESOLVE_FAILED');
    expect(msg.message).toMatch(/outside this chat’s project folder/);
    expect(stubs.appendVersion).not.toHaveBeenCalled();
  });
});

// A chat starts in one folder, the assistant works in another, and names a file by a
// path relative to where it was working. The host finds it beside the chat's own files.
describe('openFilepath — a short path found beside this chat\'s other files', () => {
  const FOUND = '/home/u/banner/icon6/s-bands.png';
  const externalRecord = (id: string, abs: string): ArtifactRecord => ({
    id, path: abs.split('/').pop()!, kind: 'external', absolutePath: abs, lastModified: '',
    status: 'active', versions: [], comments: [], tags: [],
  });

  it('one match outside the folder is recorded by its FULL location and opened', async () => {
    const stubs = installClaudeArtifacts({
      resolvePath: async (_cwd, p) => (p === FOUND
        ? { ok: false, error: 'outside-project' }
        : { ok: false, error: 'not-found', searchedNearby: true, elsewhere: [FOUND] }),
      listSession: async () => ({ ok: true, artifacts: [externalRecord('rec-found', FOUND)] }),
    });
    const { ctx, dispatched } = makeCtx(makeState({ sessionCwd: { s1: '/home/u/youcoded-dev' } }));
    await openFilepath(ctx, 's1', 'icon6/s-bands.png');

    expect(stubs.resolvePath).toHaveBeenNthCalledWith(1, '/home/u/youcoded-dev', 'icon6/s-bands.png', 's1');
    expect(stubs.appendVersion).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(stubs.appendVersion.mock.calls[0][2])).toContain(FOUND);
    expect(selectedIds(dispatched)).toEqual(['rec-found']);
    expect(dispatched.some((a) => a.type === 'PILL_RESOLVE_FAILED')).toBe(false);
  });

  it('one match inside the folder opens the host\'s record without any write', async () => {
    const inside = '/proj/sub/icon6/s.png';
    const stubs = installClaudeArtifacts({
      resolvePath: async (_cwd, p) => (p === inside
        ? { ok: true, artifact: discoveredRecord('sub/icon6/s.png') }
        : { ok: false, error: 'not-found', searchedNearby: true, elsewhere: [inside] }),
    });
    const { ctx, dispatched } = makeCtx(makeState({ sessionCwd: { s1: '/proj' } }));
    await openFilepath(ctx, 's1', 'icon6/s.png');
    expect(stubs.appendVersion).not.toHaveBeenCalled();
    expect(selectedIds(dispatched)).toEqual(['sub/icon6/s.png']);
  });

  it('two matches open nothing and list both locations', async () => {
    const stubs = installClaudeArtifacts({
      resolvePath: async () => ({ ok: false, error: 'not-found', searchedNearby: true, elsewhere: ['/a/x/out.png', '/b/x/out.png'] }),
    });
    const { ctx, dispatched } = makeCtx(makeState({ sessionCwd: { s1: '/proj' } }));
    await openFilepath(ctx, 's1', 'x/out.png');
    expect(stubs.resolvePath).toHaveBeenCalledTimes(1);
    expect(stubs.appendVersion).not.toHaveBeenCalled();
    expect(dispatched.some((a) => a.type === 'ACTIVE_ARTIFACT_SET')).toBe(false);
    const msg = last(dispatched);
    expect(msg.type).toBe('PILL_RESOLVE_FAILED');
    expect(msg.message).toContain('/a/x/out.png');
    expect(msg.message).toContain('/b/x/out.png');
  });

  it('no match says where it looked', async () => {
    installClaudeArtifacts({ resolvePath: async () => ({ ok: false, error: 'not-found', searchedNearby: true }) });
    const { ctx, dispatched } = makeCtx(makeState({ sessionCwd: { s1: '/proj' } }));
    await openFilepath(ctx, 's1', 'x/out.png');
    const msg = last(dispatched);
    expect(msg.type).toBe('PILL_RESOLVE_FAILED');
    expect(msg.message).toMatch(/isn’t in this chat’s folder \(\/proj\) or next to the other files/);
  });

  it('an auto-open never asks for the nearby search and never opens by it', async () => {
    const stubs = installClaudeArtifacts({
      resolvePath: async () => ({ ok: false, error: 'not-found', searchedNearby: true, elsewhere: ['/a/x/out.png'] }),
    });
    const { ctx, dispatched } = makeCtx(makeState({ sessionCwd: { s1: '/proj' } }));
    await openFilepath(ctx, 's1', 'x/out.png', { drawerOpensImmediately: false });
    expect(stubs.resolvePath).toHaveBeenCalledWith('/proj', 'x/out.png');
    expect(stubs.resolvePath).toHaveBeenCalledTimes(1);
    expect(dispatched).toEqual([]);
  });

  it('a newer tap during the second look wins; the found file is not opened', async () => {
    let releaseSecond!: (v: any) => void;
    installClaudeArtifacts({
      resolvePath: (_cwd, p) => (p === FOUND
        ? new Promise((r) => { releaseSecond = r; })
        : p === '/proj/other.md'
          ? Promise.resolve({ ok: true, artifact: discoveredRecord('other.md') })
          : Promise.resolve({ ok: false, error: 'not-found', searchedNearby: true, elsewhere: [FOUND] })),
    });
    const { ctx, dispatched } = makeCtx(makeState({ sessionCwd: { s1: '/proj' } }));
    const first = openFilepath(ctx, 's1', 'icon6/s-bands.png');
    await vi.waitFor(() => expect(releaseSecond).toBeTypeOf('function'));
    await openFilepath(ctx, 's1', '/proj/other.md');
    releaseSecond({ ok: false, error: 'outside-project' });
    await first;
    expect(selectedIds(dispatched)).toEqual(['other.md']);
  });
});
