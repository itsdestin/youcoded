// Saves that quit had to give up on, kept until the next launch can say so (final review,
// finding 4). Kept in <userData>/office-abandoned-saves.json as a list of file paths.
//
// WHY: quit waits at most 5 s for Office saves (quitOfficeSessions), so a quit can never hang
// on a slow or wedged translator. A save still running past that is stopped, and the file stays
// as it was before that save — the edits since the last finished save are gone, and the app is
// gone too, so nothing could tell the person. The next launch shows the same toast a lost save
// shows while the app runs ("An Office document couldn't be saved"), once per file, then forgets.
//
// WHY paths: the list never leaves this machine or main; the renderer only uses a path to open
// that file in Office from the toast.
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { log } from '../logger';

const FILE = 'office-abandoned-saves.json';
/** WHY capped: this runs during quit, and a wedged disk must not turn into a quit that hangs. */
const RECORD_CAP_MS = 1_000;

let folder: string | null = null;
/** Where the list lives (registerOfficeIpc passes userData at startup). */
export function keepAbandonedSavesIn(userData: string): void {
  folder = userData;
}

const target = (dir: string) => path.join(dir, FILE);

async function readList(dir: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(target(dir), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p)) : [];
  } catch {
    return []; // missing (the usual case) or unreadable: nothing to report
  }
}

/** Add `paths` to the list (quit only). Never rejects, and gives up after 1 s. */
export async function recordAbandonedSaves(paths: string[], dir: string | null = folder): Promise<void> {
  if (paths.length === 0) return;
  log('WARN', 'Office', `quit stopped ${paths.length} save(s) still running`, { paths });
  if (!dir) return;
  const write = (async () => {
    const all = [...new Set([...(await readList(dir)), ...paths])];
    // WHY write-then-rename: a quit cut off mid-write must not leave half a list behind.
    const part = `${target(dir)}.part`;
    await fsp.writeFile(part, JSON.stringify(all), 'utf8');
    await fsp.rename(part, target(dir));
  })().catch((e) => log('WARN', 'Office', 'recording saves stopped at quit failed', { error: String(e) }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([write, new Promise<void>((r) => (timer = setTimeout(r, RECORD_CAP_MS)))]);
  clearTimeout(timer);
}

/** Hand over the list and forget it, so each file is reported once. Never rejects. */
export async function takeAbandonedSaves(dir: string | null = folder): Promise<string[]> {
  if (!dir) return [];
  const list = await readList(dir);
  // Removed even when unreadable, so a damaged list cannot sit there for ever.
  await fsp.rm(target(dir), { force: true }).catch(() => {});
  return list;
}
