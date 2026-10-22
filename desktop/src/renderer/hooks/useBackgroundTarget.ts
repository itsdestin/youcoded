import { useCallback, useSyncExternalStore } from 'react';
import { useChatStore } from '../state/chat-context';
import type { SessionChatState } from '../state/chat-types';
import { asString } from '../utils/tool-input';

/**
 * The plain name of the helper or background command a MANAGEMENT call points at — so a card
 * reads "Stopping "Start the dev server"" instead of a bare tool name or "Hiring a specialist"
 * (Destin, 2026-10-22: "checking the status of subagents or sending additional notes often still
 * reports as 'hiring specialist', which makes it seem like were adding a new subagent when we arent").
 *
 * The calls: Claude Code's SendMessage (`to`), TaskOutput / TaskStop (`task_id`), and the
 * native BashOutput / KillShell (`shell_id`). The name is the launching call's own
 * description: an Agent card's description, or a command's (state/background-commands.ts —
 * which also knows commands whose card is not loaded).
 */

// One index per (toolCalls, backgroundCommands) pair — both are replaced only when a card or a
// command changes, never per streamed word (perf rule 4), so the scan runs once per real change
// however many management cards read it. Accepted cost (review F5): a helper's activity replaces
// toolCalls per event, so while a management card is mounted each such event also rescans — the
// same O(cards) order as the reducer's own Map copy for that event, not a new growth class.
const cache = new WeakMap<object, { commands: object; index: Map<string, string> }>();

function buildIndex(session: SessionChatState): Map<string, string> {
  const index = new Map<string, string>();
  for (const c of Object.values(session.backgroundCommands)) {
    if (c.taskId) index.set(c.taskId, c.label);
    if (c.shellId) index.set(c.shellId, c.label);
  }
  for (const card of session.toolCalls.values()) {
    if (card.toolName !== 'Agent') continue;
    const id = card.ccBackground?.taskId ?? card.agentId;
    const desc = asString(card.input.description);
    if (id && desc) index.set(id, desc);
  }
  return index;
}

export function backgroundTargetLabel(session: SessionChatState, id: string): string | undefined {
  let hit = cache.get(session.toolCalls);
  if (!hit || hit.commands !== session.backgroundCommands) {
    hit = { commands: session.backgroundCommands, index: buildIndex(session) };
    cache.set(session.toolCalls, hit);
  }
  return hit.index.get(id);
}

/** The id a management call names, or '' when this card is not one. */
export function managementTargetId(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'SendMessage': return asString(input.to) || asString(input.recipient);
    case 'TaskOutput':
    case 'TaskStop': return asString(input.task_id) || asString(input.taskId);
    case 'BashOutput':
    case 'KillShell': return asString(input.shell_id);
    default: return '';
  }
}

/** A narrow selector (like useSpecialistRunByChild): a card with no target subscribes to nothing. */
export function useBackgroundTarget(sessionId: string | undefined, id: string): string | undefined {
  const store = useChatStore();
  const subscribe = useCallback(
    (cb: () => void) => (sessionId && id ? store.subscribeSession(sessionId, cb) : () => {}),
    [store, sessionId, id],
  );
  const getSnapshot = useCallback(
    () => (sessionId && id ? backgroundTargetLabel(store.getSession(sessionId), id) : undefined),
    [store, sessionId, id],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}
