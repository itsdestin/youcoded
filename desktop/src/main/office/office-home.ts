// The Office start screen's backend (Task 8): the focused project's Office files, a new blank
// file from the add-on's templates, and the system file picker.
//
// WHY no electron import at the top: office-ipc.ts imports this file, and its tests drive the
// handlers with fakes. The picker loads electron's dialog only when it is used.
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { OfficeFile, OfficeKind } from '../../shared/office-types';

const EXT: Record<OfficeKind, 'docx' | 'xlsx' | 'pptx'> = { document: 'docx', spreadsheet: 'xlsx', presentation: 'pptx' };
const KIND_OF: Record<string, OfficeKind> = { docx: 'document', xlsx: 'spreadsheet', pptx: 'presentation' };
const BLANK_NAME: Record<OfficeKind, string> = {
  document: 'Untitled document',
  spreadsheet: 'Untitled spreadsheet',
  presentation: 'Untitled presentation',
};

export function isOfficeKind(v: unknown): v is OfficeKind {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(EXT, v);
}

/** Which kind of file a name is, or null when Office can't open it. */
export function kindFor(name: string): OfficeKind | null {
  return KIND_OF[path.extname(name).slice(1).toLowerCase()] ?? null;
}

/** A file as the start screen lists it. `at` is when it was opened (Recent) or changed. */
export function describeFile(filePath: string, kind: OfficeKind, at: Date): OfficeFile {
  return { path: filePath, name: path.basename(filePath), kind, folder: path.basename(path.dirname(filePath)), at: at.toISOString() };
}

// ── The "In <project>" list ──

/** Folders below the project root that are searched (a file 3 folders down is found). */
const MAX_DEPTH = 3;
const MAX_LISTED = 50;
/** WHY stop early: a conversation's folder can be the home folder, with hundreds of thousands
 *  of files. The walk ends after this many Office files are found, or this many folders are
 *  read, whichever comes first (and at the deadline below) — so opening the start screen stays
 *  quick. The found cap is above MAX_LISTED so "newest first" is judged over more than the
 *  first 50 the walk happens to meet. */
const MAX_FOUND = 200;
const MAX_DIRS = 2000;

/** Not an Office document of the person's: a hidden file, or an editor's own lock file
 *  (Word's "~$name.docx", LibreOffice's ".~lock.name#"). */
const isLockOrHidden = (name: string) => name.startsWith('.') || name.startsWith('~$');

/** WHY a deadline too (fix round 1): the caps bound the work, but not a slow drive — one folder
 *  on a sleeping network mount can take many seconds to answer. The start screen asks for the
 *  project list separately from Recent, and the walk gives back whatever it found by then. */
const WALK_DEADLINE_MS = 1500;

/** The folder entries the walk reads: a name and what kind of entry it is. */
interface WalkEntry { name: string; isDirectory(): boolean; isFile(): boolean }
/** The file-system calls the walk makes. Test seam: tests pass slow or counting ones. */
interface WalkFs {
  opendir(dir: string): Promise<AsyncIterable<WalkEntry>>;
  stat(p: string): Promise<{ mtime: Date }>;
}
const realFs: WalkFs = { opendir: (d) => fsp.opendir(d), stat: (p) => fsp.stat(p) };

export interface WalkOptions {
  maxDirs?: number;
  maxFound?: number;
  deadlineMs?: number;
  fs?: WalkFs;
  /** Test seam: called for each folder read. */
  onReadDir?: (dir: string) => void;
}

/** A walk under way: `done` settles when the walk itself ends (never rejects), and `found()`
 *  is what it has found so far, newest changed first, at most 50. */
export interface ProjectWalk {
  done: Promise<void>;
  found(): OfficeFile[];
}

/** Office files under `root`, up to 3 folders deep, newest changed first, at most 50. Skips
 *  node_modules and every hidden folder (.git among them). Never throws: an unreadable folder is
 *  skipped, and a root that is gone answers an empty list. Answers within `deadlineMs` with what
 *  it has found by then, even when a folder or file never answers. */
export async function projectFiles(root: string, opts: WalkOptions = {}): Promise<OfficeFile[]> {
  return answerBy(startWalk(root, opts), opts.deadlineMs);
}

/** What a walk has found once it ends, or at the deadline, whichever comes first. WHY separate
 *  from the walk (fix round 2): the walk may go on past the deadline (a hung network folder), and
 *  main keeps that one walk for later requests instead of starting another beside it. */
export async function answerBy(walk: ProjectWalk, deadlineMs = WALK_DEADLINE_MS): Promise<OfficeFile[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((r) => { timer = setTimeout(r, deadlineMs); });
  await Promise.race([walk.done, deadline]);
  clearTimeout(timer);
  return walk.found();
}

/** Start walking `root` in the background (see projectFiles for what it finds). Bounded by the
 *  folder and file caps, not by time. */
export function startWalk(root: string, opts: WalkOptions = {}): ProjectWalk {
  const maxDirs = opts.maxDirs ?? MAX_DIRS;
  const maxFound = opts.maxFound ?? MAX_FOUND;
  const fs = opts.fs ?? realFs;
  const dated: Array<{ path: string; kind: OfficeKind; mtime: Date }> = [];
  let found = 0;

  const walk = async () => {
    // Breadth first: the shallow files — the ones most likely to be the project's own — are met
    // before any cap is reached.
    let level: string[] = [root];
    let dirsRead = 0;
    for (let depth = 0; depth <= MAX_DEPTH && level.length; depth++) {
      const next: string[] = [];
      for (const dir of level) {
        if (dirsRead >= maxDirs || found >= maxFound) return;
        dirsRead++;
        opts.onReadDir?.(dir);
        const files: Array<{ path: string; kind: OfficeKind }> = [];
        try {
          // WHY opendir, not readdir: a folder with 100,000 entries is read only until the cap
          // is reached — breaking out of the loop closes it.
          for await (const e of await fs.opendir(dir)) {
            if (found >= maxFound) break;
            if (isLockOrHidden(e.name)) continue;
            // WHY isDirectory/isFile on the entry, not a stat: a link is neither, so the walk
            // never follows one — a link back up the tree cannot make it loop.
            if (e.isDirectory()) {
              if (e.name !== 'node_modules') next.push(path.join(dir, e.name));
            } else if (e.isFile()) {
              const kind = kindFor(e.name);
              if (kind) { files.push({ path: path.join(dir, e.name), kind }); found++; }
            }
          }
        } catch {
          // gone, or not ours to read: whatever it listed before failing still counts
        }
        await Promise.all(files.map(async (f) => {
          try {
            const { mtime } = await fs.stat(f.path);
            dated.push({ ...f, mtime });
          } catch { /* removed while the walk ran */ }
        }));
      }
      level = next;
    }
  };

  return {
    done: walk().catch(() => {}),
    found: () => [...dated]
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
      .slice(0, MAX_LISTED)
      .map((f) => describeFile(f.path, f.kind, f.mtime)),
  };
}

// ── New blank file ──

/** "Untitled document.docx", then "Untitled document 2.docx", … */
export function blankName(kind: OfficeKind, n: number): string {
  return n === 1 ? `${BLANK_NAME[kind]}.${EXT[kind]}` : `${BLANK_NAME[kind]} ${n}.${EXT[kind]}`;
}

/** WHY a bound: a folder already holding thousands of "Untitled document N" files is not a
 *  case to spin on; creating fails and says so instead. */
const MAX_NUMBER = 1000;

/** Copy the add-on's blank template for `kind` into `dir` as "Untitled <kind>.<ext>", or the
 *  first free "Untitled <kind> N.<ext>". Never replaces an existing file: each name is created
 *  exclusively ('wx'), so a file that appears meanwhile — another window creating at the same
 *  moment — makes this try the next number instead of writing over it. */
export async function createBlank(root: string, kind: OfficeKind, dir: string): Promise<OfficeFile> {
  const ext = EXT[kind];
  const bytes = await fsp.readFile(path.join(root, 'templates', `blank.${ext}`));
  for (let n = 1; n <= MAX_NUMBER; n++) {
    const target = path.join(dir, blankName(kind, n));
    let fh: fsp.FileHandle;
    try {
      fh = await fsp.open(target, 'wx');
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') continue;
      throw e;
    }
    // The file is ours from here: a failed write removes it, so no half-written blank is left.
    try {
      await fh.writeFile(bytes);
      await fh.close();
    } catch (e) {
      await fh.close().catch(() => {});
      await fsp.unlink(target).catch(() => {});
      throw e;
    }
    return describeFile(target, kind, new Date());
  }
  throw new Error(`No free name for a new ${kind} in this folder`);
}

// ── The system file picker ──

type ShowOpen = (win: unknown, opts: { title?: string; filters: Array<{ name: string; extensions: string[] }>; properties: Array<'openFile'> }) =>
  Promise<{ canceled: boolean; filePaths: string[] }>;

const showOpenDialog: ShowOpen = async (win, opts) => {
  const { dialog } = await import('electron');
  // WHY parented when there is a window: the picker then sits on top of the window that asked
  // (and is modal to it) instead of opening somewhere behind it.
  return win ? dialog.showOpenDialog(win as Electron.BaseWindow, opts) : dialog.showOpenDialog(opts);
};

/** Ask the person for an Office file (docx, xlsx, pptx). null when cancelled. */
export async function pickFile(win: unknown, show: ShowOpen = showOpenDialog): Promise<OfficeFile | null> {
  const r = await show(win, {
    filters: [{ name: 'Office files', extensions: ['docx', 'xlsx', 'pptx'] }],
    properties: ['openFile'],
  });
  const chosen = r.canceled ? undefined : r.filePaths[0];
  if (!chosen) return null;
  // WHY checked again: some platforms' pickers let the person switch the filter off.
  const kind = kindFor(chosen);
  if (!kind) return null;
  // The real path, as office:open will name it, so the tab and Recent agree on the file.
  const real = await fsp.realpath(chosen).catch(() => chosen);
  return describeFile(real, kind, new Date());
}
