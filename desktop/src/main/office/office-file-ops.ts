// The file-system half of Office Home's Rename and "Make a copy" (card #143). Pure file work, no
// electron and no sessions: office-ipc.ts decides WHETHER a file may be touched (authorized, not
// open in Office); this file decides what a good name is and does the move or copy safely.
//
// WHY its own file: office-ipc.ts is already very large, and these functions are easiest to test
// against a real temporary folder, with no editor sessions around.
import { constants as fsc, promises as fsp } from 'node:fs';
import path from 'node:path';

/** Windows refuses these as file names (with or without an extension), and so do many programs on
 *  every system — so Office refuses them everywhere, keeping a file movable between computers. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** Characters Windows forbids in a name (the two slashes are checked first, with their own sentence). */
const FORBIDDEN = /[<>:"|?*]/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what is being refused
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_NAME_BYTES = 255;

/** Why a new name is refused, as a sentence for the person; null when the name is fine.
 *  `oldName` supplies the extension the new name must keep. */
export function nameProblem(newName: unknown, oldName: string): string | null {
  if (typeof newName !== 'string' || newName.trim() === '' || /^[. ]+$/.test(newName)) return 'Type a name for this file.';
  if (/[\\/]/.test(newName)) return "A file name can't contain / or \\.";
  if (CONTROL.test(newName)) return "A file name can't contain control characters.";
  if (FORBIDDEN.test(newName)) return `A file name can't contain any of these: < > : " | ? *`;
  if (/[ .]$/.test(newName)) return "A file name can't end with a space or a period.";
  // WHY the part before the FIRST dot, trailing spaces ignored: Windows treats "CON.tar.docx" and
  // "CON .docx" as the device CON too.
  if (RESERVED.test(newName.split('.')[0].replace(/ +$/, ''))) return `"${newName.split('.')[0].trim()}" is a name your computer keeps for itself. Pick another.`;
  if (Buffer.byteLength(newName, 'utf8') > MAX_NAME_BYTES) return 'That name is too long.';
  // WHY the extension alone: each Office extension maps to exactly one kind, so the same extension
  // (ignoring case) is the same kind.
  if (path.extname(newName).toLowerCase() !== path.extname(oldName).toLowerCase()) {
    return `The file type has to stay ${path.extname(oldName).toLowerCase()}.`;
  }
  return null;
}

/** Codes meaning "this disk can't make hard links" (FAT/exFAT, some network and sandboxed disks).
 *  EPERM is on the list because FAT reports it; if it was a real permission problem the rename
 *  that follows fails with it and is reported as such. */
const NO_LINKS = new Set(['EPERM', 'EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK', 'EINVAL']);

export class NameTaken extends Error {
  constructor() { super('a file with that name is already there'); }
}

/** Whether two paths are the very same file (a case-only rename on a disk that ignores case). */
async function sameFile(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([fsp.stat(a), fsp.stat(b)]);
  return x.ino !== 0 && x.dev === y.dev && x.ino === y.ino;
}

/**
 * Move `from` to `to` (same folder) WITHOUT ever replacing a file already named `to`.
 *
 * WHY link-then-unlink: a plain rename silently replaces an existing target, and checking first
 * leaves a gap in which another program can create that file (its work would be lost). A hard
 * link refuses an existing name atomically (EEXIST), so there is no gap; removing the old name
 * afterwards finishes the move. Where the disk has no hard links (NO_LINKS) we fall back to
 * "check it is free, then rename" — a tiny gap, but the only option there.
 *
 * Case-only renames ("report.docx" to "Report.docx"): on a disk that ignores case the target
 * "exists" — it is the same file — so that one case uses a plain rename, which is safe because
 * nothing else can be replaced.
 */
export async function renameNoClobber(from: string, to: string): Promise<void> {
  // Same file under another spelling of its name: a case-only rename (never replaces anything else).
  const existing = await fsp.lstat(to).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return false; throw e; });
  if (existing) {
    if (from !== to && (await sameFile(from, to))) { await fsp.rename(from, to); return; }
    throw new NameTaken();
  }
  try {
    await fsp.link(from, to);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new NameTaken();
    if (!NO_LINKS.has(code ?? '')) throw e;
    // No hard links here: check again, then rename.
    const taken = await fsp.lstat(to).then(() => true, () => false);
    if (taken) throw new NameTaken();
    await fsp.rename(from, to);
    return;
  }
  try {
    await fsp.unlink(from);
  } catch (e) {
    // WHY undo: leaving both names would look like a copy and the rename would be reported as failed.
    await fsp.unlink(to).catch(() => {});
    throw e;
  }
}

/** The names tried for a copy: "<stem> (copy).<ext>", then "<stem> (copy 2).<ext>" … */
export function copyName(name: string, n: number): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  return `${stem} (${n === 1 ? 'copy' : `copy ${n}`})${ext}`;
}

/** How many copies of one file are tried before giving up (a sane cap, not a limit anyone meets). */
export const MAX_COPIES = 100;

/**
 * Copy `from` beside itself under the first free "(copy)" name and return the new path.
 * `allow` is called with each candidate before anything is written (the protected-folder check)
 * and returns the path to write to, or throws to refuse.
 *
 * WHY COPYFILE_EXCL: it fails with EEXIST instead of replacing, atomically, so even a file that
 * appears between our tries is never overwritten — we just move on to the next number.
 */
export async function copyBeside(from: string, allow: (candidate: string) => Promise<string>): Promise<string> {
  const dir = path.dirname(from);
  const name = path.basename(from);
  for (let n = 1; n <= MAX_COPIES; n++) {
    const target = await allow(path.join(dir, copyName(name, n)));
    try {
      await fsp.copyFile(from, target, fsc.COPYFILE_EXCL);
      return target;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      // A half-written copy (disk full) must not stay behind looking like a real file.
      await fsp.rm(target, { force: true }).catch(() => {});
      throw e;
    }
  }
  throw new NameTaken();
}
