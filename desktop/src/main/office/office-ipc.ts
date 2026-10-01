// The office:* channels: how the renderer reaches the Office editors' main-process half.
// Structurally a sibling of voice/voice-handlers.ts — one register function called from
// main.ts, one channel list pinned beside preload.ts's strings.
//
// WHY main re-checks everything (design section 3a, review 2 R2-7): the renderer checks each
// editor request too, but only as a convenience. Here an office:invoke is refused unless its
// command is on the allow-list AND its token names a document the ASKING window opened
// (event.sender). A compromised or confused renderer can therefore never drive another
// window's document, nor ask the editor host for anything outside the allow-list.
//
// WHY no electron import: ipcMain is passed in (and typed structurally), so the tests drive
// these handlers with a fake that records them. main.ts passes the real one.
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { OFFICE_MAX_BYTES, type OfficeFile, type OfficeOpen, type OfficeSaveCopyResult, type OfficeStatus, type OfficeVersion } from '../../shared/office-types';
import { authorizeArtifactWrite } from '../artifacts/write-authorization';
import { log } from '../logger';
import { saveEditorSettings } from './editor-settings';
import { createOfficeCommands, OFFICE_COMMANDS } from './office-commands';
import { grantPicked } from './office-pictures';
import { keepRecoveryIn } from './office-recovery';
import type { createSessions, OfficeSession } from './office-sessions';
import type { PrintOutcome } from './office-print';
import { formatFor } from './x2t';
import * as versions from './versions';
import { createPruneScheduler, type PruneScheduler } from './prune-schedule';
import * as recent from './recent';
import { answerBy, blankName, createBlank, describeFile, isOfficeKind, kindFor, startWalk, type ProjectWalk, type WalkOptions } from './office-home';

type Sessions = ReturnType<typeof createSessions>;

// Byte-identical to the strings in preload.ts (and remote-shim.ts, SessionService.kt);
// tests/ipc-channels.test.ts pins all four.
const CHANNELS = [
  'office:status',
  'office:create',
  'office:pick',
  'office:open',
  'office:invoke',
  'office:close',
  'office:versions',
  'office:restore',
  'office:save-copy',
] as const;

// WHY a local literal, not imported: office-protocol.ts keeps its scheme constant private on
// purpose (main.ts pins the same literal in its privileged-scheme list). The origin handed to
// the renderer is this scheme plus the document token, the host the protocol handler reads.
const SCHEME = 'office';

const MSG = {
  unavailable: "Office isn't included in this build.",
  missing: 'This file no longer exists.',
  unsupported: "Office can't open this kind of file yet.",
  tooLarge: "This file is larger than 200 MB, which Office can't open.",
  protected: "Office can't open files in this protected folder.",
  needsConfirm: "Office can't open settings files like this one yet.",
  noPermission: "Office doesn't have permission to open this file.",
  openElsewhere: 'This file is already open in another window.',
  couldNotOpen: "Office couldn't open this file.",
  couldNotCopy: "Office couldn't save a copy of this file.",
  refused: 'refused',
  createProtected: "Office can't create files in this protected folder.",
  createNeedsConfirm: "Office can't create files in this folder yet.",
  createFolderGone: 'This folder no longer exists.',
  couldNotCreate: "Office couldn't create a new file.",
  createNoPermission: "Office doesn't have permission to create files in this folder.",
  changeProtected: "Office can't change files in this protected folder.",
  changeNeedsConfirm: "Office can't change settings files like this one yet.",
  folderGone: "This file's folder no longer exists.",
  stillSaving: 'This file is still being saved. Try again in a moment.',
  couldNotRestore: "Office couldn't restore this version.",
  // Print (finish plan Task 3).
  printing: 'Office is already printing a document. Finish or cancel that first.',
  noPrinter: "Office couldn't find a printer on this computer.",
  couldNotPrint: "Office couldn't open the print window.",
} as const;

/** WHY a cap across folders (fix round 2): a walk on a hung network folder never ends. Past this
 *  many running at once, a further project gets no list (logged) rather than one more stuck walk. */
const MAX_WALKS = 2;

/** WHY 10 minutes (design section 3): while a file keeps changing, one extra kept version per
 *  10 minutes of work — autosave itself writes every few seconds, far too often to keep each. */
const AUTOSAVE_SNAPSHOT_MS = 10 * 60 * 1000;
/** WHY 5 minutes: the tidy-up reads every kept file's index; a burst of snapshots (many files
 *  opened at once) runs it once, not once per file. */
const PRUNE_MIN_GAP_MS = 5 * 60 * 1000;

/** The part of Electron's ipcMain these handlers use. */
export interface OfficeIpcMain {
  handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void;
  removeHandler(channel: string): void;
}

/** The part of Electron's WebContents (event.sender) these handlers use. */
interface OfficeSender {
  id: number;
  once(event: 'destroyed', listener: () => void): unknown;
  isDestroyed?(): boolean;
  send?(channel: string, ...args: unknown[]): void;
}

export interface OfficeIpcDeps {
  /** The live session registry, or null when Office cannot run (see office-session-registry.ts).
   *  WHY a getter, fetched per request: the registry goes away at quit, and a handler must
   *  then answer "unavailable" instead of opening a session in a folder being removed. */
  getSessions(): Sessions | null;
  /** Whether the add-on is installed and matches the pinned version (officeAvailable()). */
  available(): Promise<boolean>;
  /** The add-on folder, for the translator (officeRoot()). */
  root: string;
  /** Where kept versions live (app.getPath('userData'), read after the dev-profile override). */
  userData: string;
  /** Where "Save a copy…" goes (the system save dialog); null when cancelled. Tests pass a fake.
   *  WHY optional: main.ts does not pass it — the real one lives in office-dialogs.ts, loaded
   *  only when a copy is asked for, so this file itself never imports electron. */
  pickCopyTarget?(sender: unknown, filePath: string): Promise<string | null | { refused: string }>;
  /** Tidy every kept version (each file's rules, then 1 GB across files) this long after
   *  registering, and again this long after a new version is kept (at most once per 5 minutes).
   *  WHY a delay (main.ts passes 30 s): it reads every kept file's index and may delete copies —
   *  work that must never compete with the first window opening or with a save. Tests leave it
   *  out, so nothing is scheduled. */
  pruneVersionsAfterMs?: number;
  /** Where a new file goes when no conversation is focused (app.getPath('documents')).
   *  Optional so tests that never create can leave it out; without it such a create fails. */
  documents?: string;
  /** The system file picker for the asking window (office-dialogs.ts pickOfficeFile); null when
   *  cancelled. Tests pass a fake. WHY optional: as with pickCopyTarget, the real one is loaded
   *  only when used, so this file never imports electron. */
  pickFile?(sender: unknown): Promise<OfficeFile | null>;
  /** Test seams for the project walk: its file-system calls, and how long a request waits for it. */
  walkFs?: WalkOptions['fs'];
  walkDeadlineMs?: number;
  /** The system file picker the editor asks for (office-dialogs.ts pickEditorFiles); null when
   *  cancelled. Tests pass a fake. WHY optional: as with pickCopyTarget, loaded only when used. */
  pickEditorFiles?(sender: unknown, opts: { multiple: boolean; filters: unknown }): Promise<string[] | null>;
  /** The system save dialog the editor asks for (office-dialogs.ts pickSaveTarget): Save As,
   *  Download as, Export to PDF. null when cancelled. Tests pass a fake; loaded only when used. */
  pickSaveTarget?(sender: unknown, opts: { filters: unknown; folder: string; name: string; ext: string }): Promise<string | null | { refused: string }>;
  /** The system print dialog for a PDF (office-print.ts printPdf). Tests pass a fake; loaded only
   *  when used, like the dialogs above. */
  printPdf?(file: string): Promise<PrintOutcome>;
  /** Printing could not be shown: the reason, and an offer to save a PDF instead (office-print.ts
   *  offerPdf). True when accepted. Tests pass a fake. */
  offerPdf?(sender: unknown, message: string): Promise<boolean>;
  /** Test seam: the translator (a fake that copies). Production uses x2t. */
  convert?: Parameters<typeof createOfficeCommands>[0]['convert'];
}



const fail = (message: string): OfficeOpen => ({ ok: false, message });

/** What a log line says about an error: its kind and its system code (ENOENT, EACCES…), never its
 *  message. WHY (Task 1 fix rounds 2-3, a deliberate change to every error log here): an fs or
 *  dialog error's message carries paths; the kind and code keep the cause without them. */
const errorKind = (e: unknown) => ({
  kind: e instanceof Error ? e.name : typeof e,
  code: (e as NodeJS.ErrnoException | null)?.code ?? null,
});
let activePruner: PruneScheduler | null = null;

// The picture types the editor's Insert → Picture dialog asks for (bridge.js's 'images' filter).
const PICTURE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'ico', 'tif', 'tiff', 'webp']);
/** Whether an open_dialog request's filters are pictures only (plus "All files"): true for
 *  Insert → Picture, false for the editor's own Open, which asks for documents. */
function picturesOnly(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  let pictures = false;
  for (const f of raw) {
    const exts = f && typeof f === 'object' && Array.isArray((f as { extensions?: unknown }).extensions) ? (f as { extensions: unknown[] }).extensions : null;
    if (!exts) return false;
    for (const e of exts) {
      if (e === '*') continue;
      if (typeof e !== 'string' || !PICTURE_EXTS.has(e.toLowerCase())) return false;
      pictures = true;
    }
  }
  return pictures;
}

// ── Save As targets (finish plan Task 2) ──
// WHY handles: the editor's save-as hands dialog.save's answer straight to save_file_as, and the
// frame must never learn a folder. So save_dialog answers `yc-save/<random>/<chosen name>` —
// bridge.js reads the name (and its extension) from the end — and save_file_as writes only to
// the path main's own dialog recorded for that exact handle, for that document, once.
const SAVE_HANDLE = /^yc-save\/[0-9a-f]{32}\/[^/\\]+$/;
// Per document; a WeakMap so a closed document's grants go with it.
const saveTargets = new WeakMap<OfficeSession, Map<string, string>>();

export function registerOfficeIpc(ipcMain: OfficeIpcMain, deps: OfficeIpcDeps): void {
  // WHY: ipcMain.handle throws on re-registration. Clearing first keeps hot-reload dev
  // sessions (scripts/run-dev.sh) from crashing on reload.
  for (const ch of CHANNELS) ipcMain.removeHandler(ch);
  keepRecoveryIn(deps.userData); // where each open document's crash-recovery journal lives (Task 8)
  // WHY cancel the previous one: a re-register (a dev reload) must not leave two tidy-ups queued.
  activePruner?.cancel();
  const pruner = activePruner = deps.pruneVersionsAfterMs === undefined ? null
    : createPruneScheduler(() => versions.pruneAll(deps.userData), { delayMs: deps.pruneVersionsAfterMs, minGapMs: PRUNE_MIN_GAP_MS });
  pruner?.request(); // the startup pass

  // WHY one commands instance per registry, not one per request: the command runner keeps
  // each document's queue (one save at a time), which only works if every request for that
  // document goes through the same instance. Rebuilt only if the registry itself changes.
  let commands: { reg: Sessions; run: ReturnType<typeof createOfficeCommands> } | null = null;
  const commandsFor = (reg: Sessions) => {
    if (commands?.reg !== reg) commands = { reg, run: createOfficeCommands({ root: deps.root, sessions: reg, onOpened, onSaved, wantsBefore: snapshotDue, convert: deps.convert }) };
    return commands.run;
  };

  // ── Kept versions (Task 7): both run inside the document's command queue, and a failure is
  // only logged there — the open or save itself has already succeeded. ──
  async function onOpened(s: OfficeSession): Promise<void> {
    if (await versions.snapshot(deps.userData, s.path, 'opened', await fsp.readFile(s.path))) pruner?.request();
  }
  // WHY asked before the save reads the file (M1): the file as it was is up to 200 MB, and is
  // only needed when a kept version is due — not on every autosave.
  const snapshotDue = (s: OfficeSession) => Date.now() - s.lastSnapshotAt > AUTOSAVE_SNAPSHOT_MS;
  async function onSaved(s: OfficeSession, before: Buffer | null): Promise<void> {
    // `before` is the file as it was just before this save — the state worth keeping.
    if (!before || !snapshotDue(s)) return;
    try {
      if (await versions.snapshot(deps.userData, s.path, 'autosave', before)) pruner?.request();
    } finally {
      // WHY also after a failure: a full disk would otherwise be retried (and fail, reading and
      // writing up to 200 MB) on every autosave. The next try comes 10 minutes later instead.
      s.lastSnapshotAt = Date.now();
    }
  }

  const isReady = async (): Promise<Sessions | null> => {
    const reg = deps.getSessions();
    return reg && (await deps.available()) ? reg : null;
  };

  // WHY track windows: a window that closes (or crashes) never sends office:close, and its
  // documents' temp folders would otherwise stay until quit. One listener per window.
  const watched = new Set<number>();
  // WHY count opens (fix round 1): a window can hold the same file in more than one place (a
  // tab, and an Edit in a file panel), and each place is handed the same token. Only the
  // last one's close may tear the session down. Keyed by window, then token.
  const opens = new Map<number, Map<string, number>>();
  // (A save that fails after its page reloaded, or its window closed, needs no report of its own
  // since Task 8: its edits are in the document's recovery journal, offered back at the next open.)
  function watch(sender: OfficeSender): void {
    const id = sender.id;
    if (watched.has(id)) return;
    watched.add(id);
    sender.once('destroyed', () => {
      watched.delete(id);
      opens.delete(id);
      void deps.getSessions()?.closeAllFor(id).catch((e) => log('WARN', 'Office', 'closing a gone window\'s documents failed', errorKind(e)));
    });
  }

  // WHY: two opens of one file racing (a double click) must not make two sessions for it —
  // one editor per file (design section 5). The second waits for the first one's session.
  const opening = new Map<string, Promise<OfficeSession>>();

  async function open(sender: OfficeSender, filePath: unknown): Promise<OfficeOpen> {
    const reg = await isReady();
    if (!reg) return fail(MSG.unavailable);
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return fail(MSG.couldNotOpen);

    // WHY the realpath is the session's path (review P1-6): a file reached through a link is
    // the same file, so it maps to the same session, and every later check (the protected
    // folders, versions) judges the real location rather than the spelling it was given.
    let realPath: string;
    try {
      const auth = await authorizeArtifactWrite({ projectRoot: path.dirname(filePath), fullPath: filePath, mustStayInRoot: false });
      if (!auth.ok) {
        if (auth.error === 'protected-path') return fail(MSG.protected);
        // Settings-like files would need a confirm step first, which Office doesn't have yet; refuse.
        if (auth.error === 'needs-confirm') return fail(MSG.needsConfirm);
        return fail(MSG.missing);
      }
      realPath = auth.realPath;
      // WHY stat after authorizing: the authorization accepts a missing file whose folder
      // exists (it is also used for saving new files), so existence is checked here.
      const info = await fsp.stat(realPath);
      if (!info.isFile() || formatFor(realPath) === null) return fail(MSG.unsupported);
      if (info.size > OFFICE_MAX_BYTES) return fail(MSG.tooLarge);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return fail(MSG.missing);
      if (code === 'EACCES' || code === 'EPERM') return fail(MSG.noPermission);
      // WHY general: the cause is not known for certain, so the message guesses nothing; the
      // detail goes to the log (docs/error-message-standards.md).
      log('ERROR', 'Office', 'office:open failed', { error: String(e), code: code ?? null });
      return fail(MSG.couldNotOpen);
    }

    let session = reg.byPath(realPath);
    if (!session) {
      let pending = opening.get(realPath);
      if (!pending) {
        pending = reg.open(realPath, sender.id);
        opening.set(realPath, pending);
        const clear = () => void opening.delete(realPath);
        pending.then(clear, clear);
      }
      try {
        session = await pending;
      } catch (e) {
        log('ERROR', 'Office', 'office:open could not start a session', errorKind(e));
        return fail(MSG.couldNotOpen);
      }
    }
    // WHY refuse rather than hand over the token: the token is bound to the window that
    // opened the file, so another window could not use it anyway (invoke re-checks the owner).
    if (session.senderId !== sender.id) return fail(MSG.openElsewhere);
    // WHY (fix round 1): the window can close while main was opening. Its destroyed event has
    // then already run (or never will be listened for), so nothing would ever close this
    // session, and it would keep the file claimed until quit.
    if (sender.isDestroyed?.()) {
      void reg.close(session.token).catch(() => {});
      return fail(MSG.couldNotOpen);
    }
    watch(sender);
    const mine = opens.get(sender.id) ?? new Map<string, number>();
    opens.set(sender.id, mine);
    mine.set(session.token, (mine.get(session.token) ?? 0) + 1);
    // WHY here, on success only (R5): Recent means "opened in Office" — a refused open (gone,
    // too large, protected) never lists the file. WHY the real path: the same file reached
    // through a link is one entry. WHY not awaited (fix round 1): Recent must never delay or
    // fail an open; a failure is only logged.
    const kind = kindFor(realPath);
    if (kind) void recent.add(deps.userData, describeFile(realPath, kind, new Date())).catch((e) => log('WARN', 'Office', 'adding to Recent failed', errorKind(e)));
    return { ok: true, token: session.token, origin: `${SCHEME}://${session.token}` };
  }

  async function invoke(sender: OfficeSender, token: unknown, cmd: unknown, args: unknown): Promise<unknown> {
    if (typeof token !== 'string' || typeof cmd !== 'string' || !OFFICE_COMMANDS.has(cmd)) throw new Error(MSG.refused);
    const reg = deps.getSessions();
    const s = reg?.get(token);
    if (!reg || !s || s.senderId !== sender.id) throw new Error(MSG.refused);
    // WHY a plain object only: the commands read named fields from it; anything else (an
    // array, null) is treated as no arguments rather than reaching them.
    const a = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
    if (cmd === 'open_dialog') return openDialog(sender, s, a);
    if (cmd === 'save_dialog') return saveDialog(sender, s, a);
    if (cmd === 'save_file_as') return saveFileAs(reg, s, a);
    if (cmd === 'print_document') return printDocument(sender, reg, s, a);
    if (cmd === 'save_editor_settings') return saveSettings(a);
    return commandsFor(reg)(token, cmd, a);
  }

  // The editor's own settings (finish plan Task 4). WHY answered null even when the write fails:
  // a setting that isn't remembered is no reason to interrupt the person — the choice still holds
  // in the open document — and an fs error names paths the frame must never see. It is logged.
  async function saveSettings(a: Record<string, unknown>): Promise<null> {
    try {
      await saveEditorSettings(deps.userData, a.settings);
    } catch (e) {
      log('WARN', 'Office', 'editor settings could not be saved', errorKind(e));
    }
    return null;
  }

  // Insert → Picture → From file (finish plan Task 1): Tauri's dialog.open, which the add-on's
  // relay sends as open_dialog. WHY here and not in the command runner: the dialog is parented to
  // the asking window, and only the handles office-pictures.ts grants for THIS document go back —
  // the frame never sees a folder, and copy-to-media reads only what this dialog granted.
  async function openDialog(sender: OfficeSender, s: OfficeSession, a: Record<string, unknown>): Promise<string | string[] | null> {
    const multiple = a.multiple === true;
    // WHY (Task 2 fix round 1): the only rightful caller is picture insert. The editor's own Open
    // (Ctrl+O → LocalFileOpen) asks this dialog for documents, and its answer would have made
    // the editor reload its file, dropping unsaved edits. Files open from the Office start screen.
    if (!picturesOnly(a.filters)) return null;
    let paths: string[] | null;
    try {
      const pick = deps.pickEditorFiles ?? (await import('./office-dialogs')).pickEditorFiles;
      paths = await pick(sender, { multiple, filters: a.filters });
    } catch (e) {
      // WHY caught (fix round 1): a failing system dialog's error text can name folders; the frame
      // gets the same answer as a cancel. WHY only kind and code are logged (fix round 2): the
      // message itself can carry those folders too.
      log('WARN', 'Office', 'editor file dialog failed', errorKind(e));
      return null;
    }
    if (!paths?.length) return null;
    const handles = grantPicked(s, paths);
    // Tauri's shape: a list when several may be chosen, else the one file.
    return multiple ? handles : handles[0];
  }

  // Save As / Download as / Export to PDF (finish plan Task 2): Tauri's dialog.save, which the
  // add-on's relay sends as save_dialog. WHY here, as open_dialog: the dialog is parented to the
  // asking window, and what goes back is a handle only this document can spend.
  async function saveDialog(sender: OfficeSender, s: OfficeSession, a: Record<string, unknown>): Promise<string | null> {
    let chosen: string | null | { refused: string };
    try {
      const pick = deps.pickSaveTarget ?? (await import('./office-dialogs')).pickSaveTarget;
      // WHY the document's own folder: where Save As starts in every office suite. main knows it;
      // the frame never does.
      chosen = await pick(sender, { filters: a.filters, folder: path.dirname(s.path), name: path.basename(s.path, path.extname(s.path)), ext: path.extname(s.path).slice(1).toLowerCase() });
    } catch (e) {
      // As open_dialog: a failing dialog's text can name folders; the frame gets a cancel.
      log('WARN', 'Office', 'editor save dialog failed', errorKind(e));
      return null;
    }
    if (chosen === null) return null;
    // Worded for a person and naming only the file (office-dialogs.ts resolveCopyTarget).
    if (typeof chosen === 'object') throw new Error(chosen.refused);
    let mine = saveTargets.get(s);
    if (!mine) saveTargets.set(s, (mine = new Map()));
    const handle = `yc-save/${randomBytes(16).toString('hex')}/${path.basename(chosen)}`;
    mine.set(handle, chosen);
    return handle;
  }

  // The answer's second half: write the copy where the dialog said. Answers the chosen file's
  // name and its folder's name for YouCoded's own note (EditorFrame keeps them from the frame).
  async function saveFileAs(reg: Sessions, s: OfficeSession, a: Record<string, unknown>): Promise<{ name: string; folder: string }> {
    const handle = a.path;
    const target = typeof handle === 'string' && SAVE_HANDLE.test(handle) ? saveTargets.get(s)?.get(handle) : undefined;
    if (!target) throw new Error(MSG.refused);
    // One save per dialog: a handle the frame kept can't write there again later.
    saveTargets.get(s)?.delete(handle as string);
    // The editor's export choices go along; main checks them before x2t sees any (exportParams).
    await commandsFor(reg).saveAs(s.token, target, { text: a.text, json: a.json });
    return { name: path.basename(target), folder: path.basename(path.dirname(target)) };
  }

  // ── Print (finish plan Task 3) ──
  // WHY one at a time across the app: each print shows a system dialog of its own, and a second
  // one stacked behind the first is easy to lose. The flag lives here, per registration.
  let printing = false;

  // File → Print, the toolbar's print, Ctrl+P: bridge.js's Print sends write_editor_bin, then this.
  // Main makes a PDF of the document in its own temp folder and shows the system print dialog for
  // it. When that dialog can't be shown (no printing service or printer), it says so and offers the
  // same PDF as a file (Task 2's Save As path). Answers what EditorFrame needs for its note; the
  // frame itself is only told it went well.
  async function printDocument(sender: OfficeSender, reg: Sessions, s: OfficeSession, a: Record<string, unknown>): Promise<{ saved?: { name: string; folder: string } }> {
    if (printing) throw new Error(MSG.printing);
    printing = true;
    try {
      const run = commandsFor(reg);
      // Its errors are already worded for a person (office-commands toEditorError).
      const pdf = await run.printPdf(s.token, a.json);
      let outcome: PrintOutcome;
      try {
        const print = deps.printPdf ?? (await import('./office-print')).printPdf;
        outcome = await print(pdf.file);
      } catch (e) {
        log('WARN', 'Office', 'print window failed', errorKind(e));
        outcome = { failed: 'other' };
      } finally {
        // WHY right away: the PDF was only for the print window. The offer below makes its own file.
        await pdf.dispose();
      }
      if (outcome === 'printed' || outcome === 'cancelled') return {};
      log('WARN', 'Office', 'printing could not be shown', { reason: outcome.failed });
      let chosen: string | null | { refused: string };
      try {
        const offer = deps.offerPdf ?? (await import('./office-print')).offerPdf;
        if (!(await offer(sender, outcome.failed === 'no-printer' ? MSG.noPrinter : MSG.couldNotPrint))) return {};
        const pick = deps.pickSaveTarget ?? (await import('./office-dialogs')).pickSaveTarget;
        const base = path.basename(s.path, path.extname(s.path));
        chosen = await pick(sender, { filters: [{ name: 'PDF', extensions: ['pdf'] }], folder: path.dirname(s.path), name: base, ext: path.extname(s.path).slice(1).toLowerCase() });
      } catch (e) {
        // As the editor's own dialogs: a failing system dialog's text can name folders — logged by
        // kind and code only, and answered as a cancel.
        log('WARN', 'Office', 'print fallback dialog failed', errorKind(e));
        return {};
      }
      if (chosen === null) return {};
      if (typeof chosen === 'object') throw new Error(chosen.refused);
      // The same safe write as Save As (a private folder beside it, checked, one rename). A
      // workbook's chosen range goes along (exportParams); a page list is a print-only choice.
      await run.saveAs(s.token, chosen, { json: a.json });
      return { saved: { name: path.basename(chosen), folder: path.basename(path.dirname(chosen)) } };
    } finally {
      printing = false;
    }
  }

  async function close(sender: OfficeSender, token: unknown): Promise<void> {
    if (typeof token !== 'string') return;
    const reg = deps.getSessions();
    // WHY silent for someone else's token: closing is only ever a request about the asking
    // window's own documents; anything else changes nothing.
    if (!reg || reg.get(token)?.senderId !== sender.id) return;
    const mine = opens.get(sender.id);
    const left = (mine?.get(token) ?? 1) - 1;
    if (left > 0) { mine!.set(token, left); return; }
    mine?.delete(token);
    // reg.close waits (capped) for a save still queued for this document before its temp goes.
    await reg.close(token);
  }

  // "Save a copy…" for a document whose save keeps failing (the owner's decision, fix round 1).
  // Same checks as invoke: the token must be one this window opened.
  async function saveCopy(sender: OfficeSender, token: unknown, mode: unknown, data?: unknown): Promise<OfficeSaveCopyResult> {
    // The editor's own bytes, from an editor kept after a restore (EditorFrame): copied, never saved.
    // WHY refused, not ignored, when not text (fix round 3): falling back to the working copy
    // would put some other editor's document in the copy the person asked for.
    if (data !== undefined && typeof data !== 'string') return { ok: false, message: MSG.refused };
    const bin = data;
    const reg = deps.getSessions();
    const s = typeof token === 'string' ? reg?.get(token) : undefined;
    if (!reg || !s || s.senderId !== sender.id) return { ok: false, message: MSG.refused };
    const run = commandsFor(reg);
    if (mode === 'release') { await run.releaseKeptMedia(s.token); return { ok: true, released: true }; }
    if (mode === 'check') return { ok: true, possible: run.canCopy(s.token) };
    if (mode === 'again') {
      try {
        const r = await run.saveCopyAgain(s.token, bin);
        if (!r) return { ok: false, message: MSG.couldNotCopy };
        return { ok: true, folder: path.basename(path.dirname(r.target)), path: r.target, unchanged: r.unchanged };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : MSG.couldNotCopy };
      }
    }
    const pick = deps.pickCopyTarget ?? (await import('./office-dialogs')).pickCopyTarget;
    const target = await pick(sender, s.path);
    if (!target) return { ok: false, cancelled: true };
    if (typeof target !== 'string') return { ok: false, message: target.refused };
    try {
      await run.saveCopy(s.token, target, bin);
      // The folder's name only — never a full path on screen (the owner's rule for this message).
      return { ok: true, folder: path.basename(path.dirname(target)), path: target };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : MSG.couldNotCopy };
    }
  }

  // The versions of a file, newest first. WHY the real path: versions are keyed on it (the
  // session's path), so a file named through a link shows the same list.
  async function listVersions(filePath: unknown): Promise<OfficeVersion[]> {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return [];
    const real = await fsp.realpath(filePath).catch(() => filePath);
    try {
      return await versions.list(deps.userData, real);
    } catch (e) {
      // Rejected on purpose: the window then says it couldn't load them, never "no versions".
      log('ERROR', 'Office', 'office:versions could not read the kept versions', errorKind(e));
      throw new Error("Office couldn't load the versions of this file.");
    }
  }

  // Put a kept version back (design section 3; restore-while-open in versions.ts's caller here).
  // WHY through the document's queue when it is open: a save already asked for lands first (and
  // is kept as 'before-restore'); the editor's later saves are refused until it reloads — main
  // then tells its window (office:changed), whose editor reopens the restored file.
  async function restoreVersion(sender: OfficeSender, filePath: unknown, id: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
    const reg = await isReady();
    if (!reg) return { ok: false, message: MSG.unavailable };
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || typeof id !== 'string') return { ok: false, message: MSG.couldNotRestore };
    let realPath: string;
    try {
      const auth = await authorizeArtifactWrite({ projectRoot: path.dirname(filePath), fullPath: filePath, mustStayInRoot: false });
      if (!auth.ok) {
        if (auth.error === 'protected-path') return { ok: false, message: MSG.changeProtected };
        if (auth.error === 'needs-confirm') return { ok: false, message: MSG.changeNeedsConfirm };
        // A missing FILE is fine (restoring brings it back); this is its folder.
        return { ok: false, message: MSG.folderGone };
      }
      realPath = auth.realPath;
    } catch (e) {
      log('ERROR', 'Office', 'office:restore could not check the file', errorKind(e));
      return { ok: false, message: MSG.couldNotRestore };
    }
    if (formatFor(realPath) === null) return { ok: false, message: MSG.unsupported };
    const s = reg.byPath(realPath);
    // Another window's editor holds it: that window would keep editing the old document.
    if (s && s.senderId !== sender.id) return { ok: false, message: MSG.openElsewhere };
    // Closing (its last save may still land after ours) or about to open: not now.
    if (!s && reg.inUse(realPath)) return { ok: false, message: MSG.stillSaving };
    const work = () => versions.restore(deps.userData, realPath, id);
    // WHY held (M4): an open of this file starting now waits for the restore, so its editor
    // loads the restored file — never the old one, which its next save would write back.
    if (!s) {
      const r = await reg.holdWhile(realPath, work);
      if (r.ok) pruner?.request(); // the before-restore copy counts toward the 1 GB too
      return r;
    }
    let r: { ok: true } | { ok: false; message: string };
    try {
      const run = commandsFor(reg);
      // WHY the pictures go aside inside the same queue turn (fix round 3): an editor of this
      // document that keeps its typing may later copy it, and x2t needs ITS pictures — a reload
      // queued after this would already have replaced <temp>/media with the restored file's.
      r = await run.exclusive(s.token, async () => {
        const res = await work();
        if (res.ok) await run.keepMedia(s.token).catch((e) => log('WARN', 'Office', 'keeping pictures for a kept editor failed', errorKind(e)));
        return res;
      }, (x) => x.ok);
    } catch (e) {
      // The document closed (or quit began) while the restore waited its turn: nothing was done.
      log('WARN', 'Office', 'office:restore did not run', errorKind(e));
      return { ok: false, message: MSG.couldNotRestore };
    }
    if (r.ok) {
      pruner?.request(); // the before-restore copy counts toward the 1 GB too
      try { sender.send?.('office:changed', { path: realPath, token: s.token }); } catch { /* the window is going */ }
    }
    return r;
  }

  ipcMain.handle('office:open', (e, filePath) => open(e.sender, filePath));
  ipcMain.handle('office:versions', (_e, filePath) => listVersions(filePath));
  ipcMain.handle('office:restore', (e, filePath, id) => restoreVersion(e.sender, filePath, id));
  ipcMain.handle('office:save-copy', (e, token, mode, data) => saveCopy(e.sender, token, mode, data));
  ipcMain.handle('office:invoke', (e, token, cmd, args) => invoke(e.sender, token, cmd, args));
  ipcMain.handle('office:close', (e, token) => close(e.sender, token));

  // ── The start screen (Task 8): Recent, the focused project's files, New, Open ──

  /** The focused conversation's folder, when it is one: an absolute path to a folder that exists. */
  async function folderOf(projectRoot: unknown): Promise<string | null> {
    if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) return null;
    try {
      return (await fsp.stat(projectRoot)).isDirectory() ? projectRoot : null;
    } catch {
      return null;
    }
  }

  // ── The project walk: at most one real walk per folder, and at most MAX_WALKS at once ──
  // WHY (fix rounds 1–2): the page asks each time it is shown, and two windows can show the same
  // project. A walk still running for a folder answers every asker — each at its own deadline,
  // with what it has found so far — and is kept until the walk itself ends, not just until the
  // first answer: on a hung network folder the walk may never end, and starting another each
  // showing would stack them. A create in the folder marks the running walk stale (it may have
  // read past the new file already), so the next request starts one fresh walk.
  interface RunningWalk { walk: ProjectWalk; stale: boolean }
  const walks = new Map<string, RunningWalk>();
  let realWalks = 0;
  function walkFor(folder: string): ProjectWalk | null {
    const cur = walks.get(folder);
    if (cur && !cur.stale) return cur.walk;
    if (realWalks >= MAX_WALKS) {
      log('WARN', 'Office', 'project list skipped: other project folders are still being read', { running: realWalks });
      return null;
    }
    const entry: RunningWalk = { walk: startWalk(folder, { fs: deps.walkFs }), stale: false };
    walks.set(folder, entry);
    realWalks++;
    void entry.walk.done.then(() => {
      realWalks--;
      // A fresher walk may have replaced this one (after a create); leave that one in place.
      if (walks.get(folder) === entry) walks.delete(folder);
    });
    return entry.walk;
  }
  async function projectListFor(folder: string): Promise<OfficeFile[]> {
    const walk = walkFor(folder);
    return walk ? answerBy(walk, deps.walkDeadlineMs) : [];
  }
  /** A new file in `dir`: a walk of it that is running now may miss it. */
  function folderChanged(...dirs: string[]): void {
    for (const d of dirs) { const w = walks.get(d); if (w) w.stale = true; }
  }

  // WHY the renderer asks twice — status(null) for Recent, then status(folder) for the project
  // list (fix round 1): a project on a slow drive must never hold back Recent or the New buttons.
  // status(null) walks nothing; Recent's own stats are time-limited (recent.ts).
  async function status(projectRoot: unknown): Promise<OfficeStatus> {
    // WHY nothing is read when unavailable: the app hides Office then (Task 6), so walking a
    // project folder for it would be wasted work.
    if (!(await isReady())) return { available: false, recent: [], project: null };
    const folder = await folderOf(projectRoot);
    // WHY a Recent read failure rejects (only a real read error does — an unreadable file starts
    // over): the start screen then shows its Retry, never an empty Recent that isn't true.
    const [list, files] = await Promise.all([recent.list(deps.userData), folder ? projectListFor(folder) : null]);
    return { available: true, recent: list, project: folder && files ? { name: path.basename(folder), files } : null };
  }

  async function create(kind: unknown, projectRoot: unknown): Promise<{ ok: true; file: OfficeFile } | { ok: false; message: string }> {
    if (!(await isReady())) return { ok: false, message: MSG.unavailable };
    if (!isOfficeKind(kind)) return { ok: false, message: MSG.couldNotCreate };
    // The focused project, or Documents (design: "the focused project or Documents").
    const toDocuments = projectRoot === null || projectRoot === undefined;
    const wanted = toDocuments ? deps.documents : projectRoot;
    // WHY make Documents (fix round 1): a new account or a cleaned-up home can lack it, and New
    // with no conversation should still work. A project folder that is gone is NOT recreated:
    // that is a folder the person removed, and saying so is the truthful answer.
    if (toDocuments && typeof wanted === 'string' && path.isAbsolute(wanted)) {
      await fsp.mkdir(wanted, { recursive: true }).catch((e) => log('WARN', 'Office', 'could not create the Documents folder', errorKind(e)));
    }
    const dir = await folderOf(wanted);
    if (!dir) {
      if (typeof wanted === 'string' && path.isAbsolute(wanted)) return { ok: false, message: MSG.createFolderGone };
      return { ok: false, message: MSG.couldNotCreate };
    }
    let realDir: string;
    try {
      // WHY authorized like a save target (the same check "Save a copy" and office:open use): a
      // conversation's folder can be anywhere, and Office must not put files in a protected one.
      // Its name decides nothing here, so the kind's first name stands for every numbered one.
      const auth = await authorizeArtifactWrite({ projectRoot: dir, fullPath: path.join(dir, blankName(kind, 1)), mustStayInRoot: false });
      if (!auth.ok) {
        if (auth.error === 'protected-path') return { ok: false, message: MSG.createProtected };
        if (auth.error === 'needs-confirm') return { ok: false, message: MSG.createNeedsConfirm };
        return { ok: false, message: MSG.createFolderGone };
      }
      realDir = path.dirname(auth.realPath);
    } catch (e) {
      log('ERROR', 'Office', 'office:create could not check the folder', errorKind(e));
      return { ok: false, message: MSG.couldNotCreate };
    }
    try {
      // Not opened here: the renderer opens it through office:open, which adds it to Recent.
      const file = await createBlank(deps.root, kind, realDir);
      // Both spellings of the folder: the page asks by the conversation's own path.
      folderChanged(dir, realDir);
      return { ok: true, file };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return { ok: false, message: MSG.createNoPermission };
      // WHY general: the cause is not known for certain (a missing template among them); the
      // detail goes to the log (docs/error-message-standards.md).
      log('ERROR', 'Office', 'office:create failed', { error: String(e), code: code ?? null });
      return { ok: false, message: MSG.couldNotCreate };
    }
  }

  async function pick(sender: OfficeSender): Promise<OfficeFile | null> {
    // Nothing picked can be opened when Office can't run, so the picker isn't shown.
    if (!(await isReady())) return null;
    const choose = deps.pickFile ?? (await import('./office-dialogs')).pickOfficeFile;
    return choose(sender);
  }

  ipcMain.handle('office:status', (_e, projectRoot) => status(projectRoot));
  ipcMain.handle('office:create', (_e, kind, projectRoot) => create(kind, projectRoot));
  ipcMain.handle('office:pick', (e) => pick(e.sender));
}
