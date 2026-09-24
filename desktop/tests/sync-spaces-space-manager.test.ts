import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SpaceManager, repoNameForSpace, provisionGithubRemote } from '../src/main/sync-spaces/space-manager';
import type { SyncSpace } from '../src/main/sync-spaces/types';

describe('repoNameForSpace', () => {
  it('maps personal and project spaces to stable private repo names', () => {
    expect(repoNameForSpace({ id: 'personal', kind: 'personal', root: '/x' })).toBe('youcoded-sync-personal');
    // Project names carry a short hash of the lowercased id for uniqueness.
    expect(repoNameForSpace({ id: 'project:My App', kind: 'project', root: '/x' }))
      .toMatch(/^youcoded-sync-project-my-app-[0-9a-f]{8}$/);
  });

  it('is case-insensitive: the same folder name in different case maps to the SAME repo', () => {
    const a = repoNameForSpace({ id: 'project:My App', kind: 'project', root: '/x' });
    const b = repoNameForSpace({ id: 'project:my app', kind: 'project', root: '/x' });
    expect(a).toBe(b);
  });

  it('distinct folder names that slug identically get DIFFERENT repos', () => {
    const a = repoNameForSpace({ id: 'project:My App', kind: 'project', root: '/x' });
    const b = repoNameForSpace({ id: 'project:My-App', kind: 'project', root: '/x' });
    expect(a).not.toBe(b);
  });

  it('all-symbol names still produce a valid, unique repo name', () => {
    expect(repoNameForSpace({ id: 'project:###', kind: 'project', root: '/x' }))
      .toMatch(/^youcoded-sync-project-x-[0-9a-f]{8}$/);
  });
});

// Phase 2 (2026-07-22): provisioning goes through the shared github-client
// (REST) — no gh CLI. The already-exists recovery + plain-language error
// mapping live INSIDE createPrivateRepo (pinned in github-client.test.ts);
// this seam only pins the delegation + the no-client wiring-regression path.
describe('provisionGithubRemote (injected github-client)', () => {
  it('delegates to createPrivateRepo and returns its clone URL', async () => {
    const client = { createPrivateRepo: vi.fn(async () => 'https://github.com/u/youcoded-sync-personal.git') };
    await expect(provisionGithubRemote('youcoded-sync-personal', client))
      .resolves.toBe('https://github.com/u/youcoded-sync-personal.git');
    expect(client.createPrivateRepo).toHaveBeenCalledWith('youcoded-sync-personal');
  });

  it('propagates client errors verbatim (syncSpace surfaces them as the error event)', async () => {
    const original = Object.assign(
      new Error('GitHub sign-in expired — reconnect your GitHub account in the Sync settings'),
      { syncErrorCode: 'github-auth' },
    );
    const client = { createPrivateRepo: vi.fn(async () => { throw original; }) };
    await expect(provisionGithubRemote('r', client)).rejects.toBe(original);
  });

  it('no registered client → plain-language, coded "not connected" error', async () => {
    await expect(provisionGithubRemote('r', null)).rejects.toThrow('Not connected to GitHub');
    await expect(provisionGithubRemote('r', null)).rejects.toMatchObject({ syncErrorCode: 'github-auth' });
  });
});

describe('SpaceManager state', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-sm-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('persists enabled flag + per-space remotes in sync-spaces.json', async () => {
    const stateFile = path.join(tmp, 'sync-spaces.json');
    const m = new SpaceManager({ stateFile, provisionRemote: vi.fn() });
    expect(m.isEnabled()).toBe(false);
    m.setEnabled(true);
    expect(m.isEnabled()).toBe(true); // visible to reads at once, before the write lands
    await m.flush();
    expect(new SpaceManager({ stateFile, provisionRemote: vi.fn() }).isEnabled()).toBe(true);
    m.recordRemote('personal', 'https://github.com/u/youcoded-sync-personal.git');
    expect(m.remoteFor('personal')).toBe('https://github.com/u/youcoded-sync-personal.git');
  });

  it('ensureRemote provisions once and caches the URL', async () => {
    const stateFile = path.join(tmp, 'sync-spaces.json');
    const provisionRemote = vi.fn(async (name: string) => `https://github.com/u/${name}.git`);
    const m = new SpaceManager({ stateFile, provisionRemote });
    const space: SyncSpace = { id: 'personal', kind: 'personal', root: tmp };
    const url1 = await m.ensureRemote(space);
    const url2 = await m.ensureRemote(space);
    expect(url1).toBe('https://github.com/u/youcoded-sync-personal.git');
    expect(url2).toBe(url1);
    expect(provisionRemote).toHaveBeenCalledTimes(1);
  });

  it('a failed provision propagates and does not record a remote', async () => {
    const stateFile = path.join(tmp, 'sync-spaces.json');
    // First call fails (e.g. offline / not authed); second succeeds. The failure
    // must NOT poison the state file — remoteFor stays null so a retry can provision.
    const provisionRemote = vi.fn()
      .mockRejectedValueOnce(new Error('gh: not signed in'))
      .mockResolvedValueOnce('https://github.com/u/youcoded-sync-personal.git');
    const m = new SpaceManager({ stateFile, provisionRemote });
    const space: SyncSpace = { id: 'personal', kind: 'personal', root: tmp };
    await expect(m.ensureRemote(space)).rejects.toThrow('gh: not signed in');
    expect(m.remoteFor('personal')).toBe(null);
    // Retry after the transient failure provisions and records normally.
    await expect(m.ensureRemote(space)).resolves.toBe('https://github.com/u/youcoded-sync-personal.git');
    expect(m.remoteFor('personal')).toBe('https://github.com/u/youcoded-sync-personal.git');
    expect(provisionRemote).toHaveBeenCalledTimes(2);
  });

  it('recordSyncSuccess persists "has ever synced" evidence across instances', async () => {
    const stateFile = path.join(tmp, 'sync-spaces.json');
    const m = new SpaceManager({ stateFile, provisionRemote: vi.fn() });
    // Never-synced default is null — this is what gates the panel's green
    // state: recentEvents is per-boot, so WITHOUT this persisted marker a
    // restart couldn't tell "synced before" from "never synced" (beta.8 VM bug).
    expect(m.lastSyncFor('personal')).toBe(null);
    m.recordSyncSuccess('personal', 1_800_000_000_000);
    expect(m.lastSyncFor('personal')).toBe(1_800_000_000_000);
    // Survives a restart (fresh instance over the same state file) and
    // coexists with the other persisted fields.
    m.setEnabled(true);
    await m.flush();
    const m2 = new SpaceManager({ stateFile, provisionRemote: vi.fn() });
    expect(m2.lastSyncFor('personal')).toBe(1_800_000_000_000);
    expect(m2.lastSyncFor('project:other')).toBe(null);
    expect(m2.isEnabled()).toBe(true);
    // A later sync advances the marker.
    m2.recordSyncSuccess('personal', 1_800_000_000_500);
    expect(m2.lastSyncFor('personal')).toBe(1_800_000_000_500);
  });

  it('degrades to defaults when the state file is corrupt, and self-heals on write', async () => {
    const stateFile = path.join(tmp, 'sync-spaces.json');
    fs.writeFileSync(stateFile, '{not json!!');
    const m = new SpaceManager({ stateFile, provisionRemote: vi.fn() });
    expect(m.isEnabled()).toBe(false);
    expect(m.remoteFor('personal')).toBe(null);
    m.setEnabled(true);
    await m.flush();
    expect(new SpaceManager({ stateFile, provisionRemote: vi.fn() }).isEnabled()).toBe(true);
  });
});

// main-blocking-calls B6 (2026-09-24): this state file used to be read with
// readFileSync on every status query and rewritten synchronously after EVERY
// successful sync of EVERY space — on the main thread every window shares.
// Reads now come from memory; writes are queued to one async writer per file.
describe('SpaceManager — non-blocking reads and writes', () => {
  let tmp: string;
  let stateFile: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-sm-'));
    stateFile = path.join(tmp, 'toolkit-state', 'sync-spaces.json');
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const readDisk = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));

  it('reads the file synchronously ONCE; later reads and every write touch no sync fs call', async () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ enabled: true, remotes: { personal: 'u' } }));
    const m = new SpaceManager({ stateFile, provisionRemote: vi.fn() });
    expect(m.isEnabled()).toBe(true); // the startup read
    const sync = ['readFileSync', 'writeFileSync', 'renameSync', 'mkdirSync'].map((k) => vi.spyOn(fs, k as any));
    for (let i = 0; i < 5; i++) {
      m.recordSyncSuccess('personal', 1000 + i);
      expect(m.isEnabled()).toBe(true);
      expect(m.remoteFor('personal')).toBe('u');
      expect(m.lastSyncFor('personal')).toBe(1000 + i);
    }
    await m.flush();
    for (const s of sync) expect(s).not.toHaveBeenCalled();
    expect(readDisk().lastSync).toEqual({ personal: 1004 });
  });

  it('syncs of several spaces finishing together: every stamp lands, writes never overlap, and they coalesce', async () => {
    const m = new SpaceManager({ stateFile, provisionRemote: vi.fn() });
    const realWrite = fs.promises.writeFile;
    let inFlight = 0;
    let maxInFlight = 0;
    let writes = 0;
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args: any[]) => {
      inFlight++; writes++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5)); // a slow disk widens any race
      try { return await (realWrite as any)(...args); } finally { inFlight--; }
    });
    const spaces = ['personal', 'project:a', 'project:b', 'project:c', 'project:d'];
    spaces.forEach((id, i) => m.recordSyncSuccess(id, 2000 + i));
    // A second wave arrives while the first write is still in flight.
    await new Promise((r) => setTimeout(r, 1));
    spaces.forEach((id, i) => m.recordSyncSuccess(id, 3000 + i));
    m.recordRemote('project:a', 'https://github.com/u/a.git');
    await m.flush();
    expect(maxInFlight).toBe(1);        // one writer: the shared temp file is never written twice at once
    expect(writes).toBeLessThanOrEqual(2); // 11 changes → at most one write per wave
    expect(readDisk().lastSync).toEqual(Object.fromEntries(spaces.map((id, i) => [id, 3000 + i])));
    expect(readDisk().remotes).toEqual({ 'project:a': 'https://github.com/u/a.git' });
    // A fresh instance (a restart) sees exactly what memory saw.
    const m2 = new SpaceManager({ stateFile, provisionRemote: vi.fn() });
    for (const [i, id] of spaces.entries()) expect(m2.lastSyncFor(id)).toBe(3000 + i);
  });

  it('a write keeps a field another process wrote meanwhile (re-reads before writing)', async () => {
    const m = new SpaceManager({ stateFile, provisionRemote: vi.fn() });
    expect(m.isEnabled()).toBe(false); // memory now holds "no remotes"
    // The dev instance (same ~/.claude) records a remote behind our back.
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ enabled: false, remotes: { personal: 'from-other-process' } }));
    m.recordSyncSuccess('project:x', 42);
    await m.flush();
    expect(readDisk().remotes).toEqual({ personal: 'from-other-process' });
    expect(readDisk().lastSync).toEqual({ 'project:x': 42 });
    expect(m.remoteFor('personal')).toBe('from-other-process'); // memory caught up too
  });

  it("picks up another process's change on a later read (background refresh)", async () => {
    const m = new SpaceManager({ stateFile, provisionRemote: vi.fn() });
    expect(m.isEnabled()).toBe(false);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ enabled: true, remotes: {} }));
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 60_000); // the cached copy is now old
    m.isEnabled(); // kicks the background re-read
    await vi.waitFor(() => expect(m.isEnabled()).toBe(true));
  });

  it('a background re-read never overwrites a change made while it was reading', async () => {
    const m = new SpaceManager({ stateFile, provisionRemote: vi.fn() });
    expect(m.isEnabled()).toBe(false);
    const realRead = fs.promises.readFile;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.spyOn(fs.promises, 'readFile').mockImplementationOnce(async (...args: any[]) => {
      // The refresh reads the OLD file, then is slow to hand it back.
      const old = await (realRead as any)(...args);
      await gate;
      return old;
    }).mockImplementationOnce(realRead as any);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ enabled: false, remotes: {} }));
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    m.isEnabled(); // refresh starts: reads enabled:false, then waits
    m.setEnabled(true); // a change lands and is fully written meanwhile
    await m.flush();
    expect(readDisk().enabled).toBe(true);
    release(); // now the stale refresh result arrives
    await new Promise((r) => setTimeout(r, 10));
    expect(m.isEnabled()).toBe(true); // the newer change survives
    expect(readDisk().enabled).toBe(true);
  });

  it('a failed write loses nothing: memory keeps the value, flush reports the error, the next write retries it', async () => {
    const m = new SpaceManager({ stateFile, provisionRemote: vi.fn() });
    const realRename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename')
      .mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
      .mockImplementation(realRename as any);
    m.recordSyncSuccess('personal', 111);
    await expect(m.flush()).rejects.toThrow('disk full');
    expect(m.lastSyncFor('personal')).toBe(111);
    // The next change (a later sync) carries the earlier one with it.
    m.recordSyncSuccess('project:a', 222);
    await m.flush();
    expect(readDisk().lastSync).toEqual({ personal: 111, 'project:a': 222 });
  });

  it('ensureRemote surfaces a failed state write to its caller, like the old sync write did', async () => {
    const provisionRemote = vi.fn(async () => 'https://github.com/u/r.git');
    const m = new SpaceManager({ stateFile, provisionRemote });
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('EACCES: permission denied'));
    await expect(m.ensureRemote({ id: 'personal', kind: 'personal', root: tmp })).rejects.toThrow('permission denied');
  });
});
