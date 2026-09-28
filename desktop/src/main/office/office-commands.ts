import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { EDITOR_BIN_MAX_BYTES, OFFICE_MAX_BYTES } from '../../shared/office-types';
import { renameReplacing, sweepStaleTmp } from '../artifacts/cas-write';
import { noteOwnWrite } from '../artifacts/project-watcher';
import { authorizeArtifactWrite } from '../artifacts/write-authorization';
import { log } from '../logger';
import type { createSessions, OfficeSession } from './office-sessions';
import { convert as realConvert, FORMAT, formatFor } from './x2t';

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
  unsupported: "Office can't open this kind of file.",
  binTooLarge: 'This document has grown too large for Office to save.',
  refused: 'refused',
} as const;

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
  // WHY run on both fulfil and reject: one failed command must not wedge the document's queue.
  const p = q.tail.then(run, run);
  q.tail = p.catch(() => undefined);
  inflight.add(p);
  const done = () => void inflight.delete(p);
  p.then(done, done);
  return p;
}

/**
 * Resolves once every document's queued commands have finished. WHY (Task 3 review
 * carry-over): at quit, cleanupOfficeSessions() removes every session's temp folder — and with
 * it the Editor.bin a save in flight is still translating. main.ts's shutdown waits on this
 * (capped) first, so a save either finishes or never starts its rename.
 */
export async function awaitIdle(): Promise<void> {
  // WHY a loop: a command that finishes can have been followed by another already queued.
  while (inflight.size > 0) await Promise.allSettled([...inflight]);
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

  // WHY re-check on every open and save, not only when the tab opened: the file's folder can
  // have changed since (a symlink swapped in), and the protected-folder rule is the boundary
  // that keeps Office from writing into .git or credential files.
  async function authorize(s: OfficeSession): Promise<void> {
    const r = await authorizeArtifactWrite({ projectRoot: path.dirname(s.path), fullPath: s.path, mustStayInRoot: false });
    if (r.ok) return;
    if (r.error === 'protected-path') throw new Error(MSG.protected);
    // A confirm step for settings-like files is design task 8's; until then, refuse.
    if (r.error === 'needs-confirm') throw new Error(MSG.needsConfirm);
    throw new Error(MSG.notFound);
  }

  async function openFile(s: OfficeSession): Promise<string> {
    await authorize(s);
    if (formatFor(s.path) === null) throw new Error(MSG.unsupported);
    const info = await fsp.stat(s.path).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') throw new Error(MSG.notFound);
      throw e;
    });
    if (info.size > OFFICE_MAX_BYTES) throw new Error(MSG.tooLarge);
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
    await fsp.writeFile(tmp, Buffer.from(data, 'base64'));
    await fsp.rename(tmp, editorBin(s));
    return 'ok';
  }

  // WHY tmp + rename (same as artifacts:save): the user's file is replaced in one step, so a
  // crash, a full disk or a failed translation mid-save never leaves half a file. The tmp sits
  // beside the user's file — not in the temp base — so it is on the same disk (rename is atomic
  // only within one) and quit's temp cleanup cannot touch it.
  async function saveFile(s: OfficeSession): Promise<string> {
    await authorize(s);
    const fmt = formatFor(s.path);
    if (fmt === null) throw new Error(MSG.unsupported);
    const dir = path.dirname(s.path);
    await sweepStaleTmp(dir, path.basename(s.path));
    // WHY only when someone will use it: the previous bytes are for Task 7's version history;
    // reading up to 200 MB on every autosave for nobody would be pure waste.
    let before: Buffer | null = null;
    if (deps.onSaved) {
      before = await fsp.readFile(s.path).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      });
    }
    const tmp = `${s.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await convert(deps.root, editorBin(s), tmp, fmt, jobsBase(s));
      await checkLooksLikeDocument(tmp);
      noteOwnWrite(s.path);
      await renameReplacing(tmp, s.path);
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw e;
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
  // started. A write_editor_bin in between ends the run (enqueueOther below), so a newer
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

  return async (token, cmd, args) => {
    if (!OFFICE_COMMANDS.has(cmd)) throw new Error(MSG.refused);
    // WHY the session comes only from the token: the frame is sealed to its own document, and
    // an editor naming some other path (args.path) must never reach any file but its own.
    const s = deps.sessions.get(token);
    if (!s) throw new Error(MSG.refused);

    switch (cmd) {
      case 'open_file':
        return enqueueOther(s, () => openFile(s));
      case 'write_editor_bin': {
        const data = args.data;
        if (typeof data !== 'string') throw new Error(MSG.refused);
        // WHY checked on the string's length, before decoding (review P1-3): decoding a huge
        // string would allocate the whole buffer first. base64 decodes to 3/4 of its length.
        if ((data.length * 3) / 4 > binMax) throw new Error(MSG.binTooLarge);
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
          return s.path;
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
  };
}

// WHY: docx, xlsx and pptx are all zip files, which start with "PK\x03\x04". A translation
// that wrote something else must not replace the user's working document.
async function checkLooksLikeDocument(file: string): Promise<void> {
  const fh = await fsp.open(file, 'r+');
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await fh.read(head, 0, 4, 0);
    if (bytesRead < 4 || head.toString('latin1') !== 'PK\x03\x04') throw new Error('Office could not save this file.');
    // WHY fsync before the rename: without it, a power cut just after the rename can leave the
    // new name pointing at an empty file on some filesystems.
    await fh.sync();
  } finally {
    await fh.close();
  }
}
