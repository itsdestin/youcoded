// Second-round review (2026-11-14) of the device layer: one failing-first test per finding that the old code could be made to
// show, written BEFORE the fixes (the review's numbering: N1..N12). The convergence fuzz (tests/mesh/convergence-fuzz.test.ts)
// covers the same classes over thousands of random schedules; these are the named, readable reproductions.
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { insecureTestSealer, MeshKeyStore } from '../../src/main/mesh/keystore';
import { MeshService, type MeshServiceOptions } from '../../src/main/mesh/service';
import { RelayClient } from '../../src/main/mesh/relay-client';
import { FrameSender } from '../../src/main/mesh/crypto/frames';
import { generateIdentity, setIdFor, type DeviceIdentity } from '../../src/main/mesh/crypto/identity';
import { makeAddEntry, makeGenesisEntry, makeRemoveEntry, makeRenameEntry, seenForNextEntry, type SignedEntry } from '../../src/main/mesh/crypto/roster';
import { newSetSecret } from '../../src/main/mesh/crypto/keys';
import { MemoryCarrier, MemoryHub } from '../../src/main/mesh/carrier-memory';
import { Link } from '../../src/main/mesh/link';
import { RosterStore } from '../../src/main/mesh/roster-store';
import { GROUP_ROSTER, KIND_ROSTER, noteBody, parseNoteBody, rosterBody } from '../../src/main/mesh/wire';
import { FakeRelay } from './fake-relay';
import { tmp } from './helpers';

const live: Array<{ stop(): Promise<void> }> = [];
let relay: FakeRelay;
afterEach(async () => {
  while (live.length) await live.pop()!.stop();
  await relay?.close();
});
const dirs = new Map<MeshService, string>();
const mk = async (name: string, extra: Partial<MeshServiceOptions> = {}, dir = tmp(`r2-${name}-`)): Promise<MeshService> => {
  const s = new MeshService({ userData: dir, sealer: insecureTestSealer({ testMode: true }), testMode: true, relayUrl: relay.url, deviceName: name, platform: 'linux', log: () => undefined, relayBaseDelayMs: 20, genTakeoverMs: 150, headsEveryMs: 1000, ...extra });
  await s.start();
  live.push(s);
  dirs.set(s, dir);
  return s;
};
const until = async (cond: () => boolean | Promise<boolean>, what: string, ms = 15_000): Promise<void> => {
  const t0 = Date.now();
  while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 15)); }
};
async function pair(host: MeshService, joiner: MeshService): Promise<void> {
  const { room, code } = host.openPairing();
  let toHost: Buffer[] = [joiner.joinStart({ room: Buffer.from(room, 'hex'), code })];
  let decided = false;
  for (let i = 0; i < 20 && toHost.length; i++) {
    const toJoiner = toHost.flatMap((m) => host.hostPairingMessage('c', m));
    toHost = [];
    for (const m of toJoiner) { const r = await joiner.joinMessage(m); toHost.push(...r.out); }
    const p = host.pairingPrompt();
    if (p && !decided) {
      decided = true;
      for (const m of await host.hostPairingDecide(p.conn, true)) { const r = await joiner.joinMessage(m); toHost.push(...r.out); }
    }
  }
}
async function group(n: number, extra: Partial<MeshServiceOptions> = {}): Promise<MeshService[]> {
  relay = await new FakeRelay().ready();
  const A = await mk('A', extra);
  await A.createSet();
  await until(() => A.status().relay === 'ready', 'A on the relay');
  const all = [A];
  for (let i = 1; i < n; i++) {
    const d = await mk(String.fromCharCode(65 + i));
    await pair(A, d);
    await until(() => d.status().relay === 'ready', 'joiner ready');
    all.push(d);
  }
  await until(() => all.every((s) => s.status().rosterCount >= n), 'roster everywhere');
  return all;
}
const idOf = (s: MeshService): string => s.status().deviceId;
async function attackerFrame(as: MeshService, kind: string, body: unknown): Promise<void> {
  const keys = (await new MeshKeyStore(path.join(dirs.get(as)!, 'mesh'), insecureTestSealer({ testMode: true })).load())!;
  const setId = keys.setId as Buffer;
  const sender = new FrameSender({ identity: keys.identity, setId, padding: 'buckets' });
  const wire = sender.seal({ secret: keys.secrets.get(1)!, gen: 1, group: GROUP_ROSTER, kind, body: body as never, to: null });
  const c = new RelayClient({ url: relay.url, setId, identity: keys.identity, baseDelayMs: 20 });
  c.start();
  await until(() => c.state === 'ready', 'attacker connection');
  await c.hold({ group: GROUP_ROSTER, session: sender.session.toString('hex'), n: sender.framesSealed, frame: wire });
  c.stop();
}
/** Everyone in `devs` hears every other one's note (proves they share the current secret). */
async function allHear(devs: MeshService[], tag: string): Promise<void> {
  for (const s of devs) await s.sendNote(`${tag}-${idOf(s).slice(0, 6)}`);
  for (const r of devs) {
    for (const s of devs) {
      if (s === r) continue;
      await until(() => r.inbox.some((i) => i.text === `${tag}-${idOf(s).slice(0, 6)}`), `${idOf(r).slice(0, 6)} hears ${idOf(s).slice(0, 6)} (${tag})`, 20_000);
    }
  }
}

describe('N1: an entry that never left the device must not strand the device\'s later changes', () => {
  it('N1: A renames while offline, quits, restarts, then removes C: B still learns of the removal and shares the new secret with A', async () => {
    const [A, B, C] = await group(3);
    const dirA = dirs.get(A)!;
    A.setOffline(true);
    await A.renameSelf('A renamed offline');
    await A.stop();
    const A2 = await mk('A', {}, dirA);
    await until(() => A2.status().relay === 'ready', 'A back');
    await A2.removeDevice(idOf(C));
    await until(() => B.status().removedDevices.includes(idOf(C)), 'B learns of the removal');
    await allHear([A2, B], 'n1');
  });
});

describe('N2: unsigned junk claiming to be A must not silence A\'s real entries', () => {
  it('N2: 70 forged entries naming A arrive from B; A then removes B; C still learns B is removed', async () => {
    const [A, B, C] = await group(3);
    const real = A.roster.entries[A.roster.entries.length - 1];
    const forged: SignedEntry[] = Array.from({ length: 70 }, () => ({ ...real, id: randomBytes(32), signature: randomBytes(64) }));
    await attackerFrame(B, KIND_ROSTER, rosterBody(forged));
    await new Promise((r) => setTimeout(r, 400));
    await A.removeDevice(idOf(B));
    await until(() => C.status().removedDevices.includes(idOf(B)), 'C learns B was removed');
    await allHear([A, C], 'n2');
  });
});

describe('N3: concurrent removals must leave every remaining device with one shared secret', () => {
  it('N3: A removes C while B removes D; A, B and E still read each other', async () => {
    const [A, B, C, D, E] = await group(5);
    await Promise.all([A.removeDevice(idOf(C)), B.removeDevice(idOf(D))]);
    await until(() => [A, B, E].every((s) => s.status().removedDevices.length === 2), 'all three know both removals');
    await allHear([A, B, E], 'n3');
    void C; void D;
  });
});

describe('N7: a removed member\'s entries that its remover never saw are void, and so are the devices they admitted', () => {
  it('N7: B adds a ghost concurrently with A removing B: the ghost is not a member, in either arrival order', async () => {
    const a = generateIdentity(), b = generateIdentity(), ghost = generateIdentity();
    const g = makeGenesisEntry(a, 'A', 'linux', 1);
    const addB = makeAddEntry(a, { name: 'B', platform: 'linux', signKey: b.signKey, agreeKey: b.agreeKey }, [g.id], 2);
    const bHello = makeRenameEntry(b, 'B1', [addB.id], 3);
    const removeB = makeRemoveEntry(a, b.deviceId, seenForNextEntry([g, addB, bHello], a.deviceId), 4);
    const ghostAdd = makeAddEntry(b, { name: 'G', platform: 'linux', signKey: ghost.signKey, agreeKey: ghost.agreeKey }, [bHello.id], 5); // concurrent with removeB
    for (const order of [[g, addB, bHello, removeB, ghostAdd], [g, addB, bHello, ghostAdd, removeB]]) {
      const s = new RosterStore(tmp('n7-'));
      await s.load();
      for (const e of order) await s.append(e);
      expect(s.activeDevices().map((d) => d.name)).toEqual(['A']);
    }
  });
});

describe('N8: a correctly paired device is never removed by a timer', () => {
  it('N8: the host\'s link is down when the new device connects and stays down past the wait; the new device is still a member afterwards', async () => {
    relay = await new FakeRelay().ready();
    const A = await mk('A', { pairConfirmMs: 300 });
    await A.createSet();
    await until(() => A.status().relay === 'ready', 'A ready');
    const D = await mk('D');
    D.setOffline(true); // D finishes the pairing but connects only after A's link is down
    await pair(A, D);
    A.setOffline(true);
    D.setOffline(false);
    await until(() => D.status().relay === 'ready', 'D connected');
    await new Promise((r) => setTimeout(r, 1200));
    A.setOffline(false);
    await until(() => A.status().relay === 'ready', 'A back');
    await new Promise((r) => setTimeout(r, 800));
    expect(A.status().removedDevices).toEqual([]);
    expect(A.status().activeDevices).toContain(idOf(D));
    expect(D.status().relay).toBe('ready');
  });
});

// ---- link-level tests (in-memory carrier) ----
interface LinkSetup { hub: MemoryHub; link: Link; got: string[]; secrets: Map<number, Buffer>; ids: Record<string, DeviceIdentity>; setId: Buffer; carrier: MemoryCarrier; roster: RosterStore }
async function linkWorld(names: string[]): Promise<LinkSetup> {
  const hub = new MemoryHub();
  const ids = Object.fromEntries(names.map((n) => [n, generateIdentity()]));
  const first = ids[names[0]];
  const setId = setIdFor(first.signKey);
  const entries = [makeGenesisEntry(first, names[0], 'linux', 1)];
  for (const n of names.slice(1)) entries.push(makeAddEntry(first, { name: n, platform: 'linux', signKey: ids[n].signKey, agreeKey: ids[n].agreeKey }, seenForNextEntry(entries, first.deviceId), 2));
  const roster = new RosterStore(tmp('lw-'));
  await roster.load();
  for (const e of entries) await roster.append(e);
  const secrets = new Map<number, Buffer>([[1, newSetSecret()]]);
  const carrier = hub.carrier(names[0]);
  const got: string[] = [];
  let saves = 0;
  const link = new Link({
    identity: first, setId, carrier, meshDir: tmp('ll-'), secrets: () => secrets, signKeyFor: (d) => roster.signKeyFor(d), isRemoved: (d) => roster.isRemoved(d),
    counter: { get: () => saves, set: async (v) => { saves = Math.max(saves, v); } },
    onFrame: (f) => { got.push(parseNoteBody(f.body)); },
  });
  await link.start(['g']);
  return { hub, link, got, secrets, ids, setId, carrier, roster };
}
const sealFrom = (w: LinkSetup, who: string, gen: number, secret: Buffer, text: string): Buffer => new FrameSender({ identity: w.ids[who], setId: w.setId, padding: 'buckets' }).seal({ secret, gen, group: 'g', kind: 'note', body: noteBody(text), to: null });
const store = (w: LinkSetup, bytes: Buffer, from: string, seq: number): void => { const l = w.hub.groups.get('g') ?? []; l.push({ seq, bytes, from }); w.hub.groups.set('g', l); };

describe('N4: junk in the waiting list must not push out another sender\'s frame', () => {
  it('N4: C\'s real frame (secret not held yet) waits; B floods 70 junk frames; when the secret arrives C\'s frame is still delivered', async () => {
    const w = await linkWorld(['A', 'B', 'C']);
    const s2 = newSetSecret();
    store(w, sealFrom(w, 'C', 2, s2, 'from C under generation 2'), 'C', 1);
    const junkSecret = newSetSecret();
    const sender = new FrameSender({ identity: w.ids.B, setId: w.setId, padding: 'buckets' });
    for (let i = 0; i < 70; i++) store(w, sender.seal({ secret: junkSecret, gen: 99, group: 'g', kind: 'note', body: noteBody('junk'), to: null }), 'B', 2 + i);
    await w.link.syncAll();
    w.secrets.set(2, s2);
    w.link.retryPending();
    await until(() => w.got.includes('from C under generation 2'), 'C\'s frame delivered after the secret arrived', 3000);
  });
});

describe('N9: an honest relay whose first retained frame is far ahead must not wedge a device', () => {
  it('N9: first retained frame numbered 150,000 is delivered; resetReadPosition() works too', async () => {
    const w = await linkWorld(['A', 'B']);
    store(w, sealFrom(w, 'B', 1, w.secrets.get(1)!, 'far ahead'), 'B', 150_000);
    await w.link.syncAll();
    await until(() => w.got.includes('far ahead'), 'the far-ahead frame arrived', 3000);
    expect(w.link.rejections().counts['relay-bad-seq'] ?? 0).toBe(0);
    await w.link.resetReadPosition();
    await w.link.syncAll();
    expect(w.link.rejections().counts['relay-bad-seq'] ?? 0).toBe(0);
  });
});

void fs;
