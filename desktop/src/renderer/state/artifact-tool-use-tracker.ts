import { categorizeArtifact } from '../../shared/artifacts/categorization';
import { resolveTrackedPath } from '../../shared/artifacts/resolve-tracked-path';

/**
 * The artifact tracker: turns Write/Edit/MultiEdit/Read tool-use transcript
 * events into `appendVersion` calls so the file shows up in the Session Drawer,
 * then refreshes that session's drawer list from the sidecar. It also listens
 * for `tool-result` events to record SendUserFile deliveries — see the
 * "delivered" handling below.
 *
 * Extracted from App.tsx (2026-08-15) so it can be pinned by a test. It has no
 * React in it: App.tsx builds one with `createArtifactToolUseTracker(deps)`,
 * feeds it every transcript event, and disposes it on unmount.
 *
 * WHY the refresh is debounced per session, not fired per event: the tracker
 * cannot tell replayed history from live events — opening an old conversation
 * delivers every tool call it ever made through this same handler in one burst
 * (~1,000 for a long session). One `listSession` per event was ~1,000 full
 * reads of a multi-MB sidecar in the main process, on top of the appends; the
 * drawer only needs the state after the burst settles. Appends themselves are
 * coalesced on the main-process side (artifact-store.ts appendVersion queue).
 */

export interface TrackerAppendArgs {
  path: string;
  kind: 'internal' | 'external';
  absolutePath: string | null;
  type: 'create' | 'edit' | 'read' | 'delivered';
  author: 'agent';
  /** Transcript tool_use id — appendVersion's replay-dedupe key. */
  toolUseId?: string;
}

export interface ArtifactToolUseTrackerDeps {
  /** Sessions as the renderer currently knows them (id + cwd are all we read). */
  getSessions: () => ReadonlyArray<{ id: string; cwd?: string }> | undefined;
  /** The drawer's current artifact list for a session (read-dedupe source). */
  getSessionArtifacts: (sessionId: string) => ReadonlyArray<{ kind: string; path?: string; absolutePath?: string | null }>;
  appendVersion: (projectRoot: string, sessionId: string, args: TrackerAppendArgs) => Promise<unknown>;
  listSession: (sessionId: string, projectRoot: string) => Promise<{ ok?: boolean; artifacts?: unknown[] } | undefined>;
  /** Receives the refreshed list for a session. */
  onSessionArtifacts: (sessionId: string, artifacts: unknown[]) => void;
  /** Trailing debounce for the per-session refresh. */
  refreshDelayMs?: number;
  log?: (message: string, error: unknown) => void;
}

export interface ArtifactToolUseTracker {
  handle: (event: unknown) => void;
  dispose: () => void;
}

const DEFAULT_REFRESH_DELAY_MS = 250;
const TRACKED_TOOLS = ['Write', 'Edit', 'MultiEdit', 'Read', 'SendUserFile'];
// EVERY tracked call waits for its RESULT before anything is recorded.
// WHY (2026-09-11): the transcript writes a tool call BEFORE the tool runs —
// measured on 1,464 real Write/Edit calls, the result lands a median 0.14 s
// later, and 32 of them waited over a second (a permission prompt waits as long
// as the user does). Recording at call time asked the drawer's on-disk check
// about a file that did not exist yet, so a brand-new file showed "deleted"
// until the drawer was reopened; and a call the user DENIED, or an Edit that
// failed, was listed as a real change. SendUserFile always worked this way for
// the same reason. Bounded so a session that dies between call and result
// cannot grow the map forever.
const PENDING_CALLS_CAP = 200;

type PendingCall =
  | { sessionId: string; tool: 'SendUserFile'; files: string[] }
  | { sessionId: string; tool: 'Write' | 'Edit' | 'MultiEdit' | 'Read'; targetPath: string };

export function createArtifactToolUseTracker(deps: ArtifactToolUseTrackerDeps): ArtifactToolUseTracker {
  const refreshDelayMs = deps.refreshDelayMs ?? DEFAULT_REFRESH_DELAY_MS;
  const log = deps.log ?? ((m, e) => console.error(m, e));
  // One pending refresh per session, keyed by sessionId; re-armed on every
  // settled append so the drawer refreshes once after the burst.
  const pendingRefresh = new Map<string, { timer: ReturnType<typeof setTimeout>; projectRoot: string }>();
  let disposed = false;

  const pendingCalls = new Map<string, PendingCall>();

  const hold = (toolUseId: string, call: PendingCall) => {
    if (pendingCalls.size >= PENDING_CALLS_CAP) pendingCalls.delete(pendingCalls.keys().next().value as string);
    pendingCalls.set(toolUseId, call);
  };

  const settle = (toolUseId: string | undefined, isError: boolean) => {
    if (!toolUseId) return;
    const pending = pendingCalls.get(toolUseId);
    if (!pending) return;
    pendingCalls.delete(toolUseId);
    if (isError) return;          // denied, failed or cancelled — nothing happened on disk
    if (pending.tool === 'SendUserFile') recordDelivery(toolUseId, pending.sessionId, pending.files);
    else recordFileCall(toolUseId, pending.sessionId, pending.tool, pending.targetPath);
  };

  const recordDelivery = (toolUseId: string, sessionId: string, files: string[]) => {
    const pending = { sessionId, files };
    const session = deps.getSessions()?.find?.((s) => s.id === pending.sessionId);
    const projectRoot: string = session?.cwd ?? '';
    if (!projectRoot) return;
    // One append per file, all sharing the call's toolUseId: main's replay
    // dedupe is per artifact record, so a 4-file call yields 4 records and a
    // replayed transcript adds nothing.
    const appends = pending.files.map((file) => {
      const resolved = resolveTrackedPath(file, projectRoot);
      const args: TrackerAppendArgs = {
        path: resolved.path, kind: resolved.kind, absolutePath: resolved.absolutePath,
        type: 'delivered', author: 'agent', toolUseId,
      };
      return Promise.resolve(deps.appendVersion(projectRoot, pending.sessionId, args))
        .catch((e) => log('[artifact-tracker] appendVersion (delivered) failed', e));
    });
    void Promise.all(appends).finally(() => scheduleRefresh(pending.sessionId, projectRoot));
  };

  const scheduleRefresh = (sessionId: string, projectRoot: string) => {
    if (disposed) return;
    const prior = pendingRefresh.get(sessionId);
    if (prior) clearTimeout(prior.timer);
    const timer = setTimeout(() => {
      pendingRefresh.delete(sessionId);
      if (disposed) return;
      Promise.resolve(deps.listSession(sessionId, projectRoot))
        .then((res) => {
          if (disposed) return;
          if (res && res.ok && Array.isArray(res.artifacts)) deps.onSessionArtifacts(sessionId, res.artifacts);
        })
        .catch((e) => log('[artifact-tracker] listSession failed', e));
    }, refreshDelayMs);
    pendingRefresh.set(sessionId, { timer, projectRoot });
  };

  const handle = (raw: unknown) => {
    if (disposed) return;
    const event = raw as { type?: string; sessionId?: string; data?: { toolName?: string; toolUseId?: string; toolInput?: Record<string, unknown>; isError?: boolean } } | null;
    if (!event?.type || !event?.sessionId) return;
    if (event.type === 'tool-result') { settle(event.data?.toolUseId, event.data?.isError === true); return; }
    if (event.type !== 'tool-use') return;
    const toolName: string = event.data?.toolName ?? '';
    if (!TRACKED_TOOLS.includes(toolName)) return;
    // No id = no way to match the result, so nothing can be confirmed. Both
    // transcript sources (Claude Code's JSONL and the native harness) always
    // carry one; an event without it is malformed.
    const toolUseId = event.data?.toolUseId;
    if (typeof toolUseId !== 'string' || !toolUseId) return;
    const input = event.data?.toolInput ?? {};
    if (toolName === 'SendUserFile') {
      const files = Array.isArray(input.files) ? input.files.filter((f): f is string => typeof f === 'string' && f.length > 0) : [];
      if (files.length) hold(toolUseId, { sessionId: event.sessionId, tool: 'SendUserFile', files });
      return;
    }
    const targetPath = (typeof input.file_path === 'string' && input.file_path) || (typeof input.path === 'string' && input.path) || '';
    if (!targetPath) return;

    // Reads are tracked for DOCUMENTS only (plans, notes, mockups, images) so
    // the tool card becomes openable — code/config reads would flood the
    // drawer and aren't what the artifact viewer is for. Writes/Edits track
    // everything (they're genuine changes Claude made).
    if (toolName === 'Read' && categorizeArtifact(targetPath) !== 'document') return;
    hold(toolUseId, { sessionId: event.sessionId, tool: toolName as 'Write' | 'Edit' | 'MultiEdit' | 'Read', targetPath });
  };

  const recordFileCall = (toolUseId: string, sessionId: string, toolName: string, targetPath: string) => {
    const isRead = toolName === 'Read';
    // Resolve cwd by looking up the session — transcript events don't carry cwd.
    const session = deps.getSessions()?.find?.((s) => s.id === sessionId);
    const projectRoot: string = session?.cwd ?? '';
    if (!projectRoot) return;

    // Dedup reads: only the FIRST read of a doc this session appends a 'read'
    // version. Skip if the file is already a known session artifact (already
    // written/edited/read this session) so repeated reads don't stack version
    // noise or bump lastModified on a real artifact. (Replays of the SAME
    // tool call are deduped by toolUseId inside appendVersion.)
    if (isRead) {
      const known = deps.getSessionArtifacts(sessionId) ?? [];
      const tnorm = targetPath.replace(/\\/g, '/');
      const already = known.some((a) => {
        const aPath = (a.kind === 'internal' ? a.path : a.absolutePath) ?? '';
        const an = aPath.replace(/\\/g, '/');
        return an === tnorm || tnorm.endsWith('/' + an) || an.endsWith('/' + tnorm);
      });
      if (already) return;
    }

    // Determine internal vs external. The Session Drawer shows BOTH (a
    // session's activity log includes anything Claude touched); Project View
    // filters externals out unless they're in manualIncludes.
    //
    // resolveTrackedPath also REMAPS cross-device paths: a resumed conversation
    // replays a transcript whose absolute paths were recorded on ANOTHER device
    // (Windows `C:\…\<project>\file` resumed on Linux). Without the remap those
    // synced files mis-filed as external → showed "deleted" in the artifact
    // viewer even though the file is right there under the local root.
    const resolved = resolveTrackedPath(targetPath, projectRoot);

    // Read → 'read' (viewed, not modified); Write → 'create'; Edit/MultiEdit → 'edit'.
    const versionType: 'create' | 'edit' | 'read' =
      isRead ? 'read' : toolName === 'Write' ? 'create' : 'edit';

    const appendArgs: TrackerAppendArgs = {
      path: resolved.path,
      kind: resolved.kind,
      absolutePath: resolved.absolutePath,
      type: versionType,
      author: 'agent',
      toolUseId,
    };
    Promise.resolve(deps.appendVersion(projectRoot, sessionId, appendArgs))
      .catch((e) => log('[artifact-tracker] appendVersion failed', e))
      .finally(() => scheduleRefresh(sessionId, projectRoot));
  };

  const dispose = () => {
    disposed = true;
    for (const { timer } of pendingRefresh.values()) clearTimeout(timer);
    pendingRefresh.clear();
    pendingCalls.clear();
  };

  return { handle, dispose };
}
