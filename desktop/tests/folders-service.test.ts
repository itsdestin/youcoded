// Destin, 2026-09-11, phone test of remote access batches 2/3: "the project selector for new
// sessions isn't listing my projects?" The phone's folder list came from a hand-copied handler
// in remote-server.ts that returned only ~/.claude/youcoded-folders.json, while the desktop
// handler also lists every synced project under ~/YouCoded/Projects. Both transports now call
// ONE service, pinned here, and the guard below keeps a copy from coming back.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const h = vi.hoisted(() => ({ managed: null as null | { projectsRoot: string; listProjects: () => { path: string; name: string }[] } }));
vi.mock('../src/main/sync-spaces/service', () => ({ getManagedRoots: () => h.managed }));

import { listPickerFolders, addFolder, removeFolder, renameFolder, setFolderDescription } from '../src/main/folders-service';

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
  it('add dedupes by resolved path and puts the new folder first', () => {
    fs.writeFileSync(file, JSON.stringify([{ path: '/a', nickname: 'a', addedAt: 1 }]));
    const entry = addFolder('/b/', undefined, file);
    expect(entry).toMatchObject({ path: '/b', nickname: 'b' });
    expect(addFolder('/b', 'again', file)).toMatchObject({ nickname: 'b' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).map((f: any) => f.path)).toEqual(['/b', '/a']);
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

describe('guard: one folder store, two callers', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', 'src', 'main', rel), 'utf8');
  it('remote-server.ts no longer reads or writes youcoded-folders.json itself', () => {
    expect(read('remote-server.ts')).not.toContain('youcoded-folders.json');
  });
  it('both transports call the shared service for all five folder channels', () => {
    for (const file of ['remote-server.ts', 'ipc-handlers.ts']) {
      const src = read(file);
      for (const fn of ['listPickerFolders(', 'addFolder(', 'removeFolder(', 'renameFolder(', 'setFolderDescription(']) {
        expect(src, `${file} calls ${fn}`).toContain(fn);
      }
    }
  });
});
