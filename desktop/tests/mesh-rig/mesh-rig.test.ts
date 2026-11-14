// END-TO-END PROOF of the device layer: real headless backends (jailed, decoy homes) talking through the REAL relay code
// (the Worker's MeshRelayRoom, run locally by `wrangler dev --local`, no network beyond localhost).
//
// Story: three devices boot with the mesh on; A makes the set; B and C pair to A with the typed code THROUGH THE RELAY's meeting point;
// all three hold the same verified roster; A sends sealed frames; C goes offline and catches up; A removes B, B is cut off and
// its later frames are refused; a device killed in the middle of appending restarts clean. Then: no key, code or frame body in
// any log or in what the relay stored, nothing written outside the decoy homes, and with the mesh OFF a profile is exactly
// what it was before this change.
//
// GATED: it compiles the backend and starts a relay (a few minutes), so `npm test` skips it with a message. Run it with
//   MESH_RIG=1 npx vitest run tests/mesh-rig
// Optional: MESH_RIG_BUILD=<dir> reuses an earlier build of this checkout (skips the compile).
import { createDecipheriv, randomBytes } from 'crypto';
import WebSocket from 'ws';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MeshKeyStore, insecureTestSealer, type MeshKeys, type SecretSealer } from '../../src/main/mesh/keystore';
import { RelayClient } from '../../src/main/mesh/relay-client';
import { RosterStore } from '../../src/main/mesh/roster-store';
import { signRosterStatement } from '../../src/main/mesh/crypto/relay-auth';
import { seenForNextEntry } from '../../src/main/mesh/crypto/roster';
import { DESKTOP, auditRows, buildBackend, decoyLeaks, findLeaks, inventory, killDevice, logFiles, pidsOf, planDevice, rigAvailable, runAttacker, sleep, startDevice, startRelay, stopDevice, type Device, type DeviceOptions, type Relay } from './rig';

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
  const codes: string[] = [];
  const meetings: string[] = [];
  const notes = ['rig-note-alpha-7f3a', 'rig-note-bravo-91c2', 'rig-note-charlie-5d08', 'rig-note-delta-ee14'];

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-rig-'));
    buildDir = process.env.MESH_RIG_BUILD || path.join(root, 'build');
    if (!process.env.MESH_RIG_BUILD) buildBackend(buildDir);
    relay = await startRelay(root);
    for (const n of ['A', 'B', 'C']) opts[n] = { mesh: true, relayUrl: relay.url, build: buildDir };
    opts.D = { mesh: true, keystore: 'os', relayUrl: relay.url, build: buildDir };
    // The review-fix story (below) uses its own devices: P hosts every pairing and has shortened timers.
    opts.P = { mesh: true, relayUrl: relay.url, build: buildDir, extraEnv: { YOUCODED_MESH_PAIR_CONFIRM_MS: '8000', YOUCODED_MESH_REMOVE_WAIT_MS: '2500', YOUCODED_MESH_RELAY_RETRY_MS: '300' } };
    for (const n of ['Q', 'R', 'T', 'U', 'W']) opts[n] = { mesh: true, relayUrl: relay.url, build: buildDir };
    opts.V = { mesh: true, relayUrl: relay.url, build: buildDir };
    // Shrunk generation and heads timers for every device (the service's own defaults are 15 s and 30 s).
    for (const n of Object.keys(opts)) opts[n].extraEnv = { YOUCODED_MESH_GEN_TAKEOVER_MS: '300', YOUCODED_MESH_HEADS_MS: '3000', ...opts[n].extraEnv };
    for (const n of Object.keys(opts)) devs[n] = planDevice(root, n, opts[n]);
    // The review-fix devices (P, Q, R, T, U, V, W) are started by the tests that need them, so the first story runs on four processes as before.
    await Promise.all(['A', 'B', 'C', 'D'].map((n) => startDevice(devs[n], opts[n])));
  }, 420_000);

  afterAll(async () => {
    await Promise.all(Object.values(devs).map(stopDevice));
    await relay?.stop();
    // Throwaway folders (homes, relay state, build): removed unless you want to look inside (MESH_RIG_KEEP=1).
    if (root && process.env.MESH_RIG_KEEP !== '1') fs.rmSync(root, { recursive: true, force: true });
    else if (root) console.warn(`mesh rig folders kept at ${root}`);
  }, 60_000);

  /** Pair through the relay's meeting point: the host shows a typed code, the joiner types it, both screens show a number, the host says yes. */
  async function pair(host: Device, joiner: Device): Promise<{ hostSas: string; joinerSas: string; code: string; meeting: string }> {
    const { code, meeting } = await host.control!.post<any>('/pair/open-relay');
    codes.push(code, code.replace(/-/g, ''));
    await joiner.control!.post('/pair/join-relay', { code });
    let hostSas = '';
    await until(async () => { const p = (await host.control!.post<any>('/pair/prompt')).prompt; if (p) { hostSas = p.sas; return true; } return false; }, 'the host prompt');
    await until(async () => !!(await joiner.control!.post<any>('/pair/join-status')).sas, 'the joiner number');
    const joinerSas = (await joiner.control!.post<any>('/pair/join-status')).sas as string;
    // the person on the host screen compares the number, then says yes
    const p = (await host.control!.post<any>('/pair/prompt')).prompt;
    await host.control!.post('/pair/decide', { conn: p.conn, approve: true });
    await until(async () => (await joiner.control!.post<any>('/pair/join-status')).done === true, 'the joiner to finish');
    return { hostSas, joinerSas, code, meeting };
  }
  /** True when a plain socket to the meeting is answered 404 (nothing opened under that id, or it was erased). */
  const isDead = (m: string): Promise<boolean> => new Promise((resolve) => {
    const ws = new WebSocket(`${relay.url}/mesh/meet/${m}?v=1`);
    ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode === 404); ws.terminate(); });
    ws.on('open', () => { resolve(false); ws.terminate(); });
    ws.on('error', () => resolve(false));
  });

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

  it('B and C pair to A THROUGH THE RELAY with only the typed code; the matching numbers agree; the meetings are erased once they served', async () => {
    for (const n of ['B', 'C']) {
      const r = await pair(devs.A, devs[n]);
      expect(r.hostSas).toMatch(/^\d{6}$/);
      expect(r.joinerSas).toBe(r.hostSas);
      expect(r.code.replace(/-/g, '')).toHaveLength(19);
      meetings.push(r.meeting);
      await until(async () => (await status(devs[n])).relay === 'ready', `${n} on the relay`);
    }
    for (const m of meetings) await until(() => isDead(m), `meeting ${m.slice(0, 8)} erased`, 10_000);
  }, 120_000);

  it('all three hold the same verified roster (and each log verifies from disk)', async () => {
    await until(async () => (await Promise.all(['A', 'B', 'C'].map((n) => status(devs[n])))).every((s) => s.rosterCount >= 3), 'roster of 3 everywhere');
    const [a, b, c] = await Promise.all(['A', 'B', 'C'].map((n) => status(devs[n])));
    expect([...b.rosterIds].sort()).toEqual([...a.rosterIds].sort());
    expect([...c.rosterIds].sort()).toEqual([...a.rosterIds].sort());
    expect([...b.activeDevices].sort()).toEqual([...a.activeDevices].sort());
    expect(a.activeDevices.length).toBe(3);
    for (const n of ['A', 'B', 'C']) {
      const re = new RosterStore(path.join(devs[n].userData, 'mesh'));
      await re.load(); // verifyRosterLog over the whole file, written by the device itself
      expect(re.size).toBeGreaterThanOrEqual(3); // three devices, and the first entry each joiner signs of its own
      expect(re.verified!.devices.size).toBe(3);
    }
  }, 60_000);

  it('an attacker PROCESS that knows the meeting id but not the code cannot pair, reaches no prompt, and burns at most the allowed tries', async () => {
    const before = await status(devs.A);
    const { code, meeting } = await devs.A.control!.post<any>('/pair/open-relay');
    codes.push(code, code.replace(/-/g, ''));
    meetings.push(meeting);
    const res = await runAttacker(root, buildDir, relay.url, meeting, 6);
    expect(res.joined).toBeGreaterThanOrEqual(1); // it really was in the meeting, as a guest
    expect(res.welcomed).toBe(0);
    const st = await devs.A.control!.post<any>('/pair/state');
    const fails = (st.events as string[]).filter((e) => e.startsWith('fail')).length;
    expect(fails).toBeGreaterThanOrEqual(1);
    expect(fails).toBeLessThanOrEqual(3); // MAX_FAILURES: six attempts cost the host no more than three tries
    expect(st.events).toContain('burned');
    expect(st.events).not.toContain('prompt');
    expect(st.events).not.toContain('welcome-sent');
    expect((await devs.A.control!.post<any>('/pair/prompt')).prompt).toBeNull();
    const after = await status(devs.A);
    expect(after.rosterCount).toBe(before.rosterCount);
    expect(after.activeDevices.sort()).toEqual(before.activeDevices.sort());
    // the code is now dead for the honest joiner too (a nuisance a hostile pipe can always cause, but never a break-in)
    await devs.D.control!.post('/pair/join-relay', { code }).catch(() => undefined);
    await until(async () => { const j = (await devs.D.control!.post<any>('/pair/join-status')); return !!j.failed || j.stage === 'none'; }, 'the honest joiner to be refused', 15_000).catch(() => undefined);
    expect((await status(devs.D)).inSet).toBe(false);
    expect((await devs.D.control!.post<any>('/pair/join-status')).done).toBe(false);
  }, 180_000);

  it('a sealed frame from A is received and verified by B and C', async () => {
    await devs.A.control!.post('/send', { text: notes[0] });
    await until(async () => (await inbox(devs.B)).length === 1 && (await inbox(devs.C)).length === 1, 'note on B and C');
    expect(await inbox(devs.B)).toEqual([notes[0]]);
    expect((await devs.B.control!.post<any>('/inbox')).items[0].from).toBe((await status(devs.A)).deviceId);
    // B and C were online, so they heard of the frame from the relay's DOORBELL (the one-byte `pass` workaround is gone)
    expect((await status(devs.B)).doorbells).toBeGreaterThan(0);
    expect((await status(devs.C)).doorbells).toBeGreaterThan(0);
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
    await until(async () => { const c = await status(devs.C); return c.removedDevices.includes(bId) && (c.currentGeneration ?? 1) !== 1; }, 'C knows of the removal and holds the new generation');
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

  it('a removed device cannot rejoin: its signed statements are refused (even carried by a member), it cannot be re-added, it cannot sign in', async () => {
    const bId = (await status(devs.B)).deviceId;
    const [aKeys, bKeys, cKeys] = await Promise.all([keysOf(devs.A), keysOf(devs.B), keysOf(devs.C)]);
    const setId = aKeys.setId as Buffer;
    const aRoster = new RosterStore(path.join(devs.A.userData, 'mesh'));
    await aRoster.load();
    // C's own (still valid) connection carries everything below: the relay judges the SIGNER of each statement, not who relays it
    const carrier = new RelayClient({ url: relay.url, setId, identity: cKeys.identity, baseDelayMs: 50 });
    carrier.start();
    try {
      await until(() => carrier.state === 'ready', 'a member connection');
      const put = (signer: typeof aKeys.identity, kind: 'add' | 'remove', targetKey: Buffer | null, target: Buffer, seen: Buffer[]) => {
        const entry = randomBytes(32);
        const at = Date.now();
        const { sig } = signRosterStatement(signer, { kind, room: setId, target, targetKey, entry, seen, at });
        return carrier.rosterPut({ kind, signer: signer.deviceId.toString('hex'), target: target.toString('hex'), ...(targetKey ? { targetKey: targetKey.toString('hex') } : {}), entry: entry.toString('hex'), seen: seen.map((x) => x.toString('hex')), at, sig: sig.toString('hex') });
      };
      const anySeen = [Buffer.alloc(32, 7)];
      // B, removed, signs an add of itself and an add of a stranger
      expect(await put(bKeys.identity, 'add', bKeys.identity.signKey, bKeys.identity.deviceId, anySeen)).toBe('signer-removed');
      // (a removed signer's removal is judged against its stated ancestry for the mutual-removal rule: bogus ancestry is refused as such)
      expect(['signer-removed', 'bad-ancestry']).toContain(await put(bKeys.identity, 'remove', null, cKeys.identity.deviceId, anySeen));
      // A, a real member with a real history, is asked to re-add B: the relay's ban refuses it
      const seenA = seenForNextEntry(aRoster.entries, aKeys.identity.deviceId);
      expect(await put(aKeys.identity, 'add', bKeys.identity.signKey, bKeys.identity.deviceId, seenA)).toBe('banned');
    } finally { carrier.stop(); }
    // and B itself still cannot sign in
    const probe = new RelayClient({ url: relay.url, setId, identity: bKeys.identity, baseDelayMs: 50 });
    probe.start();
    await until(() => probe.state === 'removed', 'relay refuses B at sign-in');
    probe.stop();
    expect((await status(devs.A)).removedDevices).toContain(bId);
  }, 60_000);

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

  // ---------------------------------------------------------------------------------------------------------------------
  // Review fixes (2026-11-14): rename, removal in two steps, killed backends, a failed pairing, a long roster. Devices P (host), Q, R, T, U, V, W.
  // ---------------------------------------------------------------------------------------------------------------------
  const roster = (d: Device) => status(d);
  const names = (s: any): string[] => s.activeDevices;

  it('after a rename the relay still takes a pairing and a removal (it used to refuse both, silently)', async () => {
    await Promise.all(['P', 'Q', 'R', 'T'].map((n) => startDevice(devs[n], opts[n])));
    await devs.P.control!.post('/create-set');
    await until(async () => (await status(devs.P)).relay === 'ready', 'P on the relay');
    for (const n of ['Q', 'R']) {
      await pair(devs.P, devs[n]);
      await until(async () => (await status(devs[n])).relay === 'ready', `${n} on the relay`);
    }
    await devs.P.control!.post('/rename', { name: 'renamed-P' });
    await until(async () => (await status(devs.P)).relayPending === 0, 'the relay accepted the rename');
    await devs.Q.control!.post('/rename', { name: 'renamed-Q' });
    await until(async () => (await status(devs.Q)).relayPending === 0, 'the relay accepted Q\'s rename');
    // a 4th device pairs AFTER the renames: the relay must still let it in
    await pair(devs.P, devs.T);
    await until(async () => (await status(devs.T)).relay === 'ready', 'T on the relay');
    await until(async () => (await Promise.all(['P', 'Q', 'R', 'T'].map((n) => roster(devs[n])))).every((s) => s.activeDevices.length === 4), 'four active devices everywhere');
    // and a removal after the renames reaches the relay: R is cut off, and the answer is "done", not "pending"
    const rId = (await status(devs.R)).deviceId;
    const r = await devs.P.control!.post<any>('/remove', { device: rId });
    expect(r.outcome).toBe('done');
    await until(async () => (await status(devs.R)).relay === 'removed', 'R cut off at the relay');
    expect((await status(devs.P)).removalsPending).toEqual([]);
    expect((await status(devs.P)).relayRefusals).toEqual({});
  }, 240_000);

  it('a removal while the relay is unreachable is "pending", survives a KILLED backend, and completes after the restart', async () => {
    const qId = (await status(devs.Q)).deviceId;
    await devs.P.control!.post('/offline', { offline: true });
    await until(async () => (await status(devs.P)).relay === 'stopped', 'P offline');
    const r = await devs.P.control!.post<any>('/remove', { device: qId });
    expect(r.outcome).toBe('pending');
    expect((await status(devs.P)).removalsPending).toEqual([qId]);
    expect((await status(devs.Q)).relay).toBe('ready'); // the relay has not been told: Q is not cut off yet
    await killDevice(devs.P); // between the steps: the entry is in the log, the new secret saved, nothing reached the relay
    await startDevice(devs.P, opts.P);
    await until(async () => (await status(devs.Q)).relay === 'removed', 'Q cut off after the restart', 40_000);
    await until(async () => { const s = await status(devs.P); return s.removalsPending.length === 0 && s.relayPending === 0 && (s.currentGeneration ?? 1) !== 1; }, 'P finished the removal and holds the new generation', 40_000);
    await until(async () => { const t = await status(devs.T); return t.removedDevices.includes(qId) && (t.currentGeneration ?? 1) !== 1; }, 'T learned of the removal and holds the new generation', 40_000);
    // and the survivors still talk to each other under the new generation
    await devs.P.control!.post('/send', { text: 'after-kill-note' });
    await until(async () => (await inbox(devs.T)).includes('after-kill-note'), 'T receives under generation 3');
    notes.push('after-kill-note');
  }, 240_000);

  it('a pairing whose new device is slow to show up is NEVER undone by a timer: it stays listed as pending, and finishes once the device connects', async () => {
    await startDevice(devs.U, opts.U);
    await devs.U.control!.post('/offline', { offline: true }); // U will finish pairing but not reach the relay yet
    const before = await status(devs.P);
    await pair(devs.P, devs.U);
    const mid = await status(devs.P);
    expect(mid.activeDevices.length).toBe(before.activeDevices.length + 1);
    expect(mid.unconfirmedJoins.length).toBe(1);
    const uId = mid.unconfirmedJoins[0];
    await new Promise((r) => setTimeout(r, 10_000)); // settle: longer than P's old rollback timer (8 s)
    const waited = await status(devs.P);
    expect(waited.removedDevices).not.toContain(uId);
    expect(waited.pendingDevices).toContain(uId);
    await devs.U.control!.post('/offline', { offline: false });
    await until(async () => { const s = await status(devs.P); return s.pendingDevices.length === 0 && s.unconfirmedJoins.length === 0; }, 'the pairing finished once U connected', 60_000);
    expect((await status(devs.P)).removedDevices).not.toContain(uId);
  }, 180_000);

  it('a host with 500 roster entries still pairs a new device through the relay (the welcome is far above the old 16 KiB limit)', async () => {
    await Promise.all(['V', 'W'].map((n) => startDevice(devs[n], opts[n])));
    await devs.V.control!.post('/create-set');
    await until(async () => (await status(devs.V)).relay === 'ready', 'V on the relay');
    await devs.V.control!.post('/stress-append', { n: 500 });
    expect((await status(devs.V)).rosterCount).toBe(501);
    await pair(devs.V, devs.W);
    await until(async () => (await status(devs.W)).rosterCount >= 502, 'W holds the whole roster');
    const re = new RosterStore(path.join(devs.W.userData, 'mesh'));
    await re.load();
    expect(re.size).toBeGreaterThanOrEqual(502);
    await until(async () => (await status(devs.W)).relay === 'ready', 'W on the relay');
    expect((await status(devs.V)).unconfirmedJoins).toEqual([]);
  }, 240_000);

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
    // the relay now verifies roster changes itself, so prove it still never sees a device NAME (statements carry ids and keys only)
    for (const h of hay.filter((x) => x.where.startsWith('relay'))) for (const nm of ['rig-A', 'rig-B', 'rig-C']) expect(h.bytes.includes(Buffer.from(nm)), `${nm} in ${h.where}`).toBe(false);
    expect(hay.reduce((n, h) => n + h.bytes.length, 0)).toBeGreaterThan(1000);
  }, 60_000);

  it('nothing was written outside the decoy homes: every decoy "real home" is empty and no real-home path was touched', async () => {
    for (const d of Object.values(devs)) {
      expect(decoyLeaks(d), `${d.name} decoy`).toEqual([]);
      expect(auditRows(d), `${d.name} fs audit`).toEqual([]);
    }
    // each device's own files are where they should be
    // Every device now also receives the others' roster heads and first entries, so each saves a receive position.
    // (relay-sync.json: the host's record of pairings it still has to confirm; join-attempted: a joiner's marker that a second try uses a new identity)
    expect(inventory(path.join(devs.A.userData, 'mesh'))).toEqual(['keys.bin', 'link-state.bin', 'relay-sync.json', 'roster.log']);
    for (const n of ['B', 'C']) expect(inventory(path.join(devs[n].userData, 'mesh'))).toEqual(['join-attempted', 'keys.bin', 'link-state.bin', 'roster.log']);
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


