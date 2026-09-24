import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NativeHome } from '../src/main/native-home';
import {
  projectExtensionsGet, projectExtensionsSet, projectExtensionsForSession,
  type ProjectExtensionsIpcDeps,
} from '../src/main/project-extensions/ipc-shell';
import type { NativeSessionListEntry } from '../src/main/harness/session-store';

// T3 review F3 — ipc-shell.ts's candidatesAndStores() reads the REAL
// sync-spaces/service singleton (getManagedRoots()), not something deps.ts
// lets a caller inject. To prove get()/set() route a SYNCED project by its
// cross-device sync name rather than by whichever local path resolved it,
// the "two devices" test below has to swap what that singleton reports
// mid-test — this stub is the seam. `current: null` (the module-level
// default below) reproduces every OTHER test's real-world behaviour (no
// ManagedRoots constructed in a test process), so this mock is a no-op for
// them.
const managedRootsStub: { current: { personalRoot: string; projectsRoot: string } | null } = { current: null };
vi.mock('../src/main/sync-spaces/service', () => ({
  getManagedRoots: () => managedRootsStub.current,
}));

// candidates.ts imports `os` with `import * as os from 'os'` (a namespace
// import) rather than the default import skill-scanner.test.ts's convention
// mutates — under this project's ESM/CJS interop that namespace binding is a
// static snapshot, so reassigning `os.homedir` is both impossible (frozen)
// and, even worked around, invisible to that file. `os.homedir()` itself
// reads `process.env.HOME` live on POSIX regardless of import style, so
// overriding the ENV VAR (restored in afterEach) is the one mock that
// reaches every module transitively touched here (candidates.ts, NativeHome,
// skill-scanner.ts) without patching each one's own binding.
describe('project-extensions IPC shell (ipc-handlers.ts / remote-server.ts shared glue)', () => {
  let tmpHome: string;
  let tmpProject: string;
  let origHome: string | undefined;
  let deps: ProjectExtensionsIpcDeps;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-pe-ipc-home-'));
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-pe-ipc-project-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    fs.mkdirSync(path.join(tmpProject, '.claude', 'skills', 'notes'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpProject, '.claude', 'skills', 'notes', 'SKILL.md'),
      '---\nname: notes\ndescription: take notes\n---\nTake notes.',
    );
    // A real install always has at least one saved folder by the time any
    // native session exists (resolveSessionAvailability's own "Real usage
    // always seeds a Home folder" comment) — candidates.ts's
    // listProjectKeyCandidatesAsync reads exactly this file, and an EMPTY
    // one makes resolveSessionAvailability itself treat every call as "not
    // bootstrapped yet" (candidates.length === 0 -> null), which would make
    // settingsDiffer vacuously false regardless of this file's own logic.
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.claude', 'youcoded-folders.json'),
      JSON.stringify([{ path: tmpProject, nickname: 'Test Project', addedAt: Date.now() }]),
    );
    deps = {
      nativeHome: new NativeHome(tmpHome),
      mcpManager: { listEnabled: async () => ([{ id: 'lib', label: 'Library', origin: { kind: 'user' }, missingSecrets: [] } as any]) },
      skillConfigStore: { getPackages: () => ({}) },
    };
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 3 });
    fs.rmSync(tmpProject, { recursive: true, force: true, maxRetries: 3 });
  });

  it('get() seeds the project and returns the current catalog, ungrouped items under `personal`', async () => {
    const result = await projectExtensionsGet(deps, tmpProject);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.projectKey).toBe(tmpProject);
    expect(result.view.personal.map((p) => p.key).sort()).toEqual(['mcp:lib', 'project:notes']);
    expect(result.view.personal.every((p) => p.on)).toBe(true);
    expect(result.view.needsSetup).toEqual([]);
    // Seeded on disk — a torn-down and rebuilt NativeHome sees the same record.
    const record = JSON.parse(fs.readFileSync(path.join(tmpHome, '.youcoded', 'project-extensions.local.json'), 'utf8'));
    expect(record[tmpProject].seededAt).toBeGreaterThan(0);
  });

  it('set() turns an item off, returns the updated view, and the write survives a re-read', async () => {
    await projectExtensionsGet(deps, tmpProject); // seed first, matching real usage order
    const setResult = await projectExtensionsSet(deps, tmpProject, [{ item: 'mcp:lib', on: false }]);
    expect(setResult.ok).toBe(true);
    if (!setResult.ok) return;
    expect(setResult.view.personal.find((p) => p.key === 'mcp:lib')?.on).toBe(false);

    const getAgain = await projectExtensionsGet(deps, tmpProject);
    expect(getAgain.ok && getAgain.view.personal.find((p) => p.key === 'mcp:lib')?.on).toBe(false);
    // Re-seeding never resurrects an explicit choice.
    expect(getAgain.ok && getAgain.view.personal.find((p) => p.key === 'project:notes')?.on).toBe(true);
  });

  it('set() rejects a change naming neither plugin nor item, without touching the stored record', async () => {
    await projectExtensionsGet(deps, tmpProject);
    const result = await projectExtensionsSet(deps, tmpProject, [{ on: true } as any]);
    expect(result).toEqual({ ok: false, error: 'invalid-change' });
    const getAgain = await projectExtensionsGet(deps, tmpProject);
    expect(getAgain.ok && getAgain.view.personal.every((p) => p.on)).toBe(true); // untouched
  });

  function fakeHeader(overrides: Partial<NativeSessionListEntry & { provider: 'native' }> = {}): NativeSessionListEntry & { provider: 'native' } {
    return {
      v: 1, sessionId: 's-1', harnessId: 'coder', binding: { providerId: 'openrouter', modelId: 'm' },
      cwd: tmpProject, createdAt: Date.now(), mtimeMs: Date.now(), sizeBytes: 0, slug: 'slug', provider: 'native',
      ...overrides,
    };
  }

  it('for-session answers a typed error for an unknown session id', async () => {
    deps.nativeSessions = { listAsync: async () => [] };
    const result = await projectExtensionsForSession(deps, 'nope');
    expect(result).toEqual({ ok: false, error: 'no session found for that id' });
  });

  it('for-session echoes the frozen set and reports no difference when nothing has changed since create()', async () => {
    await projectExtensionsGet(deps, tmpProject); // seed
    deps.nativeSessions = {
      listAsync: async () => [fakeHeader({ availability: { projectKey: tmpProject, skillCatalogIds: ['notes'], mcpServerIds: ['lib'] } })],
    };
    const result = await projectExtensionsForSession(deps, 's-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projectKey).toBe(tmpProject);
    expect(result.frozenSkillIds).toEqual(['notes']);
    expect(result.frozenMcpIds).toEqual(['lib']);
    expect(result.missing).toEqual([]);
    expect(result.settingsDiffer).toBe(false);
  });

  it('for-session reports a difference once the project setting changes after the session froze', async () => {
    await projectExtensionsGet(deps, tmpProject); // seed
    deps.nativeSessions = {
      listAsync: async () => [fakeHeader({ availability: { projectKey: tmpProject, skillCatalogIds: ['notes'], mcpServerIds: ['lib'] } })],
    };
    await projectExtensionsSet(deps, tmpProject, [{ item: 'mcp:lib', on: false }]); // changes AFTER the session's own "create"
    const result = await projectExtensionsForSession(deps, 's-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frozenMcpIds).toEqual(['lib']); // the frozen set itself never moves
    expect(result.settingsDiffer).toBe(true);
  });

  it('for-session treats an absent frozen set (a pre-T2 session) as unrestricted, differing once the project turns something off', async () => {
    await projectExtensionsGet(deps, tmpProject);
    deps.nativeSessions = { listAsync: async () => [fakeHeader({ availability: undefined })] };
    const beforeAnyChange = await projectExtensionsForSession(deps, 's-1');
    expect(beforeAnyChange.ok && beforeAnyChange.frozenSkillIds).toBeNull();
    expect(beforeAnyChange.ok && beforeAnyChange.settingsDiffer).toBe(false);

    await projectExtensionsSet(deps, tmpProject, [{ item: 'mcp:lib', on: false }]);
    const afterChange = await projectExtensionsForSession(deps, 's-1');
    expect(afterChange.ok && afterChange.frozenMcpIds).toBeNull();
    expect(afterChange.ok && afterChange.settingsDiffer).toBe(true);
  });

  // T3 review F3: no test exercised the SYNCED-project path end to end — two
  // different cwds (two "devices") that both resolve to the same cross-device
  // `syncName` (project-key.ts) must read/write the SAME store.ts record,
  // never two separate ones keyed by each device's own differing local path.
  describe('synced project: set() from one device is read by get() from another', () => {
    it('routes two different cwds with the same folder basename to one shared record via the sync name', async () => {
      // personalRoot is the ONE thing real cross-device sync keeps identical
      // (Personal/ProjectExtensions/<name>.json) — projectsRoot (and so the
      // cwd under it) differs per device, which is exactly what this proves
      // does NOT fragment the stored record.
      const personalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-pe-ipc-personal-'));
      const projectsRootA = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-pe-ipc-projA-'));
      const projectsRootB = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-pe-ipc-projB-'));
      const cwdA = path.join(projectsRootA, 'shared-project');
      const cwdB = path.join(projectsRootB, 'shared-project'); // same basename, different absolute path
      fs.mkdirSync(cwdA, { recursive: true });
      fs.mkdirSync(cwdB, { recursive: true });

      try {
        managedRootsStub.current = { personalRoot, projectsRoot: projectsRootA };
        const getA = await projectExtensionsGet(deps, cwdA);
        expect(getA.ok).toBe(true);
        if (!getA.ok) return;
        expect(getA.view.projectKey).toBe(cwdA); // echoed back as THIS device's own path
        // Proves this really took the SYNCED branch (store.ts's
        // ProjectExtensions/<name>.json), not the unsynced local-path file.
        expect(fs.existsSync(path.join(personalRoot, 'ProjectExtensions', 'shared-project.json'))).toBe(true);

        const setResult = await projectExtensionsSet(deps, cwdA, [{ item: 'mcp:lib', on: false }]);
        expect(setResult.ok).toBe(true);
        expect(setResult.ok && setResult.view.personal.find((p) => p.key === 'mcp:lib')?.on).toBe(false);

        // "Device B": a different projectsRoot -> a different absolute cwd,
        // but the SAME sync name (folder basename) and the same personalRoot.
        managedRootsStub.current = { personalRoot, projectsRoot: projectsRootB };
        const getB = await projectExtensionsGet(deps, cwdB);
        expect(getB.ok).toBe(true);
        if (!getB.ok) return;
        expect(getB.view.projectKey).toBe(cwdB); // echoes device B's OWN path, never the sync name
        expect(getB.view.personal.find((p) => p.key === 'mcp:lib')?.on).toBe(false);
      } finally {
        managedRootsStub.current = null;
        fs.rmSync(personalRoot, { recursive: true, force: true, maxRetries: 3 });
        fs.rmSync(projectsRootA, { recursive: true, force: true, maxRetries: 3 });
        fs.rmSync(projectsRootB, { recursive: true, force: true, maxRetries: 3 });
      }
    });
  });
});
