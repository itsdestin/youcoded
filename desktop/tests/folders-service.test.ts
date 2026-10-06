// Destin, 2026-09-11, phone test of remote access batches 2/3: "the project selector for new
// sessions isn't listing my projects?" The phone's folder list came from a hand-copied handler
// in remote-server.ts that returned only ~/.claude/youcoded-folders.json, while the desktop
// handler also lists every synced project under ~/YouCoded/Projects. Both transports now call
// ONE service, pinned here. WHY no source-text guard below any more (Plan B, 2026-09-16): the
// "no copy comes back" half is the ast-grep rules no-folders-json-outside-service and
// folders-service-called-by-both-transports (youcoded-dev scripts/ast-grep/rules/).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const h = vi.hoisted(() => ({ managed: null as null | { projectsRoot: string; listProjects: () => { path: string; name: string }[] } }));
vi.mock('../src/main/sync-spaces/service', () => ({ getManagedRoots: () => h.managed }));

import { listPickerFolders, addFolder, removeFolder, renameFolder, setFolderDescription, isHiddenProject } from '../src/main/folders-service';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folders-service-'));
  file = path.join(dir, 'youcoded-folders.json');
  h.managed = null;
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('listPickerFolders — what the new-session picker shows, on every transport', () => {
  it('seeds Home on first use', () => {
    const list = listPickerFolders(file);
    expect(list).toEqual([expect.objectContaining({ path: os.homedir(), nickname: 'Home', exists: true })]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toHaveLength(1);
  });

  it('lists synced projects after the saved folders, badged, without repeating a saved one', () => {
    const projectsRoot = path.join(dir, 'Projects');
    const cooking = path.join(projectsRoot, 'CookinOnLowHeat');
    const paf = path.join(projectsRoot, 'PAF 574');
    fs.mkdirSync(cooking, { recursive: true });
    fs.mkdirSync(paf, { recursive: true });
    fs.writeFileSync(file, JSON.stringify([
      { path: dir, nickname: 'work', addedAt: 5 },
      { path: cooking, nickname: 'cooking (saved)', addedAt: 4 },
    ]));
    h.managed = { projectsRoot, listProjects: () => [{ path: cooking, name: 'CookinOnLowHeat' }, { path: paf, name: 'PAF 574' }] };

    const list = listPickerFolders(file);
    expect(list.map((f) => f.nickname)).toEqual(['work', 'cooking (saved)', 'PAF 574']);
    expect(list[0].managed).toBeUndefined();
    expect(list[1]).toMatchObject({ managed: true, exists: true });
    expect(list[2]).toMatchObject({ path: paf, managed: true, exists: true, addedAt: 0 });
  });

  it('marks a saved folder that is gone', () => {
    fs.writeFileSync(file, JSON.stringify([{ path: path.join(dir, 'gone'), nickname: 'gone', addedAt: 1 }]));
    expect(listPickerFolders(file)[0].exists).toBe(false);
  });
});

describe('the folder writes behave as the desktop handlers always did', () => {
  // WHY temp-rooted paths and not '/a', '/b': addFolder stores path.resolve() of what it is
  // given, and on Windows '/b' resolves to 'D:\\b' — the literal '/b' never matched, so this
  // failed on every Windows CI run. A path under the test's own temp dir resolves to itself.
  it('add dedupes by resolved path and puts the new folder first', () => {
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    fs.writeFileSync(file, JSON.stringify([{ path: a, nickname: 'a', addedAt: 1 }]));
    const entry = addFolder(b + path.sep, undefined, file);
    expect(entry).toMatchObject({ path: b, nickname: 'b' });
    expect(addFolder(b, 'again', file)).toMatchObject({ nickname: 'b' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).map((f: any) => f.path)).toEqual([b, a]);
  });

  it('remove, rename and set-description report whether a folder matched', () => {
    fs.writeFileSync(file, JSON.stringify([{ path: '/a', nickname: 'a', addedAt: 1 }]));
    expect(renameFolder('/a', 'Alpha', file)).toBe(true);
    expect(setFolderDescription('/a', `  ${'x'.repeat(5000)}  `, file)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))[0];
    expect(saved.nickname).toBe('Alpha');
    expect(saved.description.length).toBeLessThan(5000);
    expect(setFolderDescription('/a', null as any, file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))[0].description).toBeNull();
    expect(renameFolder('/missing', 'x', file)).toBe(false);
    expect(removeFolder('/missing', file)).toBe(false);
    expect(removeFolder('/a', file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual([]);
  });
});

// Backlog row 10 (Destin, 2026-09-29: "there's no way to delete some projects currently"): a
// synced project lives in ~/YouCoded/Projects and is listed because its FOLDER is there, so
// dropping it from youcoded-folders.json did nothing — it came straight back. Removing one now
// puts it on this computer's "removed" list. Nothing on disk is touched and sync is not stopped.
describe('removing a synced project hides it on this computer, and Add a project brings it back', () => {
  function setup() {
    const projectsRoot = path.join(dir, 'Projects');
    const paf = path.join(projectsRoot, 'PAF 574');
    fs.mkdirSync(paf, { recursive: true });
    fs.writeFileSync(path.join(paf, 'notes.md'), 'keep me');
    fs.writeFileSync(file, JSON.stringify([{ path: dir, nickname: 'work', addedAt: 5 }]));
    h.managed = { projectsRoot, listProjects: () => [{ path: paf, name: 'PAF 574' }] };
    return { paf };
  }

  it('remove reports a match, the picker stops listing it, and its files stay', () => {
    const { paf } = setup();
    expect(removeFolder(paf, file)).toBe(true);
    expect(listPickerFolders(file).map((f) => f.nickname)).toEqual(['work']);
    expect(isHiddenProject(paf, file)).toBe(true);
    expect(fs.readFileSync(path.join(paf, 'notes.md'), 'utf8')).toBe('keep me');
  });

  it('adding the folder again lists it again', () => {
    const { paf } = setup();
    removeFolder(paf, file);
    addFolder(paf, undefined, file);
    expect(isHiddenProject(paf, file)).toBe(false);
    expect(listPickerFolders(file).map((f) => f.path)).toContain(paf);
  });

  it('a plain folder is only dropped from the saved list, never put on the removed list', () => {
    setup();
    expect(removeFolder(dir, file)).toBe(true);
    expect(isHiddenProject(dir, file)).toBe(false);
  });
});
