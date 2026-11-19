// A two-slot record file written in place, the way the checkpoint is (checkpoint.ts), but with a JSON value inside the ONE envelope (envelope.ts).
//
// WHY: the "marks" file (a version's partial / damaged markers) and the high-water file both need "the newest statement wins, one torn write can only damage the slot
// being written, an older copy of the file loses by its sequence number". That used to be three mechanisms (two copies of partial, two copies of damaged, a checkpoint).
// Now it is this one. A slot is a fixed SLOT_BYTES; the sequence number is the envelope's `fresh` field, so it sits inside the checksum with the role and the version key.
import * as nodePath from 'node:path';
import type { Fs } from './fsio';
import { openEnv, sealEnv } from './envelope';

export const SLOT_BYTES = 1024;

export interface SlotState<T> {
  /** absent: no file; bad: a file with no valid slot of this role and version; ok: the newest valid slot's value */
  kind: 'absent' | 'bad' | 'ok';
  value: T | null;
  seq: number;
  /** where the NEXT in-place write goes: a damaged or unwritten slot first, else the older one */
  next: 0 | 1;
  slotsOk: number;
}

export async function readSlots<T>(fs: Fs, path: string, role: string, key: string): Promise<SlotState<T>> {
  const b = await fs.readFile(path);
  if (b === null) return { kind: 'absent', value: null, seq: 0, next: 0, slotsOk: 0 };
  const slots = [0, 1].map((i) => {
    const r = openEnv(b.subarray(i * SLOT_BYTES, (i + 1) * SLOT_BYTES), { role, version: key }, true);
    if (r.kind !== 'ok') return null;
    try { return { seq: r.fresh, value: JSON.parse(r.payload.toString('utf8')) as T }; } catch { return null; }
  });
  let best = -1;
  for (let i = 0; i < 2; i++) if (slots[i] && (best < 0 || slots[i]!.seq > slots[best]!.seq)) best = i;
  const slotsOk = slots.filter((x) => x !== null).length;
  if (best < 0) return { kind: 'bad', value: null, seq: 0, next: 0, slotsOk };
  return { kind: 'ok', value: slots[best]!.value, seq: slots[best]!.seq, next: (1 - best) as 0 | 1, slotsOk };
}

async function putSlot(fs: Fs, path: string, role: string, key: string, slot: 0 | 1, seq: number, value: unknown): Promise<void> {
  const env = sealEnv({ role, version: key, fresh: seq }, Buffer.from(JSON.stringify(value), 'utf8'));
  if (env.length > SLOT_BYTES) throw new Error(`slot value too large for ${role}`);
  const buf = Buffer.alloc(SLOT_BYTES); env.copy(buf, 0);
  const created = !(await fs.exists(path));
  const f = await fs.open(path, { create: true });
  try {
    // DESTRUCTIVE-OK(verified-record): overwrites only the slot chosen by readSlots (a damaged one, else the OLDER); the newest valid slot is untouched, so a torn write leaves the previous statement intact
    await f.write(buf, slot * SLOT_BYTES); await f.sync();
  } finally { await f.close(); }
  if (created) await fs.fsyncDir(nodePath.dirname(path));
}

/** Write `value` as the newest statement into the slot that is safe to overwrite. `st` (from readSlots) is updated. */
export async function writeSlot<T>(fs: Fs, path: string, role: string, key: string, st: SlotState<T>, value: T): Promise<void> {
  await putSlot(fs, path, role, key, st.next, st.seq + 1, value);
  st.kind = 'ok'; st.value = value; st.seq += 1; st.next = (1 - st.next) as 0 | 1; st.slotsOk = Math.min(2, st.slotsOk + 1);
}

/** Write BOTH slots (used when a lower or different statement must not be undone by a stale higher slot coming back after a fault in the newest). */
export async function writeBothSlots<T>(fs: Fs, path: string, role: string, key: string, st: SlotState<T>, value: T): Promise<void> {
  const first = st.next;
  await putSlot(fs, path, role, key, first, st.seq + 1, value);
  await putSlot(fs, path, role, key, (1 - first) as 0 | 1, st.seq + 2, value);
  st.kind = 'ok'; st.value = value; st.seq += 2; st.next = first; st.slotsOk = 2;
}
