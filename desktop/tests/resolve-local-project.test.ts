// Cross-device / cross-OS resume resolution (fix 2026-07-12).
// resolveLocalProject is the single resolver shared by the materialize sweep and
// the Resume Browser; if it resolves a synced record to a folder that isn't on
// THIS device, `claude --resume` launches in the wrong cwd and the session
// spawns blank and exits. These cases pin the OS-agnostic behavior: a foreign
// absolute path (the creating device's, e.g. a Linux path on a Windows box) must
// be ignored in favor of THIS device's copy of the folder, found by managed
// name or saved-folder basename.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLocalProject } from '../src/main/conversations/resolve-local-project';

describe('resolveLocalProject', () => {
  let tmp: string;
  let savedDir: string;   // this device's copy of the "youcoded-dev" folder
  let managedDir: string; // a managed project "budget-app"
  // An absolute path that is never created — models the creating device's
  // originalPath as seen from a DIFFERENT device (it doesn't exist here). Using
  // a tmp-rooted absent path keeps the test deterministic on every OS.
  let foreignOriginalPath: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rlp-'));
    savedDir = path.join(tmp, 'youcoded-dev');
    fs.mkdirSync(savedDir);
    managedDir = path.join(tmp, 'Projects', 'budget-app');
    fs.mkdirSync(managedDir, { recursive: true });
    foreignOriginalPath = path.join(tmp, 'other-device-home', 'youcoded-dev'); // never created
  });

  afterAll(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('uses originalPath when it exists on THIS device (same machine)', async () => {
    const r = await resolveLocalProject({ projectName: 'youcoded-dev', originalPath: savedDir }, new Map(), []);
    expect(r).toBe(savedDir);
  });

  it('falls back to a SAVED folder by basename when originalPath is foreign/absent (the cross-OS case)', async () => {
    const r = await resolveLocalProject(
      { projectName: 'youcoded-dev', originalPath: foreignOriginalPath },
      new Map(),
      [{ path: savedDir }],
    );
    expect(r).toBe(savedDir);
  });

  it('falls back to a MANAGED project by name when originalPath is foreign/absent', async () => {
    const r = await resolveLocalProject(
      { projectName: 'budget-app', originalPath: foreignOriginalPath },
      new Map([['budget-app', managedDir]]),
      [],
    );
    expect(r).toBe(managedDir);
  });

  it('prefers originalPath over the name/basename fallbacks when it exists here', async () => {
    // managed map points elsewhere, but originalPath is valid → originalPath wins.
    const r = await resolveLocalProject(
      { projectName: 'youcoded-dev', originalPath: savedDir },
      new Map([['youcoded-dev', managedDir]]),
      [],
    );
    expect(r).toBe(savedDir);
  });

  it('returns null when the project is not on this device at all', async () => {
    const r = await resolveLocalProject(
      { projectName: 'ghost-project', originalPath: foreignOriginalPath },
      new Map(),
      [{ path: savedDir }],
    );
    expect(r).toBeNull();
  });

  it('ignores a saved folder whose basename matches but whose path no longer exists on disk', async () => {
    const r = await resolveLocalProject(
      { projectName: 'gone', originalPath: foreignOriginalPath },
      new Map(),
      [{ path: path.join(tmp, 'gone') }], // never created
    );
    expect(r).toBeNull();
  });

  it('asks the disk once per path when given a cache (the materialize sweep shares one)', async () => {
    const cache = new Map<string, Promise<boolean>>();
    const access = vi.spyOn(fs.promises, 'access');
    for (let i = 0; i < 50; i++) {
      await resolveLocalProject({ projectName: 'youcoded-dev', originalPath: savedDir }, new Map(), [], cache);
    }
    expect(access).toHaveBeenCalledTimes(1);
    access.mockRestore();
  });
});
