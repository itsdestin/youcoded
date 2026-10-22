// relistenIfDeleted (src/main/socket-repair.ts): re-creating a socket file that was
// deleted while the app runs (2026-10-22: the live app's hook socket vanished from
// /tmp and every new session sat on "Initializing session…").
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { relistenIfDeleted } from '../src/main/socket-repair';

const servers: net.Server[] = [];
const dirs: string[] = [];
const tempDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-sr-')); dirs.push(d); return d; };
const listen = (p: string) => new Promise<net.Server>((resolve) => { const s = net.createServer(); servers.push(s); s.listen(p, () => resolve(s)); });
const connects = (p: string) => new Promise<boolean>((resolve) => {
  const c = net.createConnection(p, () => { c.end(); resolve(true); });
  c.on('error', () => resolve(false));
});
const track = (s: net.Server | null) => { if (s) servers.push(s); return s; };

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('relistenIfDeleted', () => {
  it('does nothing while the file is there', async () => {
    const p = path.join(tempDir(), 's.sock');
    await listen(p);
    expect(await relistenIfDeleted(p, () => net.createServer())).toBeNull();
  });

  it('re-creates a deleted file (and its folder) and sets the file mode', async () => {
    const p = path.join(tempDir(), 'gone', 's.sock');
    fs.mkdirSync(path.dirname(p));
    await listen(p);
    fs.rmSync(path.dirname(p), { recursive: true });
    expect(await connects(p)).toBe(false);
    const fresh = track(await relistenIfDeleted(p, () => net.createServer(), { fileMode: 0o600 }));
    expect(fresh).not.toBeNull();
    expect(await connects(p)).toBe(true);
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });

  it('never touches a file that is not a socket it made', async () => {
    const p = path.join(tempDir(), 's.sock');
    fs.writeFileSync(p, 'someone else');
    expect(await relistenIfDeleted(p, () => net.createServer())).toBeNull();
    expect(fs.readFileSync(p, 'utf8')).toBe('someone else');
  });

  it('two callers at once make exactly one replacement', async () => {
    const p = path.join(tempDir(), 's.sock');
    const results = await Promise.all([1, 2, 3].map(() => relistenIfDeleted(p, () => net.createServer())));
    results.forEach(track);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await connects(p)).toBe(true);
  });

  it('closes the new server if its owner stopped meanwhile (session created during quit)', async () => {
    const p = path.join(tempDir(), 's.sock');
    expect(await relistenIfDeleted(p, () => net.createServer(), { stillWanted: () => false })).toBeNull();
    expect(fs.existsSync(p)).toBe(false); // nothing left behind, nothing holding the process open
  });

  it('refuses a folder other users can enter', async () => {
    const d = tempDir();
    fs.chmodSync(d, 0o755);
    expect(await relistenIfDeleted(path.join(d, 's.sock'), () => net.createServer())).toBeNull();
    expect(fs.existsSync(path.join(d, 's.sock'))).toBe(false);
  });

  it('is a no-op for Windows named pipes and an unset path', async () => {
    expect(await relistenIfDeleted('\\\\.\\pipe\\x', () => net.createServer(), { platform: 'win32' })).toBeNull();
    expect(await relistenIfDeleted(null, () => net.createServer())).toBeNull();
  });
});

// The repair only helps if each long-lived socket is actually re-checked when a
// session starts. Source scan, because the wiring lives in app startup files.
describe('every long-lived socket is re-checked at session start', () => {
  const src = (f: string) => fs.readFileSync(path.join(__dirname, '..', 'src', 'main', f), 'utf8');
  it.each([
    ['main.ts', /on\('session-created',[^\n]*hookRelay\.ensureListening\(\)/],
    ['headless/headless-boot.ts', /on\('session-created',[^\n]*hookRelay\.ensureListening\(\)/],
    ['assistant-browser/browser-main.ts', /on\('session-created',[^\n]*server\.ensureListening\(\)/],
    ['harness/admin-password-startup.ts', /onSessionCreated\?\.\([^\n]*server\.ensureListening\(\)/],
    ['create-runtime.ts', /sessionManager\.on\?\.\('session-created', cb\)/],
  ])('%s', (file, pattern) => {
    expect(src(file)).toMatch(pattern);
  });
});
