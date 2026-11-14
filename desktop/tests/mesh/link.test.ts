// Link layer over the in-memory carrier: delivery, order, offline catch-up, replay, restart, rollback of saved state.
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { generateIdentity, setIdFor, type DeviceIdentity } from '../../src/main/mesh/crypto/identity';
import { makeAddEntry, makeGenesisEntry, seenForNextEntry } from '../../src/main/mesh/crypto/roster';
import { newSetSecret } from '../../src/main/mesh/crypto/keys';
import { MemoryCarrier, MemoryHub } from '../../src/main/mesh/carrier-memory';
import { Link } from '../../src/main/mesh/link';
import { RosterStore } from '../../src/main/mesh/roster-store';
import { noteBody, parseNoteBody } from '../../src/main/mesh/wire';
import { tmp } from './helpers';

const secret = newSetSecret();
interface Dev { id: DeviceIdentity; dir: string; carrier: MemoryCarrier; roster: RosterStore; got: string[]; saves: { n: number }; link: Link; events: string[]; failHandler: { on: boolean } }

async function world(names: string[]): Promise<{ hub: MemoryHub; devs: Record<string, Dev>; setId: Buffer; remake: (n: string) => Promise<Dev> }> {
  const hub = new MemoryHub();
  const ids = Object.fromEntries(names.map((n) => [n, generateIdentity()]));
  const first = ids[names[0]];
  const setId = setIdFor(first.signKey);
  const entries = [makeGenesisEntry(first, names[0], 'linux', 1)];
  for (const n of names.slice(1)) entries.push(makeAddEntry(first, { name: n, platform: 'linux', signKey: ids[n].signKey, agreeKey: ids[n].agreeKey }, seenForNextEntry(entries, first.deviceId), 2));
  const devs: Record<string, Dev> = {};
  const saves = Object.fromEntries(names.map((n) => [n, { n: 0 }]));
  const dirs = Object.fromEntries(names.map((n) => [n, tmp(`link-${n}-`)]));
  const make = async (n: string): Promise<Dev> => {
    const roster = new RosterStore(dirs[n]);
    await roster.load();
    if (roster.size === 0) for (const e of entries) await roster.append(e);
    const carrier = hub.members.get(n) ?? hub.carrier(n);
    const got: string[] = [];
    const events: string[] = [];
    const failHandler = { on: false };
    const link = new Link({
      identity: ids[n], setId, carrier, meshDir: dirs[n], secrets: () => new Map([[1, secret]]), signKeyFor: (d) => roster.signKeyFor(d),
      counter: { get: () => saves[n].n, set: async (v) => { saves[n].n = Math.max(saves[n].n, v); } },
      onFrame: (f) => { if (failHandler.on) throw new Error('boom'); got.push(parseNoteBody(f.body)); },
      onEvent: (e) => events.push(e),
    });
    await link.start(['g']);
    return { id: ids[n], dir: dirs[n], carrier, roster, got, saves: saves[n], link, events, failHandler };
  };
  for (const n of names) devs[n] = await make(n);
  return { hub, devs, setId, remake: make };
}
const send = (d: Dev, text: string) => d.link.sendDurable({ group: 'g', kind: 'note', body: noteBody(text) });
const settle = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 30)); };

describe('link: delivery', () => {
  it('a sealed frame from A is received, verified and delivered once on B and C; A does not see its own', async () => {
    const { devs, hub } = await world(['A', 'B', 'C']);
    await send(devs.A, 'hello everyone');
    await settle();
    expect(devs.B.got).toEqual(['hello everyone']);
    expect(devs.C.got).toEqual(['hello everyone']);
    expect(devs.A.got).toEqual([]);
    // the hub (a relay) only ever stored sealed bytes
    expect(hub.stored.length).toBe(1);
    expect(hub.stored[0].includes(Buffer.from('hello everyone'))).toBe(false);
  });
  it('order is kept', async () => {
    const { devs } = await world(['A', 'B']);
    for (const t of ['1', '2', '3', '4']) await send(devs.A, t);
    await settle();
    expect(devs.B.got).toEqual(['1', '2', '3', '4']);
  });
  it('syncing again never delivers a frame twice', async () => {
    const { devs } = await world(['A', 'B']);
    await send(devs.A, 'once');
    await settle();
    await devs.B.link.syncAll();
    await devs.B.link.syncAll();
    expect(devs.B.got).toEqual(['once']);
  });
});

describe('link: offline catch-up', () => {
  it('C offline for three frames receives all three, in order, exactly once, when it comes back', async () => {
    const { devs } = await world(['A', 'B', 'C']);
    devs.C.carrier.setOnline(false);
    for (const t of ['x', 'y', 'z']) await send(devs.A, t);
    await settle();
    expect(devs.B.got).toEqual(['x', 'y', 'z']);
    expect(devs.C.got).toEqual([]);
    devs.C.carrier.setOnline(true);
    await settle();
    expect(devs.C.got).toEqual(['x', 'y', 'z']);
  });
  it('a sender that is offline keeps the frame (same sealed bytes) and delivers it on reconnect, with unbroken numbering', async () => {
    const { devs, hub } = await world(['A', 'B']);
    devs.A.carrier.setOnline(false);
    const p1 = send(devs.A, 'late-1');
    const p2 = send(devs.A, 'late-2');
    await settle();
    expect(hub.stored.length).toBe(0);
    devs.A.carrier.setOnline(true);
    const r = await Promise.all([p1, p2]);
    await settle();
    expect(r.map((x) => x.counter)).toEqual([0, 1]);
    expect(devs.B.got).toEqual(['late-1', 'late-2']);
  });
});

describe('link: restart and saved state', () => {
  it('after a restart a device does not see old frames again, and still gets new ones', async () => {
    const w = await world(['A', 'B']);
    await send(w.devs.A, 'before');
    await settle();
    w.devs.B.link.stop();
    const b2 = await w.remake('B');
    await settle();
    expect(b2.got).toEqual([]); // nothing redelivered
    await send(w.devs.A, 'after');
    await settle();
    expect(b2.got).toEqual(['after']);
  });
  it('replay state and the save counter are written (state first, counter second)', async () => {
    const w = await world(['A', 'B']);
    await send(w.devs.A, 'one');
    await settle();
    expect(fs.existsSync(path.join(w.devs.B.dir, 'link-state.bin'))).toBe(true);
    expect(w.devs.B.saves.n).toBeGreaterThanOrEqual(1);
  });
  it('an OLDER state file than the recorded save counter is detected as rolled back: the link says so and re-reads from the start', async () => {
    const w = await world(['A', 'B']);
    await send(w.devs.A, 'one');
    await settle();
    const stateFile = path.join(w.devs.B.dir, 'link-state.bin');
    const old = fs.readFileSync(stateFile); // saved after 'one'
    await send(w.devs.A, 'two');
    await send(w.devs.A, 'three');
    await settle();
    expect(w.devs.B.got).toEqual(['one', 'two', 'three']);
    w.devs.B.link.stop();
    fs.writeFileSync(stateFile, old); // a backup restore of just this file
    const b2 = await w.remake('B');
    await settle();
    expect(b2.events).toContain('rolled-back');
    // frames the old state knew are refused as replays; the ones applied after the backup are re-delivered (handlers must be idempotent)
    expect(b2.got).toEqual(['two', 'three']);
    expect(w.devs.B.saves.n).toBeGreaterThanOrEqual(2);
    // and the counter has moved past the recorded one, so the NEXT restart is clean
    b2.link.stop();
    const b3 = await w.remake('B');
    await settle();
    expect(b3.events).not.toContain('rolled-back');
    expect(b3.got).toEqual([]);
  });
});

describe('link: frames that cannot be checked yet or fail', () => {
  it('a handler that throws does not lose the frame: it is retried on the next sync', async () => {
    const { devs } = await world(['A', 'B']);
    devs.B.failHandler.on = true;
    await send(devs.A, 'fragile');
    await settle();
    expect(devs.B.got).toEqual([]);
    devs.B.failHandler.on = false;
    await devs.B.link.syncAll();
    expect(devs.B.got).toEqual(['fragile']);
  });
  it('a frame from a device the roster does not know yet waits (never skipped) and is delivered after retryPending', async () => {
    const w = await world(['A', 'B']);
    const c = generateIdentity();
    // C is a real member from A's point of view only after A adds it; B's roster does not have it yet.
    const aRoster = w.devs.A.roster;
    const addC = makeAddEntry(w.devs.A.id, { name: 'C', platform: 'linux', signKey: c.signKey, agreeKey: c.agreeKey }, seenForNextEntry(aRoster.entries, w.devs.A.id.deviceId), 3);
    await aRoster.append(addC);
    const hubC = w.hub.carrier('C');
    const cDir = tmp('link-C-');
    const cRoster = new RosterStore(cDir);
    await cRoster.load();
    for (const e of aRoster.entries) await cRoster.append(e);
    const cLink = new Link({ identity: c, setId: w.setId, carrier: hubC, meshDir: cDir, secrets: () => new Map([[1, secret]]), signKeyFor: (d) => cRoster.signKeyFor(d), counter: { get: () => 0, set: async () => {} }, onFrame: () => {} });
    await cLink.start(['g']);
    await cLink.sendDurable({ group: 'g', kind: 'note', body: noteBody('from C') });
    await settle();
    expect(w.devs.B.got).toEqual([]); // B cannot check C yet
    await w.devs.B.roster.append(addC);
    w.devs.B.link.retryPending();
    await settle();
    expect(w.devs.B.got).toEqual(['from C']);
  });
  it('junk in the group is dropped and later good frames still arrive', async () => {
    const { devs, hub } = await world(['A', 'B']);
    hub.groups.set('g', [{ seq: 1, bytes: Buffer.from('not a frame at all'), from: 'evil' }]);
    await send(devs.A, 'good');
    await settle();
    expect(devs.B.got).toEqual(['good']);
  });
});
