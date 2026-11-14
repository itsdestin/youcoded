// HPKE base mode: RFC 9180 Appendix A.2 (DHKEM X25519 / HKDF-SHA256 / ChaCha20-Poly1305) plus tamper checks.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hpkeOpen, hpkeOpenSealed, hpkeSeal, hpkeSealWithEphemeral } from './hpke';
import { x25519PublicFromSecret } from './curves';
import { MeshCryptoError } from './errors';
import { fromHex } from './bytes';

describe('HPKE', () => {
  it('RFC 9180 A.2.1: encapsulated key and ciphertext match byte for byte', () => {
    const info = fromHex('4f6465206f6e2061204772656369616e2055726e');
    const skEm = fromHex('f4ec9b33b792c372c1d2c2063507b684ef925b8c75a42dbcbf57d63ccd381600');
    const pkRm = fromHex('4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a');
    const skRm = fromHex('8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb');
    const pt = fromHex('4265617574792069732074727574682c20747275746820626561757479');
    const aad = fromHex('436f756e742d30');
    const { enc, ct } = hpkeSealWithEphemeral(pkRm, info, aad, pt, skEm);
    expect(enc.toString('hex')).toBe('1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a');
    expect(ct.toString('hex')).toBe('1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db21993c62ce81883d2dd1b51a28');
    expect(hpkeOpen(skRm, enc, info, aad, ct).toString('hex')).toBe(pt.toString('hex'));
  });
  it('round trip; tampering, wrong aad, wrong info and wrong key are all auth-failed', () => {
    const sk = randomBytes(32);
    const pk = x25519PublicFromSecret(sk);
    const sealed = hpkeSeal(pk, Buffer.from('info'), Buffer.from('aad'), Buffer.from('secret'));
    expect(hpkeOpenSealed(sk, sealed, Buffer.from('info'), Buffer.from('aad')).toString()).toBe('secret');
    const t = Buffer.from(sealed);
    t[40] ^= 1;
    const codes = [
      () => hpkeOpenSealed(sk, t, Buffer.from('info'), Buffer.from('aad')),
      () => hpkeOpenSealed(sk, sealed, Buffer.from('info'), Buffer.from('other')),
      () => hpkeOpenSealed(sk, sealed, Buffer.from('other'), Buffer.from('aad')),
      () => hpkeOpenSealed(randomBytes(32), sealed, Buffer.from('info'), Buffer.from('aad')),
    ].map((f) => { try { f(); return 'no-throw'; } catch (e) { return (e as MeshCryptoError).code; } });
    expect(codes).toEqual(['auth-failed', 'auth-failed', 'auth-failed', 'auth-failed']);
  });
  it('short or low-order input is a typed error', () => {
    const sk = randomBytes(32);
    for (const sealed of [Buffer.alloc(0), Buffer.alloc(40), Buffer.alloc(48, 0)]) {
      expect(() => hpkeOpenSealed(sk, sealed, Buffer.alloc(0), Buffer.alloc(0))).toThrowError(MeshCryptoError);
    }
  });
});
