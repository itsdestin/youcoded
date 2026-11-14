// Property/fuzz tests: every function that parses or verifies outside bytes must throw ONLY
// MeshCryptoError (or return a verdict), never a raw TypeError/RangeError/OpenSSL error, and the
// pairing state machines must never throw at all for hostile input. Seeded PRNG, so a failure
// reproduces exactly; no new dependency (fast-check is not installed in this repo).
import { describe, expect, it } from 'vitest';
import { decode, encode, type CborValue } from './cbor';
import { FrameReceiver, FrameSender, peekHeader } from './frames';
import { generateIdentity, parseIdentity, serializeIdentity, setIdFor } from './identity';
import { Existing, NewDevice, type ExistingState } from './pairing';
import { makeGenesisEntry, parseEntry, parseEntryValue, verifyRosterLog, encodeEntry, makeAddEntry } from './roster';
import { RelayAuthVerifier } from './relay-auth';
import { hpkeOpenSealed } from './hpke';
import { openSecret } from './keygen';
import { newSetSecret } from './keys';
import { MeshCryptoError } from './errors';
import { normalizeCode } from './pairing';

// mulberry32: tiny deterministic PRNG.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = prng(0xc0ffee);
const randBytes = (n: number): Buffer => Buffer.from(Array.from({ length: n }, () => Math.floor(rnd() * 256)));
function mutate(b: Buffer): Buffer {
  const out = Buffer.from(b);
  const kind = Math.floor(rnd() * 5);
  if (kind === 0 && out.length) out[Math.floor(rnd() * out.length)] ^= 1 << Math.floor(rnd() * 8);
  else if (kind === 1) return out.subarray(0, Math.floor(rnd() * out.length));
  else if (kind === 2) return Buffer.concat([out, randBytes(1 + Math.floor(rnd() * 8))]);
  else if (kind === 3 && out.length) out[Math.floor(rnd() * out.length)] = Math.floor(rnd() * 256);
  else if (out.length > 2) {
    const i = Math.floor(rnd() * (out.length - 1));
    return Buffer.concat([out.subarray(0, i), out.subarray(i + 1)]);
  }
  return out;
}
/** Returns normally if f returned or threw MeshCryptoError; fails the test on anything else. */
function onlyTyped(f: () => unknown): void {
  try {
    f();
  } catch (e) {
    if (!(e instanceof MeshCryptoError)) throw new Error('escaped a non-MeshCryptoError: ' + (e instanceof Error ? e.constructor.name + ': ' + e.message : String(e)));
  }
}
const N = 1500;

function corpus(valid: Buffer[]): Buffer[] {
  const out: Buffer[] = [Buffer.alloc(0), Buffer.from([0xff]), Buffer.alloc(64), Buffer.alloc(64, 0xff)];
  for (let i = 0; i < N; i++) out.push(rnd() < 0.3 ? randBytes(Math.floor(rnd() * 300)) : mutate(valid[Math.floor(rnd() * valid.length)]));
  return out;
}

const A = generateIdentity();
const B = generateIdentity();
const setId = setIdFor(A.signKey);
const S1 = newSetSecret();
const genesis = makeGenesisEntry(A, 'D', 'linux', 1);
const addB = makeAddEntry(A, { name: 'P', platform: 'android', signKey: B.signKey, agreeKey: B.agreeKey }, [genesis.id], 2);
const sender = new FrameSender({ identity: A, setId });
const frames = [0, 1, 2].map((i) => sender.seal({ secret: S1, gen: 1, group: 'chat:v1', kind: 'lines', body: { i, t: 'x'.repeat(i * 40) } }));

describe('parsers throw only MeshCryptoError', () => {
  it('cbor decode', () => {
    const valid = [encode({ a: [1, 'x', Buffer.alloc(4)], b: null }), encode([1, 2, [3]]), encode('text')];
    for (const b of corpus(valid)) onlyTyped(() => decode(b));
  });
  it('frame open and peekHeader (a fresh receiver each time, as a keeper-fed device would)', () => {
    for (const b of corpus(frames)) {
      const r = new FrameReceiver({ setId, secretFor: () => S1, signKeyFor: () => A.signKey });
      onlyTyped(() => r.open(b));
      onlyTyped(() => peekHeader(b));
    }
  });
  it('a mutated frame never opens as a different body (authenticity, not just robustness)', () => {
    let opened = 0;
    for (let i = 0; i < 400; i++) {
      const orig = frames[i % 3];
      const m = mutate(orig);
      if (m.equals(orig)) continue;
      const r = new FrameReceiver({ setId, secretFor: () => S1, signKeyFor: () => A.signKey });
      try {
        r.open(m);
        opened++;
      } catch (e) {
        expect(e).toBeInstanceOf(MeshCryptoError);
      }
    }
    expect(opened).toBe(0);
  });
  it('receiver state import', () => {
    const r = new FrameReceiver({ setId, secretFor: () => S1, signKeyFor: () => A.signKey });
    r.open(frames[0]);
    for (const b of corpus([r.exportState()])) onlyTyped(() => new FrameReceiver({ setId, secretFor: () => S1, signKeyFor: () => A.signKey }).importState(b));
  });
  it('identity parse', () => {
    for (const b of corpus([serializeIdentity(A)])) onlyTyped(() => parseIdentity(b));
  });
  it('entry parse and roster verification', () => {
    for (const b of corpus([encodeEntry(genesis), encodeEntry(addB)])) {
      onlyTyped(() => parseEntry(b));
      onlyTyped(() => verifyRosterLog([parseEntry(b)]));
    }
    for (const v of [null, 5, 'x', [], {}, { id: 1 }, Buffer.alloc(3), [Buffer.alloc(3)]]) onlyTyped(() => parseEntryValue(v));
  });
  it('hpke open and keygen open', () => {
    for (const b of corpus([randBytes(80)])) {
      onlyTyped(() => hpkeOpenSealed(A.agreeSecret, b, Buffer.from('i'), Buffer.from('a')));
      onlyTyped(() => openSecret(A.agreeSecret, b, setId, 1, A.deviceId, B.deviceId));
    }
  });
  it('typed code normalisation', () => {
    for (let i = 0; i < N; i++) onlyTyped(() => normalizeCode(randBytes(Math.floor(rnd() * 12)).toString('latin1')));
  });
  it('relay verdicts never throw', () => {
    const v = new RelayAuthVerifier('r', () => A.signKey);
    const ch = v.challenge();
    for (let i = 0; i < 200; i++) {
      const out = v.verify({ room: randBytes(Math.floor(rnd() * 40)), nonce: rnd() < 0.5 ? ch.nonce : randBytes(32), dev: randBytes(Math.floor(rnd() * 20)), sig: randBytes(Math.floor(rnd() * 70)) });
      expect(out.ok).toBe(false);
    }
  });
});

describe('pairing state machines never throw on hostile input', () => {
  const state = (): ExistingState => ({ setId, secrets: new Map([[1, S1]]), roster: [genesis] });
  it('Existing.onMessage: random and mutated messages, before and after a handshake', () => {
    const E = new Existing(A, state(), { onAddPrompt: () => true });
    const inv = E.openInvite('code');
    const N = new NewDevice(generateIdentity(), { room: inv.room, secret: inv.secret }, 'code', { name: 'p', platform: 'x' });
    const valid: Buffer[] = [N.start()];
    const reply = E.onMessage('real', valid[0]);
    valid.push(...reply);
    for (const m of corpus(valid)) {
      const conn = 'c' + Math.floor(rnd() * 5);
      expect(() => E.onMessage(conn, m)).not.toThrow();
    }
    expect(E.failureCount).toBeLessThanOrEqual(3);
  });
  it('NewDevice.onMessage: random and mutated messages', () => {
    const E = new Existing(A, state(), { onAddPrompt: () => true });
    const inv = E.openInvite('code');
    const N0 = new NewDevice(generateIdentity(), { room: inv.room, secret: inv.secret }, 'code', { name: 'p', platform: 'x' });
    const m1 = N0.start();
    const m2 = E.onMessage('c', m1);
    for (const m of corpus(m2)) {
      const N = new NewDevice(generateIdentity(), { room: inv.room, secret: inv.secret }, 'code', { name: 'p', platform: 'x' });
      N.start();
      expect(() => N.onMessage(m)).not.toThrow();
      expect(N.result?.ok ?? false).toBe(false);
    }
  });
});

describe('cbor round trip property', () => {
  it('decode(encode(v)) re-encodes to identical bytes for random values', () => {
    function gen(depth: number): CborValue {
      const k = Math.floor(rnd() * (depth > 3 ? 4 : 6));
      if (k === 0) return Math.floor(rnd() * 2 ** Math.floor(rnd() * 52));
      if (k === 1) return randBytes(Math.floor(rnd() * 40));
      if (k === 2) return String.fromCharCode(...Array.from({ length: Math.floor(rnd() * 10) }, () => 32 + Math.floor(rnd() * 90)));
      if (k === 3) return [true, false, null][Math.floor(rnd() * 3)];
      if (k === 4) return Array.from({ length: Math.floor(rnd() * 4) }, () => gen(depth + 1));
      const o: Record<string, CborValue> = {};
      for (let i = 0; i < Math.floor(rnd() * 4); i++) o['k' + Math.floor(rnd() * 20)] = gen(depth + 1);
      return o;
    }
    for (let i = 0; i < 1000; i++) {
      const v = gen(0);
      const bytes = encode(v);
      expect(encode(decode(bytes)).equals(bytes)).toBe(true);
    }
  });
});
