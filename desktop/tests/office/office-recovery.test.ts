// Crash recovery (finish plan Task 8): every batch of edits the editor sends reaches a journal, and
// the next open of the file gets back whatever its file never got — after a crash, a kill, or a
// window closed before its last save. What these pin is the no-lost-work guarantee the removed
// close/quit save handshake used to give, now given by the journal.
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/main/artifacts/project-watcher', () => ({ noteOwnWrite: vi.fn() }));

import { createOfficeCommands, drainSession } from '../../src/main/office/office-commands';
import { RECOVERY_MAX_AGE_MS, discardRecoveryFor, keepRecoveryIn, offerRecovery, pruneRecovery, resetRecoveryForTests } from '../../src/main/office/office-recovery';
import { createSessions } from '../../src/main/office/office-sessions';

const MEMO = fileURLToPath(new URL('./fixtures/memo.docx', import.meta.url));

let dir: string;
let file: string;
let sessions: ReturnType<typeof createSessions>;
// A stand-in translator: the "editor form" is the file's bytes, and a save writes them back.
const convert = vi.fn(async (_root: string, src: string, dst: string) => { await fsp.copyFile(src, dst); });
const journals = () => path.join(dir, 'userData', 'office-recovery');

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(tmpdir(), 'office-recovery-test-'));
  file = path.join(dir, 'docs', 'plan.docx');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.copyFile(MEMO, file);
  sessions = createSessions(path.join(dir, 'base'), { drain: (s) => drainSession(s, 1_000) });
  keepRecoveryIn(path.join(dir, 'userData'));
});
afterEach(async () => {
  resetRecoveryForTests();
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** An editor that opened `file` in a fresh session (as the window does), with its command runner. */
async function editor() {
  const s = await sessions.open(file, 1);
  const run = createOfficeCommands({ root: dir, sessions, convert: convert as never });
  const opened = (await run(s.token, 'open_file', {})) as string;
  await run(s.token, 'recovery_begin', { docType: 'word', name: 'ignored', path: '/somewhere/else.docx', data: 'ignored' });
  return { s, run, opened };
}
const settle = () => new Promise((r) => setTimeout(r, 30));
// WHY wait for the journal's change log, not a fixed 30 ms (2026-10-09): it is written after the
// call returns, and at load average ~45 that took longer — readdir threw ENOENT, or the folder
// existed with no log yet, in full runs while the file passed alone. Returns as soon as a
// journal holds a non-empty changes.log; gives up after 5 s and lets the test's own check fail.
async function journalWritten(): Promise<void> {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const dirs = await fsp.readdir(journals()).catch(() => [] as string[]);
    for (const d of dirs) {
      const size = await fsp.stat(path.join(journals(), d, 'changes.log')).then((st) => st.size, () => 0);
      if (size > 0) return;
    }
    await settle();
  }
}

describe('the recovery journal', () => {
  it('a window closed before its save: the next open gets the opened document and every edit back', async () => {
    const a = await editor();
    await a.run(a.s.token, 'save_changes', { changes: ['c1', 'c2'], deleteIndex: null, count: 2 });
    await a.run(a.s.token, 'save_changes', { changes: ['c3'], deleteIndex: null, count: 1 });
    // An undo of c3 and a different edit instead (sdkjs sends where its list now ends).
    await a.run(a.s.token, 'save_changes', { changes: ['c3b'], deleteIndex: 2, count: 1 });
    await sessions.close(a.s.token); // the window went: nothing was saved
    const b = await editor0();
    const list = (await b.run(b.s.token, 'recovery_candidates', {})) as Array<{ id: string; name: string }>;
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('plan.docx');
    expect(JSON.stringify(list)).not.toContain(path.dirname(file)); // never a folder
    const r = (await b.run(b.s.token, 'recovery_load', { id: list[0].id })) as { data: string; changes: string[]; path: string; outsideChange: boolean };
    expect(r.changes).toEqual(['c1', 'c2', 'c3b']);
    expect(Buffer.from(r.data, 'base64')).toEqual(Buffer.from(a.opened, 'base64'));
    expect(r.path).toBe('plan.docx');
    expect(r.outsideChange).toBe(false);
    // The editor of the new session reads its starting point from its own temp folder.
    expect(await fsp.readFile(path.join(b.s.temp, 'Editor.bin'))).toEqual(Buffer.from(a.opened, 'base64'));
  });

  it('a save that holds every edit leaves nothing to recover, and closing removes the journal', async () => {
    const a = await editor();
    await a.run(a.s.token, 'save_changes', { changes: ['c1'], deleteIndex: null, count: 1 });
    await a.run(a.s.token, 'save_changes', { changes: [], deleteIndex: 1, count: 0 }); // the save's own marker
    await a.run(a.s.token, 'write_editor_bin', { data: a.opened });
    await a.run(a.s.token, 'save_file', {});
    await settle();
    expect(await fsp.readdir(journals())).toHaveLength(1);
    await sessions.close(a.s.token);
    expect(await fsp.readdir(journals())).toHaveLength(0);
    const b = await editor0();
    expect(await b.run(b.s.token, 'recovery_candidates', {})).toEqual([]);
  });

  // Final review fix 2, item 1: a window that is not the last one closes without the unsaved
  // prompt. Its editors start their save as the close begins; main gets the save's commands before
  // the window goes, and the close still lets that save land in the FILE — then the journal goes.
  it('a save started as its window closes lands in the file, and then the journal is removed', async () => {
    const a = await editor();
    const newer = Buffer.concat([Buffer.from(a.opened, 'base64'), Buffer.from('typed just before closing')]);
    await a.run(a.s.token, 'save_changes', { changes: ['typed just before closing'], deleteIndex: null, count: 1 });
    let release!: () => void;
    // WHY a signal, not settle() (desktop-test-build run 36992142223, windows-latest): a slow
    // runner had not reached the translation 30 ms in, so `release` was still unset — and the
    // unused one-off translation then hung the next test. Wait until it is really running.
    let reached!: () => void;
    const translating = new Promise<void>((r) => (reached = r));
    convert.mockImplementationOnce(async (_root: string, src: string, dst: string) => {
      reached();
      await new Promise<void>((r) => (release = r)); // a translation still running as the window goes
      await fsp.copyFile(src, dst);
    });
    void a.run(a.s.token, 'write_editor_bin', { data: newer.toString('base64') });
    const saved = a.run(a.s.token, 'save_file', {});
    const closed = sessions.closeAllFor(1); // the window is gone
    await translating;
    release();
    await saved;
    await closed;
    expect(await fsp.readFile(file)).toEqual(newer);
    expect(await fsp.readdir(journals())).toHaveLength(0);
  });

  it('edits made after a save took its bytes are still offered (typing during a save)', async () => {
    const a = await editor();
    await a.run(a.s.token, 'save_changes', { changes: ['c1'], deleteIndex: null, count: 1 });
    const bytes = a.run(a.s.token, 'write_editor_bin', { data: a.opened });
    await a.run(a.s.token, 'save_changes', { changes: ['typed during the save'], deleteIndex: null, count: 1 });
    await bytes;
    await a.run(a.s.token, 'save_file', {});
    await sessions.close(a.s.token);
    const b = await editor0();
    const [c] = (await b.run(b.s.token, 'recovery_candidates', {})) as Array<{ id: string }>;
    const r = (await b.run(b.s.token, 'recovery_load', { id: c.id })) as { changes: string[] };
    expect(r.changes).toEqual(['c1', 'typed during the save']);
  });

  it("keeps the editor's starting point even after a save replaced the session's Editor.bin", async () => {
    const a = await editor();
    await a.run(a.s.token, 'save_changes', { changes: ['c1'], deleteIndex: null, count: 1 });
    await a.run(a.s.token, 'write_editor_bin', { data: Buffer.from('PK\x03\x04newer').toString('base64') });
    await a.run(a.s.token, 'save_changes', { changes: ['c2'], deleteIndex: null, count: 1 });
    await sessions.close(a.s.token);
    const b = await editor0();
    const [c] = (await b.run(b.s.token, 'recovery_candidates', {})) as Array<{ id: string }>;
    const r = (await b.run(b.s.token, 'recovery_load', { id: c.id })) as { data: string; changes: string[] };
    expect(Buffer.from(r.data, 'base64')).toEqual(Buffer.from(a.opened, 'base64'));
    expect(r.changes).toEqual(['c1', 'c2']);
  });

  it('writes nothing for a document that was only read, and keeps its folder private', async () => {
    const a = await editor();
    await settle();
    await expect(fsp.readdir(journals())).rejects.toThrow(); // no folder at all
    await a.run(a.s.token, 'save_changes', { changes: ['c1'], deleteIndex: null, count: 1 });
    await journalWritten(); // WHY: see journalWritten
    const [name] = await fsp.readdir(journals());
    expect(name).not.toContain('plan');
    // WHY POSIX only: Windows has no group/other permission bits (its mode always reads 0o666).
    if (process.platform !== 'win32') expect((await fsp.stat(path.join(journals(), name))).mode & 0o077).toBe(0);
  });

  it('a discard (Close without saving, Discard and quit) is never offered back', async () => {
    const a = await editor();
    await a.run(a.s.token, 'save_changes', { changes: ['c1'], deleteIndex: null, count: 1 });
    await a.run(a.s.token, 'recovery_discard', {});
    await sessions.close(a.s.token);
    const b = await editor0();
    expect(await b.run(b.s.token, 'recovery_candidates', {})).toEqual([]);
  });

  it('a recovered document goes on in the same journal, and its next save clears it', async () => {
    const a = await editor();
    await a.run(a.s.token, 'save_changes', { changes: ['c1'], deleteIndex: null, count: 1 });
    await sessions.close(a.s.token);
    const b = await editor0();
    const [c] = (await b.run(b.s.token, 'recovery_candidates', {})) as Array<{ id: string }>;
    await b.run(b.s.token, 'recovery_load', { id: c.id });
    await b.run(b.s.token, 'save_changes', { changes: ['c2x'], deleteIndex: null, count: 1 });
    // The recovered editor numbers its own edits from 0 (measured): this trims c2x, never c1.
    await b.run(b.s.token, 'save_changes', { changes: ['c2'], deleteIndex: 0, count: 1 });
    await sessions.close(b.s.token); // crashed again before saving
    const c2 = await editor0();
    const [again] = (await c2.run(c2.s.token, 'recovery_candidates', {})) as Array<{ id: string }>;
    const r = (await c2.run(c2.s.token, 'recovery_load', { id: again.id })) as { data: string; changes: string[] };
    expect(r.changes).toEqual(['c1', 'c2']);
    await c2.run(c2.s.token, 'write_editor_bin', { data: r.data });
    await c2.run(c2.s.token, 'save_file', {});
    await sessions.close(c2.s.token);
    expect(await fsp.readdir(journals())).toHaveLength(0);
  });

  it('a file changed outside Office since: its edits are set aside at open and offered, never replayed on their own', async () => {
    const a = await editor();
    await a.run(a.s.token, 'save_changes', { changes: ['c1'], deleteIndex: null, count: 1 });
    await settle();
    await sessions.close(a.s.token);
    await fsp.appendFile(file, 'changed elsewhere');
    expect(await offerRecovery(file)).toBe(true); // office:open asks this before the editor starts
    const b = await editor(); // so the editor opens the file as it is, and journals afresh
    expect(await b.run(b.s.token, 'recovery_candidates', {})).toEqual([]);
    await b.run(b.s.token, 'save_changes', { changes: ['typed meanwhile'], deleteIndex: null, count: 1 });
    expect(await offerRecovery(file)).toBe(true); // still offered until the person answers
    // Recover: the kept edits come back; reopening replays them over the file as it was.
    expect(await b.run(b.s.token, 'recovery_accept_held', {})).toBe(true);
    await sessions.close(b.s.token);
    const onOpened = vi.fn(async () => {});
    const s = await sessions.open(file, 1);
    const run = createOfficeCommands({ root: dir, sessions, convert: convert as never, onOpened });
    expect(await offerRecovery(file)).toBe(false);
    const [c] = (await run(s.token, 'recovery_candidates', {})) as Array<{ id: string }>;
    const r = (await run(s.token, 'recovery_load', { id: c.id })) as { changes: string[]; outsideChange: boolean };
    expect(r.changes).toEqual(['c1']);
    expect(r.outsideChange).toBe(true); // the strip says the file's own version is in Versions
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  it('Discard on the offer drops the kept edits', async () => {
    const a = await editor();
    await a.run(a.s.token, 'save_changes', { changes: ['c1'], deleteIndex: null, count: 1 });
    await settle();
    await sessions.close(a.s.token);
    await fsp.appendFile(file, 'changed elsewhere');
    expect(await offerRecovery(file)).toBe(true);
    const b = await editor0();
    await b.run(b.s.token, 'recovery_discard_held', {});
    expect(await offerRecovery(file)).toBe(false);
  });

  it('an unchanged file is not offered: its edits replay at open', async () => {
    const a = await editor();
    await a.run(a.s.token, 'save_changes', { changes: ['c1'], deleteIndex: null, count: 1 });
    await sessions.close(a.s.token);
    expect(await offerRecovery(file)).toBe(false);
    const b = await editor0();
    expect(await b.run(b.s.token, 'recovery_candidates', {})).toHaveLength(1);
  });

  it('a restore drops the journal kept against the old content', async () => {
    const a = await editor();
    await a.run(a.s.token, 'save_changes', { changes: ['c1'], deleteIndex: null, count: 1 });
    await sessions.close(a.s.token);
    await discardRecoveryFor(file);
    const b = await editor0();
    expect(await b.run(b.s.token, 'recovery_candidates', {})).toEqual([]);
  });

  it('the startup tidy-up removes journals of files that are gone, and ones untouched for 30 days', async () => {
    const a = await editor();
    await a.run(a.s.token, 'save_changes', { changes: ['c1'], deleteIndex: null, count: 1 });
    await sessions.close(a.s.token);
    await pruneRecovery();
    expect(await fsp.readdir(journals())).toHaveLength(1); // a fresh journal of a file that exists stays
    await pruneRecovery(Date.now() + RECOVERY_MAX_AGE_MS + 1);
    expect(await fsp.readdir(journals())).toHaveLength(0);
    const b = await editor();
    await b.run(b.s.token, 'save_changes', { changes: ['c2'], deleteIndex: null, count: 1 });
    await sessions.close(b.s.token);
    await fsp.rm(file);
    await pruneRecovery();
    expect(await fsp.readdir(journals())).toHaveLength(0);
  });

  it('skips a last line cut short by a crash, and refuses another document\'s id', async () => {
    const a = await editor();
    await a.run(a.s.token, 'save_changes', { changes: ['c1'], deleteIndex: null, count: 1 });
    await journalWritten(); // WHY: see journalWritten
    const [name] = await fsp.readdir(journals());
    await fsp.appendFile(path.join(journals(), name, 'changes.log'), '[null,["c2"');
    await sessions.close(a.s.token);
    const b = await editor0();
    await expect(b.run(b.s.token, 'recovery_load', { id: 'f'.repeat(32) })).rejects.toThrow();
    const [c] = (await b.run(b.s.token, 'recovery_candidates', {})) as Array<{ id: string }>;
    const r = (await b.run(b.s.token, 'recovery_load', { id: c.id })) as { changes: string[] };
    expect(r.changes).toEqual(['c1']);
  });

  it('refuses a malformed batch rather than journal it', async () => {
    const a = await editor();
    await expect(a.run(a.s.token, 'save_changes', { changes: [1, 2] })).rejects.toThrow();
    await expect(a.run(a.s.token, 'save_changes', { changes: ['x'], deleteIndex: 'no' })).rejects.toThrow();
  });
});

/** A second editor on the same file that has NOT begun yet: it asks for candidates first. */
async function editor0() {
  const s = await sessions.open(file, 1);
  const run = createOfficeCommands({ root: dir, sessions, convert: convert as never });
  return { s, run };
}
