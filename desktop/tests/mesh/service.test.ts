// Three services in one process, a stand-in relay and a function-call pipe: create the set, pair B and C, share the roster,
// send, go offline and catch up, remove a device. (The rig test runs the same story with real processes and the real relay.)
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { insecureTestSealer } from '../../src/main/mesh/keystore';
import { MeshService } from '../../src/main/mesh/service';
import { FakeRelay } from './fake-relay';
import { tmp } from './helpers';

const live: Array<{ stop(): Promise<void> }> = [];
let relay: FakeRelay;
afterEach(async () => {
  while (live.length) await live.pop()!.stop();
  await relay?.close();
});
const logs: string[] = [];
const mk = async (name: string, dir = tmp(`svc-${name}-`)): Promise<MeshService> => {
  const s = new MeshService({ userData: dir, sealer: insecureTestSealer({ testMode: true }), testMode: true, relayUrl: relay.url, deviceName: name, platform: 'linux', log: (e, f) => logs.push(`${e} ${JSON.stringify(f ?? {})}`), relayBaseDelayMs: 20 });
  await s.start();
  live.push(s);
  return s;
};
const until = async (cond: () => boolean, what: string, ms = 5000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 15)); }
};
async function pair(host: MeshService, joiner: MeshService, approve = true): Promise<{ hostSas: string; joinerSas: string }> {
  const { room, code } = host.openPairing();
  let toHost: Buffer[] = [joiner.joinStart({ room: Buffer.from(room, 'hex'), code })];
  let joinerSas = '';
  let hostSas = '';
  for (let i = 0; i < 20 && toHost.length; i++) {
    const toJoiner = toHost.flatMap((m) => host.hostPairingMessage('c', m));
    toHost = [];
    for (const m of toJoiner) { const r = await joiner.joinMessage(m); toHost.push(...r.out); joinerSas = r.sas ?? joinerSas; }
    const p = host.pairingPrompt();
    if (p && !hostSas) {
      hostSas = p.sas;
      for (const m of await host.hostPairingDecide(p.conn, approve)) { const r = await joiner.joinMessage(m); toHost.push(...r.out); joinerSas = r.sas ?? joinerSas; }
    }
  }
  return { hostSas, joinerSas };
}

describe('device layer, end to end in one process', () => {
  it('create, pair B and C, same roster everywhere, notes reach B and C, C offline catches up, removal cuts B off', async () => {
    relay = await new FakeRelay().ready();
    const A = await mk('A');
    const B = await mk('B');
    const C = await mk('C');
    expect(A.status().inSet).toBe(false);
    await A.createSet();
    await until(() => A.status().relay === 'ready', 'A on the relay');

    const p1 = await pair(A, B);
    expect(p1.hostSas).toBe(p1.joinerSas);
    expect(p1.hostSas).toMatch(/^\d{6}$/);
    await until(() => B.status().relay === 'ready', 'B on the relay');
    const p2 = await pair(A, C);
    expect(p2.hostSas).toBe(p2.joinerSas);
    await until(() => C.status().relay === 'ready', 'C on the relay');

    // every device ends with the same verified roster (B learns of C through A's roster frame)
    await until(() => [A, B, C].every((s) => s.status().rosterCount === 3), 'roster of 3 on all');
    const ids = A.status().rosterIds;
    expect(B.status().rosterIds).toEqual(ids);
    expect(C.status().rosterIds).toEqual(ids);
    expect(A.status().activeDevices.sort()).toEqual(B.status().activeDevices.sort());

    // a sealed note from A reaches B and C
    await A.sendNote('first note');
    await until(() => B.inbox.length === 1 && C.inbox.length === 1, 'note on B and C');
    expect(B.inbox[0].text).toBe('first note');
    expect(B.inbox[0].from).toBe(A.status().deviceId);
    expect(relay.stored.some((b) => b.includes(Buffer.from('first note')))).toBe(false);

    // C goes offline, A sends two more, C comes back and catches up in order
    C.setOffline(true);
    await until(() => C.status().relay === 'stopped', 'C offline');
    await A.sendNote('second');
    await A.sendNote('third');
    await until(() => B.inbox.length === 3, 'B has 3');
    expect(C.inbox.length).toBe(1);
    C.setOffline(false);
    await until(() => C.inbox.length === 3, 'C caught up');
    expect(C.inbox.map((i) => i.text)).toEqual(['first note', 'second', 'third']);

    // remove B: B is closed, learns it, and cannot send; C and A move to generation 2 and keep talking
    const bId = B.status().deviceId;
    await A.removeDevice(bId);
    await until(() => B.status().relay === 'removed', 'B closed');
    await until(() => C.status().removedDevices.includes(bId), 'C knows of the removal');
    await until(() => C.status().generations.includes(2), 'C holds generation 2');
    await expect(B.sendNote('from the removed one')).rejects.toBeTruthy();
    await A.sendNote('after removal');
    await until(() => C.inbox.length === 4, 'C gets the post-removal note');
    expect(C.inbox[3].text).toBe('after removal');
    expect(B.inbox.map((i) => i.text)).not.toContain('after removal');
    expect(B.status().generations).toEqual([1]); // B was never given generation 2
    // nothing readable in any log
    const text = logs.join('\n');
    for (const bad of ['first note', 'second', 'after removal']) expect(text).not.toContain(bad);
  });

  it('a restarted device keeps its identity, roster and place in the set and reconnects by itself', async () => {
    relay = await new FakeRelay().ready();
    const dirA = tmp('svc-A-');
    const A = await mk('A', dirA);
    await A.createSet();
    const B = await mk('B');
    await pair(A, B);
    await until(() => B.status().relay === 'ready', 'B ready');
    const idB = B.status().deviceId;
    await B.stop();
    live.splice(live.indexOf(B), 1);
    const B2 = await mk('B', (B as unknown as { o: { userData: string } }).o.userData);
    expect(B2.status().deviceId).toBe(idB);
    expect(B2.status().inSet).toBe(true);
    expect(B2.status().rosterCount).toBe(2);
    await until(() => B2.status().relay === 'ready', 'B2 ready');
    expect(fs.existsSync(path.join(dirA, 'mesh', 'keys.bin'))).toBe(true);
  });
});
