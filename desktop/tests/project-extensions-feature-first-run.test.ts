// feature-first-run.ts (T6, F1 review fix): the per-device, never-synced
// instant recording the first time a build with the project skills/tools
// feature ran here — the ONLY lower bound resolve.ts's defaultPluginOn
// compares an install against. Real temp dirs, same style as
// project-extensions-store.test.ts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { NativeHome } from '../src/main/native-home';
import { ensureFeatureFirstRunAt, readFeatureFirstRunAt } from '../src/main/project-extensions/feature-first-run';

const NOW = 1_800_000_000_000;

describe('ensureFeatureFirstRunAt / readFeatureFirstRunAt', () => {
  let root: string;
  let home: NativeHome;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-feature-first-run-'));
    home = new NativeHome(root);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  it('reads undefined when nothing has been recorded yet', async () => {
    expect(await readFeatureFirstRunAt(home)).toBeUndefined();
  });

  it('records the given instant on first call and reads it back', async () => {
    const result = await ensureFeatureFirstRunAt(home, NOW);
    expect(result).toBe(NOW);
    expect(await readFeatureFirstRunAt(home)).toBe(NOW);
  });

  it('"earliest wins" — a second call with a LATER instant never moves it', async () => {
    await ensureFeatureFirstRunAt(home, NOW);
    const second = await ensureFeatureFirstRunAt(home, NOW + 999_999);
    expect(second).toBe(NOW);
    expect(await readFeatureFirstRunAt(home)).toBe(NOW);
  });

  it('a second call with an EARLIER instant still keeps the first-recorded value (write-once, not earliest-of-calls)', async () => {
    // The file is written once, on the FIRST call ever made — a later call
    // (even with an earlier `now`, e.g. clock skew across processes) is a
    // no-op that reports back whatever is already on disk, never rewrites it.
    await ensureFeatureFirstRunAt(home, NOW);
    const second = await ensureFeatureFirstRunAt(home, NOW - 999_999);
    expect(second).toBe(NOW);
  });

  it('a corrupt/malformed stored value reads as undefined (unknown), never throws, and a later ensure call repairs it', async () => {
    fs.mkdirSync(path.join(root, '.youcoded'), { recursive: true });
    fs.writeFileSync(path.join(root, '.youcoded', 'project-extensions-feature.local.json'), 'not json');
    expect(await readFeatureFirstRunAt(home)).toBeUndefined();
    const result = await ensureFeatureFirstRunAt(home, NOW);
    expect(result).toBe(NOW); // corrupt content counts as "never recorded" — this call wins
    expect(await readFeatureFirstRunAt(home)).toBe(NOW);
  });

  it('a write failure (home directory blocked) returns undefined, never throws', async () => {
    // Put a FILE where NativeHome's mutateJson needs the target path to be a
    // writable JSON file location — a directory in its place makes the
    // locked read-modify-write's readFile throw EISDIR, same trick as
    // native-home.test.ts's own "rethrows non-ENOENT I/O errors" case.
    fs.mkdirSync(path.join(root, '.youcoded'), { recursive: true });
    fs.mkdirSync(path.join(root, '.youcoded', 'project-extensions-feature.local.json'));
    const result = await ensureFeatureFirstRunAt(home, NOW);
    expect(result).toBeUndefined();
  });

  it('a read failure (same directory-in-place-of-file) returns undefined, never throws', async () => {
    fs.mkdirSync(path.join(root, '.youcoded'), { recursive: true });
    fs.mkdirSync(path.join(root, '.youcoded', 'project-extensions-feature.local.json'));
    expect(await readFeatureFirstRunAt(home)).toBeUndefined();
  });
});
