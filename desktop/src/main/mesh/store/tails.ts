// Set-aside tails and the HISTORY IDENTITY (review 6, B1 and B2). Split out of store.ts to keep it inside its line budget.
//
// TWO INVARIANTS live here.
//
//  (H) HISTORY: a version's line N can change only through a takeover, and every takeover goes through setAsideTail. The takeovers a version has had are recorded by their `.begun`
//      markers in tails/; the sorted list of those names IS the version's history identity (its "epoch", readEpoch below). A parked append is sealed with the epoch it was parked in
//      (parked.ts), and is applied only when the version is still in that epoch: a park is only ever drained onto the history it was parked against. Because the epoch is READ FROM DISK
//      (not remembered), it holds after any crash, and a lost or extra marker changes it in the SAFE direction (parks are refused, kept in rejected/, never applied).
//  (T) TAIL: after ANY crash point in setAsideTail and any number of retries, either the tail file is complete (and marked), or its loss is reported (`corrupt`). A retry never writes an
//      empty tail over a lost one: a tail is only ever written while NO marker exists, and no marker exists only until the tail is durable and has been read back.
import * as nodePath from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomic, mkdirDurable, type Fs } from './fsio';
import { StoreError } from './errors';
import { hex } from './chain';
import { encodeTailFile, decodeTailFile, type TailFile } from './storeutil';
import type { VState } from './vstate';
import type { Parked } from './parked';

export const MAX_TAILS = 1024;
/** The epoch of a version that has never had a takeover. */
export const GENESIS_EPOCH = 'genesis';

const tailsDir = (dir: string): string => nodePath.join(dir, 'tails');
const marker = (dir: string, id: string, ext: 'begun' | 'done'): string => nodePath.join(tailsDir(dir), `${id}.${ext}`);

/** The history identity of the version folder `dir`: the takeovers that have begun, read from disk. */
export async function readEpoch(fs: Fs, dir: string): Promise<string> {
  const begun = (await fs.readdir(tailsDir(dir))).filter((n) => n.endsWith('.begun')).sort();
  return begun.length === 0 ? GENESIS_EPOCH : createHash('sha256').update(begun.join('\n')).digest('hex').slice(0, 16);
}

export async function readTailFile(fs: Fs, path: string, key: string, takeoverId: string): Promise<TailFile | null> {
  const b = await fs.readFile(path);
  return b ? decodeTailFile(b, key, takeoverId) : null;
}

/** A marker exists for this takeover: a tail file that is then missing was LOST (the cut may already have happened), never "not written yet". */
export async function tailWasProtected(fs: Fs, dir: string, id: string): Promise<boolean> {
  return (await fs.exists(marker(dir, id, 'begun'))) || (await fs.exists(marker(dir, id, 'done')));
}
export const LOST_TAIL = (): StoreError => new StoreError('corrupt', 'the saved tail file is missing although the takeover was marked');

/** What the store gives setAsideTail to work with (all of these stay in store.ts). */
export interface TailEnv {
  fs: Fs;
  parked: Parked;
  readRange: (st: VState, from: number, to: number, verify: boolean) => Promise<Buffer[]>;
  stateAtLine: (st: VState, n: number) => Promise<{ h: Buffer; c: Buffer }>;
  confirmedBetween: (st: VState, from: number, to: number) => Promise<number[]>;
  /** Cut the version back to n lines (the only operation that shortens a version); replaces the cached state. */
  cutTo: (st: VState, n: number) => Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// THE STATE MACHINE of setAsideTail (review 6: B1 and B2 both lived in the ORDER of these steps). Steps in order, and what open/retry does after a crash behind each:
//
//  step                                                    a crash right after it leaves                       the next open / retry
//  ------------------------------------------------------  --------------------------------------------------  ---------------------------------------------------------------------
//  0  nothing yet                                          no tail, no marker                                  retry runs from step 1; nothing was cut
//  1  tail file written (atomic: temp, fsync, rename)      tail durable, NO marker, version uncut              retry reads the tail back, goes on at step 3. If the tail is then
//                                                                                                             lost (one fault) there is no marker and no cut: step 1 simply runs again
//  2  tail read back and compared with the lines           same as 1                                           same as 1
//  3  `.begun` marker written                              marker, tail, version uncut, parks untouched        open: the epoch has CHANGED, so every old park is refused on read
//                                                                                                             (B1); retry goes on at step 4. A lost tail from here on is REPORTED
//                                                                                                             (`corrupt`), because the cut may already have happened (B2)
//  4  old parks moved to rejected/ (each move atomic)      some parks moved, some not                          retry moves the rest (the unmoved ones were already refused by the
//                                                                                                             epoch; both layers hold, either alone is enough)
//  5  cut (cutTo): high-water lowered, checkpoint lowered,  anything from "nothing cut" to "index cut, body not   open re-adopts lines the index lost (the tail still holds them) or sees
//     index truncated, body trimmed                        trimmed"                                            the cut; the retry cuts again when the version still holds exactly
//                                                                                                             the tail, otherwise the cut is complete
//  6  `.done` marker written                               everything finished                                 retry returns the original answer and changes nothing
//
//  Why this order is the simplest that works: the only thing that must never be absent when the cut happens is the evidence, so the tail comes first and `.begun` (the intent) second, before
//  ANY change to the version or its parks. `.done` only decides one thing: whether lines that merely LOOK like the saved tail (the new host wrote the same bytes) may be cut a second time.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
export async function setAsideTailLocked(e: TailEnv, st: VState, takeoverId: string, fromLine: number): Promise<{ lines: number }> {
  const { fs } = e;
  const key = st.key; const dir = st.dir;
  const path = nodePath.join(tailsDir(dir), `${takeoverId}.tail`);
  let tail = await readTailFile(fs, path, key, takeoverId);
  if (tail) {
    // a request past the head was clamped to the head the first time: the same request again is the same retry
    const same = tail.fromLine === fromLine || (tail.lines.length === 0 && fromLine > tail.fromLine);
    if (!same) throw new StoreError('bad-argument', 'takeover id already used for a different tail');
  } else {
    // WHY (review 4 F6, review 6 B2): a marker with no tail file means the tail (the only copy of the cut lines) was lost. A retry must not write an empty valid tail over that evidence.
    if (await tailWasProtected(fs, dir, takeoverId)) throw LOST_TAIL();
    // steps 1 and 2: no marker exists, so nothing was cut, and the lines are still in the version
    if (fromLine < st.evictedLines) throw new StoreError('evicted', 'tail lines have no body here');
    if ((await fs.readdir(tailsDir(dir))).filter((n) => n.endsWith('.tail')).length >= MAX_TAILS) throw new StoreError('limit', 'too many set-aside tails for this version');
    const from = Math.min(fromLine, st.count);
    const lines = from < st.count ? await e.readRange(st, from, st.count, true) : [];
    const fromRec = await e.stateAtLine(st, from);
    const header = {
      fromLine: from, fromHash: hex(fromRec.h), fromConv: hex(fromRec.c), headHash: hex(st.h), headConv: hex(st.c),
      replyEnds: await e.confirmedBetween(st, from, st.count), pending: st.rs.cand && st.rs.cand.n >= from ? st.rs.cand.n : null,
    };
    await mkdirDurable(fs, tailsDir(dir));
    await writeFileAtomic(fs, path, encodeTailFile(key, takeoverId, header, lines)); // DESTRUCTIVE-OK(kept-copy-first): a NEW file (checked absent above)
    // WHY read it back before anything else: the cut deletes the only other copy of these lines, so it acts on the bytes that are really in the tail file
    const back = await readTailFile(fs, path, key, takeoverId);
    if (!back || back.lines.length !== lines.length || !back.lines.every((l, i) => l.equals(lines[i]))) throw new StoreError('corrupt', 'the tail file does not read back as written; nothing was cut');
    tail = back;
  }
  const L = tail.lines.length;
  if (!(await fs.exists(marker(dir, takeoverId, 'done')))) {
    // step 3: the intent. WHY BEFORE the cut (B2): from here a missing tail is evidence, not "never written". WHY it also starts the new history (B1): it changes the epoch.
    await mkdirDurable(fs, tailsDir(dir));
    await writeFileAtomic(fs, marker(dir, takeoverId, 'begun'), Buffer.from('cut begun\n')); // DESTRUCTIVE-OK(hint): an existence-only marker
    st.epoch = await readEpoch(fs, dir);
    // step 4: parks of the old history are kept in rejected/ (never deleted, never applied)
    await e.parked.rejectOutsideEpoch(st);
    // step 5: cut only when the version still holds exactly the saved tail (a first run always does; a retry after a finished cut does not)
    if (L > 0 && st.count === tail.fromLine + L && hex((await e.stateAtLine(st, st.count)).h) === tail.headHash) await e.cutTo(st, tail.fromLine);
    // step 6 (N15): without this marker, lines the new host appended that happen to be byte-identical to the saved tail would be cut a second time by a replay
    await writeFileAtomic(fs, marker(dir, takeoverId, 'done'), Buffer.from('cut done\n')); // DESTRUCTIVE-OK(hint): an existence-only marker
  }
  return { lines: L };
}
