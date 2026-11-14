// Readers of a version's small files and the eviction cross-check (split out of store.ts to keep it inside its line budget). Pure functions over the Fs
// door. The rule they all follow (inventory.ts): a damaged or missing file has a NON-DESTRUCTIVE meaning; nothing here deletes anything.
import * as nodePath from 'node:path';
import { chainStep, type RuntimeKind } from './chain';
import { isDiskFull } from './storeutil';
import { StoreError } from './errors';
import { type Fs } from './fsio';
import { readSide, writeSide, keepBadSideFile, type SideRead } from './sidefile';
import { REC, decodeRecord, recPos, type Rec } from './records';
import { Damaged, NeedsRebuild, PARTIAL_FILE, chunkPathOf } from './recovery';

async function readAt(fs: Fs, path: string, pos: number, len: number): Promise<Buffer> {
  const f = await fs.open(path, { create: false });
  try { return await f.read(pos, len); } finally { await f.close(); }
}

  /** The version's registration, from whichever of meta.json / meta.copy is intact; the damaged or missing one is rewritten from it. Null when neither file exists. */
export async function readMeta(fs: Fs, dir: string): Promise<{ chatId: string; runtime: RuntimeKind; parent: string | null; createdMs: number } | null> {
    const names = ['meta.json', 'meta.copy'];
    const reads: SideRead[] = [];
    for (const n of names) reads.push(await readSide(fs, nodePath.join(dir, n)));
    if (reads.every((r) => r.kind === 'absent')) return null;
    const norm = (r: SideRead) => (r.kind === 'ok' && r.value && typeof r.value.chatId === 'string' && (r.value.runtime === 'claude-code' || r.value.runtime === 'native')
      ? { chatId: r.value.chatId as string, runtime: r.value.runtime as RuntimeKind, parent: (r.value.parent ?? null) as string | null, createdMs: Number(r.value.createdMs) || 0 } : null);
    const ms = reads.map(norm);
    if (ms[0] && ms[1]) {
      if (ms[0].chatId !== ms[1].chatId || ms[0].runtime !== ms[1].runtime || ms[0].parent !== ms[1].parent) throw new StoreError('corrupt', 'meta.json and meta.copy disagree');
      return ms[0];
    }
    const good = ms[0] ?? ms[1];
    if (!good) throw new StoreError('corrupt', 'meta.json');
    // heal the other copy: the damaged bytes are kept as *.bad-N first. Best effort: a read never fails because the disk is full.
    const badName = ms[0] ? names[1] : names[0]; const goodRead = reads[ms[0] ? 0 : 1];
    try {
      const bp = nodePath.join(dir, badName);
      if (await fs.exists(bp)) await keepBadSideFile(fs, bp);
      await writeSide(fs, bp, (goodRead as { value: unknown }).value); // DESTRUCTIVE-OK(verified-record): the damaged copy was moved to *.bad-N above; the new bytes are the intact copy's
    } catch (e) { if (!isDiskFull(e)) throw e; }
    return good;
  }

  /** True when line `n`'s body bytes hash to the chain value in its index record. */
export async function lineVerifies(fs: Fs, dir: string, chunks: number[], n: number, seed: Buffer): Promise<boolean> {
    const r = decodeRecord(await readAt(fs, nodePath.join(dir, 'index.bin'), recPos(n), REC), 0);
    if (!r) return false;
    const prev = n > 0 ? decodeRecord(await readAt(fs, nodePath.join(dir, 'index.bin'), recPos(n - 1), REC), 0) : null;
    if (n > 0 && !prev) return false;
    const cs = chunks.filter((c) => c <= r.offset).pop();
    if (cs === undefined) return false;
    const line = await readAt(fs, chunkPathOf(dir, cs), r.offset - cs, r.len);
    return line.length === r.len && chainStep(prev ? prev.h : seed, line).equals(r.h);
  }

  /**
   * The eviction state to act on. The marker (`hint`) is believed only when it names a line count the index has AND the index record of its
   * last line ends exactly at the marker's byte count (an independent, checksummed record). Otherwise it is derived from what is present:
   * the first body chunk file starts where the bodies start; no chunk file at all means no line has a body here.
   */
export async function resolveEvicted(fs: Fs, dir: string, hint: { lines: number; bytes: number } | null, chunkNames: number[], count: number, last: Rec | null): Promise<{ lines: number; bytes: number; trusted: boolean }> {
    // trusted marker: it names a line the index has and ends exactly where that line's record says. A chunk file that starts past the marker's bytes then means
    // bodies the marker says are present are not: the first chunk is missing (a fault), reported like any missing chunk.
    const firstMissing = () => new Damaged('the first body chunk is missing');
    if (hint) {
      if (hint.lines === 0 && hint.bytes === 0) { if (chunkNames.length && chunkNames[0] > 0) throw firstMissing(); return { ...hint, trusted: true }; }
      if (hint.lines <= count && hint.lines > 0) {
        const r = decodeRecord(await readAt(fs, nodePath.join(dir, 'index.bin'), recPos(hint.lines - 1), REC), 0);
        if (r && r.offset + r.len === hint.bytes) { if (chunkNames.length && chunkNames[0] > hint.bytes) throw firstMissing(); return { ...hint, trusted: true }; }
      }
    }
    if (chunkNames.length === 0) return count === 0 ? { lines: 0, bytes: 0, trusted: false } : { lines: count, bytes: last ? last.offset + last.len : 0, trusted: false };
    const first = chunkNames[0];
    if (first === 0) return { lines: 0, bytes: 0, trusted: false };
    // binary search for the line that ends exactly where the first chunk starts (offsets only grow)
    let lo = 0; let hi = count - 1; const f = await fs.open(nodePath.join(dir, 'index.bin'), { create: false });
    try {
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const r = decodeRecord(await f.read(recPos(mid), REC), 0);
        if (!r) throw new NeedsRebuild(`record ${mid} fails its checksum`);
        const end = r.offset + r.len;
        if (end === first) return { lines: mid + 1, bytes: first, trusted: false };
        if (end < first) lo = mid + 1; else hi = mid - 1;
      }
    } finally { await f.close(); }
    throw new Damaged('the first body chunk does not start where a line starts (an earlier chunk is missing)');
  }

  /** partial.json: lines a rebuild or a recovery set aside because they could not be verified (review 3, F4). A damaged marker still reports: damaged from the head. */
export async function readPartial(fs: Fs, dir: string, count: number): Promise<{ fromLine: number; lost: number } | null> {
    const r = await readSide(fs, nodePath.join(dir, PARTIAL_FILE));
    if (r.kind === 'absent') return null;
    if (r.kind === 'ok' && Number.isSafeInteger(r.value?.fromLine) && Number.isSafeInteger(r.value?.lost) && r.value.lost >= 0) return { fromLine: r.value.fromLine, lost: r.value.lost };
    // WHY not "no marker": a version that silently looks healthy but shorter cannot be told from a short chat (review 3, F4). Reported from its head, until the next line lands.
    return { fromLine: count, lost: 1 };
  }

  /** damaged.json: absent means healthy; a damaged marker still means damaged (the aside name is then unknown). */
export async function readDamaged(fs: Fs, dir: string): Promise<{ asideName: string; reason: string } | null> {
    const r = await readSide(fs, nodePath.join(dir, 'damaged.json'));
    if (r.kind === 'absent') return null;
    if (r.kind === 'ok' && typeof r.value?.asideName === 'string') return { asideName: r.value.asideName, reason: String(r.value.reason ?? '') };
    return { asideName: 'unknown', reason: 'damaged.json is unreadable' };
  }

export async function readScrubMark(fs: Fs, dir: string): Promise<{ lines: number; passEnd: number }> {
    const r = await readSide(fs, nodePath.join(dir, 'scrub.json'));
    const m = r.kind === 'ok' ? r.value : null;
    if (m && Number.isSafeInteger(m.lines) && m.lines >= 0) return { lines: m.lines, passEnd: Number.isSafeInteger(m.passEnd) && m.passEnd >= m.lines ? m.passEnd : m.lines };
    return { lines: 0, passEnd: 0 };   // absent or damaged: the pass starts over
  }

  /** evicted.json as a hint: checksummed, with sane numbers, or null (absent, damaged or nonsense). Never trusted to delete anything by itself. */
export async function readEvictedHint(fs: Fs, dir: string): Promise<{ lines: number; bytes: number } | null> {
    const r = await readSide(fs, nodePath.join(dir, 'evicted.json'));
    const m = r.kind === 'ok' ? r.value : null;
    if (m && Number.isSafeInteger(m.lines) && Number.isSafeInteger(m.bytes) && m.lines >= 0 && m.bytes >= 0 && (m.lines === 0) === (m.bytes === 0)) return { lines: m.lines, bytes: m.bytes };
    return null;
  }

  /** The next unused aside name for this version: max existing number + 1 over BOTH kinds, never a name that exists (a deleted aside folder must not let a new copy merge into an old one). */
export async function nextAsideName(fs: Fs, root: string, key: string, quarantined: boolean): Promise<string> {
    const asideDir = nodePath.join(root, 'aside');
    let max = 0;
    for (const n of await fs.readdir(asideDir)) { const m = new RegExp(`^${key}-q?(\\d+)$`).exec(n); if (m) max = Math.max(max, parseInt(m[1], 10)); }
    for (let v = max + 1; ; v++) { const name = `${key}-${quarantined ? 'q' : ''}${v}`; if (!(await fs.exists(nodePath.join(asideDir, name)))) return name; }
  }
