import { describe, expect, it } from 'vitest';
import { findBestMatch, buildArtifactifyArgs } from '../../src/renderer/components/filepath-match';
import type { ArtifactRecord } from '../../src/shared/artifacts/types';

function art(partial: Partial<ArtifactRecord> & { id: string }): ArtifactRecord {
  return {
    path: '',
    kind: 'internal',
    absolutePath: null,
    status: 'active',
    lastModified: '',
    versions: [],
    comments: [],
    tags: [],
    ...partial,
  } as unknown as ArtifactRecord;
}

describe('findBestMatch', () => {
  it('prefers an exact match over an earlier suffix match', () => {
    // Two config.json files: the suffix-matching one comes FIRST in the array.
    // The old OR'd predicate returned it; exact must win now.
    const list = [
      art({ id: 'other', path: 'packages/a/config.json' }),
      art({ id: 'exact', path: 'src/config.json' }),
    ];
    expect(findBestMatch(list, 'src/config.json')?.id).toBe('exact');
  });

  it('falls back to suffix matching in both directions', () => {
    const list = [art({ id: 'a', path: 'youcoded/desktop/src/x.ts' })];
    // clicked path is a SUFFIX of the artifact path
    expect(findBestMatch(list, 'desktop/src/x.ts')?.id).toBe('a');
    // artifact path is a SUFFIX of the clicked path
    const list2 = [art({ id: 'b', path: 'src/x.ts' })];
    expect(findBestMatch(list2, 'C:/proj/src/x.ts')?.id).toBe('b');
  });

  it('matches case-insensitively (Windows paths)', () => {
    const list = [art({ id: 'w', kind: 'external', path: 'Report.xlsx', absolutePath: 'C:\\Temp\\Report.xlsx' })];
    expect(findBestMatch(list, 'c:/temp/report.xlsx')?.id).toBe('w');
  });

  it('returns undefined when nothing matches', () => {
    const list = [art({ id: 'a', path: 'src/x.ts' })];
    expect(findBestMatch(list, 'docs/plan.md')).toBeUndefined();
  });

  it('does not suffix-match against empty artifact paths', () => {
    const list = [art({ id: 'broken', kind: 'external', path: 'x', absolutePath: null })];
    expect(findBestMatch(list, 'docs/plan.md')).toBeUndefined();
  });
});

// The wrong-file bug found on the owner's phone (2026-09-11): tapping
// /home/destin/youcoded-dev/wecoded-themes/CLAUDE.md opened the workspace ROOT
// CLAUDE.md, because the suffix pass matched `.../CLAUDE.md` against the root
// record `CLAUDE.md`. With the session's folder known, an ABSOLUTE click is
// compared only as a full absolute path — a same-named file elsewhere is not it.
describe('findBestMatch with the session folder (exact absolute matching)', () => {
  const cwd = '/home/destin/youcoded-dev';

  it('an absolute path in another directory never matches a same-named record', () => {
    const list = [art({ id: 'root-claude', path: 'CLAUDE.md' })];
    expect(findBestMatch(list, '/home/destin/youcoded-dev/wecoded-themes/CLAUDE.md', cwd)).toBeUndefined();
  });

  it('an absolute path matches the internal record at exactly that place', () => {
    const list = [
      art({ id: 'root-claude', path: 'CLAUDE.md' }),
      art({ id: 'themes-claude', path: 'wecoded-themes/CLAUDE.md' }),
    ];
    expect(findBestMatch(list, '/home/destin/youcoded-dev/wecoded-themes/CLAUDE.md', cwd)?.id).toBe('themes-claude');
    expect(findBestMatch(list, '/home/destin/youcoded-dev/CLAUDE.md', cwd)?.id).toBe('root-claude');
  });

  it('an external record matches only by its full absolute path', () => {
    const list = [art({ id: 'ext', kind: 'external', path: 'report.xlsx', absolutePath: '/tmp/out/report.xlsx' })];
    expect(findBestMatch(list, '/tmp/out/report.xlsx', cwd)?.id).toBe('ext');
    expect(findBestMatch(list, '/tmp/other/report.xlsx', cwd)).toBeUndefined();
  });

  it('keeps Windows drive paths and case differences matching', () => {
    const list = [art({ id: 'w', path: 'src/X.ts' })];
    expect(findBestMatch(list, 'c:\\Users\\Desti\\Proj\\src\\x.ts', 'C:\\Users\\desti\\proj')?.id).toBe('w');
    expect(findBestMatch(list, 'C:/Users/desti/proj/other/src/x.ts', 'C:\\Users\\desti\\proj')).toBeUndefined();
  });

  it('a RELATIVE click keeps the suffix fallback even when the folder is known', () => {
    const list = [art({ id: 'a', path: 'youcoded/desktop/src/x.ts' })];
    expect(findBestMatch(list, 'desktop/src/x.ts', cwd)?.id).toBe('a');
  });
});

describe('buildArtifactifyArgs', () => {
  const cwd = 'C:\\Users\\desti\\project';

  it('classifies a path under cwd as internal with a relative path', () => {
    const args = buildArtifactifyArgs('C:/Users/desti/project/docs/plan.md', cwd);
    expect(args).toEqual({
      path: 'docs/plan.md', kind: 'internal', absolutePath: null, type: 'read', author: 'user',
    });
  });

  it('resolves bare relative paths against cwd (internal)', () => {
    const args = buildArtifactifyArgs('docs/plan.md', cwd);
    expect(args?.kind).toBe('internal');
    expect(args?.path).toBe('docs/plan.md');
  });

  it('strips ./ prefixes', () => {
    expect(buildArtifactifyArgs('./docs/plan.md', cwd)?.path).toBe('docs/plan.md');
  });

  it('classifies ../ paths as EXTERNAL after resolving dots', () => {
    // The old inline version left `..` unresolved, so `cwd/../sibling/x.md`
    // still string-started-with cwd → wrongly classified internal with a
    // `..`-containing relative path persisted to the sidecar.
    const args = buildArtifactifyArgs('../sibling/x.md', cwd);
    expect(args?.kind).toBe('external');
    expect(args?.absolutePath).toBe('c:/Users/desti/sibling/x.md');
    expect(args?.path).toBe('x.md');
  });

  it('resolves ../ that stays INSIDE the project as internal', () => {
    const args = buildArtifactifyArgs('docs/../src/x.md', cwd);
    expect(args?.kind).toBe('internal');
    expect(args?.path).toBe('src/x.md');
  });

  it('classifies an absolute path outside cwd as external', () => {
    const args = buildArtifactifyArgs('C:/Users/desti/AppData/Local/Temp/report.xlsx', cwd);
    expect(args?.kind).toBe('external');
    expect(args?.absolutePath).toBe('c:/Users/desti/AppData/Local/Temp/report.xlsx');
    expect(args?.path).toBe('report.xlsx');
  });

  it('is drive-letter-case-insensitive when classifying internal', () => {
    const args = buildArtifactifyArgs('c:/users/desti/project/a.md', 'C:/users/desti/project');
    expect(args?.kind).toBe('internal');
  });

  it('returns null for ~/ paths (renderer cannot expand home)', () => {
    expect(buildArtifactifyArgs('~/Documents/x.md', cwd)).toBeNull();
  });
});
