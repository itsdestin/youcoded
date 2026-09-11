// openFilepath is the ONE resolve-and-open path shared by FilepathToken clicks
// and the deliverable auto-open (src/renderer/hooks/useOpenFilepath.ts). This
// pins two live-tested fixes:
//
// 1. `drawerOpensImmediately` (default true = today's exact click behaviour):
//    a click gets DRAWER_OPENED dispatched up front for instant feedback even
//    while the lookup is still in flight. An auto-open nobody clicked gets no
//    such benefit — opening early there just shows an empty/list-only panel
//    for however long the lookup takes. Passing `{ drawerOpensImmediately:
//    false }` defers DRAWER_OPENED until a match is actually found (dispatched
//    right before the ACTIVE_ARTIFACT_SET for that match), and dispatches
//    NOTHING on a miss — the user didn't ask for this, so a silent no-op beats
//    a panel popping open onto an error about a file they never clicked.
// 2. Step 2 (whole-project resolve) now awaits the cheap tracked-list lookup
//    FIRST and only pays for the full-disk scan (listAllFiles) on a miss —
//    see the WHY comment at the call site for the measured 4s cost of doing
//    both in parallel on a large workspace.
//
// And, since 2026-09-11, the host lookup (artifacts:resolve-path) that
// replaced step 2 wherever the bridge has it — see the last describe blocks.
// A test that installs NO `resolvePath` stub is a bridge without the channel
// (an older host), so it exercises the older list-based lookup, unchanged.
// A click now also dispatches PILL_RESOLVE_STARTED after PILL_ERROR_CLEARED
// (the drawer's "Opening …" note), which is the only change to the expected
// action lists of the tests above that block.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { openFilepath } from '../src/renderer/hooks/useOpenFilepath';
import { setConnectionMode } from '../src/renderer/platform';
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
  resolvePath?: (cwd: string, path: string) => Promise<any>;
}) {
  const listProject = vi.fn(stubs.listProject ?? (async () => ({ ok: true, artifacts: [] })));
  const listAllFiles = vi.fn(stubs.listAllFiles ?? (async () => ({ ok: true, files: [] })));
  const listSession = vi.fn(stubs.listSession ?? (async () => ({ ok: true, artifacts: [] })));
  const appendVersion = vi.fn(stubs.appendVersion ?? (async () => ({ ok: true })));
  const resolvePath = stubs.resolvePath ? vi.fn(stubs.resolvePath) : undefined;
  (globalThis as any).window = {
    ...(globalThis as any).window,
    claude: {
      artifacts: { listProject, listAllFiles, listSession, appendVersion, ...(resolvePath ? { resolvePath } : {}) },
    },
  };
  return { listProject, listAllFiles, listSession, appendVersion, resolvePath };
}

afterEach(() => { setConnectionMode('local'); });

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
    expect(dispatched.map((a) => a.type)).toEqual(['DRAWER_OPENED', 'PILL_ERROR_CLEARED', 'PILL_RESOLVE_STARTED']);

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

    // buildArtifactifyArgs (filepath-match.ts:80) returns null for ANY path
    // starting with '~', unconditionally — no cwd or session-list matching
    // ambiguity involved. So this fixture always takes the early-return branch
    // at useOpenFilepath.ts's `if (!args) { failed(); return; }`, never the
    // "artifactify ran but the refreshed list has no match" branch below it.
    await openFilepath(ctx, 's1', '~/no-such-file.md');
    expect(dispatched.map((a) => a.type)).toEqual([
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
      // appendVersion succeeds (default stub), but listSession comes back with
      // nothing findBestMatch can match against the clicked path — the miss
      // branch at useOpenFilepath.ts's `if (added) {...} else if
      // (drawerOpensImmediately) { dispatch(SESSION_ARTIFACTS_LOADED) }`,
      // followed by `if (!selected) failed();`.
      listSession: async () => ({ ok: true, artifacts: [] }),
    });
    const state = makeState({ sessionCwd: { s1: '/proj' } });
    const { ctx, dispatched } = makeCtx(state);

    await openFilepath(ctx, 's1', '/proj/orphan.md');
    expect(dispatched.map((a) => a.type)).toEqual([
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
      // listSession's refreshed list now contains the just-artifactified file
      // (stored relative as 'new-doc.md', clicked as the absolute
      // '/proj/new-doc.md' — with the folder known, findBestMatch compares the
      // full absolute forms, '/proj' + '/new-doc.md').
      listSession: async () => ({ ok: true, artifacts: [record('art-5', 'new-doc.md')] }),
    });
    const state = makeState({ sessionCwd: { s1: '/proj' } });
    const { ctx, dispatched } = makeCtx(state);

    await openFilepath(ctx, 's1', '/proj/new-doc.md');
    expect(dispatched.map((a) => a.type)).toEqual([
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
    expect(dispatched.map((a) => a.type)).toEqual(['DRAWER_OPENED', 'ACTIVE_ARTIFACT_SET']);
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
    expect(dispatched.map((a) => a.type)).toEqual([
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

  it('tracked miss (Finding 1 fix): never selects an ephemeral discovered record — listAllFiles is not consulted and the eventual selection is the persisted sidecar id, not the relative-path discovered id', async () => {
    const state = makeState({ sessionCwd: { s1: '/proj' } });
    // listAllFiles is wired to return a DISCOVERED record whose id is the raw
    // relative path (project-file-discovery.ts shape) — exactly the ephemeral
    // record a concurrent tracker refresh would wipe out from under
    // ACTIVE_ARTIFACT_SET. If deferred mode ever falls back to listAllFiles
    // like click mode does, this stub is what it would (wrongly) select.
    const { listAllFiles, listProject, appendVersion } = installClaudeArtifacts({
      listProject: async () => ({ ok: true, artifacts: [] }), // tracked miss
      listAllFiles: async () => ({ ok: true, files: [record('e.md', 'e.md')] }),
      // artifactify's own refresh comes back with a real sidecar id.
      listSession: async () => ({ ok: true, artifacts: [record('art-9', 'e.md')] }),
    });
    const { ctx, dispatched } = makeCtx(state);

    await openFilepath(ctx, 's1', '/proj/e.md', { drawerOpensImmediately: false });

    expect(listProject).toHaveBeenCalledTimes(1);
    // The direct pin on the fix: deferred mode must not even ask the disk-scan
    // question on a tracked miss, since asking it is what produces the
    // ephemeral id in the first place.
    expect(listAllFiles).not.toHaveBeenCalled();
    expect(appendVersion).toHaveBeenCalledTimes(1);
    // The behavioral outcome that matters to the user: whatever got selected
    // is the persisted sidecar id, never the discovered relative-path id.
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
    // Deferred mode skips the top-of-function PILL_ERROR_CLEARED entirely (it's
    // inside `if (drawerOpensImmediately)`), and DRAWER_OPENED is dispatched
    // only once the artifactify match is found (useOpenFilepath.ts:
    // `if (!drawerOpensImmediately) dispatch({ type: 'DRAWER_OPENED', ... })`
    // right before SESSION_ARTIFACTS_LOADED/ACTIVE_ARTIFACT_SET in the added-match branch).
    expect(dispatched.map((a) => a.type)).toEqual([
      'DRAWER_OPENED',
      'SESSION_ARTIFACTS_LOADED',
      'ACTIVE_ARTIFACT_SET',
    ]);
    expect((dispatched[2] as any).artifactId).toBe('art-6');
  });
});

describe('openFilepath — step 2 asks the cheap question first (Fix 2)', () => {
  it('tracked hit: listAllFiles is NEVER called', async () => {
    const state = makeState({ sessionCwd: { s1: '/proj' } });
    const { listAllFiles, listProject } = installClaudeArtifacts({
      listProject: async () => ({ ok: true, artifacts: [record('art-3', 'c.md')] }),
      listAllFiles: async () => ({ ok: true, files: [] }),
    });
    const { ctx, dispatched } = makeCtx(state);

    await openFilepath(ctx, 's1', 'c.md');
    expect(listProject).toHaveBeenCalledTimes(1);
    expect(listAllFiles).not.toHaveBeenCalled();
    expect(dispatched.some((a) => a.type === 'ACTIVE_ARTIFACT_SET' && (a as any).artifactId === 'art-3')).toBe(true);
  });

  it('tracked miss: listAllFiles IS called and its match is used', async () => {
    const state = makeState({ sessionCwd: { s1: '/proj' } });
    const { listAllFiles, listProject } = installClaudeArtifacts({
      listProject: async () => ({ ok: true, artifacts: [] }),
      listAllFiles: async () => ({ ok: true, files: [record('art-4', 'd.md')] }),
    });
    const { ctx, dispatched } = makeCtx(state);

    await openFilepath(ctx, 's1', 'd.md');
    expect(listProject).toHaveBeenCalledTimes(1);
    expect(listAllFiles).toHaveBeenCalledTimes(1);
    expect(dispatched.some((a) => a.type === 'ACTIVE_ARTIFACT_SET' && (a as any).artifactId === 'art-4')).toBe(true);
  });
});

// ── The host lookup (artifacts:resolve-path, 2026-09-11) ─────────────────────
//
// Found on the owner's phone: a tap on wecoded-themes/CLAUDE.md downloaded the
// whole project list (3,090 records, ~1 MB) to find one file, then — the file
// being inside a nested git repo discovery skips — fell through to a WRITE the
// phone may not make and said "not found". One host question replaces all of it.
describe('openFilepath — one host lookup replaces listing the project', () => {
  const WS = '/home/destin/youcoded-dev';
  const TAPPED = `${WS}/wecoded-themes/CLAUDE.md`;

  it('a resolved file opens with no project listing and no write; the pending note is set, then cleared by the selection', async () => {
    const stubs = installClaudeArtifacts({ resolvePath: async () => ({ ok: true, artifact: discoveredRecord('wecoded-themes/CLAUDE.md') }) });
    // The session list holds the ROOT CLAUDE.md — the file the old matcher opened instead.
    const state = makeState({ sessionCwd: { s1: WS }, sessionArtifacts: { s1: [record('root-claude', 'CLAUDE.md')] } });
    const { ctx, dispatched } = makeCtx(state);

    await openFilepath(ctx, 's1', TAPPED);

    expect(stubs.resolvePath).toHaveBeenCalledWith(WS, TAPPED);
    expect(dispatched.map((a) => a.type)).toEqual([
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
      // Two different gates, two different truths (review 2026-09-11, finding 4):
      // a folder the computer does not share at all, vs a chat-only folder that
      // shares only its recorded files.
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
      const last = dispatched[dispatched.length - 1] as any;
      expect(last.type, error).toBe('PILL_RESOLVE_FAILED');
      expect(last.message, error).toMatch(words);
      expect(last.message, error).toContain('CLAUDE.md');
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
    expect((dispatched[dispatched.length - 1] as any)).toMatchObject({ type: 'ACTIVE_ARTIFACT_SET', artifactId: 'art-x' });
  });

  it('over remote access, a file outside the folder gets a note — no write is attempted', async () => {
    setConnectionMode('remote');
    const stubs = installClaudeArtifacts({ resolvePath: async () => ({ ok: false, error: 'outside-project' }) });
    const { ctx, dispatched } = makeCtx(makeState({ sessionCwd: { s1: '/proj' } }));
    await openFilepath(ctx, 's1', '/tmp/out/report.xlsx');
    expect(stubs.appendVersion).not.toHaveBeenCalled();
    expect(dispatched[dispatched.length - 1]).toMatchObject({ type: 'PILL_RESOLVE_FAILED' });
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
    expect(dispatched[dispatched.length - 1]).toMatchObject({ type: 'ACTIVE_ARTIFACT_SET', artifactId: 'd.md' });
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
    expect(dispatched[dispatched.length - 1]).toMatchObject({ type: 'ACTIVE_ARTIFACT_SET', artifactId: 'art-2' });
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
    expect(dispatched.filter((a) => a.type === 'ACTIVE_ARTIFACT_SET').map((a) => (a as any).artifactId)).toEqual(['b.md']);
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
    expect(dispatched.map((a) => a.type)).toEqual(['DRAWER_OPENED', 'SESSION_ARTIFACT_UPSERTED', 'ACTIVE_ARTIFACT_SET']);
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
    const selected = dispatched.filter((a) => a.type === 'ACTIVE_ARTIFACT_SET').map((a) => (a as any).artifactId);
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

    expect(dispatched.filter((a) => a.type === 'ACTIVE_ARTIFACT_SET').map((a) => (a as any).artifactId)).toEqual(['tapped.md']);
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
    expect(dispatched.filter((a) => a.type === 'ACTIVE_ARTIFACT_SET').map((a) => (a as any).artifactId)).toEqual(['tapped.md']);
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
    const last = dispatched[dispatched.length - 1] as any;
    expect(last.type).toBe('PILL_RESOLVE_FAILED');
    expect(last.message).toContain('timed out');
    expect(last.message).not.toMatch(/wasn’t found/);
    expect(stubs.listProject).not.toHaveBeenCalled();
    expect(stubs.listAllFiles).not.toHaveBeenCalled();
  });

  it('on the desktop, a ~ path outside the folder says it is outside — not "not found"', async () => {
    const stubs = installClaudeArtifacts({ resolvePath: async () => ({ ok: false, error: 'outside-project' }) });
    const { ctx, dispatched } = makeCtx(makeState({ sessionCwd: { s1: '/proj' } }));
    await openFilepath(ctx, 's1', '~/Downloads/report.md');
    const last = dispatched[dispatched.length - 1] as any;
    expect(last.type).toBe('PILL_RESOLVE_FAILED');
    expect(last.message).toMatch(/outside this chat’s project folder/);
    expect(stubs.appendVersion).not.toHaveBeenCalled();
  });
});
