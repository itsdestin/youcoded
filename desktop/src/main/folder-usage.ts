// folder-usage.ts — when each SYNCED PROJECT was last used, for the new-session folder list (card #143 b, Destin Q-8: "if its synced,
// then shouldnt it be in the list?"). A synced project is only a row the picker synthesizes, so it must NOT become a saved folder
// (removal, "Sync stopped" and the import flow would see it); its stamps live in a small file beside the saved-folders file.
//
// WHY in memory (performance rule 1: the main process has one thread, and its blocking-call list may only shrink): the stamps are
// loaded ONCE with fs.promises and kept current here; the folder list reads the in-memory copy, and a change is written back with an
// async, atomic, coalesced write whose errors are swallowed — a slow or failing disk can never hold up, or stop, a session start.
// A list asked for before the first load finishes simply has no stamps for that one call (the folder handler awaits the load first).
import fs from 'fs';
import os from 'os';
import path from 'path';

interface Entry { stamps: Record<string, number>; loaded: Promise<void> | null; writing: Promise<void> | null; dirty: boolean }
const entries = new Map<string, Entry>();

function usagePath(foldersFile?: string): string {
  // Beside the saved-folders file (~/.claude/youcoded-folders.json by default); the default dir is the one saved-folders.ts uses.
  return path.join(foldersFile ? path.dirname(foldersFile) : path.join(os.homedir(), '.claude'), 'youcoded-folder-usage.json');
}

function entryFor(file: string): Entry {
  let e = entries.get(file);
  if (!e) { e = { stamps: {}, loaded: null, writing: null, dirty: false }; entries.set(file, e); }
  return e;
}

/** Load the stamps once (async). Safe to call every time; a missing or unreadable file means no stamps. */
export function loadFolderUsage(foldersFile?: string): Promise<void> {
  const file = usagePath(foldersFile);
  const e = entryFor(file);
  e.loaded ??= (async () => {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(file, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) if (typeof v === 'number' && Number.isFinite(v) && !(k in e.stamps)) e.stamps[k] = v;
      }
    } catch { /* no file yet, or unreadable: no stamps */ }
  })();
  return e.loaded;
}

/** The stamps as of now, from memory; {} until the first load finishes (the load is started here if nobody has). */
export function folderUsage(foldersFile?: string): Record<string, number> {
  void loadFolderUsage(foldersFile);
  return { ...entryFor(usagePath(foldersFile)).stamps };
}

/** Stamp one project key as used now, keeping only the keys in `liveKeys` (a project that no longer exists is dropped), and write it back. Never throws. */
export function noteProjectUsed(key: string, liveKeys: ReadonlySet<string>, foldersFile?: string): void {
  const file = usagePath(foldersFile);
  const e = entryFor(file);
  e.stamps[key] = Date.now();
  for (const k of Object.keys(e.stamps)) if (!liveKeys.has(k)) delete e.stamps[k];
  // Merge with what is on disk once the first load lands, then write. The memory copy is already current for readers.
  void loadFolderUsage(foldersFile).then(() => {
    for (const k of Object.keys(e.stamps)) if (!liveKeys.has(k)) delete e.stamps[k];
    schedule(file, e);
  });
}

function schedule(file: string, e: Entry): void {
  e.dirty = true;
  if (e.writing) return; // one writer at a time; it will pick the newest copy up
  e.writing = (async () => {
    while (e.dirty) {
      e.dirty = false;
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      try {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(tmp, JSON.stringify(e.stamps));
        await fs.promises.rename(tmp, file); // atomic: a reader never sees half a file
      } catch {
        await fs.promises.rm(tmp, { force: true }).catch(() => {});
      }
    }
  })().finally(() => { e.writing = null; });
}

/** Resolves when every write started so far has finished (tests, and a clean shutdown if ever wanted). */
export async function flushFolderUsage(foldersFile?: string): Promise<void> {
  const e = entryFor(usagePath(foldersFile));
  await e.loaded;
  while (e.writing) await e.writing;
}
