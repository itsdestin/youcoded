// CPace against the draft's PUBLISHED vectors (draft-irtf-cfrg-cpace-21, Appendix B.1, X25519 + SHA-512).
// These are the T5 prototype's checks ported unchanged; the cpace-ts interop checks are not ported
// because cpace-ts is not (and must not become) a dependency of the app.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CPace, calculateGenerator, elligator2Noble, elligator2Reference, generatorString, lvCat, prependLen, scalarMultVfy, transcriptIR } from './cpace';
import { fromHex } from './bytes';

const hex = (b: Uint8Array | null): string | null => (b ? Buffer.from(b).toString('hex') : null);
const PRS = Buffer.from('Password');
const CI = fromHex('0b415f696e69746961746f720b425f726573706f6e646572');
const SID = fromHex('7e4b4791d6a8ef019b936c79fb7f2c57');
const ya = fromHex('21b4f4bd9e64ed355c3eb676a28ebedaf6d8f17bdc365995b319097153044080');
const yb = fromHex('848b0779ff415f0af4ea14df9dd1d3c29ac41d836c7808896c4eba19c51ac40a');
const GEN = 'd04bf6d41f6a289632a2e929fa29bebd51092512a7829fdde7d314b62f05a73f';

describe('CPace draft-21 Appendix B.1', () => {
  it('B.1.1 generator_string is 170 bytes with the expected prefix', () => {
    const gs = generatorString(PRS, CI, SID);
    expect(gs.length).toBe(170);
    expect(gs.subarray(0, 28).toString('hex')).toBe('0843506163653235350850617373776f72646d000000000000000000');
  });
  it('B.1.1 generator g via noble Elligator2', () => expect(hex(calculateGenerator(PRS, CI, SID))).toBe(GEN));
  it('B.1.1 generator g via the reference Elligator2 from draft A.5', () => expect(hex(calculateGenerator(PRS, CI, SID, elligator2Reference))).toBe(GEN));
  it('noble Elligator2 equals the reference on 2000 random inputs (guards a noble rename/behaviour change)', () => {
    for (let i = 0; i < 2000; i++) {
      const r = BigInt('0x' + randomBytes(32).toString('hex')) & ((1n << 255n) - 1n);
      expect(hex(elligator2Noble(r))).toBe(hex(elligator2Reference(r)));
    }
  });
  const A = new CPace({ prs: PRS, ci: CI, sid: SID, role: 'initiator', ad: Buffer.from('ADa'), scalar: ya });
  const B = new CPace({ prs: PRS, ci: CI, sid: SID, role: 'responder', ad: Buffer.from('ADb'), scalar: yb });
  it('B.1.2 Ya', () => expect(hex(A.Y)).toBe('1d13c89278cdadd826f6d8d7f887701430f8380ddc17611cdd6dc989ce0c9f32'));
  it('B.1.3 Yb', () => expect(hex(B.Y)).toBe('248cccf6d5cdc3646f0ad593f9e6cef4e69d4945f8372e623512ecea32185623'));
  it('B.1.4 K, both directions', () => {
    const k = '5b067effbdc0b2a0e1d907b21ebb25cfedb96a852179a847c37e43ee71322c6b';
    expect(hex(scalarMultVfy(ya, B.Y))).toBe(k);
    expect(hex(scalarMultVfy(yb, A.Y))).toBe(k);
  });
  it('B.1.5 transcript_ir', () =>
    expect(hex(transcriptIR(A.Y, Buffer.from('ADa'), B.Y, Buffer.from('ADb')))).toBe(
      '201d13c89278cdadd826f6d8d7f887701430f8380ddc17611cdd6dc989ce0c9f320341446120248cccf6d5cdc3646f0ad593f9e6cef4e69d4945f8372e623512ecea3218562303414462'));
  it('B.1.5 ISK on both parties', () => {
    const want = '6e19b875f7a561d6b3ca3dbb9ef42ac55de3e717881018204b8922b4d5e53bb2aa82c300bea7b65d2b671da71922ddf6472301b79bc270adfa8bf413285f2263';
    expect(hex(A.finish(B.message()))).toBe(want);
    expect(hex(B.finish(A.message()))).toBe(want);
  });
  it('A.1 prepend_len / lv_cat vectors', () => {
    expect(hex(prependLen(Buffer.alloc(0)))).toBe('00');
    expect(hex(prependLen(Buffer.from('1234')))).toBe('0431323334');
    expect(hex(prependLen(Buffer.from([...Array(128).keys()])).subarray(0, 3))).toBe('800100');
    expect(hex(lvCat(Buffer.from('1234'), Buffer.from('5'), Buffer.alloc(0), Buffer.from('678')))).toBe('043132333401350003363738');
  });
  it('B.1.10 low-order points: q0..qb exact, abort on u0-u5 and u7', () => {
    const s = fromHex('af46e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449aff');
    const u = ['0000000000000000000000000000000000000000000000000000000000000000', '0100000000000000000000000000000000000000000000000000000000000000',
      'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', 'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
      '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157', 'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'daffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'dbffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'd9ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      'cdeb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b880', '4c9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f11d7'];
    const q = [null, null, null, null, null, null, 'd8e2c776bbacd510d09fd9278b7edcd25fc5ae9adfba3b6e040e8d3b71b21806', null,
      'c85c655ebe8be44ba9c0ffde69f2fe10194458d137f09bbff725ce58803cdb38', 'db64dafa9b8fdd136914e61461935fe92aa372cb056314e1231bc4ec12417456',
      'e062dcd5376d58297be2618c7498f55baa07d7e03184e8aada20bca28888bf7a', '993c6ad11c4c29da9a56f7691fd0ff8d732e49de6250b6c2e80003ff4629a175'];
    u.forEach((h, i) => expect(hex(scalarMultVfy(s, fromHex(h))), 'u' + i.toString(16)).toBe(q[i]));
  });
});

describe('CPace behaviour', () => {
  it('a malicious low-order Y makes finish() abort (null)', () => {
    expect(new CPace({ prs: PRS, ci: CI, sid: SID, role: 'initiator' }).finish({ Y: Buffer.alloc(32), AD: Buffer.alloc(0) })).toBeNull();
  });
  it('a wrong-length Y aborts instead of throwing', () => {
    expect(new CPace({ prs: PRS, ci: CI, sid: SID, role: 'initiator' }).finish({ Y: Buffer.alloc(5), AD: Buffer.alloc(0) })).toBeNull();
  });
  it('a different password gives different session keys', () => {
    const a = new CPace({ prs: Buffer.from('1234'), ci: CI, sid: SID, role: 'initiator' });
    const b = new CPace({ prs: Buffer.from('1235'), ci: CI, sid: SID, role: 'responder' });
    expect(hex(a.finish(b.message()))).not.toBe(hex(b.finish(a.message())));
  });
  it('the same password gives the same key on both sides (random scalars)', () => {
    const a = new CPace({ prs: Buffer.from('K7QD4M'), ci: CI, sid: SID, role: 'initiator' });
    const b = new CPace({ prs: Buffer.from('K7QD4M'), ci: CI, sid: SID, role: 'responder' });
    expect(hex(a.finish(b.message()))).toBe(hex(b.finish(a.message())));
  });
});
