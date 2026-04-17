import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Stub homedir before importing SyncService, because the constructor
// captures paths from os.homedir() at instantiation time.
let tmpHome: string;
let origHomedir: typeof os.homedir;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-sync-tags-'));
  origHomedir = os.homedir;
  (os as any).homedir = () => tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.claude', 'topics'), { recursive: true });
});

afterEach(() => {
  (os as any).homedir = origHomedir;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

async function freshService() {
  // Dynamic import each time so the constructor runs under the stubbed homedir.
  const mod = await import('../src/main/sync-service');
  return new mod.SyncService();
}

function readIndex(): any {
  const p = path.join(tmpHome, '.claude', 'conversation-index.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeTopicFile(sessionId: string, content: string, mtime?: Date): void {
  const p = path.join(tmpHome, '.claude', 'topics', `topic-${sessionId}`);
  fs.writeFileSync(p, content);
  if (mtime) fs.utimesSync(p, mtime, mtime);
}

describe('setSessionFlag — unknown session with topic file present', () => {
  it('seeds entry from the topic file (topic + mtime), not a bare "Untitled"', async () => {
    const svc = await freshService();
    const mtime = new Date('2026-04-10T12:00:00Z');
    writeTopicFile('sess-a', 'Real topic about cats', mtime);

    svc.setSessionFlag('sess-a', 'complete', true);

    const idx = readIndex();
    expect(idx.sessions['sess-a'].topic).toBe('Real topic about cats');
    expect(new Date(idx.sessions['sess-a'].lastActive).getTime()).toBe(mtime.getTime());
    expect(idx.sessions['sess-a'].slug).not.toBe('');
    expect(idx.sessions['sess-a'].flags.complete.value).toBe(true);
  });
});

describe('setSessionFlag — unknown session with NO topic file', () => {
  it('seeds entry with epoch lastActive as a "pending topic scan" sentinel', async () => {
    const svc = await freshService();

    svc.setSessionFlag('sess-b', 'priority', true);

    const idx = readIndex();
    expect(idx.sessions['sess-b'].flags.priority.value).toBe(true);
    // Epoch (1970-01-01) signals that the next topic scan should overwrite us.
    expect(new Date(idx.sessions['sess-b'].lastActive).getTime()).toBe(0);
  });
});

describe('updateConversationIndex — interaction with epoch-seeded entries', () => {
  it('overwrites an epoch-seeded entry when the topic file shows up', async () => {
    const svc = await freshService();

    // Flag set before topic file existed — entry seeded with epoch lastActive
    svc.setSessionFlag('sess-c', 'helpful', true);
    expect(new Date(readIndex().sessions['sess-c'].lastActive).getTime()).toBe(0);

    // Topic file appears later (user sent first message)
    writeTopicFile('sess-c', 'Topic written later', new Date('2026-04-12T08:00:00Z'));

    svc.updateConversationIndex();

    const entry = readIndex().sessions['sess-c'];
    expect(entry.topic).toBe('Topic written later');
    // Flag survives the topic-scan overwrite
    expect(entry.flags.helpful.value).toBe(true);
  });

  it('does NOT prune epoch-seeded entries (they are pending, not old)', async () => {
    const svc = await freshService();

    // Epoch-seeded pending entry
    svc.setSessionFlag('sess-d', 'complete', true);

    // Also add a real-old entry that SHOULD be pruned (lastActive 60 days ago)
    const idxPath = path.join(tmpHome, '.claude', 'conversation-index.json');
    const current = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    current.sessions['sess-old'] = {
      topic: 'Old session',
      lastActive: new Date(Date.now() - 60 * 86400_000).toISOString(),
      slug: 'whatever',
      device: 'host',
    };
    fs.writeFileSync(idxPath, JSON.stringify(current));

    svc.updateConversationIndex();

    const after = readIndex();
    // Epoch entry survives prune
    expect(after.sessions['sess-d']).toBeDefined();
    expect(after.sessions['sess-d'].flags.complete.value).toBe(true);
    // Real-old entry is pruned as before
    expect(after.sessions['sess-old']).toBeUndefined();
  });
});

describe('setSessionFlag — 30s debounced index-only push', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('schedules a push 30 seconds after setSessionFlag (not sooner)', async () => {
    const svc = await freshService();
    const spy = vi.spyOn(svc as any, 'pushIndexOnly').mockResolvedValue(undefined);

    svc.setSessionFlag('x', 'complete', true);
    expect(spy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(29_000);
    expect(spy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('debounces: rapid repeated calls coalesce to one push', async () => {
    const svc = await freshService();
    const spy = vi.spyOn(svc as any, 'pushIndexOnly').mockResolvedValue(undefined);

    svc.setSessionFlag('x', 'complete', true);
    vi.advanceTimersByTime(20_000);
    svc.setSessionFlag('y', 'priority', true);
    vi.advanceTimersByTime(20_000);
    svc.setSessionFlag('z', 'helpful', true);

    // 40 seconds since the first call, but each call resets the timer
    expect(spy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(31_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('skips if a full push is in flight when the timer fires', async () => {
    const svc = await freshService();
    const spy = vi.spyOn(svc as any, 'pushIndexOnly').mockResolvedValue(undefined);

    svc.setSessionFlag('x', 'complete', true);
    // Full push starts while we're waiting
    (svc as any).pushing = true;
    vi.advanceTimersByTime(31_000);

    // Index push is redundant — full push will upload the index anyway
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('pullConversationIndexOnly — restore-from-backup hook', () => {
  // Minimal fake backend; we stub the per-backend fetch so the type isn't load-bearing.
  const fakeBackend = { id: 'b1', type: 'drive', syncEnabled: true, config: {} };

  it('merges a fetched remote index into local (cross-device restore case)', async () => {
    const svc = await freshService();
    vi.spyOn(svc, 'getBackendById').mockReturnValue(fakeBackend as any);

    // Local has a tag set from this device
    svc.setSessionFlag('local-only', 'helpful', true);

    // Simulate the per-backend fetch writing a remote index into staging, as
    // a real rclone/git pull would. Matches the production contract.
    const stagingDir = path.join(tmpHome, '.claude', 'toolkit-state', '.index-staging');
    vi.spyOn(svc as any, 'fetchIndexFromBackend').mockImplementation(async () => {
      fs.mkdirSync(stagingDir, { recursive: true });
      fs.writeFileSync(
        path.join(stagingDir, 'conversation-index.json'),
        JSON.stringify({
          version: 1,
          sessions: {
            'remote-only': {
              topic: 'From other device',
              lastActive: new Date().toISOString(),
              slug: 'other-slug',
              device: 'other-host',
              flags: { complete: { value: true, updatedAt: new Date().toISOString() } },
            },
          },
        }),
      );
    });

    await svc.pullConversationIndexOnly('b1');

    const after = readIndex();
    expect(after.sessions['local-only'].flags.helpful.value).toBe(true);
    expect(after.sessions['remote-only'].flags.complete.value).toBe(true);
    expect(after.sessions['remote-only'].topic).toBe('From other device');
  });

  it('is a no-op when the fetch produces no staged file (offline / missing backup)', async () => {
    const svc = await freshService();
    vi.spyOn(svc, 'getBackendById').mockReturnValue(fakeBackend as any);
    svc.setSessionFlag('only-local', 'priority', true);

    // Fetch returns normally but writes nothing — the remote backup is empty
    vi.spyOn(svc as any, 'fetchIndexFromBackend').mockResolvedValue(undefined);

    await svc.pullConversationIndexOnly('b1');

    // Local entry untouched, no merge attempted
    const after = readIndex();
    expect(after.sessions['only-local'].flags.priority.value).toBe(true);
  });

  it('early-returns silently if the backendId is unknown', async () => {
    const svc = await freshService();
    svc.setSessionFlag('only-local', 'complete', true);

    // Default getBackendById returns null — pull should not throw
    await expect(svc.pullConversationIndexOnly('nope')).resolves.toBeUndefined();

    const after = readIndex();
    expect(after.sessions['only-local'].flags.complete.value).toBe(true);
  });
});
