// atomic-write.ts — write a file so a reader sees the old whole file or the new whole file, never half.
//
// WHY (2026-09-30 one-core R3-7): the async temp-file-and-rename helper lived privately in sync-state.ts,
// and ipc/model.ts wrote a second copy of it (R3-6 review). One shared helper now; sync-state and the
// model preference both call it. The per-file "one write at a time, in the order asked" queue the model
// preference needs stays in model.ts: that is a caller policy, not part of the write.
import fs from 'fs';
import path from 'path';

// WHY a per-call counter on top of the pid: `.tmp.<pid>` alone is the SAME name for every write in this
// process, so two overlapping writes to one target both write the same tmp path — the first rename moves
// it away and the second rename throws ENOENT (the cross-OS CI flake in sync-service.test.ts). pid keeps
// the dev instance and the built app apart; the counter keeps calls apart.
let atomicWriteSeq = 0;

// WHY a retry (Windows CI flake, 2026-10-04): on Windows a rename onto a file that another rename (or a scanner) has open at
// that instant fails with EPERM/EACCES/EBUSY and succeeds a few milliseconds later. Two overlapping writes to one target hit it
// ("two overlapping writes ... both succeed"); the same race can hit a real save. Retrying briefly is what graceful-fs does.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
async function renameOverTarget(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await fs.promises.rename(from, to); return; }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 8 || !code || !RENAME_RETRY_CODES.has(code)) throw err;
      await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
    }
  }
}

/** Atomic write via temp file + rename (same directory, so the same filesystem). Creates the folder.
 *  A failed write removes its temp file and rethrows. */
export async function atomicWrite(target: string, content: string): Promise<void> {
  const tmpPath = `${target}.tmp.${process.pid}.${atomicWriteSeq++}`;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.promises.writeFile(tmpPath, content, 'utf8');
    await renameOverTarget(tmpPath, target);
  } catch (err) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}
