import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NativeHome } from '../src/main/native-home';
import {
  projectExtensionsGet, projectExtensionsSet, projectExtensionsForSession,
  type ProjectExtensionsIpcDeps,
} from '../src/main/project-extensions/ipc-shell';
import type { NativeSessionListEntry } from '../src/main/harness/session-store';

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
});
