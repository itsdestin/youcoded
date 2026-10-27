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
 *  behaves the same way in each. Since 2026-10-26 (notify-user questions Q-3: "gray"
 *  — trust the assistant) the app no longer turns a capable session blue on its own,
 *  so the model is told plainly that "ready" is its job. */
export const NOTIFY_USER_DESCRIPTION = [
  'Tell the user something is ready for them. Their conversation list shows your short label on this conversation, and your reply shows the label and message at its top.',
  'The app does not tell them a reply is ready: you do. Call this whenever you stop and hand the conversation back because you finished what they asked or need their decision (ask in your reply, then call this), and at a checkpoint they would want to see while you keep working.',
  'Do not call it when you stop only to wait for your own helpers or background work, for a short conversational reply (a quick answer, a greeting), or more than once per reply.',
  'The label and message sit beside your reply, so do not repeat what the reply says: say only what is ready, or what to look at.',
].join(' ');

export const NOTIFY_LABEL_DESCRIPTION = `Two or three words shown in the conversation list, e.g. "Draft ready" or "Tests passing". At most ${NOTIFY_LABEL_MAX} characters.`;
export const NOTIFY_MESSAGE_DESCRIPTION = 'One short sentence: what is ready, or what to look at. It sits beside your reply, so never restate the reply.';

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

/** Does the ASSISTANT decide when this conversation is "ready" (Notify user), rather than the app turning it blue
 *  whenever a reply ends unseen? Claude Code sessions and native sessions on a capable model do (Destin, 2026-10-26:
 *  "replace the existing automatic version ... at least for all frontier sessions"); small local models keep the
 *  automatic blue. Read from the session's "Started with" record, which every screen already holds. */
export function readyIsTheModels(ctx: { assembledBy?: string; notifiesByModel?: boolean } | null | undefined): boolean {
  return ctx?.assembledBy === 'claude-code' || ctx?.notifiesByModel === true;
}
