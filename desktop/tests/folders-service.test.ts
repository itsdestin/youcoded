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

const h = vi.hoisted(() => ({ managed: null as null | { projectsRoot: string; listProjects: () => { path: string; name: string }[] }, removed: new Set<string>() }));
vi.mock('../src/main/sync-spaces/service', () => ({ getManagedRoots: () => h.managed, isRemovedProject: (n: string) => h.removed.has(n) }));

import { listPickerFolders, addFolder, removeFolder, renameFolder, setFolderDescription, isRemovedFromLists } from '../src/main/folders-service';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folders-service-'));
  file = path.join(dir, 'youcoded-folders.json');
  h.managed = null;
  h.removed = new Set();
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('listPickerFolders — what the new-session picker shows, on every transport', () => {
  it('seeds Home on first use', () => {
    const list = listPickerFolders(file);
    expect(list).toEqual([expect.objectContaining({ path: os.homedir(), nickname: 'Home', exists: true })]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toHaveLength(1);
  });

  it('on the phone never offers Home, the app\'s private folder, as a project', () => {
    vi.stubEnv('YOUCODED_HEADLESS_PORT', '1234');
    try {
      expect(listPickerFolders(file)).toEqual([]);
      // A phone that already seeded Home (every install before this) stops showing it too.
      fs.writeFileSync(file, JSON.stringify([{ path: os.homedir(), nickname: 'Home', addedAt: 1 }, { path: dir, nickname: 'work', addedAt: 2 }]));
      expect(listPickerFolders(file).map((f) => f.nickname)).toEqual(['work']);
    } finally { vi.unstubAllEnvs(); }
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

// Backlog row 10 (Destin, project-switcher-1 PQ-1: "stop syncing on all devices, remove from
// list on all devices"). A synced project is listed because its FOLDER sits in
// ~/YouCoded/Projects; once it is marked removed (on any device) it leaves this computer's
// lists too, its files stay, and Add a project on this computer lists it again.
describe('a synced project removed on any device leaves the lists; its files stay', () => {
  function setup() {
    const projectsRoot = path.join(dir, 'Projects');
    const paf = path.join(projectsRoot, 'PAF 574');
    fs.mkdirSync(paf, { recursive: true });
    fs.writeFileSync(path.join(paf, 'notes.md'), 'keep me');
    fs.writeFileSync(file, JSON.stringify([
      { path: dir, nickname: 'work', addedAt: 5 },
      // The import flow saves an entry for a project it moved into Projects.
      { path: paf, nickname: 'PAF (saved)', addedAt: 4 },
    ]));
    h.managed = { projectsRoot, listProjects: () => [{ path: paf, name: 'PAF 574' }] };
    return { paf };
  }

  it('drops both its saved entry and its synced row from the picker, and touches no file', () => {
    const { paf } = setup();
    h.removed.add('PAF 574');
    expect(listPickerFolders(file).map((f) => f.nickname)).toEqual(['work']);
    expect(isRemovedFromLists(paf, JSON.parse(fs.readFileSync(file, 'utf8')))).toBe(true);
    expect(fs.readFileSync(path.join(paf, 'notes.md'), 'utf8')).toBe('keep me');
  });

  it('Add a project on this computer lists it here again', () => {
    const { paf } = setup();
    h.removed.add('PAF 574');
    addFolder(paf, undefined, file);
    expect(listPickerFolders(file).map((f) => f.path)).toContain(paf);
  });

  it('a project that was not removed, and a plain folder, are untouched', () => {
    const { paf } = setup();
    expect(listPickerFolders(file).map((f) => f.path)).toEqual([dir, paf]);
    h.removed.add(path.basename(dir)); // a same-named plain folder outside Projects
    expect(listPickerFolders(file).map((f) => f.path)).toEqual([dir, paf]);
  });
});

// WHY (card #151 item 4): "same folder" now goes through one pathKey(): letter case is ignored
// on Windows and macOS (their disks ignore it) but NOT on Linux, where Docs and docs are two
// folders. The platform is stubbed so every OS's CI checks all three behaviours.
describe('folder paths that differ only by letter case', () => {
  const realPlatform = process.platform;
  const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p });
  afterEach(() => setPlatform(realPlatform));

  for (const [platform, sameFolder] of [['win32', true], ['darwin', true], ['linux', false]] as const) {
    it(`${platform}: picker badge + dedupe + removal ${sameFolder ? 'treat them as one folder' : 'keep them as two folders'}`, () => {
      setPlatform(platform);
      const projectsRoot = path.join(dir, 'Projects');
      const upper = path.join(projectsRoot, 'Paf');
      const lower = path.join(projectsRoot, 'paf');
      fs.writeFileSync(file, JSON.stringify([{ path: upper, nickname: 'saved', addedAt: 5 }]));
      // The managed list spells the same project in lower case.
      h.managed = { projectsRoot: projectsRoot.toLowerCase(), listProjects: () => [{ path: lower, name: 'paf' }] };
      const list = listPickerFolders(file);
      // dedupe: one row when the OS ignores case, two on Linux
      expect(list).toHaveLength(sameFolder ? 1 : 2);
      // managed badge on the saved row only when the projects root matches ignoring case
      expect(list[0].managed).toBe(sameFolder ? true : undefined);
      // removal by the differently-cased path
      expect(removeFolder(lower, file)).toBe(sameFolder);
    });
  }

  // WHY (reviewer finding): add, rename and describe still compared with plain ===, so on
  // Windows/macOS the other casing made a second entry or reported "not found".
  for (const [platform, sameFolder] of [['win32', true], ['darwin', true], ['linux', false]] as const) {
    it(`${platform}: add, rename and describe ${sameFolder ? 'find the one saved folder' : 'treat the other casing as a different folder'}`, () => {
      setPlatform(platform);
      const upper = path.join(dir, 'Docs');
      const lower = path.join(dir, 'docs');
      fs.writeFileSync(file, JSON.stringify([{ path: upper, nickname: 'saved', addedAt: 5 }]));
      addFolder(lower, undefined, file);
      const saved = () => JSON.parse(fs.readFileSync(file, 'utf8')) as { path: string; nickname: string; description?: string | null }[];
      expect(saved()).toHaveLength(sameFolder ? 1 : 2);
      expect(renameFolder(lower, 'renamed', file)).toBe(true);
      expect(setFolderDescription(lower, 'about', file)).toBe(true);
      const hit = saved().find((f) => f.path === (sameFolder ? upper : lower))!;
      expect(hit.nickname).toBe('renamed');
      expect(hit.description).toBe('about');
      // The other entry (Linux only) is untouched.
      if (!sameFolder) expect(saved().find((f) => f.path === upper)!.nickname).toBe('saved');
    });
  }
});

// Card #143 b (deck C-3): the one list is ordered by last use.
describe('folder order by last use', () => {
  it('a folder a session just started in moves to the top; unused ones keep their old order', async () => {
    const a = path.join(dir, 'a'); const b = path.join(dir, 'b'); const c = path.join(dir, 'c');
    fs.writeFileSync(file, JSON.stringify([{ path: a, nickname: 'a', addedAt: 3 }, { path: b, nickname: 'b', addedAt: 2 }, { path: c, nickname: 'c', addedAt: 1 }]));
    const { noteFolderUsed } = await import('../src/main/folders-service');
    expect(listPickerFolders(file).map((f) => f.nickname)).toEqual(['a', 'b', 'c']);
    noteFolderUsed(c, file);
    expect(listPickerFolders(file).map((f) => f.nickname)).toEqual(['c', 'a', 'b']);
    await new Promise((r) => setTimeout(r, 5));
    noteFolderUsed(b, file);
    expect(listPickerFolders(file).map((f) => f.nickname)).toEqual(['b', 'c', 'a']);
  });
  it('a folder that is not saved is not added by being used', async () => {
    fs.writeFileSync(file, JSON.stringify([{ path: path.join(dir, 'a'), nickname: 'a', addedAt: 1 }]));
    const { noteFolderUsed } = await import('../src/main/folders-service');
    noteFolderUsed(path.join(dir, 'elsewhere'), file);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toHaveLength(1);
  });
});
