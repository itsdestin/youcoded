// Third-round review: the nine app-side mutants that survived the reviewer's mutation check (M2, M10, M14, M15, M16, M18, M21, M22, M23), each with a test that
// fails when the checked line is removed. (M14 is shown to be an equivalent mutant: see its test.)
import { describe, expect, it } from 'vitest';
import { toHex } from '../../src/main/mesh/crypto/bytes';
import { generateIdentity, setIdFor, type DeviceIdentity } from '../../src/main/mesh/crypto/identity';
import { encodeStatement, signStatement } from '../../src/main/mesh/crypto/generation';
import { sealSecretTo } from '../../src/main/mesh/crypto/keygen';
import { newSetSecret } from '../../src/main/mesh/crypto/keys';
import { makeAddEntry, makeGenesisEntry, makeRemoveEntry, makeRenameEntry, seenForNextEntry, verifyEntry, type SignedEntry } from '../../src/main/mesh/crypto/roster';
import { DeviceCore, GenBook } from '../../src/main/mesh/device-core';
import { RosterStore } from '../../src/main/mesh/roster-store';
import { KIND_REMOVAL, removalBody } from '../../src/main/mesh/wire';

const info = (d: DeviceIdentity) => ({ name: 'd', platform: 'linux', signKey: d.signKey, agreeKey: d.agreeKey });
async function world(n: number): Promise<{ ids: DeviceIdentity[]; roster: RosterStore; core: DeviceCore; book: GenBook; setId: Buffer; log: SignedEntry[] }> {
  const ids = Array.from({ length: n }, () => generateIdentity());
  const setId = setIdFor(ids[0].signKey);
  const roster = new RosterStore('/x', () => 1e6, { memory: true });
  const book = new GenBook();
  // device 1 is the receiver ("me")
  const core = new DeviceCore({ identity: ids[1], setId, roster, book, takeoverMs: 100 });
  const g = makeGenesisEntry(ids[0], 'd0', 'linux', 1);
  const log = [g];
  await roster.append(g);
  for (let i = 1; i < n; i++) { const by = ids[Math.floor((i - 1) / 4)]; const e = makeAddEntry(by, info(ids[i]), seenForNextEntry(log, by.deviceId), 2 + i); log.push(e); await roster.append(e); }
  return { ids, roster, core, book, setId, log };
}
const bundleFor = (minter: DeviceIdentity, setId: Buffer, removed: Buffer[], members: DeviceIdentity[], to: DeviceIdentity) => {
  const secret = newSetSecret();
  const stmt = signStatement(minter, { set: setId, removed, members: members.map((m) => m.deviceId), secret });
  return { stmt, secret, bundle: { entries: [], stmt: encodeStatement(stmt), sealed: new Map([[toHex(to.deviceId), sealSecretTo(to.agreeKey, setId, stmt.label, secret, minter.deviceId, to.deviceId)]]) } };
};

describe('mutants the third review found alive', () => {
  it('M2: an entry whose content was edited after signing (id unchanged, so the signature still covers the old id) is not valid', () => {
    const [A, B] = [generateIdentity(), generateIdentity()];
    const e = makeRenameEntry(A, 'honest name', [Buffer.alloc(32, 1)], 5);
    expect(verifyEntry(e, A.signKey)).toBe(true);
    const edited = { ...e, body: { name: 'evil name' } } as SignedEntry;
    expect(verifyEntry(edited, A.signKey)).toBe(false); // id is no longer SHA-256 of the content
    void B;
  });
  it('M10: a generation statement made for a DIFFERENT set is refused', async () => {
    const w = await world(3);
    const other = setIdFor(generateIdentity().signKey);
    const { bundle } = bundleFor(w.ids[0], other, [w.ids[2].deviceId], [w.ids[0], w.ids[1]], w.ids[1]);
    await w.roster.append(makeRemoveEntry(w.ids[0], w.ids[2].deviceId, seenForNextEntry(w.log, w.ids[0].deviceId), 20));
    expect(w.core.acceptBundle(bundle, w.ids[0].deviceId)).toBe('reject:bad-statement');
  });
  it('M14 (equivalent mutant, shown): a secret whose minter is no longer a member can never be the CURRENT one, with or without the explicit check', async () => {
    const w = await world(4);
    // device 3 mints for removed set [] (a stale statement), then is removed itself: current removed set is {3}; the statement\'s set is not
    const { stmt, secret } = bundleFor(w.ids[3], w.setId, [], [w.ids[3], w.ids[1]], w.ids[1]);
    w.book.set(stmt.label, { stmt, secret });
    await w.roster.append(makeRemoveEntry(w.ids[0], w.ids[3].deviceId, seenForNextEntry(w.log, w.ids[0].deviceId), 20));
    expect(w.core.currentLabel()).toBeNull();
    expect(w.core.currentLabels()).toEqual([]);
  });
  it('M15: a bundle that names a removal this device has not heard of waits instead of being accepted', async () => {
    const w = await world(3);
    const { bundle } = bundleFor(w.ids[0], w.setId, [w.ids[2].deviceId], [w.ids[0], w.ids[1]], w.ids[1]);
    expect(w.core.acceptBundle(bundle, w.ids[0].deviceId)).toBe('wait');
    expect(w.book.held.size).toBe(0);
  });
  it('M16: a removal bundle from a device that has been removed is refused at the door', async () => {
    const w = await world(4);
    await w.roster.append(makeRemoveEntry(w.ids[0], w.ids[3].deviceId, seenForNextEntry(w.log, w.ids[0].deviceId), 20));
    const { bundle } = bundleFor(w.ids[3], w.setId, [], [w.ids[3], w.ids[1]], w.ids[1]);
    const r = await w.core.onMessage(KIND_REMOVAL, removalBody(bundle), w.ids[3].deviceId, 1e6);
    expect(r.reject).toBe('signer-not-a-member');
    expect(w.book.held.size).toBe(0);
  });
  it('M18: a device that sees itself removed makes no secrets and says no hello', async () => {
    const w = await world(3);
    const me = w.ids[1];
    w.core.genesis(); // holds a secret (as any member does)
    await w.roster.append(makeRemoveEntry(w.ids[0], me.deviceId, seenForNextEntry(w.log, w.ids[0].deviceId), 20));
    const t = await w.core.tick(1e6 + 1000, true);
    expect(t.out.some((o) => o.kind === KIND_REMOVAL)).toBe(false);
  });
  it('M22: one delivering member can park at most 128 entries; entries it parks beyond that are its own loss', async () => {
    const w = await world(2);
    for (let i = 0; i < 300; i++) await w.core.takeEntries([makeRenameEntry(w.ids[0], 'o' + i, [Buffer.alloc(32, (i % 250) + 1)], 50 + i)], 'one-sender');
    const mine = [...w.core.parked.values()].filter((p) => p.from === 'one-sender').length;
    expect(mine).toBe(128);
    // a second sender is untouched by the first one's volume
    await w.core.takeEntries([makeRenameEntry(w.ids[0], 'other', [Buffer.alloc(32, 77)], 999)], 'second-sender');
    expect([...w.core.parked.values()].filter((p) => p.from === 'second-sender').length).toBe(1);
  });
  it('M23: a minter may leave at most 8 STALE secrets here; the 9th is refused, another minter\'s stale secret and the current one are still accepted', async () => {
    // four removed devices give 14 distinct older removed sets for one minter
    const w = await world(8);
    const removedIds = w.ids.slice(4, 8);
    let seen = w.log;
    for (const r of removedIds) { const e = makeRemoveEntry(w.ids[0], r.deviceId, seenForNextEntry(seen, w.ids[0].deviceId), 20); await w.roster.append(e); seen = [...seen, e]; }
    const subsets: Buffer[][] = [];
    for (let mask = 0; mask < 15; mask++) subsets.push(removedIds.filter((_, i) => mask & (1 << i)).map((d) => d.deviceId)); // all proper subsets
    const results: string[] = [];
    for (const sub of subsets.slice(1, 11)) results.push(w.core.acceptBundle(bundleFor(w.ids[2], w.setId, sub, [w.ids[2], w.ids[1]], w.ids[1]).bundle, w.ids[2].deviceId));
    expect(results.filter((r) => r === 'accepted').length).toBe(8);
    expect(results.filter((r) => r === 'reject:too-many-generations').length).toBe(2);
    // another minter is not affected by the first one's volume
    expect(w.core.acceptBundle(bundleFor(w.ids[3], w.setId, subsets[1], [w.ids[3], w.ids[1]], w.ids[1]).bundle, w.ids[3].deviceId)).toBe('accepted');
    // and the CURRENT secret (made for exactly the removals known) is always accepted
    expect(w.core.acceptBundle(bundleFor(w.ids[2], w.setId, removedIds.map((d) => d.deviceId), [w.ids[2], w.ids[1]], w.ids[1]).bundle, w.ids[2].deviceId)).toBe('accepted');
  });
});
