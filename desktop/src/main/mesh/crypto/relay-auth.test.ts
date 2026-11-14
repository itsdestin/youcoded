// Relay challenge-response: valid, and every way it must fail.
import { describe, expect, it } from 'vitest';
import { answerRelayChallenge, CHALLENGE_LIFETIME_MS, RelayAuthVerifier } from './relay-auth';
import { generateIdentity, identityFromSecrets, setIdFor } from './identity';
import { MeshCryptoError } from './errors';
import { sha256 } from './bytes';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const A = generateIdentity();
const B = generateIdentity();
const room = setIdFor(A.signKey);
const rosters = new Map([[hex(room), new Map([[hex(A.deviceId), A.signKey], [hex(B.deviceId), B.signKey]])]]);
const lookup = (r: Buffer, d: Buffer): Uint8Array | undefined => rosters.get(hex(r))?.get(hex(d));
let clock = 1_000_000;
const verifier = (aud = 'relay.example') => new RelayAuthVerifier(aud, lookup, () => clock);

describe('known answer', () => {
  it('a response to a fixed challenge is pinned (synthetic key)', () => {
    const id = identityFromSecrets(Buffer.alloc(32, 7), Buffer.alloc(32, 9));
    const r = answerRelayChallenge(id, 'relay.example', setIdFor(id.signKey), { aud: 'relay.example', nonce: Buffer.alloc(32, 8) });
    expect(hex(r.sig)).toBe('1886766e49cfdcb56fa999e5792bb2999120e46d4eefc58c3a99dbd0b3e79965fa5c6c2f7b2c05914dcfac24b2b60932d72b3f1c8e6d06db72f069f78a2de301');
  });
});

describe('relay auth', () => {
  it('a member answers and is accepted once', () => {
    const v = verifier();
    const resp = answerRelayChallenge(A, 'relay.example', room, v.challenge());
    const ok = v.verify(resp);
    expect(ok.ok).toBe(true);
    expect(v.verify(resp)).toEqual({ ok: false, why: 'stale-or-unknown-nonce' }); // captured response replayed
  });
  it('a response moved to another room fails, and the nonce is spent even on failure', () => {
    const v = verifier();
    const r = answerRelayChallenge(A, 'relay.example', room, v.challenge());
    expect(v.verify({ ...r, room: sha256(Buffer.from('another room')) }).ok).toBe(false);
    expect(v.verify(r)).toEqual({ ok: false, why: 'stale-or-unknown-nonce' });
  });
  it('a device refuses a relay that names another host (challenge forwarded from elsewhere)', () => {
    const evil = verifier('evil.example');
    expect(() => answerRelayChallenge(A, 'relay.example', room, evil.challenge())).toThrowError(MeshCryptoError);
    try {
      answerRelayChallenge(A, 'relay.example', room, evil.challenge());
    } catch (e) {
      expect((e as MeshCryptoError).code).toBe('relay-mismatch');
    }
  });
  it('a signature made for one relay is useless at another', () => {
    const v1 = verifier('relay.example');
    const r = answerRelayChallenge(A, 'relay.example', room, v1.challenge());
    const v2 = verifier('relay2.example');
    (v2 as unknown as { pending: Map<string, number> }).pending = (v1 as unknown as { pending: Map<string, number> }).pending; // share the nonce, as a forwarding attacker would
    expect(v2.verify(r)).toEqual({ ok: false, why: 'bad-signature' });
  });
  it('a non-member is refused; a member of another room is refused', () => {
    const v = verifier();
    const N = generateIdentity();
    expect(v.verify(answerRelayChallenge(N, 'relay.example', room, v.challenge()))).toEqual({ ok: false, why: 'not-on-roster' });
    expect(v.verify(answerRelayChallenge(A, 'relay.example', sha256(Buffer.from('other')), v.challenge()))).toEqual({ ok: false, why: 'not-on-roster' });
  });
  it('a stale challenge (older than 30 s) is refused', () => {
    const v = verifier();
    const r = answerRelayChallenge(A, 'relay.example', room, v.challenge());
    clock += CHALLENGE_LIFETIME_MS + 1;
    expect(v.verify(r)).toEqual({ ok: false, why: 'stale-or-unknown-nonce' });
  });
  it('a forged signature and a signature by another member fail', () => {
    const v = verifier();
    const r = answerRelayChallenge(A, 'relay.example', room, v.challenge());
    const t = Buffer.from(r.sig);
    t[0] ^= 1;
    expect(v.verify({ ...r, sig: t })).toEqual({ ok: false, why: 'bad-signature' });
    const v2 = verifier();
    const rb = answerRelayChallenge(B, 'relay.example', room, v2.challenge());
    expect(v2.verify({ ...rb, dev: A.deviceId })).toEqual({ ok: false, why: 'bad-signature' }); // B's signature claimed as A
  });
  it('malformed responses are a verdict, never a throw', () => {
    const v = verifier();
    const ch = v.challenge();
    expect(v.verify({ room: Buffer.alloc(3), nonce: ch.nonce, dev: Buffer.alloc(16), sig: Buffer.alloc(64) })).toEqual({ ok: false, why: 'malformed' });
    expect(v.verify({} as never)).toEqual({ ok: false, why: 'malformed' });
    expect(v.verify(null as never)).toEqual({ ok: false, why: 'malformed' });
  });
  it('outstanding challenges are bounded', () => {
    const v = verifier();
    const first = v.challenge();
    for (let i = 0; i < 1100; i++) v.challenge();
    expect(v.verify(answerRelayChallenge(A, 'relay.example', room, first))).toEqual({ ok: false, why: 'stale-or-unknown-nonce' });
  });
});
