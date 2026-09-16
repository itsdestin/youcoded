// IPC channel constants for the Project View hub (conversations, repo, context).
// Mirrors src/main/artifacts/ipc-channels.ts. Keep every value in sync with
// preload.ts, remote-shim.ts, ipc-handlers.ts, and SessionService.kt (stub).
// (No apostrophes in comments — the ipc parity test scans single-quoted strings.)
export const PROJECT_IPC = {
  LIST_CONVERSATIONS: 'project:list-conversations',
  REPO_INFO: 'project:repo-info',
  LIST_CONTEXT: 'project:list-context',
  READ_CONTEXT_FILE: 'project:read-context-file',
  WRITE_CONTEXT_FILE: 'project:write-context-file',
} as const;

export type ProjectIpcChannel = typeof PROJECT_IPC[keyof typeof PROJECT_IPC];
