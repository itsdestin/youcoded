// Claude Code background runs on tool cards (2026-09-24, Destin: "background
// agents often get immediately marked as complete"). Every CC Agent call now
// runs in the background, as does a Bash `run_in_background` command: the tool
// result is only a launch receipt, and the end arrives later as a
// <task-notification> (transcript-watcher.ts taskNotificationEvents). These
// helpers keep ToolCallState.ccBackground — the work's real state — in step.
// Split out of chat-reducer.ts, which calls them from three cases.
import type { CcBackgroundRun, ToolCallState } from '../../shared/types';
import type { ChatAction, SessionChatState } from './chat-types';
import { settleCommands, type BackgroundCommands } from './background-commands';

/** The background record a Claude Code launch receipt starts — or, when the
 *  work's end was already read (a newer history page, or a repeated receipt
 *  after the notice), that end. A repeated receipt never revives a finished run. */
export function ccBackgroundOnLaunch(
  session: SessionChatState, toolUseId: string, taskId: string, current: CcBackgroundRun | undefined,
): CcBackgroundRun {
  if (current && current.status !== 'running') return current;
  // A later SendMessage reopened this helper (audit A2): the work is whatever that
  // SECOND run is doing — never the stored first-run outcome, which would read
  // "completed" about a helper that is working again.
  const reopened = session.ccBackgroundOutcomes[reopenKey(taskId)];
  if (reopened) {
    const later = reopened.viaToolUseId ? session.ccBackgroundOutcomes[reopened.viaToolUseId] : undefined;
    return later ? { ...later, taskId } : { taskId, status: 'running' };
  }
  const known = session.ccBackgroundOutcomes[toolUseId] ?? session.ccBackgroundOutcomes[taskId];
  return known ? { ...known, taskId } : { taskId, status: 'running' };
}

/** Key of the "this finished helper was resumed" marker in ccBackgroundOutcomes. */
function reopenKey(taskId: string): string { return `reopen:${taskId}`; }

/** SendMessage resumed a finished helper: remember it in session state (audit A2).
 *  `reopenResumedHelper` only reaches cards that are LOADED; when the Agent's launch
 *  card sits on an older history page, the page loads later and its launch step reads
 *  this marker instead of settling on the first run's stored outcome. Returns the SAME
 *  record when already marked. */
export function markHelperReopened(
  outcomes: Record<string, CcBackgroundRun>, sendMessageToolUseId: string, taskId: string,
): Record<string, CcBackgroundRun> {
  const key = reopenKey(taskId);
  if (outcomes[key]?.viaToolUseId === sendMessageToolUseId) return outcomes;
  return { ...outcomes, [key]: { taskId, status: 'running', viaToolUseId: sendMessageToolUseId } };
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

/** The same stop for the background-command list: still-running commands `which`
 *  selects (by their launching toolUseId) read stopped. SAME record when none. */
export function stopRunningCommands(
  cmds: BackgroundCommands, which: (toolUseId: string) => boolean, endedAt?: number,
): BackgroundCommands {
  return settleCommands(cmds, (c) => which(c.toolUseId), { status: 'stopped', endedAt });
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
  const endedAt = action.timestamp;
  const matchesCommand = (c: { toolUseId: string; taskId?: string }) =>
    (!!action.toolUseId && c.toolUseId === action.toolUseId) || (!!c.taskId && action.taskIds.includes(c.taskId));
  // A helper's OWN background work (stamped by SubagentWatcher) has no card
  // of its own at the top level — its launching row lives in the helper's
  // Activity, which shows the tool call, not the run. It DOES have a record in the
  // background-command list (audit C4), so the end settles that and nothing else.
  if (action.parentAgentToolUseId) {
    const backgroundCommands = settleCommands(session.backgroundCommands, matchesCommand, {
      status: action.status, exitCode: action.exitCode, summary: action.summary, endedAt,
    });
    return backgroundCommands === session.backgroundCommands ? null : { ...session, backgroundCommands };
  }
  const end = {
    status: action.status,
    ...(action.summary ? { summary: action.summary } : {}),
    ...(action.result ? { result: action.result } : {}),
    ...(action.exitCode !== undefined ? { exitCode: action.exitCode } : {}),
    ...(endedAt ? { endedAt } : {}),
  };
  // Remember the outcome under every id it can be looked up by, so a card
  // that is read LATER (an older history page) settles on its receipt.
  const ccBackgroundOutcomes = { ...session.ccBackgroundOutcomes };
  if (action.toolUseId) ccBackgroundOutcomes[action.toolUseId] = { taskId: action.taskIds[0] ?? action.toolUseId, ...end };

  // A finished helper that SendMessage resumed (audit A2): a notice that does not name
  // that SendMessage call is an EARLIER run's end — read late, because history pages
  // arrive newest first — and must not settle the working-again card or overwrite what
  // the task id stands for. The resumed run's own notice (or a toolUseId-less one,
  // which can only be the latest) ends the reopen.
  const earlierRunOf = new Set<string>();
  for (const id of action.taskIds) {
    const marker = ccBackgroundOutcomes[reopenKey(id)];
    if (!marker) continue;
    if (action.toolUseId && action.toolUseId !== marker.viaToolUseId) earlierRunOf.add(id);
    else if (!action.toolUseId) delete ccBackgroundOutcomes[reopenKey(id)];
  }
  for (const id of action.taskIds) if (!earlierRunOf.has(id)) ccBackgroundOutcomes[id] = { taskId: id, ...end };

  let toolCalls = session.toolCalls;
  const settle = (cardId: string, card: ToolCallState) => {
    if (toolCalls === session.toolCalls) toolCalls = new Map(toolCalls);
    toolCalls.set(cardId, {
      ...card,
      ccBackground: { taskId: card.ccBackground?.taskId ?? action.taskIds[0] ?? cardId, ...end },
    });
  };
  const byToolUse = action.toolUseId ? session.toolCalls.get(action.toolUseId) : undefined;
  const byToolUseTask = byToolUse && (byToolUse.ccBackground?.taskId ?? byToolUse.agentId);
  if (byToolUse && !(byToolUseTask && earlierRunOf.has(byToolUseTask))) settle(action.toolUseId!, byToolUse);
  // ALSO every card carrying one of these task ids, not only when the tool-use
  // id is missing (orphan summaries omit it): after Claude resumes a finished
  // helper with SendMessage, the helper's next notice names the SendMessage
  // call (132 of 141 measured), yet the Agent card is where its work shows.
  // A scan, but these notices are rare: one per background task end.
  if (action.taskIds.length > 0) {
    for (const [cardId, card] of session.toolCalls) {
      if (cardId === action.toolUseId) continue;
      const taskId = card.ccBackground?.taskId ?? card.agentId;
      if (taskId && action.taskIds.includes(taskId) && !earlierRunOf.has(taskId)) settle(cardId, card);
    }
  }
  const backgroundCommands = settleCommands(session.backgroundCommands, matchesCommand, {
    status: action.status, exitCode: action.exitCode, summary: action.summary, endedAt,
  });
  return { ...session, toolCalls, ccBackgroundOutcomes, backgroundCommands };
}

/** A successful TaskStop (audit C1). TaskStop writes NO <task-notification> for a
 *  Bash command (264 of 264 measured), so its own result is the only signal the
 *  command, helper or workflow is over: the matching card and command read stopped.
 *  Work that already ended keeps its real end (a stop that raced a finish). The
 *  outcome is remembered by task id so a launch card on an older history page
 *  settles the same way. Returns the SAME session when nothing needed changing. */
export function applyTaskStop(
  session: SessionChatState, taskId: string, summary: string | undefined, endedAt: number | undefined,
): SessionChatState {
  let toolCalls = session.toolCalls;
  for (const [cardId, card] of session.toolCalls) {
    if (card.ccBackground?.status !== 'running') continue;
    if ((card.ccBackground.taskId ?? card.agentId) !== taskId) continue;
    if (toolCalls === session.toolCalls) toolCalls = new Map(toolCalls);
    toolCalls.set(cardId, { ...card, ccBackground: { ...card.ccBackground, status: 'stopped', ...(endedAt ? { endedAt } : {}) } });
  }
  const backgroundCommands = settleCommands(session.backgroundCommands, (c) => c.taskId === taskId, { status: 'stopped', summary, endedAt });
  const known = session.ccBackgroundOutcomes[taskId];
  const ccBackgroundOutcomes = known && known.status !== 'running'
    ? session.ccBackgroundOutcomes
    : { ...session.ccBackgroundOutcomes, [taskId]: { taskId, status: 'stopped' as const, ...(summary ? { summary } : {}), ...(endedAt ? { endedAt } : {}) } };
  if (toolCalls === session.toolCalls && backgroundCommands === session.backgroundCommands && ccBackgroundOutcomes === session.ccBackgroundOutcomes) return session;
  return { ...session, toolCalls, backgroundCommands, ccBackgroundOutcomes };
}
