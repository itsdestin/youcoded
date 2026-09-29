import * as fs from 'fs';
import { createHash } from 'crypto';

/**
 * The read-before-edit gate's notion of "unchanged since you read it".
 *
 * WHY a content hash and not an mtime (2026-09-16, closing
 * docs/active/investigations/2026-09-01-write-edit-mtime-staleness.md): the
 * gate compared modification times, which lie in both directions — a `touch`
 * or a `git checkout` that changed no bytes bumped the mtime and wrongly
 * refused the edit, and a real outside edit inside one clock tick on a
 * coarse-resolution filesystem kept the same mtime and was wrongly allowed.
 * Both prior-art harnesses the mutation-safety doc surveyed compare content
 * (Gemini CLI hashes at read time; OpenCode compares raw bytes), and both
 * Write and Edit already have the bytes in hand when they check, so the hash
 * costs nothing extra there. Read pays one hash over a buffer it already
 * holds; the image and PDF branches read the file once more for it, which is
 * bounded by the attachment limit and the PDF's own read respectively.
 *
 * The digest is prefixed with the byte length so a (vanishingly unlikely)
 * digest collision would still need matching sizes, and so a reader of the
 * registry can tell the value is a fingerprint and not an mtime at a glance.
 */
export function fingerprintOf(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return `${b.length}:${createHash('sha256').update(b).digest('hex')}`;
}

/** Fingerprint of a file's current bytes on disk, read off the main thread
 *  (2026-09-16 C4). Rejects like fs.promises.readFile. */
export async function fingerprintFile(absPath: string): Promise<string> {
  return fingerprintOf(await fs.promises.readFile(absPath));
}

/** The same fingerprint as fingerprintOf, computed in small pieces as the file
 *  streams in. WHY (Destin, 2026-09-28: no new stutters): the app's main
 *  process serves every window, and hashing a large file in one go holds it for
 *  tens of milliseconds (~36 ms at 50 MB). Between pieces the process is free to
 *  handle other work, so even the largest readable file causes no visible hitch.
 *  Used by Read's repeat check, where most answers are "unchanged" and the
 *  whole-file decode and line split can then be skipped entirely. */
export function fingerprintFileInPieces(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let length = 0;
    fs.createReadStream(absPath, { highWaterMark: 256 * 1024 })
      .on('data', (chunk: Buffer | string) => {
        const b = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        length += b.length;
        hash.update(b);
      })
      .on('error', reject)
      .on('end', () => resolve(`${length}:${hash.digest('hex')}`));
  });
}
