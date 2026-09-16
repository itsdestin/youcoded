import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  pruneVersions,
  pruneSidecarVersions,
  VERSION_RETENTION_DAYS,
  VERSION_RETENTION_FLOOR,
} from '../../src/shared/artifacts/version-retention';
import { appendVersionsDirect, readSidecar, _resetSidecarCacheForTests } from '../../src/main/artifacts/artifact-store';
import { trackedArtifacts } from '../../src/main/artifacts/visible-artifacts';
import type { ProjectSidecar, VersionEvent, VersionType } from '../../src/shared/artifacts/types';
import { SIDECAR_SCHEMA_VERSION } from '../../src/shared/artifacts/types';

const NOW = Date.parse('2026-09-03T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/** A version event `daysAgo` days before NOW. */
function v(daysAgo: number, type: VersionType = 'edit', extra: Partial<VersionEvent> = {}): VersionEvent {
  return {
    id: `v-${daysAgo}-${type}-${extra.toolUseId ?? ''}`,
    ts: new Date(NOW - daysAgo * DAY).toISOString(),
    sessionId: 's1',
    type,
    author: 'agent',
    ...extra,
  };
}

function sidecarOf(versions: VersionEvent[]): ProjectSidecar {
  return {
    $schema: SIDECAR_SCHEMA_VERSION,
    projectId: 'p1',
    name: 'test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    artifacts: [{
      id: 'a1',
      path: 'notes.md',
      kind: 'internal',
      absolutePath: null,
      lastModified: '2026-01-01T00:00:00.000Z',
      status: 'active',
      versions,
      comments: [],
      tags: [],
    }],
    manualExcludes: [],
    manualIncludes: [],
  };
}

describe('pruneVersions — the retention policy', () => {
  it('drops entries older than the retention window', () => {
    // 12 recent + 12 ancient. The ancient ones are past the window AND past the
    // floor (the 12 recent already fill it), so every one of them goes.
    const recent = Array.from({ length: 12 }, (_, i) => v(i));                       // 0..11 days old
    const ancient = Array.from({ length: 12 }, (_, i) => v(VERSION_RETENTION_DAYS + 10 + i));
    const kept = pruneVersions([...ancient, ...recent], NOW);
    expect(kept).toHaveLength(12);
    expect(kept.map((x) => x.id)).toEqual(recent.map((x) => x.id));
  });

  it('keeps everything inside the retention window, however many there are', () => {
    const inside = Array.from({ length: 200 }, (_, i) => v(i % VERSION_RETENTION_DAYS));
    expect(pruneVersions(inside, NOW)).toHaveLength(200);
  });

  it('keeps the FLOOR most recent entries regardless of age', () => {
    // Every entry is ancient — 60 of them, none inside the window.
    const ancient = Array.from({ length: 60 }, (_, i) => v(365 - i));   // oldest first
    const kept = pruneVersions(ancient, NOW);
    expect(kept).toHaveLength(VERSION_RETENTION_FLOOR);
    // The survivors are the newest ones, in their original order.
    expect(kept.map((x) => x.id)).toEqual(ancient.slice(-VERSION_RETENTION_FLOOR).map((x) => x.id));
  });

  it('a record whose history is ENTIRELY ancient keeps its floor rather than being emptied', () => {
    // The safety floor is the reason age-based retention is safe: a project
    // dormant for months must not lose a file's whole history on first touch.
    const ancient = Array.from({ length: 40 }, (_, i) => v(439 - i));   // oldest first, as the store writes them
    const kept = pruneVersions(ancient, NOW);
    expect(kept.length).toBe(VERSION_RETENTION_FLOOR);
    expect(kept.length).toBeGreaterThan(0);
  });

  it('pins the last array slot too, when it disagrees with the newest timestamp', () => {
    // migrate-relative-externals.statusFrom() reads `versions[versions.length - 1]`
    // to re-derive `status`, so the last SLOT is pinned as well as the newest
    // TIMESTAMP. They only differ in a hand-edited or merged file — here the
    // array is deliberately newest-first, and both ends survive.
    const reversed = Array.from({ length: 40 }, (_, i) => v(400 + i));   // newest first
    const kept = pruneVersions(reversed, NOW);
    expect(kept.length).toBe(VERSION_RETENTION_FLOOR + 1);
    expect(kept[0].id).toBe(reversed[0].id);                            // newest timestamp
    expect(kept[kept.length - 1].id).toBe(reversed[reversed.length - 1].id);  // last slot
  });

  it('never drops the version representing the file\'s current state', () => {
    // The newest entry is a 'delete' two years old, surrounded by older noise.
    // `status` is derived from the latest version, so losing it would flip a
    // deleted file back to active.
    const history = [
      ...Array.from({ length: 30 }, (_, i) => v(900 - i)),
      v(500, 'delete'),
    ];
    const kept = pruneVersions(history, NOW);
    expect(kept[kept.length - 1].type).toBe('delete');
    expect(kept[kept.length - 1].id).toBe(history[history.length - 1].id);
  });

  it('is idempotent — pruning twice changes nothing', () => {
    const history = [
      ...Array.from({ length: 40 }, (_, i) => v(300 - i)),
      ...Array.from({ length: 5 }, (_, i) => v(i)),
    ];
    const once = pruneVersions(history, NOW);
    const twice = pruneVersions(once, NOW);
    // Same reference back means the second pass found nothing to drop.
    expect(twice).toBe(once);
    expect(twice).toEqual(once);
  });

  it('returns the SAME array when nothing is dropped', () => {
    const small = [v(1000), v(999)];
    expect(pruneVersions(small, NOW)).toBe(small);
  });

  it('keeps the newest non-read entry so the file stays visible in Project View', () => {
    // trackedArtifacts() rule 3: an internal record shows only while it has a
    // non-'read' version. A file created long ago and merely opened since must
    // not be pruned into invisibility.
    // 'create' 400 days ago, then 30 views spread over days 100..71 — all
    // ancient, so the floor alone would keep 10 reads and throw the create away.
    const history = [
      v(400, 'create'),
      ...Array.from({ length: 30 }, (_, i) => v(100 - i, 'read')),
    ];
    const kept = pruneVersions(history, NOW);
    expect(kept.some((x) => x.type !== 'read')).toBe(true);
    expect(kept.some((x) => x.type === 'create')).toBe(true);

    // …and the predicate that actually gates the UI agrees, before and after.
    const before = trackedArtifacts(sidecarOf(history).artifacts, [], [], '/proj');
    const after = trackedArtifacts(sidecarOf(kept).artifacts, [], [], '/proj');
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
  });

  it('keeps entries whose timestamp cannot be parsed', () => {
    // A retention rule must only remove what it can PROVE is old. A
    // hand-edited or foreign sidecar is left alone rather than guessed at.
    const history = [
      ...Array.from({ length: 20 }, (_, i) => v(500 + i)),
      { id: 'bad', ts: 'not-a-date', sessionId: 's1', type: 'edit' as const, author: 'agent' as const },
    ];
    const kept = pruneVersions(history, NOW);
    expect(kept.some((x) => x.id === 'bad')).toBe(true);
  });

  it('pruneSidecarVersions reports how much it removed and leaves a clean sidecar alone', () => {
    const dirty = sidecarOf(Array.from({ length: 40 }, (_, i) => v(500 - i)));
    expect(pruneSidecarVersions(dirty, NOW)).toBe(40 - VERSION_RETENTION_FLOOR);
    expect(dirty.artifacts[0].versions).toHaveLength(VERSION_RETENTION_FLOOR);
    expect(pruneSidecarVersions(dirty, NOW)).toBe(0);

    const clean = sidecarOf([v(1), v(2)]);
    expect(pruneSidecarVersions(clean, NOW)).toBe(0);
  });
});

describe('the sidecar is pruned on the write path', () => {
  let projectRoot: string;
  beforeEach(() => {
    _resetSidecarCacheForTests();
    projectRoot = mkdtempSync(join(tmpdir(), 'as-retain-'));
    mkdirSync(join(projectRoot, '.youcoded'));
  });

  it('an already-oversized file heals on its next write — no migration needed', async () => {
    // 60 entries, all two years old. Written by an older app version that had
    // no retention rule; nothing runs at startup to fix it.
    const old = sidecarOf(Array.from({ length: 60 }, (_, i) => v(700 - i)));
    writeFileSync(join(projectRoot, '.youcoded/artifacts.json'), JSON.stringify(old, null, 2));
    const bytesBefore = readFileSync(join(projectRoot, '.youcoded/artifacts.json')).length;

    await appendVersionsDirect(projectRoot, 'p1', 'test', [{
      path: 'notes.md', kind: 'internal', absolutePath: null,
      sessionId: 's2', type: 'edit', author: 'agent', toolUseId: 'toolu_new',
    }]);

    const after = await readSidecar(projectRoot);
    if (!after || 'corrupted' in after) throw new Error('sidecar unreadable');
    // The floor is a total, and the entry just appended is the newest of them.
    expect(after.artifacts[0].versions).toHaveLength(VERSION_RETENTION_FLOOR);
    expect(after.artifacts[0].versions.at(-1)?.toolUseId).toBe('toolu_new');
    expect(readFileSync(join(projectRoot, '.youcoded/artifacts.json')).length).toBeLessThan(bytesBefore);
  });

  it('a pure-dedupe append still writes nothing, pruning or not', async () => {
    // The "a re-opened conversation leaves the sidecar byte-identical"
    // invariant lives ABOVE the prune call; this pins that ordering.
    const input = {
      path: 'notes.md', kind: 'internal' as const, absolutePath: null,
      sessionId: 's1', type: 'edit' as const, author: 'agent' as const, toolUseId: 'toolu_A',
    };
    await appendVersionsDirect(projectRoot, 'p1', 'test', [input]);
    const bytes = readFileSync(join(projectRoot, '.youcoded/artifacts.json'), 'utf8');
    await appendVersionsDirect(projectRoot, 'p1', 'test', [input]);
    expect(readFileSync(join(projectRoot, '.youcoded/artifacts.json'), 'utf8')).toBe(bytes);
  });

  it('a normal recent history is not touched by the write path', async () => {
    for (let i = 0; i < 25; i++) {
      await appendVersionsDirect(projectRoot, 'p1', 'test', [{
        path: 'notes.md', kind: 'internal', absolutePath: null,
        sessionId: 's1', type: 'edit', author: 'agent', toolUseId: `toolu_${i}`,
      }]);
    }
    const after = await readSidecar(projectRoot);
    if (!after || 'corrupted' in after) throw new Error('sidecar unreadable');
    expect(after.artifacts[0].versions).toHaveLength(25);
  });
});
