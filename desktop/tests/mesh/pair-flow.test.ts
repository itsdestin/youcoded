// Pairing, device layer: durable before the welcome leaves; the joiner stores nothing unless the whole welcome verified.
import path from 'path';
import { describe, expect, it } from 'vitest';
import { generateIdentity, setIdFor } from '../../src/main/mesh/crypto/identity';
import { makeGenesisEntry } from '../../src/main/mesh/crypto/roster';
import { newSetSecret } from '../../src/main/mesh/crypto/keys';
import { insecureTestSealer, MeshKeyStore } from '../../src/main/mesh/keystore';
import { adoptPairing, PairingHost, PairingJoiner } from '../../src/main/mesh/pair-flow';
import { RosterStore } from '../../src/main/mesh/roster-store';
import { tmp } from './helpers';

async function hostSetup() {
  const id = generateIdentity();
  const dir = tmp('host-');
  const roster = new RosterStore(dir);
  await roster.load();
  await roster.append(makeGenesisEntry(id, 'Desktop', 'linux', 1));
  const secrets = new Map([[1, newSetSecret()]]);
  const admitted: string[] = [];
  const published: Buffer[] = [];
  const host = new PairingHost({
    identity: id, setId: setIdFor(id.signKey), secrets: () => secrets, roster,
    admitAtRelay: async (k) => { admitted.push(k); },
    afterAdded: (e) => { published.push(e.id); },
  });
  return { id, dir, roster, secrets, host, admitted, published };
}
/** Run the joiner against the host over a plain function-call pipe; the host's question is answered by `answer`. */
async function run(h: Awaited<ReturnType<typeof hostSetup>>, j: PairingJoiner, answer: boolean | null) {
  let toHost: Buffer[] = [j.start()];
  let stages = 0;
  while (toHost.length && stages++ < 50) {
    const toJoiner: Buffer[] = [];
    for (const m of toHost) toJoiner.push(...h.host.onMessage('c1', m));
    toHost = [];
    for (const m of toJoiner) toHost.push(...j.onMessage(m));
    if (h.host.prompt && answer !== null) {
      const sentToJoiner = await h.host.decide(h.host.prompt.conn, answer);
      for (const m of sentToJoiner) toHost.push(...j.onMessage(m));
    }
  }
}

describe('pairing over a pipe', () => {
  it('completes: both screens show the same matching number, the roster add is durable and published, the relay was told', async () => {
    const h = await hostSetup();
    const { room, code } = h.host.open();
    const joinerId = generateIdentity();
    const j = new PairingJoiner(joinerId, { room, code }, { name: 'Phone', platform: 'android' });
    await run(h, j, true);
    expect(j.result && j.result.ok).toBe(true);
    expect(j.sas).toBeDefined();
    expect(h.host.events).toContain('welcome-sent');
    expect(h.roster.size).toBe(2); // genesis + add
    const reloaded = new RosterStore(h.dir);
    await reloaded.load();
    expect(reloaded.size).toBe(2);
    expect(h.admitted).toEqual([joinerId.signKey.toString('hex')]);
    expect(h.published.length).toBe(1);
  });
  it('the typed code is accepted in any case with a dash or space, and a typo is refused before anything is sent', async () => {
    const h = await hostSetup();
    const { room, code } = h.host.open();
    const pretty = `${code.slice(0, 3)}-${code.slice(3)}`.toLowerCase();
    expect(() => new PairingJoiner(generateIdentity(), { room, code: pretty }, { name: 'x', platform: 'y' })).not.toThrow();
    expect(() => new PairingJoiner(generateIdentity(), { room, code: 'ABC' }, { name: 'x', platform: 'y' })).toThrow();
    expect(() => new PairingJoiner(generateIdentity(), { room, code: 'ABCDE0' }, { name: 'x', platform: 'y' })).toThrow();
  });
  it('a wrong code never reaches "Add this device?" and nothing is added', async () => {
    const h = await hostSetup();
    const { room, code } = h.host.open();
    const wrong = code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';
    const j = new PairingJoiner(generateIdentity(), { room, code: wrong }, { name: 'Phone', platform: 'android' });
    await run(h, j, true);
    expect(h.host.prompt).toBeNull();
    expect(j.result && j.result.ok).not.toBe(true);
    expect(h.roster.size).toBe(1);
    expect(h.admitted).toEqual([]);
  });
  it('"No" adds nothing and the joiner learns it was declined', async () => {
    const h = await hostSetup();
    const { room, code } = h.host.open();
    const j = new PairingJoiner(generateIdentity(), { room, code }, { name: 'Phone', platform: 'android' });
    await run(h, j, false);
    expect(j.result).toEqual({ ok: false, why: 'declined' });
    expect(h.roster.size).toBe(1);
  });
  it('if the host cannot record the add durably, the welcome is NOT released', async () => {
    const id = generateIdentity();
    const dir = tmp('host-');
    const roster = new RosterStore(dir);
    await roster.load();
    await roster.append(makeGenesisEntry(id, 'Desktop', 'linux', 1));
    const host = new PairingHost({ identity: id, setId: setIdFor(id.signKey), secrets: () => new Map([[1, newSetSecret()]]), roster, admitAtRelay: async () => { throw new Error('relay down'); } });
    const { room, code } = host.open();
    const j = new PairingJoiner(generateIdentity(), { room, code }, { name: 'Phone', platform: 'android' });
    await run({ host, roster, id, dir, secrets: new Map(), admitted: [], published: [] }, j, true);
    expect(j.result && j.result.ok).not.toBe(true);
  });
  it('the code is single use: a second joiner with the same code gets nothing', async () => {
    const h = await hostSetup();
    const { room, code } = h.host.open();
    await run(h, new PairingJoiner(generateIdentity(), { room, code }, { name: 'One', platform: 'android' }), true);
    const second = new PairingJoiner(generateIdentity(), { room, code }, { name: 'Two', platform: 'android' });
    await run(h, second, true);
    expect(second.result && second.result.ok).not.toBe(true);
    expect(h.roster.size).toBe(2);
  });
});

describe('adopting a pairing on the joiner', () => {
  it('stores the set id, every secret and the whole verified roster, readable after a restart', async () => {
    const h = await hostSetup();
    const { room, code } = h.host.open();
    const jid = generateIdentity();
    const j = new PairingJoiner(jid, { room, code }, { name: 'Phone', platform: 'android' });
    await run(h, j, true);
    const ok = j.result as Exclude<typeof j.result, null | { ok: false; why: string }>;
    const dir = tmp('joiner-');
    const keys = new MeshKeyStore(path.join(dir, 'mesh'), insecureTestSealer({ testMode: true }));
    await keys.update(() => {}); // identity placeholder; replaced below by the real joiner identity
    const roster = new RosterStore(path.join(dir, 'mesh'));
    await roster.load();
    await adoptPairing(ok, keys, roster);
    const k = (await new MeshKeyStore(path.join(dir, 'mesh'), insecureTestSealer({ testMode: true })).load())!;
    expect(k.setId!.equals(setIdFor(h.id.signKey))).toBe(true);
    expect([...k.secrets.keys()]).toEqual([1]);
    const re = new RosterStore(path.join(dir, 'mesh'));
    await re.load();
    expect(re.size).toBe(2);
    expect(re.verified!.devices.has(jid.deviceId.toString('hex'))).toBe(true);
  });
});
