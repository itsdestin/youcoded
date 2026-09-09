import { app, IpcMain, BrowserWindow, dialog, clipboard, nativeImage, shell, powerSaveBlocker, webContents } from 'electron';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { CHATSEARCH_IPC } from './chatsearch-index/ipc-channels';
import { resolveConversations, readConversation } from './chatsearch-index/refs-service';
import type { ChatsearchReadRequest } from '../shared/chatsearch-refs';
import https from 'https';
import { execFile } from 'child_process';
import { SessionManager, prepareRunInTerminal, shellDisplayName } from './session-manager';
import { HookRelay } from './hook-relay';
import { IPC, PERMISSION_OVERRIDES_DEFAULT, SESSION_FLAG_NAMES, type SessionFlagName, type SessionProvider, type TranscriptEvent, type TranscriptPageRequest, type TranscriptPageResult, type HookEvent, type SpecialistsEvent, type ShellEvent } from '../shared/types';
import { isPlaceholderModelId } from '../shared/model-ids';
import { hasRealTitle } from '../shared/session-title';
import { setPermissionOverrides } from './main';
import { LocalSkillProvider } from './skill-provider';
import { CommandProvider } from './command-provider';
import { IntegrationInstaller, listWithState } from './integration-installer';
import { RemoteConfig } from './remote-config';
import { RemoteServer } from './remote-server';
import { TranscriptWatcher } from './transcript-watcher';
import { readTranscriptPage } from './transcript-page';
import { nativeStoreSlug, ccProjectSlug } from './slug-encoding';
// Native runtime (platform roadmap Phase 1 Plan A) — the first-party harness
// stack: provider CRUD + key management, model catalog, and the live-session
// registry that owns HarnessSessions and their persistence.
import { NativeHome } from './native-home';
import { SecretsStore } from './providers/secrets-store';
import { ProviderRegistry } from './providers/provider-registry';
// Sign in with ChatGPT (backend design 2026-09-05 §1): constructed by main.ts
// (it needs the post-dev-profile userData) and passed IN; this file only wires it.
import type { ChatGptAuth } from './providers/chatgpt-auth';
// Task 7: native auto-title generation over the AI SDK — the SAME `ai`
// package harness-session.ts already depends on (never through
// HarnessSession.send(), which hard-throws on re-entrancy).
import { generateText } from 'ai';
import type { ModelBinding } from '../shared/provider-types';
import { createNativeTitleFeeder } from './native-title-feeder';
import { reapplyStoredTitle, type ResumeTitleDeps } from './native-resume-title';
import { ModelCatalog } from './providers/model-catalog';
import { EngineManager } from './engine/engine-manager';
// Faster-engine prerequisites (2026-09-05 §A5) — a pure-ish read of this
// machine, so it needs no manager instance.
import { enginePrereqs } from './engine/rocm-prereqs';
import type { EngineModel as EngineModelType } from '../shared/engine-types';
import { ModelManager } from './models/model-manager';
import type { ModelSettingsWrite } from '../shared/model-manager-types';
import { detectEndpoints } from './models/endpoint-detectors';
import { ENGINE_PORT } from '../shared/ports';
import { SessionStore } from './harness/session-store';
import { NativeSessionHost } from './harness/native-session-host';
import { SpecialistCatalog, toListResult } from './harness/specialists/catalog';
import type { ProfileProviderType } from './harness/capability-profile';
import { PermissionStore } from './harness/permission-store';
import { StepGuardSettings } from './harness/step-guard-settings';
// Type-only: the payload the permissions:remove handler forwards to the host.
import type { PermissionRule } from '../shared/permission-types';
// Task 7b: the MCP registry (WHICH servers ~/.youcoded/mcp.json configures)
// and the pooled connection manager that acquire()s them per session. See the
// construction site below for the eager-vs-lazy invariant this must preserve.
import { McpRegistry } from './harness/mcp/mcp-registry';
import { McpManager } from './harness/mcp/mcp-manager';
import { createConnection } from './harness/mcp/mcp-client';
// WebSearch provider stack (Phase 2 Plan B): keyed Tavily/Exa upgrades + the
// chain-walking SearchService injected into the native tool framework.
import { SearchKeyStore } from './harness/search/search-key-store';
import { SearchService } from './harness/search/search-service';
import { SearchChain } from './harness/search/search-chain';
import { exaBackend } from './harness/search/backends/exa';
import { ddgBackend } from './harness/search/backends/ddg';
import { tavilyBackend } from './harness/search/backends/tavily';
import type { NativePermissionMode } from '../shared/permission-types';
import { resolveMappingAction } from './session-id-mapping';
import { listPastSessions, loadHistory } from './session-browser';
import { TranscriptPageSources, type ResolvedPageSource } from './transcript-page-source';
import { readTranscriptMeta } from './transcript-utils';
import { startThemeWatcher, listUserThemes, userThemeDir, userThemeManifest, THEMES_DIR } from './theme-watcher';
import { isBundledPlugin } from '../shared/bundled-plugins';
import { ThemeMarketplaceProvider } from './theme-marketplace-provider';
import { generateThemePreview } from './theme-preview-generator';
// The KDE script that lets the buddy move itself on a Wayland desktop.
import { helperStatus, installHelper, removeHelper, type HelperStatus } from './kwin-helper';
import { getSyncStatus, getSyncConfig, setSyncConfig, forceSync, getSyncLog, dismissWarning, addBackend, removeBackend, updateBackend, pushBackend, type SyncWarning } from './sync-state';
// Cross-device sync spaces (spec 2026-07-03) — the folder-based sync engine.
import {
  syncSpacesStatus, syncSpacesEnable, syncSpacesSyncNow, syncSpacesCreateProject, syncSpacesImportProject,
  syncSpacesRenameProject, syncSpacesStopProject, syncSpacesSetProjectDescription, getManagedRoots, isSyncSpacesEnabled, getLastSyncByDevice,
  getSelfLastSyncEpochMs, isSyncSpacesSyncing,
} from './sync-spaces/service';
// Self-row recency derivation (spec §4) — pure fn so the ms→wire-seconds
// conversion and the sync-spaces-vs-legacy-marker precedence are unit tested.
import { deriveSelfLastSyncEpochSec } from './sync-spaces/self-sync-status';
import { readDevices, renameDevice, removeDevice } from './sync-spaces/device-registry';
// Connect-GitHub modal (device-flow auth) — detectGh/installGh are step fns;
// createGithubConnect is the stateful orchestrator that owns the in-flight flow.
import { installGh } from './github-auth';
import { createGithubConnect, setGithubConnect, disconnectGithub } from './github-connect';
import { combinedGithubStatus } from './github-client';
import { getConfig as getMarketplaceConfig, setConfig as setMarketplaceConfig } from './marketplace-config-store';
import { readComponent, type ComponentKind } from './marketplace-file-reader';
import { checkSyncPrereqs, installRclone, checkGdriveRemote, authGdrive, authGithub, createGithubRepo } from './sync-setup-handlers';
import { log } from './logger';
import { readLogTail, gatherDiagnostics, summarizeIssue, submitIssue, installWorkspace, openDevSessionIn } from './dev-tools';
import { createUpdateInstaller, findCachedDownload, makeLaunchInstaller, UpdateInstallError } from './update-installer';
import type { UpdateProgressEvent } from '../shared/update-install-types';
import { getChangelog } from './changelog-service';
// Analytics opt-out — Phase 6. The two exported functions read/write
// ~/.claude/youcoded-analytics.json; runAnalyticsOnLaunch (wired in main.ts)
// short-circuits when optIn is false.
import { getOptIn as getAnalyticsOptIn, setOptIn as setAnalyticsOptIn } from './analytics-service';
// Saved-folder store — extracted so sync-spaces/ can share the reader/writer.
import { SavedFolder, readFolders, writeFolders } from './saved-folders';
// Shared cap so a local folder's description can't drift from the synced
// registry's limit (project-registry.ts uses the same constant).
import { PROJECT_DESCRIPTION_MAX } from '../shared/artifacts/types';
import { loadConfigSync, writeConfig, getAppliedAtLaunch, getCachedGpu } from './performance-config';
import type { PerformanceConfigSnapshot, SessionInfo } from '../shared/types';
import { ARTIFACT_IPC } from './artifacts/ipc-channels';
// 2026-08-27 OOM fix: read-only handlers (list, get, save, check-existence,
// the binary-roots pass) go through readSidecarShared — one parsed copy per
// project however many callers ask at once. Only the manual include/exclude
// handlers, which mutate and write back, keep the private readSidecar.
import { appendVersion, readSidecar, readSidecarShared, writeSidecar, renameArtifact, removeArtifactRecord, runSidecarMigration } from './artifacts/artifact-store';
import { listProjects, removeProject } from './artifacts/central-index';
// Shared with remote-server.ts — see that module's header for why these left
// this file (they were closures, so the remote transport could not reach them).
import { countArtifacts, projectAllFiles, isGatedRoot, listProjectsIndex } from './artifacts/projects-index';
import { invalidateDiscoveryCache } from './artifacts/project-file-discovery';
import { ensureProject, ensureProjectCoalesced, applyGitTreatmentCoalesced } from './artifacts/project-manager';
import { sweepStaleTmp } from './artifacts/cas-write';
import { canonicalize } from '../shared/artifacts/canonicalize';
import { evaluateBinaryRead } from './artifacts/read-binary-access';
import { readFileHead } from './fs-read-head';
import { initProjectWatchers, watchProject, unwatchProject, dropSubscriber, noteOwnWrite, invalidateSidecarIdCache } from './artifacts/project-watcher';
import { searchProjectContent } from './artifacts/content-search';
import { looksBinary, EDIT_MAX_BYTES, FULL_READ_MAX_BYTES, READ_BINARY_MAX_BYTES } from '../shared/artifacts/editable-path-policy';
import { decideOverCapRead } from '../shared/artifacts/over-cap-read';
import { authorizeArtifactRead, authorizeArtifactWrite, isAbsoluteRecorded } from './artifacts/write-authorization';
import { trackedArtifacts } from './artifacts/visible-artifacts';
import { importFile } from './artifacts/import-file';
import { GIT_IPC } from './git/ipc-channels';
import {
  gitFileStatus, gitFileReview, gitCommitFileDiff,
  gitStage, gitUnstage, gitCommit, gitDiscard,
} from './git/git-service';
import { initGitWatchers, watchGit, unwatchGit, dropGitSubscriber } from './git/git-watcher';
import { resolveRepoRoot, invalidateRepoRootCache } from './git/git-exec';
import { PROJECT_IPC } from './project/ipc-channels';
import { listProjectConversations, projectConversationHistory } from './project-conversations';
// Conversation Store (Phase 2a): live intake of transcript activity, session
// cwd, title and flag changes. Keyed by CLAUDE session id (resolved from the
// desktop id via sessionIdMap below), matching the store's record id.
import { noteTranscriptEvent, noteSessionStarted, noteSessionEnded, noteTitleChanged, noteFlagChanged, noteSessionNote, noteModelUsed, getConversationStore, flushSessionToSpace, buildLocalProjectResolver, emitConversationMetaChanged } from './conversations/service';
import { requestChatsearchRefresh } from './chatsearch-index/index-service';
// Task 4: resolves a native session's live model binding into the store's
// portable {modelId, providerType, providerLabel} shape — see
// portable-model.ts's WHY comment for why the lookup itself is split out.
import { bindingToPortableModel } from './conversations/portable-model';
import type { PortableModelRef } from './conversations/store-core';
// Plan 2b Task 8: holder-side takeover — when another device requests a session
// this device holds, cleanly interrupt/flush/release/move/destroy it.
import { createHolderTakeover } from './conversations/takeover';
import { getTagRegistry } from './conversations/tag-registry-service';
import { tagFlagKey, isTagColor, TagColor } from '../shared/tags';
import { getRepoInfo } from './project-repo';
import { listContext, readContextFile, writeContextFile } from './project-context';

// WHY: the chatsearch outbox drainer lives outside registerIpcHandlers but must
// fire the SAME renderer + remote broadcast the IPC tag/flag/note handlers fire,
// or the conversation list won't repaint when the CLI changes something.
// sendForSession and remoteServer are function-local, so the handler registers
// this bridge at startup — same hand-out pattern as setSessionMetaWiring.
type MetaBroadcaster = (sessionId: string, payload: Record<string, unknown>) => void;
let metaBroadcaster: MetaBroadcaster | null = null;
export function broadcastSessionMeta(sessionId: string, payload: { flag: string; value: boolean } | { note: string }): void {
  metaBroadcaster?.(sessionId, payload);
}

// WHY: same rationale as broadcastSessionMeta above — the outbox drainer
// creates tags directly via getTagRegistry().create(), bypassing the
// TAGS_CREATE handler below (the only other place a new tag reaches a
// renderer/remote broadcast), so without this hand-out a tag the drainer
// creates is invisible to an open window's tag registry and filter list
// until a restart, even though the conversation it tagged already shows it.
type TagsBroadcaster = () => void;
let tagsBroadcaster: TagsBroadcaster | null = null;
export function broadcastTagsChanged(): void {
  tagsBroadcaster?.();
}

// Max age for clipboard paste images (1 hour)
const CLIPBOARD_MAX_AGE_MS = 60 * 60 * 1000;

// Root of ~/.claude — used by artifact handlers to locate the central index.
const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// Native transcript existence probe: does ~/.youcoded/sessions/<slug>/<id>.jsonl
// exist for this cwd? Mirrors NativeHome.sessionPath's convention — the RAW
// frozen nativeStoreSlug, NOT ccProjectSlug (see session-store.ts's slug-divergence
// note). Used by the native RESUME path to validate a cwd BEFORE handing it to
// nativeHost.resume, so session-manager's silent cwd→$HOME fallback can never
// send a resume into the wrong (empty) directory (Task 9).
function nativeTranscriptExists(cwd: string, sessionId: string): boolean {
  return fs.existsSync(path.join(os.homedir(), '.youcoded', 'sessions', nativeStoreSlug(cwd), `${sessionId}.jsonl`));
}

// ─── The Linux/KDE buddy helper: one cached answer, shared by main.ts ────────
//
// WHY a cache at all: two things ask "is the helper live right now?" and
// neither can afford to wait. The drag path asks on EVERY FRAME (60×/second),
// and the answer costs two subprocess calls — so it has to be a value already
// in memory, never a fresh lookup. main.ts is the other reader; it lives here
// rather than there because these handlers are the things that change it.
let helperStatusCache: HelperStatus | null = null;

/**
 * The last answer, or null if we have never had one.
 *
 * Synchronous and allocation-free on purpose — this is what the buddy's drag
 * loop reads.
 */
export function cachedBuddyHelperStatus(): HelperStatus | null {
  return helperStatusCache;
}

/**
 * Ask the desktop again and remember the answer.
 *
 * Called at launch, on every helper-status request, and after a successful
 * add/remove — the last two matter because the user can switch the script off
 * in KDE's own System Settings while YouCoded is running, and a stale "yes it
 * is installed" would leave the buddy switched on and unable to move.
 */
let onHelperLost: (() => void) | null = null;

/**
 * Told what to do when the helper stops being live under a buddy that is
 * already on screen. Wired by main.ts to `buddyManager.hide()`.
 *
 * WHY this exists rather than trusting the Remove button (B4 review, F1):
 * `buddy-window-manager.ts` records that `captionChannelLive` MUST NOT flip
 * true→false while buddy windows exist — after the flip, moves take the
 * `setPosition` branch, which is a silent no-op on Wayland, and `rectOf` starts
 * returning `getBounds()`, frozen at the constructor position, so the chat and
 * bar re-anchor to the screen corner while the mascot stays put. It claimed
 * removal-forces-hide as the guarantee, but removal is not the only writer:
 * design §4 added the on-show re-check EXACTLY so that switching the script off
 * in KDE's own System Settings mid-session is noticed, and a momentary DBus
 * failure does the same. Noticing without acting produced the undraggable,
 * corner-anchored buddy this whole feature exists to eliminate.
 */
export function setBuddyHelperLostHandler(fn: (() => void) | null): void {
  onHelperLost = fn;
}

export async function refreshBuddyHelperStatus(): Promise<HelperStatus> {
  const wasLive = helperStatusCache?.needed === true && helperStatusCache.installed === true;
  try {
    helperStatusCache = await helperStatus();
  } catch (err) {
    // WHY the previous answer is kept rather than thrown away: `needed` is
    // decided from two facts that cannot change while the app runs (which OS
    // this is, and whether Electron's own windows are Wayland-native), so an
    // answer we already have is still true about THAT half. What a failed call
    // costs us is only whether the helper is live right now — so that half is
    // forced to "no", which makes the consent gate refuse instead of guess.
    //
    // WHY a total failure (no previous answer at all) reports needed:false
    // instead of refusing: design §4's failing-safe rule. Getting this wrong in
    // the "false" direction costs a Wayland user exactly today's behaviour — a
    // buddy that cannot be dragged. Getting it wrong the other way TAKES AWAY a
    // working buddy from a Windows, macOS or KDE-X11 user, who never needed a
    // helper in the first place.
    //
    // BUT THIS BRANCH IS NOT THE RULE THAT GOVERNS IN PRACTICE (B4 review, F3).
    // helperStatus() has no rejecting path today — supportGate() turns an
    // unreachable KWin into { supported: false }, and kdeCall catches its own
    // exec errors — so a real mid-session KDE outage lands on the NON-throwing
    // path above: { needed: true, supported: false, installed: false }, which
    // the consent gate refuses. That is the right direction (no buddy beats an
    // undraggable one), and it is the behaviour to reason about. This branch is
    // insurance against a future throw, not the live decision.
    helperStatusCache = helperStatusCache
      ? { ...helperStatusCache, installed: false, reason: err instanceof Error ? err.message : String(err) }
      : { needed: false, supported: false, installed: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const isLive = helperStatusCache.needed === true && helperStatusCache.installed === true;
  // The transition, not the button, is the trigger. See setBuddyHelperLostHandler.
  if (wasLive && !isLive) onHelperLost?.();
  return helperStatusCache;
}

/**
 * Why the buddy is being refused, or null when he may be shown.
 *
 * PURE, and exported so buddy-consent-gate.test.ts can drive every state
 * without a compositor. The rule the design asks for (§5) is that consent is
 * enforced HERE, in the main process, and not by an `if` in the settings
 * screen: the settings screen is not the only thing that turns the buddy on —
 * the app also restores him at launch from a saved preference — and a refusal
 * the renderer forgets to make is a helper-less buddy that appears and then
 * refuses to move, which is the exact bug this feature exists to remove.
 *
 * It refuses on `needed`, NEVER on "is this Linux". A KDE user on X11, or on
 * Wayland whose windows are actually X11-backed, positions his own windows
 * perfectly well and must never be refused a buddy he already has.
 */
export function buddyShowRefusal(status: HelperStatus | null): string | null {
  // No helper is needed here — Windows, macOS, Linux/X11, and Wayland running
  // through XWayland. Identical to today, and the most important line here.
  if (!status || !status.needed) return null;
  // Needed and running: the buddy moves by being renamed, so let him through.
  if (status.installed) return null;
  // Needed and NOT running. Report what we actually know — the support gate's
  // own reason when it has one, and otherwise a plain statement of the fact,
  // never a guess at a cause (docs/error-message-standards.md).
  return status.reason ?? 'The buddy needs its KDE helper on this desktop, and the helper is not running.';
}


export function registerIpcHandlers(
  ipcMain: IpcMain,
  sessionManager: SessionManager,
  mainWindow: BrowserWindow,
  skillProvider: LocalSkillProvider,
  commandProvider: CommandProvider,
  hookRelay?: HookRelay,
  remoteConfig?: RemoteConfig,
  remoteServer?: RemoteServer,
  // Multi-window ownership: when a session is created via IPC, assign it to
  // the calling renderer's window so subsequent per-session events route there.
  windowRegistry?: import('./window-registry').WindowRegistry,
  // Plan 2b Task 8 (optional): the lease client + a setter main.ts uses to
  // receive the holder-side takeover handler (which needs the local sessionIdMap,
  // built inside this function). Absent → lease lifecycle wiring is skipped
  // entirely (nothing breaks — acquire/release/takeover simply don't run).
  leaseWiring?: {
    client: import('./conversations/lease-client').LeaseClient;
    setHolderTakeover: (fn: (sessionId: string, from?: { deviceId: string; device: string }) => void) => void;
    // Plan 2b Task 9: the requester-side takeover flow, built in main.ts (where
    // deviceId + hubLeaseRequest + materializeOne + syncSpacesSyncNow are all
    // reachable). The three lease IPC handlers below are thin passthroughs to it.
    requester: import('./conversations/takeover').RequesterTakeoverType;
    // deviceId  — per-INSTALL. Leases ONLY. Distinguishes the dev instance from
    //             the built app on one machine; never use it for the registry.
    // machineId — per-MACHINE. Device registry ONLY (self-marking). '' when this
    //             machine has no durable identity, which matches no row — correct,
    //             since nothing was registered either.
    deviceId: string;
    machineId: string;
  },
  // Sign in with ChatGPT (backend design 2026-09-05 §1, §6): the account object
  // main.ts built inside createWindow. Optional so the tests that call this with
  // four args keep working. It is ALWAYS handed over when it exists — the kill
  // switch (YOUCODED_CHATGPT=0) is applied HERE, not by omitting the argument:
  // under the switch the registry, the catalog and the four handlers get null
  // (no virtual row, no models, answers signed-out/false) while the object
  // itself stays alive as the file reader main.ts's launch check needs.
  chatgptAuth?: ChatGptAuth | null,
) {
  // Broadcast a non-session-scoped event to every renderer. Status data, UI
  // actions, and similar globals must reach every window — not just window 1.
  // Session-scoped events should use sendForSession instead.
  const send = (channel: string, ...args: any[]) => {
    if (windowRegistry) {
      for (const wid of windowRegistry.getWindowIds()) {
        const wc = webContents.fromId(wid);
        if (wc && !wc.isDestroyed()) wc.send(channel, ...args);
      }
      return;
    }
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, ...args);
    }
  };

  // Route a session-scoped emit to the owner AND any buddy subscribers.
  // Ownership and subscription are independent (a buddy window observes a
  // session without claiming ownership), so events must reach both. Falls
  // back to the primary mainWindow when neither owner nor subscribers
  // exist (preserves the existing pre-buddy fallback behavior for
  // remote-created sessions during Phase 1).
  const sendForSession = (sessionId: string, channel: string, ...args: any[]) => {
    const ids = new Set<number>();
    const ownerId = windowRegistry?.getOwner(sessionId);
    if (ownerId != null) ids.add(ownerId);
    if (windowRegistry) {
      for (const subId of windowRegistry.getSubscribers(sessionId)) ids.add(subId);
    }
    if (ids.size > 0) {
      for (const wid of ids) {
        // wid is a webContents.id, NOT a BrowserWindow.id — different ID
        // spaces. BrowserWindow.fromId silently returns null for a
        // webContents.id, so previously every peer-window event fell through
        // to the mainWindow fallback (window 1). webContents.fromId does the
        // correct lookup.
        const wc = webContents.fromId(wid);
        if (wc && !wc.isDestroyed()) wc.send(channel, ...args);
      }
      return;
    }
    // Fallback: no known owner and no subscribers (e.g., remote-created
    // session pre-assignment). Send to mainWindow so these orphaned events
    // still reach a renderer. Note: if `ids` was non-empty but every target
    // webContents was destroyed, the event is silently dropped — the fallback
    // is only taken when no recipients were identified at all.
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
  };

  metaBroadcaster = (sessionId, payload) => {
    sendForSession(sessionId, IPC.SESSION_META_CHANGED, sessionId, payload);
    remoteServer?.broadcast({ type: IPC.SESSION_META_CHANGED, payload: { sessionId, ...payload } });
  };

  // Broadcast a session-scoped channel to EVERY registered main window. Use this
  // (not sendForSession) when the payload is self-scoping — i.e. the renderer only
  // acts on it if it's actually displaying that session — AND the session may have
  // no registered owner. sendForSession's ownerless fallback targets only the
  // PRIMARY mainWindow (window 1), which is the wrong window when the session is
  // shown in a secondary window: the 2026-07-18 "moved pill never appears, session
  // looks like it vanished" bug. A no-op in non-displaying windows makes the
  // fan-out safe. (SESSION_MOVED is such a payload: recordMoved is keyed by
  // sessionId and ignores sessions the window isn't showing.)
  const sendToAllMainWindows = (channel: string, ...args: any[]) => {
    const ids = windowRegistry ? windowRegistry.getWindowIds() : [];
    if (ids.length === 0) {
      // No registry / nothing registered — preserve the pre-buddy single-window
      // behavior so the event still reaches a renderer.
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
      return;
    }
    for (const wid of ids) {
      if (windowRegistry && windowRegistry.getKind(wid) !== 'main') continue; // skip buddy floaters
      const wc = webContents.fromId(wid);
      if (wc && !wc.isDestroyed()) wc.send(channel, ...args);
    }
  };

  // Registry-wide push (not session-scoped): notify every window. Mirrors the
  // getAllWindows loop already used for 'appearance:sync' / 'update:progress'.
  const broadcastToAllWindows = (channel: string, payload: any) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  };

  // WHY defined here (not next to metaBroadcaster above): it needs
  // broadcastToAllWindows, which doesn't exist yet at that point in the
  // function — same hand-out pattern, just wired where its dependency is
  // available. Fires the identical pair the TAGS_CREATE handler below fires.
  tagsBroadcaster = () => {
    remoteServer?.broadcast({ type: IPC.TAGS_CHANGED, payload: {} });
    broadcastToAllWindows(IPC.TAGS_CHANGED, {});
  };

  // --- Theme file watcher ---
  const stopThemeWatcher = startThemeWatcher(mainWindow);

  ipcMain.handle(IPC.THEME_LIST, async () => {
    return listUserThemes();
  });

  // Security: strict slug format to prevent path traversal before path.resolve.
  // Allow leading underscore for reserved internal slugs (e.g. _preview used by theme-builder).
  const SAFE_SLUG_RE = /^[a-z0-9_]+(?:-[a-z0-9_]+)*$/;

  ipcMain.handle(IPC.THEME_READ_FILE, async (_event, slug: string) => {
    if (!SAFE_SLUG_RE.test(slug)) throw new Error('Invalid theme slug');
    const manifestPath = path.resolve(userThemeManifest(slug));
    if (!manifestPath.startsWith(THEMES_DIR + path.sep)) throw new Error('Invalid theme slug');
    return fs.promises.readFile(manifestPath, 'utf-8');
  });

  ipcMain.handle(IPC.THEME_WRITE_FILE, async (_event, slug: string, content: string) => {
    if (!SAFE_SLUG_RE.test(slug)) throw new Error('Invalid theme slug');
    const themeDir = path.resolve(userThemeDir(slug));
    if (!themeDir.startsWith(THEMES_DIR + path.sep)) throw new Error('Invalid theme slug');
    await fs.promises.mkdir(path.join(themeDir, 'assets'), { recursive: true });
    await fs.promises.writeFile(path.join(themeDir, 'manifest.json'), content, 'utf-8');
  });

  // Window controls — used by custom caption buttons on Windows/Linux.
  // Operate on the SENDING window (BrowserWindow.fromWebContents), not the
  // primary mainWindow — otherwise window 2's caption buttons all act on
  // window 1.
  ipcMain.handle(IPC.WINDOW_MINIMIZE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.minimize();
  });
  ipcMain.handle(IPC.WINDOW_MAXIMIZE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.isMaximized() ? win.unmaximize() : win.maximize();
    }
  });
  ipcMain.handle(IPC.WINDOW_CLOSE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();
  });
  // macOS traffic-light repositioning. Non-Mac platforms don't have native
  // traffic lights, so this is a no-op there. Called from theme-engine when
  // chrome-style changes — floating chrome's rounded header would otherwise
  // leave the OS-default (8,12) lights stranded over empty space.
  ipcMain.handle(IPC.WINDOW_SET_TRAFFIC_LIGHT_POS, (event, pos: { x: number; y: number } | null) => {
    if (process.platform !== 'darwin') return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    // Electron 28+: setWindowButtonPosition(null) resets to the platform default.
    // Older fallback: passing undefined also resets. We type-narrow before calling.
    const anyWin = win as unknown as { setWindowButtonPosition: (p: Electron.Point | null) => void };
    anyWin.setWindowButtonPosition(pos ?? null);
  });

  // Theme-driven window + dock icon hot-swap. Called from theme-context whenever
  // the active theme changes. Two URL forms are accepted:
  //   1. theme-asset://<slug>/<relative-path>  — a file in a community/user theme's
  //      asset dir (server resolves the path and confines reads to that dir, so
  //      renderer cannot read arbitrary files).
  //   2. data:image/png;base64,<...>            — an in-memory PNG synthesized by
  //      the renderer (theme-default-icon.ts), used for every theme that doesn't
  //      declare its own appIcon. Capped at MAX_DATA_ICON_BYTES to prevent a
  //      compromised renderer from flooding main with huge buffers.
  // Anything else (or null, or failure) resets to the bundled default icon.
  const DEFAULT_ICON_PATH = path.join(__dirname, '../../assets/icon.png');
  const THEMES_DIR_FOR_ICON = path.join(os.homedir(), '.claude', 'wecoded-themes');
  const MAX_DATA_ICON_BYTES = 1024 * 1024; // 1 MB — a 256px PNG is typically <100KB
  ipcMain.handle(IPC.WINDOW_SET_ICON, (_e, url: string | null) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    let iconImg = nativeImage.createFromPath(DEFAULT_ICON_PATH);
    if (url && typeof url === 'string') {
      try {
        if (url.startsWith('theme-asset://')) {
          const parsed = new URL(url);
          const slug = parsed.hostname;
          if (SAFE_SLUG_RE.test(slug)) {
            const rel = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
            const themeDir = path.join(THEMES_DIR_FOR_ICON, slug);
            const resolved = path.resolve(themeDir, rel);
            if (resolved.startsWith(themeDir + path.sep)) {
              const img = nativeImage.createFromPath(resolved);
              if (!img.isEmpty()) iconImg = img;
            }
          }
        } else if (url.startsWith('data:image/png;base64,') && url.length <= MAX_DATA_ICON_BYTES) {
          const img = nativeImage.createFromDataURL(url);
          if (!img.isEmpty()) iconImg = img;
        }
      } catch { /* fall through to default */ }
    }
    mainWindow.setIcon(iconImg);
    if (process.platform === 'darwin' && app.dock) app.dock.setIcon(iconImg);
  });

  // Zoom controls — each returns the new zoom percentage for the overlay UI
  const ZOOM_STEP = 0.5; // ~12% per step (Electron uses logarithmic scale)
  const ZOOM_MIN = -3;   // ~50%
  const ZOOM_MAX = 5;    // ~300%

  function zoomLevelToPercent(level: number): number {
    return Math.round(Math.pow(1.2, level) * 100);
  }

  ipcMain.handle(IPC.ZOOM_IN, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return 100;
    const current = mainWindow.webContents.getZoomLevel();
    const next = Math.min(current + ZOOM_STEP, ZOOM_MAX);
    mainWindow.webContents.setZoomLevel(next);
    return zoomLevelToPercent(next);
  });

  ipcMain.handle(IPC.ZOOM_OUT, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return 100;
    const current = mainWindow.webContents.getZoomLevel();
    const next = Math.max(current - ZOOM_STEP, ZOOM_MIN);
    mainWindow.webContents.setZoomLevel(next);
    return zoomLevelToPercent(next);
  });

  ipcMain.handle(IPC.ZOOM_RESET, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return 100;
    mainWindow.webContents.setZoomLevel(0);
    return 100;
  });

  ipcMain.handle(IPC.ZOOM_GET, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return 100;
    return zoomLevelToPercent(mainWindow.webContents.getZoomLevel());
  });

  // --- The Linux/KDE buddy helper (design §4) ---
  // Three channels, and only three surfaces (here, preload.ts, remote-shim.ts).
  // The buddy has no Android or remote-server presence at all today, so adding
  // one for the helper would grow this feature into a platform-parity sweep —
  // deliberately not done, and recorded in ipc-channels.test.ts so it does not
  // read as an oversight later.

  // Always a LIVE read, never the cache: the user can turn the script off in
  // KDE's own System Settings at any moment, and the settings popup asks for
  // this every time it opens (design §4 — "re-checked on window-show").
  ipcMain.handle(IPC.BUDDY_HELPER_STATUS, () => refreshBuddyHelperStatus());

  ipcMain.handle(IPC.BUDDY_INSTALL_HELPER, async () => {
    const res = await installHelper();
    // Re-read after a change, not before: the buddy's drag path reads this
    // cached value on every frame, and until it says "installed" the buddy is
    // still gated off. Doing it here means the user's very next click works.
    if (res.ok) await refreshBuddyHelperStatus();
    return res;
  });

  ipcMain.handle(IPC.BUDDY_REMOVE_HELPER, async () => {
    const res = await removeHelper();
    // Same reason in reverse: once the script is out of KDE, the buddy can no
    // longer be moved, so the cache has to know before the next show().
    if (res.ok) await refreshBuddyHelperStatus();
    return res;
  });

  // --- Performance / GPU pref ---
  // The Settings → Performance section reads/writes ~/.claude/youcoded-performance.json
  // through these handlers. The Chromium force-{high,low}-power-gpu switch is
  // applied at module load in main.ts (cannot be changed at runtime), so set-config
  // only persists the value — the renderer is responsible for prompting a restart.
  ipcMain.handle(IPC.PERFORMANCE_GET_CONFIG, (): PerformanceConfigSnapshot => {
    const cfg = loadConfigSync();
    const gpu = getCachedGpu();
    return {
      preferPowerSaving: cfg.preferPowerSaving,
      appliedAtLaunch: getAppliedAtLaunch(),
      multiGpuDetected: gpu.multiGpuDetected,
      gpuList: gpu.gpuList,
    };
  });

  ipcMain.handle(IPC.PERFORMANCE_SET_CONFIG, (_event, payload: { preferPowerSaving: boolean }) => {
    // Validate the payload — IPC inputs are untrusted (a remote browser
    // client could send anything). We coerce to a strict boolean.
    const next = payload?.preferPowerSaving === true;
    writeConfig({ preferPowerSaving: next });
    return { ok: true as const };
  });

  ipcMain.handle(IPC.APP_RESTART, () => {
    // Generic restart channel — reused by any future setting that needs a
    // restart to apply. relaunch() schedules the restart for after exit().
    app.relaunch();
    app.exit(0);
  });

  // --- Theme marketplace ---
  // Phase 3a: pass the shared config store so theme installs also record into
  // the unified youcoded-skills.json packages map used for update tracking.
  const themeMarketplace = new ThemeMarketplaceProvider(skillProvider.configStore);
  // Phase 4: installer is now plugin-backed. Wire in a plugin lookup so the
  // installer can resolve an integration's setup.pluginId to the marketplace
  // entry that installPlugin() needs.
  const integrationInstaller = new IntegrationInstaller({
    getPluginEntryById: async (id: string) => {
      try {
        const entries = await skillProvider.listMarketplace();
        return entries.find((e) => e.id === id) ?? null;
      } catch {
        return null;
      }
    },
  });
  // Drop any stale cached integrations index so the new schema fields
  // (iconUrl, platforms, plugin setup) are picked up on first read.
  integrationInstaller.invalidateCatalogCache();

  ipcMain.handle(IPC.THEME_MARKETPLACE_LIST, async (_event, filters) => {
    return themeMarketplace.listThemes(filters);
  });

  ipcMain.handle(IPC.THEME_MARKETPLACE_DETAIL, async (_event, slug: string) => {
    return themeMarketplace.getThemeDetail(slug);
  });

  ipcMain.handle(IPC.THEME_MARKETPLACE_INSTALL, async (_event, slug: string) => {
    return themeMarketplace.installTheme(slug);
  });

  ipcMain.handle(IPC.THEME_MARKETPLACE_UNINSTALL, async (_event, slug: string) => {
    return themeMarketplace.uninstallTheme(slug);
  });

  ipcMain.handle(IPC.THEME_MARKETPLACE_PUBLISH, async (_event, slug: string) => {
    return themeMarketplace.publishTheme(slug);
  });

  // Publish-lifecycle: resolve button state (draft / in-review / published-current /
  // published-drift / unknown) for a user-authored theme on each detail open.
  ipcMain.handle(IPC.THEME_MARKETPLACE_RESOLVE_PUBLISH_STATE, async (_event, slug: string) => {
    return themeMarketplace.resolvePublishStateForSlug(slug);
  });

  // Manual refresh: drop in-memory registry cache + return a fresh listing in one round-trip.
  ipcMain.handle(IPC.THEME_MARKETPLACE_REFRESH_REGISTRY, async () => {
    themeMarketplace.invalidateRegistryCache();
    return themeMarketplace.listThemes();
  });

  ipcMain.handle(IPC.THEME_MARKETPLACE_GENERATE_PREVIEW, async (_event, slug: string) => {
    try {
      const manifestPath = path.resolve(userThemeManifest(slug));
      if (!manifestPath.startsWith(THEMES_DIR + path.sep)) throw new Error('Invalid theme slug');
      const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8'));
      const previewPath = await generateThemePreview(userThemeDir(slug), manifest);
      // Verify the file really landed on disk — if the generator returned a
      // path but writeFile silently failed, the share sheet would render a
      // broken-image icon. Better to return null and fall back to the swatch.
      const stat = await fs.promises.stat(previewPath).catch(() => null);
      if (!stat || stat.size < 150) {
        console.warn(`[IPC] Preview file missing/tiny after generation: slug=${slug} path=${previewPath} size=${stat?.size ?? 'missing'}`);
        return null;
      }
      return previewPath;
    } catch (err: any) {
      console.warn(`[IPC] Failed to generate theme preview: slug=${slug} err=${err?.message ?? err}`);
      return null;
    }
  });

  // Forward session-created to the owning window. Deferred via nextTick so
  // the SESSION_CREATE IPC handler can run assignSession first — otherwise
  // sendForSession fires before ownership is set and falls back to mainWindow,
  // making a session created in window 2 appear in window 1. Remote-created
  // sessions still fall back to mainWindow since no renderer owns them yet.
  //
  // This only holds because assignSession runs SYNCHRONOUSLY in that handler,
  // before its first await — nextTick outranks the microtask queue, so an
  // assignSession sitting after any await would drain too late. See the WHY on
  // the assignSession block itself; pinned by tests/session-create-ownership-order.test.ts.
  sessionManager.on('session-created', (info) => {
    process.nextTick(() => sendForSession(info.id, IPC.SESSION_CREATED, info));
  });

  // window.claude.terminal.getScreenText — reads the visible xterm buffer
  // for the given session. The actual read happens in the renderer (xterm
  // lives there), so main calls back via executeJavaScript. ~1s cadence
  // under the classifier; round-trip overhead is negligible.
  ipcMain.handle('terminal:get-screen-text', async (event, sessionId: string) => {
    try {
      // Tail read (120 buffer rows): the attention classifier keeps only the
      // last 40 logical lines, so serializing the full 1000+-row scrollback
      // every second was pure waste. 120 rows leaves ample wrap headroom.
      return await event.sender.executeJavaScript(
        `window.__terminalRegistry?.getScreenText(${JSON.stringify(sessionId)}, 120) ?? ''`
      );
    } catch {
      return '';
    }
  });

  // Deps for the resume-time title re-apply (native-resume-title.ts). These are
  // exactly the two calls the title feeder's own onTitle makes — the pill only
  // updates when BOTH fire (sendForSession reaches the owning window's
  // App.tsx sessionRenamed handler; broadcastRename updates SessionInfo, the
  // remote clients, and the window directory).
  const resumeTitleDeps: ResumeTitleDeps = {
    // NOTE: getConversationStore() is null for the whole launch when the managed
    // roots are unavailable (conversations/service.ts sets storePhase
    // 'unavailable'), so on such a machine this reads undefined every time and
    // the re-apply is a permanent no-op. That is survivable, not silent breakage
    // — the title feeder still generates a name at the next turn-complete.
    getStoredTitle: async (sessionId) => (await getConversationStore()?.get('native', sessionId))?.title,
    onTitle: (sessionId, title) => {
      sendForSession(sessionId, IPC.SESSION_RENAMED, sessionId, title);
      broadcastRename(sessionId, title);
    },
  };

  // Session CRUD
  ipcMain.handle(IPC.SESSION_CREATE, async (event, opts) => {
    const info = sessionManager.createSession(opts);
    // Assign the new session to the calling window so per-session events (transcript,
    // pty output, permission prompts) route here once Task 1.4 migrates the emits.
    //
    // MUST stay here — synchronously after createSession, BEFORE the native block's
    // awaits. createSession emits 'session-created' synchronously, and the listener
    // above defers the SESSION_CREATED forward by one process.nextTick precisely so
    // ownership is set first. But nextTick outranks the promise microtask queue, so
    // it drains the moment this handler suspends at its FIRST await — and the native
    // branch below awaits nativeHost.resume/create long before the end of the
    // handler. With this block at the bottom (where it lived until 2026-08-06), a
    // native session created or resumed from a SECOND main window was forwarded with
    // no owner registered, took sendForSession's ownerless mainWindow fallback, and
    // appeared in window 1 instead. Claude Code never hit it: that path runs straight
    // through with no intervening await. Pinned by tests/session-create-ownership-order.test.ts.
    //
    // Exception: if the sender is a buddy window (the floater's compact chat),
    // assign to the leader main window instead. Buddies don't appear in the
    // switcher directory and shouldn't own sessions — otherwise the session
    // would be invisible to every main window's session list. The buddy still
    // sees the session via its subscribe() call in SessionPill.selectSession.
    if (windowRegistry) {
      let targetId = event.sender.id;
      if (windowRegistry.getKind(event.sender.id) === 'buddy') {
        const leader = windowRegistry.getLeaderId();
        if (leader != null) targetId = leader;
      }
      try { windowRegistry.assignSession(info.id, targetId); }
      catch (e) { log('WARN', 'IPC', 'assignSession failed', { error: String(e) }); }
    }
    // Native sessions have no PTY worker — start (or resume) their HarnessSession
    // in the host now that createSession has minted the SessionInfo. The native
    // branch of createSession uses resumeSessionId AS the id, so info.id already
    // equals the resumed id and the host rebuilds the matching session.
    if (info.provider === 'native') {
      // Surface a native-runtime failure as a session-error transcript event on the
      // SAME pipe the host uses (drives NATIVE_SESSION_ERROR → the error banner).
      // Deferred via nextTick so it lands AFTER SESSION_CREATED + assignSession,
      // matching the ordering guarantee the session-created forward relies on.
      const emitNativeSessionError = (text: string) => {
        const errEvent: TranscriptEvent = {
          type: 'session-error', sessionId: info.id, uuid: randomUUID(), timestamp: Date.now(), data: { text },
        };
        process.nextTick(() => {
          sendForSession(info.id, IPC.TRANSCRIPT_EVENT, errEvent);
          remoteServer?.broadcast({ type: 'transcript:event', payload: errEvent });
        });
      };
      // Did a real resume of stored data actually happen? Distinct from
      // `opts.resumeSessionId` being set: a resume can REFUSE (transcript not
      // synced / project folder missing) or fall back to creating a fresh
      // session under the same id. Only a true resume may wear the stored
      // conversation's name — see the re-apply below.
      let didResume = false;
      try {
        if (opts.resumeSessionId) {
          // Task 6: the resume-time model selector's pick (opts.binding, when the
          // renderer already made one — the ResumeBrowser/pre-resume modal ALWAYS
          // offers the selector for native rows) overrides the persisted header
          // binding. Passed straight into resume() so it's applied before the
          // eager loadModel() below and noteModelUsed's resolvePortableModel() both
          // read it — see native-session-host.ts's resume() doc comment for why a
          // post-hoc setBinding here would race those reads.
          //
          // Task 9 — resolve the transcript's REAL cwd BEFORE resume(). session-
          // manager silently rewrites a nonexistent cwd to $HOME (session-manager.ts
          // cwd→homedir); handing that to resume() reads a header from the wrong
          // (empty) slug and the session spawns blank — the native twin of the CC
          // greedy-slug/$HOME bugs (bea0de3e/57be5e14). So NEVER pass an unvalidated
          // cwd: probe the transcript's existence, and on a genuine miss REFUSE with
          // an accurate, split message rather than resolve to $HOME.
          let resolvedCwd: string | undefined;
          let refusal: string | undefined;
          if (opts.cwd && fs.existsSync(opts.cwd) && nativeTranscriptExists(opts.cwd, opts.resumeSessionId)) {
            // Happy path: the transcript is exactly where the caller said (same device).
            resolvedCwd = opts.cwd;
          } else {
            // opts.cwd is absent/foreign or holds no transcript for this id. Consult
            // the synced conversation record and resolve its project folder on THIS
            // device (the SAME resolver the materialize sweep + Resume Browser use).
            const rec = await getConversationStore()?.get('native', opts.resumeSessionId);
            if (rec) {
              const folder = buildLocalProjectResolver()(rec);
              if (folder && nativeTranscriptExists(folder, opts.resumeSessionId)) {
                resolvedCwd = folder;                       // located locally under a resolved folder
              } else if (folder) {
                // Folder is here but its transcript isn't — the record synced ahead
                // of the bytes (a peer created it; this device hasn't pulled it yet).
                refusal = "This conversation hasn't synced to this device yet — its transcript isn't here.";
              } else {
                // The project folder itself isn't present on this device.
                refusal = `This conversation's project folder ('${rec.projectName}') isn't on this device.`;
              }
            }
            // No record AND no local transcript → resolvedCwd/refusal both unset;
            // fall through to the create-fresh-if-binding / 'saved data missing'
            // branch below (an id never persisted ANYWHERE is genuinely-missing
            // data, not a sync/folder gap — keep the original wording).
          }

          if (refusal) {
            emitNativeSessionError(refusal);
          } else if (resolvedCwd) {
            info.cwd = resolvedCwd; // fix the SessionInfo so downstream (noteSessionStarted, eager model, renderer) reads the validated cwd
            didResume = await nativeHost.resume(opts.resumeSessionId, resolvedCwd, opts.binding);
          } else {
            const resumed = await nativeHost.resume(opts.resumeSessionId, info.cwd, opts.binding);
            didResume = resumed;
            // No stored file (e.g. resuming an id that was never persisted) → start
            // a fresh session under the same id so the renderer isn't left with a
            // SessionInfo backed by no live HarnessSession.
            if (!resumed && opts.binding) {
              await nativeHost.create({ sessionId: info.id, cwd: info.cwd, binding: opts.binding, presetId: opts.preset });
            } else if (!resumed && !opts.binding) {
              // Resume asked for a session whose saved data is gone, and we have no
              // binding to start a fresh one under this id — the renderer already
              // holds a live SessionInfo with an empty chat and no way to know why.
              emitNativeSessionError('This conversation could not be resumed — its saved data is missing.');
            }
          }
        } else {
          await nativeHost.create({ sessionId: info.id, cwd: info.cwd, binding: opts.binding, presetId: opts.preset });
        }
        // Stamp the RESOLVED preset id (post legacy-mapping — a stored 'chat'
        // header resolves to 'assistant') onto the SessionInfo so the renderer's
        // preset badge + resume rows can read it. getHarnessId is authoritative
        // after create/resume awaited above.
        info.harnessId = nativeHost.getHarnessId(info.id) ?? undefined;
        // Same stamp as SESSION_LIST, so the very first render of a brand-new
        // session already knows whose plan it is spending (review T6 F1).
        info.providerType = bindingToPortableModel(nativeHost.getBinding(info.id), await providerRegistry.list())?.providerType;

        // Native sessions emit NO CC SessionStart hook, so the CC lease path
        // (sessionIdMap + acquire at the SessionStart listener) never fires for
        // them — without this they run with NO takeover protection at all: a
        // leaseQuery always answers held:false and the resume gate never offers a
        // handoff, so two devices could both resume the same native conversation
        // (2026-07-18 investigation §3.5). For native, info.id IS the claude
        // session id (createSession uses resumeSessionId as the id; fresh native
        // sessions mint one), so the mapping is identity. The existing session-exit
        // release + holder teardown both key off sessionIdMap, so they pick native
        // sessions up unchanged once the entry exists. Registered here (after the
        // host create/resume succeeded) so a FAILED start doesn't take a lease on a
        // dead session.
        sessionIdMap.set(info.id, info.id);
        noteSessionStarted(info.id, info.cwd, 'native');
        // Fix (2026-08-06): fill the header pill in on resume. The renderer
        // named this session 'Resuming…' as a placeholder, and the title feeder
        // only ever pushes a rename when it GENERATES a title — which it
        // correctly refuses to do for an already-titled session. Without this,
        // the placeholder is the last name ever written to the pill.
        // Fire-and-forget: never let a title read delay or fail a resume. Note
        // this deliberately does its OWN store read — the `rec` fetched during
        // cwd resolution above only exists on the foreign-cwd branch, not on
        // the common local-resume path.
        //
        // Gated on didResume, NOT on opts.resumeSessionId: a REFUSED resume
        // (transcript not synced / folder missing) and the "saved data missing,
        // start fresh under the same id" fallback both leave a session that is
        // empty or dead. Naming either after the stored conversation would put
        // a real name on a session that isn't it — worse than the placeholder.
        if (didResume) {
          void reapplyStoredTitle(resumeTitleDeps, info.id);
        }
        // Task 4: seed lastUsedModel the moment a native session comes up (fresh
        // create OR resume) — rides AFTER noteSessionStarted (noteModelUsed is a
        // no-op with no ctx) and AFTER create/resume above (resolvePortableModel
        // needs the binding nativeHost just set up). Fire-and-forget: the missing
        // binding on the "resumed data missing, no fallback binding" error branch
        // above resolves to null here too, so this is naturally a no-op for it.
        void resolvePortableModel(info.id)
          .then((ref) => { if (ref) noteModelUsed(info.id, ref); })
          .catch(() => { /* best-effort — the first turn-complete catches up */ });
        // LEASE FOR NATIVE SESSIONS — re-enabled in M2 (Task 9). It was reverted on
        // 2026-07-18 (PR #176 fallout) with an explicit condition: "Re-enable this
        // together with the parity work, NOT before — the lease only becomes
        // meaningful at the same moment the transcript becomes shared." That moment
        // is now. The native transcript is SHARED: it mirrors into the native/ space
        // lane and materializes on peers (M2 Tasks 4/8), so the lease finally
        // coordinates a REAL cross-device resource. Concretely, leaseQuery now
        // answers held:true for a native conversation another device owns, and the
        // resume gate offers the handoff (holder quiesce → flush → release; requester
        // materialize → acquire) instead of two devices silently resuming two copies.
        //
        // Never-block (spec §3): a failed or DENIED acquire only WARNS — it never
        // prevents the session from running (the resume must not wait on the lease).
        // The warn leaves a breadcrumb so a "takeover didn't respond" is diagnosable
        // (the same gap that hid the 2026-07-18 handoff timeout). For native, info.id
        // IS the claude session id, so the acquire keys off the identity mapping set
        // above. Gated on sync being enabled, mirroring the CC acquire at the
        // SessionStart listener: a lease coordinates cross-device writers, which only
        // exist for a synced conversation — an unsynced native session has no shared
        // resource and needs no lease.
        if (isSyncSpacesEnabled()) {
          void leaseWiring?.client.acquire(info.id)
            .then((res) => {
              if (res && res.ok === false) {
                log('WARN', 'Lease', 'native session running without its lease (held by another device)', { claudeId: info.id, holder: res.holder });
              }
            })
            .catch(() => { /* never-block */ });
        }
      } catch (e) {
        log('ERROR', 'IPC', 'native session start failed', { sessionId: info.id, error: String(e) });
      }
      // Eager-load the bound model the moment the session opens (like LM Studio),
      // so the loading bar + GB progress appear immediately rather than only after
      // the first message. Fire-and-forget; the model poll drives the UI.
      const eagerModelId = nativeHost.modelForSession(info.id);
      if (eagerModelId) { void engineManager.loadModel(eagerModelId).catch(() => { /* engine not installed / boot failed — the first send surfaces it */ }); }
    }
    return info;
  });

  // Pull-style directory snapshot — renderers call this on mount to avoid
  // racing the WINDOW_DIRECTORY_UPDATED push that fires before React subscribes.
  if (windowRegistry) {
    ipcMain.handle(IPC.WINDOW_GET_DIRECTORY, async () => {
      return windowRegistry.getDirectory((id) => sessionManager.getSession(id));
    });
  }

  ipcMain.handle(IPC.SESSION_DESTROY, async (_event, sessionId: string) => {
    // Idempotent + no-op for non-native ids: flushes/tears down the native
    // HarnessSession if this id is live, otherwise returns immediately.
    await nativeHost.destroy(sessionId);
    // Task 7: drop the title feeder's per-session state too — a no-op for
    // non-native ids (the feeder was never fed events for them) and cheap
    // idempotent Map.delete for native ones.
    nativeTitleFeeder.forget(sessionId);
    // Deliberately NOT dropped on session-EXIT: a conversation whose process
    // has ended stays on screen and must stay scrollable, and exit is what
    // stops the transcript watcher. Closing the conversation is the point where
    // nothing can ask for its history again.
    pageSources.forget(sessionId);
    const result = sessionManager.destroySession(sessionId);
    if (result) {
      // Explicit user-initiated destroy → treat as clean exit (0). The
      // reducer no-ops clean exits unless a turn was in flight.
      sendForSession(sessionId, IPC.SESSION_DESTROYED, sessionId, 0);
      windowRegistry?.releaseSession(sessionId);
    }
    return result;
  });

  // Multi-window aware: when a windowRegistry is wired up, scope the list to
  // sessions owned by the calling renderer's window — otherwise a freshly-
  // spawned peer window picks up every session on mount and its ownership-
  // acquired dedup leaves strangers stuck in the local list. Sessions with no
  // owner yet (e.g., remote-created) fall back to the primary window's list
  // so remote clients still see everything. RemoteServer uses its own path
  // and doesn't go through this handler.
  ipcMain.handle(IPC.SESSION_LIST, async (event) => {
    // Stamp each native session with the TYPE of the provider it is bound to.
    // WHY: the renderer decides whose usage numbers to show from the session's
    // model id alone otherwise, and two providers can list the same id — a user
    // with both an OpenAI API key and the ChatGPT plan has `gpt-5.5` twice. The
    // session itself knows which one it is bound to; the model id does not.
    // (Review T6 F1 / design §4.9.) resolvePortableModel returns null for a
    // non-native session or a provider that has left the registry — never a
    // guess, so the renderer falls back to "unknown" rather than to the wrong
    // plan.
    const all = await stampProviderTypes(sessionManager.listSessions());
    if (!windowRegistry) return all;
    const callerId = event.sender.id;
    const primaryId = windowRegistry.getLeaderId();
    return all.filter((s) => {
      const owner = windowRegistry.getOwner(s.id);
      if (owner == null) return callerId === primaryId; // unowned → primary only
      return owner === callerId;
    });
  });

  ipcMain.handle(IPC.SESSION_SWITCH, async (_event, _sessionId: string) => {
    // Switch is a client-side concern on desktop — the renderer manages active session.
    // This handler exists for protocol parity with Android/remote.
    return { ok: true };
  });

  // File picker dialog (attachment paperclip)
  ipcMain.handle(IPC.DIALOG_OPEN_FILE, async () => {
    // NO `filters` on purpose — do NOT re-add a filter list here. Destin's ask
    // is "default to all files, on all platforms", and Electron's dialog API
    // cannot deliver an All-Files DEFAULT alongside a category dropdown:
    //   - Linux: a live D-Bus capture of org.freedesktop.portal.FileChooser.OpenFile
    //     (KDE Plasma, 2026-08-12) showed Electron strips the wildcard filter
    //     (file_dialog_linux.cc GetFilterInfo() keeps only include_all_files,
    //     hardcodes file_type_index=0), Chromium re-appends "*.*" LAST and emits
    //     no current_filter key — so the portal selects the first listed filter
    //     (Images), and app-side ordering can never win. electron#43491, closed
    //     not-planned. A lone All-Files filter is no fix either: '*' serializes
    //     as the glob '*.*', which excludes extensionless files like Makefile.
    //   - Windows: same rule by design — the dialog "picks the first filter as
    //     default, except the All Files one". electron#19492, closed not-planned.
    //   - macOS: filters are a selection allowlist, not a dropdown default, so
    //     a list adds nothing once All Files is present.
    // If a category dropdown is ever wanted, that means an upstream Electron
    // patch or an in-app picker — not a filters array. Pinned by
    // tests/ipc-handlers.test.ts → "dialog:open-file attachment picker filters".
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
    });
    return result.canceled ? [] : result.filePaths;
  });

  // Sound file picker dialog — for custom notification sounds
  ipcMain.handle(IPC.DIALOG_OPEN_SOUND, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        // AIFF/AIF/AIFC covers Apple system sounds in /System/Library/Sounds/.
        // Chromium can't decode AIFF natively; sounds.ts has a JS AIFF parser for it.
        { name: 'Audio Files', extensions: ['mp3', 'wav', 'ogg', 'opus', 'aac', 'm4a', 'flac', 'webm', 'aiff', 'aif', 'aifc'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  // Folder picker dialog
  ipcMain.handle(IPC.DIALOG_OPEN_FOLDER, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // Save clipboard image to temp file (async I/O, cleanup on timer)
  const clipboardTmpDir = path.join(os.tmpdir(), 'claude-desktop-attachments');
  let clipboardCleanupScheduled = false;

  async function cleanupClipboardTemp(): Promise<void> {
    try {
      const files = await fs.promises.readdir(clipboardTmpDir);
      const now = Date.now();
      for (const file of files) {
        if (!file.startsWith('paste-')) continue;
        try {
          const stat = await fs.promises.stat(path.join(clipboardTmpDir, file));
          if (now - stat.mtimeMs > CLIPBOARD_MAX_AGE_MS) {
            await fs.promises.unlink(path.join(clipboardTmpDir, file));
          }
        } catch {}
      }
    } catch {}
  }

  ipcMain.handle(IPC.CLIPBOARD_SAVE_IMAGE, async () => {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    await fs.promises.mkdir(clipboardTmpDir, { recursive: true });

    if (!clipboardCleanupScheduled) {
      clipboardCleanupScheduled = true;
      setInterval(cleanupClipboardTemp, 3600_000);
    }

    const filePath = path.join(clipboardTmpDir, `paste-${Date.now()}.png`);
    await fs.promises.writeFile(filePath, img.toPNG());
    return filePath;
  });

  // Open the YouCoded CHANGELOG on GitHub in the default browser
  ipcMain.handle(IPC.OPEN_CHANGELOG, async () => {
    await shell.openExternal('https://github.com/itsdestin/youcoded/blob/master/CHANGELOG.md');
  });

  // Update panel fetches CHANGELOG.md via this handler. Cached in main;
  // forceRefresh is true only when the popup opens in the update-available path.
  ipcMain.handle(IPC.UPDATE_CHANGELOG, async (_event, opts: { forceRefresh?: boolean } = { forceRefresh: false }) => {
    return getChangelog({ forceRefresh: !!opts.forceRefresh });
  });

  // Open any URL in the default browser (allowlisted to http/https — the
  // scheme is the boundary; any HOST is fine, because the model legitimately
  // hands the user localhost/LAN dev-server links via SendUserLink and the
  // user clicks them explicitly. Never file:, javascript:, etc.
  ipcMain.handle(IPC.OPEN_EXTERNAL, async (_event, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
    }
  });

  // Reveal a local file in the OS file manager. Used by the artifact panel's
  // "Reveal in folder" action. No-op for empty / non-string paths.
  ipcMain.handle(IPC.SHOW_ITEM_IN_FOLDER, async (_event, filePath: string) => {
    if (typeof filePath === 'string' && filePath.length > 0) {
      shell.showItemInFolder(filePath);
    }
  });

  // Open a local file with the OS default app (HTML→browser, .docx→Word, etc.).
  // shell.openPath resolves with '' on success or an error string on failure.
  ipcMain.handle(IPC.OPEN_PATH, async (_event, filePath: string) => {
    if (typeof filePath !== 'string' || filePath.length === 0) return 'no path';
    return shell.openPath(filePath);
  });

  // Read model + context from a transcript JSONL file (async, first/last byte-range reads)
  ipcMain.handle(IPC.READ_TRANSCRIPT_META, async (_event, transcriptPath: string) => {
    try {
      const claudeProjects = path.join(os.homedir(), '.claude', 'projects');
      const resolved = path.resolve(transcriptPath);
      // Fix: + path.sep so a sibling dir like ~/.claude/projects-evil can't pass the prefix check
      if (!resolved.startsWith(claudeProjects + path.sep)) return null;
      return await readTranscriptMeta(transcriptPath);
    } catch {
      return null;
    }
  });

  // --- Model preference persistence ---
  ipcMain.handle('model:get-preference', async () => {
    try {
      const raw = fs.readFileSync(modelPrefPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return parsed.model || 'sonnet';
    } catch {
      return 'sonnet';
    }
  });

  ipcMain.handle('model:set-preference', async (_event, model: string) => {
    try {
      fs.mkdirSync(path.dirname(modelPrefPath), { recursive: true });
      fs.writeFileSync(modelPrefPath, JSON.stringify({ model }));
      return true;
    } catch {
      return false;
    }
  });

  // --- Model modes (fast + effort) persistence ---
  // ~/.claude/youcoded-model-modes.json holds `{ fast, effort }`. These aren't
  // verified from transcripts (Claude Code doesn't include them there) — we
  // trust our local state and rely on the user's ModelPickerPopup as the source of truth.
  const modelModesPath = path.join(os.homedir(), '.claude', 'youcoded-model-modes.json');

  ipcMain.handle('modes:get', async () => {
    try {
      return JSON.parse(fs.readFileSync(modelModesPath, 'utf-8'));
    } catch {
      return { fast: false, effort: 'auto' };
    }
  });

  ipcMain.handle('modes:set', async (_event, modes: { fast?: boolean; effort?: string }) => {
    try {
      let current = { fast: false, effort: 'auto' };
      try { current = { ...current, ...JSON.parse(fs.readFileSync(modelModesPath, 'utf-8')) }; } catch {}
      const merged = { ...current, ...modes };
      fs.mkdirSync(path.dirname(modelModesPath), { recursive: true });
      fs.writeFileSync(modelModesPath, JSON.stringify(merged));
      return merged;
    } catch {
      return null;
    }
  });

  // --- Claude Code settings.json bridge (for Preferences panel) ---
  // Generic get/set keyed by field name so we don't need a handler per setting.
  // Reads/writes ~/.claude/settings.json which Claude Code itself also reads.
  // Field names follow Claude Code's own schema (e.g., 'editorMode', 'defaultMode').
  const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');

  ipcMain.handle('settings:get', async (_event, field: string) => {
    try {
      const raw = fs.readFileSync(claudeSettingsPath, 'utf-8');
      const parsed = JSON.parse(raw);
      // Dot-path support for nested fields like 'permissions.defaultMode'
      return field.split('.').reduce((obj: any, k) => (obj == null ? undefined : obj[k]), parsed);
    } catch {
      return undefined;
    }
  });

  ipcMain.handle('settings:set', async (_event, field: string, value: unknown) => {
    try {
      let existing: Record<string, any> = {};
      try {
        existing = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf-8'));
      } catch {}
      // Dot-path support — write nested fields without clobbering siblings
      const keys = field.split('.');
      let cursor = existing;
      for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i];
        if (cursor[k] == null || typeof cursor[k] !== 'object') cursor[k] = {};
        cursor = cursor[k];
      }
      if (value === null || value === undefined) {
        delete cursor[keys[keys.length - 1]];
      } else {
        cursor[keys[keys.length - 1]] = value;
      }
      fs.mkdirSync(path.dirname(claudeSettingsPath), { recursive: true });
      fs.writeFileSync(claudeSettingsPath, JSON.stringify(existing, null, 2));
      return true;
    } catch {
      return false;
    }
  });

  // --- Appearance preference persistence ---
  ipcMain.handle('appearance:get', async () => {
    try {
      const raw = fs.readFileSync(appearancePrefPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  });

  ipcMain.handle('appearance:set', async (_event, prefs: Record<string, any>) => {
    try {
      let existing: Record<string, any> = {};
      try {
        existing = JSON.parse(fs.readFileSync(appearancePrefPath, 'utf-8'));
      } catch {}
      const merged = { ...existing, ...prefs };
      fs.mkdirSync(path.dirname(appearancePrefPath), { recursive: true });
      fs.writeFileSync(appearancePrefPath, JSON.stringify(merged));
      return true;
    } catch {
      return false;
    }
  });

  // --- Transcript model verification ---
  ipcMain.handle('model:read-last', async (_event, transcriptPath: string) => {
    try {
      // Security: validate path stays within Claude projects directory (prevents arbitrary file read)
      const claudeProjects = path.join(os.homedir(), '.claude', 'projects');
      const resolved = path.resolve(transcriptPath);
      if (!resolved.startsWith(claudeProjects + path.sep)) return null;

      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const lines = content.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type === 'assistant' && entry.message?.model) {
            return entry.message.model;
          }
        } catch { continue; }
      }
      return null;
    } catch {
      return null;
    }
  });

  // --- Session defaults persistence ---
  const DEFAULTS_INITIAL = {
    skipPermissions: false,
    model: 'sonnet',
    projectFolder: '',
    permissionOverrides: { ...PERMISSION_OVERRIDES_DEFAULT },
  };

  // Load permission overrides into main.ts cache on startup
  function syncPermissionOverrides(defaults: Record<string, any>) {
    const overrides = defaults.permissionOverrides;
    if (overrides && typeof overrides === 'object') {
      setPermissionOverrides(overrides);
    }
  }

  ipcMain.handle('defaults:get', async () => {
    try {
      const raw = fs.readFileSync(defaultsPrefPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const result = { ...DEFAULTS_INITIAL, ...parsed,
        permissionOverrides: { ...PERMISSION_OVERRIDES_DEFAULT, ...parsed.permissionOverrides },
      };
      syncPermissionOverrides(result);
      return result;
    } catch {
      return { ...DEFAULTS_INITIAL };
    }
  });

  ipcMain.handle('defaults:set', async (_event, updates: Record<string, any>) => {
    try {
      let current: Record<string, any> = { ...DEFAULTS_INITIAL };
      try {
        const parsed = JSON.parse(fs.readFileSync(defaultsPrefPath, 'utf-8'));
        current = { ...current, ...parsed,
          permissionOverrides: { ...PERMISSION_OVERRIDES_DEFAULT, ...parsed.permissionOverrides },
        };
      } catch {}
      // Deep-merge permissionOverrides instead of replacing
      const merged = { ...current, ...updates };
      if (updates.permissionOverrides) {
        merged.permissionOverrides = { ...current.permissionOverrides, ...updates.permissionOverrides };
      }
      fs.mkdirSync(path.dirname(defaultsPrefPath), { recursive: true });
      fs.writeFileSync(defaultsPrefPath, JSON.stringify(merged, null, 2));
      // Update in-memory cache so hook handler picks up changes immediately
      syncPermissionOverrides(merged);
      return merged;
    } catch {
      return null;
    }
  });

  // --- Anonymous analytics opt-out (Phase 6) ---------------------------------
  // Getters and setters for the boolean gate analytics-service reads on launch.
  // The About → Privacy section's toggle drives these; renderer handles the
  // optimistic flip with revert-on-failure, so we don't need to return a bool
  // from the setter.
  ipcMain.handle('analytics:get-opt-in', () => getAnalyticsOptIn());
  ipcMain.handle('analytics:set-opt-in', (_event, enabled: boolean) => {
    setAnalyticsOptIn(Boolean(enabled));
  });

  // --- Folder switcher persistence ---
  // Reader/writer + SavedFolder type now live in ./saved-folders (imported
  // above) so the sync-spaces import flow can rewrite an entry when a folder
  // moves. The FOLDERS_* handlers below call the no-arg forms, which default
  // to the same ~/.claude/youcoded-folders.json path.
  ipcMain.handle(IPC.FOLDERS_LIST, async () => {
    let folders = readFolders();
    // Seed with home directory on first use
    if (folders.length === 0) {
      const home = os.homedir();
      folders = [{ path: home, nickname: 'Home', addedAt: Date.now() }];
      writeFolders(folders);
    }
    // Annotate each folder with whether the path still exists on disk.
    // A saved folder that lives under ~/YouCoded/Projects/ IS a managed sync
    // project (the import flow rewrites saved entries to their new managed
    // path) — badge it like the synthesized managed rows below.
    const projectsRoot = getManagedRoots()?.projectsRoot;
    const projectsPrefix = projectsRoot ? path.resolve(projectsRoot).toLowerCase() + path.sep : null;
    const result: any[] = folders.map(f => ({
      ...f,
      exists: fs.existsSync(f.path),
      ...(projectsPrefix && path.resolve(f.path).toLowerCase().startsWith(projectsPrefix)
        ? { managed: true } : {}),
    }));
    // Managed projects (spec §3) always appear in the session-creation picker,
    // deduped against saved folders by normalized path. `managed: true` lets
    // the renderer badge them. addedAt:0 sorts them below user-added folders.
    const managed = getManagedRoots()?.listProjects() ?? [];
    const known = new Set(result.map(f => path.resolve(f.path).toLowerCase()));
    for (const p of managed) {
      if (!known.has(path.resolve(p.path).toLowerCase())) {
        result.push({ path: p.path, nickname: p.name, addedAt: 0, exists: true, managed: true });
      }
    }
    return result;
  });

  ipcMain.handle(IPC.FOLDERS_ADD, async (_event, folderPath: string, nickname?: string) => {
    const folders = readFolders();
    // Deduplicate by normalized path
    const normalized = path.resolve(folderPath);
    if (folders.some(f => path.resolve(f.path) === normalized)) {
      return folders.find(f => path.resolve(f.path) === normalized);
    }
    const entry: SavedFolder = {
      path: normalized,
      nickname: nickname || path.basename(normalized),
      addedAt: Date.now(),
    };
    folders.unshift(entry);
    writeFolders(folders);
    return entry;
  });

  ipcMain.handle(IPC.FOLDERS_REMOVE, async (_event, folderPath: string) => {
    const folders = readFolders();
    // Compare case-insensitively on Windows (paths are case-insensitive there).
    // WHY: Project View passes the project's CANONICAL path (lowercase drive,
    // e.g. c:\…) while the store holds the path.resolve form (uppercase drive,
    // C:\…). A case-sensitive compare would silently fail to remove the entry.
    const samePath = (a: string, b: string) =>
      process.platform === 'win32'
        ? a.toLowerCase() === b.toLowerCase()
        : a === b;
    const normalized = path.resolve(folderPath);
    const filtered = folders.filter(f => !samePath(path.resolve(f.path), normalized));
    if (filtered.length === folders.length) return false;
    writeFolders(filtered);
    return true;
  });

  ipcMain.handle(IPC.FOLDERS_RENAME, async (_event, folderPath: string, nickname: string) => {
    const folders = readFolders();
    const normalized = path.resolve(folderPath);
    const entry = folders.find(f => path.resolve(f.path) === normalized);
    if (!entry) return false;
    entry.nickname = nickname;
    writeFolders(folders);
    return true;
  });

  ipcMain.handle(IPC.FOLDERS_SET_DESCRIPTION, async (_event, folderPath: string, description: string) => {
    const folders = readFolders();
    const normalized = path.resolve(folderPath);
    const entry = folders.find(f => path.resolve(f.path) === normalized);
    if (!entry) return false;
    // Trim + cap here as well as in the UI: the renderer is a mirror, never the
    // boundary (same rule as the artifact write policy). String(… ?? '') matches
    // the remote-server path's coercion: the renderer always sends a string
    // today, but the two transports must be equally defensive so a future
    // null/undefined caller throws on neither surface rather than only one.
    entry.description = String(description ?? '').trim().slice(0, PROJECT_DESCRIPTION_MAX) || null;
    writeFolders(folders);
    return true;
  });

  // --- Skills discovery & marketplace ---
  ipcMain.handle(IPC.SKILLS_LIST, async () => {
    return skillProvider.getInstalled();
  });

  ipcMain.handle(IPC.COMMANDS_LIST, async () => {
    return commandProvider.getCommands();
  });

  ipcMain.handle(IPC.SKILLS_LIST_MARKETPLACE, async (_event, filters) => {
    return skillProvider.listMarketplace(filters);
  });

  ipcMain.handle(IPC.SKILLS_GET_DETAIL, async (_event, id: string) => {
    return skillProvider.getSkillDetail(id);
  });

  ipcMain.handle(IPC.SKILLS_SEARCH, async (_event, query: string) => {
    return skillProvider.search(query);
  });

  ipcMain.handle(IPC.SKILLS_INSTALL, async (_event, id: string) => {
    const result = await skillProvider.install(id);
    // Reload plugins so Claude Code discovers the new plugin. Uses a
    // short delay because firing immediately races the prompt-ready state
    // (the reload gets queued but silently no-ops). Matches Android
    // behavior (SessionService.kt:458).
    if (result.status === 'installed' && result.type === 'plugin') {
      sessionManager.broadcastReloadPlugins();
    }
    return result;
  });

  ipcMain.handle(IPC.SKILLS_UNINSTALL, async (_event, id: string) => {
    // Defense-in-depth: UI disables the uninstall button for bundled
    // plugins; reject here too so a stale client or direct IPC call can't
    // bypass it.
    if (isBundledPlugin(id)) {
      return { ok: false, error: 'bundled', type: 'plugin' };
    }
    const result = await skillProvider.uninstall(id);
    // Reload plugins so Claude Code drops the uninstalled plugin — matches
    // Android behavior (SessionService.kt:490)
    if (result.type === 'plugin') {
      sessionManager.broadcastReloadPlugins();
    }
    return result;
  });

  ipcMain.handle(IPC.SKILLS_GET_FAVORITES, async () => {
    return skillProvider.getFavorites();
  });

  ipcMain.handle(IPC.SKILLS_SET_FAVORITE, async (_event, id: string, favorited: boolean) => {
    return skillProvider.setFavorite(id, favorited);
  });

  // Theme favorites — parallel to skills:set-favorite. Drives the Appearance
  // panel's favorites-only list and the "My favorite themes" Library section.
  ipcMain.handle(IPC.APPEARANCE_GET_FAVORITE_THEMES, async () => {
    return skillProvider.configStore.getThemeFavorites();
  });

  ipcMain.handle(IPC.APPEARANCE_FAVORITE_THEME, async (_event, slug: string, favorited: boolean) => {
    skillProvider.configStore.setThemeFavorite(slug, favorited);
    // Broadcast to peer windows so ThemeContext re-reads without requiring a
    // polled IPC fetch. Reuses the existing appearance broadcast pipe.
    try {
      const prefs = { themeFavoritesChanged: Date.now() };
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('appearance:sync', prefs);
      }
    } catch { /* best-effort broadcast */ }
    return skillProvider.configStore.getThemeFavorites();
  });

  ipcMain.handle(IPC.SKILLS_GET_CHIPS, async () => {
    return skillProvider.getChips();
  });

  ipcMain.handle(IPC.SKILLS_SET_CHIPS, async (_event, chips) => {
    return skillProvider.setChips(chips);
  });

  ipcMain.handle(IPC.SKILLS_GET_OVERRIDE, async (_event, id: string) => {
    return skillProvider.getOverrides().then(o => o[id] || null);
  });

  ipcMain.handle(IPC.SKILLS_SET_OVERRIDE, async (_event, id: string, override) => {
    return skillProvider.setOverride(id, override);
  });

  ipcMain.handle(IPC.SKILLS_CREATE_PROMPT, async (_event, skill) => {
    return skillProvider.createPromptSkill(skill);
  });

  ipcMain.handle(IPC.SKILLS_DELETE_PROMPT, async (_event, id: string) => {
    return skillProvider.deletePromptSkill(id);
  });

  ipcMain.handle(IPC.SKILLS_PUBLISH, async (_event, id: string) => {
    return skillProvider.publish(id);
  });

  ipcMain.handle(IPC.SKILLS_GET_SHARE_LINK, async (_event, id: string) => {
    return skillProvider.generateShareLink(id);
  });

  ipcMain.handle(IPC.SKILLS_IMPORT_FROM_LINK, async (_event, encoded: string) => {
    return skillProvider.importFromLink(encoded);
  });

  ipcMain.handle(IPC.SKILLS_GET_CURATED_DEFAULTS, async () => {
    return skillProvider.getCuratedDefaults();
  });

  ipcMain.handle(IPC.SKILLS_GET_FEATURED, async () => {
    return skillProvider.getFeatured();
  });

  // Marketplace redesign Phase 3 — integrations IPC. list/status are real;
  // install/uninstall/configure are scaffolded (manifest-only; the actual
  // OAuth + script runner lands with the Google Workspace slice).
  ipcMain.handle(IPC.INTEGRATIONS_LIST, async () => {
    return listWithState(integrationInstaller);
  });
  ipcMain.handle(IPC.INTEGRATIONS_STATUS, async (_e, slug: string) => {
    return integrationInstaller.status(slug);
  });
  ipcMain.handle(IPC.INTEGRATIONS_INSTALL, async (_e, slug: string) => {
    return integrationInstaller.install(slug);
  });
  ipcMain.handle(IPC.INTEGRATIONS_UNINSTALL, async (_e, slug: string) => {
    return integrationInstaller.uninstall(slug);
  });
  ipcMain.handle(IPC.INTEGRATIONS_CONFIGURE, async (_e, slug: string, settings: Record<string, unknown>) => {
    return integrationInstaller.configure(slug, settings);
  });
  ipcMain.handle(IPC.INTEGRATIONS_CONNECT, async (_e, slug: string) => {
    return integrationInstaller.connect(slug);
  });

  // Reports process.platform so the renderer can gate UI (e.g. hide Install
  // buttons on macOS-only integrations when running on Windows). Returns the
  // raw Node code — the renderer uses platform-display.ts to humanize.
  ipcMain.handle(IPC.PLATFORM_GET, () => {
    return process.platform;
  });

  // Phase 4 — user-initiated cache bust. Next fetchIndex/getFeatured refetches.
  ipcMain.handle(IPC.MARKETPLACE_INVALIDATE_CACHE, async () => {
    await skillProvider.invalidateCache();
  });

  // Decomposition v3 §9.9: surface integration info for the detail view badges
  ipcMain.handle(IPC.SKILLS_GET_INTEGRATION_INFO, async (_event, id: string) => {
    return skillProvider.getIntegrationInfo(id);
  });

  // Decomposition v3 §9.10: onboarding bulk-install curated packages
  ipcMain.handle(IPC.SKILLS_INSTALL_MANY, async (_event, ids: string[]) => {
    return skillProvider.installMany(ids);
  });

  // Decomposition v3 §9.10: onboarding picks an output style
  ipcMain.handle(IPC.SKILLS_APPLY_OUTPUT_STYLE, async (_event, styleId: string) => {
    skillProvider.applyOutputStyle(styleId);
    return { ok: true };
  });

  // Phase 3a: unified marketplace packages map — lets the renderer know which
  // versions are currently installed (for update detection) and the on-disk
  // component paths (for uninstall cascade).
  ipcMain.handle(IPC.MARKETPLACE_GET_PACKAGES, async () => {
    return skillProvider.configStore.getPackages();
  });

  // Phase 3b: update an installed plugin/prompt to the latest marketplace
  // version. Re-downloads files, overwrites at the same path, and bumps the
  // version in youcoded-skills.json. Config is NOT touched.
  ipcMain.handle(IPC.SKILLS_UPDATE, async (_event, id: string) => {
    const result = await skillProvider.update(id);
    // Reload plugins in active sessions so Claude Code picks up updated code
    if (result.ok) {
      sessionManager.broadcastReloadPlugins();
    }
    return result;
  });

  // Phase 3b: update an installed theme to the latest registry version.
  // Re-downloads theme files at the same slug path and bumps the version.
  ipcMain.handle(IPC.THEME_MARKETPLACE_UPDATE, async (_event, slug: string) => {
    return themeMarketplace.updateTheme(slug);
  });

  // Phase 3c: per-entry config — reads/writes ~/.claude/youcoded-config/<id>.json.
  // Only entries that declare configSchema in their marketplace JSON use this.
  ipcMain.handle(IPC.MARKETPLACE_GET_CONFIG, async (_event, id: string) => {
    return getMarketplaceConfig(id);
  });

  ipcMain.handle(IPC.MARKETPLACE_SET_CONFIG, async (_event, id: string, values: Record<string, unknown>) => {
    setMarketplaceConfig(id, values);
    return { ok: true };
  });

  // In-app file viewer — reads a SKILL.md / command / agent file for a plugin.
  // Tries the local install dir first, then falls back to a raw GitHub URL
  // derived from the marketplace entry's sourceType/sourceRef.
  ipcMain.handle(IPC.MARKETPLACE_READ_COMPONENT, async (
    _event, args: { pluginId: string; kind: ComponentKind; name: string },
  ) => {
    try {
      return await readComponent(args, () => skillProvider.listMarketplace());
    } catch (err) {
      return { error: (err as Error).message };
    }
  });

  // --- Remote access settings ---
  let keepAwakeBlockerId: number | null = null;
  let keepAwakeTimeout: ReturnType<typeof setTimeout> | null = null;

  function applyKeepAwake(hours: number) {
    // Clear existing blocker
    if (keepAwakeBlockerId !== null) {
      powerSaveBlocker.stop(keepAwakeBlockerId);
      keepAwakeBlockerId = null;
    }
    if (keepAwakeTimeout) {
      clearTimeout(keepAwakeTimeout);
      keepAwakeTimeout = null;
    }
    // Start new blocker if hours > 0
    if (hours > 0) {
      keepAwakeBlockerId = powerSaveBlocker.start('prevent-app-suspension');
      keepAwakeTimeout = setTimeout(() => {
        if (keepAwakeBlockerId !== null) {
          powerSaveBlocker.stop(keepAwakeBlockerId);
          keepAwakeBlockerId = null;
        }
        if (remoteConfig) {
          remoteConfig.keepAwakeHours = 0;
          remoteConfig.save();
        }
      }, hours * 60 * 60 * 1000);
    }
  }

  if (remoteConfig) {
    // Apply saved keep-awake on startup
    if (remoteConfig.keepAwakeHours > 0) applyKeepAwake(remoteConfig.keepAwakeHours);
    ipcMain.handle(IPC.REMOTE_GET_CONFIG, async () => {
      return {
        ...remoteConfig.toSafeObject(),
        clientCount: remoteServer?.getClientCount() ?? 0,
      };
    });

    ipcMain.handle(IPC.REMOTE_SET_PASSWORD, async (_event, password: string) => {
      await remoteConfig.setPassword(password);
      remoteServer?.invalidateTokens();
      return true;
    });

    ipcMain.handle(IPC.REMOTE_SET_CONFIG, async (_event, updates: { enabled?: boolean; trustTailscale?: boolean; keepAwakeHours?: number }) => {
      const wasEnabled = remoteConfig.enabled;
      if (typeof updates.enabled === 'boolean') remoteConfig.enabled = updates.enabled;
      if (typeof updates.trustTailscale === 'boolean') remoteConfig.trustTailscale = updates.trustTailscale;
      if (typeof updates.keepAwakeHours === 'number') {
        remoteConfig.keepAwakeHours = updates.keepAwakeHours;
        applyKeepAwake(updates.keepAwakeHours);
      }
      remoteConfig.save();

      // Fix: flipping this toggle used to persist `enabled` and stop there.
      // remoteServer.start() ran exactly once, at boot (main.ts), when the flag
      // was still false — so turning remote access on did nothing until the app
      // was restarted, with no indication that a restart was required. The user
      // saw the toggle on and the browser saw ERR_CONNECTION_REFUSED.
      const toggled = typeof updates.enabled === 'boolean' && updates.enabled !== wasEnabled;
      if (toggled && remoteServer) {
        if (remoteConfig.enabled) {
          try {
            await remoteServer.start();
          } catch (err: any) {
            // Roll the flag back so the persisted state, the UI and reality all
            // agree — otherwise the toggle reads "on" against a dead server.
            remoteConfig.enabled = false;
            remoteConfig.save();
            // Surface the real OS error (EADDRINUSE etc.) rather than guessing
            // at a cause — see docs/error-message-standards.md.
            const detail = err?.message ? String(err.message) : String(err);
            console.error('[remote] start failed:', detail);
            return {
              ...remoteConfig.toSafeObject(),
              error: `Remote access could not start on port ${remoteConfig.port}: ${detail}`,
            };
          }
        } else {
          remoteServer.stop();
        }
      }
      return remoteConfig.toSafeObject();
    });

    ipcMain.handle(IPC.REMOTE_DETECT_TAILSCALE, async () => {
      return RemoteConfig.detectTailscale(remoteConfig.port);
    });

    ipcMain.handle(IPC.REMOTE_GET_CLIENT_COUNT, async () => {
      return remoteServer?.getClientCount() ?? 0;
    });

    ipcMain.handle(IPC.REMOTE_GET_CLIENT_LIST, async () => {
      return remoteServer?.getClientList() ?? [];
    });

    ipcMain.handle(IPC.REMOTE_DISCONNECT_CLIENT, async (_event, clientId: string) => {
      return remoteServer?.disconnectClient(clientId) ?? false;
    });

    ipcMain.handle(IPC.REMOTE_INSTALL_TAILSCALE, async () => {
      return RemoteConfig.installTailscale();
    });

    ipcMain.handle(IPC.REMOTE_AUTH_TAILSCALE, async () => {
      const result = await RemoteConfig.startTailscaleAuth();
      if (result.url) {
        // Fire-and-forget: openExternal rejects when the OS has no handler for
        // the scheme. The URL is returned to the renderer either way, so the
        // user can still copy it — but the rejection must not escape as an
        // unhandled rejection.
        void shell.openExternal(result.url).catch(() => {});
      }
      return result;
    });

    // UI action sync: Electron window broadcasts an action → forward to all remote clients
    ipcMain.on(IPC.UI_ACTION_BROADCAST, (_event, action: any) => {
      remoteServer?.broadcast({ type: 'ui:action', payload: action });
    });

    // UI action sync: Remote client broadcasts an action → forward to Electron window
    sessionManager.on('ui-action', (action: any) => {
      send(IPC.UI_ACTION_RECEIVED, action);
    });
  }

  // --- Session browser (resume) ---
  ipcMain.handle(IPC.SESSION_BROWSE, async () => {
    // Collect active Claude Code session IDs so we can exclude them.
    // Bug 1 (2026-07-13 dogfood): a stale sessionIdMap entry (missed exit event,
    // or a create+resume pair leaving two desktop ids on one claude id) hid a
    // CLOSED session from the browser until restart. Filter to mappings whose
    // desktop session actually still exists — the map is a cache, not truth.
    const activeIds = new Set<string>();
    for (const [desktopId, claudeId] of sessionIdMap.entries()) {
      if (sessionManager.getSession(desktopId)) activeIds.add(claudeId);
    }
    // Task 5: native rows now join the SAME store-overlay enrichment pass CC
    // rows get (flags/tags/note/device/title precedence, lastUsedModel) instead
    // of being bare-concatenated after the fact — see listPastSessions's
    // nativeEntries param. nativeHost.list() is the live/persisted session
    // registry; passing it in (rather than session-browser.ts reading disk
    // itself) keeps NativeSessionHost the one source of truth for what native
    // sessions exist.
    return listPastSessions(activeIds, nativeHost.list());
  });

  ipcMain.handle(IPC.SESSION_HISTORY, async (
    _event,
    sessionId: string,
    projectSlug: string,
    count: number,
    all: boolean,
  ) => {
    return loadHistory(sessionId, projectSlug, count, all);
  });


  // PTY input (fire-and-forget, not request-response)
  ipcMain.on(IPC.SESSION_INPUT, (_event, sessionId: string, text: string) => {
    sessionManager.sendInput(sessionId, text);
  });

  // PTY resize (fire-and-forget)
  ipcMain.on(IPC.SESSION_RESIZE, (_event, sessionId: string, cols: number, rows: number) => {
    sessionManager.resizeSession(sessionId, cols, rows);
  });

  // --- PTY output buffering ---
  // Buffer output per-session until the renderer signals its terminal is mounted.
  // This prevents losing the initial trust prompt on slow systems where
  // PTY output arrives before TerminalView mounts and registers its listener.
  const pendingOutput = new Map<string, string[]>();
  const readySessions = new Set<string>();

  // Perf: previously we dual-sent every PTY chunk to BOTH the per-session
  // channel AND the global IPC.PTY_OUTPUT channel. The global channel existed
  // solely so App.tsx could watch permission-mode strings ("bypass permissions
  // on" etc.) across all sessions with one listener. With many sessions
  // streaming that doubled IPC traffic and forced every BrowserWindow to
  // deserialize output for sessions it may not own. App.tsx now subscribes
  // per-session in sync with session:created / session:destroyed events, so
  // the global broadcast is no longer needed.
  sessionManager.on('pty-output', (sessionId: string, data: string) => {
    if (readySessions.has(sessionId)) {
      sendForSession(sessionId, `pty:output:${sessionId}`, data);
    } else {
      let buf = pendingOutput.get(sessionId);
      if (!buf) {
        buf = [];
        pendingOutput.set(sessionId, buf);
      }
      buf.push(data);
    }
  });

  // Renderer signals terminal is mounted and listening
  ipcMain.on(IPC.TERMINAL_READY, (_event, sessionId: string) => {
    readySessions.add(sessionId);
    const buffered = pendingOutput.get(sessionId);
    if (buffered) {
      for (const data of buffered) {
        sendForSession(sessionId, `pty:output:${sessionId}`, data);
      }
      pendingOutput.delete(sessionId);
    }
  });

  // No-op: Electron has no hardware back button. Registered for shape
  // parity with SessionService.kt's handleBridgeMessage() so the
  // 'system:notify-stack-state' string exists in ipc-handlers.ts too.
  ipcMain.on(IPC.SYSTEM_NOTIFY_STACK_STATE, () => {
    // intentionally empty
  });

  // Forward session exit events — exitCode is piped through to the renderer
  // so the reducer can distinguish clean shutdowns from 'session-died' cases.
  sessionManager.on('session-exit', (sessionId: string, exitCode: number) => {
    sendForSession(sessionId, IPC.SESSION_DESTROYED, sessionId, exitCode);
    pendingOutput.delete(sessionId);
    readySessions.delete(sessionId);
    windowRegistry?.releaseSession(sessionId);
  });

  // --- Prune stale context files on startup ---
  // Context files are written per-session by statusline.sh and cleaned up on
  // session exit, but a crash can leave orphans. Delete any .context-* files
  // that aren't associated with a running session.
  try {
    const claudeDir = path.join(os.homedir(), '.claude');
    const entries = fs.readdirSync(claudeDir);
    for (const entry of entries) {
      // Prune orphaned context + session-stats files from crashed sessions
      if (entry.startsWith('.context-') || entry.startsWith('.session-stats-')) {
        fs.unlink(path.join(claudeDir, entry), () => {});
      }
    }
  } catch { /* directory doesn't exist or unreadable — fine */ }

  // --- Status data poller ---
  // Reads YouCoded cache files and pushes status updates to the renderer
  const usageCachePath = path.join(os.homedir(), '.claude', '.usage-cache.json');
  const announcementCachePath = path.join(os.homedir(), '.claude', '.announcement-cache.json');

  // --- YouCoded app update checker via GitHub Releases API ---
  // Caches the latest release info and refreshes every 30 minutes.
  let cachedUpdateStatus: { current: string; latest: string; update_available: boolean; download_url: string | null } | null = null;
  let lastReleaseCheck = 0;
  const RELEASE_CHECK_INTERVAL = 30 * 60 * 1000; // 30 minutes

  function fetchLatestRelease(): Promise<void> {
    return new Promise((resolve) => {
      const req = https.get('https://api.github.com/repos/itsdestin/youcoded/releases/latest', {
        headers: { 'User-Agent': 'YouCoded', 'Accept': 'application/vnd.github.v3+json' },
        timeout: 10000,
      }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          // Follow redirect (GitHub sometimes redirects)
          https.get(res.headers.location!, { headers: { 'User-Agent': 'YouCoded', 'Accept': 'application/vnd.github.v3+json' }, timeout: 10000 }, (rRes) => {
            let body = '';
            rRes.on('data', (chunk: Buffer) => { body += chunk.toString(); });
            rRes.on('end', () => { parseReleaseResponse(body); resolve(); });
          }).on('error', () => { resolve(); });
          return;
        }
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => { parseReleaseResponse(body); resolve(); });
      });
      req.on('error', () => { resolve(); });
      req.on('timeout', () => { req.destroy(); resolve(); });
    });
  }

  function parseReleaseResponse(body: string) {
    try {
      const release = JSON.parse(body);
      const tagName: string = release.tag_name || '';
      const latestVersion = tagName.replace(/^v/, '');
      const currentVersion = app.getVersion();
      const isNewer = compareVersions(latestVersion, currentVersion) > 0;

      // Find the right installer asset for the current platform
      const assets: Array<{ name: string; browser_download_url: string }> = release.assets || [];
      let downloadUrl: string | null = null;
      const platform = process.platform;
      if (platform === 'win32') {
        // Prefer .exe installer
        const exe = assets.find(a => a.name.endsWith('.exe'));
        downloadUrl = exe?.browser_download_url || null;
      } else if (platform === 'darwin') {
        // Prefer .dmg matching the current arch. electron-builder produces both
        // `YouCoded-<ver>-arm64.dmg` and `YouCoded-<ver>.dmg` (x64, no suffix),
        // and GitHub returns them in non-deterministic order — so a plain
        // `.endsWith('.dmg')` would hand Intel Macs the arm64 DMG (or vice
        // versa), which Gatekeeper refuses to mount. Match by arch first, then
        // fall back to any .dmg if a matching one isn't in the release.
        const wantArm = process.arch === 'arm64';
        const archDmg = assets.find(a => a.name.endsWith('.dmg') && a.name.includes('arm64') === wantArm);
        const anyDmg = assets.find(a => a.name.endsWith('.dmg'));
        downloadUrl = archDmg?.browser_download_url || anyDmg?.browser_download_url || null;
      } else {
        // Linux — prefer .AppImage, fallback to .deb
        const appImage = assets.find(a => a.name.endsWith('.AppImage'));
        const deb = assets.find(a => a.name.endsWith('.deb'));
        downloadUrl = appImage?.browser_download_url || deb?.browser_download_url || null;
      }
      // Fallback to release page if no matching asset found
      if (!downloadUrl) downloadUrl = release.html_url || null;

      cachedUpdateStatus = { current: currentVersion, latest: latestVersion, update_available: isNewer, download_url: downloadUrl };
      lastReleaseCheck = Date.now();
    } catch {
      // Parse failed — keep previous cache or set current version only
      if (!cachedUpdateStatus) {
        cachedUpdateStatus = { current: app.getVersion(), latest: app.getVersion(), update_available: false, download_url: null };
      }
    }
  }

  /** Simple semver compare: returns >0 if a > b, <0 if a < b, 0 if equal */
  function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const na = pa[i] || 0;
      const nb = pb[i] || 0;
      if (na !== nb) return na - nb;
    }
    return 0;
  }

  function getUpdateStatus() {
    // Return cached value, kick off background refresh if stale
    if (Date.now() - lastReleaseCheck > RELEASE_CHECK_INTERVAL) {
      fetchLatestRelease().catch(() => {});
    }
    const status = cachedUpdateStatus || { current: app.getVersion(), latest: app.getVersion(), update_available: false, download_url: null };

    // Dev-only: force update_available=true for manual UpdatePanel verification without waiting for a real release.
    // Set YOUCODED_DEV_FAKE_UPDATE=1 to simulate a new release one patch ahead of the current version.
    // Note: the download_url points at the real GitHub releases page, so clicking Update Now opens the browser
    // to the actual latest release — not the fake +1 version. That's fine for UI verification; no real installer
    // exists for the fake version. No-op unless the env var is exactly '1'.
    // `!app.isPackaged` gate: belt-and-suspenders so a stray env var in a user's
    // shell can't flip the update pill on in a packaged build. Dev-only by design.
    if (!app.isPackaged && process.env.YOUCODED_DEV_FAKE_UPDATE === '1') {
      const currentVersion = app.getVersion();
      const parts = currentVersion.split('.').map(n => parseInt(n, 10));
      const maj = parts[0] || 0;
      const min = parts[1] || 0;
      const patch = parts[2] || 0;
      return {
        current: currentVersion,
        latest: `${maj}.${min}.${patch + 1}`,
        update_available: true,
        download_url: 'https://github.com/itsdestin/youcoded/releases/latest',
      };
    }

    return status;
  }

  // -------------------------------------------------------------------------
  // In-app update installer — download + launch the platform installer.
  // Spec: docs/superpowers/specs/2026-04-22-in-app-update-installer-design.md
  // -------------------------------------------------------------------------
  const updateCacheDir = path.join(app.getPath('userData'), 'update-cache');

  const installer = createUpdateInstaller({
    cacheDir: updateCacheDir,
    onProgress: (ev: UpdateProgressEvent) => {
      // Broadcast to every live renderer. Renderers filter by jobId (single-job
      // invariant in the engine means only one is in flight, but filtering keeps
      // UI state correct if a prior job's final tick arrives after the popup closed).
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('update:progress', ev);
      }
    },
  });

  const launchInstaller = makeLaunchInstaller({
    shellOpenExternal: (url: string) => shell.openExternal(url),
    appRelaunch: () => app.relaunch(),
    fallbackDownloadUrl: () => cachedUpdateStatus?.download_url ?? '',
    // production reads process.env.APPIMAGE (Linux only); tests pass an override.
  });

  // Dev-only fake-update flag: when set AND running from source (unpackaged),
  // short-circuit the download/launch to use a bundled 1 MB dummy installer.
  // Lets us exercise the popup flow end-to-end without a real release. Gated on
  // !app.isPackaged so production builds can never enter this path even if the
  // env var is somehow set.
  const devFakeUpdate = !app.isPackaged && process.env.YOUCODED_DEV_FAKE_UPDATE === '1';

  ipcMain.handle('update:download', async () => {
    if (devFakeUpdate) {
      // Copy the bundled dummy installer into the cache dir so the launch path
      // exercises the same file-move logic it would hit in prod. Emits one
      // synchronous 100% progress event so the renderer sees the full arc.
      const ext = process.platform === 'win32' ? '.exe'
               : process.platform === 'darwin' ? '.dmg'
               : '.AppImage';
      // app.getAppPath() resolves to the desktop/ root (where package.json lives),
      // which is where dev-assets/ sits. More robust than __dirname across dev
      // build variations (tsc watch vs esbuild output).
      const srcPath = path.join(app.getAppPath(), 'dev-assets', `fake-installer${ext}`);
      if (!fs.existsSync(updateCacheDir)) fs.mkdirSync(updateCacheDir, { recursive: true });
      const dstPath = path.join(updateCacheDir, `YouCoded-fake-dev${ext}`);
      fs.copyFileSync(srcPath, dstPath);
      const bytesTotal = fs.statSync(dstPath).size;
      const jobId = `dev-${Date.now()}`;
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('update:progress', { jobId, bytesReceived: bytesTotal, bytesTotal, percent: 100 });
      }
      return { jobId, filePath: dstPath, bytesTotal };
    }
    // Renderer never passes a URL — we resolve main-side from the trusted cache
    // populated by the GitHub Releases check. Prevents renderer from spoofing
    // the download target.
    const status = getUpdateStatus();
    const url = status?.download_url;
    if (!url) throw new UpdateInstallError('url-rejected', 'no download URL available');
    return await installer.startDownload(url);
  });

  ipcMain.handle('update:cancel', async (_event, payload: { jobId: string }) => {
    installer.cancelDownload(payload.jobId);
    return { success: true };
  });

  ipcMain.handle('update:launch', async (_event, payload: { jobId: string; filePath: string }) => {
    if (devFakeUpdate) {
      // Never actually launch anything in dev — just surface the cached file in
      // the OS file manager so Destin can confirm it exists.
      shell.showItemInFolder(payload.filePath);
      // Return the fallback: 'browser' shape so the renderer flips out of launching
      // state and calls onClose() — do NOT schedule app.quit() (that would kill the dev session).
      return { success: true, quitPending: false, fallback: 'browser' as const };
    }
    const result = await launchInstaller({ jobId: payload.jobId, filePath: payload.filePath });
    if (result.success && result.quitPending) {
      // 500ms grace so the child installer process has detached cleanly before we exit.
      setTimeout(() => app.quit(), 500);
    }
    return result;
  });

  ipcMain.handle('update:get-cached-download', async (_event, payload: { version: string }) => {
    return findCachedDownload(updateCacheDir, payload.version, process.platform);
  });

  // Initial fetch on startup
  fetchLatestRelease().catch(() => {});
  const modelPrefPath = path.join(os.homedir(), '.claude', 'youcoded-model.json');
  const appearancePrefPath = path.join(os.homedir(), '.claude', 'youcoded-appearance.json');
  const defaultsPrefPath = path.join(os.homedir(), '.claude', 'youcoded-defaults.json');

  function readJsonFile(filePath: string): any {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  // .sync-status is no longer read here: the value was threaded all the way to
  // StatusBar and then dropped, so this was a disk read every 10s feeding nothing.
  // The file itself still exists and is read by statusline.sh and /diagnose.
  // Legacy .sync-warnings text file is no longer read; typed warnings come from .sync-warnings.json.
  const syncWarningsJsonPath = path.join(os.homedir(), '.claude', '.sync-warnings.json');

  function readTextFile(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf8').trim() || null;
    } catch {
      return null;
    }
  }

  /** Read typed sync warnings synchronously — returns [] if missing or unparseable. */
  function readSyncWarningsSync(): SyncWarning[] {
    try {
      const text = fs.readFileSync(syncWarningsJsonPath, 'utf8');
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  // Fix: per-session status bar chips were disappearing for a few seconds after
  // switching back to an idle session. Root cause: statusline.sh writes the
  // three session files (.context-, .session-stats-, .gitbranch-) with
  // truncate-then-write (fs.writeFileSync / shell `>`). If a 10s status poll
  // lands inside that truncate window, readTextFile returns null and the entry
  // is omitted from the rebuilt map, which the renderer then replaces wholesale
  // — wiping the chips until the next successful poll. These caches preserve
  // the last-known good value so a transient read miss doesn't blank the UI.
  // Entries are purged on session-exit below.
  const lastContextByDesktopId: Record<string, number> = {};
  const lastGitBranchByDesktopId: Record<string, string> = {};
  const lastSessionStatsByDesktopId: Record<string, any> = {};

  // Per-session attention state, updated by the renderer via
  // `remote:attention-changed` and read by buildStatusData() so remote
  // browsers see matching StatusDot colors. Declared alongside the other
  // last-known caches (above) so buildStatusData's lexical scope has all
  // four in the TDZ-safe range. The listener that writes into this Map
  // is registered further down where the handler block begins.
  const lastAttentionBySession = new Map<string, string>();

  // (Native StatusBar chips are sourced from the reducer's turn-complete usage
  // via the renderer's `nativeStatusUsage` memo → selectNativeStatusChips, which
  // serves desktop AND remote. The old native:usage-report → status:data cache
  // was dead — nothing read it — and was removed in the whole-branch review.)

  function buildStatusData() {
    const usage = readJsonFile(usageCachePath);
    const announcement = readJsonFile(announcementCachePath);
    const updateStatus = getUpdateStatus();
    const syncWarnings = readSyncWarningsSync();

    // Sync state for live updates — SyncPanel also fetches via IPC,
    // but these fields let the compact section row update in real-time.
    // Self recency comes from sync-spaces evidence FIRST (the persisted
    // lastSync map); the legacy .sync-marker survives as a fallback/max for
    // Drive/iCloud-only installs. WHY: the marker is absent on GitHub-era
    // installs, so reading only it showed "last seen 22 hours ago" on a
    // machine that was (supposedly) syncing every 90 seconds (2026-07-30 spec §4).
    const syncMarkerRaw = readTextFile(path.join(os.homedir(), '.claude', 'toolkit-state', '.sync-marker'));
    const lastSyncEpoch = deriveSelfLastSyncEpochSec(getSelfLastSyncEpochMs(), syncMarkerRaw);
    // Live spaces syncing OR the legacy lock dir (extra-backups pushes).
    let syncInProgress = isSyncSpacesSyncing();
    try { syncInProgress = syncInProgress || fs.statSync(path.join(os.homedir(), '.claude', 'toolkit-state', '.sync-lock')).isDirectory(); } catch {}
    const backupMeta = readJsonFile(path.join(os.homedir(), '.claude', 'backup-meta.json'));
    // Per-device sync recency (machineId → epoch-ms), carried over the SyncHub.
    // Rides the live push so the "Your devices" rows update in real-time without
    // waiting for a full getSyncStatus() refetch. Forwarded verbatim to remote
    // browsers via broadcastStatusData (no reshape). Empty when the hub is down.
    const lastSyncByDevice = getLastSyncByDevice();

    // Read per-session context remaining % (written by statusline.sh)
    const contextMap: Record<string, number> = {};
    for (const [desktopId, claudeId] of sessionIdMap) {
      const raw = readTextFile(path.join(os.homedir(), '.claude', `.context-${claudeId}`));
      if (raw != null) {
        const num = parseInt(raw, 10);
        if (!isNaN(num)) {
          contextMap[desktopId] = num;
          lastContextByDesktopId[desktopId] = num;
        }
      } else if (desktopId in lastContextByDesktopId) {
        contextMap[desktopId] = lastContextByDesktopId[desktopId];
      }
    }

    // Read per-session git branch (written by statusline.sh, same pattern as context %)
    const gitBranchMap: Record<string, string> = {};
    for (const [desktopId, claudeId] of sessionIdMap) {
      const raw = readTextFile(path.join(os.homedir(), '.claude', `.gitbranch-${claudeId}`));
      if (raw) {
        gitBranchMap[desktopId] = raw;
        lastGitBranchByDesktopId[desktopId] = raw;
      } else if (desktopId in lastGitBranchByDesktopId) {
        gitBranchMap[desktopId] = lastGitBranchByDesktopId[desktopId];
      }
    }

    // Read per-session stats (cost, tokens, code changes — written by statusline.sh)
    const sessionStatsMap: Record<string, any> = {};
    for (const [desktopId, claudeId] of sessionIdMap) {
      const stats = readJsonFile(path.join(os.homedir(), '.claude', `.session-stats-${claudeId}.json`));
      if (stats) {
        sessionStatsMap[desktopId] = stats;
        lastSessionStatsByDesktopId[desktopId] = stats;
      } else if (desktopId in lastSessionStatsByDesktopId) {
        sessionStatsMap[desktopId] = lastSessionStatsByDesktopId[desktopId];
      }
    }

    // Per-session attention state populated by the `remote:attention-changed`
    // IPC listener. Remote browsers diff this on receipt to update StatusDot
    // colors for sessions that have diffed since the last broadcast.
    const attentionMap: Record<string, string> = {};
    for (const [desktopId] of sessionIdMap) {
      const state = lastAttentionBySession.get(desktopId);
      if (state) attentionMap[desktopId] = state;
    }

    // (The background bulk-conversations pull + its restore-progress chip were
    // removed in sync-legacy-demolition — the pull path no longer exists.)

    // Sign in with ChatGPT (§4.4): the plan's usage windows ride the same 10 s
    // push the Claude usage does, so the status-bar chips and /usage draw either
    // plan with one recipe — on desktop AND on remote browsers (this payload is
    // forwarded verbatim by broadcastStatusData). Pruned by usageForStatus();
    // null when signed out, never polled, or under the kill switch.
    const chatgptUsage = chatgptForUi?.usageForStatus() ?? null;

    return { usage, announcement, updateStatus, syncWarnings, lastSyncEpoch, syncInProgress, lastSyncByDevice, backupMeta, contextMap, gitBranchMap, sessionStatsMap, attentionMap, chatgptUsage };
  }

  // Push status data every 10s — store handle so it can be cleared on shutdown
  const statusInterval = setInterval(() => {
    const data = buildStatusData();
    send(IPC.STATUS_DATA, data);
    // Feed full status data to remote server for browser clients (single polling source)
    if (remoteServer) remoteServer.broadcastStatusData(data);
  }, 10000);

  // Also push immediately on first hook event (session is active)
  let sentInitialStatus = false;
  if (hookRelay) {
    hookRelay.on('hook-event', () => {
      if (!sentInitialStatus) {
        sentInitialStatus = true;
        const data = buildStatusData();
        send(IPC.STATUS_DATA, data);
        if (remoteServer) remoteServer.broadcastStatusData(data);
      }
    });
  }

  // (There is deliberately no usage-cache refresher here any more. It used to
  // run hook-scripts/usage-fetch.js every 5 minutes, which read the user's
  // Claude.ai OAuth token from ~/.claude/.credentials.json and called
  // Anthropic's usage API — Anthropic's Claude Code terms forbid third-party
  // apps from using that token. ~/.claude/.usage-cache.json is now written by
  // hook-scripts/statusline.sh from the rate_limits object Claude Code itself
  // passes to the status line, so buildStatusData() above keeps reading the
  // same file and the chips only update while a Claude Code session is live.)

  // --- Topic file watcher (auto-title) ---
  // The auto-title hook writes topics to ~/.claude/topics/topic-{CLAUDE_CODE_SESSION_ID}.
  // But our desktop session IDs differ from Claude Code's internal IDs.
  // We discover the mapping from hook events (which contain both IDs)
  // and watch the correct file.
  const topicDir = path.join(os.homedir(), '.claude', 'topics');
  // Maps desktop session ID → Claude Code session ID
  const sessionIdMap = new Map<string, string>();
  // Where each session's transcript lives, for the paged-history handler to
  // fall back on whenever the transcript watcher cannot say — see
  // transcript-page-source.ts for the three ordinary moments when it cannot.
  const pageSources = new TranscriptPageSources();

  // Holder-side takeover (Plan 2b Task 8): when another device requests this
  // session, cleanly interrupt, flush the final turn to the space, release the
  // lease, tell the UI it moved, and end the local session. Wired here because
  // the reverse-map (claude id → desktop id) needs sessionIdMap; sendForSession is
  // in scope for the dual-path renderer + remote push.
  if (leaseWiring) {
    const pushMoved = (desktopId: string, device?: string) => {
      // Enrich the push so the renderer's MovedGate can offer "Resume on this
      // device" without a second lookup. At push time (step 7) the holder session
      // still exists — destroy is step 8 — so both the claude id and the live
      // session's cwd are available. projectSlug mirrors how the Resume Browser
      // derives it (ccProjectSlug of the cwd) so handleResumeSession's history
      // load + resumeInfo land on the right CC project dir.
      const claudeSessionId = sessionIdMap.get(desktopId);
      const info = sessionManager.getSession(desktopId);
      const projectPath = info?.cwd;
      const projectSlug = projectPath ? ccProjectSlug(projectPath) : undefined;
      // Carry the provider so the renderer's MovedGate resume takes the NATIVE path
      // (the pre-resume model picker, never an auto-launch) for a native session —
      // without it, a moved native conversation would resume as CC and find no JSONL.
      const provider = info?.provider;
      const payload = { sessionId: desktopId, device, claudeSessionId, projectSlug, projectPath, provider };
      // Broadcast to ALL main windows, not sendForSession: at push time the holder
      // session still exists but may have no registered owner (e.g. it's shown in a
      // secondary window), and sendForSession's ownerless fallback hits only the
      // PRIMARY window — the Moved pill would never render and the conversation would
      // look like it vanished. recordMoved is keyed by sessionId and no-ops in windows
      // not showing this session, so the fan-out is safe.
      sendToAllMainWindows(IPC.SESSION_MOVED, payload);               // every main renderer window
      remoteServer?.broadcast({ type: IPC.SESSION_MOVED, payload }); // remote clients
    };
    const holderTakeover = createHolderTakeover({
      sessionManager, sessionIdMap, leaseClient: leaseWiring.client,
      flushSessionToSpace, pushMoved,
      // Provider of a live desktop id — drives the holder's step-3 branch (native
      // sessions quiesce their HarnessSession; CC sessions get the ESC byte).
      getProvider: (id) => sessionManager.getSession(id)?.provider,
      // Native takeover quiesce (Task 9): clears the queue, aborts the in-flight
      // turn, and awaits it settling so no append lands past the flush. A native
      // session has no PTY, so the ESC byte can't interrupt it.
      quiesceNative: (id) => nativeHost.quiesce(id),
      // Idempotent + no-op for non-native ids, so the holder flow calls it
      // unconditionally without needing to know the provider.
      destroyNative: (id) => nativeHost.destroy(id),
    });
    // Fire-and-forget from a hub event — the handler never throws (each step is
    // try/caught inside createHolderTakeover), so void is safe.
    leaseWiring.setHolderTakeover((sid, from) => { void holderTakeover(sid, from); });
  }

  // `lastAttentionBySession` is declared alongside the other status-value
  // caches above buildStatusData(); the listener that writes into it is
  // registered here where the handler block begins.
  ipcMain.on('remote:attention-changed', (_e, payload: { sessionId: string; state: string }) => {
    if (!payload?.sessionId) return;
    lastAttentionBySession.set(payload.sessionId, payload.state);
    // Broadcast immediately so remote clients see the change without waiting
    // for the 10s status:data timer. Payload rebuild is cheap.
    if (remoteServer) {
      const data = buildStatusData();
      remoteServer.broadcastStatusData(data);
    }
  });

  const transcriptWatcher = new TranscriptWatcher();

  // Last model id written to the store per CLAUDE session id, so a repeat is
  // never re-written. Unbounded in principle but bounded in practice by
  // sessions opened this run, and one short string each.
  const lastModelSeen = new Map<string, string>();

  transcriptWatcher.on('transcript-event', (event: any) => {
    sendForSession(event.sessionId, IPC.TRANSCRIPT_EVENT, event);
    if (remoteServer) {
      remoteServer.broadcast({ type: 'transcript:event', payload: event });
    }
    // Conversation Store (Phase 2a): feed live activity into the record store.
    // event.sessionId is the DESKTOP id; the store keys by CLAUDE id, so resolve
    // via sessionIdMap and skip if we haven't seen the mapping yet (a hook event
    // establishes it — the reconciler backfills anything missed before then).
    const claudeId = sessionIdMap.get(event.sessionId);
    // This listener is on the CC TranscriptWatcher only — native transcript
    // events are routed separately (Task 4 wires the native listener's feed).
    if (claudeId) noteTranscriptEvent(claudeId, event, 'claude');
    // Record which model a CC turn ran on, mirroring what resolvePortableModel
    // does for native sessions. The transcript watcher already parses
    // `message.model` off every assistant message and forwards it on
    // assistant-text (transcript-watcher.ts) — this just persists it.
    //
    // WHY BOTH THIS AND the browse-time transcript read (session-browser.ts
    // readSessionTranscriptMeta): the read covers all EXISTING history without
    // waiting for a turn, but only where the transcript is on this device. A
    // conversation synced in from another machine has a store record and no
    // local JSONL, so the read finds nothing. Writing the ref into the store
    // here is what makes the model travel with the record.
    //
    // providerType is 'claude-code' — deliberately not a native provider type,
    // so the resume prefill can never match it against the local model catalog.
    if (claudeId && event.type === 'assistant-text') {
      const model = (event.data as { model?: unknown } | undefined)?.model;
      // Deduped: assistant-text fires per TEXT BLOCK, several times a turn, and
      // noteModelUsed does a store read + write each call. The model only
      // changes on an explicit /model switch, so writing on every block would
      // mean hundreds of redundant record writes per conversation — each one a
      // sync-visible change. Only a DIFFERENT model reaches the store.
      // Fix: never record CC's `<synthetic>` placeholder. It is stamped on
      // assistant lines CC composed itself (session limit / out of credits /
      // /login), so it is not a model — and this record OVERRIDES the Resume
      // Browser's transcript scan (session-browser.ts, store overlay), so a
      // single limit notice would print `<synthetic>` as the card's model and
      // sync that to every other device. Read side is guarded too
      // (store-core.ts sanitizeModelRef) to heal records written before this.
      if (typeof model === 'string' && model && !isPlaceholderModelId(model)
          && lastModelSeen.get(claudeId) !== model) {
        lastModelSeen.set(claudeId, model);
        noteModelUsed(claudeId, { modelId: model, providerType: 'claude-code', providerLabel: 'Claude Code' });
      }
    }
  });

  // --- Native runtime stack (Phase 1 Plan A, Task 9) ---
  // NativeHome is the single writer for ~/.youcoded/; SecretsStore keeps API
  // keys in Electron's safeStorage-encrypted userData (NOT in the syncable home
  // dir). ProviderRegistry.init() seeds the built-in providers under the file
  // lock (fire-and-forget — list/languageModel read on demand). The catalog's
  // contextLengthFor feeds HarnessSession's context-window sizing.
  const nativeHome = new NativeHome();
  // Hoisted out of the NativeSessionHost constructor call below (M5 2a): the
  // permissions:list handler and the remote-server WS case both need to READ the
  // same store the host writes through. Constructing a second one would still
  // work (they share one file under NativeHome's lock) but would make the
  // "one store" invariant a coincidence rather than a fact.
  const permissionStore = new PermissionStore(nativeHome);
  const stepGuardSettings = new StepGuardSettings(nativeHome);
  const secretsStore = new SecretsStore(app.getPath('userData'));
  // Plan B: the local engine. EngineManager owns acquisition + supervision; its
  // hook makes the 'local' provider real and its listModels feeds the model
  // picker. ENGINE_PORT rides the shifted-port scheme so the dev instance and
  // the built app never fight over one llama-server.
  const engineManager = new EngineManager(nativeHome, app.getPath('userData'), ENGINE_PORT);
  // Bring an already-installed engine up to the pinned version, in the background.
  // Fire-and-forget by design — it never throws, never blocks startup, and skips
  // itself entirely when nothing is installed yet (a first install stays the user's
  // call). Without this a pin bump reaches nobody: EngineAcquisition.installed()
  // keeps serving whatever version is on disk, so a model needing a newer llama.cpp
  // just looks like a broken app.
  void engineManager.autoUpdateOnLaunch();
  // Sign in with ChatGPT — the kill switch (§6). `chatgptForUi` is what the
  // registry, the catalog, the four handlers and the remote WS cases see: null
  // under YOUCODED_CHATGPT=0 so the plan's row and models vanish and every
  // surface answers signed-out, while `chatgptAuth` itself (main.ts's file
  // reader) is untouched. Stored tokens are left alone — the flag is a fast
  // revert, not a sign-out.
  const chatgptForUi: ChatGptAuth | null = process.env.YOUCODED_CHATGPT !== '0' ? (chatgptAuth ?? null) : null;
  const providerRegistry = new ProviderRegistry(nativeHome, secretsStore, engineManager.registryHook(), chatgptForUi);
  void providerRegistry.init();
  const modelCatalog = new ModelCatalog(app.getPath('userData'), undefined, {
    localModels: () => engineManager.catalogModels(),
    // The plan's models come from ChatGptAuth's manifest cache (§4.2); absent
    // under the kill switch so the catalog contributes nothing for 'chatgpt'.
    ...(chatgptForUi ? { chatgptModels: () => chatgptForUi.models() } : {}),
  });
  // WebSearch stack (Phase 2 Plan B): keys live in SecretsStore, the ref map in
  // ~/.youcoded/search-providers.json (via NativeHome). SearchChain caches the
  // patchable backend chain under userData — the SAME cache-dir convention as
  // ModelCatalog/CuratedCatalog (both take app.getPath('userData')). The
  // SearchService is injected into the native tool framework as `toolServices`
  // so the WebSearch tool can reach it (see NativeSessionHost.toolWiring).
  const searchKeyStore = new SearchKeyStore(nativeHome, secretsStore);
  const searchService = new SearchService(
    new SearchChain(app.getPath('userData')),
    searchKeyStore,
    { exa: exaBackend, ddg: ddgBackend, tavily: tavilyBackend },
  );
  // Task 7b: this is the ONLY production construction site for both classes —
  // without it every piece of the native-MCP stack (registry, client, pooled
  // manager, tool adapter) is unreachable dead code (see task-7b-brief.md).
  // Registry rides the SAME nativeHome/secretsStore instances as everything
  // else above (never a duplicate) — same precedent as SearchKeyStore just
  // above. connectionFactory is mcp-client's real createConnection, unwrapped
  // (no fake, no override) — every server it pools is a real subprocess/HTTP
  // client once acquired.
  //
  // Construction itself is side-effect-free: McpRegistry.list()/
  // resolveAllEnabled() only READ ~/.youcoded/mcp.json (NativeHome.readJson
  // never creates the directory — see native-home.ts's lazy-creation
  // invariant), and McpManager's constructor does no I/O at all. Nothing here
  // connects to a server or spawns a subprocess: that only happens inside
  // acquire(), called per-session by NativeSessionHost (Task 6's wiring)
  // below. A user with no ~/.youcoded/mcp.json configured gets zero
  // directory creation, zero subprocesses, and zero log output from this
  // line — the normal case for almost every install.
  const mcpRegistry = new McpRegistry(nativeHome, secretsStore);
  const mcpManager = new McpManager({ registry: mcpRegistry, connectionFactory: createConnection });
  // Task 4 (plan 1c) — the real per-cwd specialist catalog: reads personal
  // (~/.youcoded/specialists/), Claude-Code user-level (~/.claude/agents/),
  // and each project's own .claude/agents/, merged with the four built-ins.
  // ONE instance for the app's whole life, shared by every project folder —
  // its in-memory per-source state is what makes re-reading only a CHANGED
  // folder work across turns and across conversations sharing one project.
  const specialistCatalog = new SpecialistCatalog({ home: nativeHome });
  const nativeHost = new NativeSessionHost(
    new SessionStore(nativeHome),
    // Pass the per-turn opts (e.g. serialToolCalls for small local models) straight through.
    (binding, opts) => providerRegistry.languageModel(binding, opts),
    // Context-window sizing AND the engine's real parallel-slot count, from
    // ONE closure. Fix pass 2 (Task 13): the first fix threaded contextLength
    // and totalSlots through two SEPARATE closures that shared one /props
    // reading via a module-scoped `lastLocalSlotReading` variable — correct
    // only if native-session-host.ts always awaited them back-to-back for the
    // same binding with nothing else able to run in between. It doesn't hold:
    // two local-engine sessions starting concurrently, or a cloud binding's
    // resolution landing between the two awaits (which reset the shared
    // variable to null), could read another binding's slot count or a wrong
    // null — silently, with no throw. Returning both values from this single
    // call removes the shared state entirely, so there is no ordering left to
    // break. For LOCAL models this still costs exactly ONE /props round trip
    // (effectiveContextWindow reads context AND slots from the same response);
    // remote/API models keep the catalog's context number and report
    // totalSlots: null (hosted concurrency is a flat constant, not
    // engine-measured — see capability-profile.ts's CLOUD_DEFAULT).
    async (binding) => {
      const providers = await providerRegistry.list();
      const p = providers.find((x) => x.id === binding.providerId);
      if (p?.type === 'local-engine') return engineManager.effectiveContextWindow(binding.modelId);
      return { contextLength: await modelCatalog.contextLengthFor(binding, providers), totalSlots: null };
    },
    // Provider TYPE resolver (Task 5): the host picks a CapabilityProfile from
    // this. Unknown provider → null, so the host falls back to a cloud-safe
    // default. ProviderType and ProfileProviderType are the same union today.
    async (binding) => {
      const p = (await providerRegistry.list()).find((x) => x.id === binding.providerId);
      return (p?.type as ProfileProviderType) ?? null;
    },
    // Vision-support resolver (Task 6c; local models added by T18, design §E5).
    // TWO provider types can answer "does THIS model accept images" from real
    // per-model data rather than a hand-maintained guess, and both answer it
    // through the SAME catalog field — so there is ONE lookup here, not two
    // mechanisms:
    //   - OpenRouter, from `architecture.input_modalities` on its /models rows
    //     (parsed in model-catalog.ts's openrouterModels());
    //   - the LOCAL engine, from the identically-named field on llama-server's
    //     own `GET /models` (kept by EngineSupervisor.listModels, turned into
    //     CatalogModel.supportsVision by EngineManager.catalogModels) — which
    //     is `["text","image"]` exactly when the router paired an mmproj
    //     projector beside the model.
    // Every OTHER provider type has no such signal, so this still returns null
    // for them and lets resolveProfile fall back to the registry/provider-type
    // default. That short-circuit mirrors the context/slots closure above (same
    // `providers`/`p` lookup, just gated on provider type) and is what keeps
    // this closure off a session start it does not apply to: a direct-key or
    // openai-compatible binding never touches modelCatalog at all.
    // A local binding DOES now pay a catalog read, and this closure is the
    // FIRST AND ONLY modelCatalog.get() on a local session start — the
    // context/slots closure above asks the ENGINE, and the price closure below
    // short-circuits local before the catalog. What keeps that read cheap is
    // ModelCatalog.get()'s own network gate — it skips its two upstream fetches
    // when no provider in the list can consume them — plus the fact that we
    // hand it ONLY the binding's own provider (see below). Together those make
    // a purely local, OFFLINE session start cost nothing. Without that gate this cost 4 fetches and
    // 15.1 s on every create/resume/swap, with no memoization (measured
    // 2026-09-05) — see the WHY at model-catalog.ts's get(). What is left is
    // the engine's own listModels: a localhost GET while the engine runs (it
    // does by now — the context closure above booted it), a disk scan
    // otherwise.
    // modelCatalog.get() never throws (its own contract — a dead network
    // degrades to stale cache or an empty list, and an unavailable engine
    // degrades to no local rows), so there is nothing to catch here; a cache
    // miss, an unknown model, or a router that reported no modalities all fall
    // through the `?.supportsVision` chain to null, which means "don't know".
    // Be aware where that honesty ends: capability-profile's visionFor() turns
    // an undiscovered answer into a hard `false` at the profile layer, because
    // there is no third state for the harness to act on. That is the safe
    // direction — a wrong false means the model is told the picture cannot be
    // delivered, a wrong true fails the whole turn with a provider error.
    async (binding) => {
      const providers = await providerRegistry.list();
      const p = providers.find((x) => x.id === binding.providerId);
      if (p?.type !== 'openrouter' && p?.type !== 'local-engine') return null;
      // `[p]`, not the whole list: the lookup below only ever inspects rows of
      // the BINDING'S OWN provider, so every other provider's rows are built
      // and discarded. Narrowing is what makes the network gate in
      // ModelCatalog.get() actually reach the offline local user — 'openrouter'
      // ships ENABLED by default (provider-registry's BUILT_INS), so handing
      // over the full list would drag its fetch in on every local session start
      // even for someone who has never touched it. Same rows out, since get()
      // is scoped to the providers it is handed.
      const models = await modelCatalog.get([p]);
      const hit = models.find((m) => m.providerId === binding.providerId && m.id === binding.modelId);
      return hit?.supportsVision ?? null;
    },
    // Price resolver (Task 11, spec §5): reads the SAME catalog the model
    // picker shows, so the price the user sees when choosing a model is the
    // price the session-cost chip charges. Short-circuits local-engine before
    // touching the catalog — a model running on this machine costs nothing to
    // run and its rows carry no price anyway; the host stamps those turns
    // `free` instead. modelCatalog.get() never throws (its own contract: a
    // dead network degrades to stale cache or an empty list), and a model
    // that isn't in the catalog falls through to null, which means "no
    // published price" — never a guessed zero.
    async (binding) => {
      const providers = await providerRegistry.list();
      const p = providers.find((x) => x.id === binding.providerId);
      if (p?.type === 'local-engine') return null;
      const models = await modelCatalog.get(providers);
      const hit = models.find((m) => m.providerId === binding.providerId && m.id === binding.modelId);
      return hit?.pricing ?? null;
    },
    // Remembered "Always allow" rules (per-project, ~/.youcoded/permissions.json)
    // + the injected app version for the once-per-session assembled system prompt
    // (electron `app` isn't importable in the host's own test env — inject here).
    permissionStore,
    app.getVersion(),
    // Runtime services threaded into every native tool's ToolContext — WebSearch
    // reads services.search (the chain-walking SearchService).
    {
      search: searchService,
      // Task 14 fix pass: same shape as the context/slots (~2295) and
      // vision-support (~2324) closures above — providers first, then the
      // catalog rows for those providers. NativeSessionHost.toolWiring()
      // recombines this with its own host-internal DelegatedModels store into
      // services.models, so ModelSearch and a per-hire specific-model-id
      // override can actually confirm a real id instead of always seeing
      // "catalog not loaded" (the null default this closure replaces).
      modelCatalog: async () => modelCatalog.get(await providerRegistry.list()),
    },
    // skillCatalog (9th param, shifted from 10th by fix pass 2 collapsing the
    // context and slot-count closures back into one): NOT wired yet — a
    // different task's scope (see task-7b-brief.md "Explicitly NOT in
    // scope"). Passed explicitly so mcpManager lands in the 10th positional
    // slot instead of silently taking skillCatalog's place.
    undefined,
    // mcpManager (10th param, Task 7b — shifted from 11th by the same
    // collapse): makes the whole native-MCP stack reachable — see the
    // construction comment above.
    mcpManager,
    // nativeHome (11th param, plan 1b Task 2): backs the DelegationLedger the
    // host constructs internally (see delegation-ledger.ts) — the SAME
    // nativeHome instance every other ~/.youcoded/ writer above shares, never
    // a second one.
    nativeHome,
    // specialistAskHoldMs (12th param) left at its real production default —
    // explicit undefined only to reach the 13th positional slot below.
    undefined,
    // specialistCatalog (13th param, Task 4 plan 1c): the real catalog built
    // above, sharing nativeHome with every other ~/.youcoded/ writer here.
    specialistCatalog,
    () => stepGuardSettings.read(),
  );

  // Task 4: resolves sessionId's CURRENT model binding into the portable ref
  // noteModelUsed persists — thin async wrapper around bindingToPortableModel
  // (portable-model.ts) closed over the live nativeHost/providerRegistry.
  // Returns null (write nothing) when the session has no live binding or its
  // provider has vanished from the registry — never guess.
  const resolvePortableModel = async (sessionId: string): Promise<PortableModelRef | null> =>
    bindingToPortableModel(nativeHost.getBinding(sessionId), await providerRegistry.list());

  // One registry read for a whole listing (§4.9, review T6 F1). Returns copies:
  // SessionInfo objects are owned by SessionManager and must not be mutated here.
  const stampProviderTypes = async (rows: SessionInfo[]): Promise<SessionInfo[]> => {
    if (!rows.some((s) => s.provider === 'native')) return rows;
    const providers = await providerRegistry.list();
    return rows.map((s) => {
      if (s.provider !== 'native') return s;
      const ref = bindingToPortableModel(nativeHost.getBinding(s.id), providers);
      return ref ? { ...s, providerType: ref.providerType } : s;
    });
  };

  // Task 7: native auto-title feeder. CC sessions get titled by the topic
  // watcher below (~/.claude/topics, fed by the Auto-Title hook); native
  // sessions have no such feed, so this generates one from the bound model
  // at first turn-complete. See native-title-feeder.ts's header for the full
  // rationale (JSONL-never, ordering, M6 floor-gating hook).
  const nativeTitleFeeder = createNativeTitleFeeder({
    // Bounded with a 15s abort — a bare unbounded generateText await would
    // hang the feeder (same hazard class as the compaction-hang rule).
    // providerRegistry.languageModel() itself throws for an unconfigured/
    // disabled/removed provider; that rejection propagates to the feeder's
    // own try/catch around `generate`, which is exactly the "unresolvable =
    // skip silently, never an error event" contract — no separate handling
    // needed here.
    generate: async (binding: ModelBinding, prompt: string) => {
      const model = await providerRegistry.languageModel(binding);
      const { text } = await generateText({ model, prompt, abortSignal: AbortSignal.timeout(15_000) });
      return text;
    },
    getBinding: (sessionId: string) => nativeHost.getBinding(sessionId),
    // Store title wins; falls back to the live session name for the boot
    // window before the store's first upsert lands (mirrors the browse/store
    // title-overlay precedence Task 3/5 established — store wins unless
    // placeholder).
    //
    // Fix (2026-08-06): both halves now go through the SHARED placeholder
    // predicate. The old fallback only excluded 'New Session', so a RESUMED
    // session — whose live name is 'Resuming…' — answered "already titled" and
    // this feeder skipped generation on every turn-complete, permanently. A
    // resumed, never-titled native session could never get a title at all.
    hasTitle: async (sessionId: string) => {
      const rec = await getConversationStore()?.get('native', sessionId);
      return hasRealTitle(rec?.title, sessionManager.getSession(sessionId)?.name);
    },
    // Both halves, or the Resume Browser (store title) and the live pill
    // (session.name) disagree. Native ids are identity-mapped (see the WHY
    // comment on noteTranscriptEvent's native call just below), so
    // sessionId doubles as both the desktop id and the store's record id.
    onTitle: async (sessionId: string, title: string) => {
      sendForSession(sessionId, IPC.SESSION_RENAMED, sessionId, title);
      broadcastRename(sessionId, title);
      await noteTitleChanged(sessionId, title, 'native');
    },
  });

  // Native transcript events ride the SAME channel as CC's — the reducer
  // consumes an identical event shape regardless of runtime.
  nativeHost.on('transcript-event', (event: TranscriptEvent) => {
    sendForSession(event.sessionId, IPC.TRANSCRIPT_EVENT, event);
    if (remoteServer) {
      remoteServer.broadcast({ type: 'transcript:event', payload: event });
    }
    // WHY: this is the single line that makes native conversations exist in
    // the store (design §5); Task 3 made it correct rather than mislabeling.
    // Native ids are identity-mapped (sessionIdMap.set(info.id, info.id) in
    // the SESSION_CREATE native branch above), so — unlike the CC listener
    // below, which resolves through sessionIdMap — event.sessionId IS already
    // the store's record id; no lookup needed.
    noteTranscriptEvent(event.sessionId, event, 'native');
    // Task 7: feed the SAME event stream into the title feeder. Pure/injected
    // logic — see native-title-feeder.ts — never throws synchronously.
    nativeTitleFeeder.noteEvent(event);
    if (event.type === 'turn-complete') {
      // The model may have changed mid-session (NATIVE_SET_BINDING) — refresh
      // the portable ref on every turn rather than trusting a stale snapshot
      // from session-create. Fire-and-forget: a miss here just means this
      // turn's upsert (already sent by noteTranscriptEvent above) is missing
      // lastUsedModel until the NEXT turn resolves it.
      void resolvePortableModel(event.sessionId)
        .then((ref) => { if (ref) noteModelUsed(event.sessionId, ref); })
        .catch(() => { /* best-effort — never block the transcript-event listener */ });
    }
  });

  // Native permission asks ride the SAME hook:event channel + broadcast as CC's
  // PermissionRequest/PermissionExpired — hook-dispatcher/ToolCard render them
  // unchanged. Ids are 'native-'-prefixed so permission:respond routes by id.
  nativeHost.on('hook-event', (event: HookEvent) => {
    sendForSession(event.sessionId, IPC.HOOK_EVENT, event);
    if (remoteServer) {
      // Fix (not in the original plan — see the branch's commit history):
      // native hook events reach remote clients ONLY through this direct
      // broadcast() call. RemoteServer's own onHookEvent — which is what
      // fills hookBuffers for connect-time replay — is wired solely to the
      // LEGACY CC hookRelay, never to nativeHost. So a phone reconnecting
      // while a native permission ask was HELD got nothing back: PermissionHeld
      // is one-shot and the 3s heartbeat stops re-announcing once an ask is
      // held (permission-broker.ts). bufferHookEvent() feeds the SAME
      // hookBuffers map the legacy path fills, so the existing replay loop in
      // replayBuffers() picks these up for free, in the same push order
      // (request, then held).
      remoteServer.bufferHookEvent(event);
      remoteServer.broadcast({ type: 'hook:event', payload: event });
    }
  });

  // Task 8 (plan 1c) — the ledger's own write is the ONLY thing that fires
  // this (see the 'specialists-event' emit in NativeSessionHost's
  // constructor, next to DelegationLedger's construction): one mutate, one
  // event, one changed hire. Push-only — there is no specialists:event
  // REQUEST handler anywhere, same shape as native:model-state.
  nativeHost.on('specialists-event', (event: SpecialistsEvent) => {
    sendForSession(event.sessionId, IPC.SPECIALISTS_EVENT, event);
    if (remoteServer) {
      // Task 9 (plan 1c): the phone hydrates over this WebSocket, never
      // through TRANSCRIPT_REPLAY, so it needs its own connect-time catch-up
      // for a helper's run status — bufferSpecialistRun feeds the buffer
      // replayBuffers() reads from on connect (mirrors bufferHookEvent above).
      remoteServer.bufferSpecialistRun(event);
      remoteServer.broadcast({ type: 'specialists:event', payload: event });
    }
  });

  // G-1: one background command's run record changed. Same four-surface push
  // shape as specialists:event — window + remote broadcast, buffered for a
  // reconnecting phone. Push-only; there is no request handler.
  nativeHost.on('shell-event', (event: ShellEvent) => {
    sendForSession(event.sessionId, IPC.NATIVE_SHELL_EVENT, event);
    if (remoteServer) {
      remoteServer.bufferShellRun(event);
      remoteServer.broadcast({ type: 'native:shell-event', payload: event });
    }
  });

  // Plan C: model manager (curated catalog, HF search, downloads, detectors).
  // Constructed here — BEFORE setNativeRuntime — so remote WS clients reach the
  // SAME instance via the native-runtime injection below (the models:* handlers
  // themselves are registered further down, next to the engine block).
  const modelManager = new ModelManager(nativeHome, engineManager, app.getPath('userData'));

  // Give the remote server access to the native stack so its WS clients reach
  // the SAME instances (mirrors how setLastTopic / broadcastStatusData push
  // ipc-handler-owned state into remoteServer — no global needed).
  // permissionStore rides along for the remote permissions:list case (M5 2a) —
  // the WS revokes go through nativeHost, which is already here.
  // specialistCatalog (Task 8): the remote specialists:list WS case needs the
  // SAME catalog instance the desktop handler below reads — a second instance
  // would fingerprint-cache independently and could answer a re-read with
  // stale data relative to whichever surface wrote last.
  // chatgptAuth (Sign in with ChatGPT §5): the remote chatgpt:* WS cases read
  // the SAME account object, already kill-switched (null → signed-out/false).
  remoteServer?.setNativeRuntime({ nativeHost, providerRegistry, modelCatalog, engineManager, modelManager, searchKeyStore, searchService, permissionStore, stepGuardSettings, specialistCatalog, chatgptAuth: chatgptForUi });

  // Plan 2b Task 11: give the remote server the SAME lease client/requester +
  // deviceId so its WS clients reach the identical lease/device state the
  // Electron IPC handlers use (mirrors setNativeRuntime). Absent when sync is off.
  if (leaseWiring && remoteServer) {
    remoteServer.setLeaseWiring({ client: leaseWiring.client, requester: leaseWiring.requester, deviceId: leaseWiring.deviceId, machineId: leaseWiring.machineId });
  }

  // Perf cycle 2: paged history. A window opening/resuming a session asks for
  // the NEWEST page (beforeCursor null) and, as the user scrolls up, for each
  // older page. Request/response — unlike TRANSCRIPT_REPLAY, which streams
  // every historical event back over TRANSCRIPT_EVENT and cost ~22s of main +
  // renderer work on a huge conversation.
  ipcMain.handle(IPC.TRANSCRIPT_PAGE, async (evt, req: TranscriptPageRequest): Promise<TranscriptPageResult> => {
    const empty: TranscriptPageResult = { events: [], cursor: null, hasMore: false };
    if (!req || typeof req.sessionId !== 'string') return empty;
    const { sessionId, beforeCursor } = req;

    // Did this window INHERIT the session (tear-off / re-dock) rather than watch
    // it live? Consumed unconditionally — including on the native path below,
    // which needs no special handling but must not leave the mark set for a
    // later, unrelated page read. See WindowRegistry.markInheritedByTransfer.
    const inherited = !beforeCursor
      && !!windowRegistry?.consumeInheritedByTransfer(sessionId, evt.sender.id);

    // Native sessions page over the merged event array; getHistoryPage returns
    // null for non-native ids, so CC's watcher stays the source for claude
    // sessions — the same discrimination the replay handler uses.
    const nativePage = nativeHost.getHistoryPage(sessionId, beforeCursor ? beforeCursor.offset : null);
    if (nativePage !== null) {
      return {
        events: nativePage.events,
        // `offset` carries an ARRAY INDEX for native sources; opaque to the renderer.
        cursor: nativePage.hasMore ? { path: `native:${sessionId}`, offset: nativePage.nextIndex!, sizeAtRead: 0 } : null,
        hasMore: nativePage.hasMore,
      };
    }

    let source: ResolvedPageSource | null = transcriptWatcher.pageSourceFor(sessionId);
    if (!source) {
      // Not watched (a just-resumed CC session before CC's hook reports the
      // transcript path; a session whose process has exited, which tears the
      // watcher down; the buddy floater, which never watched one). Resolve from
      // the ids the caller supplied, or from the ones an EARLIER request for
      // this session supplied — only the FIRST page request carries them, and
      // the scroll-up sentinel that follows it must not be told the
      // conversation has no more history just because it has no ids to send.
      // rememberLocator validates both before either shapes a path.
      pageSources.rememberLocator(sessionId, req.claudeSessionId, req.projectSlug);
      source = pageSources.get(sessionId);
      // NOT `empty`: "I cannot find the file" and "this is the beginning of the
      // conversation" were the same answer until 2026-09-07, and the renderer
      // acted on the second — dropping the cursor and the scroll-up sentinel
      // for good. Say which one this is so the caller can retry.
      if (!source) {
        // Put the one-shot tear-off mark back. It was consumed above (before we
        // knew whether we could serve anything) and it is what makes the
        // inheriting window's first page read to EOF — an attempt that served
        // NO events must not be the one that spends it, or the retry that
        // finally succeeds renders the conversation frozen at the moment the
        // session was resumed.
        if (inherited) windowRegistry?.markInheritedByTransfer(sessionId, evt.sender.id);
        return { ...empty, unresolved: true };
      }
    }
    // The FIRST page ends where the live tailer started, so the page and the
    // live stream cannot overlap (transcript-watcher startOffset, Task 4). A
    // startOffset of 0 means the file didn't exist at watch time — read to EOF.
    //
    // EXCEPT for a window that INHERITED this session: "the live stream already
    // delivered the rest" is only true of a window that was listening. A
    // torn-off window received none of it, so stopping at startOffset showed a
    // conversation frozen at the moment the session was resumed, with every
    // message since missing (Destin, 2026-09-03). It reads to EOF instead; the
    // reducer's HISTORY_PAGE_LOADED seeds its scratch replay from the live
    // session's seenUuids, so any overlap with live events is deduped, not
    // duplicated.
    const endOffset = beforeCursor
      ? beforeCursor.offset
      : (inherited ? null : (source.startOffset || null));
    return readTranscriptPage({
      jsonlPath: source.jsonlPath,
      sessionId,
      endOffset,
      subagentsDir: source.subagentsDir,
    });
  });

  // Transcript replay: a window that just acquired a session asks for every
  // historical event so its reducer can hydrate. Events stream back on the
  // normal TRANSCRIPT_EVENT channel (uuid dedup handles overlap with live).
  // We send directly to the requesting window — NOT via sendForSession —
  // because ownership has already transferred to them by the time this fires.
  ipcMain.on(IPC.TRANSCRIPT_REPLAY, (evt, { sessionId }: { sessionId: string }) => {
    // Native sessions replay from the SessionStore; getHistory returns null for
    // non-native ids so CC's watcher stays the source for claude sessions.
    const nativeEvents = nativeHost.getHistory(sessionId);
    const events = nativeEvents ?? transcriptWatcher.getHistory(sessionId);
    for (const ev of events) {
      evt.sender.send(IPC.TRANSCRIPT_EVENT, ev);
    }
    // (The blocks this used to inline now live in sendLiveOnlyState, which
    // SESSION_REPLAY_LIVE_STATE also serves — see its WHY.)
    sendLiveOnlyState(evt.sender, sessionId, nativeEvents !== null);
  });

  /**
   * Re-send the parts of a session's state that exist ONLY in main's memory and
   * have no record in the transcript on disk. A window hydrating from history —
   * whether by whole-transcript replay or by a single page — cannot reconstruct
   * any of it, so it must be pushed:
   *
   *  - open permission asks: the JSONL has no record that an ask is still
   *    AWAITING an answer, so the rebuilt card comes back with no buttons and
   *    (a root ask has no timeout) the turn hangs forever;
   *  - specialist run records: a specialist card's status IS its run record,
   *    which the transcript says nothing about;
   *  - background Bash run records: same, for a shell card's background state;
   *  - the replay-complete marker, which reaps tool cards the history left
   *    'running' (a transcript ends wherever the process died, so its last
   *    tool_use may have no matching result — Destin, 2026-08-09 dogfood).
   *
   * Sent DIRECT to the requesting window rather than via sendForSession: on the
   * ownership-handoff path the caller already owns the session, and on the
   * replay path ownership has likewise already transferred.
   *
   * `isNative` gates the first three: CC sessions have no broker-held asks, no
   * ledger and no shell registry, so they report nothing and keep today's
   * behaviour. The marker is sent for both, with sessionIdle false for CC —
   * only the native host can tell "genuinely mid-turn" from "died mid-tool".
   */
  function sendLiveOnlyState(sender: Electron.WebContents, sessionId: string, isNative: boolean): void {
    if (isNative) {
      for (const ev of nativeHost.pendingAskEventsFor(sessionId)) {
        sender.send(IPC.HOOK_EVENT, ev);
      }
    }
    if (isNative) {
      for (const run of nativeHost.specialistRunsFor(sessionId)) {
        sender.send(IPC.SPECIALISTS_EVENT, { kind: 'run', sessionId, run } satisfies SpecialistsEvent);
      }
      for (const run of nativeHost.shellRunsFor(sessionId)) {
        sender.send(IPC.NATIVE_SHELL_EVENT, { sessionId, run } satisfies ShellEvent);
      }
    }
    // sessionIdle gates the reap because this SAME state re-send fires when a
    // window re-docks a session that is genuinely mid-turn. Only the native
    // host can answer that (`entry.inFlight`); CC sessions have no equivalent
    // signal, so they report false and keep today's behaviour rather than risk
    // failing a tool that really is running. Synthesized here and never
    // persisted, so it cannot be re-read from a transcript.
    // Annotated, NOT passed inline: sender.send takes ...args: any[], which
    // erases the contextual type — an inline literal is checked against nothing,
    // so a typo'd `sessionIdle` compiles clean and silently disables the reap
    // (measured 2026-08-10). The annotation is what makes the field name a
    // compile error instead of a silent undefined.
    const replayComplete: TranscriptEvent = {
      type: 'replay-complete',
      sessionId,
      uuid: `replay-complete-${sessionId}`,
      timestamp: Date.now(),
      data: { sessionIdle: isNative && nativeHost.isIdle(sessionId) },
    };
    sender.send(IPC.TRANSCRIPT_EVENT, replayComplete);
  }

  // Ownership-handoff counterpart to TRANSCRIPT_REPLAY. A window that inherits
  // a session now hydrates its transcript from ONE page (TRANSCRIPT_PAGE, read
  // to EOF for an inherited session) instead of a whole-transcript replay that
  // cost ~22s on a long conversation and visibly rebuilt the view. That page
  // carries everything on disk but nothing that lives only in memory, which is
  // what this channel supplies. `handle`, not `on`: the renderer awaits the
  // page FIRST and then this, so the replay-complete marker cannot reap tool
  // cards before the page that creates them has been applied.
  ipcMain.handle(IPC.SESSION_REPLAY_LIVE_STATE, (evt, { sessionId }: { sessionId: string }) => {
    sendLiveOnlyState(evt.sender, sessionId, nativeHost.getHistory(sessionId) !== null);
  });

  // --- Native runtime IPC (Phase 1 Plan A) ---
  // M1: invoke — returns {status:'sent'|'queued'|'failed', reason?} so the renderer
  // can render truthful bubbles. send() is sync and never throws (host contract).
  // `attachments` are absolute composer file paths (optional — older renderers
  // and the remote shim may omit it). Image ones become image parts on the user
  // message; the paths also stay in `text`, which is the bubble's dedup key.
  ipcMain.handle(IPC.NATIVE_SEND, (_e, { sessionId, text, attachments }: { sessionId: string; text: string; attachments?: string[] }) =>
    nativeHost.send(sessionId, text, attachments ?? []));
  // Task 11: cancel/edit a queued-but-not-yet-sent message. removeQueued is
  // sync and never throws — the boolean IS the answer (true = removed, false =
  // too late / unknown), so this is a thin pass-through like NATIVE_SEND above.
  ipcMain.handle(IPC.NATIVE_QUEUE_REMOVE, (_e, { sessionId, queueId }: { sessionId: string; queueId: string }) =>
    nativeHost.removeQueued(sessionId, queueId));
  // Fire-and-forget I/O (no response): interrupt only. The host never throws for unknown ids.
  ipcMain.on(IPC.NATIVE_INTERRUPT, (_e, { sessionId }: { sessionId: string }) => {
    nativeHost.interrupt(sessionId);
  });
  // Stalled-turn Retry — fire-and-forget, same shape as interrupt above. The
  // host no-ops when nothing is parked (stream already resumed).
  ipcMain.on(IPC.NATIVE_RETRY, (_e, { sessionId }: { sessionId: string }) => {
    nativeHost.retryStalledStep(sessionId);
  });
  // User-initiated /compact for a native session. Never throws across IPC: a
  // failure returns a coded reason so the renderer can surface a specific,
  // accurate message instead of a guessed one (docs/error-message-standards.md).
  ipcMain.handle(IPC.NATIVE_COMPACT, async (_e, { sessionId }: { sessionId: string }) => {
    try {
      return await nativeHost.compact(sessionId);
    } catch (err: any) {
      return { ok: false, reason: 'error', detail: err?.message ?? String(err) };
    }
  });
  // /clear as a context BARRIER — appends a marker; the log is never rewritten.
  ipcMain.handle(IPC.NATIVE_CLEAR, (_e, { sessionId }: { sessionId: string }) => {
    try {
      return nativeHost.clear(sessionId);
    } catch (err: any) {
      return { ok: false, reason: 'error', detail: err?.message ?? String(err) };
    }
  });
  // /skill-name — loads one skill's instructions as a turn (M3 item 1). Works on
  // every model, unlike the Skill TOOL, which small windows never get.
  ipcMain.handle(IPC.NATIVE_INVOKE_SKILL, async (_e, { sessionId, skill, args }: { sessionId: string; skill: string; args?: string }) => {
    try {
      return await nativeHost.invokeSkill(sessionId, skill, args);
    } catch (err: any) {
      return { ok: false, reason: 'error', detail: err?.message ?? String(err) };
    }
  });
  ipcMain.handle(IPC.NATIVE_SET_BINDING, async (_e, sessionId: string, binding: any) => {
    const ok = await nativeHost.setBinding(sessionId, binding);
    // Task 4: a successful mid-session model swap is exactly the "model may
    // have changed" case noteModelUsed exists for — write it through so the
    // resume selector reflects the swap without waiting for the next turn.
    if (ok) {
      const ref = await resolvePortableModel(sessionId);
      if (ref) noteModelUsed(sessionId, ref);
    }
    return ok;
  });
  // Per-session permission mode (renderer chip). setPermissionMode throws on an
  // unknown mode string — the reject surfaces to the renderer invoke() so the
  // chip sees the failure instead of a false "applied"; on success it returns the
  // applied mode as the authoritative value.
  ipcMain.handle(IPC.NATIVE_SET_PERMISSION_MODE, async (_e, sessionId: string, mode: NativePermissionMode) =>
    nativeHost.setPermissionMode(sessionId, mode));
  // Read-only mode fetch — seeds the renderer chip on create/resume so a fresh
  // Coder session shows AUTO EDIT rather than the default ASK. Never throws
  // (getPermissionMode falls back to 'ask' for an unknown/non-live id).
  ipcMain.handle(IPC.NATIVE_GET_PERMISSION_MODE, async (_e, sessionId: string) =>
    nativeHost.getPermissionMode(sessionId));
  ipcMain.handle(IPC.NATIVE_GET_STEP_GUARD, () => stepGuardSettings.read());
  ipcMain.handle(IPC.NATIVE_SET_STEP_GUARD, async (_e, value: number | null) => stepGuardSettings.update(value));
  ipcMain.handle(IPC.NATIVE_SESSIONS_LIST, async () => nativeHost.list());
  // G-1: the Bash card's Stop button, on every surface.
  ipcMain.handle(IPC.NATIVE_KILL_SHELL, (_e, { sessionId, shellId }: { sessionId: string; shellId: string }) => nativeHost.killShell(sessionId, shellId));
  // Provider management (Settings → Providers).
  ipcMain.handle(IPC.PROVIDER_LIST, async () => providerRegistry.list());
  ipcMain.handle(IPC.PROVIDER_UPSERT, async (_e, config: any) => providerRegistry.upsert(config));
  ipcMain.handle(IPC.PROVIDER_REMOVE, async (_e, id: string) => { await providerRegistry.remove(id); return true; });
  ipcMain.handle(IPC.PROVIDER_TEST, async (_e, id: string) => providerRegistry.testConnection(id));
  ipcMain.handle(IPC.PROVIDER_SET_KEY, async (_e, id: string, key: string) => { await providerRegistry.setKey(id, key); return true; });
  ipcMain.handle(IPC.PROVIDER_CATALOG, async () => modelCatalog.get(await providerRegistry.list()));
  // Sign in with ChatGPT (backend design 2026-09-05 §3, §5, §6). status is a
  // cheap sync read (the card polls it every second while waiting). The verbs
  // resolve boolean; signIn() is allowed to THROW its two verbatim sentences
  // (port 1455 held by another program, keychain unavailable) — nothing here
  // catches them, so Electron rejects the renderer's promise and preload's
  // unwrapInvokeError strips the transport prefix before the card shows
  // e.message. Under the kill switch chatgptForUi is null: signed-out / false.
  ipcMain.handle(IPC.CHATGPT_STATUS, async () => chatgptForUi ? chatgptForUi.status() : { state: 'signed-out' as const });
  ipcMain.handle(IPC.CHATGPT_SIGN_IN, async () => chatgptForUi ? chatgptForUi.signIn() : false);
  ipcMain.handle(IPC.CHATGPT_CANCEL_SIGN_IN, async () => chatgptForUi ? chatgptForUi.cancelSignIn() : false);
  ipcMain.handle(IPC.CHATGPT_SIGN_OUT, async () => chatgptForUi ? chatgptForUi.signOut() : false);
  // WebSearch key management (Settings → Providers → Search). list returns the
  // fixed Tavily/Exa rows with hasKey flags; set/remove manage the encrypted key;
  // test is never-throws ({ ok, message } is the result, not an exception).
  ipcMain.handle(IPC.SEARCH_LIST, async () => searchKeyStore.list());
  ipcMain.handle(IPC.SEARCH_SET_KEY, async (_e, backend: 'tavily' | 'exa', key: string) => { await searchKeyStore.setKey(backend, key); return true; });
  ipcMain.handle(IPC.SEARCH_REMOVE_KEY, async (_e, backend: 'tavily' | 'exa') => { await searchKeyStore.removeKey(backend); return true; });
  ipcMain.handle(IPC.SEARCH_TEST, async (_e, backend: 'tavily' | 'exa', key: string) => searchService.testBackend(backend, key));
  // Remembered "Always allow" rules (Settings → Permissions, M5 2a).
  // list READS the store directly — it only reports what is on disk.
  // remove / remove-project go through nativeHost.revokeRule / revokeProject and
  // NEVER through permissionStore.remove / removeProject: the store touches disk
  // only, while the host also clears the per-session in-memory `rememberedFor`
  // map that buildDecide unions into every decision. A disk-only delete would
  // leave an already-running session granting exactly what the user just
  // revoked — the failure this whole feature exists to prevent.
  // Both revokes return true only when something actually matched; false means
  // the renderer's list was stale, and it says so instead of claiming success.
  ipcMain.handle(IPC.PERMISSIONS_LIST, async () => permissionStore.list());
  ipcMain.handle(IPC.PERMISSIONS_REMOVE, async (_e, slug: string, rule: PermissionRule) => nativeHost.revokeRule(slug, rule));
  ipcMain.handle(IPC.PERMISSIONS_REMOVE_PROJECT, async (_e, slug: string) => nativeHost.revokeProject(slug));
  // Specialists 1c (Task 8) — roster + tier reads/writes + card actions.
  // list ALWAYS re-reads (catalog.reload) so a file dropped into a specialists
  // folder a moment ago shows up without a separate "did it change" check;
  // ensurePersonalFolder is opt-in (Settings' "Open folder" needs somewhere
  // to open the FIRST time, before any file has ever been written there).
  ipcMain.handle(IPC.SPECIALISTS_LIST, async (_e, opts?: { cwd?: string; ensurePersonalFolder?: boolean }) => {
    if (opts?.ensurePersonalFolder) await specialistCatalog.ensurePersonalFolder();
    await specialistCatalog.reload(opts?.cwd);
    return toListResult(specialistCatalog.snapshot(opts?.cwd));
  });
  ipcMain.handle(IPC.SPECIALISTS_DELEGATED_GET, async () => nativeHost.getDelegatedModels());
  ipcMain.handle(IPC.SPECIALISTS_DELEGATED_SET, async (_e, tier: 'budget' | 'frontier', binding: { providerId: string; modelId: string } | null) =>
    nativeHost.setDelegatedModel(tier, binding));
  ipcMain.handle(IPC.SPECIALISTS_STEER, async (_e, sessionId: string, childId: string, text: string) =>
    nativeHost.steerFromUser(sessionId, childId, text));
  ipcMain.handle(IPC.SPECIALISTS_INTERRUPT, async (_e, sessionId: string, childId: string) =>
    nativeHost.interruptFromUser(sessionId, childId));
  // --- Local engine IPC (Plan B) ---
  // install/restart resolve to a fresh status() so the caller doesn't need a
  // second round-trip. The push emitters below keep every window + remote in
  // sync during long installs and on any run-state transition.
  ipcMain.handle(IPC.ENGINE_STATUS, async () => engineManager.status());
  ipcMain.handle(IPC.ENGINE_INSTALL, async () => { await engineManager.install(); return engineManager.status(); });
  ipcMain.handle(IPC.ENGINE_RESTART, async () => { await engineManager.restart(); return engineManager.status(); });
  // Push: install progress + run-state transitions → every window + remotes.
  engineManager.on('install-progress', (p) => {
    send(IPC.ENGINE_INSTALL_PROGRESS, p);
    remoteServer?.broadcast({ type: 'engine:install-progress', payload: p });
  });
  engineManager.on('status-changed', () => {
    const s = engineManager.status();
    send(IPC.ENGINE_STATUS_CHANGED, s);
    remoteServer?.broadcast({ type: 'engine:status-changed', payload: s });
  });
  // --- Per-model residency → per-session model-state coordinator (2026-07-14) ---
  // #1: when the last session using a model releases it, unload it immediately.
  // releaseModel, not unloadModel: a model the user asked to KEEP LOADED must
  // survive the last chat on it closing, or the setting is a lie (design §C2).
  nativeHost.setModelReleasedHandler((modelId) => { void engineManager.releaseModel(modelId); });
  // Join per-model residency (engine) with session→model (host): push each live
  // native session its bound model's state so ChatView can show the unloaded /
  // loading banner (#4/#5). Only push on change per session.
  // Signature includes loadedBytes so LOAD PROGRESS updates (state stays
  // 'loading' while bytes climb) are pushed, not just state transitions.
  const lastSessionModelState = new Map<string, string>();
  engineManager.on('models-changed', (models: EngineModelType[]) => {
    for (const m of models) {
      const payload = { modelId: m.id, state: m.state, sizeBytes: m.sizeBytes, loadedBytes: m.loadedBytes ?? null };
      const sig = `${m.state}:${m.loadedBytes ?? ''}`;
      for (const sessionId of nativeHost.sessionsForModel(m.id)) {
        if (lastSessionModelState.get(sessionId) === sig) continue;
        lastSessionModelState.set(sessionId, sig);
        const full = { sessionId, ...payload };
        sendForSession(sessionId, IPC.NATIVE_MODEL_STATE, full);
        remoteServer?.broadcast({ type: 'native:model-state', payload: full });
      }
    }
  });
  // Whole live per-model state (initial fetch for the coordinator's consumers).
  ipcMain.handle(IPC.ENGINE_MODELS, async () => engineManager.liveModels());
  // #2 create-time / swap-time memory guard; #4 [Reload Model].
  ipcMain.handle(IPC.MODELS_MEMORY_CHECK, async (_e, modelId: string) => modelManager.memoryCheck(modelId));
  ipcMain.handle(IPC.MODELS_LOAD, async (_e, modelId: string) => { await engineManager.loadModel(modelId); return true; });
  // --- Model manager IPC (Plan C) ---
  // Download progress fans out to every window + remotes on one push channel,
  // mirroring the engine install-progress emitter above.
  modelManager.on('download-progress', (p) => {
    send(IPC.MODELS_DOWNLOAD_PROGRESS, p);
    remoteServer?.broadcast({ type: 'models:download-progress', payload: p });
    // A finished download is invisible to a RUNNING router until it re-scans —
    // its own rescan flag only fires for downloads IT started, and ours are
    // app-side. Without this the model is a selectable picker row (K2's listing
    // union) that 400s on first send. Fire-and-forget: the pick-time
    // ensureServable is the safety net if this refresh fails or never ran.
    if (p.state === 'done') void engineManager.refreshModels().catch(() => { /* pick-time retry covers it */ });
  });
  ipcMain.handle(IPC.ENGINE_SET_BACKEND, async (_e, backend: string) => { await engineManager.setBackend(backend as any); return engineManager.status(); });
  ipcMain.handle(IPC.ENGINE_SET_CONTEXT, async (_e, contextSize: number) => { await engineManager.setContext(contextSize); return engineManager.status(); });
  // Engine-wide settings (2026-09-05 §B). The answer is the status the moment
  // the value was SAVED — `configApplyPending` on it says whether the engine has
  // picked it up yet, and a 'status-changed' push follows when it has.
  ipcMain.handle(IPC.ENGINE_SET_CONFIG, async (_e, patch: { contextSize?: number; speed?: any }) => {
    await engineManager.setConfig(patch ?? {});
    return engineManager.status();
  });
  // "Run in terminal" (§F): open a plain-shell session and TYPE the set-up
  // command onto its prompt. Nothing runs — the user presses Enter, and the
  // password an installer asks for is typed into their own terminal, not into
  // a dialog of ours.
  ipcMain.handle(IPC.ENGINE_RUN_IN_TERMINAL, async (event, command: string) => {
    // Refuses an empty command, a command carrying a control character (a `\r`
    // inside the string runs it with nobody pressing Enter), and a $SHELL that
    // is not installed. Throws with the real reason, which reaches EngineCard's
    // FieldError beside the button — see session-manager.ts.
    const checked = prepareRunInTerminal(command);
    // WHY the folder comes from the calling window's own sessions: the button
    // lives in Settings, which has no folder of its own, and the project the
    // user is working in is whatever their live sessions are open on. The
    // newest one wins; with no session at all (a fresh install setting up its
    // first engine) createSession falls back to the home folder.
    let cwd = '';
    for (const sid of windowRegistry?.sessionsForWindow(event.sender.id) ?? []) {
      const s = sessionManager.getSession(sid);
      if (s && s.status !== 'destroyed') cwd = s.cwd;
    }
    const info = sessionManager.createSession({
      name: shellDisplayName(checked.shell),
      cwd,
      skipPermissions: false,
      provider: 'shell',
      initialCommand: checked.command,
      // Proof the command went through the validator — createSession refuses a
      // shell session without it.
      shellToken: checked.shellToken,
    });
    // Same ownership handshake SESSION_CREATE does, and for the same reason:
    // session-created is forwarded one nextTick later, so without an owner
    // registered here the new session would appear in the FIRST window instead
    // of the one whose Settings the user is standing in. A buddy window can't
    // own a session, so its leader takes it.
    if (windowRegistry) {
      let targetId = event.sender.id;
      if (windowRegistry.getKind(event.sender.id) === 'buddy') {
        const leader = windowRegistry.getLeaderId();
        if (leader != null) targetId = leader;
      }
      try { windowRegistry.assignSession(info.id, targetId); }
      catch (e) { log('WARN', 'IPC', 'assignSession failed for the shell session', { error: String(e) }); }
    }
    return { sessionId: info.id };
  });
  // Faster-engine prerequisites (2026-09-05 §A5). `refresh: true` on purpose:
  // this channel is only ever called by the card, including its "Check again"
  // button AFTER the user has run the install command — a cached answer there
  // would report the software still missing and strand them in the set-up box.
  ipcMain.handle(IPC.ENGINE_PREREQS, async (_e, backend: string) => enginePrereqs(backend, { refresh: true }));
  ipcMain.handle(IPC.MODELS_CURATED, async () => modelManager.curatedList());
  ipcMain.handle(IPC.MODELS_SEARCH, async (_e, query: string) => modelManager.search(query));
  ipcMain.handle(IPC.MODELS_QUANTS, async (_e, repo: string) => modelManager.quants(repo));
  ipcMain.handle(IPC.MODELS_DOWNLOAD, async (_e, repo: string, quant: any) => modelManager.download(repo, quant));
  ipcMain.handle(IPC.MODELS_DOWNLOAD_CANCEL, async (_e, downloadId: string) => { modelManager.cancel(downloadId); return true; });
  ipcMain.handle(IPC.MODELS_DELETE, async (_e, id: string) => { await engineManager.deleteModel(id); return true; });
  ipcMain.handle(IPC.MODELS_INSTALLED, async () => engineManager.installedModels());
  // Resume an interrupted download (2026-08-26). Reads the manifest written
  // beside the .partial — no Hugging Face round trip, so it works when the
  // network is the reason the download stopped.
  ipcMain.handle(IPC.MODELS_RESUME, async (_e, modelId: string) => modelManager.resume(modelId));
  // --- Per-model settings + vision (2026-09-05 local-engine upgrades §C/§E4) ---
  // Read: the STORED settings, so the dialog can also show "Applies after the
  // current reply" and the model's last load error, neither of which the user
  // sets. A model nobody has touched reads as every default.
  ipcMain.handle(IPC.MODELS_SETTINGS, async (_e, modelId: string) => engineManager.modelSettings(modelId));
  // Write: the value saves at once and the ENGINE is left alone — rewriting the
  // preset file here would make the router unload the model mid-reply, which is
  // the one thing this feature promises will not happen. Every rejection
  // (context too small, an engine option the binary does not know, a bad
  // toggle) throws with the reason the user needs, and the dialog shows it.
  ipcMain.handle(IPC.MODELS_SET_SETTINGS, async (_e, modelId: string, patch: ModelSettingsWrite) =>
    engineManager.setModelSettings(modelId, patch ?? {}));
  // Add vision to a model already on disk. Returns the download id straight
  // away; the bytes report on the ordinary models:download-progress stream, so
  // the row's existing progress bar covers it with no second channel.
  ipcMain.handle(IPC.MODELS_ADD_VISION, async (_e, modelId: string) => modelManager.addVision(modelId));
  ipcMain.handle(IPC.ENDPOINTS_DETECT, async () =>
    detectEndpoints(fetch, ((await providerRegistry.list()) as any[])));
  // /clear and /compact both truncate or rewrite the JSONL. App.tsx listens
  // to detect compaction completion (pending → COMPACTION_COMPLETE).
  transcriptWatcher.on('transcript-shrink', (payload: any) => {
    sendForSession(payload.sessionId, IPC.TRANSCRIPT_SHRINK, payload);
    if (remoteServer) {
      remoteServer.broadcast({ type: 'transcript:shrink', payload });
    }
  });
  const topicWatchers = new Map<string, fs.FSWatcher | NodeJS.Timeout>();
  const lastTopics = new Map<string, string>();

  // Broadcast session rename to remote WebSocket clients + update SessionInfo
  function broadcastRename(desktopId: string, name: string) {
    const session = sessionManager.getSession(desktopId);
    if (session) session.name = name;
    remoteServer?.broadcast({ type: 'session:renamed', payload: { sessionId: desktopId, name } });
    remoteServer?.setLastTopic(desktopId, name);
    // Fan out a directory refresh so any renderer that reads session names
    // from WINDOW_DIRECTORY_UPDATED (buddy SessionPill, main SessionStrip)
    // picks up the new name. sendForSession(SESSION_RENAMED) only reaches
    // the session's owner + subscribers — the buddy only subscribes to its
    // ONE viewed session, so without this its dropdown shows stale names
    // for every OTHER session. getDirectory() is the lazy snapshot; emit
    // 'changed' triggers broadcastWindowState() in main.ts which rebuilds
    // and pushes it.
    windowRegistry?.emit('changed');
  }

  function readTopicFile(claudeSessionId: string): string | null {
    try {
      const content = fs.readFileSync(path.join(topicDir, `topic-${claudeSessionId}`), 'utf8').trim();
      return content || null;
    } catch {
      return null;
    }
  }

  const pendingWatchers = new Set<string>();

  function startWatching(desktopId: string, claudeId: string) {
    if (topicWatchers.has(desktopId) || pendingWatchers.has(desktopId)) return;
    pendingWatchers.add(desktopId);

    // Read initial value
    const initial = readTopicFile(claudeId);
    if (initial && initial !== 'New Session') {
      lastTopics.set(desktopId, initial);
      sendForSession(desktopId, IPC.SESSION_RENAMED, desktopId, initial);
      broadcastRename(desktopId, initial);
      // Conversation Store (Phase 2a): mirror the auto-title into the record.
      // Keyed by claudeId (the store's record id). This is the only sanctioned
      // title writer (carry-forward 5) — no user-rename path exists yet.
      // Result ignored (best-effort, no UI to revert here) — void per Item 6's
      // Promise<MetaWriteResult> shape.
      void noteTitleChanged(claudeId, initial, 'claude');
    }

    const topicFilePath = path.join(topicDir, `topic-${claudeId}`);

    // Prefer fs.watch for efficiency; fall back to polling if watch fails
    // (e.g., on network filesystems or platforms with limited inotify)
    try {
      const watcher = fs.watch(topicFilePath, { persistent: false }, () => {
        const topic = readTopicFile(claudeId);
        if (topic && topic !== 'New Session' && topic !== lastTopics.get(desktopId)) {
          lastTopics.set(desktopId, topic);
          sendForSession(desktopId, IPC.SESSION_RENAMED, desktopId, topic);
          broadcastRename(desktopId, topic);
          void noteTitleChanged(claudeId, topic, 'claude'); // Conversation Store (Phase 2a) title write-through; result ignored
        }
      });
      watcher.on('error', () => {
        // File may not exist yet — fall back to polling
        watcher.close();
        startPolling(desktopId, claudeId);
      });
      topicWatchers.set(desktopId, watcher);
      pendingWatchers.delete(desktopId);
    } catch {
      // fs.watch not available or file doesn't exist yet — poll instead
      pendingWatchers.delete(desktopId);
      startPolling(desktopId, claudeId);
    }
  }

  function startPolling(desktopId: string, claudeId: string) {
    if (topicWatchers.has(desktopId)) return;
    const interval = setInterval(() => {
      const topic = readTopicFile(claudeId);
      if (topic && topic !== 'New Session' && topic !== lastTopics.get(desktopId)) {
        lastTopics.set(desktopId, topic);
        sendForSession(desktopId, IPC.SESSION_RENAMED, desktopId, topic);
        broadcastRename(desktopId, topic);
        void noteTitleChanged(claudeId, topic, 'claude'); // Conversation Store (Phase 2a) title write-through; result ignored
      }
    }, 2000);
    topicWatchers.set(desktopId, interval);
  }

  // Tear down the topic + transcript watchers for a desktop session. Shared
  // by the remap path (CC rotated its session id on /clear) and the
  // session-exit cleanup — the close()-vs-clearInterval discriminator is
  // subtle enough that two drifting copies would be a bug factory.
  function teardownSessionWatchers(desktopId: string): void {
    const watcher = topicWatchers.get(desktopId);
    if (watcher) {
      if (typeof (watcher as fs.FSWatcher).close === 'function') {
        (watcher as fs.FSWatcher).close();
      } else {
        clearInterval(watcher as NodeJS.Timeout);
      }
      topicWatchers.delete(desktopId);
      lastTopics.delete(desktopId);
    }
    transcriptWatcher.stopWatching(desktopId);
  }

  // Listen for hook events to extract the desktop→claude session ID mapping
  if (hookRelay) {
    hookRelay.on('hook-event', (event: { sessionId: string; payload: Record<string, unknown> }) => {
      const desktopId = event.sessionId; // _desktop_session_id (set by parseHookPayload)
      const claudeId = event.payload?.session_id as string;
      if (!desktopId || !claudeId) return;

      // Decide whether to (re)map this desktop session to a Claude session id.
      // Not set-once: Claude Code rotates its session id mid-PTY on `/clear`, so
      // we must follow that rotation — but ONLY from SessionStart events, since
      // subagent/tool hooks carry child session ids that would poison the map.
      // (payload.hook_event_name is CC's raw field, distinct from the
      // normalized event.type which coerces missing names to 'unknown'.)
      // /compact is safe here: it rewrites the SAME transcript file without
      // rotating the id (the transcript-shrink machinery depends on that), so
      // its SessionStart arrives with a matching id and resolves to 'ignore'.
      //
      // `source` (startup|resume|clear|compact) gates the REMAP specifically:
      // a `startup` on an already-mapped session is a FOREIGN claude process
      // reporting in under our inherited CLAUDE_DESKTOP_SESSION_ID, not our own
      // rotation. See session-id-mapping.ts for the full why.
      const current = sessionIdMap.get(desktopId);
      const hookEventName = event.payload?.hook_event_name as string | undefined;
      const source = event.payload?.source as string | undefined;
      if (resolveMappingAction(current, claudeId, hookEventName, source) !== 'adopt') {
        // Log only a REFUSED remap (not the steady-state 'ignore' of matching
        // ids / tool hooks, which would spam every hook event). This is the
        // breadcrumb the 2026-07-26 wrong-transcript investigation had to do
        // multi-hour disk forensics for: nothing recorded that the chat view
        // had been repointed at another conversation.
        if (current && current !== claudeId && hookEventName === 'SessionStart') {
          log('WARN', 'SessionMap', 'refused session-id remap', {
            desktopId, from: current, to: claudeId, source,
          });
        }
        return;
      }
      if (current && current !== claudeId) {
        log('INFO', 'SessionMap', 'remapping session id', {
          desktopId, from: current, to: claudeId, hookEventName, source,
        });
      }

      // Remap (e.g. /clear rotated the CC session id): tear down the old
      // topic + transcript watchers before starting new ones. startWatching
      // OVERWRITES the topicWatchers entry, so without closing the old watcher
      // first we'd leak its FSWatcher/interval and keep broadcasting renames
      // from the stale topic file.
      // INVARIANT: this remap assumes the rotated transcript starts EMPTY
      // (true for /clear). An in-session /resume rotates onto a NON-empty file
      // by design — its offset-0 replay is what hydrates the chat view with the
      // resumed conversation, which is correct there.
      // The dangerous case — a foreign process's `startup` repointing us at an
      // unrelated conversation — is now refused by the `source` gate above
      // (2026-07-26). If a future CC change rotates onto a non-empty file under
      // some OTHER source, the offset-0 replay would append into an
      // already-populated chat timeline, and the renderer would need a
      // CLEAR_TIMELINE-equivalent coupled to the remap.
      if (current) {
        teardownSessionWatchers(desktopId);
        // 2b: /clear rotates the CC session id WITHOUT firing session-exit, so the
        // pre-rotation claudeId's lease + its 30s renew timer would otherwise leak
        // (renewing a dead id every 30s until app quit). Release it here.
        // Idempotent + best-effort; release() never rejects, .catch guards a future change.
        void leaseWiring?.client.release(current).catch(() => { /* best-effort */ });
      }

      sessionIdMap.set(desktopId, claudeId);
      startWatching(desktopId, claudeId);

      // Start watching the transcript file for this session
      const sessionInfo = sessionManager.getSession(desktopId);
      if (sessionInfo) {
        // Spec §5.0: CC's payload carries transcript_path AND cwd (both required
        // fields of its hook schema). payload.cwd is post-realpath/post-chdir —
        // the exact string CC slugged — so prefer it over our sessionInfo.cwd,
        // which can differ through a symlink. sessionInfo.cwd is the fallback only.
        // Hardened casts (final review, MINOR fold): a raw `as string | undefined`
        // trusts the hook payload's shape blindly — if CC ever sent a non-string
        // for either field, the cast would silently pass it through instead of
        // falling back. typeof-narrow so an unexpected shape degrades to the
        // documented fallback (sessionInfo.cwd / slug derivation) instead of
        // handing a non-string downstream.
        const payloadCwd = typeof event.payload?.cwd === 'string' ? event.payload.cwd : undefined;
        const ccCwd = payloadCwd || sessionInfo.cwd;
        const ccTranscriptPath = typeof event.payload?.transcript_path === 'string' ? event.payload.transcript_path : undefined;
        transcriptWatcher.startWatching(desktopId, claudeId, ccCwd, ccTranscriptPath);
        // Take the AUTHORITATIVE path for paged history from the watcher we
        // just started, so scroll-back keeps working after this session's
        // process exits (session-exit stops the watcher; the conversation stays
        // on screen). Read back rather than re-derived: the watcher prefers
        // CC's own post-realpath transcript_path, which a path derived from our
        // cwd can miss through a symlink. Overwrites any earlier guess, and
        // follows a /clear rotation because this runs again on the remap.
        const watched = transcriptWatcher.pageSourceFor(desktopId);
        if (watched) pageSources.remember(desktopId, watched);
        // Conversation Store (Phase 2a): tell the store this claude session's cwd
        // so its activity upserts carry projectName/originalPath (local truth).
        noteSessionStarted(claudeId, ccCwd, 'claude');
        // 2b Task 8: this device now owns the session — take the lease.
        // Fire-and-forget: a denied (ok:false) result would only mean another
        // device holds it, but the sanctioned resume path already ran takeover
        // BEFORE spawn, so we never block session start on the lease. acquire()
        // never rejects, but the .catch keeps a future change from leaking one.
        //
        // Gate on sync being ENABLED: leases coordinate CROSS-DEVICE writers, which
        // only exist for a synced conversation. Without this, every CC SessionStart
        // (even for users who never enabled sync) took an optimistic local hold with
        // a 30s renew timer writing Personal/Leases/*.json — wasteful and creates a
        // Leases/ dir for no reason. Release on session-exit stays UNCONDITIONAL
        // (idempotent — harmless if never acquired) so a session that acquired while
        // sync was on still releases if sync later flips off.
        // Log a denied acquire: today a session can run its whole life NOT owning
        // its lease with zero trace, which is exactly how the 2026-07-18 handoff
        // timeout went undiagnosed (the holder never held, so it never responded).
        // Still never-block — the resume must not wait on the lease — but leave a
        // breadcrumb so the next "takeover didn't respond" is diagnosable.
        if (isSyncSpacesEnabled()) {
          void leaseWiring?.client.acquire(claudeId)
            .then((res) => {
              if (res && res.ok === false) {
                log('WARN', 'Lease', 'session running without its lease (held by another device)', { claudeId, holder: res.holder });
              }
            })
            .catch(() => { /* never-block */ });
        }
      }
    });
  }

  // Stop watching when a session is destroyed
  sessionManager.on('session-exit', (sessionId: string) => {
    teardownSessionWatchers(sessionId);
    // Native teardown backstop (2026-07-18). SESSION_DESTROY already awaits
    // nativeHost.destroy before destroySession, but session-exit ALSO fires for
    // paths that go straight to SessionManager (a crashed worker, a takeover, an
    // internal destroy) — and for a native session those left the HarnessSession
    // running with its transcript-event listener still appending. Idempotent and
    // a no-op for non-native ids, so calling it here is free on the CC path.
    // Fire-and-forget: this listener is sync, and destroy() never rejects for an
    // unknown id — the .catch guards a future change.
    void nativeHost.destroy(sessionId).catch((e) => {
      log('ERROR', 'IPC', 'native teardown on session-exit failed', { sessionId, error: String(e) });
    });
    // Task 7: same backstop reasoning as the destroy() call above — this
    // path also covers crashes/takeovers that never went through
    // SESSION_DESTROY, so the feeder's per-session state needs the same
    // cleanup here too.
    nativeTitleFeeder.forget(sessionId);
    // Clean up context + session stats cache files
    const claudeId = sessionIdMap.get(sessionId);
    if (claudeId) {
      fs.unlink(path.join(os.homedir(), '.claude', `.context-${claudeId}`), () => {});
      fs.unlink(path.join(os.homedir(), '.claude', `.session-stats-${claudeId}.json`), () => {});
      // 2b (Bug 2 Part 2): release the conversation-store materialize guard +
      // apply any peer version now that this session ended — no restart needed.
      // Resolved from the map BEFORE the delete below, so the claude id is known.
      noteSessionEnded(claudeId);
      // A session that just ended has new turns to index. Debounced, and it runs
      // after noteSessionEnded's own quiescence-gated materialize.
      requestChatsearchRefresh();
      // 2b Task 8: drop our lease so another device can acquire. Idempotent +
      // best-effort; release() never rejects, .catch guards a future change.
      void leaseWiring?.client.release(claudeId).catch(() => { /* best-effort */ });
    }
    sessionIdMap.delete(sessionId);
    lastAttentionBySession.delete(sessionId);
    // Drop the last-known status values so buildStatusData doesn't keep
    // broadcasting chips for a session that's gone.
    delete lastContextByDesktopId[sessionId];
    delete lastGitBranchByDesktopId[sessionId];
    delete lastSessionStatsByDesktopId[sessionId];
  });

  // Set a named flag on a session (complete, priority, helpful). Persists in
  // the Conversation Store (~/YouCoded/Personal/Conversations/) via
  // noteFlagChanged, and broadcasts SESSION_META_CHANGED so any open resume
  // browser refreshes. Accepts either a Claude session ID (as stored in the
  // store) or a desktop session ID — the desktop ID is resolved via
  // sessionIdMap. Unknown flag names are rejected server-side so a typo
  // surfaces as an error rather than silently writing dead data.
  //
  // Phantom-record gate, PART 2 (2026-07-18). The original gate below keys off
  // `sessionIdMap.has(sessionId)`, which was a reliable "this is a CC id" proxy
  // only while native sessions stayed out of that map. PR #176 started mapping
  // native sessions (identity, for the lease), which silently opened the exact
  // hole the gate was written to close — for NATIVE ids this time. setFlag /
  // setTitle / setNote all SEED a record when none exists (conversation-store.ts),
  // each with a hardcoded provider:'claude', so flagging or noting a native
  // session wrote a mislabeled record with blank projectName / originalPath /
  // transcriptRef and an EPOCH lastActive — synced to every device and never
  // pruned (flagged records are deliberately kept). Confirmed on disk 2026-07-18.
  //
  // Task 5: native conversations are real Conversation Store records now
  // (Task 4 made native transcript events upsert 'native' records the same way
  // CC turns upsert 'claude' ones), so the gate's job shrinks to its ORIGINAL
  // purpose — the CC live-before-mapping race — and no longer needs a
  // provider carve-out at all. A native id is always identity-mapped into
  // sessionIdMap the moment it's created (SESSION_CREATE's native branch), so
  // `sessionIdMap.has(sessionId)` is true for it from the start; this gate was
  // never the thing keeping native writes out — nativeMetaRefusal below (now
  // deleted) was. Retiring that refusal is only safe BECAUSE Task 4 landed
  // real native writes first — see the design's Task 5 note.
  // `_resolved` is unused on purpose: the phantom-record gate keys off the raw
  // sessionId, not the resolved path. The param stays to match the `canWrite`
  // signature RemoteServer.setSessionMetaWiring expects.
  const canWriteStoreRecord = (sessionId: string, _resolved: string): boolean => {
    return sessionIdMap.has(sessionId) || !sessionManager.getSession(sessionId);
  };

  // Parity wiring (Item 6, design §12 survivor 1): give remote WS clients the
  // SAME sessionId resolution + phantom-record gate the ipcMain handlers above
  // use for session:set-tag / session:set-note, so tagging/noting a session
  // over remote can't bypass a gate that only ever covered the local path.
  remoteServer?.setSessionMetaWiring({
    resolve: (sessionId: string) => sessionIdMap.get(sessionId) || sessionId,
    canWrite: canWriteStoreRecord,
  });

  // Provider bucket to READ a resolved session's meta from. 'native' when
  // NativeSessionHost recognizes the id (live now, or a persisted
  // ~/.youcoded/sessions file); otherwise probe the store's native bucket —
  // a store-only native browse row (record synced, transcript not local yet;
  // Task 5) is still native even though isNativeSessionId can't see it (C1).
  // A null store (boot window) falls back to 'claude' exactly as before.
  // WRITES do NOT use this: they pass isNativeSessionId(resolved) straight to
  // noteFlagChanged/noteSessionNote, which defer the native-bucket probe to
  // flush time so a boot-window buffered write re-derives once the store is up.
  const sessionProviderFor = async (resolved: string): Promise<SessionProvider> => {
    if (nativeHost.isNativeSessionId(resolved)) return 'native';
    const store = getConversationStore();
    if (!store) return 'claude';
    try { return (await store.get('native', resolved)) ? 'native' : 'claude'; }
    catch { return 'claude'; }
  };

  ipcMain.handle(IPC.SESSION_SET_FLAG, async (_event, sessionId: string, flag: string, value: boolean) => {
    if (!SESSION_FLAG_NAMES.includes(flag as SessionFlagName)) {
      return { ok: false, error: `unknown flag: ${flag}` };
    }
    const resolved = sessionIdMap.get(sessionId) || sessionId;
    try {
      // Plan 2c: flags are STORE-ONLY now. The legacy conversation-index
      // dual-write (svc.setSessionFlag) was removed — the Conversation Store is
      // the sole authority for flags; the frozen legacy index is read-only for
      // residual legacy-only rows. safeWrite semantics live inside noteFlagChanged.
      //
      // Phantom-record gate (review fix 5): only write when `resolved` is
      // actually a CLAUDE id. Either the mapping is known (sessionId was a
      // desktop id → resolved is the mapped claude id), or sessionId is NOT a
      // live desktop session (Resume Browser rows pass claude ids for past
      // sessions — safe to write as-is). Without this gate, flagging a LIVE
      // session before its SessionStart hook establishes the mapping would
      // seed a flag-only record keyed by the desktop randomUUID — UUID-shaped
      // (passes the store's id guard), synced to every device, and never
      // pruned (flagged records are deliberately kept). When gated out, the
      // flag re-applies once the SessionStart hook establishes the mapping and
      // the user (or a re-flag) drives it again — flags are store-only now,
      // so there's no legacy index still catching it in the meantime.
      if (canWriteStoreRecord(sessionId, resolved)) {
        // Item 6: await the real result and answer honestly — the write can
        // now report ok:false (store not up yet / never came up / rejected)
        // instead of the old fire-and-forget that always said ok:true even
        // when the write silently evaporated (2026-07-19 incident class, for
        // the store-availability dimension). Task 5: provider is now derived
        // per-session instead of hardcoded 'claude' — the write lands in
        // whichever bucket get-meta/browse will read it back from.
        const res = await noteFlagChanged(resolved, flag, !!value, nativeHost.isNativeSessionId(resolved));
        if (!res.ok) {
          return { ok: false, error: 'Could not save — conversation storage is not available on this device.' };
        }
      }
      const payload = { flag, value: !!value };
      sendForSession(resolved, IPC.SESSION_META_CHANGED, resolved, payload);
      remoteServer?.broadcast({
        type: IPC.SESSION_META_CHANGED,
        payload: { sessionId: resolved, ...payload },
      });
      emitConversationMetaChanged();
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // --- Tag registry CRUD ---
  ipcMain.handle(IPC.TAGS_LIST, async () => {
    const reg = getTagRegistry();
    if (!reg) return [];
    try { return await reg.list(); } catch { return []; }
  });

  ipcMain.handle(IPC.TAGS_CREATE, async (_e, label: string, color: string) => {
    const reg = getTagRegistry();
    if (!reg) return { ok: false, error: 'tag registry unavailable' };
    const c: TagColor = isTagColor(color) ? color : 'tag-gray';
    try {
      const tag = await reg.create(String(label ?? ''), c);
      remoteServer?.broadcast({ type: IPC.TAGS_CHANGED, payload: {} });
      // Notify local windows too (buddy window + main share the registry).
      broadcastToAllWindows(IPC.TAGS_CHANGED, {});
      return { ok: true, tag };
    } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  });

  ipcMain.handle(IPC.TAGS_UPDATE, async (_e, id: string, patch: { label?: string; color?: string; archived?: boolean }) => {
    const reg = getTagRegistry();
    if (!reg) return { ok: false, error: 'tag registry unavailable' };
    const clean: { label?: string; color?: TagColor; archived?: boolean } = {};
    if (patch?.label !== undefined) clean.label = String(patch.label);
    if (patch?.color !== undefined) clean.color = isTagColor(patch.color) ? patch.color : 'tag-gray';
    if (patch?.archived !== undefined) clean.archived = !!patch.archived;
    try {
      const tag = await reg.update(String(id), clean);
      remoteServer?.broadcast({ type: IPC.TAGS_CHANGED, payload: {} });
      broadcastToAllWindows(IPC.TAGS_CHANGED, {});
      // Task 5 gap (final review): the chatsearch metadata snapshot denormalizes
      // tag LABELS at build time (meta-builder.ts resolves tag ids -> labels once,
      // into each conversation row) — renaming a tag here doesn't touch those
      // rows, so without this the index would keep serving the OLD label until
      // some unrelated refresh happened to rebuild it.
      emitConversationMetaChanged();
      return { ok: true, tag };
    } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  });

  ipcMain.handle(IPC.TAGS_DELETE, async (_e, id: string) => {
    const reg = getTagRegistry();
    if (!reg) return { ok: false, error: 'tag registry unavailable' };
    try {
      await reg.delete(String(id));
      remoteServer?.broadcast({ type: IPC.TAGS_CHANGED, payload: {} });
      broadcastToAllWindows(IPC.TAGS_CHANGED, {});
      // Same gap as TAGS_UPDATE above — a deleted tag's label must also drop
      // out of the denormalized index, not just the registry.
      emitConversationMetaChanged();
      return { ok: true };
    } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  });

  // --- Apply/remove a tag on a session (writes tag:<id> into the store flag map) ---
  ipcMain.handle(IPC.SESSION_SET_TAG, async (_e, sessionId: string, tagId: string, value: boolean) => {
    if (typeof tagId !== 'string' || !tagId.startsWith('tag_')) {
      return { ok: false, error: `invalid tag id: ${tagId}` };
    }
    const resolved = sessionIdMap.get(sessionId) || sessionId;
    const key = tagFlagKey(tagId);
    try {
      // Same phantom-record gate as SESSION_SET_FLAG: only write the store when
      // `resolved` is a known CLAUDE id or a non-live session (regardless of
      // provider — see canWriteStoreRecord's comment; Task 5 dropped the
      // native carve-out). Tags are stored as `tag:<id>` flags.
      if (canWriteStoreRecord(sessionId, resolved)) {
        // Item 6: same honest-write parity as SESSION_SET_FLAG. Provider is
        // derived, not hardcoded — see SESSION_SET_FLAG's comment.
        const res = await noteFlagChanged(resolved, key, !!value, nativeHost.isNativeSessionId(resolved));
        if (!res.ok) {
          return { ok: false, error: 'Could not save — conversation storage is not available on this device.' };
        }
      }
      const payload = { flag: key, value: !!value };
      sendForSession(resolved, IPC.SESSION_META_CHANGED, resolved, payload);
      remoteServer?.broadcast({ type: IPC.SESSION_META_CHANGED, payload: { sessionId: resolved, ...payload } });
      emitConversationMetaChanged();
      return { ok: true };
    } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  });

  // --- Set/clear a session note ---
  ipcMain.handle(IPC.SESSION_SET_NOTE, async (_e, sessionId: string, note: string) => {
    const resolved = sessionIdMap.get(sessionId) || sessionId;
    const text = String(note ?? '');
    if (text.length > 8000) return { ok: false, error: 'note exceeds 8000 characters' };
    try {
      if (canWriteStoreRecord(sessionId, resolved)) {
        // Item 6: same honest-write parity as SESSION_SET_FLAG. Provider is
        // derived, not hardcoded — see SESSION_SET_FLAG's comment.
        const res = await noteSessionNote(resolved, text, nativeHost.isNativeSessionId(resolved));
        if (!res.ok) {
          return { ok: false, error: 'Could not save — conversation storage is not available on this device.' };
        }
      }
      const payload = { note: text };
      sendForSession(resolved, IPC.SESSION_META_CHANGED, resolved, payload);
      remoteServer?.broadcast({ type: IPC.SESSION_META_CHANGED, payload: { sessionId: resolved, ...payload } });
      emitConversationMetaChanged();
      return { ok: true };
    } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  });

  // --- Read a live/past session's applied tags + note (session:browse excludes
  // live sessions, so Plan B's in-session StatusBar element reads meta here) ---
  ipcMain.handle(IPC.SESSION_GET_META, async (_e, sessionId: string) => {
    const store = getConversationStore();
    const resolved = sessionIdMap.get(sessionId) || sessionId;
    // Task 5: read from whichever provider bucket this session actually writes
    // to — native records are real now, so there's no more up-front refusal.
    // `supported` stays in the result shape (Android still answers false).
    if (!store) return { tags: [], note: '', supported: true };
    try {
      const rec = await store.get(await sessionProviderFor(resolved), resolved);
      if (!rec) return { tags: [], note: '', supported: true };
      const tags: string[] = [];
      // Reserved flags travel alongside the tags now: the in-session chip shows
      // Priority as a built-in tag, so it needs the value, not just the tag
      // list. Whitelisted to SESSION_FLAG_NAMES so an internal flag key can
      // never leak to the renderer by being added to a record.
      const reserved: Partial<Record<string, boolean>> = {};
      for (const [k, v] of Object.entries(rec.flags)) {
        if (v.value && k.startsWith('tag:')) tags.push(k.slice(4));
        else if (v.value && (SESSION_FLAG_NAMES as string[]).includes(k)) reserved[k] = true;
      }
      return { tags, note: rec.note || '', supported: true, flags: reserved };
    } catch { return { tags: [], note: '', supported: true }; }
  });

  // --- Sync management ---
  // Control plane for YouCoded toolkit sync — reads state files written
  // by sync.sh / session-start.sh and triggers sync via the existing scripts.
  ipcMain.handle(IPC.SYNC_GET_STATUS, () => getSyncStatus());
  ipcMain.handle(IPC.SYNC_GET_CONFIG, () => getSyncConfig());
  ipcMain.handle(IPC.SYNC_SET_CONFIG, (_e, updates) => setSyncConfig(updates));
  ipcMain.handle(IPC.SYNC_FORCE, () => forceSync());
  ipcMain.handle(IPC.SYNC_GET_LOG, (_e, lines) => getSyncLog(lines));
  ipcMain.handle(IPC.SYNC_DISMISS_WARNING, (_e, warning) => dismissWarning(warning));

  // Cross-device sync spaces (spec 2026-07-03) — folder-based sync engine,
  // distinct from the legacy sync:* backup control plane above. The service
  // module owns the singleton engine/manager/roots.
  ipcMain.handle(IPC.SYNC_SPACES_STATUS, () => syncSpacesStatus());
  ipcMain.handle(IPC.SYNC_SPACES_ENABLE, (_e, enabled: boolean) => syncSpacesEnable(!!enabled));
  // spaceId (optional) narrows the sync to one space for the Project View
  // "Sync now" button; SyncPanel calls with no arg = sync everything.
  ipcMain.handle(IPC.SYNC_SPACES_SYNC_NOW, (_e, spaceId?: string) =>
    syncSpacesSyncNow(spaceId ? String(spaceId) : undefined));
  ipcMain.handle(IPC.SYNC_SPACES_CREATE_PROJECT, (_e, name: string) => syncSpacesCreateProject(String(name ?? '')));
  ipcMain.handle(IPC.SYNC_SPACES_IMPORT_PROJECT, (_e, sourcePath: string, name: string) =>
    // Live-cwd guard input: the folder must not move under a running session.
    syncSpacesImportProject(String(sourcePath ?? ''), String(name ?? ''),
      sessionManager.listSessions().filter(s => s.status !== 'destroyed').map(s => s.cwd)));
  // Cross-device rename (display-name only) + stop-syncing (2026-07-12).
  ipcMain.handle(IPC.SYNC_SPACES_RENAME_PROJECT, (_e, p: { name: string; displayName: string }) =>
    syncSpacesRenameProject(String(p?.name ?? ''), String(p?.displayName ?? '')));
  ipcMain.handle(IPC.SYNC_SPACES_STOP_PROJECT, (_e, p: { name: string }) =>
    syncSpacesStopProject(String(p?.name ?? '')));
  // Synced project description (Task 3) — payload-object shape, matching renameProject.
  ipcMain.handle(IPC.SYNC_SPACES_SET_PROJECT_DESCRIPTION, (_e, p: { name: string; description: string }) =>
    syncSpacesSetProjectDescription(String(p?.name ?? ''), String(p?.description ?? '')));

  // Conversation-lease takeover (Plan 2b Task 9). Thin passthroughs to the lease
  // client (query) and the requester flow (takeover/force) built in main.ts.
  // When lease wiring is absent (sync disabled), every handler degrades to a
  // "free / error" answer so the renderer's resume gate proceeds unblocked
  // (spec §3 never-block).
  ipcMain.handle(IPC.SYNC_SPACES_LEASE_QUERY, (_e, p: { claudeSessionId: string }) =>
    leaseWiring?.client.query(String(p?.claudeSessionId ?? '')) ?? { held: false, source: 'none' });
  ipcMain.handle(IPC.SYNC_SPACES_LEASE_TAKEOVER, (_e, p: { claudeSessionId: string }) =>
    leaseWiring?.requester.takeover(String(p?.claudeSessionId ?? '')) ?? { outcome: 'error' });
  ipcMain.handle(IPC.SYNC_SPACES_LEASE_FORCE, (_e, p: { claudeSessionId: string }) =>
    leaseWiring?.requester.force(String(p?.claudeSessionId ?? '')) ?? { ok: false });

  // Device registry (Plan 2b spec §10a): the "Your devices" list (Task 12 UI
  // consumes these). self:true marks the current machine so the UI can label it.
  ipcMain.handle(IPC.SYNC_SPACES_LIST_DEVICES, () => {
    const pr = getManagedRoots()?.personalRoot;
    if (!pr) return [];
    // machineId, not deviceId — rows are keyed per-MACHINE, so the per-install
    // lease id would never match and no row would render "(this device)".
    const selfId = leaseWiring?.machineId ?? '';
    return readDevices(pr).map((d) => ({ ...d, self: !!selfId && d.id === selfId }));
  });
  ipcMain.handle(IPC.SYNC_SPACES_RENAME_DEVICE, async (_e, p: { id: string; name: string }) => {
    const pr = getManagedRoots()?.personalRoot;
    if (!pr) return { ok: false };
    try { await renameDevice(pr, String(p?.id ?? ''), String(p?.name ?? '')); return { ok: true }; }
    catch { return { ok: false }; }
  });
  ipcMain.handle(IPC.SYNC_SPACES_REMOVE_DEVICE, async (_e, p: { id: string }) => {
    const pr = getManagedRoots()?.personalRoot;
    if (!pr) return { ok: false };
    const id = String(p?.id ?? '');
    if (!id) return { ok: false };
    // Refuse to remove THIS machine: upsertSelf re-creates the row on the next
    // launch, so it would read as a no-op that "didn't work". The UI hides the
    // affordance for self; this is the enforcement half (remote clients too).
    if (id === (leaseWiring?.machineId ?? '')) return { ok: false, error: 'cannot remove this device' };
    try { await removeDevice(pr, id); return { ok: true }; }
    catch { return { ok: false }; }
  });

  // Connect-GitHub modal (device-flow auth). ONE orchestrator holds the single
  // in-flight flow; its emitDone fans the connect-done push out to BOTH the
  // Electron windows (send) and remote clients (remoteServer.broadcast) — the
  // same dual path as session:moved. The access token never enters this payload.
  const githubConnect = createGithubConnect((payload) => {
    send(IPC.GITHUB_CONNECT_DONE, payload);
    remoteServer?.broadcast({ type: IPC.GITHUB_CONNECT_DONE, payload });
  });
  // Register as the process-wide singleton so remote clients drive the SAME flow.
  setGithubConnect(githubConnect);
  // Combined status (Phase 2): authed = stored app token OR gh login — a
  // stock machine that connected in-app reads as authed with no gh at all.
  // Keeps the legacy {installed, authed, login} shape (additive fields only).
  ipcMain.handle(IPC.GITHUB_STATUS, () => combinedGithubStatus());
  ipcMain.handle(IPC.GITHUB_CONNECT_START, () => githubConnect.start());
  ipcMain.handle(IPC.GITHUB_CONNECT_CANCEL, () => { githubConnect.cancel(); return { ok: true }; });
  ipcMain.handle(IPC.GITHUB_INSTALL_GH, () => installGh());
  ipcMain.handle(IPC.GITHUB_DISCONNECT, () => disconnectGithub());

  // V2: Per-instance backend management (storage backends + multi-instance support)
  ipcMain.handle('sync:add-backend', (_e, instance) => addBackend(instance));
  ipcMain.handle('sync:remove-backend', (_e, id) => removeBackend(id));
  ipcMain.handle('sync:update-backend', (_e, id, updates) => updateBackend(id, updates));
  ipcMain.handle('sync:push-backend', (_e, id) => pushBackend(id));
  // sync:pull-backend ("Download now") was removed in sync-legacy-demolition.

  // Open a backend's remote location in the default browser/file explorer
  ipcMain.handle('sync:open-folder', async (_e, id: string) => {
    const { shell } = require('electron');
    const config = await getSyncConfig();
    const backend = config.backends.find((b: any) => b.id === id);
    if (!backend) return;

    switch (backend.type) {
      case 'drive': {
        // Deep-link to the actual sync folder on Google Drive by resolving its
        // file ID via rclone, then opening https://drive.google.com/drive/folders/<id>.
        // Falls back to the generic Drive homepage if rclone or the folder lookup fails.
        const rcloneRemote = backend.config?.rcloneRemote || 'gdrive';
        const driveRoot = backend.config?.DRIVE_ROOT || 'Claude';
        const parentPath = `${rcloneRemote}:${driveRoot}/Backup`;
        const targetName = 'personal';
        const fallbackUrl = 'https://drive.google.com';
        try {
          const stdout: string = await new Promise((resolve, reject) => {
            execFile(
              'rclone',
              ['lsjson', parentPath, '--dirs-only'],
              { timeout: 15000 },
              (err, out) => (err ? reject(err) : resolve(String(out || ''))),
            );
          });
          const entries = JSON.parse(stdout) as Array<{ Name: string; ID?: string }>;
          const match = entries.find((e) => e.Name === targetName && e.ID);
          if (match?.ID) {
            shell.openExternal(`https://drive.google.com/drive/folders/${match.ID}`);
          } else {
            shell.openExternal(fallbackUrl);
          }
        } catch {
          shell.openExternal(fallbackUrl);
        }
        break;
      }
      case 'github': {
        const repoUrl = backend.config?.PERSONAL_SYNC_REPO || '';
        if (repoUrl) shell.openExternal(repoUrl);
        break;
      }
      case 'icloud': {
        const icloudPath = backend.config?.ICLOUD_PATH || '';
        if (icloudPath) shell.openPath(icloudPath);
        break;
      }
    }
  });

  // Guided setup wizard: prerequisite detection, tool installation, OAuth, repo creation.
  // Each handler runs one specific command — no generic shell exec.
  ipcMain.handle('sync:setup:check-prereqs', (_e, backend) => checkSyncPrereqs(backend));
  ipcMain.handle('sync:setup:install-rclone', () => installRclone());
  ipcMain.handle('sync:setup:check-gdrive', () => checkGdriveRemote());
  ipcMain.handle('sync:setup:auth-gdrive', () => authGdrive());
  ipcMain.handle('sync:setup:auth-github', () => authGithub());
  ipcMain.handle('sync:setup:create-repo', (_e, repoName) => createGithubRepo(repoName));

  // --- Permission response (blocking hooks + native asks) ---
  // Native asks share the channel; ids are 'native-'-prefixed so routing is
  // exact — try the native broker first, then fall through to hookRelay (which
  // may be absent in native-only sessions).
  ipcMain.handle(IPC.PERMISSION_RESPOND, async (_event, requestId: string, decision: object) => {
    if (nativeHost.respondPermission(requestId, decision as Record<string, unknown>)) return true;
    return hookRelay ? hookRelay.respond(requestId, decision) : false;
  });

  // --- Settings → Development feature handlers (see dev-tools.ts) ---

  ipcMain.handle(IPC.DEV_LOG_TAIL, async (_event, maxLines: number) => {
    // Return the last N lines of the app log, redacted, for the bug-report flow.
    return readLogTail(typeof maxLines === 'number' ? maxLines : 200);
  });

  ipcMain.handle(IPC.DEV_DIAGNOSTICS, async () => {
    // Environment snapshot (git/claude paths, ~/.claude perms, marketplace
    // cache state, network reachability) prepended to the log tail in the
    // bug-report flow. Captures the most common Mac/Linux install-failure
    // signals that the plain log doesn't cover.
    return gatherDiagnostics();
  });

  ipcMain.handle(IPC.DEV_SUMMARIZE_ISSUE, async (_event, args) => {
    // Shell out to claude -p to produce a structured summary; falls back gracefully.
    return summarizeIssue(args);
  });

  ipcMain.handle(IPC.DEV_SUBMIT_ISSUE, async (_event, args) => {
    // Use gh CLI when authed; otherwise return a prefilled GitHub URL for browser fallback.
    return submitIssue(args);
  });

  ipcMain.handle(IPC.DEV_INSTALL_WORKSPACE, async (event) => {
    // Clone (or update) ~/youcoded-dev, stream progress lines back to the renderer,
    // and register the path as a project folder on success.
    const send = (line: string) => {
      event.sender.send(IPC.DEV_INSTALL_PROGRESS, line);
    };
    try {
      const result = await installWorkspace(send);
      // Register the workspace as a known project folder.
      // readFolders / writeFolders / SavedFolder come from the ./saved-folders
      // module imported at the top of this file (no-arg = default store path).
      try {
        const normalized = path.resolve(result.path);
        const folders = readFolders();
        if (!folders.some((f) => path.resolve(f.path) === normalized)) {
          const entry: SavedFolder = {
            path: normalized,
            nickname: path.basename(normalized),
            addedAt: Date.now(),
          };
          folders.unshift(entry);
          writeFolders(folders);
        }
      } catch (e) {
        log('WARN', 'dev', 'folders.add post-install failed', { error: String(e) });
      }
      return result;
    } catch (e: any) {
      return { error: String(e?.message || e) };
    }
  });

  ipcMain.handle(IPC.DEV_OPEN_SESSION_IN, async (_event, args: { cwd: string; initialInput?: string }) => {
    // Delegate to the exported helper so the logic is independently testable.
    return openDevSessionIn(args, { defaultsPrefPath, sessionManager, homedir: os.homedir });
  });

  // --- Artifact viewer IPC handlers ---
  // All request-response handlers plus the CHANGED push event (emitted via
  // webContents.send() inside SAVE and APPEND_VERSION — no ipcMain.handle needed
  // for push events).

  // Fix: data-flow gap — the renderer Tracker calls this when it observes a
  // Write/Edit/MultiEdit transcript event so the central index is populated and
  // artifacts appear in the Session Drawer even before the user opens it.
  // ensureProject and applyGitTreatment are both idempotent.
  //
  // Burst-safe by construction (2026-08-15): opening a long conversation
  // replays ~1,000 of these at once (the tracker cannot tell replayed history
  // from live events — see transcript-watcher's offset-0 read and
  // TRANSCRIPT_REPLAY). The coalesced helpers answer the burst with one index
  // write and one .gitignore read; appendVersion queues per project and applies
  // the whole burst in a few read/write cycles instead of a thousand, each of
  // which used to pin a parsed 4.4 MB sidecar in memory until the app OOM'd.
  ipcMain.handle(ARTIFACT_IPC.APPEND_VERSION, async (
    _e,
    projectRoot: string,
    sessionId: string,
    args: {
      path: string;
      kind: 'internal' | 'external';
      absolutePath: string | null;
      type: 'create' | 'edit' | 'delete' | 'read' | 'delivered';
      author: 'agent' | 'user';
      toolUseId?: string;
    }
  ) => {
    const { project } = await ensureProjectCoalesced(CLAUDE_DIR, projectRoot, sessionId);
    await applyGitTreatmentCoalesced(projectRoot);
    const result = await appendVersion(projectRoot, project.id, project.name, {
      path: args.path,
      kind: args.kind,
      absolutePath: args.absolutePath,
      sessionId,
      type: args.type,
      author: args.author,
      toolUseId: typeof args.toolUseId === 'string' && args.toolUseId ? args.toolUseId : undefined,
    });
    // AFTER the append resolves, not before it (2026-08-15 review): appendVersion
    // is queued now, so an invalidate issued before the call could be followed
    // by a watcher rebuild that read the OLD sidecar — leaving a just-created
    // artifact unmapped until the cache's next TTL. Invalidating once the write
    // has committed closes that window.
    invalidateSidecarIdCache(projectRoot); // watcher path-to-id map is stale
    // A newly created/edited file may also be a discovered doc — drop the cached
    // disk scan so it shows up on the next LIST_PROJECT without waiting for TTL.
    invalidateDiscoveryCache(projectRoot);
    // Broadcast the REAL artifact id so listeners can match it — the previous
    // artifactId: null was dropped by every consumer, which meant the
    // ActiveArtifactView "Claude also edited this file" conflict banner could
    // never fire for agent edits (its entire purpose).
    // A deduped append changed nothing on disk — it is a replayed tool call
    // that was recorded the first time round — so it must not announce an
    // edit: that banner would be a lie about a file nobody just touched.
    if (!result.deduped) {
      webContents.getAllWebContents().forEach((wc) =>
        wc.send(ARTIFACT_IPC.CHANGED, {
          projectRoot,
          artifactId: result.artifactId,
          kind: args.type,
          by: args.author,
        })
      );
    }
    return { ok: result.committed, project };
  });

  ipcMain.handle(ARTIFACT_IPC.RENAME, async (
    _e,
    projectRoot: string,
    artifactId: string,
    newName: string
  ) => {
    const result = await renameArtifact(projectRoot, artifactId, newName);
    invalidateSidecarIdCache(projectRoot); // watcher path-to-id map is stale
    if (result.ok) {
      // Broadcast so every open window's artifact UI re-lists with the new name.
      webContents.getAllWebContents().forEach((wc) =>
        wc.send(ARTIFACT_IPC.CHANGED, { projectRoot, artifactId, kind: 'rename', by: 'user' })
      );
    }
    return result;
  });

  // Remove a tracking RECORD (never the file). See removeArtifactRecord for
  // semantics — Session Drawer per-row remove.
  ipcMain.handle(ARTIFACT_IPC.REMOVE_RECORD, async (
    _e,
    projectRoot: string,
    artifactId: string
  ) => {
    const result = await removeArtifactRecord(projectRoot, artifactId);
    invalidateSidecarIdCache(projectRoot); // watcher path-to-id map is stale
    if (result.ok) {
      webContents.getAllWebContents().forEach((wc) =>
        wc.send(ARTIFACT_IPC.CHANGED, { projectRoot, artifactId, kind: 'remove', by: 'user' })
      );
    }
    return result;
  });

  ipcMain.handle(ARTIFACT_IPC.LIST_SESSION, async (_e, sessionId: string, projectRoot: string) => {
    // Repair legacy relative-external records before listing. The Session
    // Drawer is the only surface where an unpinned external is visible, so this
    // is where the false "no longer on disk" actually renders. Memoized per
    // project per process — this handler also fires after every tracked write.
    const migration = await runSidecarMigration(projectRoot);
    // Fix: every other sidecar writer here calls invalidateSidecarIdCache after
    // committing (see APPEND_VERSION/RENAME/REMOVE_RECORD above) so the
    // watcher's path-to-id map doesn't go stale. runSidecarMigration writes too
    // (it rewrites reclassified records' path/kind) but had no caller doing
    // this. Wiring it from artifact-store.ts would import project-watcher.ts,
    // which already imports artifact-store.ts's readSidecar — a cycle — so it's
    // done here at each of the three call sites instead, and only when a write
    // actually happened.
    if (migration.migrated) invalidateSidecarIdCache(projectRoot);
    const sidecar = await readSidecarShared(projectRoot);
    if (!sidecar || 'corrupted' in sidecar) return { ok: true, artifacts: [] };
    // Filter to artifacts touched by this session
    const result = sidecar.artifacts.filter((a) =>
      a.versions.some((v) => v.sessionId === sessionId)
    );
    return { ok: true, artifacts: result };
  });

  // Project View IPC — list project-scoped conversations, their history, git
  // repo info, and the discovered context files (CLAUDE.md, rules, etc.).
  // Main-process modules already exist; these handlers just wire them to IPC.
  ipcMain.handle(PROJECT_IPC.LIST_CONVERSATIONS, async (_e, projectPath: string) => {
    return { ok: true, conversations: await listProjectConversations(projectPath) };
  });
  ipcMain.handle(PROJECT_IPC.CONVERSATION_HISTORY, async (_e, projectPath: string, sessionId: string, count: number, all: boolean) => {
    return { ok: true, messages: await projectConversationHistory(projectPath, sessionId, count ?? 20, !!all) };
  });
  ipcMain.handle(PROJECT_IPC.REPO_INFO, async (_e, projectPath: string) => {
    return { ok: true, ...(await getRepoInfo(projectPath)) };
  });
  ipcMain.handle(PROJECT_IPC.LIST_CONTEXT, async (_e, projectPath: string) => {
    return { ok: true, groups: await listContext(projectPath) };
  });
  ipcMain.handle(PROJECT_IPC.READ_CONTEXT_FILE, async (_e, projectPath: string, absolutePath: string) => {
    return readContextFile(projectPath, absolutePath);
  });
  ipcMain.handle(PROJECT_IPC.WRITE_CONTEXT_FILE, async (_e, projectPath: string, absolutePath: string, content: string) => {
    return writeContextFile(projectPath, absolutePath, content);
  });

  // Session references (spec 2026-08-10): resolve the chatsearch short ids a
  // search printed against the index the app writes, and read bounded
  // transcript slices by id. Both go through refs-service so this handler and
  // the remote WebSocket case cannot assemble paths differently.
  ipcMain.handle(CHATSEARCH_IPC.RESOLVE, async (_e, shortIds: string[]) => resolveConversations(shortIds));
  ipcMain.handle(CHATSEARCH_IPC.READ, async (_e, req: ChatsearchReadRequest) => readConversation(req));

  // Project counting/discovery helpers moved to ./artifacts/projects-index so
  // the remote WebSocket server can compute the IDENTICAL result. They used to
  // be closures here, which is why remote browsers' Project View was empty:
  // remote-server.ts had no artifacts:list-projects-index handler and could not
  // have written one without duplicating all of this. See that module for the
  // full doc comments on what each count means.

  // LIST_PROJECT → TRACKED SIDECAR ARTIFACTS ONLY. No on-disk discovery is merged
  // in — that is LIST_ALL_FILES's job.
  //
  // What comes back is whatever trackedArtifacts() admits (visible-artifacts.ts
  // owns the rules): internal records with at least one non-read version, plus
  // anything legacy-pinned in manualIncludes, minus anything in manualExcludes.
  // EXTERNAL records need a pin — Project View briefly showed unpinned externals
  // in an "External Artifacts" section (2026-07-23) but it was removed the same
  // day (~95% incidental noise against real sidecars), and the pin requirement
  // reverted with it. Consumers now: FilepathToken (resolve a pill to an
  // artifact) and the withCount path (the hero/switcher count). No Project View
  // section reads this any more.
  //
  // Deleted records (tombstones) ARE returned — not because anything here wants
  // them, but because trackedArtifacts() does not filter on `status`. The
  // session drawer's "Show deleted" toggle reads a DIFFERENT handler
  // (LIST_SESSION), which returns tombstones on its own — do not assume the
  // drawer depends on this one. Callers that don't want tombstones must filter.
  //
  // visibleCount (withCount) is a separate, independently-computed count from
  // countArtifacts — non-deleted and on-disk — shared with the hero + switcher.
  ipcMain.handle(ARTIFACT_IPC.LIST_PROJECT, async (_e, projectId: string, opts?: { withCount?: boolean }) => {
    const projects = await listProjects(CLAUDE_DIR);
    const p = projects.find((x) => x.id === projectId);
    // Synth (saved-folder) projects use their canonical PATH as id and have no
    // index entry — fall back to reading the sidecar at that path so their
    // artifacts resolve too. A bogus id simply yields no sidecar.
    const projectRoot = p ? p.path : projectId;
    // Same legacy-repair call as LIST_SESSION above (filepath pills + the
    // hero/switcher count also read through this handler) — memoized per
    // project per process, so this costs one Set lookup after the first call.
    const migration = await runSidecarMigration(projectRoot);
    if (migration.migrated) invalidateSidecarIdCache(projectRoot); // see LIST_SESSION's WHY
    const sidecar = await readSidecarShared(projectRoot);

    let tracked: any[] = [];
    if (sidecar && !('corrupted' in sidecar)) {
      // Shared predicate — see visible-artifacts.ts for the full rules.
      tracked = trackedArtifacts(sidecar.artifacts as any[], sidecar.manualIncludes, sidecar.manualExcludes, projectRoot);
    }

    const visibleCount = opts?.withCount ? await countArtifacts(projectRoot) : undefined;
    return {
      ok: true,
      artifacts: tracked,
      ...(visibleCount !== undefined ? { visibleCount } : {}),
    };
  });

  // LIST_ALL_FILES → the Project Files section. The project folder as it exists on
  // disk: bounded, deterministic discovery (stops at nested git repos), cached.
  //
  // NOT pure discovery, despite what this comment said until 2026-07-23 — the
  // callee projectAllFiles() UNIONS in any tracked INTERNAL artifact that exists on
  // disk but discovery did not reach (e.g. one inside a skipped nested sub-repo).
  // That union is load-bearing: it guarantees this list is a superset of the
  // in-folder tracked files, so a code-heavy project cannot report fewer files than
  // artifacts. Externals are NEVER unioned, which is exactly why they need their
  // own section in the UI.
  // Gated roots (home dir / drive root) return { gated: true } with no scan
  // unless opts.force — the tab renders a "Browse anyway?" gate (see
  // isGatedRoot above for WHY).
  ipcMain.handle(ARTIFACT_IPC.LIST_ALL_FILES, async (_e, projectId: string, opts?: { force?: boolean }) => {
    const projects = await listProjects(CLAUDE_DIR);
    const p = projects.find((x) => x.id === projectId);
    const projectRoot = p ? p.path : projectId;
    if (isGatedRoot(projectRoot) && !opts?.force) {
      return { ok: true, files: [], truncated: false, gated: true };
    }
    // Fix: this repair call used to run BEFORE the gated-root check above,
    // so a gated root (home dir / drive root) could have its sidecar read
    // and rewritten on a listing the user never confirmed via "Browse
    // anyway?". Moved below the early return so the repair only touches a
    // gated root once the user has actually agreed to browse it. Same
    // legacy-repair call as LIST_SESSION above. Memoized per project per
    // process.
    const migration = await runSidecarMigration(projectRoot);
    if (migration.migrated) invalidateSidecarIdCache(projectRoot); // see LIST_SESSION's WHY
    const r = await projectAllFiles(projectRoot);
    return { ok: true, files: r.files, truncated: r.truncated };
  });

  ipcMain.handle(ARTIFACT_IPC.GET, async (
    _e, projectRoot: string, artifactId: string,
    // full: the user clicked "Load the whole file" on the partial-view bar. Still
    // refused above FULL_READ_MAX_BYTES — the flag opts into a BIGGER read, not an
    // unbounded one.
    opts?: { full?: boolean },
  ) => {
    const sidecar = await readSidecarShared(projectRoot);
    const artifact = (sidecar && !('corrupted' in sidecar))
      ? sidecar.artifacts.find((a) => a.id === artifactId)
      : undefined;

    let fullPath: string;
    if (artifact) {
      fullPath = artifact.kind === 'internal'
        ? path.join(projectRoot, artifact.path)
        : artifact.absolutePath!;
    } else {
      // Discovered (on-disk) file: the id IS a canonical relative path. Resolve
      // it inside the project root and refuse anything that escapes (traversal
      // guard) so this can't be used to read arbitrary files.
      const resolved = path.resolve(projectRoot, artifactId);
      const root = path.resolve(projectRoot);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        return { ok: false, error: 'artifact-not-found' };
      }
      fullPath = resolved;
    }

    // Symlink-resolve + in-root + sensitive-read policy, all on the RESOLVED
    // path (write-authorization.ts owns the logic + its tests). Tracked
    // internals were never traversal-checked before (spec §12.1) — now they are.
    const readAuth = await authorizeArtifactRead(projectRoot, fullPath, !artifact || artifact.kind === 'internal');
    if (!readAuth.ok) {
      if ('orphan' in readAuth) return { ok: true, artifact: artifact ?? null, content: null, orphan: true };
      return { ok: false, error: readAuth.error };
    }
    const realPath = readAuth.realPath;

    // Size gate BEFORE reading (spec §2.3): a multi-MB readFile blocks the main
    // thread, ships whole over IPC/WS, then blocks the renderer rendering it.
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(realPath);
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      return { ok: true, artifact: artifact ?? null, content: null, orphan: true };
    }
    // Over the cap we no longer refuse blind. Sniff the head first: an over-cap
    // IMAGE used to get the TEXT editor's error message, which is the bug this
    // whole workstream exists to fix. Text comes back as a readable prefix.
    const wantsFull = opts?.full === true && st.size <= FULL_READ_MAX_BYTES;
    if (st.size > EDIT_MAX_BYTES && !wantsFull) {
      const fh = await fs.promises.open(realPath, 'r');
      try {
        // fs.read is only contractually required to return SOME bytes, not to
        // fill the buffer — so loop until the window is full or the file ends.
        const readFully = async (len: number) => {
          const buf = Buffer.allocUnsafe(len);
          let off = 0;
          while (off < len) {
            const { bytesRead } = await fh.read(buf, off, len - off, off);
            if (bytesRead === 0) break;
            off += bytesRead;
          }
          return buf.subarray(0, off);
        };
        // Head first, so a file that turns out to be binary is decided on 8 KB.
        const head = await readFully(8192);
        const win = await readFully(EDIT_MAX_BYTES);
        const d = decideOverCapRead(head, win);
        return {
          ok: true, artifact: artifact ?? null, orphan: false,
          content: d.content, binary: d.binary, truncated: d.truncated,
          sizeBytes: st.size, mtimeMs: st.mtimeMs,
        };
      } finally {
        await fh.close();
      }
    }

    let content: string | null = null;
    let binary = false;
    try {
      const buf = await fs.promises.readFile(realPath);
      // Head-slice NUL sniff: binary bytes decoded as utf8 turn into U+FFFD
      // soup — return binary:true + null content so the renderer routes to the
      // binary fallback instead of a garbage text view (D4 routing).
      binary = looksBinary(buf.subarray(0, 8192));
      if (!binary) content = buf.toString('utf8');
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      return { ok: true, artifact: artifact ?? null, content: null, orphan: true };
    }
    // mtimeMs is the optimistic-concurrency token: round-trip it into
    // artifacts:save as baseMtimeMs and the save is rejected when the file
    // changed underneath (spec §12.9 — last-write-wins fix).
    // sizeBytes and truncated ride EVERY response: the renderer derives
    // editability from the size, and a `full` read must clear the partial bar.
    return { ok: true, artifact: artifact ?? null, content, orphan: false, binary,
             truncated: false, sizeBytes: st.size, mtimeMs: st.mtimeMs };
  });

  // Read a file as base64 for the binary viewers (xlsx/docx/pdf/image). The
  // renderer can't fetch a file:// URL from the http(dev)/app(prod) origin, so
  // bytes come through IPC.
  //
  // SECURITY: unlike openPath (which only launches a local app and returns
  // nothing), this IPC RETURNS file contents — and on remote-access setups it is
  // reachable over the WebSocket from a remote browser. So reads are restricted
  // to (a) the user's known project roots (saved folders + central-index
  // projects) and (b) tracked external artifact paths (temp-dir files the
  // session drawer legitimately shows), with well-known secret locations
  // (.ssh, .netrc, .credentials.json, …) refused even inside those roots.
  // Pure decision logic + tests live in artifacts/read-binary-access.ts.
  ipcMain.handle(ARTIFACT_IPC.READ_BINARY, async (_e, absolutePath: string) => {
    if (typeof absolutePath !== 'string' || absolutePath.length === 0) {
      return { ok: false, error: 'no path' };
    }
    try {
      const canon = canonicalize(absolutePath, null);
      // Known roots: saved folders (the session-creation picker) + every
      // central-index project path.
      const roots = [
        ...readFolders().map((f) => canonicalize(f.path, null)),
        ...(await listProjects(CLAUDE_DIR)).map((p) => canonicalize(p.path, null)),
      ];
      let verdict = evaluateBinaryRead(canon, roots, new Set());
      if (verdict === 'outside-roots') {
        // Second pass (rare): collect tracked EXTERNAL artifact paths + manual
        // includes from each root's sidecar — covers e.g. a temp-dir xlsx.
        const tracked = new Set<string>();
        for (const root of roots) {
          const sidecar = await readSidecarShared(root).catch(() => null);
          if (!sidecar || 'corrupted' in sidecar) continue;
          for (const a of sidecar.artifacts) {
            if (a.kind === 'external' && a.absolutePath) tracked.add(canonicalize(a.absolutePath, null));
          }
          for (const inc of sidecar.manualIncludes) tracked.add(canonicalize(inc.path, null));
        }
        verdict = evaluateBinaryRead(canon, roots, tracked);
      }
      if (verdict !== 'allowed') return { ok: false, error: 'not-allowed' };

      // Size gate before reading — a huge file would freeze the renderer (and
      // the WS transport) long before the viewer could reject it.
      const st = await fs.promises.stat(absolutePath);
      if (st.size > READ_BINARY_MAX_BYTES) return { ok: false, error: 'too-large' };

      const buf = await fs.promises.readFile(absolutePath);
      return { ok: true, base64: buf.toString('base64') };
    } catch (e: any) {
      return { ok: false, error: e?.code === 'ENOENT' ? 'orphan' : String(e?.message ?? e) };
    }
  });

  // First bytes of a user-chosen file, for the composer's attachment cards
  // (rendered markdown / mono text preview). The cap, the deny list and the
  // reasoning for NOT roots-gating it live in main/fs-read-head.ts +
  // shared/read-head.ts; remote-server.ts calls the same function.
  ipcMain.handle(IPC.FS_READ_HEAD, (_e, filePath: string, maxBytes?: number) =>
    readFileHead(filePath, maxBytes));

  ipcMain.handle(ARTIFACT_IPC.SAVE, async (
    _e,
    projectRoot: string,
    projectId: string,
    projectName: string,
    artifactId: string,
    newContent: string,
    sessionId: string,
    // baseMtimeMs: optimistic-concurrency token from artifacts:get — the save is
    // rejected ('conflict') when the file changed underneath (spec §12.9).
    // confirmed: the user clicked through the confirm-tier dialog; main REQUIRES
    // it for needs-confirm paths so the policy decision cannot be skipped by a
    // caller that never showed the dialog (D5 — mistake-prevention tier).
    opts?: { baseMtimeMs?: number; confirmed?: boolean }
  ) => {
    const sidecar = await readSidecarShared(projectRoot);
    const artifact = (sidecar && !('corrupted' in sidecar))
      ? sidecar.artifacts.find((a) => a.id === artifactId)
      : undefined;

    let fullPath: string;
    if (artifact) {
      // NOTE the tracked branch historically wrote artifact.absolutePath! with
      // NO check at all — the sidecar-escalation hole (spec §12.1). Everything
      // below now runs on the RESOLVED path for both branches.
      fullPath = artifact.kind === 'internal'
        ? path.join(projectRoot, artifact.path)
        : artifact.absolutePath!;
    } else {
      // Discovered (on-disk) file: the id IS a canonical relative path. Fast
      // string-level traversal reject before touching the filesystem.
      const resolved = path.resolve(projectRoot, artifactId);
      const root = path.resolve(projectRoot);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        return { ok: false, error: 'artifact-not-found' };
      }
      fullPath = resolved;
    }

    // Symlink resolution → in-root enforcement → D5 tier policy → concurrency
    // token, all on the RESOLVED path (write-authorization.ts owns the logic +
    // its tests — this is the feature's security boundary, keep it pinned).
    const auth = await authorizeArtifactWrite({
      projectRoot,
      fullPath,
      mustStayInRoot: !artifact || artifact.kind === 'internal',
      baseMtimeMs: opts?.baseMtimeMs,
      confirmed: opts?.confirmed,
    });
    if (!auth.ok) return auth;
    const realPath = auth.realPath;

    // Suppress the watcher echo of our own write (spec §8.4), then atomic
    // write: .tmp + rename so the original is never half-written.
    // pid+time-suffixed temp name: two processes (dev + built app) writing the
    // same file must not race the same .tmp — the loser's rename would ENOENT.
    // These tmp files land in the USER'S project tree, so sweep crash orphans
    // for this file first and unlink our own tmp on failure — a pid+time name
    // is never overwritten by the next write, so a strand would linger forever
    // (git status noise, visible in the Files UI).
    noteOwnWrite(realPath);
    await sweepStaleTmp(path.dirname(realPath), path.basename(realPath));
    const tmpPath = `${realPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.promises.writeFile(tmpPath, newContent, 'utf8');
      await fs.promises.rename(tmpPath, realPath);
    } catch (e) {
      try { await fs.promises.unlink(tmpPath); } catch { /* already gone */ }
      throw e;
    }
    const st = await fs.promises.stat(realPath).catch(() => null);

    if (artifact) {
      invalidateSidecarIdCache(projectRoot);
      await appendVersion(projectRoot, projectId, projectName, {
        path: artifact.path,
        kind: artifact.kind,
        absolutePath: artifact.absolutePath,
        sessionId,
        type: 'edit',
        author: 'user',
      });
    } else {
      // NO sidecar mutation for discovered files, so editing a doc never
      // silently creates a .youcoded/ tracking dir.
      invalidateDiscoveryCache(projectRoot); // refresh the cached mtime next scan
    }
    // Broadcast the change to every renderer so all open windows update their artifact UI
    webContents.getAllWebContents().forEach((wc) =>
      wc.send(ARTIFACT_IPC.CHANGED, { projectRoot, artifactId, kind: 'edit', by: 'user' })
    );
    // Fresh token so the editor can keep saving without a refetch round-trip.
    return { ok: true, mtimeMs: st?.mtimeMs };
  });

  // ── External-change watcher (spec §8) ──
  // Watchers live in main, refcounted per webContents (project-watcher.ts owns
  // the lifecycle). Events reuse the existing CHANGED broadcast contract with
  // by:'external' — the renderer filters on projectRoot exactly like user events.
  initProjectWatchers((evt) => {
    // Created/deleted files must show up in the next file-list fetch.
    if (evt.kind !== 'edit') invalidateDiscoveryCache(evt.projectRoot);
    webContents.getAllWebContents().forEach((wc) => wc.send(ARTIFACT_IPC.CHANGED, evt));
  });
  // A crashed/closed renderer never sends unwatch — drop its refs on destroy so
  // it cannot pin a watcher forever. One listener per webContents, attached on
  // its first subscribe.
  const watchedSenders = new Set<number>();
  ipcMain.handle(ARTIFACT_IPC.WATCH_PROJECT, async (e, projectRoot: string) => {
    if (typeof projectRoot !== 'string' || projectRoot.length === 0) return { ok: false };
    const senderId = e.sender.id;
    if (!watchedSenders.has(senderId)) {
      watchedSenders.add(senderId);
      e.sender.once('destroyed', () => {
        watchedSenders.delete(senderId);
        dropSubscriber(senderId);
      });
    }
    return watchProject(projectRoot, senderId);
  });
  ipcMain.handle(ARTIFACT_IPC.UNWATCH_PROJECT, async (e, projectRoot: string) => {
    if (typeof projectRoot !== 'string' || projectRoot.length === 0) return { ok: false };
    unwatchProject(projectRoot, e.sender.id);
    return { ok: true };
  });

  // ── Git surface (spec docs/archive/specs/2026-07-22-git-surface.md) ──
  // Known-roots gate: a git operation may only target a saved folder or an
  // indexed project root — same allow-list the read-binary guard builds.
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
  const broadcastGitChanged = (repoRoot: string) => {
    // Commits and checkouts can create or retarget repos — drop the cache so
    // the next footer query re-resolves.
    invalidateRepoRootCache();
    webContents.getAllWebContents().forEach((wc) => wc.send(GIT_IPC.CHANGED, { repoRoot }));
  };

  initGitWatchers((evt) => broadcastGitChanged(evt.repoRoot));

  ipcMain.handle(GIT_IPC.FILE_STATUS, (_e, projectRoot: string, relPath: string) =>
    gitGate(projectRoot, { ok: false, error: 'unknown-project-root', isRepo: false, branch: null, counts: null, hasHistory: false, staged: false, conflicted: false },
      () => gitFileStatus(projectRoot, relPath)));

  ipcMain.handle(GIT_IPC.FILE_REVIEW, (_e, projectRoot: string, relPath: string, opts?: { logSkip?: number }) =>
    gitGate(projectRoot, { ok: false, error: 'unknown-project-root', isRepo: false, branch: null, uncommitted: null, log: [], hasMore: false, stagedCount: 0 },
      () => gitFileReview(projectRoot, relPath, opts)));

  ipcMain.handle(GIT_IPC.COMMIT_FILE_DIFF, (_e, projectRoot: string, sha: string, relPath: string, prevPath?: string) =>
    gitGate(projectRoot, { ok: false, error: 'unknown-project-root', hunks: [], binary: false },
      () => gitCommitFileDiff(projectRoot, sha, relPath, prevPath)));

  const mutating = async (projectRoot: string, run: () => Promise<{ ok: boolean; error?: string }>) =>
    gitGate(projectRoot, { ok: false, error: 'unknown-project-root' }, async () => {
      const result = await run();
      if (result.ok) {
        const repoRoot = await resolveRepoRoot(projectRoot);
        if (repoRoot) broadcastGitChanged(repoRoot);
      }
      return result;
    });

  ipcMain.handle(GIT_IPC.STAGE, (_e, projectRoot: string, relPath: string) =>
    mutating(projectRoot, () => gitStage(projectRoot, relPath)));
  ipcMain.handle(GIT_IPC.UNSTAGE, (_e, projectRoot: string, relPath: string) =>
    mutating(projectRoot, () => gitUnstage(projectRoot, relPath)));
  ipcMain.handle(GIT_IPC.COMMIT, (_e, projectRoot: string, message: string) =>
    mutating(projectRoot, () => gitCommit(projectRoot, message)));
  ipcMain.handle(GIT_IPC.DISCARD, (_e, projectRoot: string, relPath: string) =>
    mutating(projectRoot, () => gitDiscard(projectRoot, relPath)));

  const gitWatchedSenders = new Set<number>();
  ipcMain.handle(GIT_IPC.WATCH, (e, projectRoot: string) =>
    gitGate(projectRoot, { ok: false }, async () => {
      const repoRoot = await resolveRepoRoot(projectRoot);
      if (!repoRoot) return { ok: false };
      const senderId = e.sender.id;
      if (!gitWatchedSenders.has(senderId)) {
        gitWatchedSenders.add(senderId);
        e.sender.once('destroyed', () => { gitWatchedSenders.delete(senderId); dropGitSubscriber(senderId); });
      }
      return watchGit(repoRoot, senderId);
    }));
  // Gated like every other git channel — unwatch shells rev-parse, and the
  // known-roots gate should be uniform even for read-only paths.
  ipcMain.handle(GIT_IPC.UNWATCH, (e, projectRoot: string) =>
    gitGate(projectRoot, { ok: false }, async () => {
      const repoRoot = await resolveRepoRoot(projectRoot);
      if (repoRoot) unwatchGit(repoRoot, e.sender.id);
      return { ok: true };
    }));

  ipcMain.handle(ARTIFACT_IPC.SEARCH_CONTENT, async (_e, projectRoot: string, query: string) => {
    if (typeof projectRoot !== 'string' || projectRoot.length === 0 || typeof query !== 'string') {
      return { ok: false, hits: [], truncated: false, error: 'projectRoot and query are required' };
    }
    return searchProjectContent(projectRoot, query);
  });

  // Normalize an include/exclude entry to a canonical ABSOLUTE path. FilesTab
  // passes a relative path for internal artifacts and an absolute one for
  // externals; storing one uniform shape keeps trackedArtifacts' comparisons
  // trivial.
  const toCanonicalAbs = (projectRoot: string, p: string): string => {
    const fwd = p.replace(/\\/g, '/');
    const isAbs = /^[a-zA-Z]:\//.test(fwd) || fwd.startsWith('/');
    return canonicalize(isAbs ? fwd : `${projectRoot.replace(/\\/g, '/')}/${fwd}`, null);
  };

  // IMPORT_FILE → copy/move a picked file into the project. All policy lives in
  // artifacts/import-file.ts (traversal, self-import, collisions, temp+rename,
  // verify-before-unlink). disclosedCollisions is the list of colliding
  // basenames the renderer's dialog actually NAMED to the user — forwarded so
  // 'replace' can only overwrite files the user was shown (see that module).
  ipcMain.handle(ARTIFACT_IPC.IMPORT_FILE, async (
    _e,
    projectRoot: string,
    sourcePath: string,
    destDir: string,
    opts: {
      mode: 'move' | 'copy';
      onCollision: 'replace' | 'keep-both' | 'skip';
      disclosedCollisions?: string[];
    },
  ) => importFile({
    projectRoot, sourcePath, destDir,
    mode: opts.mode,
    onCollision: opts.onCollision,
    disclosedCollisions: opts.disclosedCollisions,
  }));

  // INCLUDE_EXTERNAL = PIN a file into the tracked set (any kind — a file
  // outside the project folder, or an in-project file Claude never edited).
  // Writes a manualIncludes entry, which trackedArtifacts treats as rule 1:
  // visible regardless of whether the file has any Claude work on it.
  //
  // NOTHING IN THE APP CALLS THIS TODAY. It used to be "+ Add file", but on
  // 2026-07-23 that button became a real Move/Copy import (ARTIFACT_IPC.
  // IMPORT_FILE) and stopped writing pins — so this is no longer the recovery
  // path for a mistaken Exclude, and Exclude currently has no in-app undo (the
  // Exclude button says so). The handler and the manualIncludes rule stay
  // because existing sidecars still carry pins written by the old flow, and
  // dropping the channel would break the pinned IPC surface. Three steps:
  //   1. Ensure an artifact RECORD exists (appendVersion dedups by path+kind and
  //      creates the sidecar if missing) — a pin with no record would show
  //      nothing, which was a real bug on fresh projects.
  //   2. Add to manualIncludes (idempotent).
  //   3. Remove from manualExcludes (includes also win over excludes in
  //      trackedArtifacts, so this is belt-and-suspenders).
  ipcMain.handle(ARTIFACT_IPC.INCLUDE_EXTERNAL, async (
    _e, projectRoot: string, absolutePath: string
  ) => {
    const canonical = toCanonicalAbs(projectRoot, absolutePath);
    const rootCanon = canonicalize(projectRoot, null);
    const isInternal = canonical === rootCanon || canonical.startsWith(rootCanon + '/');

    // 1. Ensure a record exists (author 'user', type 'read' — a pin, not an edit).
    const { project } = await ensureProject(CLAUDE_DIR, projectRoot, 'manual-include');
    invalidateSidecarIdCache(projectRoot); // watcher path-to-id map is stale
    const appendResult = await appendVersion(projectRoot, project.id, project.name, {
      path: isInternal ? canonical.slice(rootCanon.length + 1) : (canonical.split('/').pop() ?? canonical),
      kind: isInternal ? 'internal' : 'external',
      absolutePath: isInternal ? null : canonical,
      sessionId: 'manual-include',
      type: 'read',
      author: 'user',
    });

    // 2 + 3. Pin it and clear any standing exclude (CAS-retried).
    for (let attempt = 0; attempt < 5; attempt++) {
      const sidecar = await readSidecar(projectRoot);
      if (!sidecar || 'corrupted' in sidecar) return { ok: false, error: 'sidecar-missing' };
      const originalUpdatedAt = sidecar.updatedAt;
      const alreadyIncluded = sidecar.manualIncludes.some((i) => i.path === canonical);
      const hadExclude = sidecar.manualExcludes.includes(canonical);
      if (alreadyIncluded && !hadExclude) break; // nothing to change
      if (!alreadyIncluded) {
        sidecar.manualIncludes.push({ path: canonical, addedAt: new Date().toISOString(), addedBy: 'user' });
      }
      sidecar.manualExcludes = sidecar.manualExcludes.filter((p) => p !== canonical);
      sidecar.updatedAt = new Date().toISOString();
      const w = await writeSidecar(projectRoot, originalUpdatedAt, sidecar);
      if (w.committed) break;
    }
    webContents.getAllWebContents().forEach((wc) =>
      wc.send(ARTIFACT_IPC.CHANGED, { projectRoot, artifactId: appendResult.artifactId, kind: 'include', by: 'user' })
    );
    return { ok: true };
  });

  // Exclude = un-pin an external artifact (remove from manualIncludes) AND add a
  // sticky manualExcludes entry so trackedArtifacts() keeps hiding it even if
  // Claude re-edits the file. Never touches the file on disk or the session
  // drawer's activity log.
  //
  // NO RENDERER CALLER as of 2026-07-23. The Project View button that invoked
  // this was removed when the External Artifacts section was reverted (~95%
  // incidental noise against real sidecars). The handler stays because legacy
  // sidecars carry manualExcludes entries that must keep round-tripping, and
  // because manualExcludes is still load-bearing in trackedArtifacts() rule 2.
  // If a future feature re-introduces a caller: it is one-way (nothing writes
  // manualIncludes any more, so there is no in-app un-exclude), and it only ever
  // made sense for externals — an in-folder file cannot be hidden from a live
  // disk walk without lying about the folder's contents.
  ipcMain.handle(ARTIFACT_IPC.EXCLUDE, async (
    _e, projectRoot: string, canonicalPath: string
  ) => {
    const canonical = toCanonicalAbs(projectRoot, canonicalPath);
    for (let attempt = 0; attempt < 5; attempt++) {
      const sidecar = await readSidecar(projectRoot);
      if (!sidecar || 'corrupted' in sidecar) return { ok: false, error: 'sidecar-missing' };
      const originalUpdatedAt = sidecar.updatedAt;
      sidecar.manualIncludes = sidecar.manualIncludes.filter((i) => i.path !== canonical);
      if (!sidecar.manualExcludes.includes(canonical)) sidecar.manualExcludes.push(canonical);
      sidecar.updatedAt = new Date().toISOString();
      const w = await writeSidecar(projectRoot, originalUpdatedAt, sidecar);
      if (w.committed) break;
    }
    webContents.getAllWebContents().forEach((wc) =>
      wc.send(ARTIFACT_IPC.CHANGED, { projectRoot, artifactId: null, kind: 'exclude', by: 'user' })
    );
    return { ok: true };
  });

  // Returns the Project View project list — the user's SAVED FOLDERS (the same
  // list the session-creation folder picker shows), reconciled with the central
  // index for artifact ids + stats. WHY saved folders rather than the raw index:
  // the index only gains an entry once Claude writes a tracked artifact in a
  // folder, so folders the user works in (conversations / reads only, or
  // pre-artifact-viewer) were invisible. The picker list is the user's own
  // source of truth and needs no Claude Code ~/.claude/projects dependency.
  // Thin wrapper — the computation lives in ./artifacts/projects-index so the
  // remote WebSocket server returns byte-identical results (remote Project View
  // was empty because that transport had no handler at all).
  ipcMain.handle(ARTIFACT_IPC.LIST_PROJECTS_INDEX, async (_e, opts?: { withCounts?: boolean }) =>
    listProjectsIndex(opts)
  );

  // Task 7.3: remove a project from the central index. The project folder and
  // its files are NOT deleted — only the YouCoded tracking record is removed.
  // When deleteSidecar is true, also removes .youcoded/artifacts.json from the
  // project folder so artifact history starts fresh on next session.
  ipcMain.handle(ARTIFACT_IPC.DELETE_PROJECT, async (
    _e, projectId: string, deleteSidecar: boolean
  ) => {
    const projects = await listProjects(CLAUDE_DIR);
    const p = projects.find((x) => x.id === projectId);
    if (!p) return { ok: false, error: 'project-not-found' };
    await removeProject(CLAUDE_DIR, projectId);
    if (deleteSidecar) {
      const sidecarPath = path.join(p.path, '.youcoded', 'artifacts.json');
      try {
        await fs.promises.unlink(sidecarPath);
      } catch {
        // Ignore ENOENT — sidecar may already be absent
      }
    }
    return { ok: true };
  });

  // Batch-check whether each requested artifact's resolved path still exists on
  // disk. Used by SessionDrawer + ProjectView to mark "file not on disk"
  // artifacts as deleted in the UI without mutating the sidecar. Internal
  // artifacts resolve to projectRoot/path; external artifacts resolve to
  // absolutePath. Parallel fs.access keeps this cheap even for hundreds of IDs.
  ipcMain.handle(ARTIFACT_IPC.CHECK_EXISTENCE, async (
    _e, projectRoot: string, artifactIds: string[]
  ) => {
    if (!projectRoot || !Array.isArray(artifactIds) || artifactIds.length === 0) {
      return { ok: true, missingIds: [] };
    }
    const sidecar = await readSidecarShared(projectRoot);
    if (!sidecar || 'corrupted' in sidecar) return { ok: true, missingIds: [] };
    const byId = new Map(sidecar.artifacts.map((a) => [a.id, a]));
    const results = await Promise.all(
      artifactIds.map(async (id) => {
        const a = byId.get(id);
        if (!a) return id; // unknown id treated as missing
        // A corrupt record (relative absolutePath) resolves against the PROCESS
        // cwd here, which cuts both ways: it reports an in-project file as
        // missing (the Session Drawer's "no longer on disk" — this handler feeds
        // that label, SessionDrawer.tsx:42) AND would report an artifact as
        // present if a same-named file happens to sit in the process cwd.
        const fullPath = a.kind === 'internal'
          ? path.join(projectRoot, a.path)
          : a.absolutePath;
        if (!fullPath) return id;
        if (a.kind !== 'internal' && !isAbsoluteRecorded(fullPath)) return id;
        try {
          await fs.promises.access(fullPath);
          return null;
        } catch {
          return id;
        }
      })
    );
    return { ok: true, missingIds: results.filter((x): x is string => x !== null) };
  });

  // Return shape (Sign in with ChatGPT, backend design 2026-09-05 §5 / review
  // R3-2): `cleanup` for app shutdown — it returns the engine-stop promise so
  // main's quit handler can AWAIT the llama-server teardown before app.quit()
  // (the old fire-and-forget `void` let quit win the race and orphaned the
  // engine, which kept the port bound for the next instance to wrongly adopt) —
  // plus `hasUsableProvider`, which main.ts's launch-time auth check reads
  // BEFORE spawning `claude auth status`. WHY: this branch removes the wizard's
  // Skip link, so an install running on an OpenRouter key (or any ready native
  // provider) with no Claude login would otherwise be locked at a sign-in
  // screen on its first launch after upgrading. "Usable" = any `ready` row in
  // the registry, which for the ChatGPT row means signed in — but main.ts also
  // asks chatgptAuth.isSignedIn() directly, so the kill switch (no row) cannot
  // lock a ChatGPT-only install out either.
  const hasUsableProvider = async (): Promise<boolean> => {
    try { return (await providerRegistry.list()).some((p) => p.ready); }
    catch { return false; }
  };
  const cleanup = function cleanup(): Promise<void> {
    stopThemeWatcher();
    clearInterval(statusInterval);
    transcriptWatcher.stopAll();
    // Flush + tear down every live native session on quit (best-effort, bounded
    // to one in-flight streaming part). Fire-and-forget with .catch — cleanup()
    // is synchronous and callers don't await it, so this mirrors the async
    // stopSyncSpaces() teardown pattern in main.ts window-all-closed.
    void nativeHost.destroyAll().catch(() => {});
    // Awaited by the caller: never leave an orphaned llama-server on quit.
    const engineStopped = engineManager.stopAll().catch(() => {});
    for (const watcher of topicWatchers.values()) {
      if (typeof (watcher as fs.FSWatcher).close === 'function') {
        (watcher as fs.FSWatcher).close();
      } else {
        clearInterval(watcher as NodeJS.Timeout);
      }
    }
    topicWatchers.clear();
    lastTopics.clear();
    sessionIdMap.clear();
    return engineStopped;
  };
  return { cleanup, hasUsableProvider };
}
