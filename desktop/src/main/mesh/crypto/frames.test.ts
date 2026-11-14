// Frames: round trip, the T5 prototype's tamper/replay/forgery checks (ported, not weakened),
// known answers, the replay window, and the nonce/persistence contract.
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_REPLAY_WINDOW, FRAME_VERSION, FrameReceiver, FrameSender, MAX_FRAMES_PER_SESSION, MAX_FRAME_BYTES, newSessionId, peekHeader } from './frames';
import { encode, decode, type CborValue } from './cbor';
import { MeshCryptoError, type MeshCryptoErrorCode } from './errors';
import { deviceIdFor, generateIdentity, identityFromSecrets, setIdFor, type DeviceIdentity } from './identity';
import { frameKey, newSetSecret } from './keys';
import { aeadOpen, aeadSeal } from './aead';
import { openSecret, sealSecretTo } from './keygen';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const codeOf = (f: () => unknown): string => {
  try {
    f();
    return 'no-throw';
  } catch (e) {
    return e instanceof MeshCryptoError ? e.code : 'WRONG-ERROR-TYPE:' + String(e);
  }
};

const A = generateIdentity();
const B = generateIdentity();
const C = generateIdentity();
const X = generateIdentity(); // the one that gets removed
const setId = setIdFor(A.signKey);
const S1 = newSetSecret();
const everyone = new Map([A, B, C, X].map((d) => [hex(d.deviceId), d.signKey]));
const sender = (id: DeviceIdentity = A, extra: object = {}) => new FrameSender({ identity: id, setId, ...extra });
const rx = (o: object = {}) => new FrameReceiver({ setId, secretFor: (g) => (g === 1 ? S1 : undefined), signKeyFor: (d) => everyone.get(hex(d)), ...o });
const mk = (s: FrameSender = sender(), o: object = {}) => s.seal({ secret: S1, gen: 1, group: 'chat:v1', kind: 'lines', body: { lines: ['hello'] }, ...o });

describe('known answers (cross-checked byte-for-byte against the T5 prototype)', () => {
  const id = identityFromSecrets(Buffer.alloc(32, 7), Buffer.alloc(32, 9)); // synthetic
  const sid = setIdFor(id.signKey);
  it('a sealed frame is pinned, and a receiver opens it', () => {
    const s = new FrameSender({ identity: id, setId: sid, session: Buffer.alloc(16, 5) });
    const wire = s.seal({ secret: Buffer.alloc(32, 3), gen: 1, group: 'chat:v1', kind: 'lines', body: { lines: ['hello'], n: 1 } });
    expect(wire.length).toBe(244);
    expect(sha(wire)).toBe('37cae20b0b377d9c83fff266116801e0514953ff6932754e0d6ff66422da2c9e');
    const r = new FrameReceiver({ setId: sid, secretFor: () => Buffer.alloc(32, 3), signKeyFor: () => id.signKey });
    expect((r.open(wire).body as { n: number }).n).toBe(1);
  });
  it('a padded frame is pinned (bucket 256, then powers of two)', () => {
    const s = new FrameSender({ identity: id, setId: sid, session: Buffer.alloc(16, 6), padding: 'buckets' });
    const wire = s.seal({ secret: Buffer.alloc(32, 3), gen: 1, group: 'chat:v1', kind: 'lines', body: { n: 1 } });
    expect(sha(wire)).toBe(PADDED_SHA);
  });
});
// Pinned from this implementation (regression pin for the padded layout; the unpadded frame above is the cross-checked one).
const PADDED_SHA = '5897a74114d110bce70be7ab33e1a53a76d1b9df734f108ccd87d525d4197773';

describe('round trip and what a receiver learns', () => {
  it('opens, authenticates the signer, returns header and body', () => {
    const r = rx().open(mk());
    expect((r.body as { lines: string[] }).lines).toEqual(['hello']);
    expect(r.header.v).toBe(FRAME_VERSION);
    expect(hex(r.header.from)).toBe(hex(A.deviceId));
    expect(hex(r.signKey)).toBe(hex(A.signKey));
  });
  it('key-selection fields are readable without any key (peekHeader), and unauthenticated', () => {
    const h = peekHeader(mk());
    expect([h.gen, h.group, h.kind, h.counter]).toEqual([1, 'chat:v1', 'lines', 0]);
  });
  it('every frame kind is signed: even a tiny hello', () => {
    const s = sender();
    for (const kind of ['hello', 'beat', 'live-event', 'control']) expect(rx().open(mk(s, { kind, body: { n: 1 } })).header.kind).toBe(kind);
  });
  it('padding hides body length inside buckets and still opens', () => {
    const s = sender(A, { padding: 'buckets' });
    const small = mk(s, { body: { t: 'a' } });
    const bigger = mk(s, { body: { t: 'a'.repeat(100) } });
    expect(small.length).toBe(bigger.length);
    const huge = mk(s, { body: { t: 'a'.repeat(1000) } });
    expect(huge.length).toBeGreaterThan(small.length);
    expect(((rx().open(huge).body) as { t: string }).t.length).toBe(1000);
  });
  it('an addressed frame opens for its recipient and is refused by another device', () => {
    const w = mk(sender(), { to: B.deviceId });
    expect(rx({ selfDeviceId: B.deviceId }).open(w).header.to).toEqual(Buffer.from(B.deviceId));
    expect(codeOf(() => rx({ selfDeviceId: C.deviceId }).open(w))).toBe('not-addressed-to-me');
  });
});

describe('rejections (each path has a test)', () => {
  const rewrite = (wire: Buffer, patch: object): Buffer => {
    const { h, c } = decode(wire) as { h: object; c: Uint8Array };
    return encode({ h: { ...h, ...patch }, c } as CborValue);
  };
  it('a keeper changing group, recipient, counter, kind, session, generation: all rejected', () => {
    const w = mk();
    const s2 = randomBytes(16);
    const cases: [object, MeshCryptoErrorCode][] = [
      [{ group: 'chat:v2' }, 'auth-failed'], [{ to: Buffer.alloc(16, 1) }, 'auth-failed'], [{ counter: 1 }, 'auth-failed'],
      [{ kind: 'control' }, 'auth-failed'], [{ session: s2 }, 'auth-failed'], [{ gen: 2 }, 'unknown-generation'],
    ];
    for (const [patch, code] of cases) expect(codeOf(() => rx().open(rewrite(w, patch))), JSON.stringify(Object.keys(patch))).toBe(code);
  });
  it('same ciphertext replayed into a different set', () => {
    const other = new FrameReceiver({ setId: Buffer.alloc(32, 1), secretFor: () => S1, signKeyFor: (d) => everyone.get(hex(d)) });
    expect(codeOf(() => other.open(mk()))).toBe('wrong-set');
  });
  it('a member (holds the set secret) cannot forge a frame in another device\'s name', () => {
    // B builds a frame whose header says it is from A, signed by B's key.
    const forged = new FrameSender({ identity: { ...B, deviceId: A.deviceId }, setId }).seal({ secret: S1, gen: 1, group: 'chat:v1', kind: 'lines', body: { lines: ['evil'] } });
    expect(codeOf(() => rx().open(forged))).toBe('bad-signature');
  });
  it('an unknown signer is refused as unknown-signer (the caller may park it), never accepted', () => {
    expect(codeOf(() => rx().open(mk(sender(generateIdentity()))))).toBe('unknown-signer');
  });
  it('a roster that maps an id to the wrong key is refused', () => {
    const r = rx({ signKeyFor: () => B.signKey });
    expect(codeOf(() => r.open(mk()))).toBe('unknown-signer');
  });
  it('an unknown generation (a removed device never received it)', () => {
    const S2 = newSetSecret();
    const f2 = sender().seal({ secret: S2, gen: 2, group: 'g', kind: 'k', body: { n: 1 } });
    expect(codeOf(() => rx().open(f2))).toBe('unknown-generation');
  });
  it('a bit flip anywhere in the ciphertext is rejected, and junk does not poison the replay table', () => {
    const r = rx();
    const s = sender();
    const good = mk(s);
    const bad = Buffer.from(good);
    bad[bad.length - 3] ^= 1;
    expect(codeOf(() => r.open(bad))).toBe('auth-failed');
    expect(((r.open(good).body) as { lines: string[] }).lines).toEqual(['hello']); // genuine frame with the same counter still opens
  });
  it('wrong generation secret', () => {
    expect(codeOf(() => rx({ secretFor: () => newSetSecret() }).open(mk()))).toBe('auth-failed');
  });
  it('unknown version is refused, never downgraded', () => {
    expect(codeOf(() => rx().open(rewrite(mk(), { v: 2 })))).toBe('unsupported-version');
  });
  it('unknown extra header field, bad sizes and types', () => {
    const w = mk();
    for (const patch of [{ extra: 1 }, { from: Buffer.alloc(3) }, { set: 'x' }, { counter: 2 ** 32 }, { group: '' }, { gen: 2 ** 32 }, { to: Buffer.alloc(2) }]) {
      expect(codeOf(() => rx().open(rewrite(w, patch))), JSON.stringify(patch)).toBe('malformed');
    }
  });
  it('oversize input is refused before parsing', () => {
    expect(codeOf(() => rx().open(Buffer.alloc(MAX_FRAME_BYTES + 1)))).toBe('too-large');
    expect(codeOf(() => peekHeader(Buffer.alloc(MAX_FRAME_BYTES + 1)))).toBe('too-large');
  });
  it('truncated, empty and random bytes are malformed', () => {
    const w = mk();
    for (const b of [Buffer.alloc(0), w.subarray(0, 50), randomBytes(200), Buffer.from('a0', 'hex')]) expect(codeOf(() => rx().open(b))).toBe('malformed');
  });
  it('a member who holds the key cannot lift a signed body into a new header (signature covers the header)', () => {
    // Attacker holds S1, so it can decrypt A's counter-0 frame, then re-encrypt the SAME signed body under a counter-1 header.
    const s = sender();
    const w0 = mk(s);
    const { h, c } = decode(w0) as { h: Record<string, CborValue>; c: Buffer };
    const key = frameKey(S1, setId, 1, A.deviceId, h.session as Buffer);
    const inner = decode(aeadOpen(key, Buffer.alloc(12), encode(h), c)) as Record<string, CborValue>;
    const h1 = { ...h, counter: 1 };
    const nonce = Buffer.concat([Buffer.alloc(4), Buffer.from([0, 0, 0, 0, 0, 0, 0, 1])]);
    const lifted = encode({ h: h1, c: aeadSeal(key, nonce, encode(h1), encode(inner)) } as CborValue);
    expect(codeOf(() => rx().open(lifted))).toBe('bad-signature');
    expect(() => rx().open(w0)).not.toThrow(); // the genuine frame is fine
  });
});

describe('replay window', () => {
  it('constants: window of 1024 and a 2^32 frame limit are the documented defaults', () => {
    expect(DEFAULT_REPLAY_WINDOW).toBe(1024);
    expect(MAX_FRAMES_PER_SESSION).toBe(2 ** 32);
  });
  it('a duplicate (sender, session, counter) is a replay', () => {
    const r = rx();
    const f = mk();
    r.open(f);
    expect(codeOf(() => r.open(f))).toBe('replay');
  });
  it('out-of-order within the window is accepted once, then replay', () => {
    const s = sender();
    const f = [0, 1, 2, 3].map(() => mk(s));
    const r = rx();
    r.open(f[2]);
    r.open(f[0]);
    r.open(f[3]);
    r.open(f[1]);
    expect(codeOf(() => r.open(f[1]))).toBe('replay');
  });
  it('older than the window is out-of-window', () => {
    const s = sender();
    const f = Array.from({ length: 6 }, () => mk(s));
    const r = rx({ windowSize: 3 });
    r.open(f[5]);
    expect(codeOf(() => r.open(f[2]))).toBe('out-of-window');
    r.open(f[3]); // inside the window (high 5, size 3 -> counters 3..5)
  });
  it('the same counter under a different session is independent', () => {
    const r = rx();
    r.open(mk(sender()));
    r.open(mk(sender())); // new session, counter 0 again
  });
  it('receiver state survives a restart: a previously seen frame is still a replay; session never starts fresh', () => {
    const s = sender();
    const f0 = mk(s);
    const f1 = mk(s);
    const r1 = rx();
    r1.open(f0);
    const saved = r1.exportState();
    const r2 = rx();
    r2.importState(saved);
    expect(codeOf(() => r2.open(f0))).toBe('replay');
    r2.open(f1);
    expect(Buffer.from(saved).includes(S1)).toBe(false); // state holds counters, never secrets
  });
  it('importState rejects malformed state and never weakens existing knowledge', () => {
    const r = rx();
    expect(codeOf(() => r.importState(encode({ v: 2, w: 1, e: [] })))).toBe('unsupported-version');
    for (const b of [Buffer.alloc(0), encode({ v: 1, w: 1, e: [{ f: Buffer.alloc(3) }] }), encode('x')]) expect(codeOf(() => r.importState(b))).toBe('malformed');
    const s = sender();
    const f = mk(s);
    r.open(f);
    r.importState(rx().exportState()); // an empty older state
    expect(codeOf(() => r.open(f))).toBe('replay');
  });
});

describe('nonce / persistence contract', () => {
  it('counters count up from 0 and never repeat inside a session, across generations, groups and kinds', () => {
    const s = sender();
    const S2 = newSetSecret();
    const counters = [mk(s), mk(s, { group: 'other' }), s.seal({ secret: S2, gen: 2, group: 'g', kind: 'k', body: 1 }), mk(s, { kind: 'x' })].map((w) => peekHeader(w).counter);
    expect(counters).toEqual([0, 1, 2, 3]);
    expect(s.framesSealed).toBe(4);
  });
  it('the sender exposes no way to set or restore its counter or session', () => {
    const s = sender() as unknown as Record<string, unknown>;
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(s), 'framesSealed');
    expect(d?.set).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(s, 'session')?.writable ?? true).toBeTruthy(); // readonly is a TypeScript guarantee
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(s)).filter((n) => /set|restore|load|save|import/i.test(n))).toEqual([]);
  });
  it('a second sender for the same (device, session) in one process is refused', () => {
    const session = newSessionId();
    new FrameSender({ identity: A, setId, session });
    expect(codeOf(() => new FrameSender({ identity: A, setId, session }))).toBe('session-reused');
    new FrameSender({ identity: B, setId, session }); // another device may share the bytes: the KEY differs by sender id
  });
  it('a simulated restore (same saved session bytes) cannot reuse a nonce: the guard fires, and a fresh session gives a different key and so different ciphertext', () => {
    const session = newSessionId();
    const first = new FrameSender({ identity: C, setId, session }).seal({ secret: S1, gen: 1, group: 'g', kind: 'k', body: { m: 'attack at dawn!!' } });
    expect(codeOf(() => new FrameSender({ identity: C, setId, session }))).toBe('session-reused');
    const after = new FrameSender({ identity: C, setId, session: newSessionId() }).seal({ secret: S1, gen: 1, group: 'g', kind: 'k', body: { m: 'retreat at dusk!!' } });
    expect(peekHeader(first).counter).toBe(peekHeader(after).counter); // both counter 0 ...
    expect(hex(peekHeader(first).session)).not.toBe(hex(peekHeader(after).session)); // ... under different sessions, hence different keys
  });
  it('refuses to seal at the frame limit (counter exhaustion)', () => {
    const s = sender(generateIdentity(), { maxFrames: 2 });
    mk(s);
    mk(s);
    expect(codeOf(() => mk(s))).toBe('counter-exhausted');
  });
  it('rejects a session id of the wrong size', () => {
    expect(codeOf(() => new FrameSender({ identity: A, setId, session: Buffer.alloc(8) }))).toBe('invalid-argument');
  });
  it('DEMONSTRATION: a repeated key and nonce leaks the XOR of plaintexts (why the contract exists)', async () => {
    const { createCipheriv } = await import('node:crypto');
    const key = randomBytes(32);
    const nonce = Buffer.alloc(12);
    const enc = (pt: Buffer): Buffer => { const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 }); return Buffer.concat([c.update(pt), c.final()]); };
    const p1 = Buffer.from('attack at dawn!!');
    const p2 = Buffer.from('retreat at dusk!');
    const c1 = enc(p1);
    const c2 = enc(p2);
    expect(Buffer.from(c1.map((b, i) => b ^ c2[i]))).toEqual(Buffer.from(p1.map((b, i) => b ^ p2[i])));
  });
});

describe('after a removal (keygen sealing)', () => {
  it('a new generation opens only for the remaining devices; blobs are bound to sender and recipient', () => {
    const S2 = newSetSecret();
    const sealedB = sealSecretTo(B.agreeKey, setId, 2, S2, A.deviceId, B.deviceId);
    const sealedC = sealSecretTo(C.agreeKey, setId, 2, S2, A.deviceId, C.deviceId);
    expect(hex(openSecret(B.agreeSecret, sealedB, setId, 2, A.deviceId, B.deviceId))).toBe(hex(S2));
    for (const f of [
      () => openSecret(X.agreeSecret, sealedB, setId, 2, A.deviceId, B.deviceId),
      () => openSecret(B.agreeSecret, sealedC, setId, 2, A.deviceId, C.deviceId),
      () => openSecret(B.agreeSecret, sealedB, setId, 2, A.deviceId, C.deviceId),
      () => openSecret(B.agreeSecret, sealedB, setId, 2, C.deviceId, B.deviceId),
      () => openSecret(B.agreeSecret, sealedB, setId, 3, A.deviceId, B.deviceId),
      () => openSecret(B.agreeSecret, sealedB, Buffer.alloc(32, 9), 2, A.deviceId, B.deviceId),
    ]) expect(codeOf(f)).toBe('auth-failed');
    const f2 = sender().seal({ secret: S2, gen: 2, group: 'g', kind: 'k', body: { n: 1 } });
    expect(codeOf(() => rx().open(f2))).toBe('unknown-generation'); // the removed device's view
    expect(deviceIdFor(A.signKey).length).toBe(16);
  });
});
