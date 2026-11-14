// END-TO-END PROOF of the device layer: real headless backends (jailed, decoy homes) talking through the REAL relay code
// (the Worker's MeshRelayRoom, run locally by `wrangler dev --local`, no network beyond localhost).
//
// Story: three devices boot with the mesh on; A makes the set; B and C pair to A with the typed code (the test is the pipe);
// all three hold the same verified roster; A sends sealed frames; C goes offline and catches up; A removes B, B is cut off and
// its later frames are refused; a device killed in the middle of appending restarts clean. Then: no key, code or frame body in
// any log or in what the relay stored, nothing written outside the decoy homes, and with the mesh OFF a profile is exactly
// what it was before this change.
//
// GATED: it compiles the backend and starts a relay (a few minutes), so `npm test` skips it with a message. Run it with
//   MESH_RIG=1 npx vitest run tests/mesh-rig
// Optional: MESH_RIG_BUILD=<dir> reuses an earlier build of this checkout (skips the compile).
import { createDecipheriv } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MeshKeyStore, insecureTestSealer, type MeshKeys, type SecretSealer } from '../../src/main/mesh/keystore';
import { RelayClient } from '../../src/main/mesh/relay-client';
import { RosterStore } from '../../src/main/mesh/roster-store';
import { DESKTOP, auditRows, buildBackend, decoyLeaks, findLeaks, inventory, killDevice, logFiles, pidsOf, planDevice, rigAvailable, sleep, startDevice, startRelay, stopDevice, type Device, type DeviceOptions, type Relay } from './rig';

const avail = rigAvailable();
const enabled = process.env.MESH_RIG === '1';
if (!enabled) console.warn('SKIPPED mesh rig test: set MESH_RIG=1 to run it (compiles the backend and starts a local relay; a few minutes).');
else if (!avail.ok) console.warn(`SKIPPED mesh rig test: ${avail.why}`);

const until = async (cond: () => Promise<boolean> | boolean, what: string, ms = 20_000): Promise<void> => {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};
const status = (d: Device) => d.control!.post<any>('/status');
const inbox = async (d: Device): Promise<string[]> => (await d.control!.post<any>('/inbox')).items.map((i: { text: string }) => i.text);

/** Decrypt what the headless shim's safeStorage wrote (iv 12 | tag 16 | data, AES-256-GCM): the rig made the key, so it may. */
const shimSealer = (keyHex: string): SecretSealer => ({
  kind: 'os-secret-store',
  seal: () => { throw new Error('read only'); },
  open: (b) => {
    const dec = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), b.subarray(0, 12));
    dec.setAuthTag(b.subarray(12, 28));
    return Buffer.from(Buffer.concat([dec.update(b.subarray(28)), dec.final()]).toString('utf8'), 'base64');
  },
});
const keysOf = async (d: Device, sealer: SecretSealer = insecureTestSealer({ testMode: true })): Promise<MeshKeys> => (await new MeshKeyStore(path.join(d.userData, 'mesh'), sealer).load()) as MeshKeys;

describe.skipIf(!enabled || !avail.ok)('mesh rig: three jailed backends and the real relay', () => {
  // WHY not at describe time: vitest still runs a skipped describe's body, and a skipped run must create nothing.
  let root = '';
  let buildDir = '';
  let relay: Relay;
  const devs: Record<string, Device> = {};
  const opts: Record<string, DeviceOptions> = {};
  const pipe: Buffer[] = []; // every pairing byte the "hostile pipe" (this test) carried
  const codes: string[] = [];
  const notes = ['rig-note-alpha-7f3a', 'rig-note-bravo-91c2', 'rig-note-charlie-5d08', 'rig-note-delta-ee14'];

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-rig-'));
    buildDir = process.env.MESH_RIG_BUILD || path.join(root, 'build');
    if (!process.env.MESH_RIG_BUILD) buildBackend(buildDir);
    relay = await startRelay(root);
    for (const n of ['A', 'B', 'C']) opts[n] = { mesh: true, relayUrl: relay.url, build: buildDir };
    opts.D = { mesh: true, keystore: 'os', relayUrl: relay.url, build: buildDir };
    for (const n of Object.keys(opts)) devs[n] = planDevice(root, n, opts[n]);
    await Promise.all(Object.keys(opts).map((n) => startDevice(devs[n], opts[n])));
  }, 420_000);

  afterAll(async () => {
    await Promise.all(Object.values(devs).map(stopDevice));
    await relay?.stop();
    // Throwaway folders (homes, relay state, build): removed unless you want to look inside (MESH_RIG_KEEP=1).
    if (root && process.env.MESH_RIG_KEEP !== '1') fs.rmSync(root, { recursive: true, force: true });
    else if (root) console.warn(`mesh rig folders kept at ${root}`);
  }, 60_000);

  async function pair(host: Device, joiner: Device): Promise<{ hostSas: string; joinerSas: string }> {
    const { room, code } = await host.control!.post<any>('/pair/open');
    codes.push(code);
    const first = (await joiner.control!.post<any>('/pair/join', { room, code })).first as string;
    let toHost = [first];
    let hostSas = '';
    let joinerSas = '';
    let done = false;
    const deliver = async (msgs: string[]): Promise<string[]> => {
      const back: string[] = [];
      for (const m of msgs) {
        pipe.push(Buffer.from(m, 'base64'));
        const r = await joiner.control!.post<any>('/pair/join-msg', { b64: m });
        joinerSas = r.sas ?? joinerSas;
        done = done || r.done;
        back.push(...r.out);
      }
      return back;
    };
    for (let i = 0; i < 30 && !done; i++) {
      const toJoiner: string[] = [];
      for (const m of toHost) { pipe.push(Buffer.from(m, 'base64')); toJoiner.push(...(await host.control!.post<any>('/pair/msg', { conn: 'c1', b64: m })).out); }
      toHost = await deliver(toJoiner);
      const p = (await host.control!.post<any>('/pair/prompt')).prompt;
      if (p && !hostSas) {
        hostSas = p.sas;
        // the person on the host screen compares the number, then says yes
        const welcome = (await host.control!.post<any>('/pair/decide', { conn: p.conn, approve: true })).out as string[];
        toHost.push(...(await deliver(welcome)));
      }
    }
    expect(done, 'pairing finished').toBe(true);
    return { hostSas, joinerSas };
  }

  it('boots A, B, C and D with the mesh on: each has its own key-derived identity, nobody is in a set, no relay yet', async () => {
    const ids = new Set<string>();
    for (const n of ['A', 'B', 'C', 'D']) {
      const s = await status(devs[n]);
      expect(s.inSet).toBe(false);
      expect(s.relay).toBe('none');
      ids.add(s.deviceId);
    }
    expect(ids.size).toBe(4);
    expect((await status(devs.A)).keystore).toBe('insecure-test-file');
    expect((await status(devs.D)).keystore).toBe('os-secret-store'); // the headless shim's safeStorage ("Android Keystore" stand-in) was accepted
  }, 60_000);

  it('A creates the set and connects to the real relay', async () => {
    await devs.A.control!.post('/create-set');
    await until(async () => (await status(devs.A)).relay === 'ready', 'A on the relay');
    expect((await status(devs.A)).inSet).toBe(true);
  }, 60_000);

  it('B and C pair to A with the typed code; the matching numbers agree; the pipe saw no code, name or secret', async () => {
    for (const n of ['B', 'C']) {
      const r = await pair(devs.A, devs[n]);
      expect(r.hostSas).toMatch(/^\d{6}$/);
      expect(r.joinerSas).toBe(r.hostSas);
      await until(async () => (await status(devs[n])).relay === 'ready', `${n} on the relay`);
    }
    const all = Buffer.concat(pipe);
    for (const c of codes) expect(findLeaks(all, [{ label: 'typed code', bytes: Buffer.from(c) }])).toEqual([]);
    for (const nm of ['rig-A', 'rig-B', 'rig-C']) expect(all.includes(Buffer.from(nm))).toBe(false); // names travel sealed
    expect(pipe.length).toBeGreaterThan(8);
  }, 120_000);

  it('all three hold the same verified roster (and each log verifies from disk)', async () => {
    await until(async () => (await Promise.all(['A', 'B', 'C'].map((n) => status(devs[n])))).every((s) => s.rosterCount === 3), 'roster of 3 everywhere');
    const [a, b, c] = await Promise.all(['A', 'B', 'C'].map((n) => status(devs[n])));
    expect(b.rosterIds).toEqual(a.rosterIds);
    expect(c.rosterIds).toEqual(a.rosterIds);
    expect([...b.activeDevices].sort()).toEqual([...a.activeDevices].sort());
    expect(a.activeDevices.length).toBe(3);
    for (const n of ['A', 'B', 'C']) {
      const re = new RosterStore(path.join(devs[n].userData, 'mesh'));
      await re.load(); // verifyRosterLog over the whole file, written by the device itself
      expect(re.size).toBe(3);
      expect(re.verified!.devices.size).toBe(3);
    }
  }, 60_000);

  it('a sealed frame from A is received and verified by B and C', async () => {
    await devs.A.control!.post('/send', { text: notes[0] });
    await until(async () => (await inbox(devs.B)).length === 1 && (await inbox(devs.C)).length === 1, 'note on B and C');
    expect(await inbox(devs.B)).toEqual([notes[0]]);
    expect((await devs.B.control!.post<any>('/inbox')).items[0].from).toBe((await status(devs.A)).deviceId);
  }, 60_000);

  it('C goes offline; A sends two more; C comes back and catches up in order, once each', async () => {
    await devs.C.control!.post('/offline', { offline: true });
    await until(async () => (await status(devs.C)).relay === 'stopped', 'C offline');
    await devs.A.control!.post('/send', { text: notes[1] });
    await devs.A.control!.post('/send', { text: notes[2] });
    await until(async () => (await inbox(devs.B)).length === 3, 'B has three');
    expect(await inbox(devs.C)).toEqual([notes[0]]);
    await devs.C.control!.post('/offline', { offline: false });
    await until(async () => (await inbox(devs.C)).length === 3, 'C caught up');
    expect(await inbox(devs.C)).toEqual([notes[0], notes[1], notes[2]]);
    // settle: nothing more may arrive (no frame delivered twice)
    await sleep(500);
    expect(await inbox(devs.C)).toHaveLength(3);
  }, 90_000);

  it('A removes B: B\'s connection is closed, its frames are refused, A and C carry on under generation 2', async () => {
    const bId = (await status(devs.B)).deviceId;
    const bKeys = await keysOf(devs.B); // read BEFORE it is cut off, to prove the refusal below from the relay itself
    await devs.A.control!.post('/remove', { device: bId });
    await until(async () => (await status(devs.B)).relay === 'removed', 'B told it was removed');
    await until(async () => { const c = await status(devs.C); return c.removedDevices.includes(bId) && c.generations.includes(2); }, 'C knows of the removal and holds generation 2');
    await expect(devs.B.control!.post('/send', { text: 'from the removed device' })).rejects.toThrow();
    await devs.A.control!.post('/send', { text: notes[3] });
    await until(async () => (await inbox(devs.C)).includes(notes[3]), 'C gets the post-removal note');
    expect(await inbox(devs.B)).not.toContain(notes[3]);
    expect((await status(devs.B)).generations).toEqual([1]);
    // the relay itself: B's key can no longer sign in, and anything it tries to hold is refused
    const probe = new RelayClient({ url: relay.url, setId: bKeys.setId as Buffer, identity: bKeys.identity, baseDelayMs: 50 });
    probe.start();
    await until(() => probe.state === 'removed', 'relay refuses B at sign-in');
    await expect(probe.hold({ group: 'note.test', session: '00'.repeat(16), n: 1, frame: Buffer.from('forged') })).rejects.toThrow();
    probe.stop();
    expect(await inbox(devs.A)).not.toContain('from the removed device');
    expect(await inbox(devs.C)).not.toContain('from the removed device');
  }, 90_000);

  it('a backend killed in the middle of appending restarts clean (D, whose keys are sealed by the shim)', async () => {
    const d = devs.D;
    await d.control!.post('/create-set');
    const long = d.control!.post('/stress-append', { n: 5000 }).catch(() => 'killed');
    let seen = 0;
    await until(async () => { seen = (await status(d)).rosterCount; return seen >= 60; }, 'some appends acknowledged');
    await killDevice(d);
    expect(await long).toBe('killed');
    const onDiskAtKill = new RosterStore(path.join(d.userData, 'mesh'));
    await onDiskAtKill.load(); // the file a power cut left behind, loaded exactly as the next start would
    expect(onDiskAtKill.size).toBeGreaterThanOrEqual(seen);
    expect(onDiskAtKill.size).toBeLessThan(5001); // the kill really did interrupt it
    await startDevice(d, opts.D);
    const s = await status(d);
    expect(s.inSet).toBe(true);
    expect(s.rosterCount).toBe(onDiskAtKill.size);
    expect(s.rosterCount).toBeGreaterThanOrEqual(seen);
    await d.control!.post('/stress-append', { n: 5 });
    expect((await status(d)).rosterCount).toBe(s.rosterCount + 5);
    const reread = new RosterStore(path.join(d.userData, 'mesh'));
    await reread.load();
    expect(reread.size).toBe(s.rosterCount + 5);
    expect(reread.repairedTailBytes).toBe(0);
    // the identity survived the kill (same key-derived id) and the sealed key file still opens
    expect((await keysOf(d, shimSealer(d.key))).identity.deviceId.toString('hex')).toBe(s.deviceId);
  }, 120_000);

  it('no key, code or frame body appears in any process log, in the relay log, or in what the relay stored', async () => {
    const needles: Array<{ label: string; bytes: Buffer }> = [];
    for (const n of ['A', 'B', 'C']) {
      const k = await keysOf(devs[n]);
      needles.push({ label: `${n} signing seed`, bytes: k.identity.signSeed }, { label: `${n} agreement secret`, bytes: k.identity.agreeSecret });
      for (const [g, s] of k.secrets) needles.push({ label: `${n} set secret g${g}`, bytes: s });
    }
    const dk = await keysOf(devs.D, shimSealer(devs.D.key));
    needles.push({ label: 'D signing seed', bytes: dk.identity.signSeed }, { label: 'D agreement secret', bytes: dk.identity.agreeSecret });
    for (const c of codes) needles.push({ label: 'typed pairing code', bytes: Buffer.from(c) });
    for (const t of [...notes, 'from the removed device']) needles.push({ label: `frame body ${t}`, bytes: Buffer.from(t) });
    for (const d of Object.values(devs)) needles.push({ label: `${d.name} owner token`, bytes: Buffer.from(d.token) }, { label: `${d.name} secrets key`, bytes: Buffer.from(d.key, 'hex') }, { label: `${d.name} control token`, bytes: Buffer.from(d.meshToken) });
    // positive control: the detector must fire on a planted canary, or "found nothing" means nothing
    expect(findLeaks(Buffer.from(`prefix ${notes[0]} suffix`), needles)).toContain(`frame body ${notes[0]}`);

    const hay: Array<{ where: string; bytes: Buffer }> = [];
    for (const d of Object.values(devs)) {
      hay.push({ where: `${d.name} stdout/stderr log`, bytes: fs.readFileSync(d.log) });
      for (const f of logFiles(d.home)) hay.push({ where: `${d.name} ${f.file}`, bytes: Buffer.from(f.text) });
    }
    hay.push({ where: 'relay log', bytes: fs.readFileSync(relay.log) });
    for (const f of inventory(relay.stateDir)) hay.push({ where: `relay state ${f}`, bytes: fs.readFileSync(path.join(relay.stateDir, f)) });
    expect(hay.some((h) => h.where.startsWith('relay state'))).toBe(true); // the relay really stored something to scan
    const hits: string[] = [];
    for (const h of hay) for (const l of findLeaks(h.bytes, needles)) hits.push(`${l} in ${h.where}`);
    // what the relay stored is only sealed frames: the sealed pairing/roster/note bytes contain none of the above
    expect(hits).toEqual([]);
    expect(hay.reduce((n, h) => n + h.bytes.length, 0)).toBeGreaterThan(1000);
  }, 60_000);

  it('nothing was written outside the decoy homes: every decoy "real home" is empty and no real-home path was touched', async () => {
    for (const d of Object.values(devs)) {
      expect(decoyLeaks(d), `${d.name} decoy`).toEqual([]);
      expect(auditRows(d), `${d.name} fs audit`).toEqual([]);
    }
    // each device's own files are where they should be
    // A only ever sent, so it never had anything to save a receive position for; B and C received frames, so they did.
    expect(inventory(path.join(devs.A.userData, 'mesh'))).toEqual(['keys.bin', 'roster.log']);
    for (const n of ['B', 'C']) expect(inventory(path.join(devs[n].userData, 'mesh'))).toEqual(['keys.bin', 'link-state.bin', 'roster.log']);
  }, 30_000);

  it('with the mesh OFF a profile gets exactly the files it got before this change (same set as the pre-change build, when it is available)', async () => {
    const baseline = path.resolve(DESKTOP, '..', '..', 'docs', 'active', 'prototypes', '2026-11-14-mesh-phase0', 'T1', 'build');
    const offOpts: DeviceOptions = { mesh: false, build: buildDir };
    const now = planDevice(root, 'E', offOpts);
    const before = planDevice(root, 'F', { mesh: false, build: baseline });
    before.id = now.id; // the registry file is named by the device id: same id on both so the two profiles can be compared by name
    await startDevice(now, offOpts);
    await sleep(6000);
    await stopDevice(now);
    const mine = inventory(now.home);
    expect(mine.filter((f) => /mesh/i.test(f)), 'no mesh file in a mesh-off profile').toEqual([]);
    expect(decoyLeaks(now)).toEqual([]);
    if (!fs.existsSync(path.join(baseline, 'dist/main/headless/headless-main.js'))) {
      console.warn(`mesh-off comparison: pre-change build not found at ${baseline}; only the "no mesh file" half was checked`);
      return;
    }
    const baseOpts: DeviceOptions = { mesh: false, build: baseline };
    await startDevice(before, baseOpts);
    await sleep(6000);
    await stopDevice(before);
    // Same set of files, byte for byte by name. (Both profiles hold a rig-written device-id.json and nothing else of ours.)
    expect(mine).toEqual(inventory(before.home));
  }, 120_000);

  it('everything is stopped at the end: no backend or relay process left, no listener left open', async () => {
    await Promise.all(Object.values(devs).map(stopDevice));
    await relay.stop();
    for (const d of Object.values(devs)) expect(pidsOf(d), `${d.name} pids`).toEqual([]);
    const res = await fetch(`http://127.0.0.1:${relay.port}/`).then(() => 'open', () => 'closed');
    expect(res).toBe('closed');
  }, 60_000);
});


