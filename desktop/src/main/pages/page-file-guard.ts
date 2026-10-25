// What a page's file access may touch, decided on the REAL path (pages-finish step 2;
// files design review 1, findings 1–4, 18–20).
//
// A page never holds a path: YouCoded does every read and write here. Four things make
// "only what was approved" true rather than stated:
//   1. Names are cleaned before anything touches the disk: no `..`, no `:` (Windows
//      streams, drive letters), no NUL, no trailing dot or space, no Windows device names.
//   2. The folder (or home, for the `all` level) is re-resolved on EVERY call, and the
//      file's real path must stay inside it — so a folder later swapped for a link to
//      home, or a link planted inside, cannot lead out.
//   3. Files are opened without following a final link and then checked by identity
//      (device + inode before and after the open must agree; regular files only, so a
//      pipe or a device can never hang or flood the app). At folder level a file with
//      several hard links is refused: a hard link has an innocent name and a secret's
//      contents, and no path check can see it.
//   4. Two deny lists: secrets that are never READ (the phone's list plus files-only
//      extras), and places that are never WRITTEN because a write there becomes code that
//      runs later (shell start-up files, autostart, YouCoded's own folders, the page's).
//
// Honest residual: a PARENT folder swapped for a link between its realpath and the
// open of a file inside it. Node has no openat(); the identity check still catches a
// final-component swap, and the window is a few microseconds on folders the person chose.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { canonicalize } from '../../shared/artifacts/canonicalize';
import { isPhoneDeniedPath } from '../harness/tools/credential-paths';

/** Case-insensitive file systems compare paths without case (Windows, macOS default). */
const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin';
const fold = (p: string) => (FOLD_CASE ? p.toLowerCase() : p);

/** `child` is `root` or inside it. Both canonical. */
function within(child: string, root: string): boolean {
  const c = fold(child).replace(/\/+$/, '');
  const r = fold(root).replace(/\/+$/, '');
  return c === r || c.startsWith(r === '' ? '/' : `${r}/`);
}

/** Folders YouCoded keeps for itself, and the page's own folder: never written by a page,
 *  and never chosen as a page's folder. Canonical real paths. */
export interface GuardContext {
  home: string;
  protectedRoots: string[];
}

export async function guardContext(protectedRoots: string[], homeDir = os.homedir()): Promise<GuardContext> {
  const set = homeDir;
  const real = await fs.promises.realpath(set).catch(() => set);
  const roots = await Promise.all(protectedRoots.map(async (r) => canonicalize(await fs.promises.realpath(r).catch(() => r), null)));
  return { home: canonicalize(real, null), protectedRoots: roots };
}

// ── Names ───────────────────────────────────────────────────────────────────────────

const WINDOWS_DEVICES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** One path segment a person or a page may name. */
export function badSegment(seg: string): boolean {
  return seg === '' || seg === '.' || seg === '..' || seg.length > 255 || /[\0:\\/]/.test(seg)
    || /[. ]$/.test(seg) || WINDOWS_DEVICES.test(seg) || seg.normalize('NFC') !== seg;
}

/** A path relative to a folder ("Photos/2026/a.jpg") as segments, or null. */
export function cleanRelative(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  if (raw === '' || raw === '.') return [];
  if (raw.startsWith('/') || raw.startsWith('~') || /^[a-z]:/i.test(raw)) return null;
  const segs = raw.split('/');
  return segs.some(badSegment) ? null : segs;
}

/** An `all`-level path: `~/x`, or absolute under home, as segments under home; or null. */
export function cleanUnderHome(raw: unknown, home: string): string[] | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  if (raw === '~' || raw === '~/') return [];
  if (raw.startsWith('~/')) return cleanRelative(raw.slice(2));
  const abs = canonicalize(raw, null).replace(/\/+$/, '');
  const h = home.replace(/\/+$/, '');
  if (fold(abs) === fold(h)) return [];
  if (!within(abs, h)) return null;
  return cleanRelative(abs.slice(h.length + 1));
}

// ── Deny lists ──────────────────────────────────────────────────────────────────────

/** Read-denied beyond the phone's list, for pages only (the phone list stays as pinned). */
const FILES_READ_DENY_SEGMENTS = new Set(['.var', 'snap', '1password', 'keepassxc', 'bitwarden', 'signal', 'slack', 'discord', '.terraform.d']);
const FILES_READ_DENY_EXTENSIONS = ['.keystore', '.jks', '.ovpn', '.kdb', '.asc', '.gpg', '.ppk'];
const FILES_READ_DENY_BASENAMES = new Set(['wallet.dat', '.bashrc', '.zshrc', '.profile', '.bash_profile', '.zprofile', '.zshenv', 'config.fish']);

export function isReadDenied(canonical: string, ctx: GuardContext): boolean {
  if (isPhoneDeniedPath(canonical, ctx.home)) return true;
  // YouCoded's own folders (its settings, other pages' folders and data) are never read by a
  // page either, not only never written (code review 1, finding 3).
  if (ctx.protectedRoots.some((r) => within(canonical, r))) return true;
  const c = canonical.toLowerCase();
  const parts = c.split('/');
  const base = parts[parts.length - 1] ?? '';
  // `.env` and every variant: a project's secrets (review finding 2).
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (base.startsWith('secrets.')) return true;
  if (FILES_READ_DENY_BASENAMES.has(base)) return true;
  if (FILES_READ_DENY_EXTENSIONS.some((e) => base.endsWith(e))) return true;
  return parts.some((seg) => FILES_READ_DENY_SEGMENTS.has(seg));
}

/** Places a write turns into code that runs later, relative to home (review finding 1). */
const WRITE_DENY_UNDER_HOME = [
  '.bashrc', '.bash_profile', '.bash_login', '.profile', '.zshrc', '.zprofile', '.zshenv', '.zlogin', '.xprofile', '.xinitrc', '.xsession',
  '.config/fish/', '.config/autostart/', '.config/systemd/', '.config/environment.d/', '.config/plasma-workspace/', '.local/bin/',
  '.local/share/applications/', '.claude/', '.ssh/', 'library/launchagents/', 'library/application support/youcoded',
  'appdata/roaming/microsoft/windows/start menu/programs/startup/', '.gitconfig', '.npmrc', 'bin/', 'go/bin/',
];
/** At the `all` level, whole trees of app and system settings: on Windows `AppData` (Start Menu,
 *  npm's folder on PATH, WindowsApps…), on macOS `Library` — a write there can run later (code
 *  review 1, finding 1). */
const ALL_LEVEL_WRITE_DENY_TREES = ['appdata/', 'library/'];

/** How a write was reached: a file the person `chosen` in an Open/Save window, inside an
 *  approved `folder`, or anywhere at the `all` level. Only `all` is confined to home: a
 *  chosen file may live on a USB drive, and a folder was already checked when chosen. */
export type WriteLevel = 'chosen' | 'folder' | 'all';

export function isWriteDenied(canonical: string, ctx: GuardContext, level: WriteLevel): boolean {
  if (isReadDenied(canonical, ctx)) return true;
  if (ctx.protectedRoots.some((r) => within(canonical, r))) return true;
  if (!within(canonical, ctx.home)) return level !== 'chosen';
  const rel = canonical.slice(ctx.home.replace(/\/+$/, '').length + 1).toLowerCase();
  if (WRITE_DENY_UNDER_HOME.some((p) => (p.endsWith('/') ? `${rel}/`.startsWith(p) : rel === p || rel.startsWith(`${p}/`)))) return true;
  // Every hidden folder or file directly under home is configuration (.vimrc, .bash_logout,
  // .config…): never written, at any level — a Save window included (code review 1, finding 2).
  if (rel.startsWith('.')) return true;
  if (level === 'all' && ALL_LEVEL_WRITE_DENY_TREES.some((t) => `${rel}/`.startsWith(t))) return true;
  return false;
}

/** Why a folder may not be a page's folder, or null when it may (review finding 4). */
export function folderChoiceProblem(canonical: string, ctx: GuardContext): string | null {
  if (!within(canonical, ctx.home) || canonical.replace(/\/+$/, '') === ctx.home.replace(/\/+$/, '')) {
    return 'Pick a folder inside your home folder, not your home folder itself or anything outside it.';
  }
  if (isReadDenied(canonical, ctx) || ctx.protectedRoots.some((r) => within(canonical, r) || within(r, canonical))) {
    return 'That folder holds passwords, keys or YouCoded’s own files, so a page cannot be given it.';
  }
  const rel = canonical.slice(ctx.home.replace(/\/+$/, '').length + 1).toLowerCase();
  if (rel.split('/')[0]?.startsWith('.')) return 'Pick an ordinary folder, not a hidden settings folder.';
  return null;
}

// ── Opening, confined ───────────────────────────────────────────────────────────────

const NOFOLLOW = (fs.constants as Record<string, number | undefined>).O_NOFOLLOW ?? 0;
/** WHY non-blocking: a file swapped for a pipe between the check and the open would otherwise
 *  hang a worker thread forever (code review 1, finding 10). Harmless for a regular file. */
const NONBLOCK = (fs.constants as Record<string, number | undefined>).O_NONBLOCK ?? 0;

export type Refused = { refused: string };
const refuse = (refused: string): Refused => ({ refused });

/** The root re-resolved now, and the target's real path inside it. A file that does
 *  not exist yet resolves through its parent. */
export async function resolveInside(root: string, segs: string[]): Promise<{ rootReal: string; real: string; exists: boolean } | Refused> {
  const rootReal = canonicalize(await fs.promises.realpath(root).catch(() => ''), null);
  if (!rootReal) return refuse('That folder is no longer there.');
  const target = path.join(rootReal, ...segs);
  const real = await fs.promises.realpath(target).catch(() => null);
  if (real) {
    const c = canonicalize(real, null);
    return within(c, rootReal) ? { rootReal, real: c, exists: true } : refuse('That file is outside what this page may reach.');
  }
  if (segs.length === 0) return refuse('That folder is no longer there.');
  const parentReal = await fs.promises.realpath(path.join(rootReal, ...segs.slice(0, -1))).catch(() => null);
  if (!parentReal) return refuse('That folder is no longer there.');
  const p = canonicalize(parentReal, null);
  if (!within(p, rootReal)) return refuse('That file is outside what this page may reach.');
  return { rootReal, real: `${p.replace(/\/+$/, '')}/${segs[segs.length - 1]}`, exists: false };
}

/** `created`: the file was made just now (empty), so a failed write may remove it again. */
export interface Opened { fh: fs.promises.FileHandle; real: string; size: number; dev: number; ino: number; created?: boolean }

/** Open an existing regular file inside `root` for reading. */
/** `named`: false for a file the person chose themselves (its real name may hold a `:` or a
 *  trailing dot), true for a path the page wrote, whose every segment must be clean. */
export async function openForRead(root: string, segs: string[], ctx: GuardContext, folderLevel: boolean, named = true): Promise<Opened | Refused> {
  if (named && segs.some(badSegment)) return refuse('That name cannot be used.');
  const r = await resolveInside(root, segs);
  if ('refused' in r) return r;
  if (!r.exists) return refuse('That file is not there any more.');
  if (isReadDenied(r.real, ctx)) return refuse('That file holds passwords or keys, so pages never see it.');
  return openChecked(r.real, fs.constants.O_RDONLY, folderLevel);
}

/** Open a file inside `root` for writing: `new` refuses an existing one, `replace` needs one. */
export async function openForWrite(root: string, segs: string[], ctx: GuardContext, level: WriteLevel, mode: 'new' | 'replace'): Promise<Opened | Refused> {
  if (segs.some(badSegment)) return refuse('That name cannot be used.');
  const r = await resolveInside(root, segs);
  if ('refused' in r) return r;
  if (isWriteDenied(r.real, ctx, level)) return refuse('Pages cannot change that file or folder.');
  if (mode === 'new') {
    if (r.exists) return refuse('A file with that name is already there.');
    // `wx` fails on anything already at that name, a planted link included.
    let fh: fs.promises.FileHandle;
    try { fh = await fs.promises.open(r.real, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o644); }
    catch { return refuse('The file could not be created there.'); }
    const st = await fh.stat();
    return { fh, real: r.real, size: 0, dev: st.dev, ino: st.ino, created: true };
  }
  if (!r.exists) return refuse('That file is not there any more.');
  return openChecked(r.real, fs.constants.O_WRONLY | NOFOLLOW, level === 'folder');
}

/** Open a resolved path and prove it is the regular file that was checked. */
async function openChecked(real: string, flags: number, folderLevel: boolean): Promise<Opened | Refused> {
  const before = await fs.promises.lstat(real).catch(() => null);
  if (!before?.isFile()) return refuse('Only ordinary files can be opened by a page.');
  let fh: fs.promises.FileHandle;
  try { fh = await fs.promises.open(real, flags | NOFOLLOW | NONBLOCK); } catch { return refuse('That file could not be opened.'); }
  const st = await fh.stat().catch(() => null);
  if (!st || !st.isFile() || st.dev !== before.dev || st.ino !== before.ino || (folderLevel && st.nlink > 1)) {
    await fh.close().catch(() => {});
    return refuse('That file changed while it was being opened, so the app stopped.');
  }
  return { fh, real, size: st.size, dev: st.dev, ino: st.ino };
}

/** The entries of a folder inside `root`: folders and regular files, denied ones left out,
 *  hidden ones left out, at most `limit`. Stats in batches so a big folder does not starve
 *  the app's other file work (review finding 10). */
export async function listInside(root: string, segs: string[], ctx: GuardContext, limit: number): Promise<{ entries: Array<{ name: string; kind: 'folder' | 'file'; size?: number; modified?: string }>; more: boolean } | Refused> {
  if (segs.some(badSegment)) return refuse('That name cannot be used.');
  const r = await resolveInside(root, segs);
  if ('refused' in r) return r;
  if (!r.exists) return refuse('That folder is not there any more.');
  // A secrets folder is not listed at all, not even as empty.
  if (isReadDenied(r.real, ctx)) return refuse('That folder holds passwords or keys, so pages never see it.');
  let dirents: fs.Dirent[];
  try { dirents = await fs.promises.readdir(r.real, { withFileTypes: true }); } catch { return refuse('That folder could not be read.'); }
  const visible = dirents.filter((d) => !d.name.startsWith('.') && (d.isDirectory() || d.isFile()) && !badSegment(d.name)
    && !isReadDenied(`${r.real.replace(/\/+$/, '')}/${d.name}`, ctx));
  const kept = visible.slice(0, limit);
  const out: Array<{ name: string; kind: 'folder' | 'file'; size?: number; modified?: string }> = [];
  for (let i = 0; i < kept.length; i += 32) {
    const batch = await Promise.all(kept.slice(i, i + 32).map(async (d) => {
      if (d.isDirectory()) return { name: d.name, kind: 'folder' as const };
      const st = await fs.promises.stat(path.join(r.real, d.name)).catch(() => null);
      return st ? { name: d.name, kind: 'file' as const, size: st.size, modified: st.mtime.toISOString() } : null;
    }));
    for (const e of batch) if (e) out.push(e);
  }
  return { entries: out, more: visible.length > limit };
}
