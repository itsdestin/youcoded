// Pure rules for which artifact records may be archived (shared/artifacts/dead-records.ts).
import { describe, it, expect } from 'vitest';
import type { ArtifactRecord } from '../../src/shared/artifacts/types';
import {
  selectArchivable, classifyMissing, type Probe, type Ledger, type SelectOptions,
} from '../../src/shared/artifacts/dead-records';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-12-01T00:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const ROOT = '/home/u/proj';

function rec(id: string, idleDays: number, extra: Partial<ArtifactRecord> = {}): ArtifactRecord {
  const ts = iso(idleDays * DAY);
  return {
    id, path: `${id}.md`, kind: 'internal', absolutePath: null, lastModified: ts, status: 'active',
    versions: [{ id: `v-${id}`, ts, sessionId: 's', type: 'edit', author: 'agent' }], comments: [], tags: [], ...extra,
  } as ArtifactRecord;
}
const gone = (r: ArtifactRecord, over: Partial<Probe> = {}): Probe => ({
  target: `${ROOT}/${r.path}`, exists: false, errorCode: 'ENOENT',
  ancestor: { path: ROOT, sameDevice: true, readable: true }, ...over,
});
const present = (r: ArtifactRecord): Probe => ({ target: `${ROOT}/${r.path}`, exists: true });
const opts = (over: Partial<SelectOptions> = {}): SelectOptions => ({
  pinned: new Set(), projectRoot: ROOT, tmpDirs: ['/tmp'], minCandidates: 1, minFraction: 0, ...over,
});
const struck = (...ids: string[]): Ledger => Object.fromEntries(ids.map((i) => [i, iso(8 * DAY)]));
const probesOf = (pairs: Array<[ArtifactRecord, Probe]>) => new Map(pairs.map(([r, p]) => [r.id, p]));
/** `n` living records so a lone dead one is not mistaken for an outage. */
const living = (n: number) => Array.from({ length: n }, (_, i) => rec(`live${i}`, 1));

describe('selectArchivable — what qualifies', () => {
  it('missing + 31 days idle + two strikes 8 days apart: archived', () => {
    const r = rec('a', 31);
    const out = selectArchivable([r, ...living(10)], probesOf([[r, gone(r)], ...living(10).map((l): [ArtifactRecord, Probe] => [l, present(l)])]), struck('a'), NOW, opts());
    expect(out.ids).toEqual(['a']);
    expect(out.ledger.a).toBeDefined(); // the caller drops strikes only after the sidecar write commits
  });

  it('first strike only: kept, and the strike is written', () => {
    const r = rec('a', 31);
    const out = selectArchivable([r], probesOf([[r, gone(r)]]), {}, NOW, opts());
    expect(out.ids).toEqual([]);
    expect(out.ledger.a).toBe(new Date(NOW).toISOString());
  });

  it('a strike only 6 days old is not enough', () => {
    const r = rec('a', 31);
    const out = selectArchivable([r], probesOf([[r, gone(r)]]), { a: iso(6 * DAY) }, NOW, opts());
    expect(out.ids).toEqual([]);
  });

  it('the file reappearing clears the strike', () => {
    const r = rec('a', 31);
    const out = selectArchivable([r], probesOf([[r, present(r)]]), struck('a'), NOW, opts());
    expect(out.ids).toEqual([]);
    expect(out.ledger).toEqual({});
  });

  it('29 days idle: kept. Unparseable timestamp: kept', () => {
    const young = rec('y', 29);
    const odd = rec('o', 40, { versions: [{ id: 'v', ts: 'not a date', sessionId: 's', type: 'edit', author: 'agent' }] as any });
    const out = selectArchivable([young, odd], probesOf([[young, gone(young)], [odd, gone(odd)]]), struck('y', 'o'), NOW, opts());
    expect(out.ids).toEqual([]);
  });

  it.each(['EIO', 'EACCES', 'ENOTCONN', 'ETIMEDOUT'])('error code %s means "could not tell": kept, no strike', (code) => {
    const r = rec('a', 40);
    const out = selectArchivable([r], probesOf([[r, gone(r, { errorCode: code })]]), struck('a'), NOW, opts());
    expect(out.ids).toEqual([]);
    expect(out.ledger.a).toBeDefined(); // the old strike is neither cleared nor advanced
  });

  it('ENOTDIR counts as missing', () => {
    const r = rec('a', 40);
    const l = living(10);
    expect(selectArchivable([r, ...l], probesOf([[r, gone(r, { errorCode: 'ENOTDIR' })], ...l.map((x): [ArtifactRecord, Probe] => [x, present(x)])]), struck('a'), NOW, opts()).ids).toEqual(['a']);
  });

  it('an ancestor on a different device, an unreadable ancestor, or no ancestor at all: kept', () => {
    const a = rec('a', 40); const b = rec('b', 40); const c = rec('c', 40);
    const out = selectArchivable([a, b, c], probesOf([
      [a, gone(a, { ancestor: { path: '/mnt/usb', sameDevice: false, readable: true } })],
      [b, gone(b, { ancestor: { path: ROOT, sameDevice: true, readable: false } })],
      [c, gone(c, { ancestor: null })],
    ]), struck('a', 'b', 'c'), NOW, opts());
    expect(out.ids).toEqual([]);
  });

  it('a relative external path (no resolvable target) is kept', () => {
    const r = rec('a', 40, { kind: 'external', absolutePath: '../elsewhere/x.md' });
    const out = selectArchivable([r], probesOf([[r, { target: null, exists: false, errorCode: 'UNRESOLVABLE', ancestor: null }]]), struck('a'), NOW, opts());
    expect(out.ids).toEqual([]);
  });

  it('a path pinned in manualIncludes/manualExcludes is kept', () => {
    const r = rec('a', 40);
    const out = selectArchivable([r], probesOf([[r, gone(r)]]), struck('a'), NOW, opts({ pinned: new Set([`${ROOT}/a.md`]) }));
    expect(out.ids).toEqual([]);
  });

  it('case-insensitive twin: A.md exists, the record says a.md — the stat-based probe says it exists, so it is kept', () => {
    const r = rec('a', 40, { path: 'a.md' });
    // On a case-insensitive filesystem stat("a.md") succeeds; the pure rule only ever sees that answer.
    const out = selectArchivable([r], probesOf([[r, { target: `${ROOT}/a.md`, exists: true }]]), struck('a'), NOW, opts());
    expect(out.ids).toEqual([]);
  });
});

describe('classifyMissing', () => {
  const base: Probe = { target: '/x/y.md', exists: false, errorCode: 'ENOENT', ancestor: { path: '/x', sameDevice: true, readable: true } };
  it('names tmp, worktree-gone and file-gone, and refuses to guess otherwise', () => {
    expect(classifyMissing({ ...base, target: '/tmp/scratch/a.md' }, ['/tmp'])).toBe('tmp');
    expect(classifyMissing({ ...base, target: '/h/youcoded-dev/worktrees/sessions/93-x/src/a.ts' }, ['/tmp'])).toBe('worktree-gone');
    expect(classifyMissing(base, ['/tmp'])).toBe('file-gone');
    expect(classifyMissing({ ...base, errorCode: 'EIO' }, ['/tmp'])).toBe('unknown');
    expect(classifyMissing({ ...base, exists: true }, ['/tmp'])).toBe('unknown');
  });
});

describe('selectArchivable — the brakes', () => {
  it('refuses when most RECENTLY ACTIVE records are missing at once (an outage, not cleanup)', () => {
    const recent = Array.from({ length: 40 }, (_, i) => rec(`r${i}`, 1));
    const old = rec('old', 60);
    const probes = probesOf([...recent.map((r): [ArtifactRecord, Probe] => [r, gone(r)]), [old, gone(old)]]);
    const out = selectArchivable([...recent, old], probes, struck('old'), NOW, opts());
    expect(out.blocked).toBe('outage-suspected');
    expect(out.ids).toEqual([]);
  });

  it('does not mistake a mostly-dead OLD history for an outage while recent files are present', () => {
    const recent = living(40);
    const dead = Array.from({ length: 60 }, (_, i) => rec(`d${i}`, 60 + i));
    const probes = probesOf([...recent.map((r): [ArtifactRecord, Probe] => [r, present(r)]), ...dead.map((r): [ArtifactRecord, Probe] => [r, gone(r)])]);
    const out = selectArchivable([...recent, ...dead], probes, struck(...dead.map((d) => d.id)), NOW, opts());
    expect(out.ids).toHaveLength(60);
  });

  it('size floor: fewer than the minimum candidates rewrites nothing', () => {
    const r = [...living(30), rec('a', 60)];
    const probes = probesOf(r.map((x): [ArtifactRecord, Probe] => [x, x.id === 'a' ? gone(x) : present(x)]));
    const out = selectArchivable(r, probes, struck('a'), NOW, opts({ minCandidates: 500, minFraction: 0.05 }));
    expect(out.blocked).toBe('below-floor');
    expect(out.ids).toEqual([]);
  });

  it('per-run cap: archives the OLDEST-idle first and leaves the rest for the next run', () => {
    const dead = Array.from({ length: 10 }, (_, i) => rec(`d${i}`, 40 + i)); // d9 is the oldest
    const r = [...living(40), ...dead];
    const probes = probesOf(r.map((x): [ArtifactRecord, Probe] => [x, x.id.startsWith('d') ? gone(x) : present(x)]));
    const out = selectArchivable(r, probes, struck(...dead.map((d) => d.id)), NOW, opts({ maxPerRun: 4 }));
    expect(out.blocked).toBe('braked');
    expect(out.ids.sort()).toEqual(['d6', 'd7', 'd8', 'd9']);
    expect(Object.keys(out.ledger).sort()).toEqual(['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9']); // every strike stays until the commit
  });

  it('never more than 70% of all records in one run', () => {
    const dead = Array.from({ length: 9 }, (_, i) => rec(`d${i}`, 50 + i));
    const keep = rec('k', 1);
    const r = [keep, ...dead];
    const probes = probesOf(r.map((x): [ArtifactRecord, Probe] => [x, x.id === 'k' ? present(x) : gone(x)]));
    const out = selectArchivable(r, probes, struck(...dead.map((d) => d.id)), NOW, opts({ maxFractionPerRun: 0.7 }));
    expect(out.ids).toHaveLength(7); // floor(10 * 0.7)
  });
});

describe('selectArchivable — invariants', () => {
  it('is idempotent: running again on what remains selects nothing', () => {
    const dead = Array.from({ length: 5 }, (_, i) => rec(`d${i}`, 50));
    const r = [...living(30), ...dead];
    const probes = probesOf(r.map((x): [ArtifactRecord, Probe] => [x, x.id.startsWith('d') ? gone(x) : present(x)]));
    const first = selectArchivable(r, probes, struck(...dead.map((d) => d.id)), NOW, opts());
    const rest = r.filter((x) => !first.ids.includes(x.id));
    const second = selectArchivable(rest, probesOf(rest.map((x): [ArtifactRecord, Probe] => [x, present(x)])), first.ledger, NOW, opts());
    expect(first.ids).toHaveLength(5);
    expect(second.ids).toEqual([]);
  });

  it('property: ids are always a subset of the input, and a live (present or recent) record is never selected', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let round = 0; round < 50; round++) {
      const records = Array.from({ length: 60 }, (_, i) => rec(`r${i}`, Math.floor(rnd() * 90)));
      const probes = new Map<string, Probe>();
      for (const r of records) probes.set(r.id, rnd() < 0.5 ? present(r) : gone(r, rnd() < 0.2 ? { errorCode: 'EIO' } : {}));
      const ledger = struck(...records.filter(() => rnd() < 0.8).map((r) => r.id));
      const out = selectArchivable(records, probes, ledger, NOW, opts());
      const ids = new Set(records.map((r) => r.id));
      for (const id of out.ids) {
        expect(ids.has(id)).toBe(true);
        const r = records.find((x) => x.id === id)!;
        const p = probes.get(id)!;
        expect(p.exists).toBe(false);
        expect(p.errorCode).toBe('ENOENT');
        expect(NOW - Date.parse(r.lastModified)).toBeGreaterThan(30 * DAY);
      }
    }
  });
});

describe('selectArchivable — offline volumes and stubs', () => {
  const old = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => rec(`${prefix}${i}`, 90, { path: `${prefix}/f${i}.md` }));

  it.each([
    ['a symlink in the way', { viaSymlink: true }],
    ['a mount point', { mountPoint: true }],
    ['an empty folder that is not the project (an unmounted drive\'s stub)', { empty: true }],
  ])('an ancestor that is %s makes the file "could not tell", not "gone"', (_n, extra) => {
    const r = rec('a', 90);
    const p = gone(r, { ancestor: { path: '/mnt/x', sameDevice: true, readable: true, ...extra } });
    expect(classifyMissing(p, ['/tmp'])).toBe('unknown');
  });

  it('an empty PROJECT ROOT ancestor is still trusted (its health is checked separately)', () => {
    const r = rec('a', 90);
    expect(classifyMissing(gone(r, { ancestor: { path: ROOT, sameDevice: true, readable: true, empty: true, isProjectRoot: true } }), ['/tmp'])).toBe('file-gone');
  });

  it.each(['/mnt/usb/a.md', '/media/me/DRIVE/a.md', '/run/media/me/D/a.md', '/Volumes/X/a.md'])('anything under %s might simply be offline: kept', (target) => {
    const r = rec('a', 90);
    expect(classifyMissing(gone(r, { target }), ['/tmp'])).toBe('unknown');
  });

  it('a whole top-level folder that is entirely missing (a drive that went offline) is held back, the rest still cleans', () => {
    const drive = old(30, 'usbdrive');           // all missing, none present
    const worktrees = old(30, 'worktrees');      // mostly missing but some alive: normal clean-up
    const liveWt = rec('lw', 1, { path: 'worktrees/alive.md' });
    const probes = probesOf([
      ...drive.map((r): [ArtifactRecord, Probe] => [r, gone(r)]),
      ...worktrees.map((r): [ArtifactRecord, Probe] => [r, gone(r)]),
      [liveWt, present(liveWt)],
    ]);
    const all = [...drive, ...worktrees, liveWt, ...living(5)];
    for (const l of living(5)) probes.set(l.id, present(l));
    const out = selectArchivable(all, probes, struck(...drive.map((d) => d.id), ...worktrees.map((d) => d.id)), NOW, opts());
    expect(out.vanishedGroups).toEqual(['in:usbdrive']);
    expect(out.ids.sort()).toEqual(worktrees.map((w) => w.id).sort());
  });

  it('paths under the temp folders never count as a vanished folder (gone by design)', () => {
    const tmpRecs = Array.from({ length: 40 }, (_, i) => rec(`t${i}`, 90, { kind: 'external', absolutePath: `/tmp/scratch/f${i}.md`, path: `f${i}.md` }));
    const probes = probesOf(tmpRecs.map((r): [ArtifactRecord, Probe] => [r, gone(r, { target: `/tmp/scratch/${r.path}` })]));
    const out = selectArchivable([...tmpRecs, ...living(40)], new Map([...probes, ...living(40).map((l): [string, Probe] => [l.id, present(l)])]), struck(...tmpRecs.map((t) => t.id)), NOW, opts());
    expect(out.vanishedGroups).toEqual([]);
    expect(out.ids).toHaveLength(40);
  });

  it('a restored record is left alone until its protection date, and archivable after', () => {
    const r = rec('a', 90);
    const args = [[r, ...living(10)], probesOf([[r, gone(r)], ...living(10).map((l): [ArtifactRecord, Probe] => [l, present(l)])]), struck('a'), NOW] as const;
    expect(selectArchivable(...args, opts({ keepUntil: { a: iso(-10 * DAY) } })).ids).toEqual([]);
    expect(selectArchivable(...args, opts({ keepUntil: { a: iso(1 * DAY) } })).ids).toEqual(['a']);
  });
});
