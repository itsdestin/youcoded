// resume-browser-filters.ts
// Pure helpers for the Resume Browser's filter / group / sort pipeline.
// Extracted out of ResumeBrowser.tsx so the logic is unit-testable without
// rendering the component or mocking IPC. Imported by ResumeBrowser.tsx.

// Mirrors the FlagName + PastSession type defined inline in ResumeBrowser.tsx.
// Kept structurally compatible (PastSessionLike is a subset) so the component
// can pass its own typed sessions in directly.
export type FlagName = 'priority' | 'complete';

export interface PastSessionLike {
  sessionId: string;
  name: string;
  projectSlug: string;
  projectPath: string;
  lastModified: number;
  size: number;
  flags?: Partial<Record<FlagName, boolean>>;
  tags?: string[];      // applied custom-tag ids
  note?: string;
}

export interface FilterState {
  search: string;
  showComplete: boolean;
  stickyComplete: Set<string>;
  selectedProjects: Set<string>;
  selectedTagIds: Set<string>;          // custom-tag ids (replaces the old flag-tag set)
  tagLabelById: Record<string, string>; // id → label, for search
}

// Apply Show Complete + sticky + project + custom-tag + search, in that order.
// Order matches the existing inline pipeline in ResumeBrowser.tsx so the
// refactor is a behaviour-preserving lift. Search matches name, projectPath,
// the session note, and any applied-tag label (resolved via tagLabelById).
export function applyFilters<T extends PastSessionLike>(sessions: T[], state: FilterState): T[] {
  const completeFiltered = state.showComplete
    ? sessions
    : sessions.filter((s) => !s.flags?.complete || state.stickyComplete.has(s.sessionId));

  const projectFiltered = state.selectedProjects.size === 0
    ? completeFiltered
    : completeFiltered.filter((s) => state.selectedProjects.has(s.projectPath));

  const tagFiltered = state.selectedTagIds.size === 0
    ? projectFiltered
    : projectFiltered.filter((s) => (s.tags ?? []).some((id) => state.selectedTagIds.has(id)));

  if (!state.search.trim()) return tagFiltered;
  const q = state.search.toLowerCase();
  return tagFiltered.filter((s) => {
    if (s.name.toLowerCase().includes(q)) return true;
    if (s.projectPath.toLowerCase().includes(q)) return true;
    if ((s.note ?? '').toLowerCase().includes(q)) return true;
    // Applied-tag labels (resolved via the id→label map).
    return (s.tags ?? []).some((id) => (state.tagLabelById[id] ?? '').toLowerCase().includes(q));
  });
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

// Distinct projectPaths with display labels and counts, sorted by the most-
// recent session's lastModified per project (descending). Matches the user's
// intent of "find what I was just working on" — the project with the freshest
// conversation surfaces at the top of the Projects filter dropdown. Display
// label is the last path segment (matches the group header convention in
// ResumeBrowser.tsx).
// Chip label rule (design guide G-19): nothing picked → the category; one picked
// → its name; more → the category and a count. Pure, so the rule the deck
// approved (round 1, S-5) is testable without rendering the browser.
export function pickLabel(category: string, pickedNames: string[]): { text: string; count?: number } {
  if (pickedNames.length === 0) return { text: category };
  if (pickedNames.length === 1) return { text: pickedNames[0] };
  return { text: category, count: pickedNames.length };
}

export function getAvailableProjects<T extends PastSessionLike>(
  sessions: T[],
): Array<{ path: string; label: string; count: number }> {
  // Track per-project: count + max(lastModified). Max-anchor matches the
  // between-group ordering used by groupSessions in 'desc' mode.
  const stats = new Map<string, { count: number; recent: number }>();
  for (const s of sessions) {
    const prior = stats.get(s.projectPath);
    if (prior) {
      prior.count += 1;
      if (s.lastModified > prior.recent) prior.recent = s.lastModified;
    } else {
      stats.set(s.projectPath, { count: 1, recent: s.lastModified });
    }
  }
  const result = [...stats.entries()].map(([path, { count, recent }]) => ({
    path,
    label: lastSegment(path),
    count,
    recent,
  }));
  // Most-recent-first.
  result.sort((a, b) => b.recent - a.recent);
  // Strip the internal 'recent' field so the public shape stays { path, label, count }.
  return result.map(({ path, label, count }) => ({ path, label, count }));
}

function lastSegment(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const last = parts[parts.length - 1];
  return last || path;
}
