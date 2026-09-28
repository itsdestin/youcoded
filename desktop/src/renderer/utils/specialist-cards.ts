import type { PasswordAsk, SubagentSegment, ToolCallState } from '../../shared/types';

type ToolSegment = Extract<SubagentSegment, { type: 'tool' }>;

type AskShaped = { status: string; requestId?: string; passwordAsk?: PasswordAsk };

/**
 * True when a tool/segment row is genuinely waiting on the user to answer it
 * — a permission ask (`requestId`) or an admin-password ask (`passwordAsk`).
 * Nothing else ever sets `status: 'awaiting-approval'` without carrying one
 * of these two, but a password ask keeps its OWN `requestId` nested inside
 * `passwordAsk` rather than on the row's own `requestId` field (design
 * 2026-09-25/26: the row's status flips the same way a permission ask's
 * does, but the two asks are answered through different IPC calls, so they
 * can't share one id field) — a bare `!!row.requestId` check silently
 * excluded every password ask. Every consumer that used to write that check
 * inline should call this instead, so the two ask kinds can never drift
 * apart again (coordinator, 2026-09-26: "prefer a single shared predicate").
 */
export function needsUserAnswer(row: AskShaped): boolean {
  return row.status === 'awaiting-approval' && (!!row.requestId || !!row.passwordAsk);
}

/**
 * Specialists 1c: does this Task card hold a helper's ask that is waiting on
 * the user — a permission ask OR the helper's own sudo password ask? The
 * card opens itself when it does (ToolCard, AgentSections).
 */
export function hasNestedAsk(tool: ToolCallState): boolean {
  if (tool.toolName !== 'Task' || !tool.subagentSegments) return false;
  return tool.subagentSegments.some(s => s.type === 'tool' && needsUserAnswer(s));
}

/** True when any helper in the session is waiting on the user (see helperAsksOf). */
export function hasHelperAsk(toolCalls: Map<string, ToolCallState>): boolean {
  for (const card of toolCalls.values()) if (hasNestedAsk(card)) return true;
  return false;
}

/** One helper row as the ToolCallState shape the tool views and ToolCard read. */
export function segmentToToolState(segment: ToolSegment): ToolCallState {
  return {
    toolUseId: segment.toolUseId,
    toolName: segment.toolName,
    input: segment.input,
    status: segment.status,
    response: segment.response,
    error: segment.error,
    structuredPatch: segment.structuredPatch,
    // Specialists 1c: the ask fields ride along so ToolBody's per-tool views
    // (and friendlyToolDisplay) see the same shape a top-level card has.
    requestId: segment.requestId,
    denyListed: segment.denyListed,
    external: segment.external,
    floorStop: segment.floorStop,
    permissionMode: segment.permissionMode,
    // admin-password (coordinator, 2026-09-26): without this, a nested
    // password ask surfaced as a top-level-shaped card (helperAsksOf) lost
    // its ask on the way — ToolCard had nothing to render.
    passwordAsk: segment.passwordAsk,
  };
}

/** The id that identifies a pending ask on a row, whichever kind it is —
 *  used for de-duplication and React keys where a permission ask's
 *  `requestId` and a password ask's `passwordAsk.requestId` need one shared
 *  lookup. */
function askIdOf(row: AskShaped): string | undefined {
  return row.requestId ?? row.passwordAsk?.requestId;
}

/**
 * Every helper request waiting on the user, in any Task card of the session,
 * as top-level-shaped cards carrying `specialist` (so ToolCard says "Wren …
 * wants to:"). WHY: a helper's request used to exist only inside its Task
 * card — often a background hire's card several turns up, folded into a tool
 * group — while the bottom-of-chat approval cards and the red session dot only
 * looked at the main assistant's own tools. Nothing told the user it was
 * there. Scans ALL cards, not the active turn: a background helper keeps
 * working (and asking) after the turn that hired it ended.
 */
export function helperAsksOf(toolCalls: Map<string, ToolCallState>): ToolCallState[] {
  const out: ToolCallState[] = [];
  // A request can ALSO be a top-level card: the reducer mints one when the
  // helper's Task card isn't loaded yet, and it lingers after the Task card
  // arrives (e.g. older history paged in). That card is already shown at the
  // bottom — skip its nested twin so one request never shows twice.
  const topLevel = new Set<string>();
  for (const t of toolCalls.values()) {
    if (!needsUserAnswer(t)) continue;
    const id = askIdOf(t);
    if (id) topLevel.add(id);
  }
  for (const [id, card] of toolCalls) {
    if (!hasNestedAsk(card)) continue;
    for (const seg of card.subagentSegments!) {
      if (seg.type !== 'tool' || !needsUserAnswer(seg)) continue;
      const askId = askIdOf(seg);
      if (askId && topLevel.has(askId)) continue;
      out.push({
        ...segmentToToolState(seg),
        specialist: {
          childId: card.specialistRun?.childId ?? card.agentId ?? id,
          agentType: card.specialistRun?.agentType ?? 'specialist',
          title: card.specialistRun?.title ?? 'A specialist',
        },
      });
    }
  }
  return out;
}
