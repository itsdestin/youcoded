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
import { readFolders, writeFolders, type SavedFolder } from './saved-folders';
import { getManagedRoots, isRemovedProject } from './sync-spaces/service';
import { PROJECT_DESCRIPTION_MAX } from '../shared/artifacts/types';

export interface PickerFolder extends SavedFolder {
  exists: boolean;
  managed?: true;
}

const keyOf = (p: string) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

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
  if (folders.length === 0) {
    folders = [{ path: os.homedir(), nickname: 'Home', addedAt: Date.now() }];
    writeFolders(folders, file);
  }
  // A synced project removed on any device leaves this list too (backlog row 10) — saved
  // entries for it (the import flow writes one) and its synthesized row below.
  const saved = folders;
  folders = folders.filter((f) => !isRemovedFromLists(f.path, saved));
  // A saved folder that lives under ~/YouCoded/Projects/ IS a managed sync project (the import
  // flow rewrites saved entries to their new managed path) — badge it like the synthesized rows.
  const projectsRoot = getManagedRoots()?.projectsRoot;
  const projectsPrefix = projectsRoot ? path.resolve(projectsRoot).toLowerCase() + path.sep : null;
  const result: PickerFolder[] = folders.map((f) => ({
    ...f,
    exists: fs.existsSync(f.path),
    ...(projectsPrefix && path.resolve(f.path).toLowerCase().startsWith(projectsPrefix) ? { managed: true as const } : {}),
  }));
  // Managed projects (sync spec §3) always appear in the picker, deduped against saved folders by
  // normalized path. addedAt:0 sorts them below user-added folders.
  const managed = getManagedRoots()?.listProjects() ?? [];
  const known = new Set(result.map((f) => path.resolve(f.path).toLowerCase()));
  for (const p of managed) {
    if (isRemovedFromLists(p.path, saved)) continue;
    if (!known.has(path.resolve(p.path).toLowerCase())) {
      result.push({ path: p.path, nickname: p.name, addedAt: 0, exists: true, managed: true });
    }
  }
  return result;
}

export function addFolder(folderPath: string, nickname: string | undefined, file?: string): SavedFolder {
  const folders = readFolders(file);
  const normalized = path.resolve(folderPath);
  const existing = folders.find((f) => path.resolve(f.path) === normalized);
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
  // Case-insensitive on Windows: Project View passes the project's CANONICAL path (lowercase
  // drive, c:\…) while the store holds the path.resolve form (C:\…).
  const samePath = (a: string, b: string) =>
    process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  const normalized = path.resolve(folderPath);
  const filtered = folders.filter((f) => !samePath(path.resolve(f.path), normalized));
  if (filtered.length === folders.length) return false;
  writeFolders(filtered, file);
  return true;
}

export function renameFolder(folderPath: string, nickname: string, file?: string): boolean {
  const folders = readFolders(file);
  const normalized = path.resolve(folderPath);
  const entry = folders.find((f) => path.resolve(f.path) === normalized);
  if (!entry) return false;
  entry.nickname = nickname;
  writeFolders(folders, file);
  return true;
}

export function setFolderDescription(folderPath: string, description: string, file?: string): boolean {
  const folders = readFolders(file);
  const normalized = path.resolve(folderPath);
  const entry = folders.find((f) => path.resolve(f.path) === normalized);
  if (!entry) return false;
  // Trim + cap here as well as in the UI: the renderer is a mirror, never the boundary. String(…
  // ?? '') so a null/undefined caller throws on neither transport.
  entry.description = String(description ?? '').trim().slice(0, PROJECT_DESCRIPTION_MAX) || null;
  writeFolders(folders, file);
  return true;
}
