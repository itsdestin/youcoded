// Real filesystem (temp dir per test), no fs mocking — same style as
// native-home.test.ts and sync-spaces-project-registry.test.ts: the fold/lock
// behavior under test IS the filesystem interaction.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { NativeHome } from '../src/main/native-home';
import {
  getProjectExtensions, mutateProjectExtensions, ensureSeeded, markPluginRemoved,
  isSyncedProjectKey, parseProjectExtensionsRecord, mergeProjectExtensionsRecords,
  PROJECT_EXTENSIONS_SCHEMA, type ProjectExtensionsRecord, type ProjectExtensionsStores,
  type ProjectPluginState, type ProjectItemState,
} from '../src/main/project-extensions/store';
import type { CatalogSkillEntry, CatalogMcpEntry } from '../src/main/project-extensions/resolve';

const NOW = 1_800_000_000_000;

function emptyRecord(seededAt = 0): ProjectExtensionsRecord {
  return { schemaVersion: PROJECT_EXTENSIONS_SCHEMA, seededAt, plugins: {}, items: {} };
}

describe('isSyncedProjectKey', () => {
  it('treats a bare sync name as synced', () => {
    expect(isSyncedProjectKey('MyProject')).toBe(true);
  });

  it('treats any path (contains a separator) as unsynced — never a valid sync name', () => {
    expect(isSyncedProjectKey('/home/dest/Project')).toBe(false);
    expect(isSyncedProjectKey('C:\\Users\\dest\\Project')).toBe(false);
  });
});

describe('parseProjectExtensionsRecord', () => {
  it('returns null for invalid JSON or an unrecognized schema', () => {
    expect(parseProjectExtensionsRecord('not json')).toBeNull();
    expect(parseProjectExtensionsRecord(JSON.stringify({ schemaVersion: 2 }))).toBeNull();
  });

  it('drops one malformed entry without discarding the rest of the record', () => {
    const rec = parseProjectExtensionsRecord(JSON.stringify({
      schemaVersion: 1, seededAt: 5,
      plugins: { good: { on: true, partsChosen: true, at: 1 }, bad: { on: 'nope' } },
      items: { keep: { on: true, at: 2 }, drop: { at: 3 } },
    }));
    expect(rec?.plugins).toEqual({ good: { on: true, partsChosen: true, at: 1 } });
    expect(rec?.items).toEqual({ keep: { on: true, at: 2 } });
  });

  it('preserves an unknown field on a plugin/item entry instead of stripping it', () => {
    const rec = parseProjectExtensionsRecord(JSON.stringify({
      schemaVersion: 1, seededAt: 0,
      plugins: { p: { on: true, partsChosen: true, at: 1, futureField: 'x' } },
      items: {},
    }));
    expect((rec?.plugins.p as any).futureField).toBe('x');
  });

  // T1 review F2: a top-level field this build doesn't know about must
  // round-trip, same as a per-entry unknown field just above.
  it('preserves an unknown TOP-LEVEL field instead of stripping it', () => {
    const rec = parseProjectExtensionsRecord(JSON.stringify({
      schemaVersion: 1, seededAt: 0, plugins: {}, items: {}, futureTopLevelField: 'x',
    }));
    expect((rec as any)?.futureTopLevelField).toBe('x');
  });
});

describe('mergeProjectExtensionsRecords', () => {
  it('merges seededAt as the earliest NON-ZERO value', () => {
    expect(mergeProjectExtensionsRecords(emptyRecord(0), emptyRecord(500)).seededAt).toBe(500);
    expect(mergeProjectExtensionsRecords(emptyRecord(300), emptyRecord(500)).seededAt).toBe(300);
    expect(mergeProjectExtensionsRecords(emptyRecord(0), emptyRecord(0)).seededAt).toBe(0);
  });

  it('merges per entry, last-writer-wins by at — switching two different items on two devices both survive', () => {
    const a: ProjectExtensionsRecord = { ...emptyRecord(), items: { one: { on: true, at: 100 } } };
    const b: ProjectExtensionsRecord = { ...emptyRecord(), items: { two: { on: true, at: 200 } } };
    const m = mergeProjectExtensionsRecords(a, b);
    expect(m.items.one).toEqual({ on: true, at: 100 });
    expect(m.items.two).toEqual({ on: true, at: 200 });
  });

  it('the newer `at` wins on the SAME item key', () => {
    const oldItem: ProjectItemState = { on: true, at: 100 };
    const newItem: ProjectItemState = { on: false, at: 200 };
    const a: ProjectExtensionsRecord = { ...emptyRecord(), items: { x: oldItem } };
    const b: ProjectExtensionsRecord = { ...emptyRecord(), items: { x: newItem } };
    expect(mergeProjectExtensionsRecords(a, b).items.x).toEqual(newItem);
    expect(mergeProjectExtensionsRecords(b, a).items.x).toEqual(newItem); // commutative
  });

  it('the newer `at` wins on the SAME plugin key, same as an item', () => {
    const oldPlugin: ProjectPluginState = { on: true, partsChosen: true, at: 100 };
    const newPlugin: ProjectPluginState = { on: false, partsChosen: true, at: 200 };
    const a: ProjectExtensionsRecord = { ...emptyRecord(), plugins: { p: oldPlugin } };
    const b: ProjectExtensionsRecord = { ...emptyRecord(), plugins: { p: newPlugin } };
    expect(mergeProjectExtensionsRecords(a, b).plugins.p).toEqual(newPlugin);
  });

  it('preserves an unknown item key through a merge', () => {
    const a: ProjectExtensionsRecord = { ...emptyRecord(), items: { 'future:thing': { on: true, at: 1 } } };
    const b = emptyRecord();
    expect(mergeProjectExtensionsRecords(a, b).items['future:thing']).toEqual({ on: true, at: 1 });
  });

  // T1 review F2, merge half: the parse-level fix alone isn't enough — a
  // synced read folds copies through mergeProjectExtensionsRecords too, so
  // the merge itself must not drop an unknown top-level field either.
  it('preserves an unknown TOP-LEVEL field through a merge', () => {
    const a = { ...emptyRecord(), futureTopLevelField: 'x' } as ProjectExtensionsRecord;
    const b = emptyRecord();
    expect((mergeProjectExtensionsRecords(a, b) as any).futureTopLevelField).toBe('x');
  });
});

describe('getProjectExtensions / mutateProjectExtensions — synced store', () => {
  let root: string;
  let stores: ProjectExtensionsStores;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-proj-ext-'));
    stores = { personalRoot: path.join(root, 'Personal'), home: new NativeHome(root) };
  });
  // Fix (T1 review F3): maxRetries/retryDelay per test-suite-hygiene.md — a
  // late write into the temp dir (the lock file, a just-finished async write)
  // throws ENOTEMPTY out of a bare rmSync into a PASSING test.
  afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  it('reads null for a project with no record yet', async () => {
    expect(await getProjectExtensions(stores, 'MyProject')).toBeNull();
  });

  it('writes then reads back a synced record at Personal/ProjectExtensions/<name>.json', async () => {
    await mutateProjectExtensions(stores, 'MyProject', () => ({
      ...emptyRecord(NOW), items: { 'self:notes': { on: true, at: NOW } },
    }));
    const file = path.join(stores.personalRoot, 'ProjectExtensions', 'MyProject.json');
    expect(fs.existsSync(file)).toBe(true);
    const read = await getProjectExtensions(stores, 'MyProject');
    expect(read?.items['self:notes']).toEqual({ on: true, at: NOW });
  });

  it('folds a conflict copy into the canonical record on read, without writing anything back', async () => {
    const dir = path.join(stores.personalRoot, 'ProjectExtensions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MyProject.json'), JSON.stringify({
      ...emptyRecord(100), items: { a: { on: true, at: 100 } },
    }));
    fs.writeFileSync(path.join(dir, 'MyProject (from other-device, 2026-09-24).json'), JSON.stringify({
      ...emptyRecord(50), items: { b: { on: true, at: 200 } },
    }));
    const read = await getProjectExtensions(stores, 'MyProject');
    expect(read?.items.a).toEqual({ on: true, at: 100 });
    expect(read?.items.b).toEqual({ on: true, at: 200 }); // folded in from the copy
    expect(read?.seededAt).toBe(50); // earliest non-zero across both files
    // fold-on-read only, never a writeback:
    const canonicalOnDisk = JSON.parse(fs.readFileSync(path.join(dir, 'MyProject.json'), 'utf8'));
    expect(canonicalOnDisk.items.b).toBeUndefined();
  });

  it('a project name containing "(from ...)" is not itself misread as a conflict copy', async () => {
    // Regression class fixed in project-registry.ts for the SAME reason —
    // here it can't even arise the same way because the read is scoped to a
    // caller-known canonical name, but pin it anyway.
    await mutateProjectExtensions(stores, 'Recipes (from Grandma)', () => ({
      ...emptyRecord(NOW), items: { a: { on: true, at: NOW } },
    }));
    const read = await getProjectExtensions(stores, 'Recipes (from Grandma)');
    expect(read?.items.a).toEqual({ on: true, at: NOW });
  });
});

describe('getProjectExtensions / mutateProjectExtensions — unsynced (local) store', () => {
  let root: string;
  let stores: ProjectExtensionsStores;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-proj-ext-local-'));
    stores = { personalRoot: path.join(root, 'Personal'), home: new NativeHome(root) };
  });
  // Fix (T1 review F3): maxRetries/retryDelay per test-suite-hygiene.md — a
  // late write into the temp dir (the lock file, a just-finished async write)
  // throws ENOTEMPTY out of a bare rmSync into a PASSING test.
  afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  it('writes then reads back a local record keyed by canonical path, never touching Personal/', async () => {
    const key = '/home/dest/UnsyncedProject';
    await mutateProjectExtensions(stores, key, () => ({ ...emptyRecord(NOW), items: { a: { on: true, at: NOW } } }));
    expect(fs.existsSync(path.join(root, 'Personal'))).toBe(false);
    const file = path.join(root, '.youcoded', 'project-extensions.local.json');
    expect(fs.existsSync(file)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(Object.keys(raw)).toEqual([key]);
    expect(await getProjectExtensions(stores, key)).toMatchObject({ items: { a: { on: true, at: NOW } } });
  });

  it('keeps two different local projects independent in the same map file', async () => {
    await mutateProjectExtensions(stores, '/a', () => ({ ...emptyRecord(NOW), items: { x: { on: true, at: NOW } } }));
    await mutateProjectExtensions(stores, '/b', () => ({ ...emptyRecord(NOW), items: { y: { on: true, at: NOW } } }));
    expect(await getProjectExtensions(stores, '/a')).toMatchObject({ items: { x: { on: true, at: NOW } } });
    expect(await getProjectExtensions(stores, '/b')).toMatchObject({ items: { y: { on: true, at: NOW } } });
  });
});

describe('ensureSeeded', () => {
  let root: string;
  let stores: ProjectExtensionsStores;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-proj-ext-seed-'));
    stores = { personalRoot: path.join(root, 'Personal'), home: new NativeHome(root) };
  });
  // Fix (T1 review F3): maxRetries/retryDelay per test-suite-hygiene.md — a
  // late write into the temp dir (the lock file, a just-finished async write)
  // throws ENOTEMPTY out of a bare rmSync into a PASSING test.
  afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const skills: CatalogSkillEntry[] = [
    { id: 'youcoded-chatsearch', source: 'plugin', pluginName: 'youcoded-chatsearch' },
    { id: 'wecoded-themes-plugin:theme-builder', source: 'plugin', pluginName: 'wecoded-themes-plugin' },
  ];
  const mcp: CatalogMcpEntry[] = [];

  it('materializes Theme Builder as ON for a pre-existing project (its own default is off)', async () => {
    const rec = await ensureSeeded(stores, 'MyProject', { skills, mcp, installs: {} }, NOW);
    expect(rec.items['wecoded-themes-plugin:theme-builder']).toEqual({ on: true, at: NOW });
    expect(rec.plugins['wecoded-themes-plugin']).toMatchObject({ on: true, partsChosen: true });
    expect(rec.seededAt).toBe(NOW);
  });

  it('writes once — seeding twice does not change seededAt or re-materialize', async () => {
    await ensureSeeded(stores, 'MyProject', { skills, mcp, installs: {} }, NOW);
    const second = await ensureSeeded(stores, 'MyProject', { skills, mcp, installs: {} }, NOW + 999);
    expect(second.seededAt).toBe(NOW); // unchanged — the second call was a no-op
  });

  it('merely reading a project (getProjectExtensions) never seeds it', async () => {
    await getProjectExtensions(stores, 'MyProject');
    expect(await getProjectExtensions(stores, 'MyProject')).toBeNull();
  });

  it('a project seeded at its OWN creation (isNewProject:true) gets Theme Builder OFF, matching its forward-looking default', async () => {
    const rec = await ensureSeeded(stores, 'FreshProject', { skills, mcp, installs: {} }, NOW, true);
    expect(rec.items['wecoded-themes-plugin:theme-builder']).toEqual({ on: false, at: NOW });
    expect(rec.plugins['wecoded-themes-plugin']).toMatchObject({ on: false, partsChosen: true });
  });

  it('a marketplace plugin installed after this exact seed instant still starts off, even for a pre-existing project', async () => {
    const installedAt = new Date(NOW + 1).toISOString();
    const rec = await ensureSeeded(stores, 'MyProject', {
      skills: [{ id: 'civic:report', source: 'plugin', pluginName: 'civic' }],
      mcp: [], installs: { civic: { installedAt } },
    }, NOW);
    expect(rec.items['civic:report']).toEqual({ on: false, at: NOW });
  });

  // T6 (project-plugin-controls): the realistic Marketplace post-install
  // shape — the install already completed (installedAt is BEFORE `now`, not
  // after it, since `now` is the seed call's own timestamp and a completed
  // install can never postdate it) — and this project has NEVER been seeded
  // before, exactly like every project the "choose your projects" panel
  // lists right after a fresh install. Without `seedReferenceInstant`, this
  // used to materialize `on: true` (the plugin looked "installed before the
  // seed" purely because the seed happened to run a moment after the
  // install), silently breaking R19 ("it starts off everywhere").
  it('a never-seeded project does not materialize a just-installed plugin as ON (R19 start-off guarantee)', async () => {
    const installedAt = new Date(NOW - 1_000).toISOString(); // installed 1s before this seed call
    const rec = await ensureSeeded(stores, 'NeverOpenedProject', {
      skills: [{ id: 'inbox:process', source: 'plugin', pluginName: 'youcoded-inbox' }],
      mcp: [], installs: { 'youcoded-inbox': { installedAt } },
    }, NOW, false, NOW - 60_000); // seedReferenceInstant: the project existed since well before the install
    expect(rec.items['inbox:process']).toEqual({ on: false, at: NOW });
    expect(rec.plugins['youcoded-inbox']).toMatchObject({ on: false, partsChosen: true });
  });

  it('without a seedReferenceInstant, the same never-seeded scenario falls back to `now` (the residual, documented gap for a project with no known addedAt)', async () => {
    const installedAt = new Date(NOW - 1_000).toISOString();
    const rec = await ensureSeeded(stores, 'NeverOpenedProject', {
      skills: [{ id: 'inbox:process', source: 'plugin', pluginName: 'youcoded-inbox' }],
      mcp: [], installs: { 'youcoded-inbox': { installedAt } },
    }, NOW); // no seedReferenceInstant passed — defaults to `now`, same as before T6
    expect(rec.items['inbox:process']).toEqual({ on: true, at: NOW });
  });
});

describe('markPluginRemoved — uninstall cascade', () => {
  let root: string;
  let stores: ProjectExtensionsStores;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-proj-ext-cascade-'));
    stores = { personalRoot: path.join(root, 'Personal'), home: new NativeHome(root) };
  });
  // Fix (T1 review F3): maxRetries/retryDelay per test-suite-hygiene.md — a
  // late write into the temp dir (the lock file, a just-finished async write)
  // throws ENOTEMPTY out of a bare rmSync into a PASSING test.
  afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  it('tombstones the plugin in a synced project that has it, leaves an untouched project alone', async () => {
    await mutateProjectExtensions(stores, 'HasPlugin', () => ({
      ...emptyRecord(NOW), plugins: { civic: { on: true, partsChosen: true, at: NOW } },
    }));
    await mutateProjectExtensions(stores, 'NeverTouched', () => emptyRecord(NOW));

    await markPluginRemoved(stores, 'civic', NOW + 1000);

    const touched = await getProjectExtensions(stores, 'HasPlugin');
    expect(touched?.plugins.civic).toEqual({ on: false, partsChosen: true, removed: true, at: NOW + 1000 });

    const untouched = await getProjectExtensions(stores, 'NeverTouched');
    expect(untouched?.plugins.civic).toBeUndefined();
  });

  it('tombstones the plugin in an unsynced (local) project that has it', async () => {
    await mutateProjectExtensions(stores, '/local/proj', () => ({
      ...emptyRecord(NOW), plugins: { civic: { on: true, partsChosen: true, at: NOW } },
    }));
    await markPluginRemoved(stores, 'civic', NOW + 1000);
    const rec = await getProjectExtensions(stores, '/local/proj');
    expect(rec?.plugins.civic).toMatchObject({ on: false, removed: true });
  });

  it('is idempotent — calling it twice keeps the FIRST removal timestamp', async () => {
    await mutateProjectExtensions(stores, 'HasPlugin', () => ({
      ...emptyRecord(NOW), plugins: { civic: { on: true, partsChosen: true, at: NOW } },
    }));
    await markPluginRemoved(stores, 'civic', NOW + 1000);
    await markPluginRemoved(stores, 'civic', NOW + 2000);
    const rec = await getProjectExtensions(stores, 'HasPlugin');
    expect(rec?.plugins.civic.at).toBe(NOW + 1000);
  });

  it('never creates a project record that did not already exist', async () => {
    await markPluginRemoved(stores, 'civic', NOW);
    expect(fs.existsSync(path.join(stores.personalRoot, 'ProjectExtensions'))).toBe(false);
  });

  // T1 review F1: the canonical file has no entry for the plugin at all — it
  // exists only in an unfolded conflict copy. The gate (readSyncedRecord)
  // sees it via the fold, so this must still tombstone it on the canonical
  // file, not silently no-op.
  it('tombstones a plugin whose only record lives in an unfolded conflict copy', async () => {
    const dir = path.join(stores.personalRoot, 'ProjectExtensions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'HasPlugin.json'), JSON.stringify(emptyRecord(NOW)));
    fs.writeFileSync(path.join(dir, 'HasPlugin (from other-device, 2026-09-24).json'), JSON.stringify({
      ...emptyRecord(NOW), plugins: { civic: { on: true, partsChosen: true, at: NOW } },
    }));

    await markPluginRemoved(stores, 'civic', NOW + 1000);

    const read = await getProjectExtensions(stores, 'HasPlugin');
    expect(read?.plugins.civic).toEqual({ on: false, partsChosen: true, removed: true, at: NOW + 1000 });
    // And it actually landed on the CANONICAL file — not just observable
    // through the fold — so future folds keep preferring it via `at`.
    const canonicalOnDisk = JSON.parse(fs.readFileSync(path.join(dir, 'HasPlugin.json'), 'utf8'));
    expect(canonicalOnDisk.plugins.civic).toMatchObject({ on: false, removed: true, at: NOW + 1000 });
  });
});
