import { describe, expect, it } from 'vitest';
import {
  normalizeSpecialistStatusSnapshot,
  recoverSpecialistStatusSnapshot,
  specialistStatusUpdate,
  type SpecialistStatusSnapshotRecord,
} from '../src/main/harness/specialists/status-snapshot';

function record(overrides: Partial<SpecialistStatusSnapshotRecord> = {}): SpecialistStatusSnapshotRecord {
  return {
    childId: 'child-b',
    title: 'Nadia',
    agentType: 'explorer',
    status: 'running',
    delivered: false,
    stale: false,
    startedAt: 1_000,
    ...overrides,
  };
}

describe('specialist status snapshots', () => {
  it('sorts by stable child id and ignores elapsed time when deciding equality', () => {
    const first = normalizeSpecialistStatusSnapshot([
      record({ childId: 'child-b', startedAt: 1_000 }),
      record({ childId: 'child-a', title: 'Otis', startedAt: 2_000 }),
    ]);
    const later = normalizeSpecialistStatusSnapshot([
      record({ childId: 'child-a', title: 'Otis', startedAt: 2_000 }),
      record({ childId: 'child-b', startedAt: 1_000 }),
    ]);

    const initial = specialistStatusUpdate(null, first, 10_000);
    expect(initial?.message.indexOf('Otis')).toBeLessThan(initial!.message.indexOf('Nadia'));
    expect(specialistStatusUpdate(initial!.snapshot, later, 40_000)).toBeNull();
  });

  it.each([
    ['lifecycle', { status: 'completed' as const }],
    ['delivery', { delivered: true }],
    ['stale', { stale: true }],
    ['report', { rawReport: 'new report' }],
    ['failure', { status: 'failed' as const, failureText: 'boom' }],
  ])('appends a superseding snapshot for a meaningful %s change', (_name, change) => {
    const before = normalizeSpecialistStatusSnapshot([record()]);
    const after = normalizeSpecialistStatusSnapshot([record(change)]);
    const update = specialistStatusUpdate(before, after, 5_000);

    expect(update).not.toBeNull();
    expect(update!.message).toContain('supersedes all earlier specialist status snapshots');
  });

  it('renders completed and failed undelivered records as pending reports with the real failure', () => {
    const snapshot = normalizeSpecialistStatusSnapshot([
      record({ childId: 'completed', title: 'Otis', status: 'completed', rawReport: 'done' }),
      record({ childId: 'failed', title: 'Fiona', status: 'failed', failureText: 'ENOENT: missing input' }),
    ]);
    const update = specialistStatusUpdate(null, snapshot, 5_000);

    expect(update?.snapshot.records.map((entry) => entry.status)).toEqual(['completed', 'failed']);
    expect(update?.message).toContain('Otis (explorer): finished — report delivery pending');
    expect(update?.message).toContain('Fiona (explorer): failed — ENOENT: missing input — report delivery pending');
    expect(update?.message).not.toContain('No specialist status is currently reportable.');
  });

  it('emits one clearing update after a nonempty snapshot, then suppresses repeats', () => {
    const before = normalizeSpecialistStatusSnapshot([record()]);
    const empty = normalizeSpecialistStatusSnapshot([]);
    const clearing = specialistStatusUpdate(before, empty, 5_000);

    expect(clearing?.message).toContain('No specialist status is currently reportable.');
    expect(specialistStatusUpdate(clearing!.snapshot, empty, 6_000)).toBeNull();
    expect(specialistStatusUpdate(null, empty, 6_000)).toBeNull();
  });

  it.each([
    [{ version: 1, records: [null] }],
    [{ version: 1, records: [{ childId: 'x' }] }],
    [{ version: 1, records: [{ ...normalizeSpecialistStatusSnapshot([record()]).records[0], startedAt: null }] }],
    [{ version: 1, records: [{ ...normalizeSpecialistStatusSnapshot([record()]).records[0], startedAt: Number.POSITIVE_INFINITY }] }],
    [{ version: 1, records: [{ ...normalizeSpecialistStatusSnapshot([record()]).records[0], status: 'unknown' }] }],
  ])('rejects malformed decoded record schemas before recovery (%j)', (payload) => {
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    expect(recoverSpecialistStatusSnapshot([{
      role: 'user',
      content: `<specialists-status>\n<!-- snapshot-v1:${encoded} -->\n</specialists-status>`,
    }] as any)).toBeNull();
  });

  it('recovers the newest authoritative structured snapshot from retained history', () => {
    const first = specialistStatusUpdate(null, normalizeSpecialistStatusSnapshot([record()]), 5_000)!;
    const changed = specialistStatusUpdate(first.snapshot, normalizeSpecialistStatusSnapshot([
      record({ status: 'failed', failureText: 'boom' }),
    ]), 6_000)!;

    expect(recoverSpecialistStatusSnapshot([
      { role: 'user', content: first.message },
      { role: 'assistant', content: 'working' },
      { role: 'user', content: changed.message },
    ] as any)).toEqual(changed.snapshot);
  });
});
