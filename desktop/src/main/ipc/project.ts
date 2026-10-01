// project.ts — the Project View channels (project:*), one table entry each, served to the computer's
// windows and (for the reads) to a phone.
//
// WHY (2026-09-30 one-core R3-7): the reads were ipcMain handlers in ipc-handlers.ts AND a phone lookup in
// remote-server.ts. One entry each now; the phone's folder gate is the entry's `remoteGuard`.
// What a phone may do is unchanged: the four READS (list-conversations, repo-info, list-context,
// read-context-file) for a folder the computer shows. project:write-context-file is the computer's windows
// only (`remoteAllowed: false`): editing a project's instruction files over remote was never allowed.
import { IPC } from '../../shared/backend-contract';
import { listConversations, repoInfo, listContextFiles, readContext } from '../project-read-service';
import { writeContextFile } from '../project-context';
import { defineChannel, type MainChannelDef } from './channel-def';
import { refuseUnknownRoot } from './file-gates';

/** The answer a phone has always been given when a read throws. */
const readFailure = (e: unknown) => ({ ok: false, error: String((e as Error)?.message ?? e) });

export const projectChannels: MainChannelDef[] = [
  defineChannel({
    name: IPC.PROJECT_LIST_CONVERSATIONS, kind: 'handle',
    remoteOnError: readFailure,
    remoteGuard: async (p, ctx) => (await refuseUnknownRoot(p?.projectPath, ctx)) ?? undefined,
    handler: ({ projectPath }) => listConversations(projectPath),
  }),
  defineChannel({
    name: IPC.PROJECT_REPO_INFO, kind: 'handle',
    remoteOnError: readFailure,
    remoteGuard: async (p, ctx) => (await refuseUnknownRoot(p?.projectPath, ctx)) ?? undefined,
    handler: ({ projectPath }) => repoInfo(projectPath),
  }),
  defineChannel({
    name: IPC.PROJECT_LIST_CONTEXT, kind: 'handle',
    remoteOnError: readFailure,
    remoteGuard: async (p, ctx) => (await refuseUnknownRoot(p?.projectPath, ctx)) ?? undefined,
    handler: ({ projectPath }) => listContextFiles(projectPath),
  }),
  // Allow-listed to the discovered context set — project-context.ts refuses anything else.
  defineChannel({
    name: IPC.PROJECT_READ_CONTEXT_FILE, kind: 'handle',
    remoteOnError: readFailure,
    remoteGuard: async (p, ctx) => {
      if (typeof p?.absolutePath !== 'string') return { ok: false, error: 'bad-request' };
      return (await refuseUnknownRoot(p.projectPath, ctx)) ?? undefined;
    },
    handler: ({ projectPath, absolutePath }) => readContext(projectPath, absolutePath),
  }),
  defineChannel({
    name: IPC.PROJECT_WRITE_CONTEXT_FILE, kind: 'handle', remoteAllowed: false,
    handler: ({ projectPath, absolutePath, content }) => writeContextFile(projectPath, absolutePath, content),
  }),
];
