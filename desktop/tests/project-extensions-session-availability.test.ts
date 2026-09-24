// resolveSessionAvailability (T2, project-plugin-controls): the IO shell
// NativeSessionHost.create() calls to freeze a new session's availability
// set. Uses real temp dirs for the store side (same style as
// project-extensions-store.test.ts) and injected `candidates` to isolate
// project-key resolution from the real fs (candidates.ts has its own tests).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { NativeHome } from '../src/main/native-home';
import { resolveSessionAvailability } from '../src/main/project-extensions/session-availability';
import type { ProjectExtensionsStores } from '../src/main/project-extensions/store';
import type { CatalogSkillEntry, CatalogMcpEntry } from '../src/main/project-extensions/resolve';

const NOW = 1_800_000_000_000;

describe('resolveSessionAvailability', () => {
  let root: string;
  let stores: ProjectExtensionsStores;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-session-avail-'));
    stores = { personalRoot: path.join(root, 'Personal'), home: new NativeHome(root) };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const skills: CatalogSkillEntry[] = [
    { id: 'youcoded-chatsearch', source: 'plugin', pluginName: 'youcoded-chatsearch' },
    { id: 'civic:report', source: 'plugin', pluginName: 'civic' },
    { id: 'notes', source: 'self' },
  ];
  const mcp: CatalogMcpEntry[] = [
    { id: 'gmail', origin: { kind: 'user' } },
  ];

  it('B-1: real candidates exist but none matches this cwd — empty sets, projectKey null, no seed write', async () => {
    const result = await resolveSessionAvailability('/some/cwd', {
      projectsRoot: null, stores, skills, mcp, installs: {}, now: NOW,
      candidates: [{ path: '/somewhere/else', syncName: 'Elsewhere' }],
    });
    expect(result).toEqual({ projectKey: null, skillCatalogIds: new Set(), mcpServerIds: new Set() });
    // B-1 never seeds — there is no project to seed.
    expect(fs.existsSync(path.join(stores.personalRoot, 'ProjectExtensions'))).toBe(false);
  });

  it('an EMPTY candidate list (nothing ever saved on this device) fails open — "don\'t know", never B-1', async () => {
    // Distinct from the B-1 case above: zero candidates at all means the
    // folders store was never seeded (a bootstrap state real usage never
    // reaches, since Home is always seeded first) rather than a confident
    // "this cwd is outside every project" decision.
    const result = await resolveSessionAvailability('/some/cwd', {
      projectsRoot: null, stores, skills, mcp, installs: {}, now: NOW, candidates: [],
    });
    expect(result).toBeNull();
  });

  it('a matched project seeds once and resolves today\'s defaults (everything bundled/pre-existing stays on)', async () => {
    const result = await resolveSessionAvailability('/home/dest/MyProject', {
      projectsRoot: null, stores, skills, mcp, installs: {}, now: NOW,
      candidates: [{ path: '/home/dest/MyProject', syncName: 'MyProject' }],
    });
    expect(result?.projectKey).toBe('MyProject');
    expect(result?.skillCatalogIds).toEqual(new Set(['youcoded-chatsearch', 'civic:report', 'notes']));
    expect(result?.mcpServerIds).toEqual(new Set(['gmail']));
    // Actually seeded on disk (materialized), not just resolved in memory.
    const file = path.join(stores.personalRoot, 'ProjectExtensions', 'MyProject.json');
    expect(fs.existsSync(file)).toBe(true);
  });

  it('translates resolve.ts itemKeys back to catalog/server ids correctly for an OFF item', async () => {
    // Seed first with civic off explicitly, then resolve again — a second
    // call reads the already-seeded record rather than re-seeding.
    const file = path.join(stores.personalRoot, 'ProjectExtensions', 'Proj.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1, seededAt: NOW,
      plugins: {}, items: { 'civic:report': { on: false, at: NOW }, 'mcp:gmail': { on: false, at: NOW } },
    }));
    const result = await resolveSessionAvailability('/p', {
      projectsRoot: null, stores, skills, mcp, installs: {}, now: NOW + 100,
      candidates: [{ path: '/p', syncName: 'Proj' }],
    });
    expect(result?.skillCatalogIds.has('civic:report')).toBe(false);
    expect(result?.skillCatalogIds.has('youcoded-chatsearch')).toBe(true); // unaffected item stays on
    expect(result?.mcpServerIds.has('gmail')).toBe(false);
  });

  it('no stores wired (bare test host) answers null — "don\'t know", never B-1\'s empty set', async () => {
    const result = await resolveSessionAvailability('/p', {
      projectsRoot: null, stores: null, skills, mcp, installs: {}, now: NOW,
      candidates: [{ path: '/p', syncName: 'Proj' }],
    });
    expect(result).toBeNull();
  });

  it('fails OPEN (null) when the underlying store throws, instead of blocking the session', async () => {
    // A stores object whose personalRoot is a FILE (not a directory) makes
    // fs.promises.mkdir(recursive) inside ensureSeeded's write path throw.
    const badFile = path.join(root, 'not-a-dir');
    fs.writeFileSync(badFile, 'x');
    const badStores: ProjectExtensionsStores = { personalRoot: badFile, home: new NativeHome(root) };
    const result = await resolveSessionAvailability('/p', {
      projectsRoot: null, stores: badStores, skills, mcp, installs: {}, now: NOW,
      candidates: [{ path: '/p', syncName: 'Proj' }],
    });
    expect(result).toBeNull();
  });
});
