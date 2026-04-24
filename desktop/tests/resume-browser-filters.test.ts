// @vitest-environment jsdom
// resume-browser-filters.test.ts
// Pure-function tests for the Resume Browser filter pipeline:
// applyFilters (search + Show Complete + project + tag),
// sortSessions (priority pin + asc/desc),
// groupSessions (within-group + between-group ordering),
// getAvailableProjects (distinct paths + counts).

import { describe, it, expect } from 'vitest';
import {
  applyFilters,
  sortSessions,
  groupSessions,
  getAvailableProjects,
  type FilterState,
  type PastSessionLike,
} from '../src/renderer/components/resume-browser-filters';

const session = (over: Partial<PastSessionLike>): PastSessionLike => ({
  sessionId: over.sessionId ?? 's-' + Math.random().toString(36).slice(2, 8),
  name: 'session',
  projectSlug: over.projectSlug ?? 'youcoded',
  projectPath: over.projectPath ?? '/home/dev/youcoded',
  lastModified: over.lastModified ?? 1_000_000,
  size: over.size ?? 100,
  flags: over.flags,
  ...over,
});

const baseFilter: FilterState = {
  search: '',
  showComplete: false,
  stickyComplete: new Set(),
  selectedProjects: new Set(),
  selectedTags: new Set(),
};

describe('applyFilters', () => {
  it('hides complete sessions when showComplete=false and not in stickyComplete', () => {
    const a = session({ sessionId: 'a', flags: { complete: true } });
    const b = session({ sessionId: 'b' });
    const out = applyFilters([a, b], baseFilter);
    expect(out.map((s) => s.sessionId)).toEqual(['b']);
  });

  it('keeps sticky-complete sessions even when showComplete=false', () => {
    const a = session({ sessionId: 'a', flags: { complete: true } });
    const b = session({ sessionId: 'b' });
    const out = applyFilters([a, b], { ...baseFilter, stickyComplete: new Set(['a']) });
    expect(out.map((s) => s.sessionId).sort()).toEqual(['a', 'b']);
  });

  it('shows complete sessions when showComplete=true', () => {
    const a = session({ sessionId: 'a', flags: { complete: true } });
    const b = session({ sessionId: 'b' });
    const out = applyFilters([a, b], { ...baseFilter, showComplete: true });
    expect(out.map((s) => s.sessionId).sort()).toEqual(['a', 'b']);
  });

  it('matches search against name OR projectPath, case-insensitive', () => {
    const a = session({ sessionId: 'a', name: 'Refactor sync', projectPath: '/home/x' });
    const b = session({ sessionId: 'b', name: 'Other', projectPath: '/home/youcoded-core' });
    const c = session({ sessionId: 'c', name: 'Other', projectPath: '/home/x' });
    const hits = applyFilters([a, b, c], { ...baseFilter, search: 'YOUCODED' });
    expect(hits.map((s) => s.sessionId).sort()).toEqual(['b']);
    const hits2 = applyFilters([a, b, c], { ...baseFilter, search: 'refactor' });
    expect(hits2.map((s) => s.sessionId).sort()).toEqual(['a']);
  });

  it('empty selectedProjects = no project narrowing', () => {
    const a = session({ sessionId: 'a', projectPath: '/p1' });
    const b = session({ sessionId: 'b', projectPath: '/p2' });
    const out = applyFilters([a, b], baseFilter);
    expect(out.map((s) => s.sessionId).sort()).toEqual(['a', 'b']);
  });

  it('non-empty selectedProjects narrows to matching projectPath', () => {
    const a = session({ sessionId: 'a', projectPath: '/p1' });
    const b = session({ sessionId: 'b', projectPath: '/p2' });
    const c = session({ sessionId: 'c', projectPath: '/p3' });
    const out = applyFilters([a, b, c], { ...baseFilter, selectedProjects: new Set(['/p1', '/p3']) });
    expect(out.map((s) => s.sessionId).sort()).toEqual(['a', 'c']);
  });

  it('empty selectedTags = no tag narrowing', () => {
    const a = session({ sessionId: 'a', flags: { priority: true } });
    const b = session({ sessionId: 'b' });
    const out = applyFilters([a, b], baseFilter);
    expect(out.map((s) => s.sessionId).sort()).toEqual(['a', 'b']);
  });

  it('non-empty selectedTags = OR match across selected flags', () => {
    const a = session({ sessionId: 'a', flags: { priority: true } });
    const b = session({ sessionId: 'b', flags: { helpful: true } });
    const c = session({ sessionId: 'c' });
    const out = applyFilters([a, b, c], { ...baseFilter, selectedTags: new Set(['priority', 'helpful']) });
    expect(out.map((s) => s.sessionId).sort()).toEqual(['a', 'b']);
    const onlyPriority = applyFilters([a, b, c], { ...baseFilter, selectedTags: new Set(['priority']) });
    expect(onlyPriority.map((s) => s.sessionId)).toEqual(['a']);
  });

  it('all filters compose AND', () => {
    const a = session({ sessionId: 'a', name: 'good', projectPath: '/p1', flags: { priority: true } });
    const b = session({ sessionId: 'b', name: 'good', projectPath: '/p2', flags: { priority: true } });
    const c = session({ sessionId: 'c', name: 'bad', projectPath: '/p1', flags: { priority: true } });
    const d = session({ sessionId: 'd', name: 'good', projectPath: '/p1' });
    const out = applyFilters([a, b, c, d], {
      ...baseFilter,
      search: 'good',
      selectedProjects: new Set(['/p1']),
      selectedTags: new Set(['priority']),
    });
    expect(out.map((s) => s.sessionId)).toEqual(['a']);
  });
});

describe('sortSessions', () => {
  it('pins priority to top regardless of direction', () => {
    const a = session({ sessionId: 'a', lastModified: 100 });
    const b = session({ sessionId: 'b', lastModified: 200, flags: { priority: true } });
    const c = session({ sessionId: 'c', lastModified: 300 });
    const desc = sortSessions([a, b, c], 'desc');
    expect(desc.map((s) => s.sessionId)).toEqual(['b', 'c', 'a']);
    const asc = sortSessions([a, b, c], 'asc');
    expect(asc.map((s) => s.sessionId)).toEqual(['b', 'a', 'c']);
  });

  it('non-priority sorts by lastModified in chosen direction', () => {
    const a = session({ sessionId: 'a', lastModified: 100 });
    const b = session({ sessionId: 'b', lastModified: 200 });
    const c = session({ sessionId: 'c', lastModified: 300 });
    expect(sortSessions([a, b, c], 'desc').map((s) => s.sessionId)).toEqual(['c', 'b', 'a']);
    expect(sortSessions([a, b, c], 'asc').map((s) => s.sessionId)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate input', () => {
    const arr = [session({ sessionId: 'a', lastModified: 100 }), session({ sessionId: 'b', lastModified: 200 })];
    const before = arr.map((s) => s.sessionId);
    sortSessions(arr, 'asc');
    expect(arr.map((s) => s.sessionId)).toEqual(before);
  });
});

describe('groupSessions', () => {
  it('groups by projectPath and sorts within each group with priority pin', () => {
    const a = session({ sessionId: 'a', projectPath: '/p1', lastModified: 100 });
    const b = session({ sessionId: 'b', projectPath: '/p1', lastModified: 200, flags: { priority: true } });
    const c = session({ sessionId: 'c', projectPath: '/p1', lastModified: 300 });
    const groups = groupSessions([a, b, c], 'desc');
    expect([...groups.keys()]).toEqual(['/p1']);
    expect(groups.get('/p1')!.map((s) => s.sessionId)).toEqual(['b', 'c', 'a']);
  });

  it('orders groups between each other by anchor in chosen direction (desc = newest first)', () => {
    const p1Old = session({ sessionId: 'a', projectPath: '/p1', lastModified: 100 });
    const p2New = session({ sessionId: 'b', projectPath: '/p2', lastModified: 1000 });
    const groups = groupSessions([p1Old, p2New], 'desc');
    expect([...groups.keys()]).toEqual(['/p2', '/p1']);
  });

  it('orders groups between each other by anchor in chosen direction (asc = oldest first)', () => {
    const p1Old = session({ sessionId: 'a', projectPath: '/p1', lastModified: 100 });
    const p2New = session({ sessionId: 'b', projectPath: '/p2', lastModified: 1000 });
    const groups = groupSessions([p1Old, p2New], 'asc');
    expect([...groups.keys()]).toEqual(['/p1', '/p2']);
  });

  it('group anchor uses newest member when desc, oldest when asc', () => {
    const p1Old = session({ sessionId: 'a', projectPath: '/p1', lastModified: 100 });
    const p1New = session({ sessionId: 'b', projectPath: '/p1', lastModified: 1000 });
    const p2 = session({ sessionId: 'c', projectPath: '/p2', lastModified: 500 });
    expect([...groupSessions([p1Old, p1New, p2], 'desc').keys()]).toEqual(['/p1', '/p2']);
    expect([...groupSessions([p1Old, p1New, p2], 'asc').keys()]).toEqual(['/p1', '/p2']);
  });
});

describe('getAvailableProjects', () => {
  it('returns distinct projectPaths with counts and last-segment labels, alphabetical', () => {
    const list = [
      session({ projectPath: '/home/dev/youcoded' }),
      session({ projectPath: '/home/dev/youcoded' }),
      session({ projectPath: '/home/dev/core' }),
      session({ projectPath: '/home/dev/youcoded' }),
    ];
    const out = getAvailableProjects(list);
    expect(out).toEqual([
      { path: '/home/dev/core', label: 'core', count: 1 },
      { path: '/home/dev/youcoded', label: 'youcoded', count: 3 },
    ]);
  });

  it('uses the last path segment for the label, normalizing backslashes', () => {
    const out = getAvailableProjects([session({ projectPath: 'C:\\Users\\dev\\proj-a' })]);
    expect(out).toEqual([{ path: 'C:\\Users\\dev\\proj-a', label: 'proj-a', count: 1 }]);
  });

  it('falls back to the full path if there is no separator', () => {
    const out = getAvailableProjects([session({ projectPath: 'singletoken' })]);
    expect(out).toEqual([{ path: 'singletoken', label: 'singletoken', count: 1 }]);
  });

  it('sorts case-insensitively so capitalized labels interleave with lowercase ones', () => {
    const list = [
      session({ projectPath: '/x/ZebraProject' }),
      session({ projectPath: '/x/apps' }),
      session({ projectPath: '/x/Banana' }),
    ];
    const out = getAvailableProjects(list);
    expect(out.map((p) => p.label)).toEqual(['apps', 'Banana', 'ZebraProject']);
  });
});
