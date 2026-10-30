// Card #207: Claude Code's comment tools reaching a file outside the chat's
// project. Before, ReadFileComments was pre-allowed on Claude Code's command
// line and the comment helper refused any outside path, so the person was
// never asked and the assistant could only report a refusal. Now:
//
//   - every comment-tool permission ask reaches the app (the read is no longer
//     pre-allowed — claude-code-doc-comments-mcp.ts deploy), and an in-project
//     read is answered "allow" here at once, so nothing changes for it;
//   - an outside file (plain, Word or Excel) raises the outside-file card (`external: true` on
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

interface CommentsSession { serverId: string; cwd: string; granted: boolean }
const sessions = new Map<string, CommentsSession>();
/** Outside-file asks awaiting an answer. `chatWide`: the card offered "Allow
 *  for this chat" (a helper's plain card never does). */
const openAsks = new Map<string, { sessionId: string; chatWide: boolean }>();

/** WHY a reason on "No": a bare hook deny reaches Claude as "Permission denied
 *  by hook", and in testing it then guessed at a mystery safety check and told
 *  the person to change its settings. Claude Code puts a deny's `message` into
 *  the refused tool's result word for word (docs/cc-dependencies.md), so this
 *  says plainly that the person chose No — the app's own assistant is told the
 *  same thing in harness-session.ts. */
const OUTSIDE_COMMENTS_DECLINED =
  "The user declined comments on this file, which is outside this chat's project. Ask what they would like instead; don't try to reach the file another way.";

/** Listen for each Claude Code session's comment helper (the session manager's
 *  private `doc-comments-mcp-attached` event) and forget the session on exit. */
export function trackOutsideComments(sessionManager: EventEmitter): void {
  sessionManager.on('doc-comments-mcp-attached', (sessionId: string, cwd: string, _token: string, serverId: string) => {
    sessions.set(sessionId, { serverId, cwd, granted: false });
  });
  sessionManager.on('session-exit', (sessionId: string) => {
    sessions.delete(sessionId);
    for (const [requestId, open] of openAsks) if (open.sessionId === sessionId) openAsks.delete(requestId);
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
  // A helper (Claude Code subagent) never holds or mints the chat-wide grant,
  // matching the app's own assistant: it gets the plain card every time.
  const requestId = payload._requestId;
  if (typeof payload.agent_id === 'string' && payload.agent_id) {
    if (typeof requestId === 'string') openAsks.set(requestId, { sessionId: event.sessionId, chatWide: false });
    return 'ask';
  }
  if (info.granted) return 'approve';
  if (typeof requestId === 'string') openAsks.set(requestId, { sessionId: event.sessionId, chatWide: true });
  payload.external = true;
  return 'ask';
}

/** The answer to a Claude Code ask, on its way to Claude Code: records "Allow
 *  for this chat" for an open outside-file ask, gives a "No" its reason, and
 *  always strips the field (Claude Code's hook answer has no such key). */
export function takeCommentAnswer(requestId: string, decision: object): object {
  const { allowOutsideCommentsForSession, ...rest } = decision as Record<string, unknown>;
  const open = openAsks.get(requestId);
  if (open === undefined) return rest;
  openAsks.delete(requestId);
  const inner = (rest.decision as Record<string, unknown> | undefined) ?? rest;
  if (inner.behavior === 'deny' && inner.message === undefined) {
    return rest.decision ? { ...rest, decision: { ...inner, message: OUTSIDE_COMMENTS_DECLINED } } : { ...rest, message: OUTSIDE_COMMENTS_DECLINED };
  }
  const info = sessions.get(open.sessionId);
  if (info && open.chatWide && inner.behavior === 'allow' && allowOutsideCommentsForSession === true) info.granted = true;
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
