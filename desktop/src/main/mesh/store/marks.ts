// marks.bin: a version's partial marker (split out of versionfiles.ts so recovery.ts can write them without an import cycle).
import * as nodePath from 'node:path';
import type { Fs } from './fsio';
import { keepBadSideFile } from './sidefile';
import { readSlots, writeSlot, type SlotState } from './slotfile';

const keyOfDir = (dir: string): string => nodePath.basename(dir);

/**
 * marks.bin: ONE two-slot enveloped file (slotfile.ts) holding the version's partial marker: lines a rebuild or a recovery set aside because they could not be verified (review 3, F4); reported until
 * the head passes them. (The old second marker, "this version was quarantined", is gone: a quarantined version is RETIRED, and what says so is the aside/ folder outside the version folder, asides.ts.)
 */
/** `endHash`: the first 16 hex digits of the chain value the version had at line `fromLine + lost`, when the statement that vouched for those lines is known (the checkpoint's); it lets the refill be checked (review 9 F1). */
export interface PartialMark { fromLine: number; lost: number; endHash?: string }
export interface Marks { partial: PartialMark | null }
export const MARKS_FILE = 'marks.bin';
export const readMarksState = (fs: Fs, dir: string): Promise<SlotState<Marks>> => readSlots<Marks>(fs, nodePath.join(dir, MARKS_FILE), 'marks', keyOfDir(dir));

/** Write a new statement. A file with no valid slot is kept as marks.bin.bad-N first (it may be the only evidence of something). */
export async function setMarks(fs: Fs, dir: string, patch: Partial<Marks>, st?: SlotState<Marks>): Promise<void> {
  let cur = st ?? await readMarksState(fs, dir);
  if (cur.kind === 'bad') { await keepBadSideFile(fs, nodePath.join(dir, MARKS_FILE)); cur = await readMarksState(fs, dir); }
  const next: Marks = { partial: patch.partial === undefined ? (cur.value?.partial ?? null) : patch.partial };
  // DESTRUCTIVE-OK(verified-record): a marker; slotfile.ts overwrites only the safe slot (a damaged one, else the older)
  await writeSlot(fs, nodePath.join(dir, MARKS_FILE), 'marks', keyOfDir(dir), cur, next);
  if (st) Object.assign(st, cur);
}

/** The partial marker: lines a rebuild or a recovery set aside. A marks file that cannot be read still reports: damaged from the head (the next line that lands ends it). */
export async function readPartial(fs: Fs, dir: string, count: number, st?: SlotState<Marks>): Promise<PartialMark | null> {
    const m = st ?? await readMarksState(fs, dir);
    if (m.kind === 'absent') return null;
    // WHY not "no marker": a version that silently looks healthy but shorter cannot be told from a short chat (review 3, F4). Reported from its head, until the next line lands.
    if (m.kind === 'bad') return { fromLine: count, lost: 1 };
    const p = m.value?.partial;
    return p && Number.isSafeInteger(p.fromLine) && Number.isSafeInteger(p.lost) && p.lost >= 0 ? { fromLine: p.fromLine, lost: p.lost, ...(typeof p.endHash === 'string' && /^[0-9a-f]{16}$/.test(p.endHash) ? { endHash: p.endHash } : {}) } : null;
  }
