// Replicator wire bodies: round trips, and every parser refusing hostile shapes with the one typed error (never a raw throw, never a huge allocation).
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encode, decode, type CborValue } from '../crypto/cbor';
import { MeshCryptoError } from '../crypto/errors';
import { ackBodyOf, headsBodyOf, introBodyOf, linesBody, nakBodyOf, parseAckBody, parseHeadsBody, parseIntroBody, parseLinesBody, parseNakBody, parseSumBody, parseWantBody, sumBody, wantBodyOf, headMessage, ackMessage, introMessage, PART_BYTES, MAX_LINES_PER_FRAME, PAYLOAD_BUDGET_BYTES } from './wire';

const h32 = (n = 1): Buffer => Buffer.alloc(32, n);
const v = Buffer.from('aa010001', 'hex');
const sig = Buffer.alloc(64, 7);
const line = (s: string): Buffer => Buffer.from(`${s}\n`);
const via = (b: CborValue): unknown => decode(encode(b)); // what the link hands a handler: a decoded value
const refuses = (fn: () => unknown): void => { try { fn(); } catch (e) { expect(e).toBeInstanceOf(MeshCryptoError); expect((e as MeshCryptoError).code).toBe('malformed'); return; } throw new Error('expected a refusal'); };

describe('replicator wire: round trips', () => {
  it('lines, heads, want, ack, nak, sum and intro survive encode, decode and parse unchanged', () => {
    const lb = { version: v, from: 3, lines: [line('a'), line('b')], head: { lines: 5, hash: h32(2), sig } };
    expect(parseLinesBody(via(linesBody(lb)))).toEqual(lb);
    const heads = { page: 0, of: 1, ask: true, heads: [{ version: v, lines: 9, hash: h32(), conversationHash: h32(3), stamp: 2, state: 'refilling' as const }] };
    expect(parseHeadsBody(via(headsBodyOf(heads)))).toEqual(heads);
    const w = { version: v, haveLines: 4, haveHash: h32(4), through: null, intro: false };
    expect(parseWantBody(via(wantBodyOf(w)))).toEqual(w);
    const a = { version: v, lines: 4, hash: h32(5), sig };
    expect(parseAckBody(via(ackBodyOf(a)))).toEqual(a);
    const n = { version: v, at: 4, why: 'not-a-prefix' as const, hashAtYourCount: h32(6) };
    expect(parseNakBody(via(nakBodyOf(n)))).toEqual(n);
    expect(parseSumBody(via(sumBody({ count: 3, digest: h32(8), ask: true })))).toEqual({ count: 3, digest: h32(8), ask: true });
    const intro = { version: v, chatId: 'chat-1', runtime: 'native' as const, parent: null, forkLine: null, forkHash: null, token: null, writer: Buffer.alloc(16, 9), sig };
    expect(parseIntroBody(via(introBodyOf(intro)))).toEqual(intro);
  });
  it('every signed statement covers a different label, so one signature can never stand in for another kind', () => {
    const msgs = [headMessage(v, 5, h32()), ackMessage(Buffer.alloc(16, 1), v, 5, h32())];
    expect(msgs[0].equals(msgs[1])).toBe(false);
    expect(headMessage(v, 5, h32()).equals(headMessage(v, 6, h32()))).toBe(false);
    expect(ackMessage(Buffer.alloc(16, 1), v, 5, h32()).equals(ackMessage(Buffer.alloc(16, 2), v, 5, h32()))).toBe(false); // the holder is covered
    const base = { version: v, chatId: 'c', runtime: 'native' as const, parent: null, forkLine: null, forkHash: null, token: null, writer: Buffer.alloc(16, 9) };
    expect(introMessage(base).equals(introMessage({ ...base, chatId: 'd' }))).toBe(false);
    expect(introMessage(base).equals(introMessage({ ...base, writer: Buffer.alloc(16, 8) }))).toBe(false);
  });
});

describe('replicator wire: hostile lines bodies are refused', () => {
  const ok = { v, from: 0, lines: [line('x')], head: { lines: 1, hash: h32(), sig } };
  it('an unknown field, a missing field, wrong sizes and a head that is not from + count are all refused', () => {
    refuses(() => parseLinesBody(via({ ...ok, extra: 1 })));
    refuses(() => parseLinesBody(via({ ...ok, v: undefined } as never)));
    refuses(() => parseLinesBody(via({ ...ok, head: { ...ok.head, hash: Buffer.alloc(31) } })));
    refuses(() => parseLinesBody(via({ ...ok, head: { ...ok.head, sig: Buffer.alloc(63) } })));
    refuses(() => parseLinesBody(via({ ...ok, head: { ...ok.head, lines: 2 } }))); // head.lines must equal from + lines.length
    refuses(() => parseLinesBody(via({ ...ok, lines: [] })));
    refuses(() => parseLinesBody(via({ ...ok, v: Buffer.alloc(65) })));
    refuses(() => parseLinesBody(via({ ...ok, v: Buffer.alloc(0) })));
    refuses(() => parseLinesBody(via({ ...ok, lines: ['text'] } as never)));
  });
  it('more lines than a frame may carry, or more payload than the budget, is refused before anything is copied', () => {
    const many = Array.from({ length: MAX_LINES_PER_FRAME + 1 }, () => line('x'));
    refuses(() => parseLinesBody(via({ v, from: 0, lines: many, head: { lines: many.length, hash: h32(), sig } })));
    const big = [Buffer.alloc(PAYLOAD_BUDGET_BYTES + 1, 0x61)];
    refuses(() => parseLinesBody(via({ v, from: 0, lines: big, head: { lines: 1, hash: h32(), sig } })));
  });
  it('a part must be one chunk of a line that really needs that many parts, and a lone part header is refused', () => {
    const part = (p: Record<string, number>, n = 1) => via({ ...ok, lines: Array.from({ length: n }, () => Buffer.alloc(10)), head: { ...ok.head, lines: n }, part: p });
    expect(parseLinesBody(part({ index: 0, of: 2, total: PART_BYTES + 5 })).part).toEqual({ index: 0, of: 2, totalBytes: PART_BYTES + 5 });
    refuses(() => parseLinesBody(part({ index: 2, of: 2, total: PART_BYTES + 5 }))); // index past the end
    refuses(() => parseLinesBody(part({ index: 0, of: 1, total: 5 }))); // one part is not a part
    refuses(() => parseLinesBody(part({ index: 0, of: 2, total: 10 }))); // total too small for two parts
    refuses(() => parseLinesBody(part({ index: 0, of: 2, total: 2 * PART_BYTES + 1 }))); // total too large for two parts
    refuses(() => parseLinesBody(part({ index: 0, of: 2, total: PART_BYTES + 5 }, 2))); // a part carries exactly one chunk
    refuses(() => parseLinesBody(part({ index: 0, of: 2, total: PART_BYTES + 5, x: 1 })));
  });
});

describe('replicator wire: the other parsers refuse hostile shapes', () => {
  it('heads: page numbers, oversize lists, unknown states and a non-boolean ask are refused', () => {
    const e = { v, lines: 1, hash: h32(), conv: h32(), stamp: 1, state: 'ok' };
    refuses(() => parseHeadsBody(via({ page: 1, of: 1, ask: false, heads: [] })));
    refuses(() => parseHeadsBody(via({ page: 0, of: 0, ask: false, heads: [] })));
    refuses(() => parseHeadsBody(via({ page: 0, of: 1, ask: 1, heads: [] } as never)));
    refuses(() => parseHeadsBody(via({ page: 0, of: 1, ask: false, heads: [{ ...e, state: 'fine' }] })));
    refuses(() => parseHeadsBody(via({ page: 0, of: 1, ask: false, heads: Array.from({ length: 2001 }, () => e) })));
    refuses(() => parseHeadsBody(via({ page: 0, of: 1, ask: false, heads: [{ ...e, stamp: 2 ** 33 }] })));
  });
  it('intro: fork fields are all or none, and runtime and sizes are fixed', () => {
    const root = { v, chat: 'c', rt: 'native', parent: null, forkLine: null, forkHash: null, token: null, writer: Buffer.alloc(16), sig };
    expect(() => parseIntroBody(via(root))).not.toThrow();
    refuses(() => parseIntroBody(via({ ...root, parent: v })));
    refuses(() => parseIntroBody(via({ ...root, rt: 'other' })));
    refuses(() => parseIntroBody(via({ ...root, writer: Buffer.alloc(15) })));
    refuses(() => parseIntroBody(via({ ...root, chat: '' })));
    refuses(() => parseIntroBody(via({ ...root, token: 'x' })));
  });
  it('want, ack, nak and sum: wrong types, sizes and reasons are refused', () => {
    refuses(() => parseWantBody(via({ v, have: 1, hash: h32(), through: null })));
    refuses(() => parseWantBody(via({ v, have: 1, hash: h32(), through: null, intro: 'yes' } as never)));
    refuses(() => parseAckBody(via({ v, lines: 1, hash: h32(), sig: Buffer.alloc(10) })));
    refuses(() => parseNakBody(via({ v, at: 1, why: 'because', mine: null })));
    refuses(() => parseNakBody(via({ v, at: 1, why: 'gap', mine: Buffer.alloc(3) })));
    refuses(() => parseSumBody(via({ count: 2 ** 30, digest: h32(), ask: false })));
    refuses(() => parseSumBody(via({ count: 1, digest: h32() })));
    refuses(() => parseSumBody(via('text')));
    refuses(() => parseSumBody(via(null)));
  });
  it('random decoded values of every shape only ever produce the typed refusal', () => {
    const parsers = [parseLinesBody, parseHeadsBody, parseIntroBody, parseWantBody, parseAckBody, parseNakBody, parseSumBody];
    const rnd = (d: number): CborValue => {
      const k = randomBytes(1)[0] % 7;
      if (d > 3 || k === 0) return randomBytes(randomBytes(1)[0] % 40);
      if (k === 1) return randomBytes(1)[0];
      if (k === 2) return Buffer.from(randomBytes(4)).toString('hex');
      if (k === 3) return [rnd(d + 1), rnd(d + 1)];
      if (k === 4) return null;
      if (k === 5) return true;
      return Object.fromEntries(['v', 'from', 'lines', 'head', 'page', 'of', 'heads', 'have', 'hash', 'count', 'digest', 'sig', 'why', 'at'].filter(() => randomBytes(1)[0] > 120).map((key) => [key, rnd(d + 1)]));
    };
    for (let i = 0; i < 3000; i++) {
      const val = decode(encode(rnd(0)));
      for (const p of parsers) { try { p(val); } catch (e) { expect(e).toBeInstanceOf(MeshCryptoError); } }
    }
  });
});
