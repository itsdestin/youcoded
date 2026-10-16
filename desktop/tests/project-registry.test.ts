// desktop/tests/project-registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  readProjectRegistry, ensureProjectEntry, setProjectDisplayName, setProjectStopped,
  mergeProjectEntries, PROJECT_REGISTRY_SCHEMA, type ProjectRegistryEntry,
} from '../src/main/sync-spaces/project-registry';

let personal: string;
beforeEach(() => { personal = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-preg-')); });
afterEach(() => { fs.rmSync(personal, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

const dir = () => path.join(personal, 'ProjectSync');
const write = (file: string, obj: unknown) => {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(path.join(dir(), file), JSON.stringify(obj));
};
const E = (over: Partial<ProjectRegistryEntry>): ProjectRegistryEntry => ({
  schemaVersion: PROJECT_REGISTRY_SCHEMA, name: 'app', repoName: 'r-app',
  displayName: 'app', state: 'active', updatedAt: 1,
  // Required by the entry type; null/0 is exactly what the reader fills in for a file without them.
  description: null, descriptionUpdatedAt: 0, ...over,
});

describe('project registry store — I/O', () => {
  it('ensureProjectEntry creates a visible ProjectSync/<name>.json (active, displayName=name)', () => {
    ensureProjectEntry(personal, { name: 'app', repoName: 'r-app' });
    expect(fs.existsSync(path.join(dir(), 'app.json'))).toBe(true);
    const got = readProjectRegistry(personal);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ name: 'app', repoName: 'r-app', displayName: 'app', state: 'active' });
  });

  it('ensureProjectEntry is create-if-absent — never clobbers an existing rename/stop', () => {
    ensureProjectEntry(personal, { name: 'app', repoName: 'r-app' });
    write('app.json', E({ displayName: 'Cool App', state: 'stopped', updatedAt: 50 }));
    ensureProjectEntry(personal, { name: 'app', repoName: 'r-app' }); // must NOT reset
    const got = readProjectRegistry(personal)[0];
    expect(got.displayName).toBe('Cool App');
    expect(got.state).toBe('stopped');
  });

  it('returns [] when the registry dir does not exist', () => {
    expect(readProjectRegistry(personal)).toEqual([]);
  });

  it('skips corrupt / unknown-schema files without throwing', () => {
    ensureProjectEntry(personal, { name: 'good', repoName: 'r' });
    fs.writeFileSync(path.join(dir(), 'bad.json'), '{ not json');
    write('future.json', { schemaVersion: 999, name: 'future', repoName: 'r' });
    expect(readProjectRegistry(personal).map(e => e.name).sort()).toEqual(['good']);
  });

  it('setProjectDisplayName updates displayName + bumps updatedAt, preserving state', async () => {
    write('app.json', E({ state: 'stopped', updatedAt: 5 }));
    await setProjectDisplayName(personal, 'app', 'r-app', 'Renamed');
    const got = readProjectRegistry(personal)[0];
    expect(got.displayName).toBe('Renamed');
    expect(got.state).toBe('stopped'); // preserved
    expect(got.updatedAt).toBeGreaterThan(5);
  });

  it('setProjectStopped tombstones, preserving displayName', async () => {
    write('app.json', E({ displayName: 'Cool', updatedAt: 5 }));
    await setProjectStopped(personal, 'app', 'r-app');
    const got = readProjectRegistry(personal)[0];
    expect(got.state).toBe('stopped');
    expect(got.displayName).toBe('Cool');
  });

  it('folds conflict copies on read — stopped dominates regardless of updatedAt', () => {
    // Canonical says active/newer; a remote-wins conflict copy says stopped/older.
    write('app.json', E({ displayName: 'A', state: 'active', updatedAt: 100 }));
    write('app (from laptop, 2026-07-13).json', E({ displayName: 'A', state: 'stopped', updatedAt: 5 }));
    const got = readProjectRegistry(personal);
    expect(got).toHaveLength(1);           // folded into one
    expect(got[0].state).toBe('stopped');  // tombstone dominates the newer active
  });

  it('folds conflict copies on read — displayName is last-writer-wins', () => {
    write('app.json', E({ displayName: 'Old', updatedAt: 10 }));
    write('app (from laptop, 2026-07-13).json', E({ displayName: 'New', updatedAt: 20 }));
    expect(readProjectRegistry(personal)[0].displayName).toBe('New');
  });
});

describe('project registry store — pure merge', () => {
  it('mergeProjectEntries is commutative for state + displayName', () => {
    const a = E({ state: 'active', displayName: 'X', updatedAt: 3 });
    const b = E({ state: 'stopped', displayName: 'Y', updatedAt: 9 });
    const ab = mergeProjectEntries(a, b);
    const ba = mergeProjectEntries(b, a);
    expect(ab).toEqual(ba);
    expect(ab.state).toBe('stopped');     // dominates
    expect(ab.displayName).toBe('Y');     // updatedAt 9 wins
  });
});

// Regression tests for the 2026-07-13 post-merge review findings.
describe('project registry store — review-fix regressions', () => {
  it('#1: a project whose folder name contains " (from …)" is its OWN record, not a conflict copy', () => {
    write('Recipes (from Grandma).json', E({ name: 'Recipes (from Grandma)', displayName: 'Recipes (from Grandma)' }));
    // Before the fix this was misread as a conflict copy of "Recipes" and skipped entirely.
    expect(readProjectRegistry(personal).map(e => e.name)).toEqual(['Recipes (from Grandma)']);
  });

  it('#1: STOP is visible for a paren-named project (would silently fail before the fix)', async () => {
    write('Config (from work).json', E({ name: 'Config (from work)', displayName: 'Config (from work)', state: 'active', updatedAt: 1 }));
    await setProjectStopped(personal, 'Config (from work)', 'r');
    const got = readProjectRegistry(personal);
    expect(got).toHaveLength(1);
    expect(got[0].state).toBe('stopped'); // reader sees it → activeManagedSpaces can gate it
  });

  it('#1: a GENUINE transport conflict copy of a paren-named project still folds', () => {
    write('Recipes (from Grandma).json', E({ name: 'Recipes (from Grandma)', displayName: 'Recipes (from Grandma)', state: 'active', updatedAt: 10 }));
    // The engine names a real conflict copy by appending its own " (from <device>, <date>)" suffix.
    write('Recipes (from Grandma) (from Laptop, 2026-07-13).json', E({ name: 'Recipes (from Grandma)', displayName: 'Recipes (from Grandma)', state: 'stopped', updatedAt: 5 }));
    const got = readProjectRegistry(personal);
    expect(got).toHaveLength(1);                          // folded, not two rows
    expect(got[0].name).toBe('Recipes (from Grandma)');
    expect(got[0].state).toBe('stopped');                // the copy's tombstone folded in
  });

  it('#1: a genuine conflict copy of a plain project still folds (no regression)', () => {
    write('app.json', E({ displayName: 'A', state: 'active', updatedAt: 10 }));
    write('app (from laptop, 2026-07-13).json', E({ displayName: 'A', state: 'stopped', updatedAt: 5 }));
    const got = readProjectRegistry(personal);
    expect(got).toHaveLength(1);
    expect(got[0].state).toBe('stopped');
  });

  it('#5: renaming to the identical displayName is a no-op (no mtime churn / redundant push)', async () => {
    write('app.json', E({ displayName: 'Same', updatedAt: 5 }));
    const file = path.join(dir(), 'app.json');
    const m1 = fs.statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 15));
    await setProjectDisplayName(personal, 'app', 'r-app', 'Same');
    expect(fs.statSync(file).mtimeMs).toBe(m1); // skipped
  });

  it('#5: stopping an already-stopped project is a no-op (no mtime churn)', async () => {
    write('app.json', E({ state: 'stopped', updatedAt: 5 }));
    const file = path.join(dir(), 'app.json');
    const m1 = fs.statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 15));
    await setProjectStopped(personal, 'app', 'r-app');
    expect(fs.statSync(file).mtimeMs).toBe(m1);
  });

  it('#7: ensureProjectEntry rejects a Windows-reserved name (throws BEFORE writing)', () => {
    expect(() => ensureProjectEntry(personal, { name: 'con', repoName: 'r' })).toThrow();
    expect(fs.existsSync(path.join(dir(), 'con.json'))).toBe(false);
  });

  it('#7: readProjectRegistry skips an over-long name (validateSyncName length cap)', () => {
    const long = 'x'.repeat(101);
    write(`${long}.json`, E({ name: long, displayName: long }));
    ensureProjectEntry(personal, { name: 'ok', repoName: 'r' });
    expect(readProjectRegistry(personal).map(e => e.name)).toEqual(['ok']); // long one skipped
  });

  it('#8: a create leaves no leftover .tmp file', () => {
    ensureProjectEntry(personal, { name: 'fresh', repoName: 'r' });
    expect(fs.readdirSync(dir()).filter((n) => n.includes('.tmp'))).toEqual([]);
  });
});
