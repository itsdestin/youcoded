import { constants as fsc, promises as fsp } from 'node:fs';
import path from 'node:path';
import { EDITOR_BIN_MAX_BYTES, OFFICE_MAX_BYTES } from '../../shared/office-types';
import { renameReplacing } from '../artifacts/cas-write';
import { noteOwnWrite } from '../artifacts/project-watcher';
import { authorizeArtifactWrite } from '../artifacts/write-authorization';
import { log } from '../logger';
import type { createSessions, OfficeSession } from './office-sessions';
import { convert as realConvert, FORMAT, formatFor, X2tError } from './x2t';

// The editor (Euro-Office's desktop bridge) asks its host for these by name. Exactly the set
// the spike answered (main2.cjs); anything else is refused before it reaches a handler.
export const OFFICE_COMMANDS: ReadonlySet<string> = new Set([
  'js_log', 'get_current_path', 'set_window_title', 'set_document_modified', 'recent_files_state',
  'set_recent_files_enabled', 'clear_recent_files', 'get_system_fonts', 'list_user_dictionaries', 'recovery_begin',
  'recovery_end', 'recovery_mark_saved', 'recovery_candidates', 'recovery_load', 'recovery_discard', 'open_file',
  'write_editor_bin', 'save_file', 'save_changes', 'convert_for_insert', 'force_close',
]);

const MSG = {
  tooLarge: "This file is larger than 200 MB, which Office can't open.",
  protected: "Office can't open files in this protected folder.",
  needsConfirm: "Office can't open settings files like this one yet.",
  notFound: "Office can't find this file.",
  unsupportedOpen: "Office can't open this kind of file.",
  unsupportedSave: "Office can't save this kind of file.",
  notADocument: "Office couldn't save this file.",
  binTooLarge: 'This document has grown too large for Office to save.',
  closing: 'Office is closing.',
  refused: 'refused',
} as const;

// WHY a marker class (fix round 1): only messages written here, for a person to read, may
// cross to the editor. Anything else — an fs error naming a path, x2t's stderr — is logged and
// replaced at the command boundary (toEditorError below).
class OfficeUserError extends Error {
  /** A quiet error is expected (quit in progress) and not logged as a failure. */
  quiet: boolean;
  constructor(message: string, quiet = false) {
    super(message);
    this.quiet = quiet;
  }
}
const userError = (m: string, quiet = false) => new OfficeUserError(m, quiet);

// ── Quit (fix round 1) ──
// WHY: once quit starts removing the session temp folders, a command must not start work
// against them, and a save still translating when quit stops waiting must not replace the
// user's file with whatever it manages to finish — it abandons its copy instead.
let closing = false;

/** Called by quitOfficeSessions() just before the temp folders are removed. */
export function stopOfficeCommands(): void {
  closing = true;
}

// ── One command at a time per document (review P1-2; design §3 "one save in flight") ──
// WHY a queue: without it, write_editor_bin from a second save could replace Editor.bin while
// x2t is still reading it for the first — the saved file would be a mix of two versions, or
// unreadable. Every command for a session runs through its own promise chain.
//
// WHY a WeakMap here and not fields on OfficeSession: the queue is this module's private
// bookkeeping; no other module should read or reset it, and a closed session's entry is
// garbage-collected with the session itself.
interface SessionQueue {
  tail: Promise<unknown>;
  /** A save that is queued but has not started yet — later saves join it (see save below). */
  pendingSave: Promise<unknown> | null;
}
const queues = new WeakMap<OfficeSession, SessionQueue>();
// Every queued command, across all sessions, until it settles — what awaitIdle() waits for.
const inflight = new Set<Promise<unknown>>();

function queueOf(s: OfficeSession): SessionQueue {
  let q = queues.get(s);
  if (!q) {
    q = { tail: Promise.resolve(), pendingSave: null };
    queues.set(s, q);
  }
  return q;
}

function enqueue<T>(s: OfficeSession, run: () => Promise<T>): Promise<T> {
  const q = queueOf(s);
  // WHY re-check closing when the command's turn comes: it may have been queued before quit
  // started and would otherwise run against a temp folder that is being removed.
  const guarded = () => (closing ? Promise.reject(userError(MSG.closing, true)) : run());
  // WHY run on both fulfil and reject: one failed command must not wedge the document's queue.
  const p = q.tail.then(guarded, guarded);
  q.tail = p.catch(() => undefined);
  inflight.add(p);
  const done = () => void inflight.delete(p);
  p.then(done, done);
  return p;
}

/**
 * Resolves once every document's queued commands have finished. WHY (Task 3 review
 * carry-over): at quit, cleanupOfficeSessions() removes every session's temp folder — and with
 * it the Editor.bin a save in flight is still translating. Quit waits on this (capped) first.
 */
export async function awaitIdle(): Promise<void> {
  // WHY a loop: a command that finishes can have been followed by another already queued.
  while (inflight.size > 0) await Promise.allSettled([...inflight]);
}

// WHY map at the boundary (fix round 1; docs/error-message-standards.md): a specific message
// only where the cause is known for certain, otherwise a general one that guesses nothing. The
// raw error (with its paths and x2t's stderr) goes to the log, never to the editor frame.
function toEditorError(e: unknown, cmd: string, filePath: string): Error {
  if (e instanceof OfficeUserError) {
    if (!e.quiet) log('WARN', 'Office', `${cmd} refused: ${e.message}`);
    return new Error(e.message);
  }
  const err = e as NodeJS.ErrnoException;
  log('ERROR', 'Office', `${cmd} failed`, {
    error: String(e),
    code: err?.code ?? null,
    stderr: e instanceof X2tError ? e.stderr.slice(0, 4000) : undefined,
  });
  const verb = cmd === 'open_file' ? 'open' : cmd === 'save_file' || cmd === 'save_changes' ? 'save' : null;
  if (e instanceof X2tError) {
    if (e.code === 'timeout') return new Error('This file took too long to convert, so Office stopped.');
  } else if (verb) {
    if (err?.code === 'EACCES' || err?.code === 'EPERM') return new Error(`Office doesn't have permission to ${verb} this file.`);
    if (err?.code === 'ENOSPC') return new Error(`The disk is full, so Office couldn't ${verb} this file.`);
    if (verb === 'save' && err?.code === 'EROFS') return new Error("This file is on a read-only disk, so Office couldn't save it.");
    // WHY only when the error names the document itself (fix round 2): the file vanished
    // between the checks and the work. An ENOENT about anything else (a temp folder) is not
    // "can't find this file", and saying so would send the user looking for the wrong thing.
    if (err?.code === 'ENOENT' && err.path === filePath) return new Error(MSG.notFound);
  } else if (cmd === 'write_editor_bin' && err?.code === 'ENOSPC') {
    // Storing the edited document is the first half of a save, so the save wording fits.
    return new Error("The disk is full, so Office couldn't save this file.");
  }
  return new Error(verb ? `Office couldn't ${verb} this file.` : "Office couldn't finish that.");
}

export function createOfficeCommands(deps: {
  root: string;
  sessions: ReturnType<typeof createSessions>;
  onSaved?(s: OfficeSession, beforeBytes: Buffer | null): Promise<void>;
  onOpened?(s: OfficeSession): Promise<void>;
  /** Test seam: swap the translator (a slow or failing fake). Production uses x2t. */
  convert?: typeof realConvert;
  /** Test seam: a small limit, so the size refusal is testable without a 1 GB string. */
  editorBinMaxBytes?: number;
}): (token: string, cmd: string, args: Record<string, unknown>) => Promise<unknown> {
  const convert = deps.convert ?? realConvert;
  const binMax = deps.editorBinMaxBytes ?? EDITOR_BIN_MAX_BYTES;
  const editorBin = (s: OfficeSession) => path.join(s.temp, 'Editor.bin');
  // WHY x2t's job folders go in the instance temp base and not the session's own temp: the
  // session temp is served to the editor as office://<token>/asc/docmedia/, and the unpacked
  // document has no business being reachable there.
  const jobsBase = (s: OfficeSession) => path.dirname(s.temp);

  // WHY re-check on every open and save (and again just before a save's rename), not only when
  // the tab opened: the file's folder can have changed since (a symlink swapped in), and the
  // protected-folder rule is the boundary that keeps Office out of .git or credential files.
  async function authorize(s: OfficeSession): Promise<void> {
    const r = await authorizeArtifactWrite({ projectRoot: path.dirname(s.path), fullPath: s.path, mustStayInRoot: false });
    if (r.ok) return;
    if (r.error === 'protected-path') throw userError(MSG.protected);
    // A confirm step for settings-like files is design task 8's; until then, refuse.
    if (r.error === 'needs-confirm') throw userError(MSG.needsConfirm);
    throw userError(MSG.notFound);
  }

  async function openFile(s: OfficeSession): Promise<string> {
    await authorize(s);
    if (formatFor(s.path) === null) throw userError(MSG.unsupportedOpen);
    const info = await fsp.stat(s.path).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') throw userError(MSG.notFound);
      throw e;
    });
    if (info.size > OFFICE_MAX_BYTES) throw userError(MSG.tooLarge);
    // WHY check readability here: x2t reports an unreadable file only as a bare exit code;
    // checking first gives a real EACCES, which the boundary turns into a permission message.
    await fsp.access(s.path, fsc.R_OK);
    // WHY clear first: x2t writes the document's pictures to a media/ folder beside its output
    // (verified 2026-09-28), which is <session temp>/media — exactly what office:// serves as
    // asc/docmedia/media/. A re-open must not keep a previous translation's pictures there.
    await fsp.rm(path.join(s.temp, 'media'), { recursive: true, force: true });
    await fsp.rm(editorBin(s), { force: true });
    await convert(deps.root, s.path, editorBin(s), FORMAT.bin, jobsBase(s));
    const b64 = (await fsp.readFile(editorBin(s))).toString('base64');
    if (deps.onOpened) {
      // WHY caught: the file opened fine; a failure to keep its "opened" version (Task 7) must
      // not stop the user from seeing it.
      await deps.onOpened(s).catch((e) => log('WARN', 'Office', 'onOpened failed', { error: String(e) }));
    }
    return b64;
  }

  async function writeEditorBin(s: OfficeSession, data: string): Promise<string> {
    // WHY write-then-rename even inside our own temp: a write cut off half-way must never leave
    // a half Editor.bin that the next save would translate over the user's real file.
    const tmp = `${editorBin(s)}.part`;
    try {
      await fsp.writeFile(tmp, Buffer.from(data, 'base64'));
      await fsp.rename(tmp, editorBin(s));
    } catch (e) {
      // WHY (fix round 1): a leftover .part is up to 1 GB of the temp disk, for nothing.
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
    return 'ok';
  }

  // WHY tmp + rename (same as artifacts:save): the user's file is replaced in one step, so a
  // crash, a full disk or a failed translation mid-save never leaves half a file. The tmp sits
  // beside the user's file — not in the temp base — so it is on the same disk (rename is atomic
  // only within one) and quit's temp cleanup cannot touch it.
  async function saveFile(s: OfficeSession): Promise<string> {
    await authorize(s);
    const fmt = formatFor(s.path);
    if (fmt === null) throw userError(MSG.unsupportedSave);
    const dir = path.dirname(s.path);
    // WHY stat first (fix round 1): the saved file must keep the original's permissions — a
    // private 0600 file must not come back world-readable from the tmp's default mode.
    const orig = await fsp.stat(s.path).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    // WHY: a read-only file stays read-only — Office reports it instead of replacing it anyway.
    if (orig) await fsp.access(s.path, fsc.W_OK);
    const base = path.basename(s.path);
    await sweepStaleSaveDirs(dir, base);
    // WHY only when someone will use it: the previous bytes are for Task 7's version history;
    // reading up to 200 MB on every autosave for nobody would be pure waste.
    let before: Buffer | null = null;
    if (deps.onSaved) {
      before = await fsp.readFile(s.path).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      });
    }
    // WHY a private folder (fix round 2): x2t creates its output with default permissions, so
    // while it translates a 0600 file, a plain tmp beside it would be readable by other
    // accounts. mkdtemp makes the folder 0700 — nobody else can enter it — and it sits beside
    // the file, on the same disk, so the final rename stays one atomic step. The leading dot
    // keeps it out of file lists and the project watcher.
    const priv = await fsp.mkdtemp(path.join(dir, `.${base}${SAVE_DIR_MARK}`));
    const tmp = path.join(priv, base);
    try {
      await convert(deps.root, editorBin(s), tmp, fmt, jobsBase(s));
      await finishCopy(tmp, orig);
      // WHY again, right before the rename (fix round 1): the translation can take many seconds,
      // and the folder may have become protected, or a link swapped in, meanwhile.
      await authorize(s);
      // WHY here (fix round 1): quit stopped waiting while this save translated — its temp
      // folder is going away, so the only safe move is to keep the user's file as it was.
      if (closing) throw userError(MSG.closing, true);
      noteOwnWrite(s.path);
      // WHY the abort check (fix round 2): on Windows a busy rename is retried for a moment;
      // if quit gives up on this save meanwhile, it must stop rather than land late.
      await renameReplacing(tmp, s.path, process.platform, () => closing);
    } catch (e) {
      if (closing) throw userError(MSG.closing, true);
      throw e;
    } finally {
      // Every path — success (the folder is then empty), failure, or abandoned at quit.
      await fsp.rm(priv, { recursive: true, force: true }).catch(() => {});
    }
    s.modified = false;
    if (deps.onSaved) {
      // WHY caught: the file IS saved at this point; failing to keep a version must not make
      // the editor report the save itself as failed (it would retry and save again).
      await deps.onSaved(s, before).catch((e) => log('WARN', 'Office', 'onSaved failed', { error: String(e) }));
    }
    return 'ok';
  }

  // WHY collapse: autosave fires every few seconds, and a slow translation (a big workbook
  // takes seconds) lets several save_file calls pile up behind it. They would all translate
  // the same newest Editor.bin, so every save queued back to back joins the one not yet
  // started. A save that is already RUNNING is never joined — it may have read an older
  // Editor.bin. A write_editor_bin in between ends the run (enqueueOther below), so a newer
  // Editor.bin always gets its own save after it.
  function save(s: OfficeSession): Promise<unknown> {
    const q = queueOf(s);
    if (q.pendingSave) return q.pendingSave;
    const p: Promise<unknown> = enqueue(s, () => {
      if (q.pendingSave === p) q.pendingSave = null;
      return saveFile(s);
    });
    q.pendingSave = p;
    return p;
  }

  function enqueueOther<T>(s: OfficeSession, run: () => Promise<T>): Promise<T> {
    queueOf(s).pendingSave = null;
    return enqueue(s, run);
  }

  function dispatch(s: OfficeSession, cmd: string, args: Record<string, unknown>): Promise<unknown> {
    switch (cmd) {
      case 'open_file':
        return enqueueOther(s, () => openFile(s));
      case 'write_editor_bin': {
        const data = args.data;
        if (typeof data !== 'string') throw userError(MSG.refused);
        // WHY checked on the string's length, before decoding (review P1-3): decoding a huge
        // string would allocate the whole buffer first. base64 decodes to 3/4 of its length.
        if ((data.length * 3) / 4 > binMax) throw userError(MSG.binTooLarge);
        return enqueueOther(s, () => writeEditorBin(s, data));
      }
      case 'save_file':
      case 'save_changes':
        return save(s);
    }
    return enqueueOther(s, async () => {
      switch (cmd) {
        case 'js_log': {
          const msg = String(args.msg ?? '');
          if (/error|fail/i.test(msg)) log('WARN', 'Office', `editor: ${msg.slice(0, 300)}`);
          return null;
        }
        case 'get_current_path':
          // WHY only the name (fix round 1): the editor never needs the folder — bridge.js uses
          // this as "the document has a name" (not a Save As), for its extension in the Save As
          // filters, and as the file to reopen, which open_file ignores anyway (it always opens
          // the session's own file). A full path would tell the frame where the file lives.
          return path.basename(s.path);
        case 'set_document_modified':
          s.modified = args.modified === true;
          return null;
        case 'recent_files_state':
          return { enabled: false, files: [] };
        case 'get_system_fonts':
          return '';
        case 'list_user_dictionaries':
          return { folders: [], refused: [] };
        case 'recovery_candidates':
          return [];
        // The host owns closing the tab and titling the window; crash recovery (recovery_*)
        // and inserting another file (convert_for_insert) are follow-ups outside this plan.
        default:
          return null;
      }
    });
  }

  return async (token, cmd, args) => {
    if (!OFFICE_COMMANDS.has(cmd)) throw new Error(MSG.refused);
    // WHY the session comes only from the token: the frame is sealed to its own document, and
    // an editor naming some other path (args.path) must never reach any file but its own.
    const s = deps.sessions.get(token);
    if (!s) throw new Error(MSG.refused);
    if (closing) throw new Error(MSG.closing);
    try {
      return await dispatch(s, cmd, args);
    } catch (e) {
      throw toEditorError(e, cmd, s.path);
    }
  };
}

// Private save folders are named `.<file><SAVE_DIR_MARK><random>` beside the file.
const SAVE_DIR_MARK = '.office-save-';
// Same rule as cas-write's stale-tmp sweep: an hour is far longer than any real save, so a
// folder that old was left by a crash and a live save's folder is never touched.
const STALE_SAVE_DIR_MS = 60 * 60 * 1000;

// WHY (fix round 2): a crash mid-save leaves its private folder, holding a copy of the
// document, beside the user's file. Best-effort, like sweepStaleTmp: it must never fail a save.
async function sweepStaleSaveDirs(dir: string, base: string): Promise<void> {
  const prefix = `.${base}${SAVE_DIR_MARK}`;
  try {
    const now = Date.now();
    for (const name of await fsp.readdir(dir)) {
      if (!name.startsWith(prefix)) continue;
      const full = path.join(dir, name);
      try {
        const st = await fsp.lstat(full);
        if (st.isDirectory() && now - st.mtimeMs > STALE_SAVE_DIR_MS) await fsp.rm(full, { recursive: true, force: true });
      } catch { /* vanished or unreadable — nothing to sweep */ }
    }
  } catch { /* folder unreadable — skip the sweep */ }
}

// WHY: docx, xlsx and pptx are all zip files, which start with "PK\x03\x04". A translation
// that wrote something else must not replace the user's working document. The same handle
// then carries the original's permissions over and flushes the copy to disk.
async function finishCopy(file: string, orig: { mode: number; uid: number; gid: number } | null): Promise<void> {
  const fh = await fsp.open(file, 'r+');
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await fh.read(head, 0, 4, 0);
    if (bytesRead < 4 || head.toString('latin1') !== 'PK\x03\x04') throw userError(MSG.notADocument);
    if (orig) {
      await fh.chmod(orig.mode & 0o7777);
      // WHY: the new copy belongs to us with our default group. Root can restore the original
      // owner too; anyone else can at least restore the group when they belong to it (a shared
      // group folder). Best-effort: failing here must not fail a save that is otherwise good.
      const uid = process.getuid?.();
      if (uid !== undefined) await fh.chown(uid === 0 ? orig.uid : uid, orig.gid).catch(() => {});
    }
    // WHY fsync before the rename: without it, a power cut just after the rename can leave the
    // new name pointing at an empty file on some filesystems.
    await fh.sync();
  } finally {
    await fh.close();
  }
}
