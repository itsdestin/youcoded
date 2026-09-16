// The Project View's four READ channels, as functions both transports call
// (remote access batch 3, technical design 2026-09-10 §8). The Electron
// handler and the remote `case` are two callers of one body, so a phone's
// Project View — conversations, repo, context — fills in from the same code
// the desktop uses. The write (project:write-context-file) stays on the
// desktop's transport: editing over remote is not in this batch.
import { listProjectConversations } from './project-conversations';
import { getRepoInfo } from './project-repo';
import { listContext, readContextFile } from './project-context';

export async function listConversations(projectPath: string) {
  return { ok: true, conversations: await listProjectConversations(projectPath) };
}

export async function repoInfo(projectPath: string) {
  return { ok: true, ...(await getRepoInfo(projectPath)) };
}

export async function listContextFiles(projectPath: string) {
  return { ok: true, groups: await listContext(projectPath) };
}

/** Allow-listed to the discovered context set — project-context.ts refuses anything else. */
export function readContext(projectPath: string, absolutePath: string) {
  return readContextFile(projectPath, absolutePath);
}
