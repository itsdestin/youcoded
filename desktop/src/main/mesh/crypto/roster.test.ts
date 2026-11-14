// Signed entries and roster-log verification. Merge/decide rules are NOT tested here (another part owns them).
import { describe, expect, it } from 'vitest';
import { ROSTER_REMOVE_RESERVE, encodeEntry, entryToValue, makeAddEntry, makeGenesisEntry, makeRemoveEntry, makeRenameEntry, parseEntry, parseEntryValue, sanitizeDeviceName, sanitizePlatform, signEntry, verifyEntry, verifyRosterLog, rosterHeads, MAX_DEVICE_NAME, MAX_ENTRIES_PER_DEVICE, MAX_ROSTER_ENTRIES, MAX_SEEN, RosterVerifier, seenForNextEntry, type SignedEntry } from './roster';
import { decode, encode } from './cbor';
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
  it('refuses: empty, genesis that is not a self-add, signer not yet in the log, tampered entry, duplicate, outsider', () => {
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
    ];
    for (const [name, log, code] of cases) expect(codeOf(() => verifyRosterLog(log)), name).toBe(code);
  });
  it('a remove that names a device nobody introduced is accepted into the set but has no effect (void), in any arrival order', () => {
    const r = makeRemoveEntry(A, Buffer.alloc(16, 1), [g.id], 2);
    const v = verifyRosterLog([g, r]);
    expect(v.facts.get(hex(r.id))!.void).toBe(true);
    expect(v.removed.size).toBe(0);
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

describe('an add can never overwrite a device that is already in the log', () => {
  const A = generateIdentity();
  const B = generateIdentity();
  const C = generateIdentity();
  const g = makeGenesisEntry(A, 'Desktop', 'linux', 1);
  const addB = makeAddEntry(A, info(B), [g.id], 2);
  const addC = makeAddEntry(B, info(C), [addB.id], 3);
  it("member C re-adding A's signing key with C's agreement key has no effect (the reviewer's attack)", () => {
    const hijack = makeAddEntry(C, { name: 'Desktop', platform: 'linux', signKey: A.signKey, agreeKey: C.agreeKey }, [addC.id], 4);
    const v = verifyRosterLog([g, addB, addC, hijack]);
    expect(v.facts.get(hex(hijack.id))!.void).toBe(true);
    expect(hex(v.devices.get(hex(A.deviceId))!.agreeKey)).toBe(hex(A.agreeKey));
  });
  it('a device re-adding itself (even with new keys of its own choosing, same signing key) has no effect', () => {
    const self = makeAddEntry(B, { name: 'B', platform: 'p', signKey: B.signKey, agreeKey: generateIdentity().agreeKey }, [addC.id], 4);
    const v = verifyRosterLog([g, addB, addC, self]);
    expect(v.facts.get(hex(self.id))!.void).toBe(true);
    expect(hex(v.devices.get(hex(B.deviceId))!.agreeKey)).toBe(hex(B.agreeKey));
  });
  it('a removed device re-adding itself has no effect', () => {
    const rem = makeRemoveEntry(A, B.deviceId, [addC.id], 4);
    const readd = makeAddEntry(B, info(B), [addC.id], 5); // B has NOT seen its removal here: still refused, id already present
    const v = verifyRosterLog([g, addB, addC, rem, readd]);
    expect(v.facts.get(hex(readd.id))!.void).toBe(true);
    expect(v.removed.has(hex(B.deviceId))).toBe(true);
  });
  it('the agreement key of an existing device is unchanged by any accepted log', () => {
    const r = verifyRosterLog([g, addB, addC]);
    expect(hex(r.devices.get(hex(A.deviceId))!.agreeKey)).toBe(hex(A.agreeKey));
  });
});

describe('every entry names the roster state it was made against, and the verifier exposes what that proves', () => {
  const A = generateIdentity();
  const B = generateIdentity();
  const D = generateIdentity();
  const g = makeGenesisEntry(A, 'Desktop', 'linux', 1);
  const addB = makeAddEntry(A, info(B), [g.id], 2);
  const remB = makeRemoveEntry(A, B.deviceId, [addB.id], 3);
  it('a non-genesis entry with no reference to earlier state is refused; genesis must reference nothing', () => {
    expect(codeOf(() => verifyRosterLog([g, signEntry(A, { kind: 'rename', body: { name: 'x' }, seen: [], at: 2 })]))).toBe('bad-roster');
    expect(codeOf(() => verifyRosterLog([signEntry(A, { kind: 'add', body: { name: 'D', platform: 'l', signKey: A.signKey, agreeKey: A.agreeKey }, seen: [Buffer.alloc(32, 1)], at: 1 })]))).toBe('bad-roster');
  });
  it('a reference to an entry that is not in the log (or comes later) is refused; so are duplicate references', () => {
    expect(codeOf(() => verifyRosterLog([g, makeRenameEntry(A, 'x', [Buffer.alloc(32, 9)], 2)]))).toBe('bad-roster');
    expect(codeOf(() => verifyRosterLog([g, makeRenameEntry(A, 'x', [g.id, g.id], 2)]))).toBe('bad-roster');
    const later = makeRenameEntry(A, 'y', [g.id], 5);
    expect(codeOf(() => verifyRosterLog([g, makeRenameEntry(A, 'x', [later.id], 2), later]))).toBe('bad-roster');
  });
  it("an entry that does not cite its signer's introduction is void (no effect), however it arrives", () => {
    const early = makeRenameEntry(B, 'x', [g.id], 3); // B's first entry cites only the genesis, not the add that introduced B
    const v = verifyRosterLog([g, addB, early]);
    expect(v.facts.get(hex(early.id))!.void).toBe(true);
    expect(v.devices.get(hex(B.deviceId))!.name).not.toBe('x');
  });
  it('a removed device that has SEEN its removal cannot add, remove or rename: the entry is void', () => {
    for (const make of [
      () => makeAddEntry(B, info(D), [addB.id, remB.id], 4),
      () => makeRenameEntry(B, 'still here', [addB.id, remB.id], 4),
      () => makeRemoveEntry(B, A.deviceId, [addB.id, remB.id], 4),
    ]) {
      const e = make();
      const v = verifyRosterLog([g, addB, remB, e]);
      expect(v.facts.get(hex(e.id))!.void).toBe(true);
      expect(v.removed.has(hex(A.deviceId))).toBe(false);
      expect(v.devices.has(hex(D.deviceId))).toBe(false);
    }
  });
  it('an entry of a removed device that did NOT cite its removal is flagged and void; the entries it made before are kept', () => {
    const early = makeRenameEntry(B, 'early', [addB.id], 2);
    const late = makeRenameEntry(B, 'late', [early.id], 9); // never cites remB
    const remEarly = makeRemoveEntry(A, B.deviceId, [addB.id, early.id], 3); // saw `early`, not `late`
    const r = verifyRosterLog([g, addB, early, remEarly, late]);
    const f = (e: SignedEntry) => r.facts.get(hex(e.id))!;
    expect(f(early).signerRemovedEarlierInLog).toBe(false);
    expect(f(early).signerKnewOwnRemoval).toBe(false);
    expect(f(late).signerRemovedEarlierInLog).toBe(true);
    expect(f(late).signerKnewOwnRemoval).toBe(false);
    expect(f(late).void).toBe(true);
    expect(f(early).void).toBe(false);
    expect(r.happenedBefore(addB.id, remEarly.id)).toBe(true);
    expect(r.happenedBefore(remEarly.id, addB.id)).toBe(false);
    expect(r.happenedBefore(remEarly.id, late.id)).toBe(false); // late never saw the removal: concurrent as far as the signatures show
    expect(r.happenedBefore(early.id, late.id)).toBe(true);
    expect(r.happenedBefore(g.id, g.id)).toBe(false);
  });
  it('rosterHeads lists entries nobody cites yet, newest first', () => {
    expect(rosterHeads([g, addB, remB]).map(hex)).toEqual([hex(remB.id)]);
    const fork = makeRenameEntry(A, 'fork', [addB.id], 7);
    expect(rosterHeads([g, addB, remB, fork]).map(hex)).toEqual([hex(fork.id), hex(remB.id)]);
  });
  it('seen is capped (parse and sign) so a roster entry can never be too large to parse back', () => {
    expect(MAX_SEEN).toBeLessThanOrEqual(64);
    expect(codeOf(() => signEntry(A, { kind: 'x', body: 1, seen: Array.from({ length: MAX_SEEN + 1 }, (_, i) => Buffer.alloc(32, i)), at: 1 }))).toBe('invalid-argument');
    const v = entryToValue(signEntry(A, { kind: 'x', body: 1, seen: [], at: 1 })) as Record<string, unknown>;
    expect(codeOf(() => parseEntryValue({ ...v, seen: Array.from({ length: MAX_SEEN + 1 }, () => Buffer.alloc(32)) }))).toBe('malformed');
  });
});

describe('parsing nits', () => {
  it('an entry with no body key is refused (a second spelling of the same entry)', () => {
    const A = generateIdentity();
    const v = { ...(entryToValue(signEntry(A, { kind: 'x', body: 1, seen: [], at: 1 })) as Record<string, unknown>) };
    delete v.body;
    expect(codeOf(() => parseEntryValue(v))).toBe('malformed');
  });
});

describe('names and platforms are sanitised on every path', () => {
  const A = generateIdentity();
  const B = generateIdentity();
  const g = makeGenesisEntry(A, 'Desktop', 'linux', 1);
  const raw = (name: string, platform: string, signer = A, seen: Buffer[] = [g.id]) =>
    signEntry(signer, { kind: 'add', body: { name, platform, signKey: B.signKey, agreeKey: B.agreeKey }, seen, at: 2 });
  it('a verified roster never hands out a name with bidi or control characters, or a platform outside the allow-list', () => {
    const r = verifyRosterLog([g, raw('‮evil\u0007', 'and‮roid\n')]);
    const d = r.devices.get(hex(B.deviceId))!;
    expect(d.name).toBe('evil');
    expect(d.platform).toBe('android');
  });
  it('a rename arriving through a verified log is sanitised too', () => {
    const add = raw('B', 'p');
    const rename = signEntry(B, { kind: 'rename', body: { name: 'x‮y\u0000' }, seen: [add.id], at: 3 });
    expect(verifyRosterLog([g, add, rename]).devices.get(hex(B.deviceId))!.name).toBe('xy');
  });
  it('invisible-only names (soft hyphen, hangul filler, braille blank, line separator, tag characters) become "Unnamed device"', () => {
    for (const s of ['­', 'ㅤ', '⠀', '  ', '\u{E0041}\u{E0042}', ' ​ㅤ ', '͏']) expect(sanitizeDeviceName(s), JSON.stringify(s)).toBe('Unnamed device');
    expect(sanitizeDeviceName('Dest­in  phone')).toBe('Destin phone');
    expect(sanitizeDeviceName('line\nbreak')).toBe('linebreak');
  });
  it('a name that is only invisible in the roster of a verified log is replaced as well', () => {
    expect(verifyRosterLog([g, raw('ㅤ⠀', 'p')]).devices.get(hex(B.deviceId))!.name).toBe('Unnamed device');
  });
  it('sanitizePlatform keeps letters, digits and a little punctuation, caps at 32, never empty', () => {
    expect(sanitizePlatform('linux')).toBe('linux');
    expect(sanitizePlatform('Win32 (x64)')).toBe('Win32 (x64)');
    expect(sanitizePlatform('a‮b\u0007c')).toBe('abc');
    expect(sanitizePlatform('x'.repeat(100)).length).toBe(32);
    expect(sanitizePlatform('‮ㅤ')).toBe('unknown');
  });
});

describe('weak agreement keys are refused when parsed, with the module typed error', () => {
  const A = generateIdentity();
  const g = makeGenesisEntry(A, 'Desktop', 'linux', 1);
  it('an all-zero agreement key in an add is refused at verify time as low-order-point', () => {
    const B = generateIdentity();
    const bad = signEntry(A, { kind: 'add', body: { name: 'B', platform: 'p', signKey: B.signKey, agreeKey: Buffer.alloc(32) }, seen: [g.id], at: 2 });
    expect(codeOf(() => verifyRosterLog([g, bad]))).toBe('low-order-point');
  });
  it('other small-order points are refused too (a few of the known ones)', () => {
    const B = generateIdentity();
    const lows = ['0100000000000000000000000000000000000000000000000000000000000000', 'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800', '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157'];
    for (const h of lows) {
      const bad = signEntry(A, { kind: 'add', body: { name: 'B', platform: 'p', signKey: B.signKey, agreeKey: Buffer.from(h, 'hex') }, seen: [g.id], at: 2 });
      expect(codeOf(() => verifyRosterLog([g, bad])), h).toBe('low-order-point');
    }
  });
  it('a genesis whose own agreement key is weak is refused', () => {
    const bad = signEntry(A, { kind: 'add', body: { name: 'A', platform: 'p', signKey: A.signKey, agreeKey: Buffer.alloc(32) }, seen: [], at: 1 });
    expect(codeOf(() => verifyRosterLog([bad]))).toBe('low-order-point');
  });
});

describe('a 5,000-entry roster verifies and every entry parses back', () => {
  it('verifies, with exact ancestry facts', () => {
    // WHY ten devices (review finding 4): one device may sign at most MAX_ENTRIES_PER_DEVICE entries, so a long log has many signers.
    const devs = Array.from({ length: 10 }, () => generateIdentity());
    const A = devs[0];
    const entries: SignedEntry[] = [makeGenesisEntry(A, 'D', 'linux', 1)];
    for (let d = 1; d < 10; d++) entries.push(makeAddEntry(A, { name: 'd' + d, platform: 'linux', signKey: devs[d].signKey, agreeKey: devs[d].agreeKey }, seenForNextEntry(entries, A.deviceId), entries.length + 1));
    const lastOwn = new Map<number, SignedEntry>([[0, entries[0]]]);
    for (let d = 1; d < 10; d++) lastOwn.set(d, entries[d]); // each device's introducing add
    while (entries.length < 5000) {
      const k = entries.length % 10;
      // seen = the signer's own previous entry and the newest entry overall (no O(n) head search per entry: that made building the test slow)
      const e = makeRenameEntry(devs[k], 'n' + entries.length, [lastOwn.get(k)!.id, entries[entries.length - 1].id].filter((x, i, a) => a.findIndex((y) => y.equals(x)) === i), entries.length + 1);
      entries.push(e);
      lastOwn.set(k, e);
    }
    const r = verifyRosterLog(entries);
    expect(r.devices.size).toBe(10);
    expect(r.happenedBefore(entries[0].id, entries[4999].id)).toBe(true);
    expect(r.happenedBefore(entries[4999].id, entries[0].id)).toBe(false);
    expect(rosterHeads(entries).map(hex)).toEqual([hex(entries[4999].id)]);
    // every entry still parses back (the old 1024-id cap was the break)
    for (const e of [entries[0], entries[2500], entries[4999]]) expect(() => parseEntryValue(decode(encode(entryToValue(e))))).not.toThrow();
  }, 60_000);

  it('verification is incremental: appending entry n+1 costs about the same as entry 2 (finding 4: it was quadratic)', () => {
    const A = generateIdentity();
    const v = new RosterVerifier();
    const log: SignedEntry[] = [makeGenesisEntry(A, 'D', 'linux', 1)];
    v.add(log[0]);
    for (let i = 1; i < 400; i++) { log.push(makeRenameEntry(A, 'n' + i, [log[i - 1].id], i + 1)); v.add(log[i]); }
    const next = makeRenameEntry(A, 'late', [log[399].id], 500);
    const t0 = process.hrtime.bigint();
    v.add(next);
    const oneStep = Number(process.hrtime.bigint() - t0) / 1e6;
    const t1 = process.hrtime.bigint();
    verifyRosterLog([...log, makeRenameEntry(A, 'late2', [log[399].id], 501)]);
    const full = Number(process.hrtime.bigint() - t1) / 1e6;
    expect(oneStep * 20).toBeLessThan(full); // one more entry is a small fraction of re-verifying the whole log
  });

  it('a failed prepare changes nothing, and a prepare that is never committed changes nothing', () => {
    const A = generateIdentity();
    const g = makeGenesisEntry(A, 'D', 'linux', 1);
    const v = new RosterVerifier();
    v.add(g);
    const bad = makeRenameEntry(A, 'x', [Buffer.alloc(32, 7)], 2); // names an unknown entry
    expect(codeOf(() => v.add(bad))).toBe('bad-roster');
    const good = makeRenameEntry(A, 'y', [g.id], 2);
    v.prepare(good); // never committed (the disk write failed)
    expect(v.size).toBe(1);
    v.add(good);
    expect(v.size).toBe(2);
  });

  it('a device cannot sign more than MAX_ENTRIES_PER_DEVICE entries', () => {
    const A = generateIdentity();
    const v = new RosterVerifier();
    let prev = makeGenesisEntry(A, 'D', 'linux', 1);
    v.add(prev);
    for (let i = 1; i < MAX_ENTRIES_PER_DEVICE; i++) { prev = makeRenameEntry(A, 'n', [prev.id], i + 1); v.add(prev); }
    expect(v.countOf(hex(A.deviceId))).toBe(MAX_ENTRIES_PER_DEVICE);
    expect(codeOf(() => v.add(makeRenameEntry(A, 'one more', [prev.id], 9999)))).toBe('bad-roster');
  }, 60_000);

  it('near the 8192 cap adds and renames are refused but a removal is still accepted (no dead end that nobody can remove a flooder from)', () => {
    const devs = Array.from({ length: 16 }, () => generateIdentity());
    const v = new RosterVerifier();
    const entries: SignedEntry[] = [makeGenesisEntry(devs[0], 'g', 'linux', 1)];
    v.add(entries[0]);
    const lastOwn = new Map<number, SignedEntry>([[0, entries[0]]]);
    for (let d = 1; d < 16; d++) {
      const e = makeAddEntry(devs[0], { name: 'd' + d, platform: 'linux', signKey: devs[d].signKey, agreeKey: devs[d].agreeKey }, [lastOwn.get(0)!.id], entries.length + 1);
      v.add(e); entries.push(e); lastOwn.set(d, e); lastOwn.set(0, e);
    }
    const limit = MAX_ROSTER_ENTRIES - ROSTER_REMOVE_RESERVE;
    const hexOf = (d: { deviceId: Buffer }): string => d.deviceId.toString('hex');
    let rr = 0;
    while (v.size < limit) {
      let k = rr++ % 16;
      while (v.countOf(hexOf(devs[k])) >= MAX_ENTRIES_PER_DEVICE - 1) k = (k + 1) % 16; // device 0 already signed the adds
      const head = entries[entries.length - 1];
      const mine = lastOwn.get(k)!;
      const e = makeRenameEntry(devs[k], 'n', mine.id.equals(head.id) ? [head.id] : [mine.id, head.id], entries.length + 1);
      v.add(e); entries.push(e); lastOwn.set(k, e);
    }
    expect(v.headroom).toBe(ROSTER_REMOVE_RESERVE);
    const head = entries[entries.length - 1];
    const mine0 = lastOwn.get(0)!;
    const seen = mine0.id.equals(head.id) ? [head.id] : [mine0.id, head.id];
    expect(codeOf(() => v.add(makeRenameEntry(devs[0], 'one more', seen, 99999)))).toBe('bad-roster');
    expect(() => v.add(makeRemoveEntry(devs[0], devs[5].deviceId, seen, 99999))).not.toThrow(); // the reserve is for removals
  }, 60_000);
});

describe('roster state is a function of the SET of entries (convergence by construction)', () => {
  const A = generateIdentity(), B = generateIdentity(), C = generateIdentity(), G = generateIdentity();
  const g = makeGenesisEntry(A, 'A', 'linux', 1);
  const addB = makeAddEntry(A, info(B, 'B'), [g.id], 2);
  const addC = makeAddEntry(A, info(C, 'C'), [g.id, addB.id], 3);
  const rBA = makeRemoveEntry(B, A.deviceId, [addB.id, addC.id], 4); // B removes A
  const rAB = makeRemoveEntry(A, B.deviceId, [addB.id, addC.id], 4); // A removes B at the same moment (mutual)
  const ghost = makeAddEntry(C, info(G, 'ghost'), [addC.id], 5); // C admits a ghost while ...
  const rAC = makeRemoveEntry(A, C.deviceId, [addB.id, addC.id], 5); // ... A removes C without seeing it
  const rename = makeRenameEntry(B, 'B2', [addB.id], 5);
  const all = [g, addB, addC, rBA, rAB, ghost, rAC, rename];
  /** A random order in which every entry comes after the entries it cites. */
  function causalShuffle(seed: number): SignedEntry[] {
    let s = seed;
    const r = (): number => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const left = [...all];
    const done = new Set<string>();
    const out: SignedEntry[] = [];
    while (left.length) {
      const ready = left.filter((e) => e.seen.every((x) => done.has(hex(x))));
      const e = ready[Math.floor(r() * ready.length)];
      left.splice(left.indexOf(e), 1);
      done.add(hex(e.id));
      out.push(e);
    }
    return out;
  }
  const digest = (v: RosterVerifier): string => JSON.stringify({ act: v.active().map((d) => `${hex(d.deviceId)}:${d.name}`).sort(), rem: [...v.removed].sort(), voided: [...v.voided].sort() });
  it('any causal order, with repeats, gives the same state, for both mutual-removal rules', () => {
    for (const rule of ['both', 'first-admitted'] as const) {
      const ref = digest(verifyRosterLog(causalShuffle(1), rule));
      for (let seed = 2; seed < 40; seed++) {
        const v = new RosterVerifier(rule);
        for (const e of causalShuffle(seed)) v.add(e);
        expect(digest(v), `${rule} seed ${seed}`).toBe(ref);
      }
    }
  });
  it('mutual removal: both are out by default; with the other rule the earlier-admitted device stays', () => {
    const both = verifyRosterLog([g, addB, addC, rBA, rAB], 'both');
    expect(both.removed.has(hex(A.deviceId)) && both.removed.has(hex(B.deviceId))).toBe(true);
    const first = verifyRosterLog([g, addB, addC, rBA, rAB], 'first-admitted');
    expect(first.removed.has(hex(B.deviceId))).toBe(true);
    expect(first.removed.has(hex(A.deviceId))).toBe(false);
  });
  it('a ghost admitted by a member at the moment it is removed is not a member', () => {
    const v = verifyRosterLog([g, addB, addC, ghost, rAC]);
    expect(v.active().map((d) => d.name).sort()).toEqual(['A', 'B']);
    expect(v.facts.get(hex(ghost.id))!.void).toBe(true);
  });
});
