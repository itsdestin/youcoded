// What goes INSIDE a sealed frame for the replicator (plan section 2): seven kinds, each with a strict parser.
// Everything here is pure. A parser returns plain values or throws MeshCryptoError('malformed') (via `guard`), so hostile bytes never
// escape as a raw error and the link counts them as a rejection by name.
//
// WHY STRICT: these bodies come from a device that is on the roster but may be broken, out of date or hostile. Every count, length and
// text field has a fixed ceiling BEFORE anything is allocated from it, unknown fields are refused (`onlyKeys`), and hashes and signatures
// must be exactly their size. A claim in a body (a head, a count) schedules work and never proves anything (replicator.ts invariant 4).
import { CborValue, asArray, asBytes, asMap, asText, asUint, onlyKeys } from '../crypto/cbor';
import { guard } from '../crypto/errors';

export const KIND_LINES = 'rep.lines';
export const KIND_SUM = 'rep.sum';
export const KIND_HEADS = 'rep.heads';
export const KIND_INTRO = 'rep.intro';
export const KIND_WANT = 'rep.want';
export const KIND_ACK = 'rep.ack';
export const KIND_NAK = 'rep.nak';
export const REPLICATOR_KINDS: ReadonlySet<string> = new Set([KIND_LINES, KIND_SUM, KIND_HEADS, KIND_INTRO, KIND_WANT, KIND_ACK, KIND_NAK]);
/** The one group the live lane (everything but `rep.lines`) travels in. Chat lines travel in a group per chat (replicator.ts chatGroup). */
export const GROUP_LIVE = 'rep.live';

// ---- limits (each one is a ceiling on what a parser will accept) ----
export const MAX_LINES_PER_FRAME = 256;
/** Payload bytes of lines in one frame. WHY 640 KiB: the sealed frame (CBOR, signature, AEAD, padding buckets) must stay under the relay's 1 MiB. */
export const PAYLOAD_BUDGET_BYTES = 640 * 1024;
/** One line larger than the budget travels alone, cut into parts of this size. */
export const PART_BYTES = 512 * 1024;
/** The most a single reassembled line may be (the store caps one append call too). */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;
export const MAX_PARTS = Math.ceil(MAX_LINE_BYTES / PART_BYTES);
export const MAX_HEADS_PER_PAGE = 2000;
export const MAX_VERSION_ID_BYTES = 64;
export const MAX_PAGES = 64;

export type NakWhy = 'gap' | 'evicted' | 'not-a-prefix' | 'unavailable' | 'disk-full' | 'unknown-version';
const NAK_WHYS: readonly NakWhy[] = ['gap', 'evicted', 'not-a-prefix', 'unavailable', 'disk-full', 'unknown-version'];
export type AdvertisedState = 'ok' | 'refilling' | 'damaged';
const STATES: readonly AdvertisedState[] = ['ok', 'refilling', 'damaged'];

export interface SignedHead { lines: number; hash: Buffer; sig: Buffer }
export interface LinesBody {
  version: Buffer;
  from: number;
  lines: Buffer[];
  head: SignedHead;
  part?: { index: number; of: number; totalBytes: number };
}
export interface HeadEntry { version: Buffer; lines: number; hash: Buffer; conversationHash: Buffer; stamp: number; state: AdvertisedState }
export interface HeadsBody { page: number; of: number; ask: boolean; heads: HeadEntry[] }
export interface IntroBody {
  version: Buffer; chatId: string; runtime: 'claude-code' | 'native'; parent: Buffer | null; forkLine: number | null; forkHash: Buffer | null; token: string | null; writer: Buffer; sig: Buffer;
}
export interface WantBody { version: Buffer; haveLines: number; haveHash: Buffer; through: number | null; intro: boolean }
export interface AckBody { version: Buffer; lines: number; hash: Buffer; sig: Buffer }
export interface NakBody { version: Buffer; at: number; why: NakWhy; hashAtYourCount: Buffer | null }
export interface SumBody { count: number; digest: Buffer }

const ver = (v: unknown): Buffer => { const b = asBytes(v, 'version'); if (b.length < 1 || b.length > MAX_VERSION_ID_BYTES) throw new RangeError('version id size'); return b; };
const hash = (v: unknown, what: string): Buffer => asBytes(v, what, 32);
const oneOf = <T extends string>(v: unknown, set: readonly T[], what: string): T => { const s = asText(v, what, 32); if (!(set as readonly string[]).includes(s)) throw new RangeError(what); return s as T; };

// ---- lines ----
export const linesBody = (b: LinesBody): CborValue => ({
  v: b.version, from: b.from, lines: b.lines, head: { lines: b.head.lines, hash: b.head.hash, sig: b.head.sig },
  ...(b.part ? { part: { index: b.part.index, of: b.part.of, total: b.part.totalBytes } } : {}),
});
export function parseLinesBody(body: unknown): LinesBody {
  return guard(() => {
    const m = asMap(body, 'lines body');
    onlyKeys(m, ['v', 'from', 'lines', 'head', 'part'], 'lines body');
    const lines = asArray(m.lines, 'lines', MAX_LINES_PER_FRAME).map((l) => asBytes(l, 'line'));
    if (lines.length === 0) throw new RangeError('no lines');
    const from = asUint(m.from, 'from');
    const h = asMap(m.head, 'head');
    onlyKeys(h, ['lines', 'hash', 'sig'], 'head');
    const head = { lines: asUint(h.lines, 'head lines'), hash: hash(h.hash, 'head hash'), sig: asBytes(h.sig, 'head sig', 64) };
    let part: LinesBody['part'];
    if (m.part !== undefined) {
      const p = asMap(m.part, 'part');
      onlyKeys(p, ['index', 'of', 'total'], 'part');
      part = { index: asUint(p.index, 'part index', MAX_PARTS - 1), of: asUint(p.of, 'part of', MAX_PARTS), totalBytes: asUint(p.total, 'part total', MAX_LINE_BYTES) };
      if (part.of < 2 || part.index >= part.of || lines.length !== 1) throw new RangeError('part shape');
      if (part.totalBytes <= (part.of - 1) * PART_BYTES || part.totalBytes > part.of * PART_BYTES) throw new RangeError('part total');
    }
    // WHY here and not later: with a part the head names the line AFTER the whole line, so the arithmetic is the same either way.
    if (head.lines !== from + (part ? 1 : lines.length)) throw new RangeError('head does not equal from + lines');
    let bytes = 0;
    for (const l of lines) bytes += l.length;
    if (bytes > PAYLOAD_BUDGET_BYTES && !part) throw new RangeError('payload over budget');
    if (part && lines[0].length > PART_BYTES) throw new RangeError('part too large');
    return { version: ver(m.v), from, lines, head, ...(part ? { part } : {}) };
  });
}

// ---- sum / heads ----
export const sumBody = (b: SumBody): CborValue => ({ count: b.count, digest: b.digest });
export function parseSumBody(body: unknown): SumBody {
  return guard(() => { const m = asMap(body, 'sum body'); onlyKeys(m, ['count', 'digest'], 'sum body'); return { count: asUint(m.count, 'count', 1 << 24), digest: hash(m.digest, 'digest') }; });
}
export const headsBodyOf = (b: HeadsBody): CborValue => ({
  page: b.page, of: b.of, ask: b.ask,
  heads: b.heads.map((h) => ({ v: h.version, lines: h.lines, hash: h.hash, conv: h.conversationHash, stamp: h.stamp, state: h.state })),
});
export function parseHeadsBody(body: unknown): HeadsBody {
  return guard(() => {
    const m = asMap(body, 'heads body');
    onlyKeys(m, ['page', 'of', 'ask', 'heads'], 'heads body');
    const of = asUint(m.of, 'of', MAX_PAGES);
    const page = asUint(m.page, 'page', MAX_PAGES);
    if (of < 1 || page >= of || typeof m.ask !== 'boolean') throw new RangeError('page numbers');
    const heads = asArray(m.heads, 'heads', MAX_HEADS_PER_PAGE).map((v): HeadEntry => {
      const e = asMap(v, 'head entry');
      onlyKeys(e, ['v', 'lines', 'hash', 'conv', 'stamp', 'state'], 'head entry');
      return { version: ver(e.v), lines: asUint(e.lines, 'lines'), hash: hash(e.hash, 'hash'), conversationHash: hash(e.conv, 'conv'), stamp: asUint(e.stamp, 'stamp', 0xffffffff), state: oneOf(e.state, STATES, 'state') };
    });
    return { page, of, ask: m.ask, heads };
  });
}

// ---- intro ----
const INTRO_KEYS = ['v', 'chat', 'rt', 'parent', 'forkLine', 'forkHash', 'token', 'writer', 'sig'] as const;
export const introBodyOf = (b: IntroBody): CborValue => ({
  v: b.version, chat: b.chatId, rt: b.runtime, parent: b.parent, forkLine: b.forkLine, forkHash: b.forkHash, token: b.token, writer: b.writer, sig: b.sig,
});
export function parseIntroBody(body: unknown): IntroBody {
  return guard(() => {
    const m = asMap(body, 'intro body');
    onlyKeys(m, INTRO_KEYS, 'intro body');
    const parent = m.parent === null ? null : ver(m.parent);
    const forkLine = m.forkLine === null ? null : asUint(m.forkLine, 'forkLine');
    const forkHash = m.forkHash === null ? null : hash(m.forkHash, 'forkHash');
    const token = m.token === null ? null : asText(m.token, 'token', 200);
    // WHY all-or-none: a child names its parent, the fork line, the chain value there and the takeover token together, or it is a root version.
    if ((parent === null) !== (forkLine === null) || (parent === null) !== (forkHash === null) || (parent === null) !== (token === null)) throw new RangeError('fork fields');
    const chatId = asText(m.chat, 'chat', 256);
    if (chatId.length === 0) throw new RangeError('chat id');
    return { version: ver(m.v), chatId, runtime: oneOf(m.rt, ['claude-code', 'native'] as const, 'runtime'), parent, forkLine, forkHash, token, writer: asBytes(m.writer, 'writer', 16), sig: asBytes(m.sig, 'sig', 64) };
  });
}

// ---- want / ack / nak ----
export const wantBodyOf = (b: WantBody): CborValue => ({ v: b.version, have: b.haveLines, hash: b.haveHash, through: b.through, intro: b.intro });
export function parseWantBody(body: unknown): WantBody {
  return guard(() => {
    const m = asMap(body, 'want body');
    onlyKeys(m, ['v', 'have', 'hash', 'through', 'intro'], 'want body');
    if (typeof m.intro !== 'boolean') throw new RangeError('intro flag');
    return { version: ver(m.v), haveLines: asUint(m.have, 'have'), haveHash: hash(m.hash, 'hash'), through: m.through === null ? null : asUint(m.through, 'through'), intro: m.intro };
  });
}
export const ackBodyOf = (b: AckBody): CborValue => ({ v: b.version, lines: b.lines, hash: b.hash, sig: b.sig });
export function parseAckBody(body: unknown): AckBody {
  return guard(() => { const m = asMap(body, 'ack body'); onlyKeys(m, ['v', 'lines', 'hash', 'sig'], 'ack body'); return { version: ver(m.v), lines: asUint(m.lines, 'lines'), hash: hash(m.hash, 'hash'), sig: asBytes(m.sig, 'sig', 64) }; });
}
export const nakBodyOf = (b: NakBody): CborValue => ({ v: b.version, at: b.at, why: b.why, mine: b.hashAtYourCount });
export function parseNakBody(body: unknown): NakBody {
  return guard(() => {
    const m = asMap(body, 'nak body');
    onlyKeys(m, ['v', 'at', 'why', 'mine'], 'nak body');
    return { version: ver(m.v), at: asUint(m.at, 'at'), why: oneOf(m.why, NAK_WHYS, 'why'), hashAtYourCount: m.mine === null ? null : hash(m.mine, 'mine') };
  });
}

// ---- what a signature covers (one place, so signer and verifier cannot drift) ----
const LABEL = 'youcoded-mesh/v1/replicator/';
const u64 = (n: number): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const lenPrefixed = (b: Buffer): Buffer => Buffer.concat([Buffer.from([b.length]), b]);
/** The writer's statement "version `v` has `lines` lines and the chain value there is `hash`". */
export const headMessage = (version: Buffer, lines: number, hashRaw: Buffer): Buffer => Buffer.concat([Buffer.from(LABEL + 'head\0'), lenPrefixed(version), u64(lines), hashRaw]);
/** A holder's statement "I hold `lines` lines of `version`, chain value `hash`" (the shape of an eviction proof ack). The holder is part of what is signed. */
export const ackMessage = (holder: Buffer, version: Buffer, lines: number, hashRaw: Buffer): Buffer => Buffer.concat([Buffer.from(LABEL + 'ack\0'), lenPrefixed(holder), lenPrefixed(version), u64(lines), hashRaw]);
/** What the writer signs in an intro. Every field is covered, so a relayed intro cannot be altered by the relaying peer. */
export function introMessage(b: Omit<IntroBody, 'sig'>): Buffer {
  const t = (s: string | null): Buffer => (s === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), u64(Buffer.byteLength(s)), Buffer.from(s)]));
  const bytes = (x: Buffer | null): Buffer => (x === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), lenPrefixed(x)]));
  return Buffer.concat([Buffer.from(LABEL + 'intro\0'), lenPrefixed(b.version), t(b.chatId), t(b.runtime), bytes(b.parent), b.forkLine === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), u64(b.forkLine)]), bytes(b.forkHash), t(b.token), lenPrefixed(b.writer)]);
}
