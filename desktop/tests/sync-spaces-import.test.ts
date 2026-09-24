import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MAX_IMPORT_FILE_COUNT } from '../src/main/sync-spaces/guards';
import { ccProjectSlug } from '../src/main/slug-encoding';
import { upsertProject, remapProjectPath, listProjects } from '../src/main/artifacts/central-index';
import { canonicalize } from '../src/shared/artifacts/canonicalize';
import { checkImport, countFilesBounded, importProjectFolder } from '../src/main/sync-spaces/import-project';
import { writeFolders as writeSavedFolders, readFolders as readSavedFolders } from '../src/main/saved-folders';
import { readSidecar, writeSidecar } from '../src/main/artifacts/artifact-store';
import { SIDECAR_SCHEMA_VERSION } from '../src/shared/artifacts/types';

let tmp: string;
beforeEach(() => {
  // Canonicalize: import-project.ts realpaths the destination before computing
  // the CC slug dir (that's the dir CC will actually write to — see the
  // "CC slugs realpath(cwd)" comment there). On macOS os.tmpdir() is a symlink
  // (/var/folders/… -> /private/var/…) and on Windows CI it can resolve
  // through an 8.3 short name, so every path this file derives from `tmp`
  // must already be canonical or ccProjectSlug(dest) computed here won't
  // match the slug dir the code under test actually creates.
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-import-')));
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

describe('import enablers', () => {
  it('MAX_IMPORT_FILE_COUNT is a sane positive bound', () => {
    expect(MAX_IMPORT_FILE_COUNT).toBeGreaterThan(1000);
  });

  it('ccProjectSlug is exported and uppercases the drive before slugifying', () => {
    // On non-Windows paths this is a plain slugify; the drive-case rule only
    // fires on the ^[a-z]: prefix.
    expect(ccProjectSlug('c:/Users/x/proj')).toBe(ccProjectSlug('C:/Users/x/proj'));
  });

  it('remapProjectPath rewrites path (and name) of the entry matching the old canonical path', async () => {
    const oldRoot = path.join(tmp, 'oldproj');
    const newRoot = path.join(tmp, 'newproj');
    await upsertProject(tmp, {
      id: 'ULID1', name: 'oldproj', path: canonicalize(oldRoot, null),
      lastIndexed: new Date().toISOString(), lastSession: null,
      contentTypes: ['artifacts'], stats: { artifactCount: 3 },
    } as any);
    await remapProjectPath(tmp, canonicalize(oldRoot, null), canonicalize(newRoot, null), 'newproj');
    const projects = await listProjects(tmp);
    expect(projects).toHaveLength(1);
    expect(projects[0].path).toBe(canonicalize(newRoot, null));
    expect(projects[0].name).toBe('newproj');
    expect(projects[0].id).toBe('ULID1');            // identity survives the move
    expect(projects[0].stats.artifactCount).toBe(3); // stats survive the move
  });

  it('remapProjectPath is a no-op when no entry matches', async () => {
    await remapProjectPath(tmp, canonicalize(path.join(tmp, 'ghost'), null), canonicalize(path.join(tmp, 'x'), null));
    expect(await listProjects(tmp)).toEqual([]);
  });

  it('remapProjectPath drops a stale entry already sitting at the destination path', async () => {
    const oldRoot = path.join(tmp, 'oldproj');
    const newRoot = path.join(tmp, 'newproj');
    await upsertProject(tmp, {
      id: 'ULID1', name: 'oldproj', path: canonicalize(oldRoot, null),
      lastIndexed: new Date().toISOString(), lastSession: null,
      contentTypes: ['artifacts'], stats: { artifactCount: 1 },
    } as any);
    await upsertProject(tmp, {
      id: 'STALE', name: 'stale', path: canonicalize(newRoot, null),
      lastIndexed: new Date().toISOString(), lastSession: null,
      contentTypes: ['artifacts'], stats: { artifactCount: 9 },
    } as any);
    await remapProjectPath(tmp, canonicalize(oldRoot, null), canonicalize(newRoot, null));
    const projects = await listProjects(tmp);
    expect(projects).toHaveLength(1);          // stale entry dropped, not shadowed
    expect(projects[0].id).toBe('ULID1');      // the moved project wins
    expect(projects[0].path).toBe(canonicalize(newRoot, null));
  });
});

describe('countFilesBounded', () => {
  it('counts regular files and skips DEFAULT_IGNORES dirs', async () => {
    const root = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'b');
    fs.writeFileSync(path.join(root, 'node_modules', 'x', 'huge.js'), 'x');
    expect(await countFilesBounded(root, 100)).toBe(2);
  });

  it('stops early once the limit is exceeded', async () => {
    const root = path.join(tmp, 'many');
    fs.mkdirSync(root, { recursive: true });
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x');
    expect(await countFilesBounded(root, 3)).toBe(4); // limit+1: enough to know it's over
  });

  it('treats a walk deeper than MAX_DEPTH (100) as over-limit', async () => {
    // Build a 120-level-deep chain of single-char dirs with one file at the
    // bottom. This stands in for the junction-cycle hazard: isSymbolicLink()
    // misses NTFS junctions, so an unbounded walk would recurse forever. The
    // depth cap must fire and return the over-limit signal (> limit) even
    // though only one real file exists. Short segment names keep us under
    // Windows MAX_PATH (modern Node uses the \\?\ long-path prefix anyway).
    let deep = path.join(tmp, 'deep');
    for (let i = 0; i < 120; i++) deep = path.join(deep, 'd');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'bottom.txt'), 'x');
    expect(await countFilesBounded(path.join(tmp, 'deep'), 100)).toBeGreaterThan(100);
  });

  // main-blocking-calls B6 (2026-09-24): the walk is async now. Pin that it
  // really yields — a timer queued before the walk must get to run while the
  // walk is still going (a sync walk would finish first, then the timer).
  it('yields to other work while it walks (does not hold the main thread)', async () => {
    const root = path.join(tmp, 'wide');
    for (let i = 0; i < 30; i++) {
      fs.mkdirSync(path.join(root, `d${i}`), { recursive: true });
      fs.writeFileSync(path.join(root, `d${i}`, 'f.txt'), 'x');
    }
    let walkDone = false;
    let timerRanDuringWalk = false;
    setTimeout(() => { timerRanDuringWalk = !walkDone; }, 0);
    const n = await countFilesBounded(root, 1000);
    walkDone = true;
    expect(n).toBe(30);
    expect(timerRanDuringWalk).toBe(true);
  });
});

describe('checkImport', () => {
  function ctx(over: Partial<Parameters<typeof checkImport>[0]> = {}) {
    const youcodedRoot = path.join(tmp, 'YouCoded');
    const projectsRoot = path.join(youcodedRoot, 'Projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const source = path.join(tmp, 'mywork');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'notes.md'), 'hi');
    return { sourcePath: source, name: 'mywork', projectsRoot, youcodedRoot, liveCwds: [] as string[], ...over };
  }

  it('passes for a plain folder', async () => {
    expect(await checkImport(ctx())).toBeNull();
  });

  it('rejects a missing source', async () => {
    expect(await checkImport(ctx({ sourcePath: path.join(tmp, 'ghost') }))).toMatch(/no longer exists/);
  });

  it('rejects a file source', async () => {
    const f = path.join(tmp, 'file.txt');
    fs.writeFileSync(f, 'x');
    expect(await checkImport(ctx({ sourcePath: f }))).toMatch(/file, not a folder/);
  });

  it('passes validateSyncName failures through verbatim', async () => {
    expect(await checkImport(ctx({ name: 'bad:name' }))).toMatch(/character not allowed/);
  });

  it('rejects a source already inside ~/YouCoded', async () => {
    const c = ctx();
    const inside = path.join(c.youcodedRoot, 'Personal', 'notes');
    fs.mkdirSync(inside, { recursive: true });
    expect(await checkImport({ ...c, sourcePath: inside })).toMatch(/already inside your YouCoded folder/);
  });

  it('rejects a source that CONTAINS ~/YouCoded (would move the destination into itself)', async () => {
    const c = ctx();
    expect(await checkImport({ ...c, sourcePath: tmp, name: 'everything' })).toMatch(/contains your YouCoded folder/);
  });

  it('rejects when the destination name is taken', async () => {
    const c = ctx();
    fs.mkdirSync(path.join(c.projectsRoot, 'mywork'), { recursive: true });
    expect(await checkImport(c)).toMatch(/already exists/);
  });

  it('rejects while a live session has its cwd inside the source', async () => {
    const c = ctx();
    expect(await checkImport({ ...c, liveCwds: [path.join(c.sourcePath, 'sub')] })).toMatch(/session is currently open/);
    expect(await checkImport({ ...c, liveCwds: [c.sourcePath] })).toMatch(/session is currently open/);
    expect(await checkImport({ ...c, liveCwds: [path.join(tmp, 'elsewhere')] })).toBeNull();
  });
});

describe('importProjectFolder', () => {
  // Full fake home: claudeDir + YouCoded roots + a source folder with content,
  // a saved-folder entry, a central-index entry, a sidecar with a manual
  // include, and a fake CC transcript slug dir.
  async function setup() {
    const claudeDir = path.join(tmp, '.claude');
    const youcodedRoot = path.join(tmp, 'YouCoded');
    const projectsRoot = path.join(youcodedRoot, 'Projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.mkdirSync(claudeDir, { recursive: true });

    const source = path.join(tmp, 'budget-app');
    fs.mkdirSync(path.join(source, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(source, 'docs', 'plan.md'), 'the plan');

    const foldersFile = path.join(claudeDir, 'youcoded-folders.json');
    writeSavedFolders([{ path: source, nickname: 'Budget', addedAt: 99 }], foldersFile);

    await upsertProject(claudeDir, {
      id: 'ULIDBUDGET', name: 'budget-app', path: canonicalize(source, null),
      lastIndexed: new Date().toISOString(), lastSession: null,
      contentTypes: ['artifacts'], stats: { artifactCount: 1 },
    } as any);

    const now = new Date().toISOString();
    await writeSidecar(source, null, {
      $schema: SIDECAR_SCHEMA_VERSION, projectId: 'ULIDBUDGET', name: 'budget-app',
      createdAt: now, updatedAt: now, artifacts: [],
      manualExcludes: [],
      // Real ManualInclude shape ({path, addedAt, addedBy}) — the remap must
      // rewrite ONLY .path and carry the provenance fields through untouched.
      manualIncludes: [{
        path: canonicalize(path.join(source, 'docs', 'plan.md'), null),
        addedAt: now, addedBy: 'user',
      }],
    });

    // CC transcript dir for the OLD path (drive-case-normalized slug)
    const oldSlug = ccProjectSlug(source);
    const slugDir = path.join(claudeDir, 'projects', oldSlug);
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, 'session1.jsonl'), '{}');

    return { claudeDir, youcodedRoot, projectsRoot, source, foldersFile, includeAddedAt: now };
  }

  it('moves the folder and remaps saved folders, central index, sidecar includes, and the transcript slug dir', async () => {
    const s = await setup();
    const result = await importProjectFolder({
      sourcePath: s.source, name: 'budget-app',
      projectsRoot: s.projectsRoot, youcodedRoot: s.youcodedRoot,
      liveCwds: [], claudeDir: s.claudeDir,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dest = path.join(s.projectsRoot, 'budget-app');
    expect(result.path).toBe(dest);
    expect(result.warnings).toEqual([]);

    // folder moved (content intact, source gone)
    expect(fs.readFileSync(path.join(dest, 'docs', 'plan.md'), 'utf8')).toBe('the plan');
    expect(fs.existsSync(s.source)).toBe(false);

    // saved-folders entry rewritten, nickname kept
    const folders = readSavedFolders(s.foldersFile);
    expect(folders[0].nickname).toBe('Budget');
    expect(path.resolve(folders[0].path)).toBe(path.resolve(dest));

    // central index remapped, identity kept
    const projects = await listProjects(s.claudeDir);
    expect(projects[0].id).toBe('ULIDBUDGET');
    expect(projects[0].path).toBe(canonicalize(dest, null));

    // sidecar traveled with the folder; manual include re-pointed inside it,
    // provenance fields (addedAt/addedBy) carried through untouched
    const sidecar = await readSidecar(dest);
    expect(sidecar && !('corrupted' in sidecar) && sidecar.manualIncludes[0]).toEqual({
      path: canonicalize(path.join(dest, 'docs', 'plan.md'), null),
      addedAt: s.includeAddedAt, addedBy: 'user',
    });

    // transcript slug dir renamed to the new path's slug
    expect(fs.existsSync(path.join(s.claudeDir, 'projects', ccProjectSlug(s.source)))).toBe(false);
    expect(fs.readFileSync(path.join(s.claudeDir, 'projects', ccProjectSlug(dest), 'session1.jsonl'), 'utf8')).toBe('{}');
  });

  it('refuses (ok:false) when a guard fails, without touching the source', async () => {
    const s = await setup();
    const result = await importProjectFolder({
      sourcePath: s.source, name: 'budget-app',
      projectsRoot: s.projectsRoot, youcodedRoot: s.youcodedRoot,
      liveCwds: [s.source], claudeDir: s.claudeDir,
    });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(s.source)).toBe(true);
  });

  it('degrades a store-remap failure to ok:true + warning (corrupt central index)', async () => {
    const s = await setup();
    // Corrupt the index AFTER setup wrote a valid one: remapProjectPath's
    // parseIndex (JSON.parse inside mutateFileUnderLock) throws on this, which
    // must surface as a WARNING while the move itself still succeeds.
    fs.writeFileSync(path.join(s.claudeDir, 'youcoded-projects-index.json'), '{not json');
    const result = await importProjectFolder({
      sourcePath: s.source, name: 'budget-app',
      projectsRoot: s.projectsRoot, youcodedRoot: s.youcodedRoot,
      liveCwds: [], claudeDir: s.claudeDir,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toContain(
      'The artifact index could not be updated — artifact history may restart for this project.'
    );
    // The move and the OTHER remaps still went through.
    const dest = path.join(s.projectsRoot, 'budget-app');
    expect(fs.existsSync(s.source)).toBe(false);
    expect(fs.existsSync(path.join(dest, 'docs', 'plan.md'))).toBe(true);
    expect(fs.existsSync(path.join(s.claudeDir, 'projects', ccProjectSlug(dest), 'session1.jsonl'))).toBe(true);
  });

  it('merges into an existing slug dir instead of failing when the new slug already exists', async () => {
    const s = await setup();
    const dest = path.join(s.projectsRoot, 'budget-app');
    const newSlugDir = path.join(s.claudeDir, 'projects', ccProjectSlug(dest));
    fs.mkdirSync(newSlugDir, { recursive: true });
    fs.writeFileSync(path.join(newSlugDir, 'existing.jsonl'), '{}');
    const result = await importProjectFolder({
      sourcePath: s.source, name: 'budget-app',
      projectsRoot: s.projectsRoot, youcodedRoot: s.youcodedRoot,
      liveCwds: [], claudeDir: s.claudeDir,
    });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(newSlugDir, 'session1.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(newSlugDir, 'existing.jsonl'))).toBe(true);
  });
  // main-blocking-calls B6 (2026-09-24): the cross-drive branch is async now
  // (fs.promises.cp / rm). EXDEV can't be produced inside one tmp dir, so fake
  // the rename refusal and check the copy-then-delete MOVE still happens.
  it('cross-drive (EXDEV) import copies then deletes the source — still a MOVE', async () => {
    const s = await setup();
    const realRename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === s.source) throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
      return realRename(from, to);
    });
    const result = await importProjectFolder({
      sourcePath: s.source, name: 'budget-app',
      projectsRoot: s.projectsRoot, youcodedRoot: s.youcodedRoot,
      liveCwds: [], claudeDir: s.claudeDir,
    });
    expect(result.ok).toBe(true);
    const dest = path.join(s.projectsRoot, 'budget-app');
    expect(fs.readFileSync(path.join(dest, 'docs', 'plan.md'), 'utf8')).toBe('the plan');
    expect(fs.existsSync(s.source)).toBe(false);
  });

  it('cross-drive import refuses, touching nothing, when the destination appeared after the check', async () => {
    const s = await setup();
    const dest = path.join(s.projectsRoot, 'budget-app');
    vi.spyOn(fs.promises, 'rename').mockImplementation(async () => {
      // The destination is claimed between the check and the move (e.g. the
      // sync engine materializing the same project from another device).
      fs.mkdirSync(path.join(dest, 'theirs'), { recursive: true });
      throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    });
    const cp = vi.spyOn(fs.promises, 'cp');
    const result = await importProjectFolder({
      sourcePath: s.source, name: 'budget-app',
      projectsRoot: s.projectsRoot, youcodedRoot: s.youcodedRoot,
      liveCwds: [], claudeDir: s.claudeDir,
    });
    expect(result).toEqual({ ok: false, error: 'A project with that name already exists' });
    expect(cp).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dest, 'theirs'))).toBe(true); // never merged into or deleted
    expect(fs.existsSync(path.join(s.source, 'docs', 'plan.md'))).toBe(true);
  });

  // WHY: check + move used to be one synchronous step, so two imports to the
  // same name in this process could never interleave. Now both await; without
  // the in-flight claim both could pass the check, and on Linux/macOS rename()
  // silently replaces an EMPTY destination folder.
  it('two overlapping imports to the same name: exactly one moves, the other is refused', async () => {
    const s = await setup();
    const other = path.join(tmp, 'other-budget');
    fs.mkdirSync(other, { recursive: true }); // empty — the rename-replaces-empty-dir case
    const common = { name: 'budget-app', projectsRoot: s.projectsRoot, youcodedRoot: s.youcodedRoot, liveCwds: [], claudeDir: s.claudeDir };
    const [a, b] = await Promise.all([
      importProjectFolder({ ...common, sourcePath: s.source }),
      importProjectFolder({ ...common, sourcePath: other }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(a.ok).toBe(true); // the first to start wins
    expect(b.ok).toBe(false);
    expect(fs.existsSync(other)).toBe(true); // the refused source is untouched
    expect(fs.readFileSync(path.join(s.projectsRoot, 'budget-app', 'docs', 'plan.md'), 'utf8')).toBe('the plan');
  });
});
