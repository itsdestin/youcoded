// Review fixes (2026-11-14), device layer, in one process against the stand-in relay (which now enforces the Worker's ancestry rule):
// finding 1 (rename, removal as a two-step, failed pairing), 2 (a bad or leftover frame), 3 (who may hand out a set secret), 4 (roster flood).
// The rig (tests/mesh-rig) repeats the main stories with real processes, the real Worker and killed backends.
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { insecureTestSealer, MeshKeyStore } from '../../src/main/mesh/keystore';
import { MeshService, type MeshServiceOptions } from '../../src/main/mesh/service';
import { RelayClient } from '../../src/main/mesh/relay-client';
import { RelaySyncState } from '../../src/main/mesh/relay-sync';
import { FrameSender } from '../../src/main/mesh/crypto/frames';
import { sealSecretTo } from '../../src/main/mesh/crypto/keygen';
import { makeAddEntry, makeRemoveEntry, makeRenameEntry, encodeEntry, seenForNextEntry } from '../../src/main/mesh/crypto/roster';
import { deviceIdFor, generateIdentity, setIdFor } from '../../src/main/mesh/crypto/identity';
import { RosterStore } from '../../src/main/mesh/roster-store';
import { GROUP_ROSTER, KIND_REMOVAL, KIND_ROSTER, removalBody, rosterBody } from '../../src/main/mesh/wire';
import { FakeRelay } from './fake-relay';
import { tmp } from './helpers';

const live: Array<{ stop(): Promise<void> }> = [];
let relay: FakeRelay;
afterEach(async () => {
  while (live.length) await live.pop()!.stop();
  await relay?.close();
});
const logs: string[] = [];
const dirs = new Map<MeshService, string>();
const mk = async (name: string, extra: Partial<MeshServiceOptions> = {}, dir = tmp(`rv-${name}-`)): Promise<MeshService> => {
  const s = new MeshService({ userData: dir, sealer: insecureTestSealer({ testMode: true }), testMode: true, relayUrl: relay.url, deviceName: name, platform: 'linux', log: (e, f) => logs.push(`${e} ${JSON.stringify(f ?? {})}`), relayBaseDelayMs: 20, ...extra });
  await s.start();
  live.push(s);
  dirs.set(s, dir);
  return s;
};
const until = async (cond: () => boolean | Promise<boolean>, what: string, ms = 8000): Promise<void> => {
  const t0 = Date.now();
  while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 15)); }
};
/** Pair through the direct carrier (the same host and joiner code the relay path runs). */
async function pair(host: MeshService, joiner: MeshService, approve = true): Promise<void> {
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
      for (const m of await host.hostPairingDecide(p.conn, approve)) { const r = await joiner.joinMessage(m); toHost.push(...r.out); }
    }
  }
}
async function trio(extraA: Partial<MeshServiceOptions> = {}) {
  relay = await new FakeRelay().ready();
  const A = await mk('A', extraA);
  await A.createSet();
  await until(() => A.status().relay === 'ready', 'A on the relay');
  const B = await mk('B');
  await pair(A, B);
  await until(() => B.status().relay === 'ready', 'B ready');
  const C = await mk('C');
  await pair(A, C);
  await until(() => C.status().relay === 'ready', 'C ready');
  await until(() => [A, B, C].every((s) => s.status().rosterCount === 3), 'roster of 3 everywhere');
  return { A, B, C };
}
/** Send a frame AS a member (that device's own keys), with a body of the attacker's choosing: what a compromised device could do. */
async function attackerFrame(victim: MeshService, as: MeshService, group: string, kind: string, body: unknown): Promise<void> {
  const keys = (await new MeshKeyStore(path.join(dirs.get(as)!, 'mesh'), insecureTestSealer({ testMode: true })).load())!;
  const setId = keys.setId as Buffer;
  const sender = new FrameSender({ identity: keys.identity, setId, padding: 'buckets' });
  const wire = sender.seal({ secret: keys.secrets.get(1)!, gen: 1, group, kind, body: body as never, to: null });
  const c = new RelayClient({ url: relay.url, setId, identity: keys.identity, baseDelayMs: 20 });
  c.start();
  await until(() => c.state === 'ready', 'attacker connection');
  await c.hold({ group, session: sender.session.toString('hex'), n: sender.framesSealed, frame: wire });
  c.stop();
  void victim;
}
const idOf = (s: MeshService): string => s.status().deviceId;

describe('rename, removal and pairing against a relay that follows ancestry', () => {
  it('after a rename the relay still takes a 3rd device and a removal (the relay saw the rename as a statement, never the name)', async () => {
    relay = await new FakeRelay().ready();
    const A = await mk('A');
    await A.createSet();
    await until(() => A.status().relay === 'ready', 'A ready');
    const B = await mk('B');
    await pair(A, B);
    await A.renameSelf('Renamed A');
    await until(() => A.status().relayPending === 0, 'the relay accepted the rename');
    expect(relay.accepted.map((a) => a.kind)).toEqual(['add', 'rename']);
    const C = await mk('C');
    await pair(A, C); // used to fail: the relay could not walk from the newest entry (the rename) to A's introduction
    await until(() => C.status().relay === 'ready', 'C ready');
    expect(A.status().unconfirmedJoins).toEqual([]);
    expect(relay.accepted.map((a) => a.kind)).toEqual(['add', 'rename', 'add']);
    expect(A.status().relayRefusals).toEqual({});
    // nothing the relay was told contains a device name
    expect(JSON.stringify(relay.accepted)).not.toContain('Renamed');
    expect(await A.removeDevice(idOf(B))).toBe('done');
    await until(() => B.status().relay === 'removed', 'B cut off at the relay');
  });

  it('entries the relay never heard of (renames written while it was unreachable) do not block a later pairing or removal', async () => {
    relay = await new FakeRelay().ready();
    const A = await mk('A');
    await A.createSet();
    await until(() => A.status().relay === 'ready', 'A ready');
    const B = await mk('B');
    await pair(A, B);
    await A.stressAppend(3); // log entries with NO statement at the relay: the newest head is now an entry the relay cannot walk through
    const C = await mk('C');
    await pair(A, C);
    await until(() => C.status().relay === 'ready', 'C ready');
    expect(await A.removeDevice(idOf(B))).toBe('done');
    expect(A.status().relayRefusals).toEqual({});
  });

  it('a removal the relay cannot take yet is "pending" (as data), is retried by itself, and is "done" once accepted', async () => {
    const { A, B } = await trio({ removeWaitMs: 150, relayRetryMs: 20 });
    const bId = idOf(B);
    relay.rosterPutRefusal = 'roster-rate-limited'; // a transient refusal
    expect(await A.removeDevice(bId)).toBe('pending');
    expect(A.status().removalsPending).toEqual([bId]);
    expect(B.status().relay).toBe('ready'); // not cut off yet: the relay has not been told, and the app does not pretend otherwise
    relay.rosterPutRefusal = null;
    await until(() => A.status().removalsPending.length === 0, 'the retry got through', 8000);
    await until(() => B.status().relay === 'removed', 'B cut off');
    expect(A.status().generations).toContain(2);
  });

  it('a removal still pending survives a restart: the new secret was saved first, the queue is on disk, and the restart finishes it', async () => {
    const { A, B, C } = await trio({ removeWaitMs: 100, relayRetryMs: 20 });
    const bId = idOf(B);
    relay.rosterPutRefusal = 'roster-rate-limited';
    expect(await A.removeDevice(bId)).toBe('pending');
    const dirA = dirs.get(A)!;
    await A.stop();
    relay.rosterPutRefusal = null;
    const A2 = await mk('A', { removeWaitMs: 100, relayRetryMs: 20 }, dirA);
    expect(A2.status().removalsPending).toEqual([bId]); // still known after the restart
    await until(() => B.status().relay === 'removed', 'B cut off after the restart', 10_000);
    await until(() => A2.status().removalsPending.length === 0 && A2.status().relayPending === 0, 'queue empty');
    await until(() => C.status().generations.includes(2), 'C holds generation 2');
    expect(A2.status().generations).toContain(2);
    await A2.sendNote('after the restart');
    await until(() => C.inbox.some((i) => i.text === 'after the restart'), 'C hears A under generation 2');
  });

  it('a permanent refusal is counted and shown, never retried forever', async () => {
    const { A, B } = await trio({ removeWaitMs: 100, relayRetryMs: 20 });
    relay.rosterPutRefusal = 'bad-ancestry';
    await A.removeDevice(idOf(B));
    await until(() => A.status().relayPending === 0, 'queue settled');
    expect(A.status().relayRefusals['bad-ancestry']).toBe(1);
  });

  it('a pairing the relay refuses leaves the host exactly as it was (no phantom member) and the joiner starts over cleanly', async () => {
    relay = await new FakeRelay().ready();
    const A = await mk('A');
    await A.createSet();
    await until(() => A.status().relay === 'ready', 'A ready');
    const B = await mk('B');
    relay.rosterPutRefusal = 'too-many-devices';
    await pair(A, B);
    expect(B.status().inSet).toBe(false);
    expect(A.status().rosterCount).toBe(1);
    expect(A.status().activeDevices).toEqual([idOf(A)]);
    expect(A.status().unconfirmedJoins).toEqual([]);
    expect([...relay.rooms.values()][0].roster.size).toBe(1);
    relay.rosterPutRefusal = null;
    await pair(A, B); // the same joiner, the same host: works
    expect(B.status().inSet).toBe(true);
    expect(A.status().rosterCount).toBe(2);
  });

  it('a pairing whose new device never connects is rolled back by an ordinary removal; one that does connect is kept', async () => {
    relay = await new FakeRelay().ready();
    const A = await mk('A', { pairConfirmMs: 400 });
    await A.createSet();
    await until(() => A.status().relay === 'ready', 'A ready');
    const B = await mk('B');
    await pair(A, B);
    await until(() => B.status().relay === 'ready', 'B ready');
    const ghost = await mk('G');
    ghost.setOffline(true); // finishes the pairing, never reaches the relay
    await pair(A, ghost);
    expect(ghost.status().inSet).toBe(true);
    expect(A.status().unconfirmedJoins).toEqual([idOf(ghost)]);
    await until(() => A.status().removedDevices.includes(idOf(ghost)) && A.status().unconfirmedJoins.length === 0, 'the pairing rolled back', 10_000);
    expect(A.status().activeDevices.sort()).toEqual([idOf(A), idOf(B)].sort());
    expect(A.status().removedDevices).not.toContain(idOf(B)); // the one that connected was confirmed and kept
  });

  it('a kill between the relay accepting a pairing and the host writing it down is finished at the next start (then rolled back if nobody comes)', async () => {
    relay = await new FakeRelay().ready();
    const dirA = tmp('rv-A-');
    const A = await mk('A', {}, dirA);
    await A.createSet();
    await until(() => A.status().relay === 'ready', 'A ready');
    const keys = (await new MeshKeyStore(path.join(dirA, 'mesh'), insecureTestSealer({ testMode: true })).load())!;
    const ghost = generateIdentity();
    const add = makeAddEntry(keys.identity, { name: 'ghost', platform: 'linux', signKey: ghost.signKey, agreeKey: ghost.agreeKey }, seenForNextEntry(A.roster.entries, keys.identity.deviceId), Date.now());
    await A.stop();
    // the state a kill leaves: the intent is on disk, the add is not in the log
    const sync = new RelaySyncState(path.join(dirA, 'mesh'));
    await sync.load();
    await sync.addJoin({ dev: ghost.deviceId.toString('hex'), entry: Buffer.from(encodeEntry(add)).toString('base64'), at: Date.now() });
    const A2 = await mk('A', { pairConfirmMs: 300 }, dirA);
    await until(() => A2.status().rosterCount >= 2, 'the add was finished');
    await until(() => A2.status().removedDevices.includes(ghost.deviceId.toString('hex')) && A2.status().unconfirmedJoins.length === 0, 'and rolled back', 10_000);
    expect(A2.status().activeDevices).toEqual([idOf(A2)]);
  });
});

describe('a bad or leftover frame never freezes a device', () => {
  it('a member sends a removal bundle with junk inside: it is rejected (counted, sender prefix), and later notes still arrive, across a restart', async () => {
    const { A, B, C } = await trio();
    await attackerFrame(C, B, GROUP_ROSTER, KIND_REMOVAL, removalBody({ entries: [], gen: 1, sealed: new Map([[idOf(C), randomBytes(100)]]) }));
    await until(() => (C.status().rejections.counts['removal-without-entry'] ?? 0) === 1, 'the junk was rejected');
    expect(C.status().rejections.recent[0].from).toBe(idOf(B).slice(0, 8));
    expect(JSON.stringify(C.status().rejections)).not.toMatch(/[0-9a-f]{20}/); // a prefix, never a full id or any content
    await A.sendNote('still works');
    await until(() => C.inbox.some((i) => i.text === 'still works'), 'C hears A after the junk');
    const dirC = dirs.get(C)!;
    await C.stop();
    const C2 = await mk('C', {}, dirC);
    await until(() => C2.status().relay === 'ready', 'C2 ready');
    expect(C2.status().rejections.counts['removal-without-entry']).toBe(1); // counted, and remembered
    await A.sendNote('after restart');
    await until(() => C2.inbox.some((i) => i.text === 'after restart'), 'C2 hears A');
    // and a LATER legitimate removal of the attacker reaches C2 (it used to never arrive: the group stayed paused on the junk frame)
    await A.removeDevice(idOf(B));
    await until(() => C2.status().removedDevices.includes(idOf(B)), 'C2 learns of the removal');
  });

  it('a removed device\'s leftover frame does not block the group: notes sent after it still arrive', async () => {
    const { A, B, C } = await trio();
    A.setOffline(true);
    await until(() => A.status().relay === 'stopped', 'A offline');
    await C.sendNote('leftover from C');
    await B.removeDevice(idOf(C));
    await B.sendNote('later from B');
    A.setOffline(false);
    await until(() => A.inbox.some((i) => i.text === 'later from B'), 'A receives the later note', 10_000);
    await until(() => A.status().waitingFrames === 0, 'nothing left waiting');
    expect(A.status().removedDevices).toContain(idOf(C));
  });
});

describe('a set secret is taken only from a verified removal', () => {
  it('a member cannot overwrite another device\'s secret with a bundle that has no removal, or replay an old removal to mint a new generation', async () => {
    const { A, B, C } = await trio();
    const setId = Buffer.from((await new MeshKeyStore(path.join(dirs.get(B)!, 'mesh'), insecureTestSealer({ testMode: true })).load())!.setId as Buffer);
    const kB = (await new MeshKeyStore(path.join(dirs.get(B)!, 'mesh'), insecureTestSealer({ testMode: true })).load())!;
    const kC = (await new MeshKeyStore(path.join(dirs.get(C)!, 'mesh'), insecureTestSealer({ testMode: true })).load())!;
    const evil = randomBytes(32);
    const sealFor = (gen: number): Map<string, Buffer> => new Map([[idOf(C), sealSecretTo(kC.identity.agreeKey, setId, gen, evil, kB.identity.deviceId, kC.identity.deviceId)]]);
    // 1. the attack from the review: no entries, gen 1, a secret sealed to the victim
    await attackerFrame(C, B, GROUP_ROSTER, KIND_REMOVAL, removalBody({ entries: [], gen: 1, sealed: sealFor(1) }));
    await until(() => (C.status().rejections.counts['removal-without-entry'] ?? 0) === 1, 'refused');
    // C and A still share generation 1: A's notes reach C, and C's reach A
    await A.sendNote('A to C');
    await C.sendNote('C to A');
    await until(() => C.inbox.some((i) => i.text === 'A to C') && A.inbox.some((i) => i.text === 'C to A'), 'both directions still work');
    expect(C.status().generations).toEqual([1]);
    // 2. B removes a third device for real (generation 2) ... then replays that very removal entry to mint generation 3
    const D = await mk('D');
    await pair(A, D);
    await until(() => [A, B, C].every((s) => s.status().rosterCount === 4), 'D known everywhere');
    expect(await B.removeDevice(idOf(D))).toBe('done');
    await until(() => C.status().generations.includes(2), 'C holds generation 2');
    const removeEntry = B.roster.entries.find((e) => e.kind === 'remove')!;
    await attackerFrame(C, B, GROUP_ROSTER, KIND_REMOVAL, removalBody({ entries: [removeEntry], gen: 3, sealed: sealFor(3) }));
    await until(() => (C.status().rejections.counts['generation-not-justified'] ?? 0) === 1, 'the replayed removal was refused');
    // 3. the same removal, the right generation number but a different secret: an existing generation is never overwritten
    await attackerFrame(C, B, GROUP_ROSTER, KIND_REMOVAL, removalBody({ entries: [removeEntry], gen: 2, sealed: sealFor(2) }));
    await until(() => (C.status().rejections.counts['generation-already-held'] ?? 0) === 1, 'overwrite refused');
    expect(C.status().generations).toEqual([1, 2]);
    await A.sendNote('A to C, generation 2');
    await until(() => C.inbox.some((i) => i.text === 'A to C, generation 2'), 'still one view of the set');
  });

  it('POLICY (a decision for the product owner, deliberately NOT changed here): any member may remove any other, the first device included', async () => {
    const { A, B } = await trio();
    expect(await B.removeDevice(idOf(A))).toBe('done'); // B removes the set's creator
    await until(() => A.status().relay === 'removed', 'A, the creator, is cut off');
    expect(B.status().removedDevices).toContain(idOf(A));
  });
});

describe('a flooding member is refused and flagged, not obeyed', () => {
  it('80 renames from one member: the receiver stops at its limit, flags the member, stays quick, and can still remove it', async () => {
    const { A, B } = await trio();
    // B writes 80 valid renames into ITS OWN log (a custom client would), then ships them to A as roster frames, ten per frame
    await B.stressAppend(80);
    const ours = B.roster.entries.slice(-80);
    const t0 = Date.now();
    for (let i = 0; i < ours.length; i += 10) await attackerFrame(A, B, GROUP_ROSTER, KIND_ROSTER, rosterBody(ours.slice(i, i + 10)));
    await until(() => A.status().flaggedDevices.includes(idOf(B)), 'B flagged', 15_000);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect((A.status().rosterRejected['rejected-rate'] ?? 0) + (A.status().rosterRejected['rejected-flagged'] ?? 0)).toBeGreaterThan(0);
    expect(A.roster.countOf(idOf(B))).toBeLessThanOrEqual(61); // 60 an hour, plus its introduction
    expect(await A.removeDevice(idOf(B))).toBe('done');
  });
});

describe('a device that was away comes back and gets the whole roster, verified against what it has', () => {
  it('C is offline while A pairs D, renames itself and removes B; on return C holds the same roster, the removal and generation 2', async () => {
    const { A, B, C } = await trio({ removeWaitMs: 2000 });
    C.setOffline(true);
    await until(() => C.status().relay === 'stopped', 'C offline');
    const D = await mk('D');
    await pair(A, D);
    await A.renameSelf('A renamed');
    expect(await A.removeDevice(idOf(B))).toBe('done');
    await until(() => A.status().rosterCount === 6, 'A holds 6 entries');
    C.setOffline(false);
    await until(() => C.status().rosterCount === 6, 'C holds the whole roster after returning', 10_000);
    expect(C.status().rosterIds).toEqual(A.status().rosterIds);
    expect(C.status().removedDevices).toContain(idOf(B));
    await until(() => C.status().generations.includes(2), 'and generation 2');
    expect(C.status().rosterGaps).toBe(0);
    expect(C.status().parkedRoster).toBe(0);
  });
});

describe('retention marks: chat lines are marked, roster and removal frames are control data', () => {
  it('notes go to the relay marked line:true; the roster and the removal bundle are not marked (so the relay never drops them on the 30-day rule)', async () => {
    const { A, B } = await trio({ removeWaitMs: 2000 });
    await A.sendNote('a chat line');
    expect(await A.removeDevice(idOf(B))).toBe('done');
    await until(() => relay.holds.some((h) => h.g === 'note.test'), 'the note reached the relay');
    expect(relay.holds.filter((h) => h.g === 'note.test').every((h) => h.line)).toBe(true);
    const control = relay.holds.filter((h) => h.g === 'roster');
    expect(control.length).toBeGreaterThanOrEqual(3); // two adds and the removal bundle
    expect(control.every((h) => !h.line)).toBe(true);
  });
});

describe('roster headroom', () => {
  it('reports how many entries still fit', async () => {
    relay = await new FakeRelay().ready();
    const A = await mk('A');
    await A.createSet();
    expect(A.status().rosterHeadroom).toBe(8192 - 1);
    void makeRemoveEntry; void makeRenameEntry; void deviceIdFor; void setIdFor; void RosterStore; void fs;
  });
});
