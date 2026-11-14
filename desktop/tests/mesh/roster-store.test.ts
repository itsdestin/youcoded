// The durable roster log: verified on load and on every append, survives a kill at any byte.
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../../src/main/mesh/crypto/identity';
import { makeAddEntry, makeGenesisEntry, makeRemoveEntry, makeRenameEntry, seenForNextEntry, type SignedEntry } from '../../src/main/mesh/crypto/roster';
import { RosterStore, MeshRosterCorrupt } from '../../src/main/mesh/roster-store';
import { tmp } from './helpers';

const A = generateIdentity();
const B = generateIdentity();
const C = generateIdentity();
const info = (d: typeof A, name: string) => ({ name, platform: 'linux', signKey: d.signKey, agreeKey: d.agreeKey });

/** genesis, add B, add C, a rename by B: a valid 4-entry log. */
function log(): SignedEntry[] {
  const g = makeGenesisEntry(A, 'Desktop', 'linux', 1);
  const addB = makeAddEntry(A, info(B, 'Phone'), [g.id], 2);
  const addC = makeAddEntry(A, info(C, 'Tablet'), seenForNextEntry([g, addB], A.deviceId), 3);
  const ren = makeRenameEntry(B, 'Phone 2', seenForNextEntry([g, addB, addC], B.deviceId), 4);
  return [g, addB, addC, ren];
}
async function fill(dir: string, entries: SignedEntry[]): Promise<RosterStore> {
  const s = new RosterStore(dir);
  await s.load();
  for (const e of entries) expect(await s.append(e)).toBe('appended');
  return s;
}
const idsOf = (s: RosterStore): string[] => s.entries.map((e) => e.id.toString('hex'));

describe('roster store', () => {
  it('load() on a fresh folder creates nothing', async () => {
    const d = tmp();
    const s = new RosterStore(path.join(d, 'mesh'));
    await s.load();
    expect(s.size).toBe(0);
    expect(fs.existsSync(path.join(d, 'mesh'))).toBe(false);
  });
  it('appended entries come back identical after a restart', async () => {
    const d = tmp();
    const entries = log();
    await fill(d, entries);
    const again = new RosterStore(d);
    await again.load();
    expect(idsOf(again)).toEqual(entries.map((e) => e.id.toString('hex')));
    expect(again.verified!.devices.size).toBe(3);
    expect(again.repairedTailBytes).toBe(0);
  });
  it('an entry that does not verify is refused and NOTHING is written', async () => {
    const d = tmp();
    const [g, addB] = log();
    const s = await fill(d, [g, addB]);
    const size = fs.statSync(s.file).size;
    const stranger = makeRenameEntry(generateIdentity(), 'Evil', [addB.id], 9); // signer not in the roster
    await expect(s.append(stranger)).rejects.toMatchObject({ code: 'bad-roster' });
    const forged = { ...log()[3], signature: Buffer.alloc(64, 1) } as SignedEntry; // right place, bad signature
    await expect(s.append(forged)).rejects.toBeTruthy();
    expect(fs.statSync(s.file).size).toBe(size);
    expect(s.size).toBe(2);
  });
  it('appending the same entry twice is a harmless duplicate', async () => {
    const d = tmp();
    const entries = log();
    const s = await fill(d, entries);
    const size = fs.statSync(s.file).size;
    expect(await s.append(entries[1])).toBe('duplicate');
    expect(fs.statSync(s.file).size).toBe(size);
  });
  it('append before load() is a programming error, not a silent write', async () => {
    const d = tmp();
    await expect(new RosterStore(d).append(log()[0])).rejects.toThrow(/load/);
  });
  it('a kill at EVERY byte of the last record leaves a log that loads clean, trims the tail, and accepts the next append', async () => {
    const entries = log();
    const d0 = tmp();
    await fill(d0, entries);
    const whole = fs.readFileSync(path.join(d0, 'roster.log'));
    const d1 = tmp();
    await fill(d1, entries.slice(0, 3));
    const lastStart = fs.statSync(path.join(d1, 'roster.log')).size;
    expect(whole.length).toBeGreaterThan(lastStart);
    for (let cut = lastStart; cut <= whole.length; cut++) {
      const d = tmp();
      fs.writeFileSync(path.join(d, 'roster.log'), whole.subarray(0, cut));
      const s = new RosterStore(d);
      await s.load();
      const complete = cut === whole.length;
      expect(s.size, `cut at ${cut}`).toBe(complete ? 4 : 3);
      expect(s.repairedTailBytes, `cut at ${cut}`).toBe(complete ? 0 : cut - lastStart);
      expect(fs.statSync(s.file).size, `cut at ${cut}`).toBe(complete ? whole.length : lastStart);
      if (!complete) {
        expect(await s.append(entries[3])).toBe('appended'); // the interrupted append can simply be redone
        const re = new RosterStore(d);
        await re.load();
        expect(re.size).toBe(4);
      }
    }
  });
  it('a torn tail that is garbage (file grew, bytes wrong) is trimmed too', async () => {
    const d = tmp();
    const entries = log();
    await fill(d, entries.slice(0, 3));
    const f = path.join(d, 'roster.log');
    const good = fs.readFileSync(f);
    const four = tmp();
    await fill(four, entries);
    const last = fs.readFileSync(path.join(four, 'roster.log')).subarray(good.length);
    fs.writeFileSync(f, Buffer.concat([good, last.subarray(0, last.length - 4), Buffer.from([1, 2, 3, 4])])); // right size, wrong check
    const s = new RosterStore(d);
    await s.load();
    expect(s.size).toBe(3);
    expect(s.repairedTailBytes).toBe(last.length);
  });
  it('damage in the MIDDLE is refused loudly, never silently shortened', async () => {
    const d = tmp();
    await fill(d, log());
    const f = path.join(d, 'roster.log');
    const b = fs.readFileSync(f);
    b[20] ^= 0xff;
    fs.writeFileSync(f, b);
    await expect(new RosterStore(d).load()).rejects.toBeInstanceOf(MeshRosterCorrupt);
    expect(fs.readFileSync(f).equals(b)).toBe(true); // untouched
  });
  it('a log whose records are intact but do not verify as a roster is refused', async () => {
    const entries = log();
    const whole = tmp();
    await fill(whole, entries);
    const bytes = fs.readFileSync(path.join(whole, 'roster.log'));
    const lens: number[] = [];
    for (let pos = 0; pos < bytes.length; pos += 8 + bytes.readUInt32BE(pos)) lens.push(8 + bytes.readUInt32BE(pos));
    // drop record 2 from the middle: entry 3 now cites an entry the log no longer has
    const d = tmp();
    const head = lens[0] + lens[1];
    fs.writeFileSync(path.join(d, 'roster.log'), Buffer.concat([bytes.subarray(0, head), bytes.subarray(head + lens[2])]));
    await expect(new RosterStore(d).load()).rejects.toMatchObject({ why: 'log-invalid' });
  });
  it('queued concurrent appends keep every record whole and in order', async () => {
    const d = tmp();
    const entries = log();
    const s = new RosterStore(d);
    await s.load();
    await Promise.all(entries.map((e) => s.append(e)));
    const re = new RosterStore(d);
    await re.load();
    expect(idsOf(re)).toEqual(entries.map((e) => e.id.toString('hex')));
  });
  it('the file is private (0600) and lives only under the folder it was given', async () => {
    const d = tmp();
    const s = await fill(path.join(d, 'mesh'), log().slice(0, 1));
    if (process.platform !== 'win32') expect(fs.statSync(s.file).mode & 0o777).toBe(0o600);
    expect(s.file.startsWith(d)).toBe(true);
  });
  it('removed devices are reported as removed and their frames have no signing key', async () => {
    const d = tmp();
    const [g, addB, addC] = log();
    const rem = makeRemoveEntry(A, B.deviceId, seenForNextEntry([g, addB, addC], A.deviceId), 5);
    const s = await fill(d, [g, addB, addC, rem]);
    expect(s.signKeyFor(B.deviceId)).toBeUndefined();
    expect(s.signKeyFor(C.deviceId)!.equals(C.signKey)).toBe(true);
    expect(s.activeDevices().map((x) => x.name).sort()).toEqual(['Desktop', 'Tablet']);
  });
});
