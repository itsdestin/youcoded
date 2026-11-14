// The code-dependent CPace generator is derived once per invite, never per incoming message (so the relay
// cannot make the existing device repeat the variable-time, code-dependent maths at will).
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ n: 0 }));
// The Elligator2 map runs exactly once per generator derivation, wherever that is called from.
vi.mock('@noble/curves/ed25519.js', async (orig) => {
  const real = await orig<typeof import('@noble/curves/ed25519.js')>();
  return {
    ...real,
    _map_to_curve_elligator2_curve25519: (...a: Parameters<typeof real._map_to_curve_elligator2_curve25519>) => {
      calls.n++;
      return real._map_to_curve_elligator2_curve25519(...a);
    },
  };
});

import { encode } from './cbor';
import { generateIdentity, setIdFor } from './identity';
import { Existing } from './pairing';
import { newSetSecret } from './keys';
import { makeGenesisEntry } from './roster';

describe('generator derivation on the existing device', () => {
  it('happens once when the invite opens, and not again for any number of incoming pake1 messages', () => {
    const id = generateIdentity();
    const E = new Existing(id, { setId: setIdFor(id.signKey), secrets: new Map([[1, newSetSecret() as Uint8Array]]), roster: [makeGenesisEntry(id, 'D', 'linux', 1)] }, { onAddPrompt: () => true });
    calls.n = 0;
    E.openInvite('code');
    expect(calls.n).toBe(1);
    for (let i = 0; i < 12; i++) E.onMessage('c' + i, encode({ t: 'pake1', Y: randomBytes(32) }));
    expect(calls.n).toBe(1);
    E.openInvite('qr'); // a new invite is a new code: derived again, once
    expect(calls.n).toBe(2);
  });
});
