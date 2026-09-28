import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// WHY mocked: the real watcher module pulls in chokidar and the artifact store; this test only
// needs to know the save told it "this write was ours".
vi.mock('../../src/main/artifacts/project-watcher', () => ({ noteOwnWrite: vi.fn() }));

import { noteOwnWrite } from '../../src/main/artifacts/project-watcher';
import { awaitIdle, createOfficeCommands, OFFICE_COMMANDS } from '../../src/main/office/office-commands';
import { createSessions, type OfficeSession } from '../../src/main/office/office-sessions';
import { convert, FORMAT } from '../../src/main/office/x2t';
import { OFFICE_MAX_BYTES } from '../../src/shared/office-types';

const ROOT = fileURLToPath(new URL('../../office-addon/', import.meta.url));
const MEMO = fileURLToPath(new URL('./fixtures/memo.docx', import.meta.url));
const NOTICE = fileURLToPath(new URL('./fixtures/notice.docx', import.meta.url));
const HAS_ADDON = existsSync(path.join(ROOT, 'manifest.json'));
if (!HAS_ADDON) console.warn('[office-commands.test] skipping real-x2t tests: office-addon/manifest.json is missing');

// x2t's plain-text output code (AVS_OFFICESTUDIO_FILE_DOCUMENT_TXT). Used only here, to read
// back what a saved file says without a zip library.
const TXT = 69;
const X2T_WARMUP_BUDGET_MS = 120_000;

let dir: string;
let sessions: ReturnType<typeof createSessions>;

async function sessionFor(src: string, rel = 'docs/file.docx'): Promise<OfficeSession> {
  const file = path.join(dir, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await copyFile(src, file);
  return sessions.open(file, 1);
}

async function textOf(file: string): Promise<string> {
  const out = path.join(dir, `read-${Math.random().toString(36).slice(2)}.txt`);
  await convert(ROOT, file, out, TXT, path.join(dir, 'jobs'));
  return (await readFile(out)).toString('utf8');
}

const tmpsBeside = async (file: string) => (await readdir(path.dirname(file))).filter((n) => n.endsWith('.tmp'));

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'office-commands-test-'));
  sessions = createSessions(path.join(dir, 'base'));
  vi.mocked(noteOwnWrite).mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('office commands without the translator', () => {
  it('lists exactly the editor commands the spike answered', () => {
    expect([...OFFICE_COMMANDS].sort()).toEqual(
      [
        'js_log', 'get_current_path', 'set_window_title', 'set_document_modified', 'recent_files_state',
        'set_recent_files_enabled', 'clear_recent_files', 'get_system_fonts', 'list_user_dictionaries', 'recovery_begin',
        'recovery_end', 'recovery_mark_saved', 'recovery_candidates', 'recovery_load', 'recovery_discard', 'open_file',
        'write_editor_bin', 'save_file', 'save_changes', 'convert_for_insert', 'force_close',
      ].sort(),
    );
  });

  it('refuses an unknown command and an unknown token', async () => {
    const s = await sessionFor(MEMO);
    const run = createOfficeCommands({ root: ROOT, sessions });
    await expect(run(s.token, 'rm_rf', {})).rejects.toThrow('refused');
    await expect(run('0'.repeat(32), 'get_system_fonts', {})).rejects.toThrow('refused');
  });

  it('answers the font and recent-files questions with empty values', async () => {
    const s = await sessionFor(MEMO);
    const run = createOfficeCommands({ root: ROOT, sessions });
    expect(await run(s.token, 'get_system_fonts', {})).toBe('');
    expect(await run(s.token, 'recent_files_state', {})).toEqual({ enabled: false, files: [] });
  });

  it('records the document-modified flag on the session', async () => {
    const s = await sessionFor(MEMO);
    const run = createOfficeCommands({ root: ROOT, sessions });
    await run(s.token, 'set_document_modified', { modified: true });
    expect(s.modified).toBe(true);
    await run(s.token, 'set_document_modified', { modified: false });
    expect(s.modified).toBe(false);
  });

  it('refuses to open a file larger than the size limit', async () => {
    const s = await sessionFor(MEMO);
    // A sparse file: the size is real to stat, but no disk space is used.
    const fh = await open(s.path, 'r+');
    await fh.truncate(OFFICE_MAX_BYTES + 1);
    await fh.close();
    const run = createOfficeCommands({ root: ROOT, sessions });
    await expect(run(s.token, 'open_file', {})).rejects.toThrow("This file is larger than 200 MB, which Office can't open.");
  });

  it('refuses to open a file inside a protected folder', async () => {
    const s = await sessionFor(MEMO, 'repo/.git/memo.docx');
    const run = createOfficeCommands({ root: ROOT, sessions });
    await expect(run(s.token, 'open_file', {})).rejects.toThrow("Office can't open files in this protected folder.");
  });

  it('refuses an oversized editor file before decoding it', async () => {
    const s = await sessionFor(MEMO);
    const run = createOfficeCommands({ root: ROOT, sessions, editorBinMaxBytes: 10 });
    const from = vi.spyOn(Buffer, 'from');
    await expect(run(s.token, 'write_editor_bin', { data: 'A'.repeat(16) })).rejects.toThrow(
      'This document has grown too large for Office to save.',
    );
    expect(from).not.toHaveBeenCalled();
  });

  it("leaves the user's file untouched and no tmp behind when the translation fails", async () => {
    const s = await sessionFor(MEMO);
    const original = await readFile(s.path);
    const failing = async (_r: string, _f: string, to: string) => {
      await writeFile(to, 'half a file');
      throw new Error('x2t crashed');
    };
    const run = createOfficeCommands({ root: ROOT, sessions, convert: failing });
    await run(s.token, 'write_editor_bin', { data: Buffer.from('bin').toString('base64') });
    await expect(run(s.token, 'save_file', {})).rejects.toThrow();
    expect(await readFile(s.path)).toEqual(original);
    expect(await tmpsBeside(s.path)).toEqual([]);
  });

  it("refuses to replace the user's file with output that is not a document", async () => {
    const s = await sessionFor(MEMO);
    const original = await readFile(s.path);
    const garbage = async (_r: string, _f: string, to: string) => writeFile(to, 'not a zip at all');
    const run = createOfficeCommands({ root: ROOT, sessions, convert: garbage });
    await run(s.token, 'write_editor_bin', { data: Buffer.from('bin').toString('base64') });
    await expect(run(s.token, 'save_file', {})).rejects.toThrow();
    expect(await readFile(s.path)).toEqual(original);
    expect(await tmpsBeside(s.path)).toEqual([]);
  });

  it('awaitIdle waits for a save that is still translating', async () => {
    const s = await sessionFor(MEMO);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // WHY a signal: the negative check below is only meaningful once the save has reached the
    // translator — waiting on this instead of a fixed pause keeps it true under load.
    let entered!: () => void;
    const translating = new Promise<void>((r) => (entered = r));
    const slow = async (_r: string, _f: string, to: string) => {
      entered();
      await gate;
      await writeFile(to, Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(64)]));
    };
    const run = createOfficeCommands({ root: ROOT, sessions, convert: slow });
    await run(s.token, 'write_editor_bin', { data: Buffer.from('bin').toString('base64') });
    const saved = run(s.token, 'save_file', {});
    let idle = false;
    const idlePromise = awaitIdle().then(() => (idle = true));
    await translating;
    await new Promise((r) => setImmediate(r));
    expect(idle).toBe(false);
    release();
    await idlePromise;
    expect(idle).toBe(true);
    expect(await saved).toBe('ok');
    expect((await readFile(s.path)).subarray(0, 4).toString('latin1')).toBe('PK\x03\x04');
  });
});

describe.skipIf(!HAS_ADDON)('office commands with the bundled x2t', () => {
  beforeAll(async () => {
    const warm = await mkdtemp(path.join(tmpdir(), 'office-commands-warm-'));
    try {
      await convert(ROOT, MEMO, path.join(warm, 'Editor.bin'), FORMAT.bin, warm);
    } finally {
      await rm(warm, { recursive: true, force: true, maxRetries: 3 });
    }
  }, X2T_WARMUP_BUDGET_MS);

  it("opens the session's own file, ignoring any path the editor names", async () => {
    const s = await sessionFor(MEMO);
    const run = createOfficeCommands({ root: ROOT, sessions });
    const b64 = await run(s.token, 'open_file', { path: '/etc/passwd' });
    expect(typeof b64).toBe('string');
    const onDisk = await readFile(path.join(s.temp, 'Editor.bin'));
    expect(Buffer.from(b64 as string, 'base64')).toEqual(onDisk);
  });

  it("puts a document's pictures where office:// serves them", async () => {
    const s = await sessionFor(NOTICE);
    const run = createOfficeCommands({ root: ROOT, sessions });
    await run(s.token, 'open_file', {});
    expect((await readdir(path.join(s.temp, 'media'))).length).toBeGreaterThan(0);
    expect((await readdir(s.temp)).filter((n) => n.startsWith('job-'))).toEqual([]);
  });

  it('calls onOpened after a successful open', async () => {
    const s = await sessionFor(MEMO);
    const onOpened = vi.fn(async () => {});
    const run = createOfficeCommands({ root: ROOT, sessions, onOpened });
    await run(s.token, 'open_file', {});
    expect(onOpened).toHaveBeenCalledWith(s);
  });

  it('saves the edited document over the file atomically and it opens again', async () => {
    const s = await sessionFor(MEMO);
    const before = await readFile(s.path);
    const onSaved = vi.fn(async () => {});
    const run = createOfficeCommands({ root: ROOT, sessions, onSaved });
    const b64 = (await run(s.token, 'open_file', {})) as string;
    const old = new Date('2020-01-01T00:00:00Z');
    await utimes(s.path, old, old);
    s.modified = true;
    await run(s.token, 'write_editor_bin', { data: b64 });
    expect(await run(s.token, 'save_file', {})).toBe('ok');
    expect((await stat(s.path)).mtimeMs).not.toBe(old.getTime());
    expect(noteOwnWrite).toHaveBeenCalledWith(s.path);
    expect(await tmpsBeside(s.path)).toEqual([]);
    expect(s.modified).toBe(false);
    expect(onSaved).toHaveBeenCalledWith(s, before);
    expect(typeof (await run(s.token, 'open_file', {}))).toBe('string');
  });

  it('collapses saves queued back to back into one translation', async () => {
    const s = await sessionFor(MEMO);
    let runs = 0;
    const counting: typeof convert = async (...a) => {
      runs++;
      return convert(...a);
    };
    const run = createOfficeCommands({ root: ROOT, sessions, convert: counting });
    const b64 = (await run(s.token, 'open_file', {})) as string;
    runs = 0;
    const all = [run(s.token, 'write_editor_bin', { data: b64 }), run(s.token, 'save_file', {}), run(s.token, 'save_file', {}), run(s.token, 'save_changes', {})];
    expect(await Promise.all(all)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(runs).toBe(1);
  });

  it('keeps the newest content when two write-and-save rounds race', async () => {
    const s = await sessionFor(MEMO);
    // A: the memo's own editor form (it lands in the session temp, as the editor would have it).
    const run0 = createOfficeCommands({ root: ROOT, sessions });
    const a = (await run0(s.token, 'open_file', {})) as string;
    // B: a different document's editor form.
    const bDir = await mkdtemp(path.join(dir, 'b-'));
    await convert(ROOT, NOTICE, path.join(bDir, 'Editor.bin'), FORMAT.bin, bDir);
    const b = (await readFile(path.join(bDir, 'Editor.bin'))).toString('base64');

    let runs = 0;
    const counting: typeof convert = async (...args) => {
      runs++;
      return convert(...args);
    };
    const run = createOfficeCommands({ root: ROOT, sessions, convert: counting });
    const all = [
      run(s.token, 'write_editor_bin', { data: a }),
      run(s.token, 'save_file', {}),
      run(s.token, 'write_editor_bin', { data: b }),
      run(s.token, 'save_file', {}),
    ];
    await Promise.all(all);
    expect(await textOf(s.path)).toContain('Garden Club Notice');
    expect(await tmpsBeside(s.path)).toEqual([]);
    expect(runs).toBeLessThanOrEqual(2);
  });
});
