// The file names directly inside one project folder, for the "+ Add file"
// duplicate-name check (ProjectView's computeImportCollisions).
//
// WHY its own module (code review 2026-09-18, F4/F5): the check used to page
// the whole folder with full records — a stat per file and a peek inside every
// subfolder, all thrown away — and had no test. This asks for names only, in
// pages of 1,000 read from ONE snapshot, and stops at the first page that
// reaches the folders: the listing sends every file before any folder, so
// nothing after that point can be a file.
import type { FolderPage } from '../../../shared/artifacts/folder-page';

type ListFolder = (
  projectId: string, relDir: string,
  opts: { offset: number; limit: number; namesOnly: true; snapshot?: string },
) => Promise<FolderPage | { ok: false; error: string }>;

/** Names, or null when the folder could not be read (the caller then treats
 *  nothing as a collision — main still refuses to replace anything unnamed). */
export async function folderFileNames(listFolder: ListFolder, projectId: string, relDir: string): Promise<Set<string> | null> {
  const names = new Set<string>();
  let offset = 0;
  let snapshot: string | undefined;
  for (;;) {
    const res = await listFolder(projectId, relDir, { offset, limit: 1000, namesOnly: true, snapshot });
    if (!res?.ok) return null;
    for (const f of res.files) names.add(f.path.split('/').pop() ?? f.path);
    if (!res.hasMore || res.folders.length > 0) return names;
    offset += res.files.length;
    snapshot = res.snapshot;
  }
}
