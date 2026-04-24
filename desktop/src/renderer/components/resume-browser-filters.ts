// resume-browser-filters.ts
// Pure helpers for the Resume Browser's filter / group / sort pipeline.
// Extracted out of ResumeBrowser.tsx so the logic is unit-testable without
// rendering the component or mocking IPC. Imported by ResumeBrowser.tsx.

// Mirrors the FlagName + PastSession type defined inline in ResumeBrowser.tsx.
// Kept structurally compatible (PastSessionLike is a subset) so the component
// can pass its own typed sessions in directly.
export type FlagName = 'priority' | 'helpful' | 'complete';

export interface PastSessionLike {
  sessionId: string;
  name: string;
  projectSlug: string;
  projectPath: string;
  lastModified: number;
  size: number;
  flags?: Partial<Record<FlagName, boolean>>;
}

export interface FilterState {
  search: string;
  showComplete: boolean;
  stickyComplete: Set<string>;
  selectedProjects: Set<string>;
  selectedTags: Set<FlagName>;
}

// Apply Show Complete + sticky + project + tag + search, in that order.
// Order matches the existing inline pipeline in ResumeBrowser.tsx so the
// refactor is a behaviour-preserving lift.
export function applyFilters<T extends PastSessionLike>(sessions: T[], state: FilterState): T[] {
  const completeFiltered = state.showComplete
    ? sessions
    : sessions.filter((s) => !s.flags?.complete || state.stickyComplete.has(s.sessionId));

  const projectFiltered = state.selectedProjects.size === 0
    ? completeFiltered
    : completeFiltered.filter((s) => state.selectedProjects.has(s.projectPath));

  const tagFiltered = state.selectedTags.size === 0
    ? projectFiltered
    : projectFiltered.filter((s) => {
        for (const tag of state.selectedTags) {
          if (s.flags?.[tag]) return true;
        }
        return false;
      });

  if (!state.search.trim()) return tagFiltered;
  const q = state.search.toLowerCase();
  return tagFiltered.filter(
    (s) => s.name.toLowerCase().includes(q) || s.projectPath.toLowerCase().includes(q),
  );
}

// Pure sort: priority sessions pinned to top, then lastModified by direction.
// Returns a new array; does not mutate the input.
export function sortSessions<T extends PastSessionLike>(
  sessions: T[],
  sortDir: 'asc' | 'desc',
): T[] {
  return [...sessions].sort((a, b) => {
    const ap = a.flags?.priority ? 0 : 1;
    const bp = b.flags?.priority ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return sortDir === 'desc' ? b.lastModified - a.lastModified : a.lastModified - b.lastModified;
  });
}

// Group by projectPath. Within each group, sort by sortSessions. Between groups,
// order by an anchor lastModified in the chosen direction:
//   - 'desc' anchor = max(lastModified) in the group (newest-first feels right)
//   - 'asc'  anchor = min(lastModified) in the group (oldest-first feels right)
// Map iteration order is insertion order, so we sort the keys before inserting.
export function groupSessions<T extends PastSessionLike>(
  sessions: T[],
  sortDir: 'asc' | 'desc',
): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const s of sessions) {
    const list = buckets.get(s.projectPath);
    if (list) list.push(s);
    else buckets.set(s.projectPath, [s]);
  }

  const anchor = (arr: T[]): number => {
    let value = arr[0].lastModified;
    for (const s of arr) {
      if (sortDir === 'desc' ? s.lastModified > value : s.lastModified < value) value = s.lastModified;
    }
    return value;
  };

  const orderedKeys = [...buckets.keys()].sort((ka, kb) => {
    const va = anchor(buckets.get(ka)!);
    const vb = anchor(buckets.get(kb)!);
    return sortDir === 'desc' ? vb - va : va - vb;
  });

  const out = new Map<string, T[]>();
  for (const k of orderedKeys) {
    out.set(k, sortSessions(buckets.get(k)!, sortDir));
  }
  return out;
}

// Distinct projectPaths with display labels and counts, alphabetical by label.
// Display label is the last path segment (matches the existing group header
// convention in ResumeBrowser.tsx).
export function getAvailableProjects<T extends PastSessionLike>(
  sessions: T[],
): Array<{ path: string; label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const s of sessions) counts.set(s.projectPath, (counts.get(s.projectPath) ?? 0) + 1);
  const result = [...counts.entries()].map(([path, count]) => ({
    path,
    label: lastSegment(path),
    count,
  }));
  result.sort((a, b) => a.label.localeCompare(b.label));
  return result;
}

function lastSegment(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const last = parts[parts.length - 1];
  return last || path;
}
