// git.ts — the git surface channels (git:*), one table entry each (spec docs/archive/specs/2026-07-22-git-surface.md).
//
// WHY (2026-09-30 one-core R3-7): these were ipcMain handlers in ipc-handlers.ts. A phone never had any
// git channel (no `case` in remote-server.ts, so the phone door answered "isn't available over remote access
// yet"), and that is kept exactly: every entry is `remoteAllowed: false`. A phone cannot read git status or
// diffs, and above all cannot stage, commit or discard. Opening any of it to a phone is a separate decision.
//
// Known-roots gate: a git operation may only target a saved folder or an indexed project root — the same
// allow-list the read-binary guard builds. That gate runs inside every entry (computer's windows).
import { IPC } from '../../shared/backend-contract';
import { canonicalize } from '../../shared/artifacts/canonicalize';
import { readFolders } from '../saved-folders';
import { listProjects } from '../artifacts/central-index';
import { gitFileStatus, gitFileReview, gitCommitFileDiff, gitStage, gitUnstage, gitCommit, gitDiscard } from '../git/git-service';
import { watchGit, unwatchGit, dropGitSubscriber } from '../git/git-watcher';
import { resolveRepoRoot, invalidateRepoRootCache } from '../git/git-exec';
import { defineChannel, type MainChannelCtx, type MainChannelDef } from './channel-def';
import os from 'os';
import path from 'path';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

const knownGitRoot = async (projectRoot: unknown): Promise<boolean> => {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) return false;
  const canon = canonicalize(projectRoot, null);
  const roots = [
    ...readFolders().map((f) => canonicalize(f.path, null)),
    ...(await listProjects(CLAUDE_DIR)).map((p) => canonicalize(p.path, null)),
  ];
  return roots.includes(canon);
};
const gitGate = async <T extends object>(projectRoot: unknown, blocked: T, run: () => Promise<T>): Promise<T> => {
  if (!(await knownGitRoot(projectRoot))) return blocked;
  return run();
};

/** Commits and checkouts can create or retarget repos — drop the cache so the next footer query re-resolves,
 *  then tell every window (never a phone: git:changed always went to windows only). ipc-handlers.ts's git
 *  watcher calls this too, with its own window sender. */
export function broadcastGitChanged(sendToWindows: (channel: string, payload: unknown) => void, repoRoot: string): void {
  invalidateRepoRootCache();
  sendToWindows(IPC.GIT_CHANGED, { repoRoot });
}
const announce = (ctx: MainChannelCtx, repoRoot: string) => ctx.desktop && broadcastGitChanged(ctx.desktop.sendToWindows, repoRoot);

const mutating = async (ctx: MainChannelCtx, projectRoot: string, run: () => Promise<{ ok: boolean; error?: string }>) =>
  gitGate<{ ok: boolean; error?: string }>(projectRoot, { ok: false, error: 'unknown-project-root' }, async () => {
    const result = await run();
    if (result.ok) {
      const repoRoot = await resolveRepoRoot(projectRoot);
      if (repoRoot) announce(ctx, repoRoot);
    }
    return result;
  });

// A crashed/closed renderer never sends unwatch — drop its refs on destroy. One listener per webContents.
const gitWatchedSenders = new Set<number>();

export const gitChannels: MainChannelDef[] = [
  defineChannel({
    name: IPC.GIT_FILE_STATUS, kind: 'handle', remoteAllowed: false,
    handler: ({ projectRoot, relPath }) =>
      gitGate(projectRoot, { ok: false, error: 'unknown-project-root', isRepo: false, branch: null, counts: null, hasHistory: false, staged: false, conflicted: false } as Awaited<ReturnType<typeof gitFileStatus>>,
        () => gitFileStatus(projectRoot, relPath)),
  }),
  defineChannel({
    name: IPC.GIT_FILE_REVIEW, kind: 'handle', remoteAllowed: false,
    // The wire is one object; everything after the two named fields is the options bag (logSkip).
    handler: ({ projectRoot, relPath, ...opts }) =>
      gitGate(projectRoot, { ok: false, error: 'unknown-project-root', isRepo: false, branch: null, uncommitted: null, log: [], hasMore: false, stagedCount: 0 } as Awaited<ReturnType<typeof gitFileReview>>,
        () => gitFileReview(projectRoot, relPath, opts)),
  }),
  defineChannel({
    name: IPC.GIT_COMMIT_FILE_DIFF, kind: 'handle', remoteAllowed: false,
    handler: ({ projectRoot, sha, relPath, prevPath }) =>
      gitGate(projectRoot, { ok: false, error: 'unknown-project-root', hunks: [], binary: false } as Awaited<ReturnType<typeof gitCommitFileDiff>>,
        () => gitCommitFileDiff(projectRoot, sha, relPath, prevPath)),
  }),
  defineChannel({ name: IPC.GIT_STAGE, kind: 'handle', remoteAllowed: false, handler: ({ projectRoot, relPath }, ctx) => mutating(ctx, projectRoot, () => gitStage(projectRoot, relPath)) }),
  defineChannel({ name: IPC.GIT_UNSTAGE, kind: 'handle', remoteAllowed: false, handler: ({ projectRoot, relPath }, ctx) => mutating(ctx, projectRoot, () => gitUnstage(projectRoot, relPath)) }),
  defineChannel({ name: IPC.GIT_COMMIT, kind: 'handle', remoteAllowed: false, handler: ({ projectRoot, message }, ctx) => mutating(ctx, projectRoot, () => gitCommit(projectRoot, message)) }),
  defineChannel({ name: IPC.GIT_DISCARD, kind: 'handle', remoteAllowed: false, handler: ({ projectRoot, relPath }, ctx) => mutating(ctx, projectRoot, () => gitDiscard(projectRoot, relPath)) }),
  defineChannel({
    name: IPC.GIT_WATCH, kind: 'handle', remoteAllowed: false,
    handler: ({ projectRoot }, ctx) =>
      gitGate<{ ok: boolean }>(projectRoot, { ok: false }, async () => {
        const repoRoot = await resolveRepoRoot(projectRoot);
        if (!repoRoot) return { ok: false };
        const sender = ctx.sender;
        if (!sender) return { ok: false };
        if (!gitWatchedSenders.has(sender.id)) {
          gitWatchedSenders.add(sender.id);
          sender.once?.('destroyed', () => { gitWatchedSenders.delete(sender.id); dropGitSubscriber(sender.id); });
        }
        return watchGit(repoRoot, sender.id);
      }),
  }),
  // Gated like every other git channel — unwatch shells rev-parse, and the known-roots gate should be
  // uniform even for read-only paths.
  defineChannel({
    name: IPC.GIT_UNWATCH, kind: 'handle', remoteAllowed: false,
    handler: ({ projectRoot }, ctx) =>
      gitGate<{ ok: boolean }>(projectRoot, { ok: false }, async () => {
        const repoRoot = await resolveRepoRoot(projectRoot);
        if (repoRoot && ctx.sender) unwatchGit(repoRoot, ctx.sender.id);
        return { ok: true };
      }),
  }),
];
