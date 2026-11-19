// marks.bin: a version's partial / damaged markers (split out of versionfiles.ts so recovery.ts can write them without an import cycle).
import * as nodePath from 'node:path';
import type { Fs } from './fsio';
import { keepBadSideFile } from './sidefile';
import { readSlots, writeSlot, type SlotState } from './slotfile';

const keyOfDir = (dir: string): string => nodePath.basename(dir);

/**
 * marks.bin (review 5, replaces partial.json, partial.copy, damaged.json and damaged.copy): ONE two-slot enveloped file (slotfile.ts) holding the version's two markers.
 *   partial  lines a rebuild or a recovery set aside because they could not be verified (review 3, F4); reported until the head passes them
 *   damaged  the version was quarantined (index AND bodies moved to aside/<name>-q<n>/); believed only while index.bin is absent
 */
export interface Marks { partial: { fromLine: number; lost: number } | null; damaged: { asideName: string; reason: string } | null }
export const MARKS_FILE = 'marks.bin';
export const readMarksState = (fs: Fs, dir: string): Promise<SlotState<Marks>> => readSlots<Marks>(fs, nodePath.join(dir, MARKS_FILE), 'marks', keyOfDir(dir));

/** Write a new statement. A file with no valid slot is kept as marks.bin.bad-N first (it may be the only evidence of something). */
export async function setMarks(fs: Fs, dir: string, patch: Partial<Marks>, st?: SlotState<Marks>): Promise<void> {
  let cur = st ?? await readMarksState(fs, dir);
  if (cur.kind === 'bad') { await keepBadSideFile(fs, nodePath.join(dir, MARKS_FILE)); cur = await readMarksState(fs, dir); }
  const next: Marks = { partial: patch.partial === undefined ? (cur.value?.partial ?? null) : patch.partial, damaged: patch.damaged === undefined ? (cur.value?.damaged ?? null) : patch.damaged };
  if (next.damaged) next.damaged = { asideName: next.damaged.asideName, reason: next.damaged.reason.slice(0, 200) };
  // DESTRUCTIVE-OK(verified-record): a marker; slotfile.ts overwrites only the safe slot (a damaged one, else the older)
  await writeSlot(fs, nodePath.join(dir, MARKS_FILE), 'marks', keyOfDir(dir), cur, next);
  if (st) Object.assign(st, cur);
}

/** The partial marker: lines a rebuild or a recovery set aside. A marks file that cannot be read still reports: damaged from the head (the next line that lands ends it). */
export async function readPartial(fs: Fs, dir: string, count: number, st?: SlotState<Marks>): Promise<{ fromLine: number; lost: number } | null> {
    const m = st ?? await readMarksState(fs, dir);
    if (m.kind === 'absent') return null;
    // WHY not "no marker": a version that silently looks healthy but shorter cannot be told from a short chat (review 3, F4). Reported from its head, until the next line lands.
    if (m.kind === 'bad') return { fromLine: count, lost: 1 };
    const p = m.value?.partial;
    return p && Number.isSafeInteger(p.fromLine) && Number.isSafeInteger(p.lost) && p.lost >= 0 ? { fromLine: p.fromLine, lost: p.lost } : null;
  }

/**
 * The quarantine marker: null means healthy. WHY three sources: a quarantine moves everything away, so the marker is the ONLY thing that says this empty-looking version is not simply empty.
 *   - a valid marker, believed only while index.bin is absent (a quarantine really moves it away: a marker next to a live index is an OLDER copy, taken before the version was cleared and
 *     refilled, and believing it would hide a healthy chat);
 *   - a marks file that cannot be read while there is no index.bin: damaged, aside name unknown;
 *   - (review 5) NO marks file at all, but a quarantined copy (aside/<key>-q<n>/ with its COMPLETE mark) exists and the version has no index and no body: the marker was deleted, and one deleted
 *     file must not turn "damaged" into "fine" (the second copy that used to guard this is gone with the merge into one file).
 */
export async function readDamaged(fs: Fs, dir: string, st?: SlotState<Marks>): Promise<{ asideName: string; reason: string } | null> {
    if (await fs.exists(nodePath.join(dir, 'index.bin'))) return null;
    const m = st ?? await readMarksState(fs, dir);
    if (m.kind === 'ok' && m.value?.damaged && typeof m.value.damaged.asideName === 'string') return { asideName: m.value.damaged.asideName, reason: String(m.value.damaged.reason ?? '') };
    if (m.kind === 'bad') return { asideName: 'unknown', reason: 'marks.bin is unreadable' };
    if (m.kind === 'absent') {
      // the inference applies only to an ABSENT marks file (a cleared marker is a valid file saying `damaged: null`) AND a version holding nothing
      const key = keyOfDir(dir); const aside = nodePath.join(nodePath.dirname(nodePath.dirname(dir)), 'aside');
      if ((await fs.readdir(dir)).some((n) => /^body-[0-9a-f]{16}\.bin$/.test(n))) return null;
      for (const n of (await fs.readdir(aside)).sort().reverse()) if (new RegExp(`^${key}-q\\d+$`).test(n) && await fs.exists(nodePath.join(aside, n, 'COMPLETE'))) return { asideName: n, reason: 'the marker was lost; the quarantined copy is aside' };
    }
    return null;
  }

