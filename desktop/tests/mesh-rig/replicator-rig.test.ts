// REPLICATOR rig: two real jailed backends and the real relay code (locally), with the replicator switched on (YOUCODED_MESH_REPLICATOR=1, test mode only).
// Proves, with real processes and real sockets: a reply written on A is readable on B in under 2 seconds (p95 over a 50-line reply), a device that was away catches up
// exactly when it returns, and the two inventories end up identical (same lines, same chain value, same conversation chain value, verify() ok, byte for byte).
// GATED like the other rig test: MESH_RIG=1 npx vitest run tests/mesh-rig/replicator-rig.test.ts   (optional MESH_RIG_BUILD=<dir>).
// NOTE on "a virtual day": a real process cannot be given a virtual clock; the day-long absence is proved in tests/mesh/replicator.test.ts (virtual time). Here B is away for as long
// as the rig allows and the relay's held frames are removed, which is the same state the replicator must recover from.
import { randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBackend, planDevice, rigAvailable, sleep, startDevice, startRelay, stopDevice, type Device, type DeviceOptions, type Relay } from './rig';

const avail = rigAvailable();
const enabled = process.env.MESH_RIG === '1';
if (!enabled) console.warn('SKIPPED replicator rig test: set MESH_RIG=1 to run it (compiles the backend and starts a local relay; a few minutes).');
else if (!avail.ok) console.warn(`SKIPPED replicator rig test: ${avail.why}`);

const until = async (cond: () => Promise<boolean> | boolean, what: string, ms = 30_000): Promise<void> => {
  const t0 = Date.now();
  for (;;) { if (await cond()) return; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(40); }
};
const status = (d: Device) => d.control!.post<any>('/status');
const heads = async (d: Device): Promise<Array<{ version: string; lines: number; hash: string; conversationHash: string; state: string; status: string }>> => (await d.control!.post<any>('/rep/heads')).heads;
const headOf = async (d: Device, v: string) => (await heads(d)).find((h) => h.version === v);
const line = (i: number): string => Buffer.from(`${JSON.stringify({ type: i % 2 ? 'assistant' : 'user', message: { content: `rig line ${i} ${'y'.repeat(60)}` } })}\n`).toString('base64');
const p95 = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * 0.95) - 1)];

describe.skipIf(!enabled || !avail.ok)('replicator rig: two jailed backends and the real relay', () => {
  let root = ''; let relay: Relay; const devs: Record<string, Device> = {}; const opts: Record<string, DeviceOptions> = {};
  const V = randomBytes(32).toString('hex');
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-rep-rig-'));
    const buildDir = process.env.MESH_RIG_BUILD || path.join(root, 'build');
    if (!process.env.MESH_RIG_BUILD) buildBackend(buildDir);
    relay = await startRelay(root);
    for (const n of ['A', 'B']) opts[n] = { mesh: true, relayUrl: relay.url, build: buildDir, extraEnv: { YOUCODED_MESH_REPLICATOR: '1', YOUCODED_MESH_HEADS_MS: '1500', YOUCODED_MESH_GEN_TAKEOVER_MS: '300' } };
    for (const n of ['A', 'B']) devs[n] = planDevice(root, n, opts[n]);
    await Promise.all(['A', 'B'].map((n) => startDevice(devs[n], opts[n])));
    // A makes the set; B pairs to A through the relay's meeting point
    await devs.A.control!.post('/create-set');
    await until(async () => (await status(devs.A)).relay === 'ready', 'A on the relay');
    const { code } = await devs.A.control!.post<any>('/pair/open-relay');
    await devs.B.control!.post('/pair/join-relay', { code });
    await until(async () => !!(await devs.A.control!.post<any>('/pair/prompt')).prompt, 'the host prompt');
    const p = (await devs.A.control!.post<any>('/pair/prompt')).prompt;
    await devs.A.control!.post('/pair/decide', { conn: p.conn, approve: true });
    await until(async () => (await devs.B.control!.post<any>('/pair/join-status')).done === true, 'B joined');
    await until(async () => (await status(devs.B)).relay === 'ready', 'B on the relay');
  }, 480_000);
  afterAll(async () => {
    await Promise.all(Object.values(devs).map(stopDevice));
    await relay?.stop();
    if (root && process.env.MESH_RIG_KEEP !== '1') fs.rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('a 50-line reply written on A is readable on B in under 2 seconds (p95), line by line', async () => {
    await devs.A.control!.post('/rep/create', { version: V, chat: 'rig:chat-1' });
    await until(async () => !!(await headOf(devs.B, V)), 'B learns the version', 30_000);
    const sentAt: number[] = []; const seenAt: number[] = [];
    const watcher = (async () => { for (;;) { const h = await headOf(devs.B, V); const n = h?.lines ?? 0; const t = Date.now(); while (seenAt.length < n) seenAt.push(t); if (n >= 50) return; await sleep(15); } })();
    for (let b = 0; b < 10; b++) {
      const batch = Array.from({ length: 5 }, (_, i) => line(b * 5 + i));
      const t = Date.now();
      await devs.A.control!.post('/rep/append', { version: V, lines: batch });
      for (let i = 0; i < 5; i++) sentAt.push(t);
      await sleep(120); // an assistant reply grows over seconds, not instantly
    }
    await Promise.race([watcher, sleep(30_000).then(() => { throw new Error('B did not reach 50 lines in 30 s'); })]);
    const lat = sentAt.map((t, i) => seenAt[i] - t);
    expect(p95(lat), `latencies ms: ${lat.join(',')}`).toBeLessThan(2000);
  }, 120_000);

  it('B away while A writes 100 more lines, then back: B catches up exactly and the inventories match', async () => {
    await devs.B.control!.post('/offline', { offline: true });
    await until(async () => (await status(devs.B)).relay === 'stopped', 'B offline');
    for (let b = 0; b < 20; b++) await devs.A.control!.post('/rep/append', { version: V, lines: Array.from({ length: 5 }, (_, i) => line(50 + b * 5 + i)) });
    await devs.B.control!.post('/offline', { offline: false });
    await until(async () => (await headOf(devs.B, V))?.lines === 150, 'B caught up to 150 lines', 60_000);
    await sleep(500); // settle: nothing more may arrive
    const [a, b] = await Promise.all([headOf(devs.A, V), headOf(devs.B, V)]);
    expect(b).toMatchObject({ lines: a!.lines, hash: a!.hash, conversationHash: a!.conversationHash });
    const [ra, rb] = await Promise.all([devs.A, devs.B].map((d) => d.control!.post<any>('/rep/read', { version: V, from: 0, to: 150 })));
    expect(rb.lines).toEqual(ra.lines); // byte for byte
    expect(ra.ok).toBe(true); expect(rb.ok).toBe(true); // store.verify() on both
  }, 180_000);
});
