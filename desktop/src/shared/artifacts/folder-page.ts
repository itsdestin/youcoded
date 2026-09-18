// The shape of artifacts:list-folder — one folder of a project, one page at a
// time. The desktop answers it from disk (main/artifacts/folder-listing.ts);
// the workbench and the renderer tests answer it from a flat list of records
// with folderPageFromRecords below, so all three agree on order and paging.
import type { ArtifactRecord } from './types';

export type FolderSort = 'name' | 'recent';

/** A subfolder as its card shows it: direct contents only (no recursive walk). */
export interface FolderSummary {
  name: string;
  /** Project-relative, forward slashes. */
  path: string;
  /** Entries directly inside it; absent when it could not be read. */
  itemCount?: number;
  /** Its first few files by name, for the card's filename preview. */
  samples: ArtifactRecord[];
}

type FolderListError =
  | 'bad-request'        // malformed call
  | 'not-found'          // nothing at that path (deleted, or a drive not connected)
  | 'not-a-folder'       // something is there, but it is a file
  | 'outside-project'    // the path (or a link on it) leaves the project folder
  | 'protected-path'     // a credential location artifacts:get also refuses
  | 'permission-denied'  // the operating system refused to list it
  | 'unavailable';       // any other filesystem failure; `detail` carries its code

export type FolderPage =
  | {
      ok: true;
      /** Files come before folders; this is this page's share of each. */
      files: ArtifactRecord[];
      folders: FolderSummary[];
      /** Every listed entry in the folder (files + folders). */
      total: number;
      offset: number;
      hasMore: boolean;
      /** Pass back with later pages so they read the same listing. */
      snapshot?: string;
      /** A later page whose listing had expired: re-read from the top. */
      restarted?: boolean;
    }
  | { ok: false; error: FolderListError; detail?: string };

/** Entries per page when the caller names none. */
export const FOLDER_PAGE_SIZE = 200;
/** Filenames previewed on a folder card. */
export const FOLDER_SAMPLE_FILES = 3;

const nameOf = (r: ArtifactRecord) => r.path.split('/').pop() ?? r.path;

/**
 * Answer a list-folder request from a flat list of project-relative records —
 * for the workbench and tests, which have no disk. Mirrors folder-listing.ts:
 * files first (by name, or newest first), then subfolders by name, each
 * counting its DIRECT entries; a folder with nothing under it is not-found.
 */
export function folderPageFromRecords(
  records: readonly ArtifactRecord[],
  relDir: string,
  opts?: { sort?: FolderSort; offset?: number; limit?: number },
): FolderPage {
  const dir = relDir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const prefix = dir ? `${dir}/` : '';
  const files: ArtifactRecord[] = [];
  const inner = new Map<string, { names: Set<string>; files: ArtifactRecord[] }>();
  for (const r of records) {
    if (r.kind !== 'internal') continue;
    const p = r.path.replace(/\\/g, '/');
    if (prefix && !p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    if (slash === -1) { files.push(r); continue; }
    const name = rest.slice(0, slash);
    const child = rest.slice(slash + 1);
    const entry = inner.get(name) ?? { names: new Set<string>(), files: [] };
    entry.names.add(child.split('/')[0]);
    if (!child.includes('/')) entry.files.push(r);
    inner.set(name, entry);
  }
  if (dir && files.length === 0 && inner.size === 0) return { ok: false, error: 'not-found' };
  files.sort(opts?.sort === 'recent'
    ? (a, b) => (b.lastModified || '').localeCompare(a.lastModified || '') || nameOf(a).localeCompare(nameOf(b))
    : (a, b) => nameOf(a).localeCompare(nameOf(b)));
  const folders: FolderSummary[] = [...inner.entries()]
    .map(([name, f]) => ({
      name,
      path: prefix + name,
      itemCount: f.names.size,
      samples: [...f.files].sort((a, b) => nameOf(a).localeCompare(nameOf(b))).slice(0, FOLDER_SAMPLE_FILES),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const total = files.length + folders.length;
  const offset = Math.max(0, opts?.offset ?? 0);
  const end = Math.min(offset + (opts?.limit ?? FOLDER_PAGE_SIZE), total);
  return {
    ok: true,
    files: files.slice(Math.min(offset, files.length), Math.min(end, files.length)),
    folders: folders.slice(Math.max(0, offset - files.length), Math.max(0, end - files.length)),
    total,
    offset,
    hasMore: end < total,
  };
}
