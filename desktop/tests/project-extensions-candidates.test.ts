// listProjectKeyCandidatesAsync (T2, project-plugin-controls): the async
// rebuild of folders-service.ts's listPickerFolders() candidate set, used by
// NativeSessionHost so cwd->project resolution never blocks the main process
// on a *Sync fs call. Real temp dirs — this IS filesystem-shape behaviour.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { listProjectKeyCandidatesAsync } from '../src/main/project-extensions/candidates';

describe('listProjectKeyCandidatesAsync', () => {
  let root: string;
  let foldersFile: string;
  let projectsRoot: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-proj-candidates-'));
    foldersFile = path.join(root, 'youcoded-folders.json');
    projectsRoot = path.join(root, 'YouCoded', 'Projects');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  it('an absent folders file reads as no saved folders, not a throw', async () => {
    const candidates = await listProjectKeyCandidatesAsync(null, foldersFile);
    expect(candidates).toEqual([]);
  });

  it('an ordinary (unsynced) saved folder carries no syncName, and carries its addedAt', async () => {
    fs.writeFileSync(foldersFile, JSON.stringify([{ path: '/home/dest/Notes', nickname: 'Notes', addedAt: 1 }]));
    const candidates = await listProjectKeyCandidatesAsync(null, foldersFile);
    expect(candidates).toEqual([{ path: '/home/dest/Notes', addedAt: 1 }]);
  });

  it('an addedAt of 0 (folders-service.ts\'s "unknown age" sentinel) is dropped, not carried as a real instant', async () => {
    fs.writeFileSync(foldersFile, JSON.stringify([{ path: '/home/dest/Notes', nickname: 'Notes', addedAt: 0 }]));
    const candidates = await listProjectKeyCandidatesAsync(null, foldersFile);
    expect(candidates).toEqual([{ path: '/home/dest/Notes' }]);
  });

  it('a saved folder living under projectsRoot is badged with its DIRECTORY basename, not its nickname', async () => {
    const managedPath = path.join(projectsRoot, 'RealName');
    fs.mkdirSync(managedPath, { recursive: true });
    fs.writeFileSync(foldersFile, JSON.stringify([{ path: managedPath, nickname: 'My Nickname', addedAt: 1 }]));
    const candidates = await listProjectKeyCandidatesAsync(projectsRoot, foldersFile);
    expect(candidates).toEqual([{ path: managedPath, syncName: 'RealName', addedAt: 1 }]);
  });

  it('a managed project not yet in saved folders is appended with its directory name as syncName', async () => {
    fs.mkdirSync(path.join(projectsRoot, 'Unsaved'), { recursive: true });
    fs.writeFileSync(foldersFile, JSON.stringify([]));
    const candidates = await listProjectKeyCandidatesAsync(projectsRoot, foldersFile);
    expect(candidates).toEqual([{ path: path.join(projectsRoot, 'Unsaved'), syncName: 'Unsaved' }]);
  });

  it('does not duplicate a managed project already present as a saved folder', async () => {
    const managedPath = path.join(projectsRoot, 'AlreadySaved');
    fs.mkdirSync(managedPath, { recursive: true });
    fs.writeFileSync(foldersFile, JSON.stringify([{ path: managedPath, nickname: 'x', addedAt: 1 }]));
    const candidates = await listProjectKeyCandidatesAsync(projectsRoot, foldersFile);
    expect(candidates).toHaveLength(1);
  });

  it('projectsRoot: null skips the managed half entirely, same as no ManagedRoots wired', async () => {
    fs.writeFileSync(foldersFile, JSON.stringify([{ path: '/a', nickname: 'a', addedAt: 1 }]));
    const candidates = await listProjectKeyCandidatesAsync(null, foldersFile);
    expect(candidates).toEqual([{ path: '/a', addedAt: 1 }]);
  });

  it('a projectsRoot that does not exist yet is treated as "no managed projects", not a throw', async () => {
    fs.writeFileSync(foldersFile, JSON.stringify([]));
    const candidates = await listProjectKeyCandidatesAsync(path.join(root, 'never-created'), foldersFile);
    expect(candidates).toEqual([]);
  });
});
