// Office — shared shapes (v2, Task 5 of the build plan, 2026-09-28).
// Investigation: youcoded-dev/docs/archive/investigations/2026-09-24-office-suite.md
// Decisions: youcoded-dev/docs/archive/design/2026-09-27-office/*.answers.json
// Build design: youcoded-dev/docs/archive/specs/2026-09-28-office-build-design.md
//
// Office is the Euro-Office editors (an AGPL add-on) inside a built-in page. Each open
// document gets its own sealed origin, office://<token>, and the editor's requests reach
// main only through window.claude.office.invoke, where main re-checks the command and that
// the asking window opened the document (design section 3a). The channels live in
// main/office/office-ipc.ts; the workbench fake is dev/workbench/mock-shim.ts.

export type OfficeKind = 'document' | 'spreadsheet' | 'presentation';

/** A file Office can open, as the start screen lists it. */
export interface OfficeFile {
  /** Absolute path — the identity of a tab and of its versions. */
  path: string;
  name: string;
  kind: OfficeKind;
  /** The folder it lives in, shown as the row's second line. */
  folder: string;
  /** ISO time it was last opened in Office (Recent) or changed (project files). */
  at: string;
}

/** One kept copy of a file. Autosave writes the real file every few seconds
 *  (office-questions#Q-save: "auto", with "version history or restorability"),
 *  so versions are how a change is taken back. */
export interface OfficeVersion {
  id: string;
  at: string;
  /** Why it was kept: when you opened the file, a periodic autosave point,
   *  or the copy made just before a restore replaced the file. */
  reason: 'opened' | 'autosave' | 'before-restore';
  bytes: number;
}

/** The answer to opening a document: its token and the sealed origin its editor runs on.
 *  The renderer frames `${origin}/index.html`. */
/** recoverOffer (Task 8 fix round 1): edits kept from last time for a file that changed since —
 *  the strip offers Recover unsaved changes / Discard. */
export type OfficeOpen = { ok: true; token: string; origin: string; recoverOffer?: true } | { ok: false; message: string };

export interface OfficeStatus {
  /** False when this build carries no Office add-on (e.g. a platform without a bundle yet). */
  available: boolean;
  recent: OfficeFile[];
  /** Office files in the project of the focused conversation. */
  project: { name: string; files: OfficeFile[] } | null;
}

export interface OfficeBridge {
  /** projectRoot: the focused conversation's project folder, or null for none. */
  status(projectRoot: string | null): Promise<OfficeStatus>;
  /** A new blank file in the given project (or Documents), opened at once. */
  create(kind: OfficeKind, projectRoot: string | null): Promise<{ ok: true; file: OfficeFile } | { ok: false; message: string }>;
  /** The system's file picker, Office files only. null when cancelled. */
  pick(): Promise<OfficeFile | null>;
  /** Start editing a file. Opening a file this window already has open returns the same token. */
  open(path: string): Promise<OfficeOpen>;
  /** One editor request (its bridge's command name and arguments), relayed for the frame. */
  invoke(token: string, cmd: string, args: unknown): Promise<unknown>;
  /** Stop editing; the document's temporary files are removed. */
  close(token: string): Promise<void>;
  versions(path: string): Promise<OfficeVersion[]>;
  /** Replace the file with a kept copy; the current file is kept first. */
  restore(path: string, versionId: string): Promise<{ ok: true } | { ok: false; message: string }>;
  /** Main replaced a document this window has open (a restore): the editor holding `token` must
   *  reopen the file — main refuses its saves until it does. Optional: only hosts that restore send it. */
  onChanged?(cb: (p: { path: string; token: string }) => void): () => void;
  /** "Save a copy…" for a document whose save failed: `check` says whether a copy can succeed
   *  (hide the button when not); `save` asks where and writes it, never touching the original;
   *  `again` re-writes that same copy if the editor's bytes changed since (typing meanwhile). */
  /** 'release': the editor that kept its typing after a restore was let go — main drops the
   *  pictures it put aside for that editor's copy. */
  saveCopy(token: string, mode: 'check' | 'save' | 'again' | 'release', editorBin?: string): Promise<OfficeSaveCopyResult>;
  /** Before this window closes, main asks its editors to send their newest edits to the recovery
   *  journal, and waits (≤1.5 s) for journalDone with the same id. Desktop only. */
  onJournalRequest?(cb: (id: string) => void): () => void;
  journalDone?(id: string): void;
  /** A quit, or the last window's close, was refused because this window has unsaved files
   *  (main/unsaved-quit.ts): show their list. Desktop only. */
  onUnsavedPrompt?(cb: (p: OfficeUnsavedPrompt) => void): () => void;
  /** "Discard and quit/close" on that list: main goes ahead with what it held. */
  proceedClose?(): void;
  /** The list was dismissed (OK, Esc): main forgets what it held for it (fix round 12). */
  dismissPrompt?(): void;
  /** The names (never folders) of this window's unsaved files — open editors, parked drafts and
   *  Office documents not saved yet (fix rounds 9–11, Task 8): the quit gate refuses while any
   *  window has one. Desktop only. */
  setOtherUnsaved?(names: string[]): void;
  /** Comments on an open document go through its editor (finish plan Task 6, main/office/
   *  office-comments.ts): main asks (token, request id, op), the editor's window answers, and says
   *  when a comment changed in the editor. Desktop only. */
  onCommentsRequest?(cb: (req: { token: string; id: string; op: unknown }) => void): () => void;
  commentsAnswer?(id: string, result: unknown, token: string): void;
  commentsChanged?(token: string): void;
}

/** main → renderer: a quit (mode 'quit') or the last window's close was refused for unsaved files. */
export interface OfficeUnsavedPrompt {
  mode: 'quit' | 'close';
  /** Teardown already ran (the chats have stopped); restartDropped: a restart became a quit. */
  afterTeardown: boolean;
  restartDropped: boolean;
}

export type OfficeSaveCopyResult =
  | { ok: true; possible: boolean }
  /** Saved: `path` is where the copy went (the tab switches to it); `folder` is its folder's
   *  name, the only part of the path ever shown. */
  | { ok: true; folder: string; path: string }
  /** 'again': whether the editor's newest bytes matched what is already in the copy (then
   *  nothing was written); otherwise the copy was written again with them. */
  | { ok: true; folder: string; path: string; unchanged: boolean }
  | { ok: true; released: true }
  | { ok: false; cancelled: true }
  | { ok: false; message: string };

/** The largest file Office will open (200 MB). WHY a cap: x2t translates the whole file in
 *  one go and the editor holds all of it in memory; past this the app would stall or run out
 *  of memory instead of opening. */
export const OFFICE_MAX_BYTES = 200 * 1024 * 1024;

/** The largest translated document the editor may hand back for a save (1 GB, decoded).
 *  WHY 1 GB and not 200 MB: the editor's translated form runs about 5× the file — a 21 MB
 *  workbook's Editor.bin measured 104 MB — so a file under OFFICE_MAX_BYTES can legitimately
 *  grow well past it. The cap stops a runaway frame from exhausting the main process. */
export const EDITOR_BIN_MAX_BYTES = 1024 * 1024 * 1024;
