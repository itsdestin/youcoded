// Office — shared shapes (v2, Task 5 of the build plan, 2026-09-28).
// Investigation: youcoded-dev/docs/active/investigations/2026-09-24-office-suite.md
// Decisions: youcoded-dev/docs/active/design/2026-09-27-office/*.answers.json
// Build design: youcoded-dev/docs/active/specs/2026-09-28-office-build-design.md
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
export type OfficeOpen = { ok: true; token: string; origin: string } | { ok: false; message: string };

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
  /** "Save a copy…" for a document whose save failed: `check` says whether a copy can succeed
   *  (hide the button when not); `save` asks where and writes it, never touching the original;
   *  `again` re-writes that same copy if the editor's bytes changed since (typing meanwhile). */
  saveCopy(token: string, mode: 'check' | 'save' | 'again'): Promise<OfficeSaveCopyResult>;
  /** Window close / app quit (design §4): main asks this window to save every open document,
   *  and waits for flushDone with the same id (or 5 s). Desktop only — absent elsewhere. */
  onFlushRequest?(cb: (id: string, reason: 'close' | 'quit' | 'final') => void): () => void;
  /** Main held a close or quit because documents could not be saved: ask the person. The count
   *  covers every window (quit); firstPath is this window's first such document. */
  onUnsavedPrompt?(cb: (p: OfficeUnsavedPrompt) => void): () => void;
  /** failed: how many documents could not be saved — main then keeps the window (or quit)
   *  waiting for the person's choice instead of closing. */
  flushDone?(id: string, result: { failed: number; firstPath?: string }): void;
  /** "Close anyway" on that prompt: main goes ahead with the close or quit it held. */
  proceedClose?(): void;
  /** The refused-quit prompt was dismissed (OK, Esc, Open it): main forgets what it held for it
   *  (fix round 12). Desktop only. */
  dismissPrompt?(): void;
  /** Files whose save failed after the page that asked for it was reloaded (fix round 6, M4):
   *  main keeps them until this page takes them. Desktop only. */
  lostSaves?(): Promise<string[]>;
  /** Main recorded such a failure while this page is up: take them (lostSaves). */
  onSavesLost?(cb: () => void): () => void;
  /** The names (never folders) of this window's unsaved non-Office edits — open editors and
   *  parked drafts (fix rounds 9–11): the quit gate refuses while any window has one. Desktop only. */
  setOtherUnsaved?(names: string[]): void;
}

/** main → renderer: Office documents that couldn't be saved (count), or — `other` — a quit or the
 *  last window's close refused for unsaved non-Office edits (fix rounds 9–11). */
export interface OfficeUnsavedPrompt {
  count: number;
  firstPath: string;
  other?: boolean;
  /** other: what was refused ('quit', default) or the last window's close. */
  mode?: 'quit' | 'close';
  /** other: teardown already ran (the chats have stopped); restartDropped: a restart became a quit. */
  afterTeardown?: boolean;
  restartDropped?: boolean;
}

export type OfficeSaveCopyResult =
  | { ok: true; possible: boolean }
  /** Saved: `path` is where the copy went (the tab switches to it); `folder` is its folder's
   *  name, the only part of the path ever shown. */
  | { ok: true; folder: string; path: string }
  /** 'again': whether the editor's newest bytes matched what is already in the copy (then
   *  nothing was written); otherwise the copy was written again with them. */
  | { ok: true; folder: string; path: string; unchanged: boolean }
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
