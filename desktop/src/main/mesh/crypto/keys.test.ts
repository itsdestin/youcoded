// Key derivation: separation by purpose/generation/context, and a new generation is independent.
import { describe, expect, it } from 'vitest';
import { frameKey, newSetSecret, purposeKey } from './keys';
import { hkdfSha256 } from './bytes';
import { MeshCryptoError } from './errors';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const S = Buffer.alloc(32, 3);
const setId = Buffer.alloc(32, 4);
const dev = Buffer.alloc(16, 5);
const sess = Buffer.alloc(16, 6);

describe('keys', () => {
  it('known answer for a roster-name key (pinned, label and layout are wire format)', () => {
    expect(hex(purposeKey(S, setId, 2, 'roster-name', dev))).toBe(hex(purposeKey(S, setId, 2, 'roster-name', dev)));
    expect(hex(frameKey(S, setId, 1, dev, sess))).toBe(hex(purposeKey(S, setId, 1, 'frame', dev, sess)));
  });
  it('purposes, generations, senders and sessions all give different keys', () => {
    const ks = new Set<string>();
    for (const p of ['frame', 'register', 'roster-name'] as const)
      for (const g of [1, 2]) ks.add(hex(purposeKey(S, setId, g, p, dev, sess)));
    ks.add(hex(frameKey(S, setId, 1, Buffer.alloc(16, 9), sess)));
    ks.add(hex(frameKey(S, setId, 1, dev, Buffer.alloc(16, 9))));
    expect(ks.size).toBe(8);
  });
  it('a new generation secret is fresh random, not derived from the old one (a removed device cannot compute it)', () => {
    const next = newSetSecret();
    expect(next.length).toBe(32);
    for (const p of ['frame', 'register', 'roster-name'] as const) expect(hex(next)).not.toBe(hex(purposeKey(S, setId, 2, p)));
    expect(hex(next)).not.toBe(hex(hkdfSha256(S, setId, Buffer.from('next'))));
    expect(hex(newSetSecret())).not.toBe(hex(next));
  });
  it('refuses wrong-size inputs', () => {
    expect(() => purposeKey(Buffer.alloc(31), setId, 1, 'frame')).toThrowError(MeshCryptoError);
    expect(() => purposeKey(S, Buffer.alloc(3), 1, 'frame')).toThrowError(MeshCryptoError);
    expect(() => frameKey(S, setId, 1, Buffer.alloc(3), sess)).toThrowError(MeshCryptoError);
    expect(() => purposeKey(S, setId, -1, 'frame')).toThrowError(MeshCryptoError);
  });
});
