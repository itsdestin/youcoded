// Device identity: known answers, serialise/parse, key-derived ids, signatures.
import { describe, expect, it } from 'vitest';
import { MeshCryptoError } from './errors';
import { DEVICE_ID_LENGTH, deviceIdFor, fingerprintFor, generateIdentity, identityFromSecrets, parseIdentity, serializeIdentity, setIdFor, signWith, verifySig } from './identity';
import { encode } from './cbor';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
// Obviously synthetic test vectors: seeds are 0x07.. and 0x09.. repeated. NOT real keys.
const ID = identityFromSecrets(Buffer.alloc(32, 7), Buffer.alloc(32, 9));

describe('identity known answers (cross-checked byte-for-byte against the T5 prototype)', () => {
  it('public keys, device id, set id, fingerprint', () => {
    expect(hex(ID.signKey)).toBe('ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c');
    expect(hex(ID.agreeKey)).toBe('57db4b359f23ae5e146e4e2512056704722506348c150c14753d0c933d04d421');
    expect(hex(ID.deviceId)).toBe('5e5491a16807306d4dbdc45cea7bc1a6');
    expect(hex(setIdFor(ID.signKey))).toBe('0b778f4ca1ae2fdebbe1a552ecfb61dfdc3eb1dfa42bf2735a8dfbe3e6ef01d8');
    expect(hex(fingerprintFor(ID.signKey, ID.agreeKey))).toBe('5d983c95d35b1a3cebf94ce658cd8916bf335c8494d9fe331892ef35fee3e1d5');
  });
  it('serialised form is pinned', () => {
    expect(hex(serializeIdentity(ID))).toBe(
      'a3617601647369676e5820' + '07'.repeat(32) + '65616772656558' + '20' + '09'.repeat(32));
  });
  it('the device id comes from the signing key alone (not a machine id)', () => {
    expect(hex(deviceIdFor(ID.signKey))).toBe(hex(ID.deviceId));
    expect(ID.deviceId.length).toBe(DEVICE_ID_LENGTH);
    expect(DEVICE_ID_LENGTH).toBe(16);
  });
});

describe('identity behaviour', () => {
  it('generated identities are distinct and parse back identically', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    expect(hex(a.deviceId)).not.toBe(hex(b.deviceId));
    const back = parseIdentity(serializeIdentity(a));
    expect(hex(back.signKey)).toBe(hex(a.signKey));
    expect(hex(back.agreeKey)).toBe(hex(a.agreeKey));
    expect(hex(back.deviceId)).toBe(hex(a.deviceId));
  });
  it('sign / verify, and a wrong key, message or signature fails', () => {
    const sig = signWith(ID, Buffer.from('m'));
    expect(verifySig(ID.signKey, Buffer.from('m'), sig)).toBe(true);
    expect(verifySig(ID.signKey, Buffer.from('n'), sig)).toBe(false);
    expect(verifySig(generateIdentity().signKey, Buffer.from('m'), sig)).toBe(false);
    const t = Buffer.from(sig);
    t[0] ^= 1;
    expect(verifySig(ID.signKey, Buffer.from('m'), t)).toBe(false);
    expect(verifySig(Buffer.alloc(5), Buffer.from('m'), sig)).toBe(false); // bad key length: false, never a throw
    expect(verifySig(ID.signKey, Buffer.from('m'), Buffer.alloc(3))).toBe(false);
  });
  it('parseIdentity rejects every malformed or foreign form with MeshCryptoError', () => {
    const bad: Uint8Array[] = [
      Buffer.alloc(0), Buffer.from('ff', 'hex'), encode({ v: 2, sign: Buffer.alloc(32), agree: Buffer.alloc(32) }),
      encode({ v: 1, sign: Buffer.alloc(31), agree: Buffer.alloc(32) }), encode({ v: 1, sign: Buffer.alloc(32) }),
      encode({ v: 1, sign: Buffer.alloc(32), agree: Buffer.alloc(32), extra: 1 }), encode([1, 2]), encode('text'),
    ];
    for (const b of bad) expect(() => parseIdentity(b)).toThrowError(MeshCryptoError);
  });
  it('identityFromSecrets refuses wrong-size secrets', () => {
    expect(() => identityFromSecrets(Buffer.alloc(31), Buffer.alloc(32))).toThrowError(MeshCryptoError);
  });
});
