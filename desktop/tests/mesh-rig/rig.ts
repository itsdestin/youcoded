// Mesh rig harness: real headless backends under bubblewrap (decoy homes) + the real Worker relay under `wrangler dev --local`.
// Derived from the Phase 0 T1 rig (docs/active/prototypes/2026-11-14-mesh-phase0/T1/rig.mjs, findings in T1-rig.md, which
// is git-ignored there): same jail, same environment rules, now committed beside the test that needs it.
//
// ISOLATION (why this cannot touch the user's real data or running app):
//  * every device runs in its own bubblewrap jail: whole filesystem read-only, the REAL home replaced by an empty writable
//    DECOY folder (any file that appears there is a write that would have hit the real home), /tmp and /run/user private,
//    only that device's own folder writable, an empty environment plus the variables set below;
//  * nothing under /opt/YouCoded or the real ~/.claude, ~/.youcoded, ~/YouCoded, ~/.config is opened by this file or the test;
//  * listeners: 127.0.0.1 only, random ports, closed at the end; processes are stopped by the exact pid recorded at spawn;
//  * the relay runs with a throwaway HOME/XDG folders, telemetry off, no account, no network beyond localhost.
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

export const DESKTOP = path.resolve(__dirname, '..', '..');
export const WORKER = path.resolve(DESKTOP, '..', '..', 'wecoded-marketplace', 'worker');
export const REAL_HOME = os.userInfo().homedir; // asked of the OS on purpose: NOT process.env.HOME (which tests redirect)
const UID = process.getuid?.() ?? 1000;
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const rigAvailable = (): { ok: boolean; why: string } => {
  if (process.platform !== 'linux') return { ok: false, why: 'the rig needs Linux (bubblewrap)' };
  if (spawnSync('bwrap', ['--version']).status !== 0) return { ok: false, why: 'bubblewrap (bwrap) not found' };
  if (!fs.existsSync(path.join(WORKER, 'package.json'))) return { ok: false, why: 'wecoded-marketplace worker is not checked out beside youcoded' };
  if (!fs.existsSync(path.join(WORKER, 'node_modules', '.bin', 'wrangler'))) return { ok: false, why: 'worker node_modules (wrangler) not present' };
  return { ok: true, why: '' };
};

const freePort = (): Promise<number> => new Promise((res, rej) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); });
  s.on('error', rej);
});
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ---------------------------------------------------------------- build
/** Compile the backend (main process only) into `<root>/build`, laid out the way the headless shim expects. */
export function buildBackend(buildDir: string): void {
  fs.mkdirSync(buildDir, { recursive: true });
  // WHY --outDir elsewhere: the worktree's own desktop/dist is not ours to write.
  const r = spawnSync(path.join(DESKTOP, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json', '--outDir', path.join(buildDir, 'dist')], { cwd: DESKTOP, stdio: 'ignore' });
  if (!fs.existsSync(path.join(buildDir, 'dist/main/headless/headless-main.js'))) throw new Error(`backend build failed (tsc exit ${r.status})`);
  for (const x of ['package.json', 'scripts', 'hook-scripts', 'assets', 'node_modules']) {
    fs.rmSync(path.join(buildDir, x), { force: true });
    fs.symlinkSync(path.join(DESKTOP, x), path.join(buildDir, x));
  }
  fs.copyFileSync(path.join(DESKTOP, 'src/main/pty-worker.js'), path.join(buildDir, 'dist/main/pty-worker.js'));
  fs.mkdirSync(path.join(buildDir, 'dist/renderer/data'), { recursive: true });
}

// ---------------------------------------------------------------- relay (the real Worker code, locally)
export interface Relay { url: string; port: number; log: string; stateDir: string; stop(): Promise<void> }
export async function startRelay(root: string): Promise<Relay> {
  const dir = path.join(root, 'relay');
  const home = path.join(dir, 'home');
  const stateDir = path.join(dir, 'state');
  for (const p of [home, stateDir, path.join(dir, 'log')]) fs.mkdirSync(p, { recursive: true });
  const port = await freePort();
  const log = path.join(dir, 'relay.log');
  const out = fs.openSync(log, 'a');
  const env = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local'), XDG_STATE_HOME: path.join(home, '.state'), TMPDIR: dir, LANG: 'C.UTF-8',
    WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: path.join(dir, 'log'), CI: '1', NO_COLOR: '1',
    // no account, no token: a local run must never talk to Cloudflare
    CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '',
  };
  // detached: its own process group, so the whole tree (wrangler, esbuild, workerd) can be stopped by one group signal
  const child = spawn(path.join(WORKER, 'node_modules/.bin/wrangler'), ['dev', '--local', '--env', 'test', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', stateDir], { cwd: WORKER, env, stdio: ['ignore', out, out], detached: true });
  let exited = false;
  child.on('exit', () => { exited = true; });
  const t0 = Date.now();
  for (;;) {
    if (exited) throw new Error(`relay exited early; see ${log}`);
    if (fs.readFileSync(log, 'utf8').includes(`Ready on http://127.0.0.1:${port}`)) break;
    if (Date.now() - t0 > 90_000) { stopGroup(child); throw new Error(`relay not ready in 90 s; see ${log}`); }
    await sleep(200);
  }
  return { url: `ws://127.0.0.1:${port}`, port, log, stateDir, stop: async () => { stopGroup(child); const t = Date.now(); while (!exited && Date.now() - t < 8000) await sleep(100); } };
}
function stopGroup(child: ChildProcess): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(-(child.pid as number), 'SIGKILL'); } catch { /* gone */ } }, 6000).unref();
}

// ---------------------------------------------------------------- devices
export interface Device {
  name: string; dir: string; home: string; decoy: string; userData: string; log: string; audit: string;
  id: string; token: string; key: string; meshToken: string;
  pid?: number; port?: number; control?: Control; child?: ChildProcess; exited?: { code: number | null; sig: string | null };
  build: string; env: Record<string, string>;
}
export interface DeviceOptions {
  /** Switch the mesh on (test mode) in this device's profile. Off = a profile exactly as the app had before. */
  mesh: boolean;
  /** 'os' uses the headless shim's safeStorage (the Android-style path) instead of the insecure test file. */
  keystore?: 'os';
  relayUrl?: string;
  build: string;
  /** Extra environment for this device only (test-mode timers such as YOUCODED_MESH_PAIR_CONFIRM_MS). */
  extraEnv?: Record<string, string>;
}

export function planDevice(root: string, name: string, o: DeviceOptions): Device {
  const dir = path.join(root, name);
  const home = path.join(dir, 'home');
  return {
    name, dir, home, decoy: path.join(dir, 'decoy-real-home'), userData: path.join(home, '.config', 'youcoded'), log: path.join(dir, 'device.log'), audit: path.join(dir, 'fs-audit.jsonl'),
    id: ((): string => { const h = randomBytes(16); h[6] = (h[6] & 0x0f) | 0x40; h[8] = (h[8] & 0x3f) | 0x80; const x = h.toString('hex'); return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`; })(),
    token: randomBytes(24).toString('hex'), key: randomBytes(32).toString('hex'), meshToken: randomBytes(24).toString('hex'),
    build: o.build, env: {},
  };
}

export class Control {
  constructor(readonly port: number, private readonly token: string) {}
  async post<T = Record<string, any>>(route: string, body: unknown = {}): Promise<T> {
    const res = await fetch(`http://127.0.0.1:${this.port}${route}`, { method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(`${route}: ${j.error ?? res.status}`);
    return j;
  }
}

export function prepareHome(d: Device, o: DeviceOptions): void {
  for (const p of [d.home, d.decoy, d.userData, path.join(d.home, 'bin'), path.join(d.home, '.local/share'), path.join(d.home, '.cache'), path.join(d.home, '.local/state'), path.join(d.dir, 'tmp'), path.join(d.dir, 'run')]) fs.mkdirSync(p, { recursive: true });
  fs.chmodSync(path.join(d.dir, 'run'), 0o700);
  fs.mkdirSync(path.join(d.dir, 'rig'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fs-audit-preload.cjs'), path.join(d.dir, 'rig', 'fs-audit-preload.cjs'));
  // The registry device id (a rig device is given one by writing this file; the MESH id is key-derived and independent).
  if (!fs.existsSync(path.join(d.userData, 'device-id.json'))) fs.writeFileSync(path.join(d.userData, 'device-id.json'), JSON.stringify({ id: d.id }));
  // The per-profile switch (design 7.2): written into the device's own profile before boot, only for devices that have it on.
  if (o.mesh) fs.writeFileSync(path.join(d.userData, 'mesh-switch.json'), JSON.stringify({ enabled: true }));
  if (!fs.existsSync(d.audit)) fs.writeFileSync(d.audit, '');
  // A stand-in `claude` so nothing looks for the real one (and PATH never reaches ~/.local/bin).
  fs.writeFileSync(path.join(d.home, 'bin', 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

function deviceEnv(d: Device, port: number, o: DeviceOptions): Record<string, string> {
  const e: Record<string, string> = {
    HOME: d.home, XDG_CONFIG_HOME: path.join(d.home, '.config'), XDG_DATA_HOME: path.join(d.home, '.local/share'), XDG_CACHE_HOME: path.join(d.home, '.cache'),
    XDG_STATE_HOME: path.join(d.home, '.local/state'), XDG_RUNTIME_DIR: `/run/user/${UID}`, TMPDIR: '/tmp', CLAUDE_CONFIG_DIR: path.join(d.home, '.claude'),
    YOUCODED_USER_DATA: d.userData, YOUCODED_DEVICE_NAME: `rig-${d.name}`, PATH: `${path.join(d.home, 'bin')}:/usr/bin:/bin`, LANG: 'C.UTF-8',
    YOUCODED_HEADLESS_PORT: String(port), YOUCODED_SECRETS_ON_STDIN: '1', YOUCODED_NO_ANALYTICS: '1', YOUCODED_CHATGPT: '0', DISABLE_AUTOUPDATER: '1', GH_TOKEN: 'rig-decoy-token',
    RIG_REAL_HOME: REAL_HOME, RIG_FS_AUDIT: d.audit, RIG_ALLOW: [d.dir, d.build, DESKTOP].join(path.delimiter),
    YOUCODED_PROFILE: 'rig', // the app's own dev-copy switch: stops boot-time git clones of the marketplace
  };
  if (o.mesh) {
    // Mesh test mode (config.ts): the insecure key file and the loopback control server exist only because of these.
    e.YOUCODED_MESH_TEST = '1';
    e.YOUCODED_MESH_TEST_TOKEN = d.meshToken;
    if (o.relayUrl) e.YOUCODED_MESH_RELAY_URL = o.relayUrl;
    e.YOUCODED_MESH_RELAY_BACKOFF_MS = '150'; // rig shrinks the reconnect delay (design 5.2: timers the rig must be able to shrink)
    if (o.keystore === 'os') e.YOUCODED_MESH_KEYSTORE = 'os';
    Object.assign(e, o.extraEnv ?? {});
  }
  return e;
}

function jailArgv(d: Device, env: Record<string, string>): string[] {
  const a = ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-uts', '--hostname', `rig-${d.name}`, '--unshare-ipc', '--clearenv',
    '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', `/run/user/${UID}`,
    '--bind', d.decoy, REAL_HOME, // the real home is an empty, writable DECOY: any file that appears there is a leak
    '--ro-bind', d.build, d.build, '--ro-bind', DESKTOP, DESKTOP, '--bind', d.dir, d.dir, '--chdir', d.home];
  for (const [k, v] of Object.entries(env)) a.push('--setenv', k, v);
  return a;
}

/** pids of everything below a pid, from /proc (bwrap forks an init and then node). */
function descendants(pid: number): number[] {
  const out: number[] = [];
  const walk = (p: number): void => {
    let kids = '';
    try { kids = fs.readFileSync(`/proc/${p}/task/${p}/children`, 'utf8'); } catch { return; }
    for (const k of kids.split(/\s+/).filter(Boolean)) { out.push(Number(k)); walk(Number(k)); }
  };
  walk(pid);
  return out;
}
/** The backend's own node pid: argv0 is node and an argument ends in headless-main.js (bwrap's argv also names the script). */
function backendPid(d: Device): number | undefined {
  if (!d.pid) return undefined;
  return [d.pid, ...descendants(d.pid)].find((p) => {
    try { const c = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0'); return c[0].endsWith('/node') && c.some((x) => x.endsWith('headless-main.js')); } catch { return false; }
  });
}

export async function startDevice(d: Device, o: DeviceOptions): Promise<Device> {
  prepareHome(d, o);
  const port = await freePort();
  const env = deviceEnv(d, port, o);
  d.env = env;
  d.exited = undefined;
  const node = ['-r', path.join(d.dir, 'rig', 'fs-audit-preload.cjs'), path.join(d.build, 'dist/main/headless/headless-main.js')];
  const out = fs.openSync(d.log, 'a');
  const logFrom = fs.statSync(d.log).size; // a restart appends to the same log: only look at what THIS start wrote
  const child = spawn('bwrap', [...jailArgv(d, env), '/usr/bin/node', ...node], { stdio: ['pipe', out, out] });
  // The owner token and secret key go on stdin as ONE JSON line, never in argv or the log (headless-main.ts readSecrets).
  // keyStore is the HOST's statement of what holds the key (finding 10): the rig plays the phone app and says the Keystore did, for D only.
  child.stdin?.end(JSON.stringify({ token: d.token, key: d.key, ...(o.keystore === 'os' ? { keyStore: 'android_keystore' } : {}) }) + '\n');
  child.on('exit', (code, sig) => { d.exited = { code, sig }; });
  Object.assign(d, { pid: child.pid, port, child, control: undefined });
  const t0 = Date.now();
  let controlPort: number | undefined;
  for (;;) {
    if (d.exited) throw new Error(`device ${d.name} exited early (${JSON.stringify(d.exited)}); see ${d.log}`);
    const text = fs.readFileSync(d.log).subarray(logFrom).toString('utf8');
    const ready = text.includes(`YOUCODED_HEADLESS_READY ${port}`);
    const m = /YOUCODED_MESH_TEST_CONTROL (\d+)/.exec(text);
    if (m) controlPort = Number(m[1]);
    if (ready && (!o.mesh || controlPort)) break;
    if (Date.now() - t0 > 60_000) throw new Error(`device ${d.name} not ready in 60 s; see ${d.log}`);
    await sleep(120);
  }
  if (controlPort) d.control = new Control(controlPort, d.meshToken);
  return d;
}

/** Stop politely (SIGTERM to the backend, which stops itself), then anything left by exact pid. */
export async function stopDevice(d: Device): Promise<void> {
  if (!d.child || d.exited) return;
  const all = [d.pid as number, ...descendants(d.pid as number)];
  const node = backendPid(d);
  try { process.kill(node ?? (d.pid as number), 'SIGTERM'); } catch { /* gone */ }
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && !d.exited) await sleep(100);
  for (const p of all) if (alive(p) && p !== process.pid) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  const t1 = Date.now();
  while (!d.exited && Date.now() - t1 < 3000) await sleep(50);
}
/** SIGKILL the backend with no warning (a power cut, as far as the process can tell). */
export async function killDevice(d: Device): Promise<void> {
  const all = [d.pid as number, ...descendants(d.pid as number)];
  for (const p of all.reverse()) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  const t0 = Date.now();
  while (!d.exited && Date.now() - t0 < 5000) await sleep(50);
}
export function pidsOf(d: Device): number[] {
  return d.pid ? [d.pid, ...descendants(d.pid)].filter(alive) : [];
}

// ---------------------------------------------------------------- inventories and leak checks
/** Every file under a folder, relative, sorted: the "inventory" used to compare two profiles. */
export function inventory(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out.push(path.relative(dir, f));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}
/** Files that appeared in the decoy "real home" = writes that would have landed in the real home. */
export const decoyLeaks = (d: Device): string[] => inventory(d.decoy);
export function auditRows(d: Device): unknown[] {
  try { return fs.readFileSync(d.audit, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
/** Every text file under a folder that could be a log, with its contents (for secret scans). */
export function logFiles(dir: string): Array<{ file: string; text: string }> {
  return inventory(dir).filter((f) => /\.(log|jsonl|txt)$/.test(f) || /(^|\/)desktop\.log$/.test(f)).map((f) => ({ file: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
}
/** Which of `needles` (labelled) appear in `haystack`? Checks the raw text, its hex and its base64 spellings. */
export function findLeaks(haystack: Buffer, needles: Array<{ label: string; bytes: Buffer }>): string[] {
  const hs = haystack.toString('latin1');
  const found: string[] = [];
  for (const n of needles) {
    if (n.bytes.length < 6) continue; // too short to mean anything
    const spellings = [n.bytes.toString('latin1'), n.bytes.toString('hex'), n.bytes.toString('base64').replace(/=+$/, '')];
    if (spellings.some((s) => hs.includes(s))) found.push(n.label);
  }
  return found;
}

// ---------------------------------------------------------------- an outside attacker process
export interface AttackResult { tries: number; joined: number; refused: number; welcomed: number; messagesFromHost: number }
/** Run attacker.cjs as its own process: empty environment, throwaway HOME (inside the rig's root), loopback only. Killed by pid on timeout. */
export function runAttacker(root: string, build: string, relayUrl: string, meetingId: string, tries: number): Promise<AttackResult> {
  const home = path.join(root, 'attacker-home');
  fs.mkdirSync(home, { recursive: true });
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, TMPDIR: home, LANG: 'C.UTF-8' };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'attacker.cjs'), build, relayUrl, meetingId, String(tries)], { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } reject(new Error('attacker timed out')); }, 90_000);
    child.on('exit', () => { clearTimeout(kill); try { resolve(JSON.parse(out.trim().split('\n').pop() as string) as AttackResult); } catch { reject(new Error(`attacker printed no result: ${out.slice(0, 200)}`)); } });
  });
}
