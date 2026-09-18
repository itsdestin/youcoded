// folder-listing — ONE folder of a project, read straight from disk, a page at
// a time (artifacts:list-folder). Powers Project Files' folder view.
//
// WHY this exists (Project Files at any size, Stage 1, spec 2026-09-18): the
// folder view used to be carved out of the whole-project discovery walk
// (project-file-discovery.ts), so it inherited that walk's caps — 2,000 files,
// 6 levels, 1.5 s — and its skip rules. A file 7 levels down, inside a
// dot-folder, a build folder or a nested git repo simply never appeared, and a
// home folder or drive needed a "Browse anyway" button before anything showed.
// Listing the ONE folder being looked at needs none of that: it is a single
// readdir, whatever the size of the tree around it. The filesystem is the
// truth here — this never consults an index or a cache to decide what exists.
//
// What is NOT listed, and why:
//  - symlinks — never followed anywhere in Project Files (a link can point
//    outside the project, or at itself); same as discovery.
//  - credential locations (.ssh, .aws, .netrc …) — the set artifacts:get
//    already refuses to read (protectedReadPath). Listing names it could never
//    open would only advertise them, over remote access included.
//  - `.youcoded-import-*.part` — an import's own temp file (import-file.ts),
//    not a document; discovery and sync hide it for the same reason.
// Everything else is listed, including dot-folders, node_modules and nested
// repos: those are excluded from whole-project SEARCH (discovery), never from
// browsing.
//
// Tracked files need no separate union here (projectAllFiles unions them into
// discovery because discovery can miss them): a tracked file that still exists
// is an ordinary entry of the folder it lives in, so readdir lists it.
import fs from 'fs';
import path from 'path';
import { canonicalize } from '../../shared/artifacts/canonicalize';
import { protectedReadPath } from '../../shared/artifacts/editable-path-policy';
import {
  FOLDER_PAGE_SIZE, FOLDER_SAMPLE_FILES, type FolderPage, type FolderSort, type FolderSummary,
} from '../../shared/artifacts/folder-page';
import { discoveredFileRecord } from './project-file-discovery';
import { authorizeArtifactRead } from './write-authorization';

/** Entries per page when the caller names none (shared), and the most one call returns. */
const MAX_PAGE_SIZE = 1000;
/** Parallel stats. 100,000 unbounded stats measured 1.2 s and ~500 MB (Stage 0). */
const STAT_CONCURRENCY = 64;

interface Entry { name: string; isDir: boolean; mtimeMs?: number }
interface Snapshot { ts: number; realDir: string; files: Entry[]; folders: Entry[] }

// Later pages of one listing read from the snapshot page 0 took, so paging
// through a folder that changes under you never repeats or skips an entry.
// Page 0 always re-reads the disk: opening or refreshing a folder is never
// served from here. Small and short-lived — it holds names, not records.
const snapshots = new Map<string, Snapshot>();
const SNAPSHOT_TTL_MS = 60_000;
const MAX_SNAPSHOTS = 16;

function snapshotKey(root: string, rel: string, sort: FolderSort): string {
  return `${canonicalize(root, null)}\0${rel}\0${sort}`;
}

function isImportTemp(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('.youcoded-import-') && lower.endsWith('.part');
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The listable entries of one directory, unsorted. Throws the fs error. */
async function readEntries(absDir: string): Promise<{ files: Entry[]; folders: Entry[] }> {
  const dirents = await fs.promises.readdir(absDir, { withFileTypes: true });
  const files: Entry[] = [];
  const folders: Entry[] = [];
  for (const d of dirents) {
    if (d.isSymbolicLink()) continue;
    if (isImportTemp(d.name)) continue;
    if (protectedReadPath(canonicalize(path.join(absDir, d.name), null))) continue;
    if (d.isDirectory()) folders.push({ name: d.name, isDir: true });
    else if (d.isFile()) files.push({ name: d.name, isDir: false });
    // sockets, fifos, devices: not documents, nothing to open
  }
  return { files, folders };
}

const byName = (a: Entry, b: Entry) => a.name.localeCompare(b.name);

// A child's id. Built with canonicalize() exactly as discovery builds its ids
// (separators, NFC), so a file reached by browsing and the same file reached
// by search or a chat link are ONE record — the open file, its thumbnail
// cache and its "active" highlight all key on this string.
function relId(relDir: string, name: string): string {
  // Any non-null root works: the input is already relative, so canonicalize
  // only normalises it (it strips a root prefix only from absolute paths).
  return canonicalize(relDir ? `${relDir}/${name}` : name, '/');
}

async function statInto(absDir: string, entries: Entry[]): Promise<void> {
  await mapLimit(entries, STAT_CONCURRENCY, async (e) => {
    if (e.mtimeMs !== undefined) return;
    try { e.mtimeMs = (await fs.promises.stat(path.join(absDir, e.name))).mtimeMs; }
    catch { /* gone between readdir and stat — shows with no date */ }
  });
}

function errorFor(e: any): FolderPage {
  const code: string | undefined = e?.code;
  if (code === 'ENOENT') return { ok: false, error: 'not-found' };
  if (code === 'ENOTDIR') return { ok: false, error: 'not-a-folder' };
  if (code === 'EACCES' || code === 'EPERM') return { ok: false, error: 'permission-denied' };
  return { ok: false, error: 'unavailable', detail: code ?? String(e?.message ?? e) };
}

/** A subfolder's card data: one readdir of IT, never deeper. */
async function summarize(absDir: string, relDir: string, name: string): Promise<FolderSummary> {
  const rel = relId(relDir, name);
  try {
    const inner = await readEntries(path.join(absDir, name));
    const samples = inner.files.sort(byName).slice(0, FOLDER_SAMPLE_FILES)
      .map((f) => discoveredFileRecord(relId(rel, f.name), ''));
    return { name, path: rel, itemCount: inner.files.length + inner.folders.length, samples };
  } catch {
    // Unreadable subfolder: still listed (it exists), just without contents.
    // Opening it shows the real reason (permission-denied etc.).
    return { name, path: rel, samples: [] };
  }
}

/**
 * List one folder of a project, one page at a time.
 *
 * `relDir` is project-relative with forward slashes ('' = the project folder
 * itself). Order: files first (by name, or newest first for 'recent'), then
 * folders by name — the order Project Files has always used.
 */
export async function listFolderPage(
  projectRoot: unknown,
  relDir: unknown,
  opts?: { sort?: FolderSort; offset?: number; limit?: number },
): Promise<FolderPage> {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0 || typeof relDir !== 'string') {
    return { ok: false, error: 'bad-request' };
  }
  const sort: FolderSort = opts?.sort === 'recent' ? 'recent' : 'name';
  const offset = Number.isInteger(opts?.offset) && (opts!.offset as number) > 0 ? (opts!.offset as number) : 0;
  const limit = Number.isInteger(opts?.limit) && (opts!.limit as number) > 0
    ? Math.min(opts!.limit as number, MAX_PAGE_SIZE) : FOLDER_PAGE_SIZE;

  // Inside the project? Decided with path.relative on the same string every
  // disk call uses — the reasoning resolveArtifactPath (read-service.ts)
  // records: canonicalize() would treat `\` as a separator where Linux does not.
  const rel = relDir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const absDir = path.resolve(projectRoot, rel);
  const back = path.relative(path.resolve(projectRoot), absDir);
  if (back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
    return { ok: false, error: 'outside-project' };
  }

  const key = snapshotKey(projectRoot, rel, sort);
  let snap = offset > 0 ? snapshots.get(key) : undefined;
  if (snap && Date.now() - snap.ts > SNAPSHOT_TTL_MS) snap = undefined;

  if (!snap) {
    // Same realpath + in-folder + protected-path check artifacts:get applies,
    // so a link partway along the path cannot lead the listing out of the
    // project (the entries themselves are never links — see readEntries).
    try {
      const auth = await authorizeArtifactRead(projectRoot, absDir, true);
      if (!auth.ok) {
        if ('orphan' in auth) return { ok: false, error: 'not-found' };
        return { ok: false, error: auth.error === 'protected-path' ? 'protected-path' : 'outside-project' };
      }
      const { files, folders } = await readEntries(auth.realPath);
      folders.sort(byName);
      if (sort === 'recent') {
        // Newest first needs every file's time before the first page can be
        // cut. Measured (Stage 0): 100,000 files ≈ 1.2 s, 10,000 ≈ 0.13 s.
        await statInto(auth.realPath, files);
        files.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0) || byName(a, b));
      } else {
        files.sort(byName);
      }
      snap = { ts: Date.now(), realDir: auth.realPath, files, folders };
      snapshots.delete(key);
      snapshots.set(key, snap);
      while (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value as string);
    } catch (e) {
      return errorFor(e);
    }
  }

  const total = snap.files.length + snap.folders.length;
  const end = Math.min(offset + limit, total);
  const pageFiles = snap.files.slice(Math.min(offset, snap.files.length), Math.min(end, snap.files.length));
  const folderStart = Math.max(0, offset - snap.files.length);
  const folderEnd = Math.max(0, end - snap.files.length);
  const pageFolders = snap.folders.slice(folderStart, folderEnd);

  // Name order only needs the times of the files actually shown.
  await statInto(snap.realDir, pageFiles);
  const files = pageFiles.map((f) => discoveredFileRecord(
    relId(rel, f.name),
    f.mtimeMs !== undefined ? new Date(f.mtimeMs).toISOString() : '',
  ));
  const folders = await mapLimit(pageFolders, 16, (f) => summarize(snap!.realDir, rel, f.name));
  return { ok: true, files, folders, total, offset, hasMore: end < total };
}

/** Test seam: forget every paging snapshot. */
export function clearFolderSnapshots(): void {
  snapshots.clear();
}
