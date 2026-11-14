// Durable, append-only roster log (design 5.1 "Roster", S2 "fsynced before any acknowledgement").
//
// FILE: `<userData>/mesh/roster.log`, never inside a synced folder. A flat run of records:
//     u32 length | encoded signed entry | u32 check          (check = first 4 bytes of SHA-256(length || entry))
// WHY a check on each record: a power cut can leave the last record half written, or written with garbage
// bytes after the file grew. The check lets load tell "torn last record" (dropped and trimmed, the append was
// never acknowledged) from "damaged record in the middle" (history is gone: refuse, never silently shorten).
//
// GUARANTEES
//  * append() resolves only after the record is on disk (write + fdatasync). An acknowledged entry survives a kill.
//  * Every entry is verified incrementally (crypto RosterVerifier.prepare) BEFORE it is written, and the whole log is
//    verified again on load. A bad entry is never persisted.
//  * A kill at ANY byte of the last record leaves a log that loads clean (test: truncate at every offset).
//  * Single writer: appends are queued, so two callers cannot interleave records.
import fs from 'fs';
import path from 'path';
import { toHex, sha256, ctEqual, type Bytes } from './crypto/bytes';
import { MeshCryptoError } from './crypto/errors';
import { deviceIdFor } from './crypto/identity';
import { DEFAULT_MUTUAL_RULE, RosterVerifier, type MutualRule, verifyRosterLog, encodeEntry, parseEntry, rosterHeads, type SignedEntry, type VerifiedRoster, type RosterDevice } from './crypto/roster';
import { ensureDir, readFileIfExists, syncDir } from './fs-durable';

export class MeshRosterCorrupt extends Error {
  constructor(readonly why: 'record-damaged' | 'log-invalid') {
    super(`mesh roster log: ${why}`);
    this.name = 'MeshRosterCorrupt';
  }
}
export type AppendResult = 'appended' | 'duplicate';

/** An entry refused because of HOW FAST one DELIVERING member is handing them over (never because of whose name is on the entry:
 *  review N2). Only entries whose signature has already verified are counted, so unsigned junk can never use up anyone's allowance. */
export class MeshRosterRejected extends Error {
  constructor(readonly why: 'rate' | 'flagged', readonly signer: string) {
    super(`mesh roster entry rejected: ${why}`);
    this.name = 'MeshRosterRejected';
  }
}
/** New, signature-checked entries one delivering member may hand over per rolling hour. An honest catch-up is far below this (a device
 *  writes a handful of entries a year); a hostile member is bounded by its own per-device quota of 512 anyway. */
export const REMOTE_ENTRIES_PER_HOUR = 600;
const HOUR_MS = 3_600_000;

const MAX_RECORD = 1 << 20; // far above any entry; stops a damaged length field from allocating gigabytes
const checkOf = (len: Buffer, body: Buffer): Buffer => sha256(len, body).subarray(0, 4);
function frame(entry: SignedEntry): Buffer {
  const body = encodeEntry(entry);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, body, checkOf(len, body)]);
}

export class RosterStore {
  readonly file: string;
  #entries: SignedEntry[] = [];
  #v: RosterVerifier | null = null;
  readonly #arrivals = new Map<string, number[]>();
  /** Delivering members judged to be flooding: what THEY hand over is not examined any more (entries come from others as before). In memory on purpose. */
  readonly flagged = new Set<string>();
  #ids = new Set<string>();
  readonly #byId = new Map<string, SignedEntry>();
  #queue: Promise<unknown> = Promise.resolve();
  #opened = false;
  /** Bytes of a torn last record trimmed at load (0 on a clean file). Diagnostic and test evidence only. */
  repairedTailBytes = 0;
  readonly #memory: boolean;
  /** `opts.memory`: keep everything in memory, touch no file (the convergence fuzz and nothing else: it runs thousands of schedules). */
  constructor(meshDir: string, private readonly now: () => number = Date.now, opts: { memory?: boolean; mutual?: MutualRule } = {}) {
    this.file = path.join(meshDir, 'roster.log');
    this.#memory = opts.memory === true;
    this.#mutual = opts.mutual ?? DEFAULT_MUTUAL_RULE;
    if (this.#memory) this.#opened = true;
  }
  readonly #mutual: MutualRule;

  /** Read and verify the log. Creates nothing when the file is absent. Trims a torn last record. */
  async load(): Promise<void> {
    if (this.#memory) return;
    const raw = await readFileIfExists(this.file);
    const entries: SignedEntry[] = [];
    let good = 0;
    if (raw) {
      let pos = 0;
      while (pos < raw.length) {
        const rest = raw.length - pos;
        if (rest < 4) break; // torn inside the length
        const len = raw.subarray(pos, pos + 4);
        const n = len.readUInt32BE(0);
        const end = pos + 4 + n + 4;
        if (n === 0 || n > MAX_RECORD || end > raw.length) {
          // A length that runs past the end of the file is a torn tail ONLY if nothing valid follows it.
          // WHY (review finding 14): one flipped byte in the length of a MIDDLE record used to look like a torn tail and the rest of the
          // log, removals included, was silently truncated away. Now: if any intact record can be found after this point, the length is
          // damaged, history is at stake, and we refuse and leave the file exactly as it is.
          if (validRecordFollows(raw, pos + 1)) throw new MeshRosterCorrupt('record-damaged');
          break;
        }
        const body = raw.subarray(pos + 4, pos + 4 + n);
        const check = raw.subarray(pos + 4 + n, end);
        if (!ctEqual(check, checkOf(len, body))) {
          if (end === raw.length) break; // the final record, written with garbage: torn tail
          throw new MeshRosterCorrupt('record-damaged');
        }
        let e: SignedEntry;
        try {
          e = parseEntry(body);
        } catch {
          throw new MeshRosterCorrupt('record-damaged'); // passes its check yet is not an entry: not a torn write
        }
        entries.push(e);
        pos = end;
        good = pos;
      }
      this.repairedTailBytes = raw.length - good;
    }
    if (entries.length > 0) {
      try {
        this.#v = verifyRosterLog(entries, this.#mutual);
      } catch (e) {
        if (e instanceof MeshCryptoError) throw new MeshRosterCorrupt('log-invalid');
        throw e;
      }
    }
    this.#entries = entries;
    this.#ids = new Set(entries.map((e) => toHex(e.id)));
    this.#byId.clear();
    for (const e of entries) this.#byId.set(toHex(e.id), e);
    if (raw && this.repairedTailBytes > 0) {
      // Trim the torn record so the next append does not land after garbage. Durable before we carry on.
      const h = await fs.promises.open(this.file, 'r+');
      try {
        await h.truncate(good);
        await h.sync();
      } finally {
        await h.close();
      }
    }
    this.#opened = true;
  }

  get entries(): readonly SignedEntry[] {
    return this.#entries;
  }
  get size(): number {
    return this.#entries.length;
  }
  get verified(): VerifiedRoster | null {
    return this.#v;
  }
  /** Entries that may still be added before the log is full (the screen can warn when this gets small). */
  get headroom(): number {
    return this.#v ? this.#v.headroom : 8192;
  }
  countOf(deviceHex: string): number {
    return this.#v?.countOf(deviceHex) ?? 0;
  }
  has(id: Bytes): boolean {
    return this.#ids.has(toHex(id));
  }
  entryById(id: Bytes): SignedEntry | undefined {
    return this.#byId.get(toHex(id));
  }
  /** The `add` entry that introduced a device (the genesis entry for the creator), or undefined. */
  introductionOf(deviceId: Buffer): SignedEntry | undefined {
    const want = toHex(deviceId);
    for (const e of this.#entries) {
      if (e.kind !== 'add') continue;
      const k = (e.body as { signKey?: Uint8Array } | null)?.signKey;
      if (k && toHex(deviceIdFor(k)) === want) return e;
    }
    return undefined;
  }
  /** Devices (hex) that have signed an entry of their own: pairing completed. Active devices not in this set are "pending". */
  confirmedIds(): Set<string> {
    return new Set(this.#v?.confirmed ?? []);
  }
  /** Effective removal entries (hex ids) of a device. */
  removalIdsOf(deviceHex: string): string[] {
    return this.#v?.removalsOf(deviceHex) ?? [];
  }
  voidedIds(): Set<string> {
    return new Set(this.#v?.voided ?? []);
  }
  heads(): Buffer[] {
    return rosterHeads(this.#entries);
  }
  /** Devices that were ever added and have not been removed by an entry in this log. */
  activeDevices(): RosterDevice[] {
    if (!this.#v) return [];
    return this.#v.active();
  }
  removedIds(): Set<string> {
    return new Set(this.#v?.removed ?? []);
  }
  /**
   * The signing key frames from `deviceId` are checked against, or undefined when the device is unknown OR removed.
   * WHY removed counts as unknown (conservative): the cut-off rule (what a removed device signed before it knew) is
   * the decide layer's and does not exist yet; refusing everything from a removed device is the safe reading.
   * (Constant time: the verifier keeps the removed set, it is no longer rebuilt from the whole log per frame.)
   */
  signKeyFor(deviceId: Buffer): Buffer | undefined {
    const id = toHex(deviceId);
    if (!this.#v || this.#v.removed.has(id)) return undefined;
    return this.#v.devices.get(id)?.signKey;
  }
  /** True when this device is on the roster but has been removed. */
  isRemoved(deviceId: Buffer): boolean {
    return this.#v?.removed.has(toHex(deviceId)) ?? false;
  }

  /**
   * Verify then durably append. Throws MeshCryptoError (bad-roster / bad-entry) for an entry that does not fit
   * the log; nothing is written in that case. Resolves 'duplicate' for an entry already held (idempotent).
   */
  append(entry: SignedEntry, opts: { remote?: boolean; from?: string } = {}): Promise<AppendResult> {
    const run = async (): Promise<AppendResult> => {
      if (!this.#opened) throw new Error('RosterStore.load() must run first');
      if (this.#ids.has(toHex(entry.id))) return 'duplicate';
      // prepare() checks one entry (its signature against the key of an `add` we hold, its place in the log); commit() adds it to the set
      // after the record is on disk, so memory never gets ahead of the file. A throw leaves both untouched.
      const v = this.#v ?? new RosterVerifier(this.#mutual);
      const commit = v.prepare(entry);
      // WHY here, after the signature checked (review N2): the allowance belongs to the member that DELIVERED the entry and is spent only by
      // entries that are really signed by a member, so junk naming someone else's id costs that someone nothing.
      if (opts.remote && opts.from) this.chargeDeliverer(opts.from);
      if (!this.#memory) {
        const bytes = frame(entry);
        await ensureDir(path.dirname(this.file));
        const fresh = this.#entries.length === 0 && !(await fs.promises.stat(this.file).then(() => true, () => false));
        // WHY O_NOFOLLOW (review 15): the log is opened for append and would otherwise follow a symlink planted in the profile.
        const h = await fs.promises.open(this.file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
        try {
          await h.write(bytes);
          await h.datasync(); // the acknowledgement below means "on disk"
        } finally {
          await h.close();
        }
        if (fresh) await syncDir(path.dirname(this.file)); // a brand-new file's directory entry must survive too
      }
      commit();
      this.#v = v;
      this.#entries = [...this.#entries, entry];
      this.#ids.add(toHex(entry.id));
      this.#byId.set(toHex(entry.id), entry);
      return 'appended';
    };
    const p = this.#queue.then(run, run);
    this.#queue = p.catch(() => undefined);
    return p;
  }

  private chargeDeliverer(from: string): void {
    if (this.flagged.has(from)) throw new MeshRosterRejected('flagged', from);
    const t = this.now();
    const list = (this.#arrivals.get(from) ?? []).filter((x) => t - x < HOUR_MS);
    list.push(t);
    this.#arrivals.set(from, list);
    if (list.length > REMOTE_ENTRIES_PER_HOUR) {
      this.flagged.add(from);
      throw new MeshRosterRejected('rate', from);
    }
  }
}

/** Is there an intact record (length, a body that parses as an entry, matching check) anywhere in `raw` from `from` on? */
function validRecordFollows(raw: Buffer, from: number): boolean {
  for (let p = from; p + 8 < raw.length; p++) {
    const n = raw.readUInt32BE(p);
    if (n === 0 || n > MAX_RECORD || p + 8 + n > raw.length) continue;
    const len = raw.subarray(p, p + 4);
    const body = raw.subarray(p + 4, p + 4 + n);
    if (!ctEqual(raw.subarray(p + 4 + n, p + 8 + n), checkOf(len, body))) continue;
    try {
      parseEntry(body);
      return true;
    } catch { /* a coincidence of bytes, not a record */ }
  }
  return false;
}
