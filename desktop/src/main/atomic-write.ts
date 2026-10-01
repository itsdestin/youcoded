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

/** Atomic write via temp file + rename (same directory, so the same filesystem). Creates the folder.
 *  A failed write removes its temp file and rethrows. */
export async function atomicWrite(target: string, content: string): Promise<void> {
  const tmpPath = `${target}.tmp.${process.pid}.${atomicWriteSeq++}`;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.promises.writeFile(tmpPath, content, 'utf8');
    await fs.promises.rename(tmpPath, target);
  } catch (err) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}
