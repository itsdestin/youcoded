// Key storage: refuses without a real OS secret store, never plaintext in production, never creates anything on a refusal.
import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { MeshKeyStore, MeshKeyStoreRefused, insecureTestSealer, safeStorageSealer } from '../../src/main/mesh/keystore';
import { fakeSafeStorage, listFiles, tmp } from './helpers';

const codeOf = (f: () => unknown): string => {
  try { f(); return 'no-throw'; } catch (e) { return e instanceof MeshKeyStoreRefused ? e.code : 'WRONG-ERROR'; }
};

describe('safeStorage-backed sealer REFUSES when the OS keeps no real secret', () => {
  it('refuses the Linux plaintext and unknown backends', () => {
    expect(codeOf(() => safeStorageSealer(fakeSafeStorage('basic_text'), 'linux'))).toBe('no-secret-store');
    expect(codeOf(() => safeStorageSealer(fakeSafeStorage('unknown'), 'linux'))).toBe('no-secret-store');
  });
  it('refuses when Linux cannot say which backend it uses (treated as unknown)', () => {
    expect(codeOf(() => safeStorageSealer(fakeSafeStorage(undefined), 'linux'))).toBe('no-secret-store');
  });
  it('refuses when encryption is not available at all', () => {
    expect(codeOf(() => safeStorageSealer(fakeSafeStorage('gnome_libsecret', false), 'linux'))).toBe('unavailable');
  });
  it('accepts a real Linux keyring, macOS/Windows (which report no backend), and the Android Keystore stand-in', () => {
    for (const b of ['gnome_libsecret', 'kwallet5', 'kwallet6', 'android_keystore']) expect(safeStorageSealer(fakeSafeStorage(b), 'linux').kind).toBe('os-secret-store');
    expect(safeStorageSealer(fakeSafeStorage(undefined), 'darwin').kind).toBe('os-secret-store');
    expect(safeStorageSealer(fakeSafeStorage(undefined), 'win32').kind).toBe('os-secret-store');
  });
  it('a refusal creates no file or folder', async () => {
    const d = tmp();
    try { safeStorageSealer(fakeSafeStorage('basic_text'), 'linux'); } catch { /* expected */ }
    expect(listFiles(d)).toEqual([]);
  });
});

describe('the insecure test sealer', () => {
  it('refuses outside test mode', () => {
    expect(codeOf(() => insecureTestSealer({ testMode: false }))).toBe('not-test-mode');
  });
  it('is named insecure', () => {
    expect(insecureTestSealer({ testMode: true }).kind).toBe('insecure-test-file');
  });
});

describe('MeshKeyStore', () => {
  const os = () => safeStorageSealer(fakeSafeStorage('gnome_libsecret'), 'linux');
  it('load() on a fresh folder returns null and creates nothing', async () => {
    const d = tmp();
    expect(await new MeshKeyStore(path.join(d, 'mesh'), os()).load()).toBeNull();
    expect(listFiles(d)).toEqual([]);
  });
  it('creates the identity on first enable, keeps it across restarts, file is 0600', async () => {
    const d = tmp();
    const a = await new MeshKeyStore(d, os()).loadOrCreate();
    const b = await new MeshKeyStore(d, os()).loadOrCreate();
    expect(b.identity.deviceId.equals(a.identity.deviceId)).toBe(true);
    expect(listFiles(d)).toEqual(['keys.bin']);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(d, 'keys.bin')).mode & 0o777).toBe(0o600);
  });
  it('secrets, set id and the save counter survive a restart', async () => {
    const d = tmp();
    const s = new MeshKeyStore(d, os());
    await s.loadOrCreate();
    await s.update((k) => { k.setId = Buffer.alloc(32, 3); k.secrets.set(1, Buffer.alloc(32, 7)); k.secrets.set(2, Buffer.alloc(32, 8)); k.receiverSaves = 5; });
    const k = (await new MeshKeyStore(d, os()).load())!;
    expect([...k.secrets.keys()]).toEqual([1, 2]);
    expect(k.secrets.get(2)!.equals(Buffer.alloc(32, 8))).toBe(true);
    expect(k.setId!.equals(Buffer.alloc(32, 3))).toBe(true);
    expect(k.receiverSaves).toBe(5);
  });
  it('the OS-sealed file does not contain the private seed in the clear; the insecure test file does (that is its name)', async () => {
    const d1 = tmp();
    const k1 = await new MeshKeyStore(d1, os()).loadOrCreate();
    expect(fs.readFileSync(path.join(d1, 'keys.bin')).includes(k1.identity.signSeed)).toBe(false);
    const d2 = tmp();
    const k2 = await new MeshKeyStore(d2, insecureTestSealer({ testMode: true })).loadOrCreate();
    expect(fs.readFileSync(path.join(d2, 'keys.bin')).includes(k2.identity.signSeed)).toBe(true);
  });
  it('a file written by the insecure sealer is refused by the real one (never silently read as if secure)', async () => {
    const d = tmp();
    await new MeshKeyStore(d, insecureTestSealer({ testMode: true })).loadOrCreate();
    await expect(new MeshKeyStore(d, os()).load()).rejects.toMatchObject({ code: 'wrong-kind' });
  });
  it('garbage or a truncated file is refused as corrupt, never half-read', async () => {
    const d = tmp();
    await new MeshKeyStore(d, os()).loadOrCreate();
    const full = fs.readFileSync(path.join(d, 'keys.bin'));
    for (const bad of [Buffer.from('nonsense'), full.subarray(0, 10), full.subarray(0, full.length - 3)]) {
      fs.writeFileSync(path.join(d, 'keys.bin'), bad);
      await expect(new MeshKeyStore(d, os()).load()).rejects.toMatchObject({ code: 'corrupt' });
    }
  });
  it('concurrent updates are applied one after another, none lost', async () => {
    const d = tmp();
    const s = new MeshKeyStore(d, os());
    await s.loadOrCreate();
    await Promise.all([1, 2, 3, 4, 5].map((g) => s.update((k) => { k.secrets.set(g, Buffer.alloc(32, g)); })));
    expect([...(await new MeshKeyStore(d, os()).load())!.secrets.keys()].sort()).toEqual([1, 2, 3, 4, 5]);
  });
  it('writes nothing to any console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const d = tmp();
    const s = new MeshKeyStore(d, os());
    const k = await s.loadOrCreate();
    await s.update((x) => { x.secrets.set(1, Buffer.alloc(32, 1)); });
    for (const sp of spies) { expect(sp).not.toHaveBeenCalled(); sp.mockRestore(); }
    expect(String(k.identity)).not.toContain(k.identity.signSeed.toString('hex'));
  });
});
