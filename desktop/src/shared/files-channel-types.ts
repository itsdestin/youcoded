// files-channel-types.ts — the request/response rows of the artifacts:*, project:*, git:*, chatsearch:*
// and pages:* channels, plus fs:read-head, file:upload and get-home-path, that live in the channel table
// (one-core R3-7).
//
// WHY a file of its own (2026-09-30 one-core R3-7): backend-contract.ts is at its line budget; like
// models-channel-types.ts, ChannelTypes extends this so a row is still found by name through ChannelTypes.
// Push channels (artifacts:changed, git:changed, pages:changed) are not rows: they have no request.
//
// WHY the answers are derived from the functions that make them: the table handler returns exactly what
// the function returns, so the type cannot drift from it. The functions are imported as TYPES only
// (shared/ never loads main/).
import type * as ReadService from '../main/artifacts/read-service';
import type * as ProjectRead from '../main/project-read-service';
import type * as GitService from '../main/git/git-service';
import type { listProjectsIndex } from '../main/artifacts/projects-index';
import type { renameArtifact, removeArtifactRecord } from '../main/artifacts/artifact-store';
import type { importFile } from '../main/artifacts/import-file';
import type { authorizeArtifactWrite } from '../main/artifacts/write-authorization';
import type { writeContextFile } from '../main/project-context';
import type { resolveConversations, readConversation } from '../main/chatsearch-index/refs-service';
import type { getPagesService } from '../main/pages/pages-service';
import type { ensureProjectCoalesced } from '../main/artifacts/project-manager';
import type { readFileHead } from '../main/fs-read-head';
import type { ChatsearchReadRequest } from './chatsearch-refs';
import type { PageFetchRequest, PageSocketCall, PageSocketOpenResult, PageSocketCallResult, PageVideoStartRequest, PageVideoCall, PageVideoStartResult } from './pages-types';

type Answer<F extends (...a: any[]) => any> = Awaited<ReturnType<F>>;
type PagesService = NonNullable<ReturnType<typeof getPagesService>>;
type PagesAnswer<K extends keyof PagesService> = PagesService[K] extends (...a: any[]) => infer R ? Awaited<R> : never;
/** The record's version event as the renderer sends it (see artifacts:append-version). */
type AppendVersionArgs = {
  path: string;
  kind: 'internal' | 'external';
  absolutePath: string | null;
  type: 'create' | 'edit' | 'delete' | 'read' | 'delivered';
  author: 'agent' | 'user';
  toolUseId?: string;
};
/** Ok, or a coded refusal the screen explains. */
type OkOrCode = { ok: true } | { ok: false; error: string };

export interface FilesChannelTypes {
  // ── Artifacts: reads (a phone may call these, behind its folder gate and size ceiling) ──
  'artifacts:list-session': { request: { sessionId: string; projectRoot: string }; response: Answer<typeof ReadService.listSessionFiles> };
  'artifacts:list-project': { request: { projectId: string; opts?: { withCount?: boolean } }; response: Answer<typeof ReadService.listProjectFiles> };
  'artifacts:list-all-files': { request: { projectId: string; opts?: { force?: boolean } }; response: Answer<typeof ReadService.listAllFiles> };
  'artifacts:list-folder': { request: { projectId: string; relDir: string; opts?: { sort?: 'name' | 'recent'; offset?: number; limit?: number; snapshot?: string; namesOnly?: boolean } }; response: Answer<typeof ReadService.listFolder> };
  /** `trackedOnly` is set by the phone door's policy, never by a caller. */
  'artifacts:resolve-path': { request: { projectRoot: string; path: string; trackedOnly?: boolean }; response: Answer<typeof ReadService.resolveArtifactPath> };
  'artifacts:list-projects-index': { request: { withCounts?: boolean } | undefined; response: Answer<typeof listProjectsIndex> };
  /** `maxBytes` is set by the phone door's policy, never by a caller. */
  'artifacts:get': { request: { projectRoot: string; artifactId: string; full?: boolean; maxBytes?: number }; response: Answer<typeof ReadService.readArtifactText> };
  'artifacts:read-binary': { request: { absolutePath: string; maxBytes?: number }; response: Answer<typeof ReadService.readArtifactBytes> };
  'artifacts:search-content': { request: { projectRoot: string; query: string }; response: Answer<typeof ReadService.searchArtifactContent> };
  'artifacts:check-existence': { request: { projectRoot: string; artifactIds: string[] }; response: Answer<typeof ReadService.checkArtifactExistence> };
  'artifacts:watch-project': { request: { projectRoot: string }; response: { ok: boolean; error?: string } };
  'artifacts:unwatch-project': { request: { projectRoot: string }; response: { ok: boolean } };
  /** The computer's own windows are never offered a download: they answer { ok:false, code:'not-remote' }. */
  'artifacts:download': { request: { absolutePath: string; projectRoot?: string; artifactId?: string }; response: unknown };
  // ── Artifacts: writes (the computer's windows only; a phone is refused) ──
  'artifacts:append-version': { request: { projectRoot: string; sessionId: string; args: AppendVersionArgs }; response: { ok: boolean; project: Awaited<ReturnType<typeof ensureProjectCoalesced>>['project'] } };
  'artifacts:rename': { request: { projectRoot: string; artifactId: string; newName: string }; response: Answer<typeof renameArtifact> };
  'artifacts:remove-record': { request: { projectRoot: string; artifactId: string }; response: Answer<typeof removeArtifactRecord> };
  'artifacts:save': {
    request: { projectRoot: string; projectId: string; projectName: string; artifactId: string; content: string; sessionId: string; baseMtimeMs?: number; confirmed?: boolean };
    response: { ok: true; mtimeMs?: number } | Exclude<Answer<typeof authorizeArtifactWrite>, { ok: true }> | { ok: false; error: string };
  };
  'artifacts:import-file': {
    request: { projectRoot: string; sourcePath: string; destDir: string; opts: { mode: 'move' | 'copy'; onCollision: 'replace' | 'keep-both' | 'skip'; disclosedCollisions?: string[] } };
    response: Answer<typeof importFile>;
  };
  'artifacts:include-external': { request: { projectRoot: string; absolutePath: string }; response: OkOrCode };
  'artifacts:exclude': { request: { projectRoot: string; canonicalPath: string }; response: OkOrCode };
  'artifacts:delete-project': { request: { projectId: string; deleteSidecar: boolean }; response: OkOrCode };
  // ── Project View ──
  'project:list-conversations': { request: { projectPath: string }; response: Answer<typeof ProjectRead.listConversations> };
  'project:repo-info': { request: { projectPath: string }; response: Answer<typeof ProjectRead.repoInfo> };
  'project:list-context': { request: { projectPath: string }; response: Answer<typeof ProjectRead.listContextFiles> };
  'project:read-context-file': { request: { projectPath: string; absolutePath: string }; response: Answer<typeof ProjectRead.readContext> };
  'project:write-context-file': { request: { projectPath: string; absolutePath: string; content: string }; response: Answer<typeof writeContextFile> };
  // ── Chat references ──
  'chatsearch:resolve': { request: { shortIds: string[] }; response: ReturnType<typeof resolveConversations> };
  'chatsearch:read': { request: ChatsearchReadRequest; response: Answer<typeof readConversation> };
  // ── Git (the computer's windows only) ──
  'git:file-status': { request: { projectRoot: string; relPath: string }; response: Answer<typeof GitService.gitFileStatus> };
  'git:file-review': { request: { projectRoot: string; relPath: string; logSkip?: number }; response: Answer<typeof GitService.gitFileReview> };
  'git:commit-file-diff': { request: { projectRoot: string; sha: string; relPath: string; prevPath?: string }; response: Answer<typeof GitService.gitCommitFileDiff> };
  'git:stage': { request: { projectRoot: string; relPath: string }; response: { ok: boolean; error?: string } };
  'git:unstage': { request: { projectRoot: string; relPath: string }; response: { ok: boolean; error?: string } };
  'git:commit': { request: { projectRoot: string; message: string }; response: { ok: boolean; error?: string } };
  'git:discard': { request: { projectRoot: string; relPath: string }; response: { ok: boolean; error?: string } };
  'git:watch': { request: { projectRoot: string }; response: { ok: boolean } };
  'git:unwatch': { request: { projectRoot: string }; response: { ok: boolean } };
  // ── Pages ──
  'pages:list': { request: void; response: PagesAnswer<'listAndWatch'> };
  'pages:get': { request: { id: string }; response: unknown };
  'pages:set-pinned': { request: { id: string; pinned: boolean }; response: unknown };
  'pages:set-data': { request: { id: string; data: unknown }; response: unknown };
  'pages:approve': { request: { id: string; keys: Record<string, string>; addresses?: Record<string, string> }; response: PagesAnswer<'approve'> | { ok: false; message: string } };
  'pages:remove-connection': { request: { id: string; connectionId: string }; response: PagesAnswer<'removeConnection'> };
  'pages:refresh': { request: { id: string }; response: PagesAnswer<'refresh'> };
  'pages:saved-keys': { request: void; response: PagesAnswer<'savedKeys'> };
  'pages:delete-saved-key': { request: { service: string; address: string }; response: PagesAnswer<'deleteSavedKey'> };
  'pages:fetch': { request: { id: string; request: PageFetchRequest }; response: PagesAnswer<'fetch'> | { ok: false; reason: 'network'; message: string } };
  // Live sockets and camera video (spec 2026-10-04). Each call names its page and frame; main knows the caller itself
  // (a window or a phone), so these rows carry no owner. Events come back as the pages:socket-event push, not a row.
  'pages:socket-open': { request: PageSocketCall & { url: string }; response: PageSocketOpenResult };
  'pages:socket-send': { request: PageSocketCall & { socket: string; text: string }; response: PageSocketCallResult };
  'pages:socket-close': { request: PageSocketCall & { socket: string }; response: PageSocketCallResult };
  'pages:socket-ping': { request: PageSocketCall & { socket: string }; response: PageSocketCallResult };
  'pages:video-start': { request: PageVideoStartRequest; response: PageVideoStartResult };
  'pages:video-stop': { request: PageVideoCall; response: PageSocketCallResult };
  'pages:video-ping': { request: PageVideoCall; response: PageSocketCallResult };
  // ── Singles ──
  'fs:read-head': { request: { filePath: string; maxBytes?: number }; response: Answer<typeof readFileHead> };
  /** Phone only: the attach button hands a file to the computer, which answers where it landed. */
  'file:upload': { request: { name?: string; data: string }; response: { path: string } | { error: string } };
  'get-home-path': { request: void; response: string };
}
