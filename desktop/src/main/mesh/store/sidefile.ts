// Small JSON state files, written through the ONE envelope (envelope.ts). Reading one yields FOUR outcomes so each caller can give a damaged or misplaced file a
// non-destructive meaning:
//   absent   the file is not there
//   bad      it is there but zero-length, truncated, wrongly framed, failing its checksum or not JSON
//   foreign  its checksum is good but it is not the file the caller asked for (another kind, another version or chat, another id): never believed, never deleted
//   ok       the value
import * as nodePath from 'node:path';
import { crc32 } from './chain';
import { writeFileAtomic, type Fs } from './fsio';
import { openEnv, sealEnv } from './envelope';

export type SideRead = { kind: 'absent' } | { kind: 'bad' } | { kind: 'foreign'; why: string } | { kind: 'ok'; value: any; fresh: number };

/** What a caller expects a file to be: its kind, the version/chat it belongs to, and (where it applies) what it stands for. */
interface SideWant { role: string; key: string; id?: string | number | null }

export function encodeSide(w: SideWant, value: unknown, fresh = 0): Buffer {
  return sealEnv({ role: w.role, version: w.key, id: w.id, fresh }, Buffer.from(JSON.stringify(value), 'utf8'));
}

export function decodeSide(b: Buffer | null, w: SideWant, minFresh?: number): SideRead {
  const r = openEnv(b, { role: w.role, version: w.key, id: w.id, minFresh });
  if (r.kind !== 'ok') return r;
  try { return { kind: 'ok', value: JSON.parse(r.payload.toString('utf8')), fresh: r.fresh }; } catch { return { kind: 'bad' }; }
}

export async function readSideFor(fs: Fs, path: string, w: SideWant): Promise<SideRead> { return decodeSide(await fs.readFile(path), w); }

/** Atomic replacement (temp file, fsync, rename, directory fsync). Callers tag themselves with why replacing the old content is safe. */
export function writeSideFor(fs: Fs, path: string, w: SideWant, value: unknown): Promise<void> {
  // DESTRUCTIVE-OK(verified-record): the callers decide what may be replaced; this seals the identity into the file and replaces whole files atomically, never half
  return writeFileAtomic(fs, path, encodeSide(w, value));
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
