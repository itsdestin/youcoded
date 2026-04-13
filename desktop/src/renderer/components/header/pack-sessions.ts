// Pure packing function for session pills. Given measured pill widths and
// an available budget, decides which pills show expanded (name + dot),
// which collapse to dot-only, and which overflow into the dropdown.
//
// Priority: active pill always visible. Prefer expanded over collapsed;
// prefer visible over overflow. Budget is in CSS px.

export interface SessionMeasurement {
  id: string;
  expandedWidth: number;
  collapsedWidth: number;
}

export interface PackInput {
  sessions: readonly SessionMeasurement[];
  activeId: string | null;
  budget: number;
  gap: number;
  triggerWidth: number;
}

export interface PackResult {
  expanded: Set<string>;
  collapsed: string[];
  overflow: string[];
}

function sumWithGaps(widths: number[], gap: number): number {
  if (widths.length === 0) return 0;
  return widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1);
}

// Caller guarantees session ids are unique within `sessions`.
export function packSessions(input: PackInput): PackResult {
  const { sessions, activeId, budget, gap, triggerWidth } = input;
  if (sessions.length === 0) {
    return { expanded: new Set(), collapsed: [], overflow: [] };
  }

  const active = sessions.find(s => s.id === activeId) ?? null;
  const others = sessions.filter(s => s.id !== activeId);

  // Budget available to pills, after reserving the ▾ trigger + one gap to it.
  const pillBudget = Math.max(0, budget - triggerWidth - gap);

  // Always include the active pill. Try expanded first, fall back to collapsed
  // if even its expanded width does not fit.
  if (active === null) {
    // No active session — fall back to packing all as collapsed by priority order.
    return greedyCollapsed(sessions, pillBudget, gap);
  }

  const activeExpanded = active.expandedWidth <= pillBudget;
  const activeWidth = activeExpanded ? active.expandedWidth : active.collapsedWidth;
  if (activeWidth > pillBudget) {
    // Active does not even fit collapsed — still show it (it is the active
    // pill; UX requires at least a dot). Everything else overflows.
    return {
      expanded: new Set(),
      collapsed: [active.id],
      overflow: others.map(o => o.id),
    };
  }

  // First pass: pack others as collapsed dots in original order.
  const collapsedIds: string[] = [];
  const overflowIds: string[] = [];
  let used = activeWidth;
  for (const s of others) {
    const candidate = used + gap + s.collapsedWidth;
    if (candidate <= pillBudget) {
      collapsedIds.push(s.id);
      used = candidate;
    } else {
      overflowIds.push(s.id);
    }
  }

  // Second pass: if every session is visible AND expanding all of them fits,
  // upgrade to allExpanded mode. This matches the old `allExpanded` UX
  // (names visible when there is room) but is budget-driven.
  if (overflowIds.length === 0 && activeExpanded) {
    const allExpandedWidth = sumWithGaps(
      [active.expandedWidth, ...others.map(o => o.expandedWidth)],
      gap,
    );
    if (allExpandedWidth <= pillBudget) {
      return {
        expanded: new Set(sessions.map(s => s.id)),
        collapsed: [],
        overflow: [],
      };
    }
  }

  return {
    expanded: activeExpanded ? new Set([active.id]) : new Set(),
    collapsed: activeExpanded ? collapsedIds : [active.id, ...collapsedIds],
    overflow: overflowIds,
  };
}

// Fallback when there is no active session — pack collapsed dots greedily.
function greedyCollapsed(
  sessions: readonly SessionMeasurement[],
  budget: number,
  gap: number,
): PackResult {
  const collapsed: string[] = [];
  const overflow: string[] = [];
  let used = 0;
  for (const s of sessions) {
    const candidate = collapsed.length === 0
      ? s.collapsedWidth
      : used + gap + s.collapsedWidth;
    if (candidate <= budget) {
      collapsed.push(s.id);
      used = candidate;
    } else {
      overflow.push(s.id);
    }
  }
  return { expanded: new Set(), collapsed, overflow };
}
