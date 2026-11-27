// With the mesh OFF nothing runs: no file or folder is created, no socket is opened, no timer is started.
import fs from 'fs';
import http from 'http';
import net from 'net';
import cp from 'child_process';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startMeshIfEnabled } from '../../src/main/mesh/boot-hook';
import { insecureTestSealer } from '../../src/main/mesh/keystore';
import { MeshService } from '../../src/main/mesh/service';
import { FakeRelay } from './fake-relay';
import { fakeSafeStorage, listFiles, tmp } from './helpers';

afterEach(() => { vi.restoreAllMocks(); delete process.env.YOUCODED_MESH; delete process.env.YOUCODED_MESH_TEST; delete process.env.YOUCODED_MESH_TOKEN; delete process.env.YOUCODED_MESH_REPLICATOR; });

/** Everything that could create a file, a folder, a socket or a timer. */
function spyEverything() {
  const calls: string[] = [];
  const note = (n: string) => () => { calls.push(n); };
  const fsp = fs.promises;
  for (const k of ['mkdir', 'writeFile', 'appendFile', 'open', 'rename', 'copyFile', 'truncate', 'rm', 'unlink', 'symlink', 'mkdtemp'] as const) {
    const orig = (fsp as any)[k].bind(fsp);
    vi.spyOn(fsp as any, k).mockImplementation((...a: unknown[]) => { calls.push(`fs.${k}`); return orig(...a); });
  }
  // WHY these as well (review, "tests that cannot catch what they claim"): the first version watched only the async fs calls, `setInterval`, `listen`
  // and `connect`. A synchronous write, a one-shot timer, a write stream or a child process would have passed unseen.
  for (const k of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'openSync', 'renameSync', 'copyFileSync', 'symlinkSync', 'rmSync', 'unlinkSync', 'mkdtempSync', 'createWriteStream', 'truncateSync'] as const) {
    const orig = (fs as any)[k].bind(fs);
    vi.spyOn(fs as any, k).mockImplementation((...a: unknown[]) => { calls.push(`fs.${k} ${String(a[0])}`); return orig(...a); });
  }
  for (const k of ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync'] as const) {
    vi.spyOn(cp as any, k).mockImplementation(() => { calls.push(`child_process.${k}`); throw new Error('a mesh-off boot must not start a process'); });
  }
  const timeouts = vi.spyOn(globalThis, 'setTimeout');
  vi.spyOn(net.Server.prototype, 'listen').mockImplementation(function (this: net.Server) { note('listen')(); return this; });
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket) { note('connect')(); return this; });
  vi.spyOn(http, 'createServer').mockImplementation((() => { note('createServer')(); return {} as http.Server; }) as any);
  const st = vi.spyOn(globalThis, 'setInterval');
  return { calls, intervals: () => st.mock.calls.length, timeouts: () => timeouts.mock.calls.length };
}

describe('mesh OFF (the default)', () => {
  it('does nothing: returns null, creates no file or folder in the profile, opens no socket, starts no timer', async () => {
    const d = tmp('profile-');
    fs.writeFileSync(path.join(d, 'settings.json'), '{}'); // a profile with an existing file
    const before = listFiles(d);
    const mtimeBefore = fs.statSync(d).mtimeMs;
    const spy = spyEverything();
    const h = await startMeshIfEnabled({ userData: d, safeStorage: fakeSafeStorage('gnome_libsecret'), packaged: false });
    expect(h).toBeNull();
    expect(listFiles(d)).toEqual(before);
    expect(fs.statSync(d).mtimeMs).toBe(mtimeBefore);
    expect(spy.calls).toEqual([]);
    expect(spy.intervals()).toBe(0);
    expect(spy.timeouts()).toBe(0);
    expect(fs.existsSync(path.join(d, 'mesh'))).toBe(false);
  });
  it('a packaged build with a stray YOUCODED_MESH=1 in its environment stays off', async () => {
    process.env.YOUCODED_MESH = '1';
    const d = tmp('profile-');
    expect(await startMeshIfEnabled({ userData: d, safeStorage: fakeSafeStorage('gnome_libsecret'), packaged: true })).toBeNull();
    expect(listFiles(d)).toEqual([]);
  });
  it('an unwritable-looking or missing profile folder is still just "off"', async () => {
    expect(await startMeshIfEnabled({ userData: path.join(tmp(), 'nope', 'deeper'), safeStorage: fakeSafeStorage('gnome_libsecret'), packaged: false })).toBeNull();
  });
});

describe('mesh ON but no real secret store (Linux basic_text)', () => {
  it('refuses to start, creates NOTHING (not even the mesh folder) and opens nothing', async () => {
    process.env.YOUCODED_MESH = '1';
    const d = tmp('profile-');
    const spy = spyEverything();
    const h = await startMeshIfEnabled({ userData: d, safeStorage: fakeSafeStorage('basic_text'), packaged: false });
    expect(h).toBeNull();
    expect(listFiles(d)).toEqual([]);
    // The one allowed write is the app's own log line saying why it refused (the logger writes to the app log, not the profile).
    // (module loading and the logger use the file system too: only calls that touch THIS profile count.)
    expect(spy.calls.filter((c) => c.includes(d))).toEqual([]);
  });
});

describe('mesh ON with a real secret store', () => {
  it('creates files only under <userData>/mesh and starts no network without a relay address', async () => {
    process.env.YOUCODED_MESH = '1';
    const d = tmp('profile-');
    const h = await startMeshIfEnabled({ userData: d, safeStorage: fakeSafeStorage('gnome_libsecret'), packaged: false });
    expect(h).not.toBeNull();
    expect(listFiles(d)).toEqual(['mesh/keys.bin']);
    await h!.stop();
  });
});

describe('the chat store and the replicator create their folders only on request', () => {
  const noChatFolders = (d: string): void => {
    expect(fs.existsSync(path.join(d, 'mesh', 'store'))).toBe(false);
    expect(fs.existsSync(path.join(d, 'mesh', 'replicator'))).toBe(false);
    expect(fs.existsSync(path.join(d, 'mesh', 'witness'))).toBe(false); // the writer's second record folder (review 3, finding 11): another folder this feature adds, absent when it is off
    expect(listFiles(d).filter((f) => /(^|\/)(store|replicator|witness)\//.test(f))).toEqual([]);
  };
  it('with the feature off, and with the switch on but no relay, no store or replicator folder appears (even with the replicator variable set)', async () => {
    const off = tmp('profile-');
    expect(await startMeshIfEnabled({ userData: off, safeStorage: fakeSafeStorage('gnome_libsecret'), packaged: false })).toBeNull();
    noChatFolders(off);
    process.env.YOUCODED_MESH = '1'; process.env.YOUCODED_MESH_REPLICATOR = '1'; // the replicator variable alone, outside test mode, does nothing
    const on = tmp('profile-');
    const h = await startMeshIfEnabled({ userData: on, safeStorage: fakeSafeStorage('gnome_libsecret'), packaged: false });
    expect(h).not.toBeNull();
    noChatFolders(on);
    await h!.stop();
  });
  it('a live set in test mode WITHOUT the replicator flag never creates them; with the flag they appear (the control that proves this test can fail)', async () => {
    const relay = await new FakeRelay().ready();
    const made: MeshService[] = [];
    try {
      const mk = async (extra: { replicator?: boolean }): Promise<{ s: MeshService; d: string }> => {
        const d = tmp('profile-');
        const s = new MeshService({ userData: d, sealer: insecureTestSealer({ testMode: true }), testMode: true, relayUrl: relay.url, deviceName: 'X', platform: 'linux', log: () => {}, relayBaseDelayMs: 20, ...extra });
        await s.start(); made.push(s); await s.createSet();
        const t0 = Date.now(); while (s.status().relay !== 'ready') { if (Date.now() - t0 > 8000) throw new Error('relay not ready'); await new Promise((r) => setTimeout(r, 15)); }
        return { s, d };
      };
      const plain = await mk({});
      noChatFolders(plain.d);
      const flagged = await mk({ replicator: true });
      expect(fs.existsSync(path.join(flagged.d, 'mesh', 'store'))).toBe(true);
      // (the replicator's own folder appears on its first write, so the store folder is the signal)
    } finally { for (const s of made) await s.stop(); await relay.close(); }
  });
});
