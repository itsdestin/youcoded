// The new-session folder picker's five operations, shared by BOTH transports.
//
// WHY this module exists (Destin, 2026-09-11, phone test of remote access batches 2/3:
// "the project selector for new sessions isn't listing my projects?"): remote-server.ts
// carried its own hand-copied versions of the folders:* handlers. When the desktop handler
// learned to list synced projects (~/YouCoded/Projects) and to remove case-insensitively on
// Windows, the copy never did, so a phone saw only the saved-folders file. ipc-handlers.ts
// and remote-server.ts are now two callers of these functions — the same pattern as
// artifacts/read-service.ts. tests/folders-service.test.ts pins the behaviour; the ast-grep
// rules no-folders-json-outside-service and folders-service-called-by-both-transports
// (youcoded-dev scripts/ast-grep/rules/) guard against a copy coming back.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readFolders, writeFolders, homeIsAppPrivate, withoutPrivateHome, pathKey, type SavedFolder } from './saved-folders';
import { folderUsage, noteProjectUsed } from './folder-usage';
import { getManagedRoots, isRemovedProject } from './sync-spaces/service';
import { PROJECT_DESCRIPTION_MAX } from '../shared/artifacts/types';

import type { PickerFolder } from '../shared/prefs-types';
export type { PickerFolder };

// WHY: one shared comparison (saved-folders.ts pathKey) so every site agrees on what "same folder" means.
const keyOf = pathKey;

/** A synced project (a folder directly in ~/YouCoded/Projects) that was removed from every
 *  device's lists (sync-spaces service, backlog row 10). Its folder is still on disk. */
function isRemovedManaged(folderPath: string): boolean {
  const root = getManagedRoots()?.projectsRoot;
  if (!root || keyOf(path.dirname(folderPath)) !== keyOf(root)) return false;
  return isRemovedProject(path.basename(path.resolve(folderPath)));
}

/** Whether a project at this path stays off the lists: removed everywhere, and not added back
 *  on this computer since (Add a project marks the saved entry `readded`). Project View's list
 *  (artifacts/projects-index.ts) asks the same question. */
export function isRemovedFromLists(folderPath: string, saved: SavedFolder[]): boolean {
  if (!isRemovedManaged(folderPath)) return false;
  const k = keyOf(folderPath);
  return !saved.some((f) => f.readded && keyOf(f.path) === k);
}

/** Saved folders (seeded with Home on first use), then every synced project not already saved. */
export function listPickerFolders(file?: string): PickerFolder[] {
  let folders = readFolders(file);
  if (folders.length === 0 && !homeIsAppPrivate()) {
    folders = [{ path: os.homedir(), nickname: 'Home', addedAt: Date.now() }];
    writeFolders(folders, file);
  }
  // The phone never lists its app-private home (saved-folders.ts → homeIsAppPrivate).
  folders = withoutPrivateHome(folders);
  // A synced project removed on any device leaves this list too (backlog row 10) — saved
  // entries for it (the import flow writes one) and its synthesized row below.
  const saved = folders;
  folders = folders.filter((f) => !isRemovedFromLists(f.path, saved));
  // A saved folder that lives under ~/YouCoded/Projects/ IS a managed sync project (the import
  // flow rewrites saved entries to their new managed path) — badge it like the synthesized rows.
  const projectsRoot = getManagedRoots()?.projectsRoot;
  const projectsPrefix = projectsRoot ? pathKey(projectsRoot) + path.sep : null;
  const result: PickerFolder[] = folders.map((f) => ({
    ...f,
    exists: fs.existsSync(f.path),
    ...(projectsPrefix && pathKey(f.path).startsWith(projectsPrefix) ? { managed: true as const } : {}),
  }));
  // Managed projects (sync spec §3) always appear in the picker, deduped against saved folders by
  // normalized path. addedAt:0 sorts them below user-added folders.
  const managed = getManagedRoots()?.listProjects() ?? [];
  const known = new Set(result.map((f) => pathKey(f.path)));
  // Last-use stamps of synced projects live in their own small file (saved-folders.ts usageFilePath), applied here to the rows
  // that are only synthesized, so a project used most recently sorts first without ever becoming a saved folder.
  const usage = managed.length ? folderUsage(file) : {};
  for (const p of managed) {
    if (isRemovedFromLists(p.path, saved)) continue;
    if (!known.has(pathKey(p.path))) {
      const at = usage[pathKey(p.path)];
      result.push({ path: p.path, nickname: p.name, addedAt: 0, exists: true, managed: true, ...(at ? { lastUsedAt: at } : {}) });
    }
  }
  // Card #143 b: most recently used first. A stable sort, so folders never used (no stamp) keep the order they always had,
  // and the synced projects appended above (addedAt 0) stay last among them.
  return result.map((f, i) => ({ f, i })).sort((a, b) => ((b.f.lastUsedAt ?? 0) - (a.f.lastUsedAt ?? 0)) || a.i - b.i).map((x) => x.f);
}

/** Stamp a folder as just used (a session the person started in it): a saved folder on its own entry, a synced project in the usage file.
 *  A start in a one-off folder (neither) must not add it to the list. Never throws. */
export function noteFolderUsed(folderPath: unknown, file?: string): void {
  try {
    if (typeof folderPath !== 'string' || !folderPath) return;
    const folders = readFolders(file);
    const entry = folders.find((f) => keyOf(f.path) === keyOf(folderPath));
    if (entry) {
      entry.lastUsedAt = Date.now();
      writeFolders(folders, file);
      return;
    }
    // Not saved: a synced project is still a row in the picker, so it is stamped too, in its own file and WITHOUT being saved. A one-off
    // folder that is neither saved nor a project gets nothing. Stamps of projects that no longer exist are dropped on every write.
    const projects = getManagedRoots()?.listProjects() ?? [];
    const here = projects.find((p) => keyOf(p.path) === keyOf(folderPath));
    if (!here || isRemovedFromLists(here.path, folders)) return;
    noteProjectUsed(keyOf(here.path), new Set(projects.map((p) => keyOf(p.path))), file);
  } catch { /* an unwritable list must never stop a session from starting */ }
}

export function addFolder(folderPath: string, nickname: string | undefined, file?: string): SavedFolder {
  const folders = readFolders(file);
  const normalized = path.resolve(folderPath);
  // WHY pathKey (not ===): on Windows/macOS /Users/me/Docs and /Users/me/docs are the same folder,
  // so adding the other spelling must find the saved entry instead of making a second one.
  const existing = folders.find((f) => pathKey(f.path) === pathKey(normalized));
  // Adding a removed synced project's folder back lists it on THIS computer again (backlog
  // row 10). Sync stays stopped — a stop is permanent — so it shows as "Sync stopped".
  const readd = isRemovedManaged(normalized);
  if (existing) {
    if (readd && !existing.readded) { existing.readded = true; writeFolders(folders, file); }
    return existing;
  }
  const entry: SavedFolder = { path: normalized, nickname: nickname || path.basename(normalized), addedAt: Date.now(), ...(readd ? { readded: true as const } : {}) };
  folders.unshift(entry);
  writeFolders(folders, file);
  return entry;
}

export function removeFolder(folderPath: string, file?: string): boolean {
  const folders = readFolders(file);
  // Case-insensitive on Windows/macOS via pathKey: Project View passes the project's CANONICAL
  // path (lowercase drive, c:\…) while the store holds the path.resolve form (C:\…).
  const samePath = (a: string, b: string) => pathKey(a) === pathKey(b);
  const normalized = path.resolve(folderPath);
  const filtered = folders.filter((f) => !samePath(path.resolve(f.path), normalized));
  if (filtered.length === folders.length) return false;
  writeFolders(filtered, file);
  return true;
}

export function renameFolder(folderPath: string, nickname: string, file?: string): boolean {
  const folders = readFolders(file);
  const normalized = path.resolve(folderPath);
  // WHY pathKey: same case-blind match as add/remove, so the other casing still finds the entry.
  const entry = folders.find((f) => pathKey(f.path) === pathKey(normalized));
  if (!entry) return false;
  entry.nickname = nickname;
  writeFolders(folders, file);
  return true;
}

export function setFolderDescription(folderPath: string, description: string, file?: string): boolean {
  const folders = readFolders(file);
  const normalized = path.resolve(folderPath);
  // WHY pathKey: same case-blind match as add/remove, so the other casing still finds the entry.
  const entry = folders.find((f) => pathKey(f.path) === pathKey(normalized));
  if (!entry) return false;
  // Trim + cap here as well as in the UI: the renderer is a mirror, never the boundary. String(…
  // ?? '') so a null/undefined caller throws on neither transport.
  entry.description = String(description ?? '').trim().slice(0, PROJECT_DESCRIPTION_MAX) || null;
  writeFolders(folders, file);
  return true;
}
