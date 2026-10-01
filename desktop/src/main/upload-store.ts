// upload-store.ts — where a phone's attached files land on the computer, how big one may be, and the sweep that
// clears old ones.
//
// WHY (2026-10-01 one-core R3-SEC): file:upload accepted anything the socket would carry (50 MB) with no cap of its own,
// and the only cleanup was an hourly timer that never ran in an app that restarts more than hourly. The folder is
// the computer's temp folder, never a project, so this is the only place that writes into it and the only one that
// deletes from it.
import fs from 'fs';
import os from 'os';
import path from 'path';

/** The temp folder a phone's uploads are written to (and the one folder, outside every project, a phone may preview). */
const UPLOAD_DIR_NAME = 'claude-desktop-uploads';
export const uploadDir = (): string => path.join(os.tmpdir(), UPLOAD_DIR_NAME);

/**
 * The largest file a phone may attach. 25 MB: a phone photo is 2 to 12 MB and a scanned multi-page PDF a few more,
 * so this covers what people attach; it also keeps the base64 form (a third bigger, ~33 MB) inside the socket's
 * 50 MB frame limit with room to spare, and stops one tap from putting a video's worth of data in the computer's
 * temp folder and in memory at once.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** The phone-facing sentence when a file is over the cap. */
export const UPLOAD_TOO_LARGE_SENTENCE = 'That file is over 25 MB, the most a phone can send to the computer. Attach a smaller one.';

/** An upload is deleted once it is this old. Unchanged from the hourly timer this replaces. */
const UPLOAD_MAX_AGE_MS = 3600_000;

/** A file name that is safe to use inside the upload folder: no separators, no control characters, bounded. */
export function sanitizeUploadName(raw: unknown): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = String(raw || 'upload').replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200);
  return cleaned || 'upload';
}

/**
 * Delete files in `dir` (the upload folder, and nothing else) not modified for `maxAgeMs`. Only regular files directly
 * inside `dir` are touched: a link, a folder or anything below one is left alone, so pointing this at the wrong
 * place cannot reach outside it. Never throws. Returns how many files it removed.
 */
export async function sweepOldUploads(dir = uploadDir(), maxAgeMs = UPLOAD_MAX_AGE_MS, now = Date.now()): Promise<number> {
  let removed = 0;
  let names: string[];
  try { names = await fs.promises.readdir(dir); } catch { return 0; }
  for (const name of names) {
    try {
      const full = path.join(dir, name);
      const st = await fs.promises.lstat(full);
      if (st.isFile() && now - st.mtimeMs > maxAgeMs) { await fs.promises.unlink(full); removed++; }
    } catch { /* already gone, or not ours to remove */ }
  }
  return removed;
}
