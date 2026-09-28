import { existsSync, promises as fsNode } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, open, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// WHY mocked: the real watcher module pulls in chokidar and the artifact store; this test only
// needs to know the save told it "this write was ours".
vi.mock('../../src/main/artifacts/project-watcher', () => ({ noteOwnWrite: vi.fn() }));

import { noteOwnWrite } from '../../src/main/artifacts/project-watcher';
import { awaitIdle, createOfficeCommands, drainSession, OFFICE_COMMANDS } from '../../src/main/office/office-commands';
import { createSessions, type OfficeSession } from '../../src/main/office/office-sessions';
import { convert, FORMAT, X2tError } from '../../src/main/office/x2t';
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
    // Nothing else may decode the payload (logging a refusal may use Buffer.from on its own text).
    expect(from.mock.calls.filter((c) => (c as unknown[])[1] === 'base64')).toEqual([]);
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
