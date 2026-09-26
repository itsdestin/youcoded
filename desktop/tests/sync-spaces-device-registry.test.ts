// desktop/tests/sync-spaces-device-registry.test.ts
// Covers the Personal/Devices friendly-name registry (Plan 2b Task 4, spec §10a):
// round-trip, heartbeat that must not clobber a synced rename, fold-on-read of a
// cross-device conflict copy, and fail-soft skipping of malformed files.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  readDevices, upsertSelf, renameDevice, removeDevice,
  mergeDeviceEntries, foldDeviceEntries, DEVICE_REGISTRY_SCHEMA, type DeviceRecord,
} from '../src/main/sync-spaces/device-registry';

let personal: string;
beforeEach(() => { personal = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-dreg-')); });
afterEach(() => { fs.rmSync(personal, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

const dir = () => path.join(personal, 'Devices');
const write = (file: string, obj: unknown) => {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(path.join(dir(), file), JSON.stringify(obj));
};
// Device ids are UUIDs; the fixture id below stands in for one (it just has to
// be a stable string that can never contain the " (from " conflict-copy marker).
const E = (over: Partial<DeviceRecord>): DeviceRecord => ({
  schemaVersion: DEVICE_REGISTRY_SCHEMA, id: 'dev-1', name: 'Laptop',
  platform: 'win32', lastSeen: 1, updatedAt: 1, ...over,
});

describe('device registry store — I/O', () => {
  it('round-trips a device record through upsertSelf + readDevices', async () => {
    await upsertSelf(personal, { id: 'dev-1', name: 'My Laptop', platform: 'win32' });
    expect(fs.existsSync(path.join(dir(), 'dev-1.json'))).toBe(true);
    const got = readDevices(personal);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: 'dev-1', name: 'My Laptop', platform: 'win32' });
    expect(got[0].lastSeen).toBeGreaterThan(0);
    expect(got[0].updatedAt).toBeGreaterThan(0);
  });

  it('upsertSelf defaults the friendly name to os.hostname() when none is given', async () => {
    await upsertSelf(personal, { id: 'dev-2', platform: 'darwin' });
    expect(readDevices(personal)[0].name).toBe(os.hostname());
  });

  it('returns [] when the Devices dir does not exist', () => {
    expect(readDevices(personal)).toEqual([]);
  });

  it('upsertSelf heartbeat bumps lastSeen but does NOT clobber a newer synced name', async () => {
    // Another device renamed us and that edit synced here with a high updatedAt.
    write('dev-1.json', E({ name: 'Renamed On Phone', lastSeen: 10, updatedAt: 9_999_999_999_999 }));
    await upsertSelf(personal, { id: 'dev-1', platform: 'win32' }); // bare heartbeat, no name
    const got = readDevices(personal)[0];
    expect(got.name).toBe('Renamed On Phone');      // name preserved
    expect(got.lastSeen).toBeGreaterThan(10);       // liveness advanced
    expect(got.updatedAt).toBe(9_999_999_999_999);  // updatedAt NOT churned
  });

  it('upsertSelf with a differing name bumps updatedAt and changes the name', async () => {
    write('dev-1.json', E({ name: 'Old', updatedAt: 5 }));
    await upsertSelf(personal, { id: 'dev-1', name: 'New', platform: 'win32' });
    const got = readDevices(personal)[0];
    expect(got.name).toBe('New');
    expect(got.updatedAt).toBeGreaterThan(5);
  });

  it('renameDevice sets name + bumps updatedAt, preserving lastSeen/platform', async () => {
    write('dev-1.json', E({ name: 'Old', platform: 'linux', lastSeen: 42, updatedAt: 5 }));
    await renameDevice(personal, 'dev-1', 'Fresh');
    const got = readDevices(personal)[0];
    expect(got.name).toBe('Fresh');
    expect(got.platform).toBe('linux'); // preserved
    expect(got.lastSeen).toBe(42);      // preserved
    expect(got.updatedAt).toBeGreaterThan(5);
  });

  it('renameDevice to the identical name is a no-op (no mtime churn)', async () => {
    write('dev-1.json', E({ name: 'Same', updatedAt: 5 }));
    const file = path.join(dir(), 'dev-1.json');
    const m1 = fs.statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 15));
    await renameDevice(personal, 'dev-1', 'Same');
    expect(fs.statSync(file).mtimeMs).toBe(m1); // skipped
  });

  it('folds a conflict copy on read — newer name wins AND lastSeen is the max', () => {
    // Canonical: older name, higher lastSeen. Conflict copy (a cross-device
    // rename the transport left as a copy): newer name, lower lastSeen.
    write('dev-1.json', E({ name: 'Old Name', lastSeen: 100, updatedAt: 10 }));
    write('dev-1 (from OtherDevice, 2026-07-14).json', E({ name: 'New Name', lastSeen: 50, updatedAt: 20 }));
    const got = readDevices(personal);
    expect(got).toHaveLength(1);        // folded into one record
    expect(got[0].name).toBe('New Name'); // updatedAt 20 wins (LWW)
    expect(got[0].lastSeen).toBe(100);    // max across both copies
  });

  it('skips corrupt / unknown-schema files without throwing', () => {
    write('dev-1.json', E({ name: 'Good' }));
    fs.writeFileSync(path.join(dir(), 'bad.json'), '{ not json');
    write('future.json', { schemaVersion: 999, id: 'future', name: 'x', platform: 'p', lastSeen: 1, updatedAt: 1 });
    expect(readDevices(personal).map((e) => e.id).sort()).toEqual(['dev-1']);
  });

  it('skips a file whose name does not match its content id (filename↔id guard)', () => {
    // File is named dev-1.json but its parsed content id is dev-2 — a mangled /
    // mislabeled file that must NOT fold into either device.
    write('dev-1.json', E({ id: 'dev-2', name: 'Mislabeled' }));
    expect(readDevices(personal)).toEqual([]);
  });

  it('renameDevice to an empty name is refused — stored name unchanged', async () => {
    write('dev-1.json', E({ name: 'Keep Me', updatedAt: 5 }));
    await renameDevice(personal, 'dev-1', '   '); // whitespace-only → refused
    const got = readDevices(personal)[0];
    expect(got.name).toBe('Keep Me'); // empty names are rejected on read, so we never write one
  });
});

describe('device registry store — pure merge', () => {
  it('mergeDeviceEntries is commutative (name LWW by updatedAt, lastSeen = max)', () => {
    const a = E({ name: 'A', lastSeen: 100, updatedAt: 3 });
    const b = E({ name: 'B', lastSeen: 50, updatedAt: 9 });
    const ab = mergeDeviceEntries(a, b);
    const ba = mergeDeviceEntries(b, a);
    expect(ab).toEqual(ba);          // convergent
    expect(ab.name).toBe('B');       // updatedAt 9 wins
    expect(ab.lastSeen).toBe(100);   // max
    expect(ab.updatedAt).toBe(9);    // max
  });

  it('mergeDeviceEntries is commutative through the equal-updatedAt content tiebreak', () => {
    // Same updatedAt, different name/platform: laterOf falls back to the JSON
    // content comparison, which must pick the SAME winner regardless of arg order.
    const a = E({ name: 'Alpha', platform: 'linux', updatedAt: 7 });
    const b = E({ name: 'Beta', platform: 'darwin', updatedAt: 7 });
    const ab = mergeDeviceEntries(a, b);
    const ba = mergeDeviceEntries(b, a);
    expect(ab).toEqual(ba);                 // deterministic tiebreak → convergent
    expect(['Alpha', 'Beta']).toContain(ab.name);
    // platform rides with the name-winner, so the winning pair stays consistent.
    expect(ab.platform).toBe(ab.name === 'Alpha' ? 'linux' : 'darwin');
  });

  it('foldDeviceEntries is associative / order-independent across 3 copies', () => {
    // Equal updatedAt forces the content tiebreak for name; lastSeen is a plain
    // max. Any permutation of the same three copies must fold identically.
    const a = E({ name: 'A', platform: 'win32', lastSeen: 10, updatedAt: 7 });
    const b = E({ name: 'B', platform: 'linux', lastSeen: 30, updatedAt: 7 });
    const c = E({ name: 'C', platform: 'darwin', lastSeen: 20, updatedAt: 7 });
    const abc = foldDeviceEntries([a, b, c]);
    const cba = foldDeviceEntries([c, b, a]);
    const bca = foldDeviceEntries([b, c, a]);
    expect(abc).toEqual(cba);
    expect(abc).toEqual(bca);
    expect(abc.lastSeen).toBe(30); // max across all three
  });
});

describe('device registry store — removal', () => {
  it('removeDevice deletes the canonical record and drops it from readDevices', async () => {
    await upsertSelf(personal, { id: 'dev-1', name: 'Old Laptop', platform: 'win32' });
    await upsertSelf(personal, { id: 'dev-2', name: 'Desktop', platform: 'linux' });
    await removeDevice(personal, 'dev-1');
    expect(fs.existsSync(path.join(dir(), 'dev-1.json'))).toBe(false);
    expect(readDevices(personal).map(d => d.id)).toEqual(['dev-2']);
  });

  it('removeDevice also deletes conflict copies — a surviving copy resurrects the row', async () => {
    // readDevices folds `<id> (from X).json` into the group keyed by the record's
    // own id, and that grouping does NOT require the canonical file to exist. So
    // deleting only the canonical would leave the device still listed.
    write('dev-1.json', E({ id: 'dev-1' }));
    write('dev-1 (from Phone).json', E({ id: 'dev-1', name: 'Renamed On Phone' }));
    await removeDevice(personal, 'dev-1');
    expect(fs.readdirSync(dir())).toEqual([]);
    expect(readDevices(personal)).toEqual([]);
  });

  it('removeDevice leaves OTHER devices and their conflict copies untouched', async () => {
    write('dev-1.json', E({ id: 'dev-1' }));
    write('dev-2.json', E({ id: 'dev-2', name: 'Keep Me' }));
    write('dev-2 (from Phone).json', E({ id: 'dev-2', name: 'Keep Me Too' }));
    await removeDevice(personal, 'dev-1');
    expect(readDevices(personal).map(d => d.id)).toEqual(['dev-2']);
    expect(fs.existsSync(path.join(dir(), 'dev-2 (from Phone).json'))).toBe(true);
  });

  it('removeDevice on an unknown id is a silent no-op (never throws)', async () => {
    await upsertSelf(personal, { id: 'dev-1', name: 'Laptop', platform: 'win32' });
    await expect(removeDevice(personal, 'nope')).resolves.toBeUndefined();
    expect(readDevices(personal)).toHaveLength(1);
  });

  it('removeDevice with a missing Devices dir is a silent no-op (never throws)', async () => {
    await expect(removeDevice(personal, 'dev-1')).resolves.toBeUndefined();
  });

  it('removeDevice refuses an empty id rather than globbing the whole dir', async () => {
    await upsertSelf(personal, { id: 'dev-1', name: 'Laptop', platform: 'win32' });
    await expect(removeDevice(personal, '')).rejects.toThrow();
    expect(readDevices(personal)).toHaveLength(1);
  });

  it('removeDevice matches conflict copies whose device name contains parens/commas', async () => {
    // Real engine copies are `<base> (from <device>, <date>).json`, and a device
    // name can itself contain parens/commas — CONFLICT_RE's greedy `.+` is what
    // pins the base to `dev-1.json` here. Deleting dev-1 must take its copy but
    // leave dev-2's identically-shaped copy alone.
    write('dev-1.json', E({ id: 'dev-1' }));
    write("dev-1 (from Destin's PC (Home), 2026-07-03).json", E({ id: 'dev-1', name: 'Renamed' }));
    write('dev-2.json', E({ id: 'dev-2', name: 'Keep Me' }));
    write("dev-2 (from Destin's PC (Home), 2026-07-03).json", E({ id: 'dev-2', name: 'Keep Me Too' }));
    await removeDevice(personal, 'dev-1');
    expect(readDevices(personal).map(d => d.id)).toEqual(['dev-2']);
    expect(fs.existsSync(path.join(dir(), "dev-1 (from Destin's PC (Home), 2026-07-03).json"))).toBe(false);
    expect(fs.existsSync(path.join(dir(), "dev-2 (from Destin's PC (Home), 2026-07-03).json"))).toBe(true);
  });
});

describe('removeDevice when a file will not delete', () => {
  it('retries once, then reports failure instead of claiming the device is gone', async () => {
    const personal = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-devreg-rm-'));
    try {
      const dir = path.join(personal, 'Devices');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'dev-9.json'), '{}');
      fs.writeFileSync(path.join(dir, 'dev-9 (from X, 2026-09-20).json'), '{}');
      const rm = fs.promises.rm;
      let calls = 0;
      const spy = vi.spyOn(fs.promises, 'rm').mockImplementation(async (p, o) => {
        if (String(p).includes('(from X')) { calls++; throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); }
        return rm(p, o);
      });
      await expect(removeDevice(personal, 'dev-9')).rejects.toThrow(/could not remove 1 file/);
      expect(calls).toBe(2);
      spy.mockRestore();
      await removeDevice(personal, 'dev-9'); // once the lock clears, pressing Remove again finishes it
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally { fs.rmSync(personal, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
});
