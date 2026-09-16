import type { PlanChildView, PlanView, SubagentSegment, ToolCallState } from '../../../shared/types';

/**
 * Specialists plans, Task 5a — the plan record as its card renders it: each
 * specialist row gets the live activity (and open asks) the card collected
 * for that specialist.
 *
 * WHY the rows are joined here rather than stored inside the plan record: the
 * record is the host's journal projection and is REPLACED whole on every
 * change (PLAN_CHANGED), and a specialist's activity can arrive before its row
 * exists in the record. Keeping the activity on the card (tagged by childId,
 * chat-reducer.ts applySubagentEvent) and joining at render time means neither
 * can erase the other.
 *
 * A row the card holds no activity for keeps whatever the record itself
 * carries (the workbench fixtures ship segments inline). With nothing to add
 * the SAME record is returned, so a memoized card does not re-render.
 */
export function planWithActivity(plan: PlanView, segments: SubagentSegment[] | undefined): PlanView {
  if (!segments || segments.length === 0) return plan;
  const byChild = new Map<string, SubagentSegment[]>();
  for (const seg of segments) {
    if (!seg.childId) continue;
    let list = byChild.get(seg.childId);
    if (!list) byChild.set(seg.childId, (list = []));
    list.push(seg);
  }
  if (byChild.size === 0) return plan;
  let changed = false;
  const steps = plan.steps.map((step) => {
    if (!step.children?.some((c) => byChild.has(c.childId))) return step;
    changed = true;
    return {
      ...step,
      children: step.children.map((c) => (byChild.has(c.childId) ? { ...c, segments: byChild.get(c.childId) } : c)),
    };
  });
  return changed ? { ...plan, steps } : plan;
}

/**
 * One plan specialist in the shape of an ordinary specialist's Task card, so
 * the sections that draw a specialist (Briefing / Activity / Report) and the
 * status-bar Specialists popup draw it the same way. Task 5b: shared by the
 * plan card's rows and the popup (hooks/useSpecialists.ts), so the two can
 * never describe the same specialist differently.
 */
export function planChildCard(child: PlanChildView): ToolCallState {
  return {
    toolUseId: child.childId,
    toolName: 'Task',
    input: { agent: child.agentType, description: child.description, prompt: child.prompt },
    status: child.status === 'running' ? 'running' : 'complete',
    specialistRun: child,
    specialistReport: child.report,
    subagentSegments: child.segments,
  };
}

/** Task 5b: a `propose_plan` card (the same test the reducer uses). */
export function isPlanCard(tool: ToolCallState): boolean {
  return tool.toolName === 'propose_plan';
}
