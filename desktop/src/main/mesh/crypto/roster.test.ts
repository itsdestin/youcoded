// Signed entries and roster-log verification. Merge/decide rules are NOT tested here (another part owns them).
import { describe, expect, it } from 'vitest';
import { encodeEntry, entryToValue, makeAddEntry, makeGenesisEntry, makeRemoveEntry, makeRenameEntry, parseEntry, parseEntryValue, sanitizeDeviceName, signEntry, verifyEntry, verifyRosterLog, MAX_DEVICE_NAME, MAX_ROSTER_ENTRIES, type SignedEntry } from './roster';
import { generateIdentity, identityFromSecrets, setIdFor } from './identity';
import { MeshCryptoError } from './errors';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const codeOf = (f: () => unknown): string => {
  try {
    f();
    return 'no-throw';
  } catch (e) {
    return e instanceof MeshCryptoError ? e.code : 'WRONG-ERROR-TYPE';
  }
};
const info = (d: ReturnType<typeof generateIdentity>, name = 'Phone', platform = 'android') => ({ name, platform, signKey: d.signKey, agreeKey: d.agreeKey });

describe('known answers (synthetic keys; entry ids cross-checked against the T5 prototype)', () => {
  const a = identityFromSecrets(Buffer.alloc(32, 7), Buffer.alloc(32, 9));
  const b = identityFromSecrets(Buffer.alloc(32, 11), Buffer.alloc(32, 12));
  const g = makeGenesisEntry(a, 'Desktop', 'linux', 1);
  const add = makeAddEntry(a, info(b), [g.id], 2);
  const rem = makeRemoveEntry(a, b.deviceId, [add.id], 3);
  it('genesis, add, remove ids and signatures are pinned (Ed25519 is deterministic)', () => {
    expect(hex(g.id)).toBe('d1b298a3fef84fce93d6e0b0aef780be3cfc95299d0a23f577e745d6d3bfed91');
    expect(hex(g.signature)).toBe('1781fcc2acfff9c369b93989474a85d946c6ddbedc893faf3ab158e4715814962cf8bef54c04925d2ff02209473163aed959787a14e130e889040b1fd5919f01');
    expect(hex(add.id)).toBe('7f9bff12791b11d332ec3f2beb11dfb5dfd6b605867cce43320ac34ce7ccdd57');
    expect(hex(add.signature)).toBe('907c2c169efaaf0c7b3da1cfe0b7ae254d44e990591beaa4d72d7087c88361e3564e02dfb0694792a56b3016a3bfdcdb5125c98dd62ae34292d1f947baa85b08');
    expect(hex(rem.id)).toBe('f7457183f6e59c3bff3ddefbadc0e1815a06bb4814a3734bf48e1b48c5faaab4');
  });
  it('the whole log verifies and yields both devices', () => {
    const r = verifyRosterLog([g, add, rem]);
    expect(hex(r.setId)).toBe(hex(setIdFor(a.signKey)));
    expect([...r.devices.keys()].sort()).toEqual([hex(a.deviceId), hex(b.deviceId)].sort());
  });
});

describe('entries', () => {
  const A = generateIdentity();
  const B = generateIdentity();
  const base = { kind: 'note', body: { x: 1 }, seen: [] as Buffer[], at: 5 };
  it('id covers every field, signature covers the id; any edit invalidates', () => {
    const e = signEntry(A, base);
    expect(verifyEntry(e, A.signKey)).toBe(true);
    const edits: Partial<SignedEntry>[] = [{ at: 6 }, { kind: 'other' }, { body: { x: 2 } }, { seen: [Buffer.alloc(32)] }, { chat: 'c' }, { device: B.deviceId }];
    for (const edit of edits) expect(verifyEntry({ ...e, ...edit }, A.signKey), JSON.stringify(Object.keys(edit))).toBe(false);
    expect(verifyEntry(e, B.signKey)).toBe(false);
    const t = Buffer.from(e.signature);
    t[3] ^= 1;
    expect(verifyEntry({ ...e, signature: t }, A.signKey)).toBe(false);
    expect(verifyEntry(e, Buffer.alloc(3))).toBe(false);
  });
  it('the same content gives the same id on any device', () => {
    expect(hex(signEntry(A, base).id)).toBe(hex(signEntry(A, base).id));
    expect(hex(signEntry(A, base).id)).not.toBe(hex(signEntry(B, base).id)); // signer is part of the content
  });
  it('encode / parse round trip', () => {
    const e = signEntry(A, { ...base, chat: 'chat:v1' });
    const back = parseEntry(encodeEntry(e));
    expect(verifyEntry(back, A.signKey)).toBe(true);
    expect(hex(encodeEntry(back))).toBe(hex(encodeEntry(e)));
  });
  it('parse rejects wrong shapes with MeshCryptoError', () => {
    const v = entryToValue(signEntry(A, base)) as Record<string, unknown>;
    const bad = [{ ...v, id: Buffer.alloc(3) }, { ...v, extra: 1 }, { ...v, at: -1 }, { ...v, seen: 'x' }, { ...v, signature: Buffer.alloc(63) }, { ...v, kind: 7 }, 'x', null];
    for (const b of bad) expect(codeOf(() => parseEntryValue(b))).toBe('malformed');
    expect(codeOf(() => parseEntry(Buffer.from('ff', 'hex')))).toBe('malformed');
  });
});

describe('roster log verification', () => {
  const A = generateIdentity();
  const B = generateIdentity();
  const C = generateIdentity();
  const g = makeGenesisEntry(A, 'Desktop', 'linux', 1);
  const addB = makeAddEntry(A, info(B), [g.id], 2);
  const addC = makeAddEntry(B, info(C, 'Tablet', 'android'), [addB.id], 3); // a non-genesis device may add
  it('accepts add by any device already in the log, rename, and opaque kinds', () => {
    const rename = makeRenameEntry(C, 'New name', [addC.id], 4);
    const witness = signEntry(B, { kind: 'witness', body: { held: {} }, seen: [addC.id], at: 5 });
    const r = verifyRosterLog([g, addB, addC, rename, witness]);
    expect(r.devices.size).toBe(3);
    expect(r.devices.get(hex(C.deviceId))?.name).toBe('New name');
  });
  it('a removed device stays in the key map (frames it signed earlier must still verify; the decide layer rules on later entries)', () => {
    expect(verifyRosterLog([g, addB, makeRemoveEntry(A, B.deviceId, [addB.id], 3)]).devices.has(hex(B.deviceId))).toBe(true);
  });
  it('refuses: empty, genesis that is not a self-add, signer not yet in the log, tampered entry, duplicate, remove of an unknown device, outsider', () => {
    const X = generateIdentity();
    const forgedGenesis = makeAddEntry(A, info(B), [], 1); // signed by A but names B
    const outsider = makeAddEntry(X, info(generateIdentity()), [g.id], 9);
    const tampered = { ...addB, at: 99 };
    const cases: [string, SignedEntry[], string][] = [
      ['empty', [], 'bad-roster'],
      ['genesis not self', [forgedGenesis], 'bad-roster'],
      ['genesis not an add', [makeRenameEntry(A, 'x', [], 1)], 'bad-roster'],
      ['signer before add', [g, addC, addB], 'bad-roster'],
      ['outsider', [g, outsider], 'bad-roster'],
      ['tampered', [g, tampered], 'bad-entry'],
      ['duplicate', [g, addB, addB], 'bad-roster'],
      ['remove unknown', [g, makeRemoveEntry(A, Buffer.alloc(16, 1), [g.id], 2)], 'bad-roster'],
    ];
    for (const [name, log, code] of cases) expect(codeOf(() => verifyRosterLog(log)), name).toBe(code);
  });
  it('an add body with extra fields or short keys is rejected', () => {
    const badBody = signEntry(A, { kind: 'add', body: { name: 'x', platform: 'p', signKey: Buffer.alloc(31), agreeKey: Buffer.alloc(32) }, seen: [g.id], at: 2 });
    expect(codeOf(() => verifyRosterLog([g, badBody]))).toBe('malformed');
    const extra = signEntry(A, { kind: 'add', body: { name: 'x', platform: 'p', signKey: B.signKey, agreeKey: B.agreeKey, admin: true }, seen: [g.id], at: 2 });
    expect(codeOf(() => verifyRosterLog([g, extra]))).toBe('malformed');
  });
});

describe('roster size cap', () => {
  it('a log longer than the cap is refused before any work', () => {
    const A = generateIdentity();
    const g = makeGenesisEntry(A, 'D', 'linux', 1);
    expect(codeOf(() => verifyRosterLog(Array.from({ length: MAX_ROSTER_ENTRIES + 1 }, () => g)))).toBe('bad-roster');
  });
});

describe('device names shown to people', () => {
  it('strips control and bidi characters, caps at 40, never empty', () => {
    expect(sanitizeDeviceName('Lap‮top\u0007')).toBe('Laptop');
    expect(sanitizeDeviceName('a​b﻿c⁦d⁩')).toBe('abcd');
    expect(sanitizeDeviceName('x'.repeat(200)).length).toBe(MAX_DEVICE_NAME);
    expect(Array.from(sanitizeDeviceName('\u{1F600}'.repeat(60))).length).toBe(MAX_DEVICE_NAME);
    expect(sanitizeDeviceName('‮\u0000  ')).toBe('Unnamed device');
    expect(sanitizeDeviceName('  Destin phone ')).toBe('Destin phone');
  });
  it('builders sanitise before signing', () => {
    const A = generateIdentity();
    const g = makeGenesisEntry(A, 'Evil‮', 'linux', 1);
    expect((g.body as { name: string }).name).toBe('Evil');
  });
});
