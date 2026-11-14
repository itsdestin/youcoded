// Readers of a version's small files (split out of store.ts to keep it inside its line budget). Pure functions over the Fs
// door. The rule they all follow (inventory.ts): a damaged or missing file has a NON-DESTRUCTIVE meaning; nothing here deletes anything.
import * as nodePath from 'node:path';
import { chainStep, type RuntimeKind } from './chain';

import { isDiskFull } from './storeutil';
import { StoreError } from './errors';
import { type Fs } from './fsio';
import { readSide, readSideFor, writeSide, keepBadSideFile, type SideRead } from './sidefile';
import { REC, decodeRecord, recPos } from './records';
import { PARTIAL_FILE, PARTIAL_COPY, DAMAGED_COPY, writePartial, writeDamaged, chunkPathOf } from './recovery';

/** The version key a version folder belongs to (the folder name). */
const keyOfDir = (dir: string): string => nodePath.basename(dir);

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
    // WHY the version check (review 4): a meta file copied in from ANOTHER version has a good checksum; its own `version` field says it is foreign, so it counts as a
    // bad copy and the other one is used (instead of the two "disagreeing" and the version becoming unreadable)
    const norm = (r: SideRead) => (r.kind === 'ok' && r.value && r.value.version === keyOfDir(dir) && typeof r.value.chatId === 'string' && (r.value.runtime === 'claude-code' || r.value.runtime === 'native')
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
  // a body that is not there (or short) does not verify; it is not an error here
  try { return await lineVerifiesRaw(fs, dir, chunks, n, seed); } catch { return false; }
}
async function lineVerifiesRaw(fs: Fs, dir: string, chunks: number[], n: number, seed: Buffer): Promise<boolean> {
    const r = decodeRecord(await readAt(fs, nodePath.join(dir, 'index.bin'), recPos(n), REC), 0);
    if (!r) return false;
    const prev = n > 0 ? decodeRecord(await readAt(fs, nodePath.join(dir, 'index.bin'), recPos(n - 1), REC), 0) : null;
    if (n > 0 && !prev) return false;
    const cs = chunks.filter((c) => c <= r.offset).pop();
    if (cs === undefined) return false;
    const line = await readAt(fs, chunkPathOf(dir, cs), r.offset - cs, r.len);
    return line.length === r.len && chainStep(prev ? prev.h : seed, line).equals(r.h);
  }

  /** partial.json: lines a rebuild or a recovery set aside because they could not be verified (review 3, F4). A damaged marker still reports: damaged from the head. */
export async function readPartial(fs: Fs, dir: string, count: number): Promise<{ fromLine: number; lost: number } | null> {
    const reads = [await readSideFor(fs, nodePath.join(dir, PARTIAL_FILE), keyOfDir(dir)), await readSideFor(fs, nodePath.join(dir, PARTIAL_COPY), keyOfDir(dir))];
    if (reads.every((r) => r.kind === 'absent')) return null;
    const ok = reads.filter((r) => r.kind === 'ok' && Number.isSafeInteger(r.value?.fromLine) && Number.isSafeInteger(r.value?.lost) && r.value.lost >= 0).map((r) => ({ fromLine: (r as { value: { fromLine: number } }).value.fromLine, lost: (r as { value: { lost: number } }).value.lost }));
    if (ok.length) {
      const best = ok.reduce((a, b) => (b.fromLine + b.lost > a.fromLine + a.lost ? b : a));
      // either copy alone is enough; the missing or damaged one is rewritten from it (best effort: a read never fails for lack of space)
      if (ok.length < 2 || reads.some((r) => r.kind !== 'ok')) { try { await writePartial(fs, dir, { ...best, atMs: Date.now() }); } catch (e) { if (!isDiskFull(e)) throw e; } }
      return best;
    }
    // WHY not "no marker": a version that silently looks healthy but shorter cannot be told from a short chat (review 3, F4). Reported from its head, until the next line lands.
    return { fromLine: count, lost: 1 };
  }

  /**
   * damaged.json / damaged.copy: absent (both) means healthy; a damaged marker still means damaged (the aside name is then unknown). WHY two copies (review 4): a quarantine
   * moves everything away, so the marker is the ONLY thing that says this empty-looking version is not simply empty; one deleted file must not turn "damaged" into "fine".
   * Either copy alone is enough; the missing or damaged one is rewritten from it.
   */
export async function readDamaged(fs: Fs, dir: string): Promise<{ asideName: string; reason: string } | null> {
    const reads = [await readSideFor(fs, nodePath.join(dir, 'damaged.json'), keyOfDir(dir)), await readSideFor(fs, nodePath.join(dir, DAMAGED_COPY), keyOfDir(dir))];
    if (reads.every((x) => x.kind === 'absent')) return null;
    const r = reads.find((x) => x.kind === 'ok' && typeof x.value?.asideName === 'string') ?? (reads.find((x) => x.kind === 'bad') ?? reads[0]);
    // WHY (review 4): a quarantine really moves index.bin away, so a marker that sits next to a live index.bin is an OLDER copy of a marker (taken before the version
    // was cleared and refilled). Believing it would hide a healthy chat. Whatever else is wrong with it, a version with a live index is not quarantined.
    if (await fs.exists(nodePath.join(dir, 'index.bin'))) return null;
    if (r.kind === 'ok' && typeof r.value?.asideName === 'string') {
      if (reads.some((x) => x.kind !== 'ok')) { try { await writeDamaged(fs, dir, { asideName: r.value.asideName, reason: String(r.value.reason ?? ''), atMs: Date.now() }); } catch (e) { if (!isDiskFull(e)) throw e; } }
      return { asideName: r.value.asideName, reason: String(r.value.reason ?? '') };
    }
    return { asideName: 'unknown', reason: 'damaged.json is unreadable' };
  }

export async function readScrubMark(fs: Fs, dir: string): Promise<{ lines: number; passEnd: number }> {
    const r = await readSideFor(fs, nodePath.join(dir, 'scrub.json'), keyOfDir(dir));
    const m = r.kind === 'ok' ? r.value : null;
    if (m && Number.isSafeInteger(m.lines) && m.lines >= 0) return { lines: m.lines, passEnd: Number.isSafeInteger(m.passEnd) && m.passEnd >= m.lines ? m.passEnd : m.lines };
    return { lines: 0, passEnd: 0 };   // absent or damaged: the pass starts over
  }

  /** evicted.json, the holders' note: its numbers, or null when it is absent, damaged or another version's. NEVER the authority for an eviction (the checkpoint is); it can only veto one whose bodies are all present. */
export async function readEvictedNote(fs: Fs, dir: string): Promise<{ lines: number; bytes: number } | null> {
    const r = await readSideFor(fs, nodePath.join(dir, 'evicted.json'), keyOfDir(dir));
    const m = r.kind === 'ok' ? r.value : null;
    return m && Number.isSafeInteger(m.lines) && Number.isSafeInteger(m.bytes) && m.lines >= 0 && m.bytes >= 0 ? { lines: m.lines, bytes: m.bytes } : null;
  }

  /** The next unused aside name for this version: max existing number + 1 over BOTH kinds, never a name that exists (a deleted aside folder must not let a new copy merge into an old one). */
export async function nextAsideName(fs: Fs, root: string, key: string, quarantined: boolean): Promise<string> {
    const asideDir = nodePath.join(root, 'aside');
    let max = 0;
    for (const n of await fs.readdir(asideDir)) { const m = new RegExp(`^${key}-q?(\\d+)$`).exec(n); if (m) max = Math.max(max, parseInt(m[1], 10)); }
    for (let v = max + 1; ; v++) { const name = `${key}-${quarantined ? 'q' : ''}${v}`; if (!(await fs.exists(nodePath.join(asideDir, name)))) return name; }
  }
