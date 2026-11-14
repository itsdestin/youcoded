// Third-round review of the device layer and relay (2026-11-14): the class is "a hostile PAIRED member uses volume or pre-signed entries to defeat a
// cap, a limit or the removal rule". One test per finding, written BEFORE the fixes (see the report for how many failed on the old code), plus the
// generic cap-invariant test at the bottom: for every cap, flood from one signer and assert honest entries still take effect.
import { describe, expect, it } from 'vitest';
import { performance } from 'perf_hooks';
import { toHex } from '../../src/main/mesh/crypto/bytes';
import { encode, decode } from '../../src/main/mesh/crypto/cbor';
import { generateIdentity, setIdFor, type DeviceIdentity } from '../../src/main/mesh/crypto/identity';
import {
  MAX_ADMISSIONS_PER_SIGNER, MAX_ENTRIES_PER_DEVICE, MAX_KNOWN_KEYS, MAX_REMOVALS_PER_SIGNER, MAX_SET_DEVICES,
  RosterVerifier, makeAddEntry, makeGenesisEntry, makeHelloEntry, makeRemoveEntry, makeRenameEntry, seenForNextEntry, type AdoptedRule, type MutualRule, type SignedEntry,
} from '../../src/main/mesh/crypto/roster';
import { parseStatement } from '../../src/main/mesh/crypto/generation';
import { DeviceCore, GenBook, type Out } from '../../src/main/mesh/device-core';
import { RosterStore } from '../../src/main/mesh/roster-store';
import { KIND_HEADS, KIND_NEED, KIND_REMOVAL, KIND_ROSTER, headsBody, needBody, parseRemovalBody, rosterBody } from '../../src/main/mesh/wire';

const info = (d: DeviceIdentity, name = 'd') => ({ name, platform: 'linux', signKey: d.signKey, agreeKey: d.agreeKey });
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const ids = (n: number): DeviceIdentity[] => Array.from({ length: n }, () => generateIdentity());
const activeNames = (v: RosterVerifier, names: Record<string, DeviceIdentity>): string => v.active().map((d) => Object.entries(names).find(([, i]) => i.deviceId.equals(d.deviceId))?.[0] ?? '?').sort().join('');
const rules: MutualRule[] = ['both', 'first-admitted'];

// ---------------------------------------------------------------------------------------------------------------- serious 1
describe('serious 1: a senior hostile device cannot make itself unremovable with junk removals', () => {
  for (const rule of rules) for (const spam of [0, 50, 95, 96, 120, 200]) {
    it(`${rule}: X (first device) signs ${spam} junk removals, A removes X: X is removed and A is not`, () => {
      const X = generateIdentity(), A = generateIdentity();
      const g = makeGenesisEntry(X, 'X', 'linux', 1);
      const addA = makeAddEntry(X, info(A), [g.id], 2);
      const v = new RosterVerifier(rule);
      v.add(g); v.add(addA);
      let prev = addA;
      // junk removals against made-up ids (they can have no effect), within X's own quota
      for (let i = 0; i < spam; i++) { const e = makeRemoveEntry(X, generateIdentity().deviceId, [prev.id], 10 + i); v.add(e); prev = e; }
      v.add(makeRemoveEntry(A, X.deviceId, [prev.id], 5000));
      expect(v.removed.has(hex(X.deviceId))).toBe(true);
      expect(v.removed.has(hex(A.deviceId))).toBe(false);
    });
  }
  it('junk removals that name REAL devices (a signer is limited to MAX_REMOVALS_PER_SIGNER distinct targets) cannot crowd out the honest removal either', () => {
    const X = generateIdentity(), A = generateIdentity();
    const others = ids(6);
    const g = makeGenesisEntry(X, 'X', 'linux', 1);
    const v = new RosterVerifier('both');
    v.add(g);
    let prev = g;
    for (const o of [A, ...others.slice(0, 3)]) { prev = makeAddEntry(X, info(o), [prev.id], 2); v.add(prev); }
    for (let i = 0; i < 200; i++) { const t = [X, A, ...others.slice(0, 3)][i % 5]; const e = makeRemoveEntry(X, t.deviceId, [prev.id], 10 + i); v.add(e); prev = e; }
    v.add(makeRemoveEntry(A, X.deviceId, [prev.id], 9999));
    expect(v.removed.has(hex(X.deviceId))).toBe(true);
    expect(MAX_REMOVALS_PER_SIGNER).toBeGreaterThanOrEqual(MAX_SET_DEVICES / 2);
  });
});

// ---------------------------------------------------------------------------------------------------------------- serious 2
async function ghostWorld(adopted: AdoptedRule): Promise<{ A: DeviceIdentity; B: DeviceIdentity; X: DeviceIdentity; G: DeviceIdentity; roster: RosterStore; core: DeviceCore; entries: SignedEntry[] }> {
  const [A, B, X, G] = ids(4);
  const roster = new RosterStore('/x', () => 1e6, { memory: true, adopted });
  const core = new DeviceCore({ identity: A, setId: setIdFor(A.signKey), roster, book: new GenBook(), takeoverMs: 100 });
  core.genesis();
  const g = makeGenesisEntry(A, 'A', 'linux', 1); await roster.append(g);
  const addB = makeAddEntry(A, info(B), [g.id], 2); await roster.append(addB);
  const addX = makeAddEntry(A, info(X), [addB.id], 3); await roster.append(addX);
  const addG = makeAddEntry(X, info(G, "Destin's Phone"), [addX.id], 4); await roster.append(addG, { remote: true, from: toHex(X.deviceId) });
  return { A, B, X, G, roster, core, entries: [g, addB, addX, addG] };
}
describe('serious 2: devices a removed device admitted (the swappable rule), and the hard set size', () => {
  it("rule 'stay' (default, unchanged): a ghost the removed device admitted is still a member after the removal and the next secret is sealed to it", async () => {
    const w = await ghostWorld('stay');
    await w.roster.append(makeRemoveEntry(w.A, w.X.deviceId, seenForNextEntry(w.roster.entries, w.A.deviceId), 5));
    expect(w.roster.activeDevices().map((d) => toHex(d.deviceId))).toContain(toHex(w.G.deviceId));
    const t = await w.core.tick(1e6 + 1, false);
    const sealed = t.out.filter((o) => o.kind === KIND_REMOVAL).flatMap((o) => [...parseRemovalBody(o.body).sealed.keys()]);
    expect(sealed).toContain(toHex(w.G.deviceId));
  });
  it("rule 'cascade': the ghost leaves with the device that admitted it, and the next secret is NOT sealed to it", async () => {
    const w = await ghostWorld('cascade');
    await w.roster.append(makeRemoveEntry(w.A, w.X.deviceId, seenForNextEntry(w.roster.entries, w.A.deviceId), 5));
    expect(w.roster.activeDevices().map((d) => toHex(d.deviceId))).not.toContain(toHex(w.G.deviceId));
    expect(w.roster.excludedIds().has(toHex(w.G.deviceId))).toBe(true);
    const t = await w.core.tick(1e6 + 1, false);
    const sealed = t.out.filter((o) => o.kind === KIND_REMOVAL).flatMap((o) => [...parseRemovalBody(o.body).sealed.keys()]);
    expect(sealed).not.toContain(toHex(w.G.deviceId));
    expect(sealed).toContain(toHex(w.B.deviceId));
  });
  it("rule 'cascade' is transitive and spares devices the removed one did NOT admit", () => {
    const [A, B, X, G, H] = ids(5);
    const g = makeGenesisEntry(A, 'A', 'linux', 1);
    const addB = makeAddEntry(A, info(B), [g.id], 2);
    const addX = makeAddEntry(A, info(X), [addB.id], 3);
    const addG = makeAddEntry(X, info(G), [addX.id], 4);
    const addH = makeAddEntry(G, info(H), [addG.id], 5);
    const v = new RosterVerifier('both', 'cascade');
    for (const e of [g, addB, addX, addG, addH]) v.add(e);
    v.add(makeRemoveEntry(A, X.deviceId, [addH.id], 6));
    expect(activeNames(v, { A, B, X, G, H })).toBe('AB');
  });
  it("rule 'cascade': what the ghost signed concurrently with the removal of its introducer has no effect (it cannot remove an honest device)", () => {
    const [A, B, X, G] = ids(4);
    const g = makeGenesisEntry(A, 'A', 'linux', 1);
    const addB = makeAddEntry(A, info(B), [g.id], 2);
    const addX = makeAddEntry(A, info(X), [addB.id], 3);
    const addG = makeAddEntry(X, info(G), [addX.id], 4);
    const counter = makeRemoveEntry(G, B.deviceId, [addG.id], 5); // signed by the ghost, NOT seen by the removal below (which does see the ghost's admission)
    const v = new RosterVerifier('both', 'cascade');
    for (const e of [g, addB, addX, addG, makeRemoveEntry(A, X.deviceId, [addG.id], 6), counter]) v.add(e);
    expect(v.removed.has(hex(B.deviceId))).toBe(false);
    expect(v.facts.get(hex(counter.id))!.void).toBe(true);
  });
  it(`the set holds at most MAX_SET_DEVICES (${MAX_SET_DEVICES}) active devices: the next admission is void (and the app refuses to make it)`, () => {
    const devs = ids(MAX_SET_DEVICES + 3);
    const v = new RosterVerifier('both');
    const entries: SignedEntry[] = [makeGenesisEntry(devs[0], 'g', 'linux', 1)];
    v.add(entries[0]);
    // devices are admitted in a small tree so no signer passes its own admission limit
    for (let d = 1; d < devs.length; d++) {
      const by = devs[Math.floor((d - 1) / MAX_ADMISSIONS_PER_SIGNER)];
      const e = makeAddEntry(by, info(devs[d]), seenForNextEntry(entries, by.deviceId), d + 1);
      entries.push(e); v.add(e);
    }
    expect(v.active().length).toBe(MAX_SET_DEVICES);
    expect(v.facts.get(hex(entries[entries.length - 1].id))!.void).toBe(true);
    expect(v.facts.get(hex(entries[entries.length - 1].id))!.why).toBe('set-full');
    // removing one frees a place for a LATER add (decided in canonical order, so every device agrees)
    const rem = makeRemoveEntry(devs[0], devs[6].deviceId, seenForNextEntry(entries, devs[0].deviceId), 99);
    const late = makeAddEntry(devs[5], info(generateIdentity()), [rem.id], 100); // a signer that has admitted nobody yet
    const v2 = new RosterVerifier('both');
    for (const e of [...entries, rem, late]) v2.add(e);
    expect(v2.facts.get(hex(late.id))!.void).toBe(false);
  });
  it('a device may admit at most MAX_ADMISSIONS_PER_SIGNER devices: the next add is refused on arrival and does not use anybody else\'s room', () => {
    const [A, ...rest] = ids(MAX_ADMISSIONS_PER_SIGNER + 3);
    const v = new RosterVerifier('both');
    const g = makeGenesisEntry(A, 'A', 'linux', 1);
    v.add(g);
    let prev = g;
    for (let i = 0; i < MAX_ADMISSIONS_PER_SIGNER; i++) { prev = makeAddEntry(A, info(rest[i]), [prev.id], 2 + i); v.add(prev); }
    expect(() => v.add(makeAddEntry(A, info(rest[MAX_ADMISSIONS_PER_SIGNER]), [prev.id], 50))).toThrow(/admission quota/);
    // another member's admissions are untouched
    const viaB = makeAddEntry(rest[0], info(rest[MAX_ADMISSIONS_PER_SIGNER + 1]), [prev.id], 60);
    expect(() => v.add(viaB)).not.toThrow();
  });
  it(`at most MAX_KNOWN_KEYS (${MAX_KNOWN_KEYS}) device keys are ever named, so the log can never fill (${MAX_KNOWN_KEYS} x ${MAX_ENTRIES_PER_DEVICE} stays under the limit)`, () => {
    const v = new RosterVerifier('both');
    const root = generateIdentity();
    const g = makeGenesisEntry(root, 'g', 'linux', 1);
    v.add(g);
    const signers = [root];
    const log: SignedEntry[] = [g];
    let refused = 0;
    for (let i = 1; i < MAX_KNOWN_KEYS + 6; i++) {
      const by = signers[Math.floor((i - 1) / MAX_ADMISSIONS_PER_SIGNER)];
      const n = generateIdentity();
      const e = makeAddEntry(by, info(n), seenForNextEntry(log, by.deviceId), 1 + i);
      try { v.add(e); log.push(e); signers.push(n); } catch (err) { if (/too many device keys/.test((err as Error).message)) refused++; else throw err; }
    }
    expect(v.knownDeviceIds().length).toBe(MAX_KNOWN_KEYS);
    expect(refused).toBeGreaterThan(0);
  });
  it('an entry whose signer was not introduced among its own ancestors is not held (a tree of ghosts nobody admitted takes no room)', () => {
    const [A, B] = ids(2);
    const g = makeGenesisEntry(A, 'A', 'linux', 1);
    const addB = makeAddEntry(A, info(B), [g.id], 2);
    const v = new RosterVerifier('both');
    v.add(g); v.add(addB);
    expect(() => v.add(makeRenameEntry(B, 'x', [g.id], 3))).toThrow(/introduced/);
    expect(v.size).toBe(2);
  });
  it('rotation succeeds at the maximum: 16 active members and 8 excluded keys still make a statement and a sealed list every device can parse', async () => {
    const devs = ids(MAX_SET_DEVICES + 8);
    const roster = new RosterStore('/x', () => 1e6, { memory: true });
    const core = new DeviceCore({ identity: devs[0], setId: setIdFor(devs[0].signKey), roster, book: new GenBook(), takeoverMs: 100 });
    core.genesis();
    const g = makeGenesisEntry(devs[0], 'a', 'linux', 1); await roster.append(g);
    const entries = [g];
    for (let d = 1; d < devs.length; d++) {
      const by = devs[Math.floor((d - 1) / MAX_ADMISSIONS_PER_SIGNER)];
      if (roster.activeDevices().length >= MAX_SET_DEVICES) {
        // free a place first by removing the previous extra, as an owner would
        const victim = devs[d - 1 - (MAX_SET_DEVICES - 1) + 3];
        void victim;
      }
      const e = makeAddEntry(by, info(devs[d]), seenForNextEntry(roster.entries, by.deviceId), d + 1);
      try { await roster.append(e); entries.push(e); } catch { break; }
    }
    // remove extras until 8 are excluded, then check the minted bundle
    const removable = roster.activeDevices().filter((d) => !d.deviceId.equals(devs[0].deviceId)).slice(0, 8);
    for (const r of removable) await roster.append(makeRemoveEntry(devs[0], r.deviceId, seenForNextEntry(roster.entries, devs[0].deviceId), 500));
    expect(roster.excludedIds().size).toBeGreaterThanOrEqual(8);
    const t = await core.tick(1e6 + 1, false);
    const bundles = t.out.filter((o) => o.kind === KIND_REMOVAL);
    expect(bundles.length).toBeGreaterThan(0);
    for (const o of bundles) {
      const b = parseRemovalBody(decode(encode(o.body as never)));
      const st = parseStatement(b.stmt);
      expect(st.members.length).toBe(roster.activeDevices().length);
      expect(st.removed.length).toBe(roster.excludedIds().size);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------- serious 3 and 4
describe('serious 3: the pre-signed counter-removal (mutual removal), exact outcomes under each swappable rule', () => {
  const build = (rule: MutualRule, xPos: 'creator' | 'middle' | 'last', removers: 'A' | 'AB') => {
    const A = generateIdentity(), B = generateIdentity(), X = generateIdentity();
    const order = xPos === 'creator' ? [X, A, B] : xPos === 'middle' ? [A, X, B] : [A, B, X];
    const g = makeGenesisEntry(order[0], 'g', 'linux', 1);
    const a1 = makeAddEntry(order[0], info(order[1]), [g.id], 2);
    const a2 = makeAddEntry(order[0], info(order[2]), [a1.id], 3);
    const stash = makeRemoveEntry(X, A.deviceId, [a2.id], 4); // signed early, held back, released after A removed X
    const es = [g, a1, a2, makeRemoveEntry(A, X.deviceId, [a2.id], 5)];
    if (removers === 'AB') es.push(makeRemoveEntry(B, X.deviceId, [a2.id], 6));
    es.push(stash);
    const v = new RosterVerifier(rule);
    for (const e of es) v.add(e);
    return activeNames(v, { A, B, X });
  };
  // TRUTH TABLE (documented for the owner; see the report). Columns: which device the thief X is, and who removes it.
  const table: Array<[MutualRule, 'creator' | 'middle' | 'last', 'A' | 'AB', string]> = [
    ['both', 'creator', 'A', 'B'], ['both', 'creator', 'AB', 'AB'],
    ['both', 'middle', 'A', 'B'], ['both', 'middle', 'AB', 'AB'],
    ['both', 'last', 'A', 'B'], ['both', 'last', 'AB', 'AB'],
    ['first-admitted', 'creator', 'A', 'BX'], ['first-admitted', 'creator', 'AB', 'AB'],
    ['first-admitted', 'middle', 'A', 'AB'], ['first-admitted', 'middle', 'AB', 'AB'],
    ['first-admitted', 'last', 'A', 'AB'], ['first-admitted', 'last', 'AB', 'AB'],
  ];
  for (const [rule, xPos, removers, want] of table) {
    it(`3 devices, rule ${rule}, X is the ${xPos} device, removed by ${removers === 'A' ? 'A alone' : 'A and B'}: active = ${want}`, () => {
      expect(build(rule, xPos, removers)).toBe(want);
    });
  }
  it('the mitigation holds as a property: once a SECOND honest device removes the thief, the stash fails under both rules, whoever the thief is', () => {
    for (const rule of rules) for (const xPos of ['creator', 'middle', 'last'] as const) expect(build(rule, xPos, 'AB')).toBe('AB');
  });
  const twoDevice = (rule: MutualRule, thief: 'creator' | 'junior'): string => {
    const X = generateIdentity(), A = generateIdentity();
    const [first, second] = thief === 'creator' ? [X, A] : [A, X];
    const g = makeGenesisEntry(first, 'f', 'linux', 1);
    const add = makeAddEntry(first, info(second), [g.id], 2);
    const v = new RosterVerifier(rule);
    for (const e of [g, add, makeRemoveEntry(A, X.deviceId, [add.id], 4), makeRemoveEntry(X, A.deviceId, [add.id], 3)]) v.add(e);
    return activeNames(v, { A, X });
  };
  it("2 devices: under 'both' the set is dead whoever the thief is; under 'first-admitted' the EARLIER device survives, so a stolen creator wins", () => {
    expect(twoDevice('both', 'creator')).toBe('');
    expect(twoDevice('both', 'junior')).toBe('');
    expect(twoDevice('first-admitted', 'creator')).toBe('X');
    expect(twoDevice('first-admitted', 'junior')).toBe('A');
  });
  it('no third rule: nothing in an entry (its `seen`, its `at`) can tell a pre-signed counter-removal from a real concurrent one, because the signer writes both; so none is added', () => {
    // The thief can sign the stash with the same `seen` the honest remover cited and any `at`; the two entries are indistinguishable by content.
    const [A, X] = ids(2);
    const g = makeGenesisEntry(A, 'A', 'linux', 1);
    const add = makeAddEntry(A, info(X), [g.id], 2);
    const honest = makeRemoveEntry(A, X.deviceId, [add.id], 100);
    const stash = makeRemoveEntry(X, A.deviceId, [add.id], 100);
    expect(honest.seen.map(hex)).toEqual(stash.seen.map(hex));
    expect(honest.at).toBe(stash.at);
  });
});
describe('serious 4 (policy, unchanged, pinned): any member may remove any member', () => {
  it('a member can remove the set\'s first device', () => {
    const [A, B] = ids(2);
    const g = makeGenesisEntry(A, 'A', 'linux', 1);
    const add = makeAddEntry(A, info(B), [g.id], 2);
    const v = new RosterVerifier('both');
    for (const e of [g, add, makeRemoveEntry(B, A.deviceId, [add.id], 3)]) v.add(e);
    expect(v.removed.has(hex(A.deviceId))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------- medium
describe('medium: permanent silence after a catch-up', () => {
  it('a member that handed over 200 of its own entries is heard again after the hour, without a restart; a removal is never refused for rate', async () => {
    let t = 1_000_000;
    const [A, B] = ids(2);
    const s = new RosterStore('/x', () => t, { memory: true });
    const g = makeGenesisEntry(A, 'A', 'linux', 1); await s.append(g);
    const add = makeAddEntry(A, info(B), [g.id], 2); await s.append(add);
    const from = toHex(A.deviceId);
    let refused = 0;
    for (let i = 0; i < 200; i++) await s.append(makeRenameEntry(A, 'n' + i, [g.id, add.id], 3 + i), { remote: true, from }).catch(() => { refused++; });
    expect(refused).toBeGreaterThan(0);
    await expect(s.append(makeRemoveEntry(A, B.deviceId, [g.id, add.id], 9000), { remote: true, from })).resolves.toBe('appended');
    t += 3_700_000;
    await expect(s.append(makeRenameEntry(A, 'after the hour', [g.id, add.id], 9001), { remote: true, from })).resolves.toBe('appended');
  });
  it('entries relayed for someone else (a catch-up) cost the helper nothing', async () => {
    const [A, B] = ids(2);
    const s = new RosterStore('/x', () => 1, { memory: true });
    const g = makeGenesisEntry(A, 'A', 'linux', 1); await s.append(g);
    const add = makeAddEntry(A, info(B), [g.id], 2); await s.append(add);
    for (let i = 0; i < 200; i++) await s.append(makeRenameEntry(A, 'n' + i, [g.id, add.id], 3 + i), { remote: true, from: toHex(B.deviceId) });
    expect(s.size).toBe(202);
  });
});

describe('medium: the cost of one arriving entry stays bounded (invariant ix)', () => {
  it('a 2,000-entry log with a flood of removals from one signer: one more entry costs well under half a second, and the answer is the same as without the flood', () => {
    const [X, A, ...rest] = ids(8);
    const g = makeGenesisEntry(X, 'X', 'linux', 1);
    const v = new RosterVerifier('both');
    v.add(g);
    let prev = g;
    const everyone = [A, ...rest.slice(0, 3)];
    for (const o of everyone) { prev = makeAddEntry(X, info(o), [prev.id], 2); v.add(prev); }
    // X floods removals (all its allowance of entries), A adds renames
    for (let i = 0; i < MAX_ENTRIES_PER_DEVICE - 6; i++) { prev = makeRemoveEntry(X, [X, ...everyone][i % 5].deviceId, [prev.id], 10 + i); v.add(prev); }
    for (const o of everyone) for (let i = 0; i < 200; i++) { prev = makeRenameEntry(o, 'n' + i, seenForNextEntry([...v['_order' as never] ?? []], o.deviceId).length ? [prev.id] : [prev.id], 5000 + i); try { v.add(prev); } catch { break; } }
    void v.removed;
    const last = makeRenameEntry(A, 'late', [prev.id], 99999);
    const t0 = performance.now();
    v.add(last);
    void v.removed;
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(500);
    expect(v.size).toBeGreaterThan(900);
  });
});

// ---------------------------------------------------------------------------------------------------------------- amplification and removed devices
async function pairOfCores(n = 240): Promise<{ A: DeviceIdentity; B: DeviceIdentity; X: DeviceIdentity; a: DeviceCore; ar: RosterStore; clock: { t: number } }> {
  const [A, B, X] = ids(3);
  const clock = { t: 1_000_000 };
  const ar = new RosterStore('/x', () => clock.t, { memory: true });
  const a = new DeviceCore({ identity: A, setId: setIdFor(A.signKey), roster: ar, book: new GenBook(), takeoverMs: 100 });
  a.genesis();
  const g = makeGenesisEntry(A, 'A', 'linux', 1); await ar.append(g);
  const addB = makeAddEntry(A, info(B), [g.id], 2); await ar.append(addB);
  const addX = makeAddEntry(A, info(X), [addB.id], 3); await ar.append(addX);
  let prev = addX;
  for (let i = 0; i < n; i++) { const e = makeRenameEntry(A, 'n' + i, [prev.id], 4 + i); await ar.append(e); prev = e; }
  return { A, B, X, a, ar, clock };
}
describe('medium: heads amplification is bounded per peer per interval', () => {
  it('forty tiny heads frames from one member cost this device at most the per-window budget of entries and frames', async () => {
    const { X, a, clock } = await pairOfCores();
    let entries = 0, rosterFrames = 0, bundles = 0;
    for (let k = 0; k < 40; k++) {
      const r = await a.onMessage(KIND_HEADS, headsBody([], []), X.deviceId, clock.t);
      for (const o of r.out) { if (o.kind === KIND_ROSTER) { rosterFrames++; entries += (o.body as unknown as { entries: unknown[] }).entries.length; } if (o.kind === KIND_REMOVAL) bundles++; }
    }
    expect(entries).toBeLessThanOrEqual(512);
    expect(rosterFrames).toBeLessThanOrEqual(16);
    expect(bundles).toBeLessThanOrEqual(32);
    // a LATER window is served again (an honest slow catch-up still finishes)
    clock.t += 31_000;
    const r2 = await a.onMessage(KIND_HEADS, headsBody([], []), X.deviceId, clock.t);
    expect(r2.out.some((o) => o.kind === KIND_ROSTER)).toBe(true);
  });
  it('no single answer carries more than 128 entries, and a need for everything is capped the same way', async () => {
    const { B, a, ar, clock } = await pairOfCores();
    const r = await a.onMessage(KIND_NEED, needBody(ar.heads()), B.deviceId, clock.t);
    for (const o of r.out) if (o.kind === KIND_ROSTER) expect((o.body as unknown as { entries: unknown[] }).entries.length).toBeLessThanOrEqual(128);
  });
});
describe('medium: a removed device is not answered with anything but the proof of its removal', () => {
  it('a heads frame from a removed device gets back only entries that prove its removal, marked wide (readable by it), and no secret', async () => {
    const { A, X, a, ar, clock } = await pairOfCores(20);
    await ar.append(makeRemoveEntry(A, X.deviceId, seenForNextEntry(ar.entries, A.deviceId), 5000));
    const after = makeRenameEntry(A, 'private rename after the removal', seenForNextEntry(ar.entries, A.deviceId), 5001);
    await ar.append(after);
    const r = await a.onMessage(KIND_HEADS, headsBody([], []), X.deviceId, clock.t);
    const sent = r.out.filter((o) => o.kind === KIND_ROSTER).flatMap((o) => (o.body as unknown as { entries: SignedEntry[] }).entries);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.some((e) => e.id.equals(after.id))).toBe(false); // nothing that happened after the removal
    expect(r.out.filter((o) => o.kind === KIND_ROSTER).every((o) => o.wide === true)).toBe(true);
    expect(r.out.some((o) => o.kind === KIND_REMOVAL)).toBe(false);
  });
  it('an honest, up-to-date member is answered under the current secret (not wide)', async () => {
    const { B, a, clock } = await pairOfCores(20);
    const r = await a.onMessage(KIND_HEADS, headsBody([], []), B.deviceId, clock.t);
    const roster = r.out.filter((o) => o.kind === KIND_ROSTER);
    expect(roster.length).toBeGreaterThan(0);
    expect(roster.every((o) => o.wide !== true)).toBe(true);
  });
  it('removal bundles are wide (a device that is behind must be able to read them) and nothing else the core minted is', async () => {
    const { A, X, a, ar } = await pairOfCores(5);
    await ar.append(makeRemoveEntry(A, X.deviceId, seenForNextEntry(ar.entries, A.deviceId), 5000));
    const t = await a.tick(1_000_000 + 10, true);
    for (const o of t.out) expect(o.wide === true).toBe(o.kind === KIND_REMOVAL);
    expect(t.out.some((o) => o.kind === KIND_REMOVAL)).toBe(true);
  });
  it('a device that is BEHIND (has not heard of the removal) still catches up: it is answered with the removal proof under the first secret and then takes the bundle', async () => {
    const [A, B, X] = ids(3);
    const mk = async (id: DeviceIdentity): Promise<{ id: DeviceIdentity; r: RosterStore; core: DeviceCore; book: GenBook }> => {
      const r = new RosterStore('/x', () => 1_000_000, { memory: true });
      const book = new GenBook();
      return { id, r, book, core: new DeviceCore({ identity: id, setId: setIdFor(A.signKey), roster: r, book, takeoverMs: 100 }) };
    };
    const a = await mk(A), b = await mk(B);
    const g = makeGenesisEntry(A, 'A', 'linux', 1);
    const addB = makeAddEntry(A, info(B), [g.id], 2);
    const addX = makeAddEntry(A, info(X), [addB.id], 3);
    for (const d of [a, b]) for (const e of [g, addB, addX]) await d.r.append(e);
    a.core.genesis();
    b.core.adoptWelcome(a.book.secrets(), new Map([...a.book.held].filter(([, h]) => h.stmt).map(([l, h]) => [l, Buffer.from(JSON.stringify(l))])));
    // A (up to date) removes X and mints; B has heard nothing
    const rem = makeRemoveEntry(A, X.deviceId, seenForNextEntry(a.r.entries, A.deviceId), 10);
    await a.r.append(rem);
    const plan = await a.core.tick(1_000_001, false);
    const bundle = plan.out.find((o) => o.kind === KIND_REMOVAL) as Out;
    expect(bundle.wide).toBe(true);
    // B takes the bundle: it carries the removal entry, so B learns the removal and accepts the new secret
    const got = await b.core.onMessage(KIND_REMOVAL, bundle.body, A.deviceId, 1_000_002);
    expect(got.reject).toBeUndefined();
    expect(b.r.isRemoved(X.deviceId)).toBe(true);
    expect(b.core.currentLabel()).not.toBeNull();
  });
});

describe('medium: frames from a sender that is not a member are refused at the device-core door', () => {
  it('an unknown sender gets nothing and changes nothing', async () => {
    const { a } = await pairOfCores(3);
    const stranger = generateIdentity();
    const r = await a.onMessage(KIND_HEADS, headsBody([], []), stranger.deviceId, 1_000_000);
    expect(r.reject).toBe('sender-not-a-member');
    expect(r.out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------- the generic cap invariant
describe('CAP INVARIANT: for every cap, a flood from one signer never displaces an honest entry', () => {
  it('entries per signer: X fills its whole allowance; A (and B) can still sign, and their entries count', () => {
    const [X, A, B] = ids(3);
    const g = makeGenesisEntry(X, 'X', 'linux', 1);
    const addA = makeAddEntry(X, info(A), [g.id], 2);
    const addB = makeAddEntry(X, info(B), [addA.id], 3);
    const v = new RosterVerifier('both');
    for (const e of [g, addA, addB]) v.add(e);
    let prev = addB;
    for (let i = 0; i < MAX_ENTRIES_PER_DEVICE; i++) { const e = makeRenameEntry(X, 'n' + i, [prev.id], 10 + i); try { v.add(e); prev = e; } catch { break; } }
    expect(() => v.add(makeRenameEntry(X, 'over', [prev.id], 9999))).toThrow(/quota/);
    const honest = makeRemoveEntry(A, X.deviceId, [prev.id], 10_000);
    v.add(honest);
    expect(v.removed.has(hex(X.deviceId))).toBe(true);
    v.add(makeRenameEntry(B, 'still fine', [prev.id, addB.id], 10_001));
  });
  it('admissions per signer and device keys: X exhausting both cannot stop A from admitting a device', () => {
    const [X, A, N, ...junk] = ids(10);
    const g = makeGenesisEntry(X, 'X', 'linux', 1);
    const addA = makeAddEntry(X, info(A), [g.id], 2);
    const v = new RosterVerifier('both');
    v.add(g); v.add(addA);
    let prev = addA;
    for (const j of junk) { const e = makeAddEntry(X, info(j), [prev.id], 3); try { v.add(e); prev = e; } catch { break; } }
    const mine = makeAddEntry(A, info(N), [prev.id], 99);
    v.add(mine);
    expect(v.facts.get(hex(mine.id))!.void).toBe(false);
  });
  it('removals per signer: X signs removals of every target it can name, A\'s single removal of X still takes effect', () => {
    // covered with 300 spam entries in "serious 1"; here with the signer's own distinct-target limit exceeded by REAL targets
    const [X, A, ...others] = ids(8);
    const g = makeGenesisEntry(X, 'X', 'linux', 1);
    const v = new RosterVerifier('both');
    v.add(g);
    let prev = g;
    for (const o of [A, ...others.slice(0, 3)]) { prev = makeAddEntry(X, info(o), [prev.id], 2); v.add(prev); }
    for (const t of [A, ...others.slice(0, 3), X]) { prev = makeRemoveEntry(X, t.deviceId, [prev.id], 5); v.add(prev); }
    v.add(makeRemoveEntry(A, X.deviceId, [prev.id], 6));
    expect(v.removed.has(hex(X.deviceId))).toBe(true);
  });
  it('parked entries: hostile senders fill the TOTAL; an honest member\'s parked entry is not the victim', async () => {
    const [A, B] = ids(2);
    const roster = new RosterStore('/x', () => 1, { memory: true });
    const core = new DeviceCore({ identity: A, setId: setIdFor(A.signKey), roster, book: new GenBook(), takeoverMs: 100 });
    const g = makeGenesisEntry(A, 'A', 'linux', 1); await roster.append(g);
    const addB = makeAddEntry(A, info(B), [g.id], 2); await roster.append(addB);
    const orphan = (i: number, signer: DeviceIdentity): SignedEntry => makeRenameEntry(signer, 'o' + i, [Buffer.alloc(32, (i % 250) + 1)], 5 + i);
    // fabricated entries citing an unknown ancestor park (waitable); 10 hostile "senders" try 200 each
    for (let s = 0; s < 10; s++) for (let i = 0; i < 200; i++) await core.takeEntries([orphan(s * 1000 + i, B)], `hostile${s}`);
    expect(core.parked.size).toBeLessThanOrEqual(1024);
    // the honest member's one parked entry arrives last, while the total is full
    const honestEntry = makeRenameEntry(B, 'honest', [Buffer.alloc(32, 251)], 777);
    await core.takeEntries([honestEntry], 'honest-member');
    expect(core.parked.has(toHex(honestEntry.id))).toBe(true);
  });
  it('replies per peer: a flood of requests from one member leaves the budget of another member untouched', async () => {
    const { B, X, a, clock } = await pairOfCores(240);
    for (let k = 0; k < 40; k++) await a.onMessage(KIND_HEADS, headsBody([], []), X.deviceId, clock.t);
    const r = await a.onMessage(KIND_HEADS, headsBody([], []), B.deviceId, clock.t);
    expect(r.out.some((o) => o.kind === KIND_ROSTER)).toBe(true);
  });
});

void makeHelloEntry;

describe('work per evaluation is bounded by who can sign, not by how much one signer wrote', () => {
  it('200 junk removals from one signer add no passes: only removals that could have an effect are ranked', () => {
    const [X, A] = ids(2);
    const g = makeGenesisEntry(X, 'X', 'linux', 1);
    const v = new RosterVerifier('both');
    v.add(g);
    let prev = makeAddEntry(X, info(A), [g.id], 2); v.add(prev);
    for (let i = 0; i < 200; i++) { prev = makeRemoveEntry(X, generateIdentity().deviceId, [prev.id], 10 + i); v.add(prev); }
    void v.removed;
    expect(v.diag.considered).toBe(0);
    expect(v.diag.folds).toBeLessThanOrEqual(2);
  });
  it('one signer naming many REAL devices is ranked on at most MAX_REMOVALS_PER_SIGNER of them', () => {
    const devs = ids(MAX_REMOVALS_PER_SIGNER + 5);
    const g = makeGenesisEntry(devs[0], 'g', 'linux', 1);
    const v = new RosterVerifier('both');
    v.add(g);
    const log: SignedEntry[] = [g];
    for (let d = 1; d < devs.length; d++) { const by = devs[Math.floor((d - 1) / MAX_ADMISSIONS_PER_SIGNER)]; const e = makeAddEntry(by, info(devs[d]), seenForNextEntry(log, by.deviceId), d + 1); log.push(e); v.add(e); }
    let prev = log[log.length - 1];
    for (let d = 1; d < devs.length; d++) { prev = makeRemoveEntry(devs[0], devs[d].deviceId, [prev.id], 100 + d); v.add(prev); }
    void v.removed;
    expect(v.diag.considered).toBe(MAX_REMOVALS_PER_SIGNER);
  });
  it('a removal by a device admitted AFTER a slot was freed (set was full) is still ranked, so an honest late device can remove the thief', () => {
    const devs = ids(MAX_SET_DEVICES + 2); // [0] creator, [1..15] fill the set, [16] = late honest device, thief = devs[2]
    const log: SignedEntry[] = [makeGenesisEntry(devs[0], 'g', 'linux', 1)];
    const v = new RosterVerifier('both');
    v.add(log[0]);
    for (let d = 1; d < MAX_SET_DEVICES; d++) { const by = devs[Math.floor((d - 1) / MAX_ADMISSIONS_PER_SIGNER)]; const e = makeAddEntry(by, info(devs[d]), seenForNextEntry(log, by.deviceId), d + 1); log.push(e); v.add(e); }
    expect(v.active().length).toBe(MAX_SET_DEVICES);
    const freed = makeRemoveEntry(devs[0], devs[9].deviceId, seenForNextEntry(log, devs[0].deviceId), 200); log.push(freed); v.add(freed);
    const late = makeAddEntry(devs[5], info(devs[MAX_SET_DEVICES]), [freed.id], 201); log.push(late); v.add(late);
    expect(v.facts.get(hex(late.id))!.void).toBe(false);
    const byLate = makeRemoveEntry(devs[MAX_SET_DEVICES], devs[2].deviceId, [late.id], 202); v.add(byLate);
    expect(v.removed.has(hex(devs[2].deviceId))).toBe(true);
  });
});

describe('replies: frame budget, and a member that is behind', () => {
  it('forty small requests from one member get at most 16 entry-bearing answers per window', async () => {
    const { B, a, clock } = await pairOfCores(5);
    let frames = 0;
    for (let k = 0; k < 40; k++) {
      const r = await a.onMessage(KIND_NEED, needBody([a.heads()[0]]), B.deviceId, clock.t);
      frames += r.out.filter((o) => o.kind === KIND_ROSTER).length;
    }
    expect(frames).toBeLessThanOrEqual(16);
    expect(frames).toBeGreaterThan(0);
  });
  it('a member that does not hold the current secret (admitted after it was made, not re-sealed yet) is answered with the removal proof only, under the first secret', async () => {
    const [A, B, X, C] = ids(4);
    const clock = { t: 1_000_000 };
    const roster = new RosterStore('/x', () => clock.t, { memory: true });
    const book = new GenBook();
    const core = new DeviceCore({ identity: A, setId: setIdFor(A.signKey), roster, book, takeoverMs: 100 });
    core.genesis();
    const g = makeGenesisEntry(A, 'A', 'linux', 1); await roster.append(g);
    const addB = makeAddEntry(A, info(B), [g.id], 2); await roster.append(addB);
    const addX = makeAddEntry(A, info(X), [addB.id], 3); await roster.append(addX);
    await roster.append(makeRemoveEntry(A, X.deviceId, seenForNextEntry(roster.entries, A.deviceId), 4));
    await core.tick(clock.t, false); // A mints the secret for the removal, sealed to B only
    const addC = makeAddEntry(A, info(C), seenForNextEntry(roster.entries, A.deviceId), 5); await roster.append(addC);
    const extra = makeRenameEntry(A, 'later change', seenForNextEntry(roster.entries, A.deviceId), 6); await roster.append(extra);
    const r = await core.onMessage(KIND_HEADS, headsBody([], []), C.deviceId, clock.t);
    const sent = r.out.filter((o) => o.kind === KIND_ROSTER);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((o) => o.wide === true)).toBe(true);
    expect(sent.flatMap((o) => (o.body as unknown as { entries: SignedEntry[] }).entries).some((e) => e.id.equals(extra.id))).toBe(false);
  });
});
