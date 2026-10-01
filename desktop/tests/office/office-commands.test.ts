import { existsSync, promises as fsNode } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, open, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// WHY mocked: the real watcher module pulls in chokidar and the artifact store; this test only
// needs to know the save told it "this write was ours".
vi.mock('../../src/main/artifacts/project-watcher', () => ({ noteOwnWrite: vi.fn() }));

import { noteOwnWrite } from '../../src/main/artifacts/project-watcher';
import { awaitIdle, CLOSE_DRAIN_MS, createOfficeCommands, drainSession, OFFICE_COMMANDS } from '../../src/main/office/office-commands';
import { X2T_TIMEOUT_MS } from '../../src/main/office/x2t';
import { createSessions, type OfficeSession } from '../../src/main/office/office-sessions';
import { convert, FORMAT, X2tError } from '../../src/main/office/x2t';
import { OFFICE_MAX_BYTES } from '../../src/shared/office-types';

const ROOT = fileURLToPath(new URL('../../office-addon/', import.meta.url));
const MEMO = fileURLToPath(new URL('./fixtures/memo.docx', import.meta.url));
const NOTICE = fileURLToPath(new URL('./fixtures/notice.docx', import.meta.url));
const PICTURE = fileURLToPath(new URL('./fixtures/picture.docx', import.meta.url));
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
  // convert() never creates its temp base (quit removes it), so the reader makes its own.
  await mkdir(path.join(dir, 'jobs'), { recursive: true });
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
        'write_editor_bin', 'save_file', 'save_changes', 'convert_for_insert', 'force_close', 'open_dialog',
        'save_dialog', 'save_file_as', 'print_document', 'save_editor_settings',
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

  it('acknowledges the document-modified flag without keeping it (the renderer tracks changes)', async () => {
    const s = await sessionFor(MEMO);
    const run = createOfficeCommands({ root: ROOT, sessions });
    await expect(run(s.token, 'set_document_modified', { modified: true })).resolves.toBeNull();
    await expect(run(s.token, 'set_document_modified', { modified: false })).resolves.toBeNull();
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
    // Nothing else may decode the payload (logging a refusal may use Buffer.from on its own text).
    expect(from.mock.calls.filter((c) => (c as unknown[])[1] === 'base64')).toEqual([]);
  });

  it("acknowledges the editor's recovery change log without translating or touching the file", async () => {
    const s = await sessionFor(MEMO);
    const original = await readFile(s.path);
    const convertSpy = vi.fn(async () => { throw new Error('must not translate'); });
    const run = createOfficeCommands({ root: ROOT, sessions, convert: convertSpy });
    await run(s.token, 'set_document_modified', { modified: true });
    expect(await run(s.token, 'save_changes', { changes: ['x'], deleteIndex: 3, count: 1 })).toBe('ok');
    expect(convertSpy).not.toHaveBeenCalled();
    expect(await readFile(s.path)).toEqual(original);
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

  it('keeps a picture through a save (the saved file still carries word/media)', async () => {
    const s = await sessionFor(PICTURE);
    const run = createOfficeCommands({ root: ROOT, sessions });
    const b64 = (await run(s.token, 'open_file', {})) as string;
    await run(s.token, 'write_editor_bin', { data: b64 });
    expect(await run(s.token, 'save_file', {})).toBe('ok');
    // A zip stores its entry names uncompressed, so the name is findable in the bytes.
    expect((await readFile(s.path)).includes('word/media/')).toBe(true);
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
    await run(s.token, 'write_editor_bin', { data: b64 });
    expect(await run(s.token, 'save_file', {})).toBe('ok');
    expect((await stat(s.path)).mtimeMs).not.toBe(old.getTime());
    expect(noteOwnWrite).toHaveBeenCalledWith(s.path);
    expect(await tmpsBeside(s.path)).toEqual([]);
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
    const all = [run(s.token, 'write_editor_bin', { data: b64 }), run(s.token, 'save_file', {}), run(s.token, 'save_file', {}), run(s.token, 'save_changes', { changes: [] })];
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

// A fake translator that writes a small, valid-looking document (zip signature first).
const fakeDoc = async (_r: string, _f: string, to: string) => {
  await writeFile(to, Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(64)]));
};
const writeBin = (run: ReturnType<typeof createOfficeCommands>, token: string) =>
  run(token, 'write_editor_bin', { data: Buffer.from('bin').toString('base64') });

describe('office command errors the editor is shown', () => {
  // WHY: the editor frame is the least-trusted party here — it must never learn where a file
  // lives on disk, only a message a person can act on.
  const noPath = (msg: string) => {
    expect(msg).not.toContain(dir);
    expect(msg).not.toMatch(/[\\/]/);
  };
  async function saveError(fail: unknown): Promise<string> {
    const s = await sessionFor(MEMO);
    const run = createOfficeCommands({
      root: ROOT,
      sessions,
      convert: async () => {
        throw fail;
      },
    });
    await writeBin(run, s.token);
    const err = await run(s.token, 'save_file', {}).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    noPath(err!.message);
    return err!.message;
  }

  it('says permission was refused when saving hits EACCES or EPERM', async () => {
    const e = Object.assign(new Error(`EACCES: permission denied, open '${dir}/x'`), { code: 'EACCES' });
    expect(await saveError(e)).toBe("Office doesn't have permission to save this file.");
    const p = Object.assign(new Error(`EPERM: operation not permitted '${dir}/x'`), { code: 'EPERM' });
    expect(await saveError(p)).toBe("Office doesn't have permission to save this file.");
  });

  it('says the disk is full when saving hits ENOSPC', async () => {
    const e = Object.assign(new Error(`ENOSPC: no space left on device, write '${dir}/x'`), { code: 'ENOSPC' });
    expect(await saveError(e)).toBe("The disk is full, so Office couldn't save this file.");
  });

  it('says the file took too long when the translator times out', async () => {
    expect(await saveError(new X2tError('x2t failed (timeout)', 'timeout', `stuck on ${dir}/x`))).toBe(
      'This file took too long to convert, so Office stopped.',
    );
  });

  it('gives a general message, with no cause guessed, for anything else', async () => {
    expect(await saveError(new X2tError('x2t failed (1)', 1, `bad input ${dir}/x`))).toBe("Office couldn't save this file.");
    expect(await saveError(new Error(`something odd at ${dir}/y`))).toBe("Office couldn't save this file.");
  });

  it('says the file cannot be found when opening a missing file', async () => {
    const s = await sessionFor(MEMO);
    await rm(s.path);
    const run = createOfficeCommands({ root: ROOT, sessions, convert: fakeDoc });
    const err = await run(s.token, 'open_file', {}).catch((e: Error) => e);
    expect((err as Error).message).toBe("Office can't find this file.");
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'says permission was refused when opening an unreadable file (POSIX, non-root: root reads anything)',
    async () => {
      const s = await sessionFor(MEMO);
      await chmod(s.path, 0o000);
      const run = createOfficeCommands({ root: ROOT, sessions, convert: fakeDoc });
      const err = await run(s.token, 'open_file', {}).catch((e: Error) => e);
      expect((err as Error).message).toBe("Office doesn't have permission to open this file.");
      noPath((err as Error).message);
    },
  );

  it('words the unsupported-type refusal for opening and for saving separately', async () => {
    const s = await sessionFor(MEMO, 'docs/notes.odt');
    const run = createOfficeCommands({ root: ROOT, sessions, convert: fakeDoc });
    await expect(run(s.token, 'open_file', {})).rejects.toThrow("Office can't open this kind of file.");
    await writeBin(run, s.token);
    await expect(run(s.token, 'save_file', {})).rejects.toThrow("Office can't save this kind of file.");
  });

  it('tells the editor only the file name, never its folder', async () => {
    const s = await sessionFor(MEMO, 'docs/Quarterly memo.docx');
    const run = createOfficeCommands({ root: ROOT, sessions });
    expect(await run(s.token, 'get_current_path', {})).toBe('Quarterly memo.docx');
  });
});

describe('office saves keep the file safe', () => {
  it.skipIf(process.platform === 'win32')('keeps a private file private after a save (POSIX file modes)', async () => {
    const s = await sessionFor(MEMO);
    await chmod(s.path, 0o600);
    const run = createOfficeCommands({ root: ROOT, sessions, convert: fakeDoc });
    await writeBin(run, s.token);
    expect(await run(s.token, 'save_file', {})).toBe('ok');
    expect((await stat(s.path)).mode & 0o777).toBe(0o600);
  });

  it('runs a save again when it is asked for while another save is already translating', async () => {
    const s = await sessionFor(MEMO);
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const translating = new Promise<void>((r) => (entered = r));
    const gated = async (r: string, f: string, to: string) => {
      runs++;
      if (runs === 1) {
        entered();
        await gate;
      }
      await fakeDoc(r, f, to);
    };
    const run = createOfficeCommands({ root: ROOT, sessions, convert: gated });
    await writeBin(run, s.token);
    const first = run(s.token, 'save_file', {});
    await translating;
    const second = run(s.token, 'save_file', {});
    release();
    expect(await Promise.all([first, second])).toEqual(['ok', 'ok']);
    expect(runs).toBe(2);
  });

  it('removes a leftover partial editor file when writing it fails', async () => {
    const s = await sessionFor(MEMO);
    const run = createOfficeCommands({ root: ROOT, sessions });
    // A directory where the final Editor.bin should go makes the rename fail after the write.
    await mkdir(path.join(s.temp, 'Editor.bin', 'blocker'), { recursive: true });
    await expect(writeBin(run, s.token)).rejects.toThrow();
    expect((await readdir(s.temp)).filter((n) => n.endsWith('.part'))).toEqual([]);
  });
});

describe('office commands at quit', () => {
  // WHY a fresh module: the closing switch is module state, and it must not leak into the
  // other tests in this file.
  async function freshModule() {
    vi.resetModules();
    return import('../../src/main/office/office-commands');
  }

  it("abandons a save that is still translating when quit gives up waiting, leaving the user's file untouched", async () => {
    const m = await freshModule();
    const s = await sessionFor(MEMO);
    const original = await readFile(s.path);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const translating = new Promise<void>((r) => (entered = r));
    const slow = async (r: string, f: string, to: string) => {
      entered();
      await gate;
      await fakeDoc(r, f, to);
    };
    const run = m.createOfficeCommands({ root: ROOT, sessions, convert: slow });
    await writeBin(run, s.token);
    const saved = run(s.token, 'save_file', {});
    await translating;
    m.stopOfficeCommands();
    release();
    await expect(saved).rejects.toThrow('Office is closing.');
    expect(await readFile(s.path)).toEqual(original);
    expect(await tmpsBeside(s.path)).toEqual([]);
  });

  it('refuses every command that arrives once quit has started', async () => {
    const m = await freshModule();
    const s = await sessionFor(MEMO);
    const run = m.createOfficeCommands({ root: ROOT, sessions, convert: fakeDoc });
    m.stopOfficeCommands();
    await expect(run(s.token, 'get_system_fonts', {})).rejects.toThrow('Office is closing.');
    await expect(writeBin(run, s.token)).rejects.toThrow('Office is closing.');
  });
});

describe('office saves never expose a private file while translating', () => {
  it.skipIf(process.platform === 'win32')(
    'translates into a private folder beside the file that only the owner can enter (POSIX modes)',
    async () => {
      const s = await sessionFor(MEMO);
      await chmod(s.path, 0o600);
      let parentMode = -1;
      let parentDir = '';
      const probe = async (r: string, f: string, to: string) => {
        parentDir = path.dirname(to);
        parentMode = (await stat(parentDir)).mode & 0o777;
        await fakeDoc(r, f, to);
      };
      const run = createOfficeCommands({ root: ROOT, sessions, convert: probe });
      await writeBin(run, s.token);
      expect(await run(s.token, 'save_file', {})).toBe('ok');
      expect(parentMode).toBe(0o700);
      expect(path.dirname(parentDir)).toBe(path.dirname(s.path));
      expect(existsSync(parentDir)).toBe(false);
      expect((await stat(s.path)).mode & 0o777).toBe(0o600);
    },
  );

  it('removes its private folder when the translation fails', async () => {
    const s = await sessionFor(MEMO);
    let parentDir = '';
    const failing = async (_r: string, _f: string, to: string) => {
      parentDir = path.dirname(to);
      await writeFile(to, 'half');
      throw new Error('x2t crashed');
    };
    const run = createOfficeCommands({ root: ROOT, sessions, convert: failing });
    await writeBin(run, s.token);
    await expect(run(s.token, 'save_file', {})).rejects.toThrow();
    expect(parentDir).not.toBe('');
    expect(existsSync(parentDir)).toBe(false);
    expect(await readdir(path.dirname(s.path))).toEqual(['file.docx']);
  });

  it('sweeps a private save folder left behind over an hour ago, and keeps a recent one', async () => {
    const s = await sessionFor(MEMO);
    const docs = path.dirname(s.path);
    const stale = path.join(docs, '.file.docx.office-save-stale1');
    const fresh = path.join(docs, '.file.docx.office-save-fresh1');
    await mkdir(stale);
    await writeFile(path.join(stale, 'file.docx'), 'old');
    await mkdir(fresh);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stale, old, old);
    const run = createOfficeCommands({ root: ROOT, sessions, convert: fakeDoc });
    await writeBin(run, s.token);
    await run(s.token, 'save_file', {});
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe('office save errors, round two', () => {
  const failWith = (code: string) => async () => {
    throw Object.assign(new Error(`${code}: somewhere ${dir}`), { code });
  };

  it('says the file is on a read-only disk when saving hits EROFS', async () => {
    const s = await sessionFor(MEMO);
    const run = createOfficeCommands({ root: ROOT, sessions, convert: failWith('EROFS') });
    await writeBin(run, s.token);
    await expect(run(s.token, 'save_file', {})).rejects.toThrow("This file is on a read-only disk, so Office couldn't save it.");
  });

  it('says the disk is full when storing the edited document hits ENOSPC', async () => {
    const s = await sessionFor(MEMO);
    const run = createOfficeCommands({ root: ROOT, sessions });
    vi.spyOn(fsNode, 'writeFile').mockRejectedValueOnce(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
    await expect(writeBin(run, s.token)).rejects.toThrow("The disk is full, so Office couldn't save this file.");
  });

  it('says the file cannot be found when it vanishes between the checks and the translation', async () => {
    const s = await sessionFor(MEMO);
    const vanished = async () => {
      throw Object.assign(new Error(`ENOENT: no such file, open '${s.path}'`), { code: 'ENOENT', path: s.path });
    };
    const run = createOfficeCommands({ root: ROOT, sessions, convert: vanished });
    await expect(run(s.token, 'open_file', {})).rejects.toThrow("Office can't find this file.");
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses to replace a read-only file and leaves it as it was (POSIX, non-root)',
    async () => {
      const s = await sessionFor(MEMO);
      const original = await readFile(s.path);
      await chmod(s.path, 0o444);
      const run = createOfficeCommands({ root: ROOT, sessions, convert: fakeDoc });
      await writeBin(run, s.token);
      await expect(run(s.token, 'save_file', {})).rejects.toThrow("Office doesn't have permission to save this file.");
      expect(await readFile(s.path)).toEqual(original);
    },
  );
});

// Fix round 1 (Task 5 review): closing a document removes its temp folder, so a close must
// wait for a save still queued for it — and, past the cap, that save must give up rather
// than land late.
describe('closing a document while its save is translating', () => {
  it('waits for the save, which still lands, before removing the temp folder', async () => {
    const closable = createSessions(path.join(dir, 'closable'), { drain: (x) => drainSession(x) });
    const file = path.join(dir, 'docs/close.docx');
    await mkdir(path.dirname(file), { recursive: true });
    await copyFile(MEMO, file);
    const s = await closable.open(file, 1);
    // WHY it reads its input after the pause: the real translator reads Editor.bin from the
    // document's temp folder, which is exactly what an early close would remove.
    const slow = async (_r: string, from: string, to: string) => {
      await new Promise((r) => setTimeout(r, 150));
      await writeFile(to, Buffer.concat([Buffer.from('PK\x03\x04'), await readFile(from)]));
    };
    const run = createOfficeCommands({ root: ROOT, sessions: closable, convert: slow });
    await writeBin(run, s.token);
    // Back to back: the save is queued, then the tab closes.
    const saving = run(s.token, 'save_file', {});
    const closing = closable.close(s.token);
    expect(closable.get(s.token)).toBeUndefined(); // no new command can reach it now
    await expect(saving).resolves.toBe('ok');
    await closing;
    expect(await readFile(file)).toEqual(Buffer.from('PK\x03\x04bin'));
    expect(existsSync(s.temp)).toBe(false);
    expect(await tmpsBeside(file)).toEqual([]);
  });

  it("abandons a save still translating past the cap, leaving the user's file untouched", async () => {
    const closable = createSessions(path.join(dir, 'closable'), { drain: (x) => drainSession(x, 50) });
    const file = path.join(dir, 'docs/close.docx');
    await mkdir(path.dirname(file), { recursive: true });
    await copyFile(MEMO, file);
    const original = await readFile(file);
    const s = await closable.open(file, 1);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const translating = new Promise<void>((r) => (entered = r));
    const slow = async (r: string, f: string, to: string) => {
      entered();
      await gate;
      await fakeDoc(r, f, to);
    };
    const run = createOfficeCommands({ root: ROOT, sessions: closable, convert: slow });
    await writeBin(run, s.token);
    const saving = run(s.token, 'save_file', {});
    await translating;
    await closable.close(s.token); // returns once the 50 ms cap has passed
    release();
    await expect(saving).rejects.toThrow('Office is closing.');
    expect(await readFile(file)).toEqual(original);
    expect(await readdir(path.dirname(file))).toEqual(['close.docx']);
  });
});

// Final review, finding 4: a window (or tab) that closes lets go of a save already with main —
// the renderer counts it as saved. The close must then give that save as long as x2t itself
// allows, not 5 s: nothing on screen waits for it, and stopping it would lose those edits.
describe('closing a document whose save is slow (not a quit)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('waits as long as the translator is allowed to run, not just 5 s', () => {
    expect(CLOSE_DRAIN_MS).toBeGreaterThanOrEqual(X2T_TIMEOUT_MS);
  });

  it('lets a save still translating after 10 s land in the file', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const closable = createSessions(path.join(dir, 'closable'), { drain: (x) => drainSession(x) });
    const file = path.join(dir, 'docs/slow.docx');
    await mkdir(path.dirname(file), { recursive: true });
    await copyFile(MEMO, file);
    const s = await closable.open(file, 1);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const translating = new Promise<void>((r) => (entered = r));
    const slow = async (_r: string, from: string, to: string) => {
      entered();
      await gate;
      await writeFile(to, Buffer.concat([Buffer.from('PK\x03\x04'), await readFile(from)]));
    };
    const run = createOfficeCommands({ root: ROOT, sessions: closable, convert: slow });
    await writeBin(run, s.token);
    const saving = run(s.token, 'save_file', {});
    await translating;
    const closing = closable.close(s.token);
    await vi.advanceTimersByTimeAsync(10_000); // well past the old 5 s cap
    release();
    await expect(saving).resolves.toBe('ok');
    await closing;
    expect(await readFile(file)).toEqual(Buffer.from('PK\x03\x04bin'));
  });
});

// Fix round 2 (Task 5 re-review).
describe('re-opening a file while its last tab is closing', () => {
  const PK = Buffer.from('PK\x03\x04');
  // Opening copies the file into Editor.bin as-is; saving writes PK + Editor.bin, held by
  // `gate` so a test decides when the save's translation finishes.
  function translator(gate: Promise<void>) {
    return async (_r: string, from: string, to: string) => {
      if (to.endsWith('Editor.bin')) { await copyFile(from, to); return; }
      await gate;
      await writeFile(to, Buffer.concat([PK, await readFile(from)]));
    };
  }

  for (const reopener of [1, 2]) {
    it(`waits for the closing save, then opens what it saved (${reopener === 1 ? 'same window' : 'another window'})`, async () => {
      const closable = createSessions(path.join(dir, 'closable'), { drain: (x) => drainSession(x) });
      const file = path.join(dir, 'docs/reopen.docx');
      await mkdir(path.dirname(file), { recursive: true });
      await copyFile(MEMO, file);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const run = createOfficeCommands({ root: ROOT, sessions: closable, convert: translator(gate) });
      const first = await closable.open(file, 1);
      await run(first.token, 'write_editor_bin', { data: Buffer.from('edited').toString('base64') });
      const saving = run(first.token, 'save_file', {});
      const closing = closable.close(first.token);
      let reopened: OfficeSession | null = null;
      const reopening = closable.open(file, reopener).then((s) => (reopened = s));
      await new Promise((r) => setTimeout(r, 50));
      expect(reopened).toBeNull(); // still waiting on the close
      release();
      await expect(saving).resolves.toBe('ok');
      await closing;
      const second = await reopening;
      expect(second.token).not.toBe(first.token);
      expect(second.senderId).toBe(reopener);
      const opened = (await run(second.token, 'open_file', {})) as string;
      expect(Buffer.from(opened, 'base64')).toEqual(Buffer.concat([PK, Buffer.from('edited')]));
    });
  }
});

describe('closing a document, round two', () => {
  it("stops that document's translator when the close gives up waiting", async () => {
    const closable = createSessions(path.join(dir, 'closable'), { drain: (x) => drainSession(x, 50) });
    const file = path.join(dir, 'docs/stop.docx');
    await mkdir(path.dirname(file), { recursive: true });
    await copyFile(MEMO, file);
    const s = await closable.open(file, 1);
    let seen: AbortSignal | undefined;
    let entered!: () => void;
    const translating = new Promise<void>((r) => (entered = r));
    // Stands in for x2t: runs until its abort signal fires, as execFile's kill would end it.
    const stoppable = (_r: string, _f: string, _t: string, _fmt: number, _b: string, signal?: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        seen = signal;
        entered();
        signal?.addEventListener('abort', () => reject(new X2tError('x2t failed (stopped)', 'stopped', '')));
      });
    const run = createOfficeCommands({ root: ROOT, sessions: closable, convert: stoppable });
    await writeBin(run, s.token);
    // Caught at once: the abort rejects it while the close is still being awaited.
    const saving = run(s.token, 'save_file', {}).catch((e: Error) => e);
    await translating;
    expect(seen?.aborted).toBe(false);
    await closable.close(s.token);
    expect(seen?.aborted).toBe(true);
    expect(((await saving) as Error).message).toBe('Office is closing.');
  });

  it('runs a write and a save queued unawaited just before the close, and the save lands', async () => {
    const closable = createSessions(path.join(dir, 'closable'), { drain: (x) => drainSession(x) });
    const file = path.join(dir, 'docs/late.docx');
    await mkdir(path.dirname(file), { recursive: true });
    await copyFile(MEMO, file);
    const s = await closable.open(file, 1);
    const copyOut = async (_r: string, from: string, to: string) => {
      await writeFile(to, Buffer.concat([Buffer.from('PK\x03\x04'), await readFile(from)]));
    };
    const run = createOfficeCommands({ root: ROOT, sessions: closable, convert: copyOut });
    const writing = run(s.token, 'write_editor_bin', { data: Buffer.from('last words').toString('base64') });
    const saving = run(s.token, 'save_file', {});
    await closable.close(s.token);
    await expect(writing).resolves.toBe('ok');
    await expect(saving).resolves.toBe('ok');
    expect(await readFile(file)).toEqual(Buffer.from('PK\x03\x04last words'));
  });
});

// "Save a copy…" (the owner's decision for a save that keeps failing): the edits go to a new
// file through the same safe path as a save, and the original is never touched.
describe.skipIf(!HAS_ADDON)('saving a copy when the file itself cannot be saved', () => {
  beforeAll(async () => {
    const warm = await mkdtemp(path.join(tmpdir(), 'office-copy-warm-'));
    await convert(ROOT, MEMO, path.join(warm, 'Editor.bin'), FORMAT.bin, warm);
    await rm(warm, { recursive: true, force: true });
  }, X2T_WARMUP_BUDGET_MS);

  /** The edited document (NOTICE's content) handed to a session of a read-only MEMO. */
  async function failedSaveOfReadOnly() {
    const s = await sessionFor(MEMO);
    const run = createOfficeCommands({ root: ROOT, sessions });
    await run(s.token, 'open_file', {});
    const bDir = path.join(dir, 'b');
    await mkdir(bDir, { recursive: true });
    await convert(ROOT, NOTICE, path.join(bDir, 'Editor.bin'), FORMAT.bin, bDir);
    await run(s.token, 'write_editor_bin', { data: (await readFile(path.join(bDir, 'Editor.bin'))).toString('base64') });
    await chmod(s.path, 0o444);
    await expect(run(s.token, 'save_file', {})).rejects.toThrow();
    return { s, run };
  }

  it('writes the edits to the chosen file and leaves the read-only original untouched', async () => {
    const { s, run } = await failedSaveOfReadOnly();
    const original = await readFile(s.path);
    expect(run.canCopy(s.token)).toBe(true);
    const target = path.join(dir, 'copies', 'memo (copy).docx');
    await mkdir(path.dirname(target), { recursive: true });
    await run.saveCopy(s.token, target);
    expect(await readFile(s.path)).toEqual(original);
    expect(await textOf(target)).toBe(await textOf(NOTICE));
    expect(await readdir(path.dirname(target))).toEqual(['memo (copy).docx']);
    await chmod(s.path, 0o644);
  });

  it('writes the copy again only when the editor handed over new bytes since', async () => {
    const { s, run } = await failedSaveOfReadOnly();
    const target = path.join(dir, 'copies', 'memo (copy).docx');
    await mkdir(path.dirname(target), { recursive: true });
    await run.saveCopy(s.token, target);
    await expect(run.saveCopyAgain(s.token)).resolves.toEqual({ target, unchanged: true });
    // Typing during the copy: the editor's newest bytes are the memo's own content.
    const warm = path.join(dir, 'm');
    await mkdir(warm, { recursive: true });
    await convert(ROOT, MEMO, path.join(warm, 'Editor.bin'), FORMAT.bin, warm);
    await run(s.token, 'write_editor_bin', { data: (await readFile(path.join(warm, 'Editor.bin'))).toString('base64') });
    await expect(run.saveCopyAgain(s.token)).resolves.toEqual({ target, unchanged: false });
    expect(await textOf(target)).toBe(await textOf(MEMO));
    await chmod(s.path, 0o644);
  });

  it('refuses a copy onto a file open in Office — in any session, however it is named', async () => {
    const { s, run } = await failedSaveOfReadOnly();
    const other = await sessionFor(NOTICE, 'elsewhere/notice.docx'); // open in another tab/window
    await expect(run.saveCopy(s.token, other.path)).rejects.toThrow('That file is open in Office. Close it or choose another name.');
    // The same file through a link is the same file.
    const link = path.join(dir, 'link-to-notice.docx');
    await symlink(other.path, link);
    await expect(run.saveCopy(s.token, link)).rejects.toThrow('That file is open in Office. Close it or choose another name.');
    await chmod(s.path, 0o644);
  });

  it('refuses to write the copy again when the last hand-over of the edits failed', async () => {
    const { s, run } = await failedSaveOfReadOnly();
    const target = path.join(dir, 'copies', 'memo (copy).docx');
    await mkdir(path.dirname(target), { recursive: true });
    await run.saveCopy(s.token, target);
    const before = await readFile(target);
    vi.spyOn(fsNode, 'writeFile').mockRejectedValueOnce(Object.assign(new Error('full'), { code: 'ENOSPC' }));
    await expect(run(s.token, 'write_editor_bin', { data: Buffer.from('newer').toString('base64') })).rejects.toThrow();
    await expect(run.saveCopyAgain(s.token)).rejects.toThrow('There are no changes to save a copy of yet.');
    expect(await readFile(target)).toEqual(before);
    await chmod(s.path, 0o644);
  });

  it('refuses to "copy" over the original itself', async () => {
    const { s, run } = await failedSaveOfReadOnly();
    await expect(run.saveCopy(s.token, s.path)).rejects.toThrow("Office can't save a copy there. Choose another folder.");
    await chmod(s.path, 0o644);
  });

  it('is not offered when the save failed in the translation itself', async () => {
    const s = await sessionFor(MEMO);
    const failing = async () => { throw new X2tError('x2t failed (1)', 1, 'boom'); };
    const run = createOfficeCommands({ root: ROOT, sessions, convert: failing as never });
    await run(s.token, 'write_editor_bin', { data: Buffer.from('bin').toString('base64') });
    await expect(run(s.token, 'save_file', {})).rejects.toThrow();
    expect(run.canCopy(s.token)).toBe(false);
  });

  it('is not offered before the editor has handed over any edited copy', async () => {
    const s = await sessionFor(MEMO);
    const run = createOfficeCommands({ root: ROOT, sessions });
    await run(s.token, 'open_file', {});
    expect(run.canCopy(s.token)).toBe(false);
  });
});

// Save As / Download as / Export to PDF (finish plan Task 2): the editor's save-as writes a
// separate file through the same safe path as "Save a copy"; the open document, its session and
// its autosave stay on the file the person opened.
describe('Save As writes a separate file and leaves the document on its own', () => {
  /** A session whose editor has just handed over its edits (bridge.js's first Save As step). */
  async function editedSession(convert: Parameters<typeof createOfficeCommands>[0]['convert'] = fakeDoc) {
    const s = await sessionFor(MEMO);
    const run = createOfficeCommands({ root: ROOT, sessions, convert });
    await run(s.token, 'write_editor_bin', { data: Buffer.from('edited').toString('base64') });
    return { s, run };
  }
  const pdfOut = async (_r: string, _f: string, to: string) => { await writeFile(to, '%PDF-1.7 fake'); };

  it('is one of the editor commands', () => {
    expect(OFFICE_COMMANDS.has('save_dialog')).toBe(true);
    expect(OFFICE_COMMANDS.has('save_file_as')).toBe(true);
  });

  it('writes the copy, leaves the original untouched, and the session stays on the original', async () => {
    const { s, run } = await editedSession();
    const original = await readFile(s.path);
    const target = path.join(dir, 'out', 'memo 2.docx');
    await mkdir(path.dirname(target), { recursive: true });
    await run.saveAs(s.token, target);
    expect((await readFile(target)).subarray(0, 4).toString('latin1')).toBe('PK\x03\x04');
    expect(await readFile(s.path)).toEqual(original);
    expect(sessions.get(s.token)?.path).toBe(s.path);
    expect(await readdir(path.dirname(target))).toEqual(['memo 2.docx']);
  });

  it('asks x2t for the format the chosen name ends in, and checks the output is that kind of file', async () => {
    const asked: number[] = [];
    const { s, run } = await editedSession(async (r, f, to, fmt) => { asked.push(fmt); await pdfOut(r, f, to); });
    const target = path.join(dir, 'memo.pdf');
    await run.saveAs(s.token, target);
    expect(asked).toEqual([FORMAT.pdf]);
    expect((await readFile(target)).toString('latin1')).toBe('%PDF-1.7 fake');
    // A "PDF" that is not one is never put in place.
    const { s: s2, run: run2 } = await editedSession(fakeDoc);
    await expect(run2.saveAs(s2.token, path.join(dir, 'bad.pdf'))).rejects.toThrow("Office couldn't save this file.");
    expect(existsSync(path.join(dir, 'bad.pdf'))).toBe(false);
  });

  // Task 2 fix round 1: the editor's CSV and PDF choices reach x2t — checked (x2t.ts exportParams).
  it("hands x2t the editor's checked export choices, and nothing for a format that takes none", async () => {
    const seen: unknown[] = [];
    const csvOut = async (_r: string, _f: string, to: string, _fmt: number, _t: string, _s?: AbortSignal, extra?: unknown) => { seen.push(extra); await writeFile(to, to.endsWith('.csv') ? 'a;b\n' : 'PK\x03\x04zip'); };
    const s = await sessionFor(path.join(ROOT, 'templates', 'blank.xlsx'), 'docs/sheet.xlsx');
    const run = createOfficeCommands({ root: ROOT, sessions, convert: csvOut as never });
    await run(s.token, 'write_editor_bin', { data: Buffer.from('edited').toString('base64') });
    await run.saveAs(s.token, path.join(dir, 'sheet.csv'), { text: { codePage: 44, delimiter: [2], delimiterChar: null } });
    expect(seen[0]).toEqual({ allFontsPath: undefined, params: { csvEncoding: 44, csvDelimiter: 2 } });
    await run.saveAs(s.token, path.join(dir, 'sheet.xlsx'), { text: { codePage: 44, delimiter: [2] } });
    expect(seen[1]).toEqual({ allFontsPath: undefined, params: {} });
  });

  it("refuses another kind's format, and a name without a format", async () => {
    const { s, run } = await editedSession();
    await expect(run.saveAs(s.token, path.join(dir, 'memo.xlsx'))).rejects.toThrow("Office can't save this kind of file.");
    await expect(run.saveAs(s.token, path.join(dir, 'memo'))).rejects.toThrow("Office can't save this kind of file.");
  });

  it('refuses a protected folder', async () => {
    const { s, run } = await editedSession();
    await mkdir(path.join(dir, 'repo', '.git'), { recursive: true });
    await expect(run.saveAs(s.token, path.join(dir, 'repo', '.git', 'memo.docx'))).rejects.toThrow("Office can't save a copy there. Choose another folder.");
    expect(await readdir(path.join(dir, 'repo', '.git'))).toEqual([]);
  });

  it('refuses the original itself and any file open in Office', async () => {
    const { s, run } = await editedSession();
    await expect(run.saveAs(s.token, s.path)).rejects.toThrow("That's the file you're editing. Choose another name.");
    const other = await sessionFor(NOTICE, 'elsewhere/notice.docx');
    await expect(run.saveAs(s.token, other.path)).rejects.toThrow('That file is open in Office. Close it or choose another name.');
  });

  it('does not change what "Save a copy again" would write', async () => {
    const { s, run } = await editedSession();
    await run.saveAs(s.token, path.join(dir, 'exported.docx'));
    await expect(run.saveCopyAgain(s.token)).resolves.toBeNull();
  });

  it('never answers with a path', async () => {
    const { s, run } = await editedSession(async () => { throw Object.assign(new Error(`EACCES: permission denied, open '${dir}/x'`), { code: 'EACCES' }); });
    const err = await run.saveAs(s.token, path.join(dir, 'x.docx')).catch((e: Error) => e);
    expect(String(err)).not.toContain(dir);
  });
});

describe.skipIf(!HAS_ADDON)('Save As with the bundled x2t, to every format each kind offers', () => {
  const TEMPLATES = path.join(ROOT, 'templates');
  const HEAD: Record<string, string> = { docx: 'PK\x03\x04', odt: 'PK\x03\x04', xlsx: 'PK\x03\x04', ods: 'PK\x03\x04', pptx: 'PK\x03\x04', odp: 'PK\x03\x04', pdf: '%PDF', rtf: '{\\rt' };

  async function exportAll(src: string, rel: string, exts: string[]) {
    const s = await sessionFor(src, rel);
    const run = createOfficeCommands({ root: ROOT, sessions });
    // The editor form of the file itself stands in for the editor's edits.
    await run(s.token, 'open_file', {});
    const bin = (await readFile(path.join(s.temp, 'Editor.bin'))).toString('base64');
    await run(s.token, 'write_editor_bin', { data: bin });
    const before = await readFile(s.path);
    for (const ext of exts) {
      const target = path.join(dir, 'exports', `out.${ext}`);
      await mkdir(path.dirname(target), { recursive: true });
      await run.saveAs(s.token, target);
      const head = (await readFile(target)).subarray(0, 4).toString('latin1');
      if (HEAD[ext]) expect(head, ext).toBe(HEAD[ext]);
      else expect((await stat(target)).size, ext).toBeGreaterThan(0);
    }
    expect(await readFile(s.path)).toEqual(before);
    return s;
  }

  it('a document: docx, odt, rtf, txt and pdf', async () => {
    await exportAll(NOTICE, 'docs/notice.docx', ['docx', 'odt', 'rtf', 'txt', 'pdf']);
    expect((await readFile(path.join(dir, 'exports', 'out.txt'), 'utf8')).length).toBeGreaterThan(0);
  }, X2T_WARMUP_BUDGET_MS);

  it('a spreadsheet: xlsx, ods, csv and pdf', async () => {
    await exportAll(path.join(TEMPLATES, 'blank.xlsx'), 'docs/sheet.xlsx', ['xlsx', 'ods', 'csv', 'pdf']);
  }, X2T_WARMUP_BUDGET_MS);

  it('a CSV in the encoding and with the delimiter the editor chose', async () => {
    const s = await sessionFor(fileURLToPath(new URL('./fixtures/ledger.xlsx', import.meta.url)), 'docs/ledger.xlsx');
    const run = createOfficeCommands({ root: ROOT, sessions });
    await run(s.token, 'open_file', {});
    await run(s.token, 'write_editor_bin', { data: (await readFile(path.join(s.temp, 'Editor.bin'))).toString('base64') });
    const target = path.join(dir, 'ledger.csv');
    await run.saveAs(s.token, target, { text: { codePage: 44, delimiter: [2], delimiterChar: null } });
    const bytes = await readFile(target);
    expect(bytes.subarray(0, 12).toString('latin1')).toBe('City;Amount;');
    expect(bytes.includes(Buffer.from('Z\xfcrich', 'latin1'))).toBe(true);
  }, X2T_WARMUP_BUDGET_MS);

  it('a presentation: pptx, odp and pdf', async () => {
    await exportAll(path.join(TEMPLATES, 'blank.pptx'), 'docs/slides.pptx', ['pptx', 'odp', 'pdf']);
  }, X2T_WARMUP_BUDGET_MS);
});

// Print (finish plan Task 3): the PDF the print window shows.
describe.skipIf(!HAS_ADDON)('the PDF made for printing, with the bundled x2t', () => {
  const PAGES = fileURLToPath(new URL('./fixtures/pages.docx', import.meta.url));
  const pageCount = async (file: string) => ((await readFile(file)).toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;

  it('is the whole document by default, only the chosen pages when asked, and in Office\'s temp, not beside the file', async () => {
    const s = await sessionFor(PAGES, 'docs/pages.docx');
    const run = createOfficeCommands({ root: ROOT, sessions });
    await run(s.token, 'open_file', {});
    await run(s.token, 'write_editor_bin', { data: (await readFile(path.join(s.temp, 'Editor.bin'))).toString('base64') });
    const whole = await run.printPdf(s.token);
    expect(path.basename(whole.file)).toBe('pages.pdf');
    expect(path.dirname(path.dirname(whole.file))).toBe(path.dirname(s.temp));
    expect((await readFile(whole.file)).subarray(0, 4).toString('latin1')).toBe('%PDF');
    const all = await pageCount(whole.file);
    expect(all).toBeGreaterThan(2);
    const two = await run.printPdf(s.token, JSON.stringify({ nativeOptions: { pages: '2-3' } }));
    expect(await pageCount(two.file)).toBe(2);
    await whole.dispose();
    await two.dispose();
    expect(existsSync(path.dirname(whole.file))).toBe(false);
    expect((await readdir(path.dirname(s.path))).sort()).toEqual(['pages.docx']);
  }, X2T_WARMUP_BUDGET_MS);
});
