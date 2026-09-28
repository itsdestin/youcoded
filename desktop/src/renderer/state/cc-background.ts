// Claude Code background runs on tool cards (2026-09-24, Destin: "background
// agents often get immediately marked as complete"). Every CC Agent call now
// runs in the background, as does a Bash `run_in_background` command: the tool
// result is only a launch receipt, and the end arrives later as a
// <task-notification> (transcript-watcher.ts taskNotificationEvents). These
// helpers keep ToolCallState.ccBackground — the work's real state — in step.
// Split out of chat-reducer.ts, which calls them from three cases.
import type { CcBackgroundRun, ToolCallState } from '../../shared/types';
import type { ChatAction, SessionChatState } from './chat-types';

/** The background record a Claude Code launch receipt starts — or, when the
 *  work's end was already read (a newer history page, or a repeated receipt
 *  after the notice), that end. A repeated receipt never revives a finished run. */
export function ccBackgroundOnLaunch(
  session: SessionChatState, toolUseId: string, taskId: string, current: CcBackgroundRun | undefined,
): CcBackgroundRun {
  if (current && current.status !== 'running') return current;
  const known = session.ccBackgroundOutcomes[toolUseId] ?? session.ccBackgroundOutcomes[taskId];
  return known ? { ...known, taskId } : { taskId, status: 'running' };
}

/** Marks still-running Claude Code background work as stopped on the cards
 *  `which` selects. Returns the SAME map when nothing changed (perf rule 4). */
export function stopRunningBackground(
  toolCalls: Map<string, ToolCallState>, which: (toolUseId: string) => boolean,
): Map<string, ToolCallState> {
  let out = toolCalls;
  for (const [id, card] of toolCalls) {
    if (card.ccBackground?.status !== 'running' || !which(id)) continue;
    if (out === toolCalls) out = new Map(toolCalls);
    out.set(id, { ...card, ccBackground: { ...card.ccBackground, status: 'stopped' } });
  }
  return out;
}

/** A SendMessage that RESUMED a finished helper (`resumedAgentId` on its
 *  result): the helper's Agent card is working again, so it spins again until
 *  the next notice — which names this SendMessage call. When that notice was
 *  already read (a newer history page), apply it instead, or the card would
 *  spin forever. Returns the SAME map when nothing changed. */
export function reopenResumedHelper(
  session: SessionChatState, toolCalls: Map<string, ToolCallState>, sendMessageToolUseId: string, taskId: string,
): Map<string, ToolCallState> {
  const known = session.ccBackgroundOutcomes[sendMessageToolUseId];
  let out = toolCalls;
  for (const [id, card] of toolCalls) {
    // Agent cards only: an earlier SendMessage card also carries this task id
    // (its own notice settled it) and must not start spinning.
    if (card.toolName !== 'Agent' || (card.ccBackground?.taskId ?? card.agentId) !== taskId) continue;
    const next: CcBackgroundRun = known ? { ...known, taskId } : { ...(card.ccBackground ?? { taskId }), taskId, status: 'running' };
    if (out === toolCalls) out = new Map(toolCalls);
    out.set(id, { ...card, ccBackground: next });
  }
  return out;
}

/** TRANSCRIPT_BACKGROUND_TASK: background work a card launched has ended.
 *  Returns the updated session, or null when nothing applies. */
export function applyBackgroundTaskEnd(
  session: SessionChatState, action: Extract<ChatAction, { type: 'TRANSCRIPT_BACKGROUND_TASK' }>,
): SessionChatState | null {
  // A helper's OWN background work (stamped by SubagentWatcher) has no card
  // of its own at the top level — its launching row lives in the helper's
  // Activity, which shows the tool call, not the run.
  if (action.parentAgentToolUseId) return null;
  const end = {
    status: action.status,
    ...(action.summary ? { summary: action.summary } : {}),
    ...(action.result ? { result: action.result } : {}),
  };
  // Remember the outcome under every id it can be looked up by, so a card
  // that is read LATER (an older history page) settles on its receipt.
  const ccBackgroundOutcomes = { ...session.ccBackgroundOutcomes };
  if (action.toolUseId) ccBackgroundOutcomes[action.toolUseId] = { taskId: action.taskIds[0] ?? action.toolUseId, ...end };
  for (const id of action.taskIds) ccBackgroundOutcomes[id] = { taskId: id, ...end };

  let toolCalls = session.toolCalls;
  const settle = (cardId: string, card: ToolCallState) => {
    if (toolCalls === session.toolCalls) toolCalls = new Map(toolCalls);
    toolCalls.set(cardId, {
      ...card,
      ccBackground: { taskId: card.ccBackground?.taskId ?? action.taskIds[0] ?? cardId, ...end },
    });
  };
  const byToolUse = action.toolUseId ? session.toolCalls.get(action.toolUseId) : undefined;
  if (byToolUse) settle(action.toolUseId!, byToolUse);
  // ALSO every card carrying one of these task ids, not only when the tool-use
  // id is missing (orphan summaries omit it): after Claude resumes a finished
  // helper with SendMessage, the helper's next notice names the SendMessage
  // call (132 of 141 measured), yet the Agent card is where its work shows.
  // A scan, but these notices are rare: one per background task end.
  if (action.taskIds.length > 0) {
    for (const [cardId, card] of session.toolCalls) {
      if (cardId === action.toolUseId) continue;
      const taskId = card.ccBackground?.taskId ?? card.agentId;
      if (taskId && action.taskIds.includes(taskId)) settle(cardId, card);
    }
  }
  return { ...session, toolCalls, ccBackgroundOutcomes };
}
