// The version directory: what the replicator needs to know about a version before it will copy a byte of it, and WHO is its writer.
// This is the stand-in for the control log (plan section 1, seam `VersionDirectory`); the real one replaces `InterimDirectory` later and nothing else changes.
//
// INTERIM RULES (loud limits, stated here because they are weaker than the control log's):
//  * An announcement ("intro") is signed by the device that claims to be the version's writer, and is accepted only from a device on the roster.
//  * The first announcement for a version id wins on this device. A later one that differs is `conflict`: kept out, reported, never merged.
//  * A child version's id must equal deriveForkId(parent, forkLine, chain value, token) or the announcement is refused, so two devices cannot be handed
//    different children for one takeover, and nobody can claim an existing id for another parent.
//  * LIMIT: any paired device can announce itself as the writer of a NEW version id. It cannot take over an id this device already knows. The control log
//    (who may host which chat) closes this; until then a paired device is trusted not to invent versions, exactly as it is trusted not to flood.
import * as nodePath from 'node:path';
import { decode, encode } from '../crypto/cbor';
import { deriveForkId } from '../store/fork';
import { mkdirDurable, writeFileAtomic, type Fs } from '../store/fsio';
import { reportFailure } from '../../report-failure';
import { introBodyOf, introMessage, parseIntroBody, type IntroBody } from './wire';

export interface ReplicatorCrypto {
  /** This device's 16-byte id. */
  self: Buffer;
  sign(msg: Buffer): Buffer;
  /** Is this device on the roster (and not removed)? Distinguishes "cannot judge yet" from "wrong signature". */
  knows(device: Buffer): boolean;
  verify(device: Buffer, msg: Buffer, sig: Buffer): boolean;
}

export type VersionDescriptor = Omit<IntroBody, 'sig'>;

export interface VersionDirectory {
  describe(wire: Buffer): VersionDescriptor | null;
  /** The signed announcement as received, so a device that holds it can pass it on to one that does not. */
  intro(wire: Buffer): IntroBody | null;
  /** Does this device want a copy? (The control log decides; the interim directory wants every version it has been told about.) */
  wanted(wire: Buffer): boolean;
  list(): Buffer[];
  onChange(cb: (wire: Buffer) => void): void;
}

export type AcceptResult = 'new' | 'known' | 'conflict' | 'bad-signature' | 'unknown-writer' | 'bad-fork-id';

export class InterimDirectory implements VersionDirectory {
  readonly #byWire = new Map<string, IntroBody>();
  #cbs: Array<(wire: Buffer) => void> = [];
  constructor(private readonly fs: Fs, private readonly dir: string, private readonly crypto: ReplicatorCrypto) {}
  private path(wire: Buffer): string { return nodePath.join(this.dir, 'intro', wire.toString('hex')); }

  /** Read every saved announcement again. A file that does not parse or whose signature fails is reported and skipped (never believed). */
  async load(): Promise<void> {
    const names = await this.fs.readdir(nodePath.join(this.dir, 'intro'));
    for (const name of names) {
      if (!/^[0-9a-f]{2,128}$/.test(name)) continue; // *.tmp-* scratch of an interrupted write
      try {
        const raw = await this.fs.readFile(nodePath.join(this.dir, 'intro', name));
        if (!raw) continue;
        const body = parseIntroBody(decode(raw));
        if (body.version.toString('hex') !== name) throw new Error('intro filed under another name');
        if (this.check(body) === 'ok') this.#byWire.set(name, body);
        else reportFailure({ what: 'trust a saved version announcement (it fails its checks and is ignored)', where: 'mesh.replicator.directory' });
      } catch (cause) { reportFailure({ what: 'read a saved version announcement (it is ignored)', cause, where: 'mesh.replicator.directory' }); }
    }
  }

  private check(b: IntroBody): 'ok' | AcceptResult {
    if (b.parent !== null && !b.version.equals(deriveForkId(b.parent, b.forkLine as number, (b.forkHash as Buffer).toString('hex'), b.token as string))) return 'bad-fork-id';
    if (!this.crypto.knows(b.writer)) return 'unknown-writer';
    const { sig, ...d } = b;
    return this.crypto.verify(b.writer, introMessage(d), sig) ? 'ok' : 'bad-signature';
  }

  /** This device is the writer: sign and keep the announcement. */
  async announce(d: VersionDescriptor): Promise<IntroBody> {
    if (!d.writer.equals(this.crypto.self)) throw new RangeError('only the writer announces a version');
    const body: IntroBody = { ...d, sig: this.crypto.sign(introMessage(d)) };
    const r = await this.accept(body);
    if (r !== 'new' && r !== 'known') throw new Error(`announcement refused: ${r}`);
    return body;
  }

  /** A received announcement. Only a verified, non-conflicting one is kept. */
  async accept(b: IntroBody): Promise<AcceptResult> {
    const key = b.version.toString('hex');
    const have = this.#byWire.get(key);
    const verdict = this.check(b);
    if (verdict !== 'ok') return verdict;
    if (have) {
      const { sig: _a, ...x } = have; const { sig: _b, ...y } = b; // eslint-disable-line @typescript-eslint/no-unused-vars
      return introMessage(x).equals(introMessage(y)) ? 'known' : 'conflict';
    }
    await mkdirDurable(this.fs, nodePath.join(this.dir, 'intro'));
    await writeFileAtomic(this.fs, this.path(b.version), encode(introBodyOf(b)));
    this.#byWire.set(key, b);
    for (const cb of this.#cbs) cb(b.version);
    return 'new';
  }

  describe(wire: Buffer): VersionDescriptor | null {
    const b = this.#byWire.get(wire.toString('hex'));
    if (!b) return null;
    const { sig: _s, ...d } = b; // eslint-disable-line @typescript-eslint/no-unused-vars
    return d;
  }
  intro(wire: Buffer): IntroBody | null { return this.#byWire.get(wire.toString('hex')) ?? null; }
  wanted(wire: Buffer): boolean { return this.#byWire.has(wire.toString('hex')); }
  list(): Buffer[] { return [...this.#byWire.keys()].map((h) => Buffer.from(h, 'hex')); }
  onChange(cb: (wire: Buffer) => void): void { this.#cbs.push(cb); }
}
