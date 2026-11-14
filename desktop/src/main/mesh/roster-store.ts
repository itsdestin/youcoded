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
//  * Every entry is verified with the crypto library's verifyRosterLog BEFORE it is written, and the whole log is
//    verified again on load. A bad entry is never persisted.
//  * A kill at ANY byte of the last record leaves a log that loads clean (test: truncate at every offset).
//  * Single writer: appends are queued, so two callers cannot interleave records.
import fs from 'fs';
import path from 'path';
import { toHex, sha256, ctEqual, type Bytes } from './crypto/bytes';
import { MeshCryptoError } from './crypto/errors';
import { encodeEntry, parseEntry, rosterHeads, verifyRosterLog, type SignedEntry, type VerifiedRoster, type RosterDevice } from './crypto/roster';
import { ensureDir, readFileIfExists, syncDir } from './fs-durable';

export class MeshRosterCorrupt extends Error {
  constructor(readonly why: 'record-damaged' | 'log-invalid') {
    super(`mesh roster log: ${why}`);
    this.name = 'MeshRosterCorrupt';
  }
}
export type AppendResult = 'appended' | 'duplicate';

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
  #verified: VerifiedRoster | null = null;
  #ids = new Set<string>();
  #queue: Promise<unknown> = Promise.resolve();
  #opened = false;
  /** Bytes of a torn last record trimmed at load (0 on a clean file). Diagnostic and test evidence only. */
  repairedTailBytes = 0;
  constructor(meshDir: string) {
    this.file = path.join(meshDir, 'roster.log');
  }

  /** Read and verify the log. Creates nothing when the file is absent. Trims a torn last record. */
  async load(): Promise<void> {
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
          // A length that runs past the end of the file is a torn tail ONLY if nothing valid could follow it;
          // by construction nothing follows, so it is the tail. (A damaged length in the middle shows up as a
          // check failure on an earlier-aligned record, handled below.)
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
        this.#verified = verifyRosterLog(entries);
      } catch (e) {
        if (e instanceof MeshCryptoError) throw new MeshRosterCorrupt('log-invalid');
        throw e;
      }
    }
    this.#entries = entries;
    this.#ids = new Set(entries.map((e) => toHex(e.id)));
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
    return this.#verified;
  }
  has(id: Bytes): boolean {
    return this.#ids.has(toHex(id));
  }
  heads(): Buffer[] {
    return rosterHeads(this.#entries);
  }
  /** Devices that were ever added and have not been removed by an entry in this log. */
  activeDevices(): RosterDevice[] {
    if (!this.#verified) return [];
    const removed = this.removedIds();
    return [...this.#verified.devices.entries()].filter(([id]) => !removed.has(id)).map(([, d]) => d);
  }
  removedIds(): Set<string> {
    const out = new Set<string>();
    for (const e of this.#entries) if (e.kind === 'remove') out.add(toHex(this.#targetOf(e)));
    return out;
  }
  #targetOf(e: SignedEntry): Buffer {
    return Buffer.from((e.body as { target: Uint8Array }).target);
  }
  /**
   * The signing key frames from `deviceId` are checked against, or undefined when the device is unknown OR removed.
   * WHY removed counts as unknown (conservative): the cut-off rule (what a removed device signed before it knew) is
   * the decide layer's and does not exist yet; refusing everything from a removed device is the safe reading.
   */
  signKeyFor(deviceId: Buffer): Buffer | undefined {
    const id = toHex(deviceId);
    if (this.removedIds().has(id)) return undefined;
    return this.#verified?.devices.get(id)?.signKey;
  }

  /**
   * Verify then durably append. Throws MeshCryptoError (bad-roster / bad-entry) for an entry that does not fit
   * the log; nothing is written in that case. Resolves 'duplicate' for an entry already held (idempotent).
   */
  append(entry: SignedEntry): Promise<AppendResult> {
    const run = async (): Promise<AppendResult> => {
      if (!this.#opened) throw new Error('RosterStore.load() must run first');
      if (this.#ids.has(toHex(entry.id))) return 'duplicate';
      const verified = verifyRosterLog([...this.#entries, entry]); // throws MeshCryptoError; the file is untouched
      const bytes = frame(entry);
      await ensureDir(path.dirname(this.file));
      const fresh = this.#entries.length === 0 && !(await fs.promises.stat(this.file).then(() => true, () => false));
      const h = await fs.promises.open(this.file, 'a', 0o600);
      try {
        await h.write(bytes);
        await h.datasync(); // the acknowledgement below means "on disk"
      } finally {
        await h.close();
      }
      if (fresh) await syncDir(path.dirname(this.file)); // a brand-new file's directory entry must survive too
      this.#entries = [...this.#entries, entry];
      this.#ids.add(toHex(entry.id));
      this.#verified = verified;
      return 'appended';
    };
    const p = this.#queue.then(run, run);
    this.#queue = p.catch(() => undefined);
    return p;
  }
}
