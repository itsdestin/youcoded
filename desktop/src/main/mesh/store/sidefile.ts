// Checksummed envelope for the store's small state files (class fix: every file the store writes is integrity-checked, see inventory.ts).
//
// `YCS1 | payload length u32 | CRC-32 of the payload u32 | payload (JSON)`. WHY: before this, evicted.json, partial.json, meta.json and friends were
// plain JSON whose numbers were believed blindly; one flipped digit in evicted.json deleted acknowledged body chunks (review 3, F1).
// Reading one yields THREE outcomes, never two, so each caller can give a damaged file a non-destructive meaning:
//   absent  the file is not there
//   bad     it is there but zero-length, truncated, wrongly framed, failing its CRC or not JSON
//   ok      the value
import * as nodePath from 'node:path';
import { crc32 } from './chain';
import { writeFileAtomic, type Fs } from './fsio';

const MAGIC = Buffer.from('YCS1', 'ascii');

export type SideRead = { kind: 'absent' } | { kind: 'bad' } | { kind: 'ok'; value: any };

export function encodeSide(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const h = Buffer.alloc(12);
  MAGIC.copy(h, 0); h.writeUInt32BE(payload.length, 4); h.writeUInt32BE(crc32(payload), 8);
  return Buffer.concat([h, payload]);
}

export function decodeSide(b: Buffer | null): SideRead {
  if (b === null) return { kind: 'absent' };
  if (b.length < 12 || !b.subarray(0, 4).equals(MAGIC)) return { kind: 'bad' };
  const len = b.readUInt32BE(4);
  if (b.length !== 12 + len) return { kind: 'bad' };
  const payload = b.subarray(12);
  if (crc32(payload) !== b.readUInt32BE(8)) return { kind: 'bad' };
  try { return { kind: 'ok', value: JSON.parse(payload.toString('utf8')) }; } catch { return { kind: 'bad' }; }
}

export async function readSide(fs: Fs, path: string): Promise<SideRead> { return decodeSide(await fs.readFile(path)); }

/** Atomic replacement (temp file, fsync, rename, directory fsync). Callers tag themselves with why replacing the old content is safe. */
export async function writeSide(fs: Fs, path: string, value: unknown): Promise<void> {
  // DESTRUCTIVE-OK(verified-record): the callers decide; this only replaces whole files atomically, never half
  await writeFileAtomic(fs, path, encodeSide(value));
}

/** `<name>.bad-<n>`: a damaged state file moved aside (kept) before a fresh one is written. n is the next free number, never a name already taken. */
export async function keepBadSideFile(fs: Fs, path: string): Promise<string> {
  const dir = nodePath.dirname(path); const base = nodePath.basename(path);
  let max = 0;
  for (const n of await fs.readdir(dir)) { const m = new RegExp(`^${base.replace(/\./g, '\\.')}\\.bad-(\\d+)$`).exec(n); if (m) max = Math.max(max, parseInt(m[1], 10)); }
  for (let n = max + 1; ; n++) {
    const to = nodePath.join(dir, `${base}.bad-${n}`);
    if (await fs.exists(to)) continue;
    // DESTRUCTIVE-OK(kept-copy-first): a rename to a name nothing uses; the damaged bytes are kept, never overwritten
    await fs.rename(path, to);
    await fs.fsyncDir(dir);
    return to;
  }
}

const FORMAT_NAME = 'youcoded-mesh-store';
export const formatLine = (n: number): string => `${FORMAT_NAME} ${n} ${crc32(Buffer.from(`${FORMAT_NAME} ${n}`)).toString(16).padStart(8, '0')}\n`;
/** FORMAT is one line with its own checksum; the first, unchecksummed form (`youcoded-mesh-store 1`) is still read. */
export function parseFormat(b: Buffer): { kind: 'ok'; n: number } | { kind: 'bad' } {
  const t = b.toString('utf8');
  if (t === `${FORMAT_NAME} 1\n`) return { kind: 'ok', n: 1 };
  const m = /^youcoded-mesh-store (\d+) ([0-9a-f]{8})\n$/.exec(t);
  return m && crc32(Buffer.from(`${FORMAT_NAME} ${m[1]}`)).toString(16).padStart(8, '0') === m[2] ? { kind: 'ok', n: Number(m[1]) } : { kind: 'bad' };
}
