// Office — shared shapes (design stage, 2026-09-28).
// Investigation: youcoded-dev/docs/active/investigations/2026-09-24-office-suite.md
// Decisions: youcoded-dev/docs/active/design/2026-09-27-office/*.answers.json
//
// Office is the Euro-Office editors (an AGPL add-on on its own sealed origin)
// inside a built-in page. These shapes are the UI's contract: the backend
// (serving the editors, reading/writing files, keeping versions) is built AFTER
// the screens are approved, so today only the workbench fake answers them —
// every channel is listed in dev/workbench/mock-only.ts.

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

export interface OfficeStatus {
  /** Where the editors are served from (the add-on's sealed origin). */
  editorOrigin: string;
  recent: OfficeFile[];
  /** Office files in the project of the focused conversation. */
  project: { name: string; files: OfficeFile[] } | null;
}

/** How the editor gets a file's bytes. A URL on the editor's own origin
 *  (workbench fixtures); the real host hands bytes across the frame. */
export type OfficeSource =
  | { ok: true; url: string }
  | { ok: false; message: string };

export interface OfficeBridge {
  status(): Promise<OfficeStatus>;
  /** A new blank file in the focused project (or Documents), opened at once. */
  create(kind: OfficeKind): Promise<{ ok: true; file: OfficeFile } | { ok: false; message: string }>;
  /** The system's file picker, Office files only. null when cancelled. */
  pick(): Promise<OfficeFile | null>;
  source(path: string): Promise<OfficeSource>;
  versions(path: string): Promise<OfficeVersion[]>;
  /** Replace the file with a kept copy; the current file is kept first. */
  restore(path: string, versionId: string): Promise<{ ok: true } | { ok: false; message: string }>;
}
