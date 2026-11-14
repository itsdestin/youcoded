// Generation statements: identity is a function of the removed set and the minter, never of arrival order; forged ones are refused.
import { describe, expect, it } from 'vitest';
import { newSetSecret } from '../../src/main/mesh/crypto/keys';
import { encodeStatement, parseStatement, secretMatches, signStatement, verifyStatement } from '../../src/main/mesh/crypto/generation';
import { generateIdentity, setIdFor } from '../../src/main/mesh/crypto/identity';

const a = generateIdentity(), b = generateIdentity(), c = generateIdentity(), d = generateIdentity();
const setId = setIdFor(a.signKey);

describe('generation statements', () => {
  it('the same removed set and minter give the same label however the removed list is ordered; another minter or another set gives another', () => {
    const s = newSetSecret();
    const x = signStatement(b, { set: setId, removed: [c.deviceId, d.deviceId], members: [a.deviceId, b.deviceId], secret: s });
    const y = signStatement(b, { set: setId, removed: [d.deviceId, c.deviceId], members: [b.deviceId, a.deviceId], secret: newSetSecret() });
    expect(x.label).toBe(y.label);
    expect(signStatement(a, { set: setId, removed: [c.deviceId, d.deviceId], members: [a.deviceId, b.deviceId], secret: s }).label).not.toBe(x.label);
    expect(signStatement(b, { set: setId, removed: [c.deviceId], members: [a.deviceId, b.deviceId], secret: s }).label).not.toBe(x.label);
  });
  it('round-trips, checks the signature and the commitment, and refuses a tampered or forged statement', () => {
    const s = newSetSecret();
    const st = signStatement(b, { set: setId, removed: [c.deviceId], members: [a.deviceId, b.deviceId], secret: s });
    const back = parseStatement(encodeStatement(st));
    expect(verifyStatement(back, b.signKey, setId, a.signKey)).toBe(true);
    expect(secretMatches(back, s)).toBe(true);
    expect(secretMatches(back, newSetSecret())).toBe(false);
    expect(verifyStatement({ ...back, commit: Buffer.alloc(32, 1) }, b.signKey, setId, a.signKey)).toBe(false); // signature covers the commitment
    expect(verifyStatement({ ...back, removed: [] }, b.signKey, setId, a.signKey)).toBe(false); // label no longer matches
    expect(verifyStatement(back, c.signKey, setId, a.signKey)).toBe(false); // not the minter's key
    expect(verifyStatement(back, b.signKey, Buffer.alloc(32, 2), a.signKey)).toBe(false); // another set
  });
  it('generation 1 (no removals) can only be made by the set\'s creator', () => {
    const s = newSetSecret();
    const mine = signStatement(a, { set: setId, removed: [], members: [a.deviceId], secret: s });
    expect(mine.label).toBe(1);
    expect(verifyStatement(mine, a.signKey, setId, a.signKey)).toBe(true);
    const forged = signStatement(b, { set: setId, removed: [], members: [b.deviceId], secret: s });
    expect(verifyStatement(forged, b.signKey, setId, a.signKey)).toBe(false);
  });
  it('a statement that names its minter as removed, or that lists nobody, is refused', () => {
    const s = newSetSecret();
    expect(verifyStatement(signStatement(b, { set: setId, removed: [b.deviceId], members: [b.deviceId], secret: s }), b.signKey, setId, a.signKey)).toBe(false);
    expect(verifyStatement(signStatement(b, { set: setId, removed: [c.deviceId], members: [a.deviceId], secret: s }), b.signKey, setId, a.signKey)).toBe(false); // minter not among members
  });
});
