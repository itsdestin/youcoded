// Card #207: Claude Code's comment tools reaching a file outside the chat's
// project. Before, ReadFileComments was pre-allowed on Claude Code's command
// line and the comment helper refused any outside path, so the person was
// never asked and the assistant could only report a refusal. Now:
//
//   - every comment-tool permission ask reaches the app (the read is no longer
//     pre-allowed — claude-code-doc-comments-mcp.ts deploy), and an in-project
//     read is answered "allow" here at once, so nothing changes for it;
//   - an outside plain file raises the outside-file card (`external: true` on
//     the ask, which ToolCard draws as Yes / Allow for this chat / No), unless
//     this chat already chose "Allow for this chat";
//   - the answer is read on its way back (permission:respond) to record that
//     chat-wide choice and strip it before Claude Code sees the answer.
//
// One module for the desktop (main.ts) and Android's backend (headless-boot.ts),
// which both answer Claude Code asks and both serve permission:respond.
// The grant lives in memory only: it ends when the chat ends or the app quits.
import * as path from 'path';
import type { EventEmitter } from 'events';
import { bareDocCommentsToolName } from '../shared/doc-comments-mcp';
import { nativeFormatFor } from './doc-comments/doc-comments-dispatch';

interface CommentsSession { serverId: string; cwd: string; granted: boolean }
const sessions = new Map<string, CommentsSession>();
/** Outside-file asks awaiting an answer: requestId → sessionId. */
const openAsks = new Map<string, string>();

/** Listen for each Claude Code session's comment helper (the session manager's
 *  private `doc-comments-mcp-attached` event) and forget the session on exit. */
export function trackOutsideComments(sessionManager: EventEmitter): void {
  sessionManager.on('doc-comments-mcp-attached', (sessionId: string, cwd: string, _token: string, serverId: string) => {
    sessions.set(sessionId, { serverId, cwd, granted: false });
  });
  sessionManager.on('session-exit', (sessionId: string) => {
    sessions.delete(sessionId);
    for (const [requestId, sid] of openAsks) if (sid === sessionId) openAsks.delete(requestId);
  });
}

/** 'approve': answer allow now. 'ask': show a card and let no other
 *  auto-approve rule answer it. 'pass': not this module's call. */
export type CommentAskVerdict = 'approve' | 'ask' | 'pass';

/** Judge a Claude Code PermissionRequest. Stamps `external: true` on the
 *  payload when it raises the outside-file card. */
export function judgeCommentAsk(event: { sessionId: string; payload?: Record<string, unknown> }): CommentAskVerdict {
  const payload = event.payload;
  const info = sessions.get(event.sessionId);
  if (!payload || !info) return 'pass';
  const toolName = payload.tool_name;
  // Only THIS session's own server, by its unguessable per-deploy id (see
  // shared/doc-comments-mcp.ts's header, finding #2).
  if (typeof toolName !== 'string' || !toolName.startsWith(`mcp__${info.serverId}__`)) return 'pass';
  const bare = bareDocCommentsToolName(toolName);
  if (bare === null) return 'pass';
  const target = (payload.tool_input as Record<string, unknown> | undefined)?.path;
  if (typeof target !== 'string') return 'pass';
  if (!isOutside(info.cwd, target)) return bare === 'ReadFileComments' ? 'approve' : 'pass';
  // Word/Excel outside the project is not supported yet; the helper refuses
  // it with a plain reason, so asking first would only lead to that refusal.
  if (nativeFormatFor(target) !== null) return 'approve';
  // A helper (Claude Code subagent) never holds or mints the chat-wide grant,
  // matching the app's own assistant: it gets the plain card every time.
  if (typeof payload.agent_id === 'string' && payload.agent_id) return 'ask';
  if (info.granted) return 'approve';
  const requestId = payload._requestId;
  if (typeof requestId === 'string') openAsks.set(requestId, event.sessionId);
  payload.external = true;
  return 'ask';
}

/** The answer to a Claude Code ask, on its way to Claude Code: records "Allow
 *  for this chat" for an open outside-file ask, and always strips the field
 *  (Claude Code's hook answer has no such key). */
export function takeCommentAnswer(requestId: string, decision: object): object {
  const { allowOutsideCommentsForSession, ...rest } = decision as Record<string, unknown>;
  const sessionId = openAsks.get(requestId);
  if (sessionId === undefined) return rest;
  openAsks.delete(requestId);
  const inner = (rest.decision as Record<string, unknown> | undefined) ?? rest;
  const info = sessions.get(sessionId);
  if (info && inner.behavior === 'allow' && allowOutsideCommentsForSession === true) info.granted = true;
  return rest;
}

/** Lexical: an absolute path not under the session folder. A relative path is
 *  resolved by the helper against the project and its own containment check
 *  refuses any escape, so it is never "outside" here. No disk reads — this
 *  runs on the main process for every ask (performance rule 1). */
function isOutside(cwd: string, target: string): boolean {
  if (!path.isAbsolute(target) || !cwd) return false;
  const rel = path.relative(path.resolve(cwd), path.resolve(target));
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/** Tests only. */
export function resetOutsideCommentsForTests(): void {
  sessions.clear();
  openAsks.clear();
}
