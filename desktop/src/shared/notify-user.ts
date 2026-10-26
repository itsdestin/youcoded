// Shared vocabulary for "Notify user": the assistant telling the person that a
// response is ready or a checkpoint was reached, instead of the app guessing from
// where a turn ended. Same three-surface shape as send-user-link.ts:
//   1. the NATIVE harness tool  — main/harness/tools/notify-user.ts
//   2. the CLAUDE CODE MCP tool — a second tool on the per-session `youcoded`
//      MCP server (main/claude-code-mcp.ts)
//   3. the RENDERER — the in-chat notification card, the session list's status
//      label, and the "Jump to notification" button all read these names
//
// Deliberately NOT here (Destin, 2026-10-26): "needs your input". The assistant
// can only make a conversation's light BLUE; red stays reserved for the app's own
// permission and question cards.
import { CLAUDE_CODE_MCP_SERVER_ID } from './send-user-link';

/** The native harness tool's name. */
export const NOTIFY_USER_TOOL = 'NotifyUser';

/** The name Claude Code composes for the MCP copy. Matched EXACTLY, never as a
 *  `mcp__*__NotifyUser` wildcard: a marketplace MCP server could name a tool
 *  `NotifyUser` and would otherwise light up official-looking notifications. */
export const CLAUDE_CODE_NOTIFY_TOOL = `mcp__${CLAUDE_CODE_MCP_SERVER_ID}__${NOTIFY_USER_TOOL}`;

export function isNotifyUserToolName(name: string): boolean {
  return name === NOTIFY_USER_TOOL || name === CLAUDE_CODE_NOTIFY_TOOL;
}

/** The status label in the session list holds about three words; anything longer
 *  is cut with an ellipsis rather than stretching the row. */
export const NOTIFY_LABEL_MAX = 24;

/** What both tools tell the model. Identical in both session types so the model
 *  behaves the same way in each. */
export const NOTIFY_USER_DESCRIPTION = [
  'Tell the user something is ready for them: a response worth reading, or a checkpoint reached in a longer task.',
  'Their conversation list shows your short label on this conversation, and the chat shows a highlighted card with your message that they can jump to.',
  'Use it sparingly — when you finish something they asked for, or reach a point they would want to look at while you keep working. Do not use it for every reply, for routine progress, or to ask a question (ask in your reply instead).',
].join(' ');

export const NOTIFY_LABEL_DESCRIPTION = `Two or three words shown in the conversation list, e.g. "Draft ready" or "Tests passing". At most ${NOTIFY_LABEL_MAX} characters.`;
export const NOTIFY_MESSAGE_DESCRIPTION = 'One or two sentences saying what is ready and what, if anything, the user should look at.';

/** The label and message out of a tool call's input, tolerant of a malformed
 *  call (a model that omitted a field still gets a readable card). */
export function notifyFieldsOf(input: Record<string, unknown> | undefined): { label: string; message: string } {
  const label = typeof input?.label === 'string' ? input.label.trim() : '';
  const message = typeof input?.message === 'string' ? input.message.trim() : '';
  return { label: label || 'Ready for you', message };
}

/** The session list status pill's words for one session: its "Notify user" label, cut to fit, while the dot is
 *  blue because of it; otherwise undefined so the pill keeps its usual word ("Response ready", "Working"…). */
export function pillNotifyLabel(notes: ReadonlyMap<string, string> | undefined, id: string, color: string): string | undefined {
  const label = color === 'blue' ? notes?.get(id) : undefined;
  return label ? shortNotifyLabel(label) : undefined;
}

/** The label as the status pill shows it: cut to NOTIFY_LABEL_MAX with an ellipsis. */
export function shortNotifyLabel(label: string): string {
  return label.length <= NOTIFY_LABEL_MAX ? label : `${label.slice(0, NOTIFY_LABEL_MAX - 1).trimEnd()}…`;
}
