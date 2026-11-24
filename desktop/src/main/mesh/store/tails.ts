// Set-aside tails and the HISTORY IDENTITY (review 6, B1 and B2). Split out of store.ts to keep it inside its line budget.
//
// TWO INVARIANTS live here.
//
//  (H) HISTORY: a version's line N can change only through a takeover, and every takeover goes through setAsideTail. The takeovers a version has had are recorded by their `.begun`
//      markers in tails/; the sorted list of those names IS the version's history identity (its "epoch", readEpoch below). A parked append is sealed with the epoch it was parked in
//      (parked.ts), and is applied only when the version is still in that epoch: a park is only ever drained onto the history it was parked against. Because the epoch is READ FROM DISK
//      (not remembered), it holds after any crash, and a lost or extra marker changes it in the SAFE direction (parks are refused, kept in rejected/, never applied).
//      (Round 7, F2) A QUARANTINE OR SET-ASIDE IS A HISTORY CHANGE TOO. What is left in the folder after one is whatever a peer sends next, and nothing says it is the history the parks were made against. So the
//      epoch ALSO names the version's aside folders (aside/<vhex>-<n>, which live OUTSIDE the version folder and are never deleted): a quarantine changes the epoch the moment its aside folder exists, and
//      the parks are then moved to rejected/ with the reason `quarantine` (asides.ts). Parks made AFTER the quarantine belong to the new, empty history; the caller (the replicator) owns what it sends to it.
//  (T) TAIL: after ANY crash point in setAsideTail and any number of retries, either the tail file is complete (and marked), or its loss is reported (`corrupt`). A retry never writes an
//      empty tail over a lost one: a tail is only ever written while NO marker exists, and no marker exists only until the tail is durable and has been read back.
import * as nodePath from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomic, mkdirDurable, type Fs } from './fsio';
import { StoreError } from './errors';
import { hex, unhex, chainStep } from './chain';
import { encodeTailFile, decodeTailFile, type TailFile } from './storeutil';
import type { VState } from './vstate';
import type { Parked } from './parked';

export const MAX_TAILS = 1024;
/** The epoch of a version that has never had a takeover. */
export const GENESIS_EPOCH = 'genesis';

const tailsDir = (dir: string): string => nodePath.join(dir, 'tails');
const marker = (dir: string, id: string, ext: 'begun' | 'done'): string => nodePath.join(tailsDir(dir), `${id}.${ext}`);

/**
 * The history identity of the version folder `dir`: the takeovers that have begun (tails/*.begun) AND the quarantines / set-asides it has had (aside/<vhex>-[q]<n>), read from disk.
 * WHY the aside folders (round 7, F2): quarantine moves the index and bodies away but used to leave the parks, so a park made against history A drained onto a recopy of history B. The aside folder is
 * created BEFORE anything is moved (asides.ts) and lives outside the version folder, so the epoch changes first and the parks are refused from that moment, whatever a crash does next.
 */
export async function readEpoch(fs: Fs, dir: string): Promise<string> {
  const names = await historyNames(fs, dir);
  return names.length === 0 ? GENESIS_EPOCH : createHash('sha256').update(names.join('\n')).digest('hex').slice(0, 16);
}
/** Every history change the folder shows, as sorted names: the takeovers' `.begun` markers and the version's aside folders. */
async function historyNames(fs: Fs, dir: string): Promise<string[]> {
  const begun = (await fs.readdir(tailsDir(dir))).filter((n) => n.endsWith('.begun')).sort();
  const key = nodePath.basename(dir);
  const asideRe = new RegExp(`^${key}-q?\\d+$`);
  const asides = (await fs.readdir(nodePath.join(nodePath.dirname(nodePath.dirname(dir)), 'aside'))).filter((n) => asideRe.test(n)).sort().map((n) => `aside:${n}`);
  return [...begun, ...asides];
}
/** The history COUNT: how many history changes the folder shows now. It only rises (markers and aside folders are never deleted); the checkpoint records it (checkpoint.ts Checkpoint.hist). */
export async function histCount(fs: Fs, dir: string): Promise<number> { return (await historyNames(fs, dir)).length; }

/**
 * How many leading lines a checkpoint written BEFORE the latest history change can still vouch for (round 7, F1): a prefix shorter than every cut point is shared by every history, so a statement
 * about it is true whichever history is current. The bound is the smallest cut point of any takeover (the lines before `fromLine` of every tail), and 0 once the version has been quarantined (a
 * quarantine empties it; what is recopied may be anything). It is deliberately the smallest over ALL takeovers, not only the later ones: the checkpoint cannot say which took place after it, and a
 * smaller bound only makes the version more cautious. `'unproven'` when a takeover's tail cannot be read.
 */
export async function sharedPrefixBound(fs: Fs, dir: string, key: string): Promise<number | 'unproven'> {
  const names = await historyNames(fs, dir);
  if (names.some((n) => n.startsWith('aside:'))) return 0;
  let bound = Infinity;
  for (const id of await takeoverIds(fs, dir)) {
    if (!(await fs.exists(marker(dir, id, 'begun'))) && !(await fs.exists(marker(dir, id, 'done')))) continue;
    let tail: TailFile | null = null;
    try { tail = await readTailFile(fs, nodePath.join(tailsDir(dir), `${id}.tail`), key, id); } catch { tail = null; }
    if (!tail) return 'unproven';
    bound = Math.min(bound, tail.fromLine);
  }
  return bound;
}

/** The takeover ids tails/ shows evidence of: any of `<id>.tail`, `<id>.begun`, `<id>.done`. */
export async function takeoverIds(fs: Fs, dir: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const n of await fs.readdir(tailsDir(dir))) { const m = /^([0-9a-f]+)\.(tail|begun|done)$/.exec(n); if (m) ids.add(m[1]); }
  return [...ids].sort();
}

/**
 * The cut-away branches (round 7, F1). A takeover's tail holds the lines the old host wrote from `fromLine` on, with the chain value at `fromLine`; so the chain value after each of those lines is a
 * point on a history that was REPLACED. Returns the id of a tail whose branch passes through (count, headHex), `'unproven'` when a takeover's evidence cannot be read (a tail that is missing or unreadable,
 * or the high-water record saying more takeovers happened than tails/ shows), or null when the point is on no replaced branch.
 * WHY this is the proof the recovery relaxations need: an older copy of any file describes a state that once existed, so after a takeover it is either a prefix shared with the new history (count at or
 * below the cut: then it is correct, merely shorter) or it runs along the replaced branch (count past the cut: then it IS on a tail's branch, because the tail holds every line the old host had). Equal chain
 * values mean equal lines, so a hit can only be old content or an identical rewrite; the caller asks only when it has overridden a file, so a hit is a loud answer, never a quiet one.
 * Markers: any tail with a `.begun` or `.done` counts (a cut may have happened); a tail written but not yet marked has cut nothing and is not a branch yet.
 */
export async function cutAwayBranchHit(fs: Fs, dir: string, key: string, count: number, headHex: string, recordedTakeovers: number, onlyDone = false): Promise<string | 'unproven' | null> {
  const ids = await takeoverIds(fs, dir);
  if (recordedTakeovers > ids.length) return 'unproven';
  for (const id of ids) {
    // `onlyDone` (the load-time check): a takeover whose cut is still pending legitimately leaves the version holding its tail, so only a FINISHED cut (`.done`) makes the tail's lines "gone from the version"
    if (onlyDone ? !(await fs.exists(marker(dir, id, 'done'))) : (!(await fs.exists(marker(dir, id, 'begun'))) && !(await fs.exists(marker(dir, id, 'done'))))) continue;
    let tail: TailFile | null = null;
    try { tail = await readTailFile(fs, nodePath.join(tailsDir(dir), `${id}.tail`), key, id); } catch { tail = null; }
    if (!tail) return 'unproven';
    if (count <= tail.fromLine || count > tail.fromLine + tail.lines.length) continue;
    let h: Buffer = unhex(tail.fromHash);
    for (let i = 0; i < count - tail.fromLine; i++) h = chainStep(h, tail.lines[i]);
    if (hex(h) === headHex) return id;
  }
  return null;
}

export async function readTailFile(fs: Fs, path: string, key: string, takeoverId: string): Promise<TailFile | null> {
  const b = await fs.readFile(path);
  return b ? decodeTailFile(b, key, takeoverId) : null;
}

/** A marker exists for this takeover: a tail file that is then missing was LOST (the cut may already have happened), never "not written yet". */
export async function tailWasProtected(fs: Fs, dir: string, id: string): Promise<boolean> {
  return (await fs.exists(marker(dir, id, 'begun'))) || (await fs.exists(marker(dir, id, 'done')));
}
/** Takeovers the high-water record counted that tails/ no longer shows (0 normally). */
export const lostTakeovers = (st: VState): number => Math.max(0, (st.hw.st.value?.takeovers ?? 0) - st.tailsShown);
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
  /** Write the number of takeovers tails/ now shows into the high-water record (outside the chat folder). NOT advisory: a failure is thrown and the cut does not happen. */
  recordTakeovers: (st: VState) => Promise<void>;
  /** Rewrite the checkpoint with the same count and chain value but the CURRENT history count (checkpoint.ts Checkpoint.hist), in place (the older of its two slots). */
  stampHistory: (st: VState) => Promise<void>;
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
//  3b the takeover COUNT in the high-water record (outside     marker, tail, count; version uncut                 a lost tail from here on is reported even if `tails/` itself is lost
//     the chat folder) is raised to what tails/ shows         (the write is not advisory: if it fails, nothing is cut)  (recorded > shown, F3), and a retry or new takeover is refused
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
/** The version's head lies on this tail's branch: strictly past the cut and no further than the tail's end, with the chain value the tail's own lines give at that count. */
function holdsTailPrefix(st: VState, tail: TailFile): boolean {
  if (st.count <= tail.fromLine || st.count > tail.fromLine + tail.lines.length) return false;
  let h: Buffer = unhex(tail.fromHash);
  for (let i = 0; i < st.count - tail.fromLine; i++) h = chainStep(h, tail.lines[i]);
  return hex(h) === hex(st.h);
}
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
    // WHY (round 7, F3): the markers can be lost WITH the tail (or the whole tails/ folder). The high-water record, which lives outside the chat folder, counted the takeovers that began; when it counts more
    // than tails/ shows, some takeover's evidence is gone and it cannot be told whether THIS id is it. Nothing is written: not an empty tail for a retry, not a new takeover on top of a lost one.
    if (lostTakeovers(st) > 0) throw LOST_TAIL();
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
    // step 3b (round 7, F3): the takeover is counted outside tails/ BEFORE the cut or any park is touched, so from here a loss of tails/ shows as "recorded more than shown". Not advisory: if it cannot be
    // written the takeover stops here (nothing is cut yet; the retry writes it again).
    st.tailsShown = (await takeoverIds(fs, dir)).length;
    await e.recordTakeovers(st);
    st.epoch = await readEpoch(fs, dir);
    st.hist = await histCount(fs, dir);
    // step 3c (round 7, F1): the checkpoint is restated under the new history count NOW, before the cut, with the same count and chain value. WHY: afterwards a checkpoint older than this takeover means
    // "put back from before it" and nothing else, so the window in which an older checkpoint is a normal state is only the crash between steps 3 and 3c. (An in-place write of a small slot.)
    await e.stampHistory(st);
    // step 4: parks of the old history are kept in rejected/ (never deleted, never applied)
    await e.parked.rejectOutsideEpoch(st);
    // step 5: cut only when the version still holds exactly the saved tail (a first run always does; a retry after a finished cut does not)
    // WHY a PREFIX of the tail also counts (round 7, found by the fuzz when it put an older index and bodies back during a pending takeover): the old rule cut only when the version held ALL of the
    // tail. A version that holds the tail's first k lines (an older copy of index and bodies from before the old host wrote the rest) is just as much "still holding the replaced history", and the retry
    // used to call the cut done (writing `.done`) and leave those lines in place, mixing the two histories. Proof that the lines past the cut are the tail's: the chain value at the head, which covers
    // every line, equals the chain value along the tail's own lines at that count. Before `.done` the new host has not been answered, so lines past the cut cannot be its own.
    if (L > 0 && await holdsTailPrefix(st, tail)) await e.cutTo(st, tail.fromLine);
    // step 6 (N15): without this marker, lines the new host appended that happen to be byte-identical to the saved tail would be cut a second time by a replay
    await writeFileAtomic(fs, marker(dir, takeoverId, 'done'), Buffer.from('cut done\n')); // DESTRUCTIVE-OK(hint): an existence-only marker
  }
  return { lines: L };
}
