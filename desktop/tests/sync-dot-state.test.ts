// desktop/tests/sync-dot-state.test.ts
import { describe, it, expect } from 'vitest';
import { syncDotFor, findSpaceFor, lastSyncedLabel, latestUnresolvedError, deriveSyncBoxState, oversizeNotice, type SyncStatusData } from '../src/renderer/components/sync-dot-state';

const status = (over: Partial<SyncStatusData> = {}): SyncStatusData => ({
  enabled: true,
  spaces: [
    { id: 'personal', root: 'C:\\Users\\x\\YouCoded\\Personal' },
    { id: 'project:budget-app', root: 'C:\\Users\\x\\YouCoded\\Projects\\budget-app' },
  ],
  recentEvents: [],
  ...over,
});

describe('findSpaceFor', () => {
  it('matches a folder to its space by normalized root (slashes + case)', () => {
    expect(findSpaceFor('c:/users/x/youcoded/projects/budget-app/', status())?.id).toBe('project:budget-app');
  });
  it('returns null for a folder with no space', () => {
    expect(findSpaceFor('C:\\Users\\x\\elsewhere', status())).toBeNull();
  });
});

describe('syncDotFor', () => {
  it('returns null when status is unavailable (no dot rendered)', () => {
    expect(syncDotFor('C:\\anything', null)).toBeNull();
  });
  it('gray "Only on this computer" for unmanaged folders', () => {
    expect(syncDotFor('C:\\Users\\x\\elsewhere', status())).toEqual({ color: 'gray', label: 'Only on this computer' });
  });
  it('gray with the sync-off wording for managed folders while Sync is off', () => {
    const d = syncDotFor('C:\\Users\\x\\YouCoded\\Projects\\budget-app', status({ enabled: false }));
    expect(d?.color).toBe('gray');
    expect(d?.label).toMatch(/turn on Sync in Settings/);
  });
  it('red when the space\'s LATEST event is an error', () => {
    const d = syncDotFor('C:\\Users\\x\\YouCoded\\Projects\\budget-app', status({
      recentEvents: [
        { type: 'synced', spaceId: 'project:budget-app' },
        { type: 'error', spaceId: 'project:budget-app' },
      ],
    }));
    expect(d).toEqual({ color: 'red', label: "Sync isn't working — open Manage projects" });
  });
  it('green when a later synced event supersedes an earlier error', () => {
    const d = syncDotFor('C:\\Users\\x\\YouCoded\\Projects\\budget-app', status({
      recentEvents: [
        { type: 'error', spaceId: 'project:budget-app' },
        { type: 'synced', spaceId: 'project:budget-app' },
      ],
    }));
    expect(d).toEqual({ color: 'green', label: 'Syncs across your devices' });
  });
  it('gray "Sync stopped" for a stopped project, even while Sync is on', () => {
    const s = status();
    s.spaces = s.spaces.map((sp) =>
      sp.id === 'project:budget-app' ? { ...sp, state: 'stopped' as const } : sp);
    const d = syncDotFor('C:\\Users\\x\\YouCoded\\Projects\\budget-app', s);
    expect(d).toEqual({ color: 'gray', label: 'Sync stopped' });
  });
  it('ignores other spaces\' events', () => {
    const d = syncDotFor('C:\\Users\\x\\YouCoded\\Projects\\budget-app', status({
      recentEvents: [{ type: 'error', spaceId: 'project:other' }],
    }));
    expect(d?.color).toBe('green');
  });
  it('stays green when a large-history "notice" fires right after a synced event (no false red dot)', () => {
    const d = syncDotFor('C:\\Users\\x\\YouCoded\\Projects\\budget-app', status({
      recentEvents: [
        { type: 'synced', spaceId: 'project:budget-app' },
        { type: 'notice', spaceId: 'project:budget-app', message: 'Sync history for project:budget-app is large (512 MB). Sync still works normally.' },
      ],
    }));
    expect(d).toEqual({ color: 'green', label: 'Syncs across your devices' });
  });
  it('a notice does not mask an underlying error (error still wins the dot)', () => {
    const d = syncDotFor('C:\\Users\\x\\YouCoded\\Projects\\budget-app', status({
      recentEvents: [
        { type: 'error', spaceId: 'project:budget-app' },
        { type: 'notice', spaceId: 'project:budget-app', message: 'large' },
      ],
    }));
    expect(d?.color).toBe('red');
  });
});

describe('latestUnresolvedError', () => {
  it('returns null when status is unavailable', () => {
    expect(latestUnresolvedError(null)).toBeNull();
  });
  it('returns null when no error has ever fired', () => {
    expect(latestUnresolvedError(status({
      recentEvents: [{ type: 'synced', spaceId: 'personal' }],
    }))).toBeNull();
  });
  it('surfaces an error that no later synced has superseded', () => {
    const e = latestUnresolvedError(status({
      recentEvents: [
        { type: 'synced', spaceId: 'personal' },
        { type: 'error', spaceId: 'personal', message: 'EPERM: operation not permitted, watch' },
      ],
    }));
    expect(e?.message).toMatch(/EPERM/);
  });
  it('clears a transient error once the SAME space syncs successfully after it', () => {
    // The reported bug: a one-off watcher EPERM kept the panel red ("Couldn't
    // sync") for ~50 events while syncs succeeded every 2 minutes behind it.
    expect(latestUnresolvedError(status({
      recentEvents: [
        { type: 'error', spaceId: 'personal', message: 'EPERM: operation not permitted, watch' },
        { type: 'synced', spaceId: 'personal' },
      ],
    }))).toBeNull();
  });
  it('does NOT let another space\'s success clear an error (per-space, not global)', () => {
    const e = latestUnresolvedError(status({
      recentEvents: [
        { type: 'error', spaceId: 'project:budget-app', message: 'real breakage' },
        { type: 'synced', spaceId: 'personal' },
      ],
    }));
    expect(e?.message).toBe('real breakage');
    expect(e?.spaceId).toBe('project:budget-app');
  });
  it('keeps surfacing a genuinely broken sync that re-errors every cycle', () => {
    const e = latestUnresolvedError(status({
      recentEvents: [
        { type: 'error', spaceId: 'personal', message: 'auth failed' },
        { type: 'synced', spaceId: 'personal' },
        { type: 'error', spaceId: 'personal', message: 'auth failed' },
      ],
    }));
    expect(e?.message).toBe('auth failed');
  });
  it('ignores a notice landing after the error (a notice is not a success)', () => {
    const e = latestUnresolvedError(status({
      recentEvents: [
        { type: 'error', spaceId: 'personal', message: 'boom' },
        { type: 'notice', spaceId: 'personal', message: 'history is large' },
      ],
    }));
    expect(e?.message).toBe('boom');
  });
});

describe('lastSyncedLabel', () => {
  const NOW = 1_800_000_000_000;
  it('formats the latest synced event\'s timestamp relatively', () => {
    const s = status({ recentEvents: [{ type: 'synced', spaceId: 'project:budget-app', at: NOW - 2 * 60_000 }] });
    expect(lastSyncedLabel('project:budget-app', s, NOW)).toBe('2 minutes ago');
  });
  it('returns null when no synced event carries a timestamp', () => {
    const s = status({ recentEvents: [{ type: 'synced', spaceId: 'project:budget-app' }] });
    expect(lastSyncedLabel('project:budget-app', s, NOW)).toBeNull();
  });
  it('says "just now" under a minute', () => {
    const s = status({ recentEvents: [{ type: 'synced', spaceId: 'project:budget-app', at: NOW - 5_000 }] });
    expect(lastSyncedLabel('project:budget-app', s, NOW)).toBe('just now');
  });
  it('uses the singular "1 minute ago" at exactly one minute', () => {
    const s = status({ recentEvents: [{ type: 'synced', spaceId: 'project:budget-app', at: NOW - 60_000 }] });
    expect(lastSyncedLabel('project:budget-app', s, NOW)).toBe('1 minute ago');
  });
  it('uses the singular "1 hour ago" at exactly one hour', () => {
    const s = status({ recentEvents: [{ type: 'synced', spaceId: 'project:budget-app', at: NOW - 60 * 60_000 }] });
    expect(lastSyncedLabel('project:budget-app', s, NOW)).toBe('1 hour ago');
  });
  it('pluralizes hours ("3 hours ago")', () => {
    const s = status({ recentEvents: [{ type: 'synced', spaceId: 'project:budget-app', at: NOW - 3 * 60 * 60_000 }] });
    expect(lastSyncedLabel('project:budget-app', s, NOW)).toBe('3 hours ago');
  });
});

// ---- deriveSyncBoxState (honest-state-machine fix, 2026-07-22) -------------
// Green is EVIDENCE-GATED. The old inline ladder's bare `else` landed a device
// that had never pushed or pulled on green "All synced" (beta.8 macOS VM bug).

describe('deriveSyncBoxState', () => {
  const spaces = (over: Partial<SyncStatusData['spaces'][number]>[] = []) => ([
    { id: 'personal', root: '/p', kind: 'personal' as const, remote: 'https://github.com/u/youcoded-sync-personal.git', lastSyncAt: 1_800_000_000_000 },
    { id: 'project:x', root: '/x', kind: 'project' as const, remote: 'https://github.com/u/r.git', lastSyncAt: 1_800_000_000_000 },
  ].map((s, i) => ({ ...s, ...(over[i] ?? {}) })));
  const base = { pendingEnable: false, enabled: true, hasError: false, githubUnauthed: false, syncing: false };

  it('THE VM PIN: provisioned but never-synced Personal is hydrating, never synced', () => {
    expect(deriveSyncBoxState({ ...base, spaces: spaces([{ lastSyncAt: null }]) })).toBe('hydrating');
  });

  it('a space with no provisioned remote reads as setup, never synced', () => {
    expect(deriveSyncBoxState({ ...base, spaces: spaces([{ remote: null, lastSyncAt: null }]) })).toBe('setup');
  });

  it('an unresolved error wins over everything while enabled', () => {
    expect(deriveSyncBoxState({ ...base, hasError: true, spaces: spaces([{ remote: null, lastSyncAt: null }]) })).toBe('error');
  });

  // "Try again" sets syncing while the old error is still unresolved; letting
  // the error win hid the retry entirely (2026-09-16).
  it('a retry in flight shows syncing, not the error it is retrying', () => {
    expect(deriveSyncBoxState({ ...base, hasError: true, syncing: true, spaces: spaces() })).toBe('syncing');
  });

  it('green only with full evidence: all provisioned + Personal has synced', () => {
    expect(deriveSyncBoxState({ ...base, spaces: spaces() })).toBe('synced');
    expect(deriveSyncBoxState({ ...base, syncing: true, spaces: spaces() })).toBe('syncing');
  });

  it('a stopped project without a remote does not block green (tombstones are inert)', () => {
    expect(deriveSyncBoxState({ ...base, spaces: spaces([{}, { state: 'stopped', remote: null, lastSyncAt: null }]) })).toBe('synced');
  });

  it('a just-created project that has not synced yet does NOT flip the box to hydrating', () => {
    // createProject deliberately waits for the first file change / poll —
    // hydration gating is scoped to Personal (the first-sync long pole).
    expect(deriveSyncBoxState({ ...base, spaces: spaces([{}, { lastSyncAt: null }]) })).toBe('synced');
  });

  it('empty spaces while enabled is still setup (enable round-trip not landed)', () => {
    expect(deriveSyncBoxState({ ...base, spaces: [] })).toBe('setup');
  });

  it('disabled ladder: pending enable → setup; error+unauthed → waiting-github; else off', () => {
    expect(deriveSyncBoxState({ ...base, enabled: false, pendingEnable: true, spaces: [] })).toBe('setup');
    expect(deriveSyncBoxState({ ...base, enabled: false, hasError: true, githubUnauthed: true, spaces: [] })).toBe('waiting-github');
    expect(deriveSyncBoxState({ ...base, enabled: false, hasError: true, spaces: [] })).toBe('off');
    expect(deriveSyncBoxState({ ...base, enabled: false, spaces: [] })).toBe('off');
  });

  it('older payloads without kind/remote/lastSyncAt degrade to setup, not a crash or green', () => {
    expect(deriveSyncBoxState({ ...base, spaces: [{ id: 'personal', root: '/p' }] })).toBe('setup');
  });
});

describe('oversizeNotice', () => {
  const status = (files: string[], oversizeLimitMb?: number): SyncStatusData =>
    ({ enabled: true, spaces: [], recentEvents: [], oversize: [{ spaceId: 'personal', files }], oversizeLimitMb });

  it('says nothing when no file is over the limit, or the host sends no list', () => {
    expect(oversizeNotice(status([]))).toBeNull();
    expect(oversizeNotice({ enabled: true, spaces: [], recentEvents: [] })).toBeNull();
    expect(oversizeNotice(null)).toBeNull();
  });

  it('names conversations as conversations, with the limit the host enforces', () => {
    expect(oversizeNotice(status(['Conversations/claude/transcripts/p/a.jsonl'], 50)))
      .toBe("1 conversation is over the 50 MB sync size limit, so it won't update on your other devices. It stays safe on this device.");
    expect(oversizeNotice(status(['Conversations/a.jsonl', 'Conversations\\b.jsonl'], 50)))
      .toBe("2 conversations are over the 50 MB sync size limit, so they won't update on your other devices. They stay safe on this device.");
  });

  it('calls a mix of anything else files, and omits a limit it was not told', () => {
    expect(oversizeNotice(status(['Conversations/a.jsonl', 'video.mp4'])))
      .toBe("2 files are over the sync size limit, so they won't update on your other devices. They stay safe on this device.");
  });
});
