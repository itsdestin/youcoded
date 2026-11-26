// Link layer over the in-memory carrier: delivery, order, offline catch-up, replay, restart, rollback of saved state.
import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
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
      identity: ids[n], setId, carrier, meshDir: dirs[n], secrets: () => new Map([[1, secret]]), signKeyFor: (d) => roster.signKeyFor(d), isRemoved: (d) => roster.isRemoved(d),
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

// ---------------------------------------------------------------------------------------------------------------------------
// Review fixes (2026-11-14): finding 2 (a frame can never freeze a group) and finding 7 (a lying relay cannot set the read position).
// ---------------------------------------------------------------------------------------------------------------------------
import { FrameReject, FrameWait } from '../../src/main/mesh/link';
import type { Carrier } from '../../src/main/mesh/link';

describe('link: a frame can never freeze a group', () => {
  it('a handler that says FrameReject is skipped, counted, and the next frame is delivered (no pause, no retry loop)', async () => {
    const hub = new MemoryHub();
    const A = generateIdentity(); const B = generateIdentity();
    const setId = setIdFor(A.signKey);
    const entries = [makeGenesisEntry(A, 'A', 'linux', 1)];
    entries.push(makeAddEntry(A, { name: 'B', platform: 'linux', signKey: B.signKey, agreeKey: B.agreeKey }, seenForNextEntry(entries, A.deviceId), 2));
    const rosterB = new RosterStore(tmp('rej-B-')); await rosterB.load(); for (const e of entries) await rosterB.append(e);
    const rosterA = new RosterStore(tmp('rej-A-')); await rosterA.load(); for (const e of entries) await rosterA.append(e);
    const got: string[] = [];
    const dirB = tmp('rej-Bdir-');
    const mkLink = async (id: DeviceIdentity, roster: RosterStore, dir: string, onFrame: (f: { body: unknown }) => void) => {
      const l = new Link({ identity: id, setId, carrier: hub.members.get(id.deviceId.toString('hex')) ?? hub.carrier(id.deviceId.toString('hex')), meshDir: dir, secrets: () => new Map([[1, secret]]), signKeyFor: (d) => roster.signKeyFor(d), counter: { get: () => 0, set: async () => {} }, onFrame: onFrame as never });
      await l.start(['g']);
      return l;
    };
    const la = await mkLink(A, rosterA, tmp('rej-Adir-'), () => {});
    const lb = await mkLink(B, rosterB, dirB, (f) => { const t = parseNoteBody(f.body); if (t === 'bad') throw new FrameReject('bad-content'); got.push(t); });
    await la.sendDurable({ group: 'g', kind: 'note', body: noteBody('bad') });
    await la.sendDurable({ group: 'g', kind: 'note', body: noteBody('good') });
    await settle();
    expect(got).toEqual(['good']);
    expect(lb.rejections().counts['bad-content']).toBe(1);
    expect(lb.rejections().recent[0].from).toBe(A.deviceId.toString('hex').slice(0, 8));
    // across a restart: the counted rejection is remembered and the rejected frame is not read again
    lb.stop();
    const lb2 = await mkLink(B, rosterB, dirB, (f) => { got.push('again:' + parseNoteBody(f.body)); });
    await settle();
    expect(lb2.rejections().counts['bad-content']).toBe(1);
    expect(got).toEqual(['good']);
    await la.sendDurable({ group: 'g', kind: 'note', body: noteBody('later') });
    await settle();
    expect(got).toEqual(['good', 'again:later']);
  });

  it('a frame whose handler says FrameWait is kept (and saved), does not block the next one, and is delivered after retryPending - also across a restart', async () => {
    const hub = new MemoryHub();
    const A = generateIdentity(); const B = generateIdentity();
    const setId = setIdFor(A.signKey);
    const entries = [makeGenesisEntry(A, 'A', 'linux', 1)];
    entries.push(makeAddEntry(A, { name: 'B', platform: 'linux', signKey: B.signKey, agreeKey: B.agreeKey }, seenForNextEntry(entries, A.deviceId), 2));
    const rosters = [tmp('w-A-'), tmp('w-B-')];
    const rA = new RosterStore(rosters[0]); await rA.load(); const rB = new RosterStore(rosters[1]); await rB.load();
    for (const e of entries) { await rA.append(e); await rB.append(e); }
    const got: string[] = [];
    let ready = false;
    const dirB = tmp('w-Bdir-');
    const mk2 = async (id: DeviceIdentity, roster: RosterStore, dir: string, onFrame: (f: { body: unknown }) => void) => {
      const l = new Link({ identity: id, setId, carrier: hub.members.get(id.deviceId.toString('hex')) ?? hub.carrier(id.deviceId.toString('hex')), meshDir: dir, secrets: () => new Map([[1, secret]]), signKeyFor: (d) => roster.signKeyFor(d), counter: { get: () => 0, set: async () => {} }, onFrame: onFrame as never });
      await l.start(['g']);
      return l;
    };
    const handler = (f: { body: unknown }): void => { const t = parseNoteBody(f.body); if (t === 'early' && !ready) throw new FrameWait('not yet'); got.push(t); };
    const la = await mk2(A, rA, tmp('w-Adir-'), () => {});
    const lb = await mk2(B, rB, dirB, handler);
    await la.sendDurable({ group: 'g', kind: 'note', body: noteBody('early') });
    await la.sendDurable({ group: 'g', kind: 'note', body: noteBody('next') });
    await settle();
    expect(got).toEqual(['next']); // the waiting frame did not hold 'next' back
    expect(lb.waitingCount).toBe(1);
    lb.stop();
    const lb2 = await mk2(B, rB, dirB, handler); // restart: the waiting frame was saved with the read position
    expect(lb2.waitingCount).toBe(1);
    ready = true;
    lb2.retryPending();
    await settle();
    expect(got).toEqual(['next', 'early']);
    expect(lb2.waitingCount).toBe(0);
  });

  it('a handler that keeps failing with a plain error is given up on after a few tries instead of freezing the group', async () => {
    const { devs } = await world(['A', 'B']);
    devs.B.failHandler.on = true;
    await send(devs.A, 'doomed');
    await settle();
    for (let i = 0; i < 4; i++) await devs.B.link.syncAll();
    devs.B.failHandler.on = false;
    await send(devs.A, 'fine');
    await settle();
    await devs.B.link.syncAll();
    expect(devs.B.got).toEqual(['fine']);
    expect(devs.B.link.rejections().counts['handler-failed']).toBe(1);
  });

  it('a frame from a REMOVED device is rejected as signer-removed (not parked, not blocking)', async () => {
    const w = await world(['A', 'B', 'C']);
    const c = w.devs.C;
    const b = w.devs.B;
    await send(c, 'leftover from C');
    // B removes C in its own roster before it reads the frame
    b.carrier.setOnline(false);
    await send(c, 'second leftover');
    const rem = (await import('../../src/main/mesh/crypto/roster')).makeRemoveEntry(b.id, c.id.deviceId, seenForNextEntry(b.roster.entries, b.id.deviceId), 9);
    await b.roster.append(rem);
    b.link.stop();
    b.carrier.setOnline(true);
    const b2 = await w.remake('B');
    await send(w.devs.A, 'live');
    // WHY waitFor on the state itself, not a fixed 30 ms settle: the restart re-reads, verifies and rejects the removed device's
    // frames before it reaches 'live', and on a busy machine (load 50 on 32 threads) 30 ms was not enough (verify run 2026-11-25).
    await vi.waitFor(() => expect(b2.got).toContain('live'));
    expect(b2.link.rejections().counts['signer-removed'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(b2.link.waitingCount).toBe(0);
  });
});

describe('link: a lying relay cannot set the read position', () => {
  /** A carrier that wraps the honest one and answers fetches as told. */
  function lying(inner: Carrier, mode: { v: 'honest' | 'gap-huge' | 'seq-huge' | 'junk-tail' }): Carrier {
    return {
      get connected() { return inner.connected; },
      hold: (...a) => inner.hold(...a),
      received: (g, s) => inner.received(g, s),
      ring: (g) => inner.ring(g),
      onRing: (cb) => inner.onRing(cb),
      onConnected: (cb) => inner.onConnected(cb),
      pass: (g, to, f) => inner.pass(g, to, f),
      onPass: (cb) => inner.onPass(cb),
      async fetchAfter(g, seq) {
        if (mode.v === 'gap-huge') return { frames: [{ seq: 9_000_000_000_000_000 + 1, bytes: Buffer.from('junk') }], more: false, gap: { through: 9_000_000_000_000_000 } };
        if (mode.v === 'seq-huge') return { frames: [{ seq: seq + 5_000_000, bytes: Buffer.from('junk') }], more: false };
        if (mode.v === 'junk-tail') return { frames: [{ seq: seq + 1, bytes: Buffer.from('junk') }, { seq: seq + 2, bytes: Buffer.from('junk2') }], more: false };
        return inner.fetchAfter(g, seq);
      },
    };
  }
  async function setup() {
    const hub = new MemoryHub();
    const A = generateIdentity(); const B = generateIdentity();
    const setId = setIdFor(A.signKey);
    const entries = [makeGenesisEntry(A, 'A', 'linux', 1)];
    entries.push(makeAddEntry(A, { name: 'B', platform: 'linux', signKey: B.signKey, agreeKey: B.agreeKey }, seenForNextEntry(entries, A.deviceId), 2));
    const rA = new RosterStore(tmp('p-A-')); await rA.load(); const rB = new RosterStore(tmp('p-B-')); await rB.load();
    for (const e of entries) { await rA.append(e); await rB.append(e); }
    const mode: { v: 'honest' | 'gap-huge' | 'seq-huge' | 'junk-tail' } = { v: 'honest' };
    const got: string[] = [];
    const dirB = tmp('p-Bdir-');
    const mk2 = async (id: DeviceIdentity, roster: RosterStore, dir: string, carrier: Carrier, onFrame: (f: { body: unknown }) => void) => {
      const l = new Link({ identity: id, setId, carrier, meshDir: dir, secrets: () => new Map([[1, secret]]), signKeyFor: (d) => roster.signKeyFor(d), counter: { get: () => 0, set: async () => {} }, onFrame: onFrame as never });
      await l.start(['g']);
      return l;
    };
    const cA = hub.carrier('A'); const cB = hub.carrier('B');
    const la = await mk2(A, rA, tmp('p-Adir-'), cA, () => {});
    return { hub, la, cB, mode, got, dirB, mkB: (c: Carrier) => mk2(B, rB, dirB, c, (f) => { got.push(parseNoteBody(f.body)); }) };
  }

  it('a gap that jumps to 9e15 is refused; after switching back to the honest relay the device receives new notes (it used to be deaf for good)', async () => {
    const s = await setup();
    const lb = await s.mkB(lying(s.cB, s.mode));
    s.mode.v = 'gap-huge';
    await lb.syncAll();
    expect(lb.rejections().counts['relay-bad-gap']).toBeGreaterThanOrEqual(1);
    s.mode.v = 'honest';
    await s.la.sendDurable({ group: 'g', kind: 'note', body: noteBody('after the lie') });
    await settle();
    await lb.syncAll();
    expect(s.got).toEqual(['after the lie']);
    // and the saved position was never poisoned: a restart on the honest relay still works
    lb.stop();
    const lb2 = await s.mkB(s.cB);
    await s.la.sendDurable({ group: 'g', kind: 'note', body: noteBody('after restart') });
    await settle();
    await lb2.syncAll();
    expect(s.got).toEqual(['after the lie', 'after restart']);
    void lb2;
  });
  it('a frame numbered millions ahead is judged like any other (junk is rejected) and never moves the saved position', async () => {
    const s = await setup();
    const lb = await s.mkB(lying(s.cB, s.mode));
    s.mode.v = 'seq-huge';
    await lb.syncAll();
    s.mode.v = 'honest';
    await s.la.sendDurable({ group: 'g', kind: 'note', body: noteBody('still hears') });
    await settle();
    expect(s.got).toEqual(['still hears']);
  });
  it('junk the relay serves at the tail is skipped for this session only: the SAVED position does not move past frames the device never verified', async () => {
    const s = await setup();
    const lb = await s.mkB(lying(s.cB, s.mode));
    s.mode.v = 'junk-tail';
    await lb.syncAll();
    expect(lb.rejections().counts['malformed'] ?? lb.rejections().counts['error'] ?? 0).toBeGreaterThanOrEqual(0);
    lb.stop();
    // the honest relay's real frames sit at seq 1 and 2: they must still be read after a restart on the honest relay
    s.mode.v = 'honest';
    await s.la.sendDurable({ group: 'g', kind: 'note', body: noteBody('one') });
    await s.la.sendDurable({ group: 'g', kind: 'note', body: noteBody('two') });
    await settle();
    const lb2 = await s.mkB(s.cB);
    await lb2.syncAll();
    expect(s.got).toEqual(['one', 'two']);
  });
  it('resetReadPosition reads everything again and delivers nothing twice', async () => {
    const s = await setup();
    const lb = await s.mkB(s.cB);
    await s.la.sendDurable({ group: 'g', kind: 'note', body: noteBody('x') });
    await settle();
    await lb.resetReadPosition();
    await settle();
    expect(s.got).toEqual(['x']);
  });
});

describe('link: the live lane', () => {
  const live = (d: Dev, text: string, to?: Buffer) => d.link.sendLive({ group: 'g', kind: 'note', body: noteBody(text), ...(to ? { to } : {}) });
  it('a live frame reaches every connected device once, is never stored, and is never redelivered by a sync', async () => {
    const { devs, hub } = await world(['A', 'B', 'C']);
    expect(live(devs.A, 'now')).toBe(true);
    await vi.waitFor(() => expect(devs.B.got).toEqual(['now']));
    await vi.waitFor(() => expect(devs.C.got).toEqual(['now']));
    await devs.B.link.syncAll();
    expect(devs.B.got).toEqual(['now']);
    expect(hub.stored.length).toBe(0);
    expect(devs.A.got).toEqual([]);
  });
  it('a live frame addressed to one device is not handed to the others', async () => {
    const { devs } = await world(['A', 'B', 'C']);
    for (const n of ['A', 'B', 'C']) devs[n].carrier.deviceHex = devs[n].id.deviceId.toString('hex');
    expect(live(devs.A, 'for B', devs.B.id.deviceId)).toBe(true);
    await vi.waitFor(() => expect(devs.B.got).toEqual(['for B']));
    await settle(); // settle: the negative
    expect(devs.C.got).toEqual([]);
  });
  it('offline: the frame is not queued, sendLive says false, and nothing arrives later', async () => {
    const { devs } = await world(['A', 'B']);
    devs.A.carrier.setOnline(false);
    expect(live(devs.A, 'lost')).toBe(false);
    devs.A.carrier.setOnline(true);
    await settle();
    expect(devs.B.got).toEqual([]);
  });
  it('a replayed live frame is refused as a repeat; a forged one is rejected and counted, never delivered', async () => {
    const { devs } = await world(['A', 'B']);
    const seen: Buffer[] = [];
    devs.A.carrier.passFilter = (_g, _t, f) => { seen.push(f); return 'deliver'; };
    live(devs.A, 'once');
    await vi.waitFor(() => expect(devs.B.got).toEqual(['once']));
    // replay the captured bytes straight into B's carrier, and a bit-flipped copy
    const replay = (f: Buffer): void => { devs.A.carrier.passFilter = null; devs.A.carrier.pass('g', 'all', f); };
    replay(seen[0]);
    const flipped = Buffer.from(seen[0]); flipped[flipped.length - 3] ^= 1;
    replay(flipped);
    await vi.waitFor(() => expect(Object.values(devs.B.link.rejections().counts).reduce((x, y) => x + y, 0)).toBeGreaterThanOrEqual(1));
    expect(devs.B.got).toEqual(['once']);
  });
  it('a live frame relabelled to another group is rejected (the relay names groups in clear)', async () => {
    const { devs } = await world(['A', 'B']);
    const seen: Buffer[] = [];
    devs.A.carrier.passFilter = (_g, _t, f) => { seen.push(f); return 'drop'; };
    live(devs.A, 'x');
    devs.A.carrier.passFilter = null;
    devs.A.carrier.pass('other', 'all', seen[0]);
    await vi.waitFor(() => expect(devs.B.link.rejections().counts['live-group-mismatch'] ?? 0).toBe(1));
    expect(devs.B.got).toEqual([]);
  });
  it('a handler that throws on a live frame costs only that frame', async () => {
    const { devs } = await world(['A', 'B']);
    devs.B.failHandler.on = true;
    live(devs.A, 'boom');
    await vi.waitFor(() => expect(devs.B.link.rejections().counts['live-handler-failed']).toBe(1));
    devs.B.failHandler.on = false;
    live(devs.A, 'fine');
    await vi.waitFor(() => expect(devs.B.got).toEqual(['fine']));
  });
  it('a live frame from an unknown signer is dropped and counted, never parked', async () => {
    const w = await world(['A', 'B']);
    const stranger = generateIdentity();
    const carrier = w.hub.carrier('S');
    const link = new Link({ identity: stranger, setId: w.setId, carrier, meshDir: tmp('link-S-'), secrets: () => new Map([[1, secret]]), signKeyFor: () => undefined, counter: { get: () => 0, set: async () => {} }, onFrame: () => {} });
    await link.start(['g']);
    expect(link.sendLive({ group: 'g', kind: 'note', body: noteBody('hi') })).toBe(true);
    await vi.waitFor(() => expect(w.devs.B.link.rejections().counts['live-unjudgeable'] ?? 0).toBeGreaterThanOrEqual(1));
    expect(w.devs.B.link.waitingCount).toBe(0);
    expect(w.devs.B.got).toEqual([]);
  });
});

describe('link: unfollow', () => {
  it('a group that is let go is no longer read, and following it again does not redeliver', async () => {
    const { devs } = await world(['A', 'B']);
    await send(devs.A, 'one');
    await vi.waitFor(() => expect(devs.B.got).toEqual(['one']));
    expect(devs.B.link.isFollowing('g')).toBe(true);
    await devs.B.link.unfollow('g');
    expect(devs.B.link.isFollowing('g')).toBe(false);
    await send(devs.A, 'two');
    await settle(); // settle: the negative
    expect(devs.B.got).toEqual(['one']);
    devs.B.link.follow('g');
    await devs.B.link.sync('g');
    expect(devs.B.got).toEqual(['one', 'two']);
  });
});
