// Third review, finding 9: the waiting-frame allowance is charged to the device the RELAY says wrote the frame, never to the sender a frame claims.
import { describe, expect, it } from 'vitest';
import { decode, encode } from '../../src/main/mesh/crypto/cbor';
import { FrameSender } from '../../src/main/mesh/crypto/frames';
import { generateIdentity, setIdFor, type DeviceIdentity } from '../../src/main/mesh/crypto/identity';
import { newSetSecret } from '../../src/main/mesh/crypto/keys';
import { makeAddEntry, makeGenesisEntry, seenForNextEntry } from '../../src/main/mesh/crypto/roster';
import { MemoryHub } from '../../src/main/mesh/carrier-memory';
import { Link } from '../../src/main/mesh/link';
import { RosterStore } from '../../src/main/mesh/roster-store';
import { noteBody } from '../../src/main/mesh/wire';
import { tmp } from './helpers';

describe('waiting frames are charged to the relay-stamped writer', () => {
  it('junk frames that CLAIM to be from a victim (and are written by an attacker) cannot push the victim\'s genuine waiting frame out', async () => {
    const [A, V, M] = [generateIdentity(), generateIdentity(), generateIdentity()];
    const setId = setIdFor(A.signKey);
    const g = makeGenesisEntry(A, 'A', 'linux', 1);
    const log = [g];
    for (const d of [V, M]) log.push(makeAddEntry(A, { name: 'd', platform: 'linux', signKey: d.signKey, agreeKey: d.agreeKey }, seenForNextEntry(log, A.deviceId), 2));
    const roster = new RosterStore(tmp('r3l-'));
    await roster.load();
    for (const e of log) await roster.append(e);
    const hub = new MemoryHub();
    const known = newSetSecret();
    const unheld = newSetSecret();
    const carrierA = hub.carrier('A'), carrierV = hub.carrier('V'), carrierM = hub.carrier('M');
    const link = new Link({
      identity: A, setId, carrier: carrierA, meshDir: tmp('r3l-A-'), secrets: () => new Map([[1, known]]),
      signKeyFor: (d) => roster.signKeyFor(d), isRemoved: (d) => roster.isRemoved(d),
      counter: { get: () => 0, set: async () => undefined }, onFrame: () => undefined,
    });
    await link.start(['g']);
    // the victim's genuine frame, sealed under a secret A does not hold yet: it waits
    const vs = new FrameSender({ identity: V, setId });
    await carrierV.hold('g', vs.session.toString('hex'), 1, vs.seal({ secret: unheld, gen: 5, group: 'g', kind: 'note', body: noteBody('real') }));
    // the attacker's junk: its own sealed frames with the header rewritten to name the victim
    const ms = new FrameSender({ identity: M, setId });
    for (let i = 0; i < 40; i++) {
      const wire = ms.seal({ secret: unheld, gen: 5, group: 'g', kind: 'note', body: noteBody('junk' + i) });
      const outer = decode(wire) as { h: Record<string, unknown>; c: unknown };
      await carrierM.hold('g', ms.session.toString('hex'), i + 1, Buffer.from(encode({ ...outer, h: { ...outer.h, from: V.deviceId } } as never)));
    }
    await link.sync('g');
    const kinds = link.rejections().counts;
    // the genuine frame is still waiting (the attacker's own allowance overflowed, not the victim's)
    expect(link.waitingCount).toBeGreaterThanOrEqual(1);
    expect(kinds['wait-overflow'] ?? 0).toBeGreaterThan(0);
    // ... and the one that was evicted each time was an attacker frame: the victim's frame (seq 1) is still held
    const recent = link.rejections().recent.filter((r) => r.reason === 'wait-overflow');
    expect(recent.every((r) => r.seq !== 1)).toBe(true);
  });
});
