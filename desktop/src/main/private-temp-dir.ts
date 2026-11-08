// private-temp-dir.ts — make a folder in the shared temp area that only THIS user can use.
//
// WHY (security hardening 2026-10-30, local-listeners audit F6): the phone-upload and pasted-image folders
// were made with default permissions under the shared temp folder, with a name anyone can guess. On a computer
// with another account, that person could read the pictures and files the user attached, or create the folder
// FIRST (owned by them) so the app wrote into a folder they control and could swap a file before the assistant
// read it. Now: the folder is made owner-only (0700); if it already exists it must be a real folder (not a
// link) owned by this user, and gets tightened to 0700; otherwise it is refused. Windows has no such
// permission bits, so the check is skipped there (its temp folder is already per-user).
import fs from 'fs';

export async function ensurePrivateTempDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  const st = await fs.promises.lstat(dir);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (!st.isDirectory() || st.isSymbolicLink() || (uid !== undefined && st.uid !== uid)) {
    throw new Error(`Temporary folder ${dir} is not private to this user`);
  }
  if ((st.mode & 0o077) !== 0) await fs.promises.chmod(dir, 0o700);
}

/** A private folder at `dir`, or — when `dir` is taken by someone else — a fresh one with an
 *  unpredictable name next to it (mkdtemp). Returns the folder to use. */
export async function privateTempDirOrFresh(dir: string): Promise<string> {
  try {
    await ensurePrivateTempDir(dir);
    return dir;
  } catch {
    return fs.promises.mkdtemp(`${dir}-`);
  }
}
