import { mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBlank, pickFile, projectFiles } from '../../src/main/office/office-home';

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), 'office-home-test-')));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** Writes a file (making its folders) and, when given, sets its changed time. */
async function put(rel: string, mtimeSec?: number, body = 'x'): Promise<string> {
  const p = path.join(dir, rel);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, body);
  if (mtimeSec !== undefined) await utimes(p, mtimeSec, mtimeSec);
  return p;
}

describe('projectFiles (the "In <project>" list)', () => {
  it('finds documents, spreadsheets and presentations up to three folders deep, and nothing else', async () => {
    await put('top.docx');
    await put('a/budget.xlsx');
    await put('a/b/talk.pptx');
    await put('a/b/c/deep.docx');
    await put('a/b/c/d/too-deep.docx');
    await put('notes.txt');
    await put('a/old.doc');
    const files = await projectFiles(dir);
    expect(files.map((f) => f.name).sort()).toEqual(['budget.xlsx', 'deep.docx', 'talk.pptx', 'top.docx']);
    const talk = files.find((f) => f.name === 'talk.pptx')!;
    expect(talk).toMatchObject({ path: path.join(dir, 'a/b/talk.pptx'), kind: 'presentation', folder: 'b' });
    expect(files.find((f) => f.name === 'budget.xlsx')!.kind).toBe('spreadsheet');
    expect(files.find((f) => f.name === 'top.docx')!.kind).toBe('document');
  });

  it('skips node_modules, .git and every other hidden folder', async () => {
    await put('keep.docx');
    await put('node_modules/pkg/readme.docx');
    await put('.git/x.docx');
    await put('.cache/y.xlsx');
    await put('src/.hidden/z.pptx');
    expect((await projectFiles(dir)).map((f) => f.name)).toEqual(['keep.docx']);
  });

  it("skips the editors' own lock files", async () => {
    await put('report.docx');
    await put('~$report.docx');
    await put('.~lock.report.docx#');
    await put('.report.docx');
    expect((await projectFiles(dir)).map((f) => f.name)).toEqual(['report.docx']);
  });

  it('lists the most recently changed first, each with its changed time', async () => {
    await put('old.docx', 1_700_000_000);
    await put('new.xlsx', 1_800_000_000);
    await put('mid/mid.pptx', 1_750_000_000);
    const files = await projectFiles(dir);
    expect(files.map((f) => f.name)).toEqual(['new.xlsx', 'mid.pptx', 'old.docx']);
    expect(files[0].at).toBe(new Date(1_800_000_000 * 1000).toISOString());
  });

  it('lists at most 50 files', async () => {
    for (let i = 0; i < 60; i++) await put(`f${i}.docx`, 1_700_000_000 + i);
    const files = await projectFiles(dir);
    expect(files).toHaveLength(50);
    expect(files[0].name).toBe('f59.docx');
  });

  it('stops looking after a bounded number of folders, so a huge folder cannot stall it', async () => {
    // WHY a count, not a clock: the cap is on work done — folders read — never on time.
    for (let i = 0; i < 30; i++) await put(`d${String(i).padStart(2, '0')}/f.docx`);
    const reads: string[] = [];
    const files = await projectFiles(dir, { maxDirs: 10, onReadDir: (d) => reads.push(d) });
    expect(reads.length).toBe(10);
    expect(files.length).toBeLessThan(30);
  });

  it('answers an empty list for a folder that does not exist', async () => {
    await expect(projectFiles(path.join(dir, 'gone'))).resolves.toEqual([]);
  });
});

describe('createBlank (New document / spreadsheet / presentation)', () => {
  const kinds = [
    ['document', 'docx', 'Untitled document'],
    ['spreadsheet', 'xlsx', 'Untitled spreadsheet'],
    ['presentation', 'pptx', 'Untitled presentation'],
  ] as const;

  let root: string;
  let target: string;
  beforeEach(async () => {
    // A stand-in add-on: generated templates, each with its own bytes.
    root = path.join(dir, 'addon');
    await mkdir(path.join(root, 'templates'), { recursive: true });
    for (const [, ext] of kinds) await writeFile(path.join(root, 'templates', `blank.${ext}`), `template ${ext}`);
    target = path.join(dir, 'project');
    await mkdir(target);
  });

  for (const [kind, ext, base] of kinds) {
    it(`copies the blank ${ext} template to "${base}.${ext}", then "${base} 2.${ext}"`, async () => {
      const first = await createBlank(root, kind, target);
      expect(first).toMatchObject({ path: path.join(target, `${base}.${ext}`), name: `${base}.${ext}`, kind, folder: 'project' });
      expect(await readFile(first.path, 'utf8')).toBe(`template ${ext}`);
      const second = await createBlank(root, kind, target);
      expect(second.name).toBe(`${base} 2.${ext}`);
      expect(await readFile(second.path, 'utf8')).toBe(`template ${ext}`);
    });
  }

  it('never replaces a file that already has the name — it takes the next free number', async () => {
    await writeFile(path.join(target, 'Untitled document.docx'), 'mine');
    await writeFile(path.join(target, 'Untitled document 2.docx'), 'mine too');
    const made = await createBlank(root, 'document', target);
    expect(made.name).toBe('Untitled document 3.docx');
    expect(await readFile(path.join(target, 'Untitled document.docx'), 'utf8')).toBe('mine');
    expect(await readFile(path.join(target, 'Untitled document 2.docx'), 'utf8')).toBe('mine too');
  });

  it('gives each of several creations at once its own file', async () => {
    const made = await Promise.all([1, 2, 3, 4].map(() => createBlank(root, 'spreadsheet', target)));
    expect(new Set(made.map((f) => f.name)).size).toBe(4);
    expect((await readdir(target)).sort()).toEqual(made.map((f) => f.name).sort());
  });

  it('fails without leaving a file behind when the template is missing', async () => {
    await rm(path.join(root, 'templates', 'blank.pptx'));
    await expect(createBlank(root, 'presentation', target)).rejects.toThrow();
    expect(await readdir(target)).toEqual([]);
  });
});

describe('pickFile (the system file picker)', () => {
  it('asks for Office files only, parented to the asking window, and describes the chosen one', async () => {
    const chosen = await put('pick/Plan.xlsx');
    const win = { id: 7 };
    const show = vi.fn(async () => ({ canceled: false, filePaths: [chosen] }));
    const f = await pickFile(win, show);
    expect(show).toHaveBeenCalledTimes(1);
    const [parent, opts] = show.mock.calls[0] as unknown as [unknown, { filters: unknown; properties: string[] }];
    expect(parent).toBe(win);
    expect(opts.filters).toEqual([{ name: 'Office files', extensions: ['docx', 'xlsx', 'pptx'] }]);
    expect(opts.properties).toContain('openFile');
    expect(f).toMatchObject({ path: chosen, name: 'Plan.xlsx', kind: 'spreadsheet', folder: 'pick' });
  });

  it('answers null when the picker is cancelled', async () => {
    await expect(pickFile(null, async () => ({ canceled: true, filePaths: [] }))).resolves.toBeNull();
  });

  it('answers null for a file of another kind (a platform that ignores the filter)', async () => {
    const other = await put('notes.txt');
    await expect(pickFile(null, async () => ({ canceled: false, filePaths: [other] }))).resolves.toBeNull();
  });
});
