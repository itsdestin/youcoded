// The docx/xlsx pending-mutation queue's main-process half (T9b, design
// docs/active/specs/2026-09-26-doc-comments-build-design.md §9.2) — started
// for every Claude Code session (it's harmless, cheap idle-refcount overhead
// for a session whose assistant never touches a Word/Excel comment) and
// stopped when the session ends. WHY wired via listeners rather than inside
// session-manager.ts's own createSession/destroySession (where the doc-
// comments MCP server's DEPLOYMENT itself lives, since that affects the
// spawned CLI args directly): session-manager.test.ts constructs a bare
// `SessionManager` with no listeners attached and reuses a single shared
// `os.tmpdir()` as `cwd` across dozens of tests — starting a real chokidar
// watcher on that shared directory from inside createSession would leak a
// live filesystem watch into every one of those tests. Wiring it as a
// listener instead (called from ipc-handlers.ts's registerIpcHandlers, which
// is where this used to live inline before being extracted here to keep that
// file under its own line budget) means it only ever runs where a real (or
// sufficiently real) SessionManager actually emits these events.
//
// `docCommentsQueueCwds` tracks each session's own cwd from creation through
// exit: `destroySession`'s multiple emit sites don't consistently leave
// `getSession(id)` answerable by the time 'session-exit' fires (some already
// delete the entry first), so this listener keeps its own record rather than
// depending on that.
//
// WHY `doc-comments-mcp-attached`, not `session-created` (adversarial review
// 2026-09-27, finding #1): the queue needs this session's own request-
// authentication token, minted only on a SUCCESSFUL doc-comments MCP deploy —
// `session-created` fires for every session regardless of whether that
// deploy succeeded, and carries no token at all (a PRIVATE event
// specifically so the token/server id never reach the renderer-facing
// `SESSION_CREATED` broadcast — see session-manager.ts's own emit-site
// comment). A session whose deploy failed simply never gets a queue, which
// is correct: nothing legitimate could ever submit a request for it anyway.
//
// `docCommentsDeployDirs` is finding #3 (T9c/T20 adversarial review): this
// session's own deploy directory (config + token) is deleted wholesale on
// session-exit; a crash/kill that skips this is swept on the next deploy in
// a fresh process instead (claude-code-doc-comments-mcp.ts's own
// sweepStaleDeploysOnce).
import fs from 'fs';
import type { SessionManager } from '../session-manager';
import { log } from '../logger';
import { startPendingMutationQueue, stopPendingMutationQueue } from './pending-mutation-queue';

export function wireDocCommentsSessionLifecycle(sessionManager: SessionManager): void {
  const docCommentsQueueCwds = new Map<string, string>();
  const docCommentsDeployDirs = new Map<string, string>();
  sessionManager.on('doc-comments-mcp-attached', (sessionId: string, cwd: string, token: string, _serverId: string, deployDir: string) => {
    docCommentsQueueCwds.set(sessionId, cwd);
    docCommentsDeployDirs.set(sessionId, deployDir);
    void startPendingMutationQueue(sessionId, cwd, token);
  });
  sessionManager.on('session-exit', (sessionId: string) => {
    const cwd = docCommentsQueueCwds.get(sessionId);
    if (cwd !== undefined) {
      docCommentsQueueCwds.delete(sessionId);
      void stopPendingMutationQueue(sessionId, cwd);
    }
    const deployDir = docCommentsDeployDirs.get(sessionId);
    if (deployDir !== undefined) {
      docCommentsDeployDirs.delete(sessionId);
      // Fire-and-forget, same shape as stopPendingMutationQueue above.
      fs.promises.rm(deployDir, { recursive: true, force: true })
        .catch((e) => log('WARN', 'IPC', 'doc-comments deploy dir cleanup failed', { sessionId, error: String(e) }));
    }
  });
}
