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
import { createHash } from 'node:crypto';
import { MAX_ANNOUNCED_PER_DEVICE } from './budget';
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
  /** Set when a DIFFERENT announcement for a known version was received (review 1, F4): the reason, kept for good (durable in the interim directory), or null. */
  conflict?(wire: Buffer): string | null;
}

export type AcceptResult = 'new' | 'known' | 'conflict' | 'bad-signature' | 'unknown-writer' | 'bad-fork-id' | 'bad-root-id' | 'bad-token' | 'over-budget';

/** A root version's id: SHA-256 over a label, the set, the chat, the writer's device id and a nonce the writer chose. Anyone can recompute it, so an announcement that names a DIFFERENT writer for an id
 *  cannot be valid (review 2, finding 4); the way `deriveForkId` binds a child to its parent. The writer's device id is itself derived from its signing key, and the announcement is signed by that key. */
export function deriveRootId(setId: Buffer, chatId: string, writer: Buffer, nonce: Buffer): Buffer {
  return createHash('sha256').update('youcoded-mesh/v1/root-id\0').update(setId).update('\0').update(chatId).update('\0').update(writer).update(nonce).digest();
}
/* A takeover's token must begin with the writer's device id in hex plus a colon, so two devices can never derive the same child id for different writers (review 2, finding 4, forks). */

export interface DirectoryOptions {
  /** The set this device belongs to (part of every root id). */
  setId: Buffer;
}

export class InterimDirectory implements VersionDirectory {
  readonly #byWire = new Map<string, IntroBody>();
  readonly #conflicts = new Map<string, string>();
  /** versions announced to me by each OTHER device (hex of the device id), for the per-device budget */
  readonly #announced = new Map<string, number>();
  #cbs: Array<(wire: Buffer) => void> = [];
  constructor(private readonly fs: Fs, private readonly dir: string, private readonly crypto: ReplicatorCrypto, private readonly opts: DirectoryOptions) {}
  private count(b: IntroBody): void { if (b.writer.equals(this.crypto.self)) return; const k = b.writer.toString('hex'); this.#announced.set(k, (this.#announced.get(k) ?? 0) + 1); }
  private path(wire: Buffer): string { return nodePath.join(this.dir, 'intro', wire.toString('hex')); }
  /** A second copy of every announcement (review 3, fuzz): the announcement of a version nobody else has yet may exist ONLY here, and one flipped bit in its file would make the writer forget its own chat.
   *  The announcement is authenticated by its signature, so a copy needs no checksum: whichever file still verifies is used, and the other is rewritten. */
  private copyPath(wire: Buffer): string { return nodePath.join(this.dir, 'intro-copy', wire.toString('hex')); }
  private async saveIntro(b: IntroBody): Promise<void> {
    const raw = encode(introBodyOf(b));
    await mkdirDurable(this.fs, nodePath.join(this.dir, 'intro')); await writeFileAtomic(this.fs, this.path(b.version), raw);
    try { await mkdirDurable(this.fs, nodePath.join(this.dir, 'intro-copy')); await writeFileAtomic(this.fs, this.copyPath(b.version), raw); } catch (cause) { reportFailure({ what: 'keep a second copy of a version announcement', cause, where: 'mesh.replicator.directory' }); }
  }
  private conflictPath(wire: Buffer): string { return nodePath.join(this.dir, 'conflict', wire.toString('hex')); }

  /** Read every saved announcement and conflict note again. A file that does not parse or whose signature fails is reported and skipped (never believed). */
  async load(): Promise<void> {
    const names = new Set([...await this.fs.readdir(nodePath.join(this.dir, 'intro')), ...await this.fs.readdir(nodePath.join(this.dir, 'intro-copy'))]);
    for (const name of names) {
      if (!/^[0-9a-f]{2,128}$/.test(name)) continue; // *.tmp-* scratch of an interrupted write
      let kept: IntroBody | null = null; let bad = 0;
      for (const path of [nodePath.join(this.dir, 'intro', name), nodePath.join(this.dir, 'intro-copy', name)]) {
        try {
          const raw = await this.fs.readFile(path);
          if (!raw) { bad++; continue; }
          const body = parseIntroBody(decode(raw));
          if (body.version.toString('hex') !== name) throw new Error('intro filed under another name');
          if (this.check(body) === 'ok') { if (!kept) kept = body; } else { bad++; reportFailure({ what: 'trust a saved version announcement (it fails its checks and is ignored)', where: 'mesh.replicator.directory' }); }
        } catch (cause) { bad++; reportFailure({ what: 'read a saved version announcement (it is ignored)', cause, where: 'mesh.replicator.directory' }); }
      }
      if (kept) { this.#byWire.set(name, kept); this.count(kept); if (bad > 0) await this.saveIntro(kept).catch((cause: unknown) => reportFailure({ what: 'rewrite a damaged copy of a version announcement', cause, where: 'mesh.replicator.directory' })); }
    }
    for (const name of await this.fs.readdir(nodePath.join(this.dir, 'conflict'))) {
      if (!/^[0-9a-f]{2,128}$/.test(name)) continue;
      try { const raw = await this.fs.readFile(nodePath.join(this.dir, 'conflict', name)); if (raw) this.#conflicts.set(name, raw.toString('utf8').slice(0, 200)); } catch (cause) { reportFailure({ what: 'read a saved announcement conflict', cause, where: 'mesh.replicator.directory' }); }
    }
  }

  /** A root id must be derived from its writer and nonce, a child's token must start with its writer (review 2, finding 4): an announcement for someone else's id is dropped on its face and creates no conflict.
   *  There is no unbound mode (review 3, finding 10); only a TEST subclass may override this, to keep arbitrary ids in older tests. */
  protected bindingOk(b: IntroBody): 'ok' | AcceptResult {
    if (b.parent === null && (!b.nonce || !b.version.equals(deriveRootId(this.opts.setId, b.chatId, b.writer, b.nonce)))) return 'bad-root-id';
    if (b.parent !== null && !(b.token as string).startsWith(`${b.writer.toString('hex')}:`)) return 'bad-token';
    return 'ok';
  }
  private check(b: IntroBody): 'ok' | AcceptResult {
    if (b.parent !== null && !b.version.equals(deriveForkId(b.parent, b.forkLine as number, (b.forkHash as Buffer).toString('hex'), b.token as string))) return 'bad-fork-id';
    const bound = this.bindingOk(b); if (bound !== 'ok') return bound;
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

  /** A received announcement. Only a verified, non-conflicting one is kept.
   *  WHY the decision is made BEFORE the first await (review 1, F4): two announcements handled in the same turn used to both see "not known yet" and the second one won; a paired device could
   *  time its own announcement with the real one and capture the version id. The map entry is set synchronously; the file is written after. */
  async accept(b: IntroBody): Promise<AcceptResult> {
    const key = b.version.toString('hex');
    const verdict = this.check(b);
    if (verdict !== 'ok') return verdict;
    const have = this.#byWire.get(key);
    if (have) {
      const { sig: _a, ...x } = have; const { sig: _b, ...y } = b; // eslint-disable-line @typescript-eslint/no-unused-vars
      if (introMessage(x).equals(introMessage(y))) return 'known';
      // a different announcement for a known version: remembered IN the directory (durable), never in a status flag a later append could clear
      if (!this.#conflicts.has(key)) {
        const why = `writer ${b.writer.toString('hex').slice(0, 8)} announced this version differently from ${have.writer.toString('hex').slice(0, 8)}`;
        this.#conflicts.set(key, why);
        await mkdirDurable(this.fs, nodePath.join(this.dir, 'conflict'));
        await writeFileAtomic(this.fs, this.conflictPath(b.version), Buffer.from(why, 'utf8'));
      }
      return 'conflict';
    }
    // the per-device budget (review 4, F7): checked before anything is kept or written, in the same synchronous stretch as the first-wins decision
    if (!b.writer.equals(this.crypto.self) && (this.#announced.get(b.writer.toString('hex')) ?? 0) >= MAX_ANNOUNCED_PER_DEVICE) return 'over-budget';
    this.#byWire.set(key, b); this.count(b);
    await this.saveIntro(b);
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
  conflict(wire: Buffer): string | null { return this.#conflicts.get(wire.toString('hex')) ?? null; }
}
