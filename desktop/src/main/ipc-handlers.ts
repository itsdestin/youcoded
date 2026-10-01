import { app, IpcMain, BrowserWindow, powerSaveBlocker, webContents } from 'electron';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { resolveNoFolderCwd } from './no-folder';
import { randomUUID } from 'crypto';
import { buildClaudeCodeContext, readWholeContextFile } from './claude-code-context';
import https from 'https';
import { execFile } from 'child_process';
import { SessionManager } from './session-manager';
import { wireDocCommentsSessionLifecycle } from './doc-comments/session-lifecycle';
import { shouldReconcileNativePage, snapshotResumeBoundary } from './transcript-page-source';
import { SAFE_ID_RE } from './session-browser';
import { HookRelay } from './hook-relay';
import { IPC, type TranscriptEvent, type TranscriptPageRequest, type TranscriptPageResult, type HookEvent, type SpecialistsEvent, type ShellEvent } from '../shared/types';
import { isPlaceholderModelId } from '../shared/model-ids';
import { setPermissionOverrides, forgetSessionAttention } from './main';
import { LocalSkillProvider } from './skill-provider';
import { CommandProvider } from './command-provider';
import { IntegrationInstaller } from './integration-installer';
import { RemoteConfig } from './remote-config';
import { RemoteServer } from './remote-server';
import { TranscriptWatcher } from './transcript-watcher';
import { readTranscriptPage } from './transcript-page';
import { nativeStoreSlug, ccProjectSlug } from './slug-encoding';
// Native runtime (platform roadmap Phase 1 Plan A) — the first-party harness
// stack: provider CRUD + key management, model catalog, and the live-session
// registry that owns HarnessSessions and their persistence.
import { NativeHome } from './native-home';
import type { NativeRuntime } from './create-runtime';
import { bindAppearance } from './ipc/appearance';
import { bindWindow } from './ipc/window';
import { bindShell } from './ipc/shell';
import { bindApp } from './ipc/app';
import { bindUi } from './ipc/ui';
import { bindIntegrations } from './ipc/integrations';
import { bindBuddy } from './ipc/buddy';
import { bindRemoteAdmin } from './ipc/remote-admin';
import { registerDesktopChannels } from './ipc/channel-table';
import { bindSkillsDeps } from './ipc/skills';
import { bindSyncSpacesDeps } from './ipc/sync-spaces';
import { bindSessionOps, sessionProviderFor, findTranscriptSlug } from './ipc/session';
import { bindThemeMarketplace } from './ipc/theme-marketplace';
import { bindFirstRunNative } from './ipc/first-run';
import type { OutboxBroadcast } from './chatsearch-index/outbox-drain';
import { ProviderRegistry } from './providers/provider-registry';
// Sign in with ChatGPT (backend design 2026-09-05 §1): constructed by main.ts
// (it needs the post-dev-profile userData) and passed IN; this file only wires it.
import { ClaudeAccount } from './providers/claude-account';
// Welcome back (design 2026-09-24 §1-3): the per-install "open at last
// shutdown" store, constructed in main.ts and passed in (T1 built the store
// itself; this file only calls its API).
import type { WelcomeBackStore, WelcomeBackProvider } from './welcome-back-store';
// Task 7: native auto-title generation over the AI SDK — the SAME `ai`
// package harness-session.ts already depends on (never through
// HarnessSession.send(), which hard-throws on re-entrancy).
import type { ModelBinding } from '../shared/provider-types';
import { reapplyStoredTitle, type ResumeTitleDeps } from './native-resume-title';
import { EngineManager } from './engine/engine-manager';
// Faster-engine prerequisites (2026-09-05 §A5) — a pure-ish read of this
// machine, so it needs no manager instance.
import type { EngineModel as EngineModelType } from '../shared/engine-types';
import { ModelManager } from './models/model-manager';
import { firstRunStateDir, type FirstRunNativeDeps } from './first-run';
import { clearSetupDownload, computeSetupDownloadStatus, readSetupDownload } from './first-run-local';
import { SessionStore } from './harness/session-store';
import { NativeSessionHost } from './harness/native-session-host';
import { adminCapabilityReady } from './harness/admin-capability';
import { toListResult } from './harness/specialists/catalog';
// Type-only: the payload the permissions:remove handler forwards to the host.
import type { PermissionRule } from '../shared/permission-types';
// Task 7b: the MCP registry (WHICH servers ~/.youcoded/mcp.json configures)
// and the pooled connection manager that acquire()s them per session. See the
// construction site below for the eager-vs-lazy invariant this must preserve.
// WebSearch provider stack (Phase 2 Plan B): keyed Tavily/Exa upgrades + the
// chain-walking SearchService injected into the native tool framework.
import { SearchService } from './harness/search/search-service';
import type { NativePermissionMode } from '../shared/permission-types';
import { resolveMappingAction, findLiveSessionForConversation } from './session-id-mapping';
import { readSessionTranscriptMeta } from './session-browser';
import { TranscriptPageSources, type ResolvedPageSource } from './transcript-page-source';
import { startThemeWatcher } from './theme-watcher';
import { isBundledPlugin } from '../shared/bundled-plugins';
import { ThemeMarketplaceProvider } from './theme-marketplace-provider';
import { generateThemePreview } from './theme-preview-generator';
// The KDE script that lets the buddy move itself on a Wayland desktop.
import { helperStatus, installHelper, removeHelper, type HelperStatus } from './kwin-helper';
import { setSyncHealthGate, type SyncWarning } from './sync-state';
import { startStatusPushGate } from './status-push-gate';
// Cross-device sync spaces (spec 2026-07-03) — the folder-based sync engine.
import {
  getManagedRoots, isSyncSpacesEnabled, getLastSyncByDevice,
  getSelfLastSyncEpochMs, isSyncSpacesSyncing,
} from './sync-spaces/service';
// Self-row recency derivation (spec §4) — pure fn so the ms→wire-seconds
// conversion and the sync-spaces-vs-legacy-marker precedence are unit tested.
import { deriveSelfLastSyncEpochSec } from './sync-spaces/self-sync-status';
// Connect-GitHub modal (device-flow auth) — detectGh/installGh are step fns;
// createGithubConnect is the stateful orchestrator that owns the in-flight flow.
import { createGithubConnect, setGithubConnect } from './github-connect';
import { getGithubClient } from './github-client';
import { getConfig as getMarketplaceConfig, setConfig as setMarketplaceConfig } from './marketplace-config-store';
import { readComponent, type ComponentKind } from './marketplace-file-reader';
import { log } from './logger';
import { attachStartupDialogLog } from './startup-dialog-log';
import { getUpdateService } from './update-service';
// Analytics opt-out — Phase 6. The two exported functions read/write
// ~/.claude/youcoded-analytics.json; runAnalyticsOnLaunch (wired in main.ts)
// short-circuits when optIn is false.
// Saved-folder store — extracted so sync-spaces/ can share the reader/writer.
// Shared cap so a local folder's description can't drift from the synced
// registry's limit (project-registry.ts uses the same constant).
import { PROJECT_DESCRIPTION_MAX } from '../shared/artifacts/types';
import { setPermissionOverridesSink } from './prefs-service';
import type { SessionInfo } from '../shared/types';
import { ARTIFACT_IPC } from './artifacts/ipc-channels';
import { createPublish } from './publish';
import { SessionLiveFacts } from './session-live';
import { SessionScreens } from './session-screens';
import { startSessionSummaryPush, SESSION_SUMMARY_CHANNEL } from './session-summary-push';
import { listProjects } from './artifacts/central-index';
import { initPagesService, getPagesService } from './pages/pages-service';
import { PageConnectionsStore } from './pages/connections-store';
import { wireDocCommentsPush } from './doc-comments/ipc-handlers';
import { createAuthStore } from './marketplace-auth-store';
import { getMachineIdentity } from './device-identity';
// Shared with remote-server.ts — see that module's header for why these left
// this file (they were closures, so the remote transport could not reach them).
import { invalidateDiscoveryCache } from './artifacts/project-file-discovery';
import { initProjectWatchers, noteOwnWrite } from './artifacts/project-watcher';
import { initGitWatchers } from './git/git-watcher';
import { broadcastGitChanged } from './ipc/git';
import { gitBranchLabel } from './git/git-branch-label';
// The artifact and Project View READ bodies, shared with remote-server.ts
// (remote access batch 3) so a phone gets the desktop's own answers.
// Conversation Store (Phase 2a): live intake of transcript activity, session
// cwd, title and flag changes. Keyed by CLAUDE session id (resolved from the
// desktop id via sessionIdMap below), matching the store's record id.
import { noteTranscriptEvent, noteSessionStarted, noteSessionEnded,
  noteModelUsed, getConversationStore, flushSessionToSpace,
  buildLocalProjectResolver, emitConversationMetaChanged,
  pinHandoffDestination, publishStoppedHandoff, syncPublishedHandoff,
  importConfirmedHandoff, resolveHandoffProject, resolveSavedHandoffProject, HANDOFF_SYNC_TIMEOUT_MS,
  mutateNamingRecord,
  resolveSessionName,
  setManualSessionName,
} from './conversations/service';
import { requestChatsearchRefresh } from './chatsearch-index/index-service';
// Task 4: resolves a native session's live model binding into the store's
// portable {modelId, providerType, providerLabel} shape — see
// portable-model.ts's WHY comment for why the lookup itself is split out.
import { bindingToPortableModel } from './conversations/portable-model';
// Plan 2b Task 8: holder-side takeover — when another device requests a session
// this device holds, cleanly interrupt/flush/release/move/destroy it.
import { createHolderTakeover } from './conversations/takeover';
import { createResumeAdmission } from './conversations/resume-admission';
import { createHandoffAttempts } from './conversations/handoff-attempt';
import { createHandoffTransport } from './conversations/handoff-transport';
import { bindHandoffRoute } from './ipc/handoff';
import { bindPermissionHooks } from './ipc/permissions';
import { createTransferredExitGate } from './conversations/handoff-exit';
import { hubLeaseRequest, syncSpacesSyncNowAwaited } from './sync-spaces/service';
import type { RequesterTakeoverType } from './conversations/takeover';

// Max age for clipboard paste images (1 hour)

// Root of ~/.claude — used by artifact handlers to locate the central index.
const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// Native transcript existence probe: does ~/.youcoded/sessions/<slug>/<id>.jsonl
// exist for this cwd? Mirrors NativeHome.sessionFilePath's convention — the RAW
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

// Moved to electron-platform.ts (2026-09-29 one-core R1): it is the desktop Platform's answer to
// "where are the sudo-password helper scripts". Re-exported so existing importers keep working.
export { resolveAskpassPaths } from './electron-platform';

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
    setHolderTakeover: (fn: (sessionId: string, from?: { deviceId: string; device: string }, transferNonce?: string) => void) => void;
    // Plan 2b Task 9: the requester-side takeover flow, built in main.ts (where
    // deviceId + hubLeaseRequest + materializeOne + syncSpacesSyncNow are all
    // reachable). The three lease IPC handlers below are thin passthroughs to it.
    requester: RequesterTakeoverType;
    // deviceId  — per-INSTALL. Leases ONLY. Distinguishes the dev instance from
    //             the built app on one machine; never use it for the registry.
    // machineId — per-MACHINE. Device registry ONLY (self-marking). '' when this
    //             machine has no durable identity, which matches no row — correct,
    //             since nothing was registered either.
    deviceId: string;
    machineId: string;
    /** Test override; production uses the sync-space service flag. */
    syncEnabled?: () => boolean;
  },
  // The native runtime, built once by createRuntime() in main.ts and shared with RemoteServer
  // (WHY, 2026-09-29 one-core R1: this used to be constructed in the middle of this function and
  // pushed to the phone door afterwards through a setter). It also carries Sign in with ChatGPT
  // with the YOUCODED_CHATGPT=0 kill switch already applied (create-runtime.ts).
  runtime?: NativeRuntime,
  // Welcome back (design §1-3): absent only in tests that don't care about it —
  // every call site below is optional-chained, so the feature is silently
  // inert (no offer, no tracking) rather than throwing when it's omitted.
  welcomeBackStore?: WelcomeBackStore,
) {
  // WHY optional in the signature but required here: the params before it are optional (tests
  // pass four), and TypeScript will not let a required one follow them. A missing runtime is a
  // programming error, so fail loudly at registration rather than at the first handler call.
  if (!runtime) throw new Error('registerIpcHandlers needs the runtime built by createRuntime()');
  // WHY (2026-09-29 one-core R2): every request from a window is now ONE object ({ sessionId, text }, not (sessionId, text)) — the same object the phone sends, so one handler can serve both doors and two same-typed arguments can no longer be swapped unnoticed. tests/wire-shape-parity.test.ts checks these keys against preload's.
  // The per-session maps every handler group shares. WHY (2026-09-29 one-core R1): ONE copy,
  // owned by the runtime (ipc/session-state.ts) — never re-declared per file or per group.
  const { sessionIdMap, lastModelSeen, topicWatchers, lastTopics, provisionalResumeTitles } = runtime.sessionState;

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
  // WHY `hold` (one-core R5-2): a window that is being filled with this session (session-open.ts) keeps what it would receive until
  // its answer is out; `hold` is told each recipient and may take the delivery.
  const sendForSession = (sessionId: string, channel: string, args: any[], hold?: (windowId: number, deliver: () => void) => boolean) => {
    // WHY the registry answers this (one-core R5-1): windows and phones are both registry members, one audience question.
    const audience = windowRegistry?.resolveAudience(sessionId);
    const ids = audience ? audience.windowIds : [];
    if (ids.length > 0) {
      for (const wid of ids) {
        // wid is a webContents.id, NOT a BrowserWindow.id — different ID
        // spaces. BrowserWindow.fromId silently returns null for a
        // webContents.id, so previously every peer-window event fell through
        // to the mainWindow fallback (window 1). webContents.fromId does the
        // correct lookup.
        const deliver = () => {
          const wc = webContents.fromId(wid);
          if (wc && !wc.isDestroyed()) wc.send(channel, ...args);
        };
        if (hold?.(wid, deliver)) continue;
        deliver();
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

  // WHY (one-core R5-1): the ONE way a session-scoped push leaves the core — the windows by the registry's audience, every
  // phone, and the session's record. A hand-written sendForSession + broadcast pair is rejected by ast-grep (no-paired-session-send-and-broadcast).
  // WHY (R5-2 review): a screen whose fill never completed has had its held pushes dropped; tell it to fill again. A window is asked to
  // (session:refill); a phone is hung up on, and its reconnect fills every conversation.
  runtime.fills.setExpireHandler((key, sessionId) => {
    const id = Number(key.slice(1));
    if (key[0] === 'w') { const wc = webContents.fromId(id); if (wc && !wc.isDestroyed()) wc.send(IPC.SESSION_REFILL, sessionId); }
    else remoteServer?.dropAudience(id);
  });
  const publish = createPublish({
    records: runtime.records,
    fills: runtime.fills,
    toWindows: (sessionId, channel, args, hold) => sendForSession(sessionId, channel, args, hold),
    toSockets: (message, socketIds, hold) => remoteServer?.broadcast(message, socketIds, hold),
    socketsFor: (sessionId) => windowRegistry?.resolveAudience(sessionId).socketIds,
  });

  // WHY (one-core R5-4a): the computer's one reading of a Claude Code session's live facts (permission mode, /model, /compact, "Conversation
  // cleared") and the one place a card a window saw in its terminal becomes an event every screen draws. Everything it says leaves through publish.
  const liveFacts = new SessionLiveFacts({
    publish,
    records: runtime.records,
    // A Claude Code session: not native (its host says these things itself) and not a plain shell.
    isClaude: (id) => { const p = sessionManager.getSession(id)?.provider; return p !== 'native' && p !== 'shell' && !!sessionManager.getSession(id); },
  });

  // WHY (one-core R5-4b): the computer's own copy of each running Claude Code terminal, read for the "may be stuck" check and for the cards a terminal
  // shows. Everything it finds leaves through liveFacts (so through publish). It exists only while a turn runs, a session is starting or a menu is up.
  // The terminal bytes it is fed are noted in the record by the session manager itself (setChunkNoter below), whether or not phone access is on.
  let onMainAttention: ((sessionId: string, state: 'ok' | 'stuck') => void) | null = null; // set once the status relay below exists
  const screens = new SessionScreens({
    records: runtime.records,
    live: liveFacts,
    isClaude: (id) => { const p = sessionManager.getSession(id)?.provider; return p !== 'native' && p !== 'shell' && !!sessionManager.getSession(id); },
    size: (id) => sessionManager.getPtySize(id),
    // The tray, the badge and a status bar read the same cache a window's relay fills (attentionMap); the computer's reading goes in too, so
    // they are right with no window relaying.
    onAttention: (id, state) => { onMainAttention?.(id, state); },
  });
  runtime.records.onScreenNeedChange((id) => screens.refresh(id));
  // The record keeps a session's terminal bytes (up to 4M units) for a phone's terminal view, and ONLY while phone access is on, exactly as the
  // phone server's own buffer did before the record existed. The computer's headless terminals are fed every chunk directly and need none of it.
  sessionManager.setChunkNoter((id, data) => (remoteServer?.isRunning() ? runtime.records.notePty(id, data) : null));

  // WHY (2026-09-29 one-core R1): returned from registerIpcHandlers as plain values (was two
  // module-level `let`s assigned here as a side effect, so a caller that ran first silently
  // did nothing). main.ts hands them to the chatsearch outbox drainer, which changes flags,
  // notes and tags outside any window's handler and must still repaint every window and phone.
  const broadcastSessionMeta = (sessionId: string, payload: { flag: string; value: boolean } | { note: string }): void => {
    // Windows get (sessionId, change); phones get {sessionId, ...change} — the two shapes the pair always sent.
    publish(sessionId, IPC.SESSION_META_CHANGED, { sessionId, ...payload }, { windowArgs: [sessionId, payload], everyPhone: true });
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

  // WHY defined here (not next to broadcastSessionMeta above): it needs
  // broadcastToAllWindows, which doesn't exist yet at that point in the
  // function — same hand-out pattern, just wired where its dependency is
  // available. Fires the identical pair the TAGS_CREATE handler below fires.
  const broadcastTagsChanged = (): void => {
    remoteServer?.broadcast({ type: IPC.TAGS_CHANGED, payload: {} });
    broadcastToAllWindows(IPC.TAGS_CHANGED, {});
  };

  // --- Theme file watcher ---
  const stopThemeWatcher = startThemeWatcher();

  // WHY (2026-10-01 one-core R3-8): theme:*, appearance:*, window:* controls and zoom:* are table entries
  // (main/ipc/appearance.ts, window.ts). The theme favourites live in the skill config store and the window controls act on
  // the main window and the window list, which are built here, so they are handed over.
  bindAppearance(skillProvider.configStore);
  bindWindow({ getMainWindow: () => mainWindow, getDirectory: () => windowRegistry?.getDirectory((id) => sessionManager.getSession(id)) });
  bindShell({ getMainWindow: () => mainWindow });

  // --- The Linux/KDE buddy helper (design §4) ---
  // WHY (2026-10-01 one-core R3-8): buddy:helper-status / install-helper / remove-helper are table entries (main/ipc/buddy.ts);
  // the cached status, the consent gate's refusal and the install/remove calls stay here (the drag path and the consent
  // test read them) and are handed over.
  bindBuddy({ helper: { refresh: refreshBuddyHelperStatus, showRefusal: buddyShowRefusal, install: installHelper, remove: removeHelper } });

  // WHY (2026-10-01 one-core R3-8): performance:*, app:restart and attention:* are table entries (main/ipc/app.ts).

  // --- Theme marketplace ---
  // Phase 3a: pass the shared config store so theme installs also record into
  // the unified youcoded-skills.json packages map used for update tracking.
  const themeMarketplace = new ThemeMarketplaceProvider(skillProvider.configStore);
  // WHY (2026-09-30 one-core R3-3): skills:*, marketplace:* and theme-marketplace:* are table entries
  // (main/ipc/{skills,marketplace,theme-marketplace}.ts) served to the computer's windows AND to a
  // phone by one body each. They reach the objects built here through these two binds.
  bindSkillsDeps({ skillProvider, sessionManager });
  bindThemeMarketplace(themeMarketplace);
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

  // Forward session-created to the owning window. Deferred via nextTick so
  // the SESSION_CREATE IPC handler can run assignSession first — otherwise
  // sendForSession fires before ownership is set and falls back to mainWindow,
  // making a session created in window 2 appear in window 1. Remote-created
  // sessions still fall back to mainWindow since no renderer owns them yet.
  //
  // This only holds because assignSession runs SYNCHRONOUSLY in that handler,
  // before its first await — nextTick outranks the microtask queue, so an
  // assignSession sitting after any await would drain too late. See the WHY on
  // the assignSession block itself; pinned by tests/ipc-handlers-create-ownership.test.ts.
  sessionManager.on('session-created', (info) => {
    // A new record, a new epoch (one-core R5-1). Synchronous, so it exists before any of the session's events.
    runtime.records.begin(info.id);
    process.nextTick(() => sendForSession(info.id, IPC.SESSION_CREATED, [info]));
  });
  attachStartupDialogLog(sessionManager, hookRelay, log, (id) => sessionManager.markStarted(id)); // desktop.log + SessionInfo.awaitingStart

  // The docx/xlsx pending-mutation queue's lifecycle (T9b/T20/finding #3) —
  // extracted to its own file (session-lifecycle.ts) to keep this file under
  // its own line budget; see that file's own header for the full WHY.
  wireDocCommentsSessionLifecycle(sessionManager);

  // WHY (2026-10-01 one-core R3-8): terminal:get-screen-text is a table entry (main/ipc/ui.ts).

  // Deps for the resume-time title re-apply (native-resume-title.ts). These are
  // exactly the two calls the title feeder's own onTitle makes — the pill only
  // updates when BOTH fire (sendForSession reaches the owning window's
  // App.tsx sessionRenamed handler; broadcastRename updates SessionInfo, the
  // remote clients, and the window directory).
  // Opening-words names planted on a resumed, never-titled native session's pill
  // (native-resume-title.ts), keyed by session id. They are there so the pill
  // matches the Resume Browser row — NOT a title: both `hasTitle` checks below
  // look through them via liveNameForTitleCheck (create-runtime.ts), or the namer would read the
  // raw first message as a real name and never generate one.
  const resumeTitleDeps: ResumeTitleDeps = {
    // NOTE: getConversationStore() is null for the whole launch when the managed
    // roots are unavailable (conversations/service.ts sets storePhase
    // 'unavailable'), so on such a machine this reads undefined every time and
    // the re-apply is a permanent no-op. That is survivable, not silent breakage
    // — the title feeder still generates a name at the next turn-complete.
    getStoredTitle: async (sessionId) => (await getConversationStore()?.get('native', sessionId))?.title,
    onTitle: (sessionId, title, opts) => {
      if (opts?.provisional) provisionalResumeTitles.mark(sessionId, title);
      sendForSession(sessionId, IPC.SESSION_RENAMED, [sessionId, title]);
      broadcastRename(sessionId, title);
    },
    getOpeningTitle: (sessionId) => nativeHost.openingTitle(sessionId),
  };

  const leasesEnabled = () => leaseWiring?.syncEnabled?.() ?? isSyncSpacesEnabled();
  // Session CRUD. The same operation serves Electron and the remote socket;
  // admission happens before createSession can spawn a writer on either path.
  const startSession = async (event: { sender: { id: number; isDestroyed?: () => boolean } } | null, rawOpts: Parameters<SessionManager['createSession']>[0], attemptCheck?: () => void) => {
    // "No folder" (shared/no-folder.ts): the renderer's sentinel becomes the
    // app-owned empty folder here, before the session manager or the native
    // host sees a cwd.
    // The window can close while admission or native startup is awaiting I/O.
    const checkWindow = () => { attemptCheck?.(); if (event?.sender.isDestroyed?.()) throw new Error('The window closed before this conversation opened.'); };
    checkWindow();
    // Task 1 (Destin, 2026-09-26): no session may exist before this
    // machine's admin capability is settled — a session created in the
    // first moments of app start would otherwise read the Bash
    // description's placeholder default and keep it, byte-identical, for
    // its own whole life (prompt cache). Resolves instantly once settled;
    // pending only in the brief window right after app launch.
    await adminCapabilityReady();
    checkWindow();
    const opts = resolveNoFolderCwd(rawOpts, app.getPath('userData'));
    // Snapshot BEFORE spawn: a fallback page can otherwise include new Claude Code turns.
    const resumeBoundary = opts.provider === 'claude' && opts.resumeSessionId
      ? snapshotResumeBoundary(opts.cwd, opts.resumeSessionId) : null;
    const info = sessionManager.createSession(opts);
    if (resumeBoundary) resumePageBoundaries.set(info.id, resumeBoundary);
    // WHY: a holder takeover can arrive during the FIRST native await or before
    // CC emits SessionStart. Register the resumed identity synchronously now.
    if (opts.resumeSessionId) {
      writerGenerations.set(info.id, (writerGenerations.get(info.id) ?? 0) + 1);
      sessionIdMap.set(info.id, opts.resumeSessionId);
      if (leaseWiring && leasesEnabled()) admittedResumes.add(info.id);
      if (info.provider === 'claude') awaitingFirstResumeHook.add(info.id);
      // Welcome back (design §2): a resumed conversation already has messages
      // (S-sent), so it's remembered as "open" from the moment it's created —
      // unlike a brand-new session, which only earns that once its first user
      // message actually lands (the hook on the transcript-event listeners
      // below). 'shell' has no conversation id to remember (welcome-back-store.ts).
      if (info.provider !== 'shell') trackWelcomeBack(info.id, opts.resumeSessionId, info.provider);
      // WHY: a resumed Claude Code session's pill sat on the 'Resuming...'
      // placeholder for its whole life — only native resumes re-applied the
      // stored title below (Destin, 2026-09-24). Same re-apply, same rename
      // pair, keyed by the CONVERSATION id (a Claude session's desktop id
      // differs). No stored title → the opening words, read by the same
      // reader the Resume browser row uses, so the pill matches the row the
      // user clicked; provisional, so the namer can still give it a real one.
      // Fire-and-forget: never lets a title read delay or fail the resume.
      if (info.provider === 'claude') {
        const conversationId = opts.resumeSessionId;
        const jsonlPath = resumeBoundary?.jsonlPath;
        void reapplyStoredTitle({
          getStoredTitle: async () => (await getConversationStore()?.get('claude', conversationId))?.title,
          onTitle: resumeTitleDeps.onTitle,
          getOpeningTitle: async () => (jsonlPath ? (await readSessionTranscriptMeta(jsonlPath, true)).fallbackTitle ?? undefined : undefined),
        }, info.id);
      }
    }
    // WHY: assign ownership BEFORE the first native await. session-created is
    // forwarded on nextTick; otherwise it reaches the wrong window (pinned by
    // ipc-handlers-create-ownership.test.ts). Buddy-created sessions belong to
    // the leader main window; the buddy subscribes instead of owning them.
    if (windowRegistry && event) {
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
      nativeStarting.add(info.id);
      // Did a real resume of stored data actually happen? Distinct from
      // `opts.resumeSessionId` being set: a resume can REFUSE (transcript not
      // synced / project folder missing) or fall back to creating a fresh
      // session under the same id. Only a true resume may wear the stored
      // conversation's name — see the re-apply below.
      let didResume = false;
      try {
        if (opts.resumeSessionId) {
          // Apply the resume-time binding inside resume(), before context/model
          // profiling, rather than changing it after initialization.
          //
          // Resolve the transcript's actual cwd BEFORE resume(): SessionManager
          // falls back to $HOME when cwd is absent, which can spawn a blank chat.
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
            throw new Error(refusal);
          } else if (resolvedCwd) {
            info.cwd = resolvedCwd; // fix the SessionInfo so downstream (noteSessionStarted, eager model, renderer) reads the validated cwd
            didResume = await nativeHost.resume(opts.resumeSessionId, resolvedCwd, opts.binding);
            // Existence is not readability; false means no harness was started.
            if (!didResume) throw new Error('This conversation could not be resumed — its saved data could not be read.');
          } else {
            const resumed = await nativeHost.resume(opts.resumeSessionId, info.cwd, opts.binding);
            didResume = resumed;
            // No stored file (e.g. resuming an id that was never persisted) → start
            // a fresh session under the same id so the renderer isn't left with a
            // SessionInfo backed by no live HarnessSession.
            const fallbackBinding = opts.binding;
            // WHY: an EXISTING file with no readable header was never "not persisted" — create() appended a 2nd header.
            if (!resumed && nativeTranscriptExists(info.cwd, opts.resumeSessionId)) throw new Error('This conversation could not be resumed — its saved data could not be read.');
            if (!resumed && fallbackBinding) {
              await nativeHost.create({ sessionId: info.id, cwd: info.cwd, binding: fallbackBinding, presetId: opts.preset });
            } else if (!resumed && !opts.binding) {
              // Resume asked for a session whose saved data is gone, and we have no
              // binding to start a fresh one under this id — the renderer already
              // holds a live SessionInfo with an empty chat and no way to know why.
              throw new Error('This conversation could not be resumed — its saved data is missing.');
            }
          }
        } else {
          if (!opts.binding) throw new Error('A model is required to start this conversation.');
          await nativeHost.create({ sessionId: info.id, cwd: info.cwd, binding: opts.binding, presetId: opts.preset });
        }
        checkWindow();
        // Stamp the RESOLVED preset id (post legacy-mapping — a stored 'chat'
        // header resolves to 'assistant') onto the SessionInfo so the renderer's
        // preset badge + resume rows can read it. getHarnessId is authoritative
        // after create/resume awaited above.
        info.harnessId = nativeHost.getHarnessId(info.id) ?? undefined;
        // Same stamp as SESSION_LIST, so the very first render of a brand-new
        // session already knows whose plan it is spending (review T6 F1).
        info.providerType = bindingToPortableModel(nativeHost.getBinding(info.id), await providerRegistry.list())?.providerType;

        // Native has no CC hook; this identity mapping also powers holder teardown.
        writerGenerations.set(info.id, (writerGenerations.get(info.id) ?? 0) + 1);
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
        // Only a true resume receives the stored title: a fallback creates
        // fresh data under the old id, which is not the old conversation.
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
        // Resumes already acquired before creation; fresh native identities
        // acquire here. Confirmed denial tears the failed session down instead
        // of leaving a writable session without authority. Offline stays usable.
        if (!opts.resumeSessionId && leaseWiring && leasesEnabled()) {
          const acquired = await leaseWiring.client.acquire(info.id).catch(() => null);
          if (acquired?.ok === false) {
            throw new Error('Another device holds this conversation.');
          }
        }
        checkWindow();
        if (nativeExited.has(info.id)) throw new Error('This conversation ended before startup completed.');
      } catch (e) {
        // WHY: destroy may fail while a harness can still append. Keep its
        // identity and renewable hold until a successful teardown; never
        // represent a possible writer as a safely released session.
        try {
          await nativeHost.destroy(info.id);
          await resumeAdmission.waitForStop(opts.resumeSessionId ?? info.id);
          resumeAdmission.clearProtection(opts.resumeSessionId ?? info.id);
          sessionManager.destroySession(info.id);
          // WHY (F2, code review 2026-09-24): a resumed session is tracked as
          // "open" at creation, above, before this native resume attempt ever
          // runs (S-sent — it already has messages). Every failure here
          // (refused sync, missing project folder, missing saved data,
          // another device holding the lease, the window closing mid-start)
          // reaches this successful-teardown branch, and a resume that failed
          // for a real reason is not "open" — it must not be re-offered by
          // the next Welcome back screen. Only reached once teardown itself
          // succeeded (the cleanupError branch below keeps the session's
          // renewable hold, so it stays tracked, matching the WHY above it).
          if (opts.resumeSessionId) untrackWelcomeBack(info.id);
        } catch (cleanupError) {
          resumeAdmission.protect(opts.resumeSessionId ?? info.id);
          log('ERROR', 'IPC', 'native teardown after startup failure failed', { sessionId: info.id, error: String(cleanupError) });
          throw new Error(`Native startup failed (${String(e)}); teardown failed (${String(cleanupError)}).`);
        } finally { nativeStarting.delete(info.id); nativeExited.delete(info.id); }
        sessionIdMap.delete(info.id);
        // WHY endSession (one-core R5-3): the session never started, so no phone should keep a watch on it (releaseSession keeps phones').
        windowRegistry?.endSession(info.id);
        log('ERROR', 'IPC', 'native session start failed', { sessionId: info.id, error: String(e) });
        throw e;
      }
      nativeStarting.delete(info.id);
      nativeExited.delete(info.id);
      // Eager-load the bound model the moment the session opens (like LM Studio),
      // so the loading bar + GB progress appear immediately rather than only after
      // the first message. Fire-and-forget; the model poll drives the UI.
      const eagerModelId = nativeHost.modelForSession(info.id);
      if (eagerModelId) { void engineManager.loadModel(eagerModelId).catch(() => { /* engine not installed / boot failed — the first send surfaces it */ }); }
    } else if (info.provider === 'claude') {
      // Contract R23: EVERY chat carries the line saying what the assistant
      // started with — a Claude Code chat is still a chat. The native runtime
      // pushes its own record from the host's wire(); Claude Code has no host
      // here, so it is assembled from what this machine can honestly say (the
      // instruction files on disk, the skills the app installed) and marked as
      // Claude Code's own for everything else. See claude-code-context.ts.
      //
      // nextTick for the same reason the SESSION_CREATED forward defers: the
      // renderer must have the session in state before a record about it lands.
      // Never fatal — a chat that will not start is worse than an unexplained one.
      process.nextTick(() => {
        try {
          const payload = { sessionId: info.id, context: buildClaudeCodeContext(info.cwd, info.model ?? null) };
          publish(info.id, IPC.NATIVE_SESSION_CONTEXT, payload);
        } catch (err) {
          log('ERROR', 'ipc-handlers', 'could not describe a Claude Code session context', { sessionId: info.id, error: String(err) });
        }
      });
    }
    checkWindow();
    return info;
  };
  const createSession = async (event: { sender: { id: number; isDestroyed?: () => boolean } } | null, opts: Parameters<SessionManager['createSession']>[0]) => {
    if (!opts.resumeSessionId) return startSession(event, opts);
    let started = false;
    const result = await resumeAdmission.open(opts.resumeSessionId, () => {
      started = true;
      return startSession(event, opts);
    }, !!leaseWiring && leasesEnabled());
    if (result.status === 'lease-denied') return result;
    // WHY: a duplicate open belongs to its original window, even if the
    // second request came from a different window. Ask that owner to select it.
    // WHY the ownerless fallback (combined branch: master's reuse vs bugfix-chatfiles'
    // "switch to the open tab"): a session with NO owning window — started from
    // a phone or a remote handoff — was answered `reused` with no focus request
    // at all, so the desktop never switched to it. Its events take
    // sendForSession's ownerless route (the primary mainWindow, above), so that
    // is the one window whose renderer lists it. Once that window is closed no
    // window shows it, and none is raised (not the leader: it would not list it).
    const owner = windowRegistry?.getOwner(result.id);
    if (!started && event) {
      const target = owner != null ? webContents.fromId(owner)
        : (!mainWindow.isDestroyed() ? mainWindow.webContents : undefined);
      if (target) {
        target.send(IPC.SESSION_FOCUS_REQUEST, result.id);
        BrowserWindow.fromWebContents(target)?.focus();
      }
    }
    return started ? result : { ...result, reused: true as const };
  };
  // WHY (2026-09-30 one-core R3-4): session:create is a table entry (main/ipc/session.ts) calling this
  // closure through bindSessionOps, for a window (with its sender) and for a phone (with none).

  // The teardown behind session:destroy (table entry, main/ipc/session.ts): the computer's windows AND a
  // phone run this one body, so a phone's close also releases the hold and forgets it for Welcome back.
  const destroySession = async (sessionId: string): Promise<boolean> => {
    // WHY: admission is keyed by CONVERSATION id; a Claude session's desktop id
    // differs. Capture it before teardown can drop the mapping.
    const conversationId = sessionIdMap.get(sessionId) ?? sessionId;
    // Idempotent + no-op for non-native ids: flushes/tears down the native
    // HarnessSession if this id is live, otherwise returns immediately.
    await nativeHost.destroy(sessionId);
    await resumeAdmission.waitForStop(conversationId);
    // WHY: an earlier direct destroy may have left this Claude writer unproven.
    // A later IPC destroy cannot clear its protection without PTY-exit proof.
    const recoveredWriter = handoffAttempts?.hasSession(sessionId) ? false : resumeAdmission.clearProtection(conversationId);
    // Task 7: drop the title feeder's per-session state too — a no-op for
    // non-native ids (the feeder was never fed events for them) and cheap
    // idempotent Map.delete for native ones.
    sessionNamer.forget(sessionId);
    // Deliberately NOT dropped on session-EXIT: a conversation whose process
    // has ended stays on screen and must stay scrollable, and exit is what
    // stops the transcript watcher. Closing the conversation is the point where
    // nothing can ask for its history again.
    pageSources.forget(sessionId);
    resumePageBoundaries.delete(sessionId);
    // WHY: ordinary destroy emits session-exit before requesting a PTY kill.
    // A transferred writer needs the worker's PTY-exit proof before its pin
    // can go; an unknown stop stays fenced, even if the UI closes the tab.
    const pinnedClaude = handoffAttempts?.hasSession(sessionId) && sessionManager.getSession(sessionId)?.provider === 'claude';
    const stopProof = pinnedClaude ? await sessionManager.stopSessionForHandoff(sessionId) : null;
    if (pinnedClaude && stopProof?.status !== 'stopped') resumeAdmission.protect(conversationId);
    // WHY: a proven stop already removed the manager entry, so destroySession
    // finds nothing; that is still a successful close, not a failure.
    const result = sessionManager.destroySession(sessionId) || (!!pinnedClaude && stopProof?.status === 'stopped');
    // No SessionManager entry remains to emit exit after a failed startup.
    if (recoveredWriter && !result) resumeAdmission.end(conversationId);
    if (result && !pinnedClaude) handoffAttempts?.ended(sessionId);
    if (result) {
      // Explicit user-initiated destroy → treat as clean exit (0). The
      // reducer no-ops clean exits unless a turn was in flight.
      sendForSession(sessionId, IPC.SESSION_DESTROYED, [sessionId, 0]);
      windowRegistry?.endSession(sessionId); // the session is over: windows' AND phones' interest ends (R5-3)
      // Welcome back (design §2): this is the session's own X — untrack it so
      // it is NOT offered back next launch. Deliberately NOT in
      // sessionManager.destroySession/session-exit (below): those also run on
      // an ordinary process exit or a whole-app quit, which must keep it
      // tracked (S-other-quit) — only THIS explicit IPC path means "the user
      // closed it".
      untrackWelcomeBack(sessionId);
    }
    return result;
  };

  // session:list / :selected / :switch are table entries now (main/ipc/session.ts); the window-scoped list
  // and the per-window selection cache read windowRegistry through bindSessionOps.

  // WHY (2026-10-01 one-core R3-8): dialog:*, clipboard:save-image and shell:* (open changelog / external / path, show item) are
  // table entries (main/ipc/shell.ts).

  // WHY (2026-09-30 one-core R3-5): model:get-preference / set-preference live in the channel table (main/ipc/model.ts).

  // WHY (2026-09-30 one-core R3-1): modes:get / modes:set, settings:get / settings:set,
  // defaults:get / defaults:set, analytics:* , folders:* and tags:* now live in the channel table
  // (main/ipc/<family>.ts), served by both doors from one body.

  // model:read-last is a table entry too (main/ipc/model.ts).

  // --- Session defaults persistence ---
  // The channels themselves are table entries (main/ipc/defaults.ts); prefs-service.ts holds the
  // read/merge/write. Every read and save also refreshes main.ts's in-memory override cache (the
  // one the permission hook consults) through the sink registered here — for a save made from a
  // phone too.
  setPermissionOverridesSink(setPermissionOverrides);

  // --- Skills discovery & marketplace ---
  // skills:* / marketplace:* / theme-marketplace:* are table entries now (see the binds above).
  // WHY (2026-10-01 one-core R3-8): commands:list, platform:get, the favourite themes and integrations:* are table entries
  // (main/ipc/ui.ts, appearance.ts, integrations.ts). The command list and the integration installer are built here, so
  // they are handed over.
  bindUi({ getCommands: () => commandProvider.getCommands(), emitUiAction: (action) => sessionManager.emit('ui-action', action) });
  bindIntegrations(integrationInstaller);

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

  bindRemoteAdmin({ config: remoteConfig, server: remoteServer, applyKeepAwake });
  if (remoteConfig) {
    // Apply saved keep-awake on startup
    if (remoteConfig.keepAwakeHours > 0) applyKeepAwake(remoteConfig.keepAwakeHours);
    // WHY (2026-10-01 one-core R3-8): remote:get-config, set-password, set-config, detect-tailscale, get-client-count,
    // get-client-list, status, devices:* and install/auth-tailscale are table entries (main/ipc/remote-admin.ts), including
    // the refusals a phone gets for set-password, set-config, rename and unpair (HOST_ADMIN_REFUSAL). The config, server and the
    // keep-awake timer that lives above are handed over. remote:rehydrate below is connection housekeeping, not a feature: the
    // phone's answer is in remote-server.ts, and a window, which IS the copy, says so here.
    ipcMain.handle(IPC.REMOTE_REHYDRATE, async () => ({ ok: false, code: 'not-remote' }));

    // WHY (2026-10-01 one-core R3-8): ui:action:broadcast (a window's screen action, relayed to every phone) is a table
    // entry (main/ipc/ui.ts).
    // UI action sync: Remote client broadcasts an action → forward to Electron window
    sessionManager.on('ui-action', (action: any) => {
      send(IPC.UI_ACTION_RECEIVED, action);
    });
  }

  // session:browse / :history / :input / :resize are table entries (main/ipc/session.ts).

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
    // One reading of the permission-mode footer for the session, instead of every screen scanning its own copy (one-core R5-4a).
    liveFacts.noteOutput(sessionId, data);
    screens.noteOutput(sessionId, data); // the computer's own copy of the terminal (one-core R5-4b)
    if (readySessions.has(sessionId)) {
      sendForSession(sessionId, `pty:output:${sessionId}`, [data]);
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
  const signalTerminalReady = (sessionId: string): void => {
    readySessions.add(sessionId);
    const buffered = pendingOutput.get(sessionId);
    if (buffered) {
      for (const data of buffered) {
        sendForSession(sessionId, `pty:output:${sessionId}`, [data]);
      }
      pendingOutput.delete(sessionId);
    }
  };

  // Forward session exit events — exitCode is piped through to the renderer
  // so the reducer can distinguish clean shutdowns from 'session-died' cases.
  sessionManager.on('session-exit', (sessionId: string, exitCode: number) => {
    sendForSession(sessionId, IPC.SESSION_DESTROYED, [sessionId, exitCode]);
    runtime.records.drop(sessionId); // the session is over: its record goes with it (one-core R5-1)
    liveFacts.forget(sessionId);
    screens.forget(sessionId);
    pendingOutput.delete(sessionId);
    readySessions.delete(sessionId);
    windowRegistry?.endSession(sessionId); // over: windows' AND phones' watches go (a window merely releasing keeps phones', R5-3)
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

  // WHY (2026-09-30 one-core R3-2): the update checker, installer and update:* handlers moved to
  // update-service.ts and main/ipc/update.ts. Initial fetch on startup:
  const updateService = getUpdateService();
  const getUpdateStatus = () => updateService.getUpdateStatus();
  updateService.fetchLatestRelease().catch(() => {});
  const defaultsPrefPath = path.join(os.homedir(), '.claude', 'youcoded-defaults.json');

  // WHY async (2026-09-16 smoothness sweep, C5): these three readers feed the
  // 10 s status push, which read 6 files plus 3 per open session synchronously
  // on the main thread every tick (and again on every attention change) — a
  // rhythmic micro-stutter that grew with the number of sessions opened.
  async function readJsonFile(filePath: string): Promise<any> {
    try {
      return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  // .sync-status is no longer read here: the value was threaded all the way to
  // StatusBar and then dropped, so this was a disk read every 10s feeding nothing.
  // The file itself still exists and is read by statusline.sh and /diagnose.
  // Legacy .sync-warnings text file is no longer read; typed warnings come from .sync-warnings.json.
  const syncWarningsJsonPath = path.join(os.homedir(), '.claude', '.sync-warnings.json');

  async function readTextFile(filePath: string): Promise<string | null> {
    try {
      return (await fs.promises.readFile(filePath, 'utf8')).trim() || null;
    } catch {
      return null;
    }
  }

  /** Read typed sync warnings — returns [] if missing or unparseable. */
  async function readSyncWarnings(): Promise<SyncWarning[]> {
    try {
      const text = await fs.promises.readFile(syncWarningsJsonPath, 'utf8');
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

  async function buildStatusData() {
    const home = os.homedir();
    // Every file read for one push is issued at once and awaited together;
    // the per-session trio below likewise. Nothing here blocks the loop.
    const [usage, announcement, syncWarnings, syncMarkerRaw, backupMeta, syncLockIsDir, perSession] = await Promise.all([
      readJsonFile(usageCachePath),
      readJsonFile(announcementCachePath),
      readSyncWarnings(),
      readTextFile(path.join(home, '.claude', 'toolkit-state', '.sync-marker')),
      readJsonFile(path.join(home, '.claude', 'backup-meta.json')),
      fs.promises.stat(path.join(home, '.claude', 'toolkit-state', '.sync-lock')).then((s) => s.isDirectory(), () => false),
      Promise.all([...sessionIdMap].map(async ([desktopId, claudeId]) => {
        // WHY: .gitbranch comes from Claude Code's status line, which native sessions lack.
        const live = sessionManager.getSession(desktopId);
        const nativeCwd = live?.provider === 'native' ? live.cwd : null;
        const [context, branch, stats] = await Promise.all([
          readTextFile(path.join(home, '.claude', `.context-${claudeId}`)),
          nativeCwd ? gitBranchLabel(nativeCwd) : readTextFile(path.join(home, '.claude', `.gitbranch-${claudeId}`)),
          readJsonFile(path.join(home, '.claude', `.session-stats-${claudeId}.json`)),
        ]);
        return { desktopId, context, branch, stats };
      })),
    ]);
    const updateStatus = getUpdateStatus();

    // Sync state for live updates — SyncPanel also fetches via IPC,
    // but these fields let the compact section row update in real-time.
    // Self recency comes from sync-spaces evidence FIRST (the persisted
    // lastSync map); the legacy .sync-marker survives as a fallback/max for
    // Drive/iCloud-only installs. WHY: the marker is absent on GitHub-era
    // installs, so reading only it showed "last seen 22 hours ago" on a
    // machine that was (supposedly) syncing every 90 seconds (2026-07-30 spec §4).
    const lastSyncEpoch = deriveSelfLastSyncEpochSec(getSelfLastSyncEpochMs(), syncMarkerRaw);
    // Live spaces syncing OR the legacy lock dir (extra-backups pushes).
    const syncInProgress = isSyncSpacesSyncing() || syncLockIsDir;
    // Per-device sync recency (machineId → epoch-ms), carried over the SyncHub.
    // Rides the live push so the "Your devices" rows update in real-time without
    // waiting for a full getSyncStatus() refetch. Forwarded verbatim to remote
    // browsers via broadcastStatusData (no reshape). Empty when the hub is down.
    const lastSyncByDevice = getLastSyncByDevice();

    // Read per-session context remaining % (written by statusline.sh)
    const contextMap: Record<string, number> = {};
    for (const { desktopId, context: raw } of perSession) {
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
    for (const { desktopId, branch: raw } of perSession) {
      if (raw) {
        gitBranchMap[desktopId] = raw;
        lastGitBranchByDesktopId[desktopId] = raw;
      } else if (desktopId in lastGitBranchByDesktopId) {
        gitBranchMap[desktopId] = lastGitBranchByDesktopId[desktopId];
      }
    }

    // Read per-session stats (cost, tokens, code changes — written by statusline.sh)
    const sessionStatsMap: Record<string, any> = {};
    for (const { desktopId, stats } of perSession) {
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

  // Single-flight: an attention change that lands while the 10 s build is in
  // progress joins it instead of racing a second build that could send an
  // older payload after a newer one.
  let statusBuildInFlight: ReturnType<typeof buildStatusData> | null = null;
  function buildStatusDataShared(): ReturnType<typeof buildStatusData> {
    if (!statusBuildInFlight) {
      statusBuildInFlight = buildStatusData().finally(() => { statusBuildInFlight = null; });
    }
    return statusBuildInFlight;
  }
  // Push status data every 10 s while anyone can see it, deduplicated, pushed at
  // once on the first look back — WHY and rules: status-push-gate.ts (audit W2).
  const statusPush = startStatusPushGate({
    build: buildStatusDataShared,
    // Feed full status data to remote server for browser clients (single polling source)
    deliver: (data) => { send(IPC.STATUS_DATA, data); if (remoteServer) remoteServer.broadcastStatusData(data); },
    mainWindow, windowRegistry, remoteServer,
  });
  setSyncHealthGate(statusPush.hasAudience); // the sync health check asks the same question (audit W12)
  // WHY (one-core R5-1): the per-session summary rides its own push beside attentionMap; a phone's dots and attention sound read it (R5-3).
  const summaryPush = startSessionSummaryPush({
    records: runtime.records,
    deliver: (payload) => { send(SESSION_SUMMARY_CHANNEL, payload); remoteServer?.broadcast({ type: SESSION_SUMMARY_CHANNEL, payload }); },
    hasAudience: statusPush.hasAudience,
    onPhoneConnected: remoteServer ? (listener) => remoteServer.onStatusChange((status) => { if (status.clientCount > 0) listener(); }) : undefined,
    hasPhone: () => (remoteServer?.getClientCount() ?? 0) > 0,
  });
  // WHY (one-core R5-3): a dot a phone draws from the summary must change when the session does, not on the next 10 s tick.
  runtime.records.onSummaryChange(() => summaryPush.notify());

  // Also push immediately on first hook event (session is active)
  let sentInitialStatus = false;
  if (hookRelay) {
    hookRelay.on('hook-event', () => {
      if (!sentInitialStatus) {
        sentInitialStatus = true;
        statusPush.push();
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
  // (sessionIdMap — desktop session ID → Claude Code session ID — now lives in the runtime's
  // session-state.ts, shared by every handler group; see the destructure at the top.)
  const nativeStarting = new Set<string>();
  const nativeExited = new Set<string>();
  const admittedResumes = new Set<string>();
  const awaitingFirstResumeHook = new Set<string>();
  // Welcome back (design §2): desktop ids the store has already been told to
  // `track()`, so the first-user-message hook (below) fires the store write
  // exactly ONCE per session instead of on every subsequent message — the
  // store's own track() is a plain overwrite-and-persist with no such guard
  // (design §1: "changes are a handful per session", not one per turn).
  const welcomeBackTracked = new Set<string>();
  const trackWelcomeBack = (desktopId: string, conversationId: string, provider: WelcomeBackProvider) => {
    if (!welcomeBackStore || welcomeBackTracked.has(desktopId)) return;
    welcomeBackTracked.add(desktopId);
    welcomeBackStore.track(desktopId, conversationId, provider);
  };
  const untrackWelcomeBack = (desktopId: string) => {
    welcomeBackTracked.delete(desktopId);
    welcomeBackStore?.untrack(desktopId);
  };
  const resumeAdmission = createResumeAdmission<SessionInfo>({
    acquire: (id) => leaseWiring!.client.acquire(id),
    release: (id) => leaseWiring!.client.release(id),
    // WHY (combined branch: master's resume admission x bugfix-chatfiles'
    // already-open guard): one lookup for "is this conversation open here".
    // Master's identity-map walk first; chatfiles' lookup then also matches a native session by its own id (a native desktop id IS its
    // conversation id, before the identity map is written) and a Claude Code
    // resume still waiting for its first hook (resumedConversationOf).
    getLive: (id) => {
      for (const [desktopId, claudeId] of sessionIdMap) {
        if (claudeId === id) {
          const info = sessionManager.getSession(desktopId);
          if (info) return info;
        }
      }
      return findLiveSessionForConversation(id, sessionManager.listSessions?.() ?? [],
        (desktopId) => sessionIdMap.get(desktopId) ?? sessionManager.resumedConversationOf?.(desktopId));
    },
  });
  // WHY: Task 5 must attach transport routes to this SAME admission/session
  // owner; no separate requester may turn lease release into freshness.
  const handoffAttempts = leaseWiring ? createHandoffAttempts({
    deviceId: leaseWiring.deviceId, admission: resumeAdmission,
    validate: (context, opts: Parameters<SessionManager['createSession']>[0]) =>
      opts.resumeSessionId === context.sessionId && opts.provider === context.provider &&
      typeof opts.name === 'string' && opts.name.length <= 512 && typeof opts.skipPermissions === 'boolean' &&
      (opts.model === undefined || typeof opts.model === 'string') &&
      (opts.binding === undefined || (typeof opts.binding === 'object' && opts.binding !== null)),
    query: (id) => leaseWiring.client.query(id),
    takeover: (id, nonce) => leaseWiring.client.takeover(id, nonce),
    // WHY: only the hub's atomic compare-and-swap may grant separate force consent.
    forceIfHolder: (id, expected) => hubLeaseRequest('force-acquire-if-holder', id, leaseWiring.deviceId, undefined, expected),
    releaseForced: (id) => leaseWiring.client.release(id),
    sync: () => syncSpacesSyncNowAwaited('personal', HANDOFF_SYNC_TIMEOUT_MS),
    confirm: importConfirmedHandoff, pin: pinHandoffDestination, project: resolveHandoffProject,
    savedProject: resolveSavedHandoffProject,
    delay: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    start: (owner, context, cwd, check, opts: Parameters<SessionManager['createSession']>[0]) => {
      check();
      if (opts.resumeSessionId !== context.sessionId || opts.provider !== context.provider)
        throw new Error('Handoff create options do not match the verified transcript.');
      const sender = owner.startsWith('window:') ? webContents.fromId(Number(owner.slice(7))) : null;
      if (owner.startsWith('window:') && !sender) throw new Error('The requesting window closed.');
      return startSession(sender ? { sender } : null, { ...opts, cwd }, check);
    },
    dispose: async (info: SessionInfo) => {
      // WHY: destroySession only requests a PTY kill; cancellation must wait
      // for the worker's proven exit before relinquishing lease authority.
      if (info.provider === 'claude') {
        if ((await sessionManager.stopSessionForHandoff(info.id)).status !== 'stopped')
          throw new Error('Canceled writer stop is unproven.');
      } else {
        await nativeHost.destroy(info.id);
        if (!sessionManager.destroySession(info.id)) throw new Error('Attempt writer could not be stopped.');
      }
      sessionIdMap.delete(info.id);
      windowRegistry?.endSession(info.id); // the attempt's writer is gone: nothing left to watch (R5-3)
    },
  }) : null;
  const handoffRoute = createHandoffTransport(handoffAttempts);
  bindHandoffRoute(handoffRoute); // WHY (2026-09-30 one-core R3-5): handoff:* are table entries (main/ipc/handoff.ts) for windows AND phones.
  remoteServer?.setHandoffRoute?.(handoffRoute);
  const transferredExit = createTransferredExitGate(resumeAdmission,
    (sessionId) => handoffAttempts?.hasSession(sessionId) ?? false,
    (sessionId) => handoffAttempts?.ended(sessionId));
  // Where each session's transcript lives, for the paged-history handler to
  // fall back on whenever the transcript watcher cannot say — see
  // transcript-page-source.ts for the three ordinary moments when it cannot.
  const pageSources = new TranscriptPageSources();
  const transcriptWatcher = new TranscriptWatcher();
  // WHY: expected exit removes the map, but a /clear remap (including a
  // round-trip) must permanently invalidate a captured writer generation.
  const writerGenerations = new Map<string, number>();
  const handoffExpectedExits = new Set<string>();
  const resumePageBoundaries = new Map<string, { jsonlPath: string; offset: number }>();

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
      markExpectedExit: (id) => handoffExpectedExits.add(id),
      clearExpectedExit: (id) => { handoffExpectedExits.delete(id); },
      flushSessionToSpace, pushMoved,
      withAdmissionHandoff: (id, teardown) => resumeAdmission.handoff(id, teardown),
      senderDeviceId: leaseWiring.deviceId,
      pinSnapshot: pinHandoffDestination,
      protectUnsafe: (id) => resumeAdmission.protect(id),
      publishSnapshot: publishStoppedHandoff,
      syncPublished: syncPublishedHandoff,
      captureWriter: (desktopId, conversationId) => {
        const info = sessionManager.getSession(desktopId);
        if (!info || sessionIdMap.get(desktopId) !== conversationId ||
            (info.provider !== 'claude' && info.provider !== 'native')) return null;
        const provider = info.provider;
        const native = provider === 'native' ? nativeHost.captureHandoffWriter(desktopId) : null;
        const watched = provider === 'claude' ? transcriptWatcher.pageSourceFor(desktopId) : null;
        const source = provider === 'native' ? native?.transcriptPath : watched?.jsonlPath;
        const projectCwd = provider === 'native' ? native?.projectCwd : watched?.cwd;
        if (!source || !projectCwd) return null;
        const generation = writerGenerations.get(desktopId) ?? 0;
        return {
          provider, sessionId: conversationId, transcriptPath: source, projectCwd,
          persisted: () => provider === 'claude' || !!native?.persisted(),
          current: () => {
            if ((writerGenerations.get(desktopId) ?? 0) !== generation) return false;
            const live = sessionManager.getSession(desktopId);
            if (live) return live.provider === provider && sessionIdMap.get(desktopId) === conversationId &&
              (provider === 'native' ? nativeHost.captureHandoffWriter(desktopId)?.transcriptPath === source &&
                nativeHost.captureHandoffWriter(desktopId)?.projectCwd === projectCwd :
                transcriptWatcher.pageSourceFor(desktopId)?.jsonlPath === source &&
                transcriptWatcher.pageSourceFor(desktopId)?.cwd === projectCwd);
            // Only the captured session's ordinary exit may remove its mapping.
            return handoffExpectedExits.has(desktopId) && !sessionIdMap.has(desktopId);
          },
        };
      },
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
      endQuiesceNative: (id) => nativeHost.endQuiesce(id),
      // Welcome back (design §2): a holder takeover means the conversation now
      // lives on another device, so it is no longer "open here" — untrack
      // wherever this flow calls sessionManager.destroySession directly
      // (bypassing SESSION_DESTROY, which has its own untrack call).
      untrackWelcomeBack: (id) => untrackWelcomeBack(id),
    });
    // Fire-and-forget from a hub event — the handler never throws (each step is
    // try/caught inside createHolderTakeover), so void is safe.
    leaseWiring.setHolderTakeover((sid, from, transferNonce) => { void holderTakeover(sid, from, transferNonce); });
  }

  // WHY (2026-10-01 one-core R3-8): remote:attention-changed is a table entry (main/ipc/app.ts); this hands it the cache above and
  // the status relay. A window says a session's attention classifier changed.
  bindApp({
    attentionChanged: (payload) => {
      if (!payload?.sessionId) return;
      lastAttentionBySession.set(payload.sessionId, payload.state);
      // The record holds the same relayed value (one-core R5-1); R5-4 retires the second cache.
      runtime.records.noteReportedAttention(payload.sessionId, payload.state);
      // Broadcast immediately so remote clients see the change without waiting for the 10s status:data timer. The rebuild is
      // async and shared (C5).
      if (remoteServer) {
        void buildStatusDataShared().then((data) => remoteServer?.broadcastStatusData(data));
      }
      summaryPush.push(); // the summary carries the same attention value, so it follows at once too
    },
  });
  // The computer's own "may be stuck" reading (one-core R5-4b) joins the same cache and relay a window's report fills, so the status bar and the
  // tray are right with no window open. The record already holds it (it is the event), and its summary change pushes the dot.
  onMainAttention = (sessionId, state) => {
    lastAttentionBySession.set(sessionId, state);
    if (remoteServer) void buildStatusDataShared().then((data) => remoteServer?.broadcastStatusData(data));
  };

  // (lastModelSeen — last model id written per CLAUDE session id — lives in session-state.ts.)

  transcriptWatcher.on('transcript-event', (event: any) => {
    publish(event.sessionId, IPC.TRANSCRIPT_EVENT, event);
    liveFacts.noteTranscript(event.sessionId, event); // a refused /model, a card Claude Code has moved past (R5-4a)
    // Conversation Store (Phase 2a): feed live activity into the record store.
    // event.sessionId is the DESKTOP id; the store keys by CLAUDE id, so resolve
    // via sessionIdMap and skip if we haven't seen the mapping yet (a hook event
    // establishes it — the reconciler backfills anything missed before then).
    const claudeId = sessionIdMap.get(event.sessionId);
    // This listener is on the CC TranscriptWatcher only — native transcript
    // events are routed separately (Task 4 wires the native listener's feed).
    if (claudeId) noteTranscriptEvent(claudeId, event, 'claude');
    // Welcome back (design §2): a session with no messages yet isn't
    // remembered (S-sent) — this is where a brand-new (non-resume) session
    // earns its spot, the moment its first user message actually lands.
    // trackWelcomeBack no-ops after the first call, so later messages are free.
    if (claudeId && event.type === 'user-message') trackWelcomeBack(event.sessionId, claudeId, 'claude');
    // Claude Code sessions are named by the SAME policy as native ones: this
    // tailer emits 'turn-complete' only when stop_reason !== 'tool_use', so a
    // turn that ran twenty tools counts as the one reply it is.
    sessionNamer.noteEvent(event);
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

  // --- Native runtime stack ---
  // WHY (2026-09-29 one-core R1): the whole native runtime (NativeHome, ProviderRegistry,
  // EngineManager, NativeSessionHost, ModelManager, the session namer, …) is now built ONCE
  // by createRuntime() in main.ts and handed to this door AND to RemoteServer, so both reach
  // the same instances by construction. This block only unpacks what the handlers below use.
  const {
    permissionStore, stepGuardSettings, contextSettings, secretsStore, engineManager,
    chatgptAuth: chatgptForUi, providerRegistry, openRouterSignIn, modelCatalog, claudeAccount,
    searchKeyStore, searchService, specialistCatalog, nativeHost, modelManager, namingSettings,
    sessionNamer, applyAutomaticTitle, queueTitle, publishNamingMode, resolvePortableModel,
    stampProviderTypes,
  } = runtime;
  // The core announces an automatic title; this door paints it: the owning window (and
  // buddy subscribers) plus phones and the window directory — the same two calls the
  // inline applyAutomaticTitle made before the hoist.
  runtime.onTitleApplied((desktopId, title) => {
    sendForSession(desktopId, IPC.SESSION_RENAMED, [desktopId, title]);
    broadcastRename(desktopId, title);
  });

  // Native transcript events ride the SAME channel as CC's — the reducer
  // consumes an identical event shape regardless of runtime.
  nativeHost.on('transcript-event', (event: TranscriptEvent) => {
    publish(event.sessionId, IPC.TRANSCRIPT_EVENT, event);
    // WHY: this is the single line that makes native conversations exist in
    // the store (design §5); Task 3 made it correct rather than mislabeling.
    // Native ids are identity-mapped (sessionIdMap.set(info.id, info.id) in
    // the SESSION_CREATE native branch above), so — unlike the CC listener
    // below, which resolves through sessionIdMap — event.sessionId IS already
    // the store's record id; no lookup needed.
    noteTranscriptEvent(event.sessionId, event, 'native');
    // Welcome back (design §2): same first-message rule as the Claude feed
    // above. Native ids are identity-mapped (see the comment above this
    // listener), so event.sessionId IS already the conversation id — no
    // sessionIdMap lookup needed here.
    if (event.type === 'user-message') trackWelcomeBack(event.sessionId, event.sessionId, 'native');
    // Feed the SAME event stream into the namer. Pure/injected logic — see
    // session-namer.ts — never throws synchronously.
    sessionNamer.noteEvent(event);
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

  // Native permission asks ride the SAME hook:event channel as CC's PermissionRequest/PermissionExpired —
  // hook-dispatcher/ToolCard render them unchanged. Ids are 'native-'-prefixed so permission:respond routes by id.
  // A screen that opens later learns which asks are still waiting from the host's broker (session-open.ts), not from a buffer here.
  nativeHost.on('hook-event', (event: HookEvent) => {
    publish(event.sessionId, IPC.HOOK_EVENT, event);
  });

  // Task 8 (plan 1c) — the ledger's own write is the ONLY thing that fires
  // this (see the 'specialists-event' emit in NativeSessionHost's
  // constructor, next to DelegationLedger's construction): one mutate, one
  // event, one changed hire. Push-only — there is no specialists:event
  // REQUEST handler anywhere, same shape as native:model-state. A screen that opens later gets the latest run per helper
  // from the host's ledger (session-open.ts).
  nativeHost.on('specialists-event', (event: SpecialistsEvent) => {
    publish(event.sessionId, IPC.SPECIALISTS_EVENT, event);
  });

  // What this session was given, pushed once when it opens (contract R23: every
  // chat carries the line). Push-only, like specialists:event and shell-event
  // below — there is no request handler, because nothing asks: the strip is part
  // of the session's own opening. A screen that opens later is handed the record by session:open.
  nativeHost.on('session-context', (event: { sessionId: string; context: unknown }) => {
    publish(event.sessionId, IPC.NATIVE_SESSION_CONTEXT, event);
  });

  // G-1: one background command's run record changed. Same shape as specialists:event — push-only; there is no request
  // handler, and a screen that opens later gets the latest run per command from the host (session-open.ts).
  nativeHost.on('shell-event', (event: ShellEvent) => {
    publish(event.sessionId, IPC.NATIVE_SHELL_EVENT, event);
  });

  // Perf cycle 2: paged history. A screen asks for the NEWEST page (beforeCursor null) and, as the reader scrolls up, for
  // each older one. Request/response — unlike the whole-transcript replay this replaced, which streamed every historical
  // event back over TRANSCRIPT_EVENT and cost ~22s of main + renderer work on a huge conversation.
  //
  // WHY ONE BODY (2026-10-01 one-core R5-2): the computer's window and a phone used to be served by two functions
  // (desktopTranscriptPage and phoneTranscriptPage), and the phone's had none of the resume-boundary
  // reconcile, so a resumed Claude Code session showed its interrupted tool cards as still running on a phone. A page does
  // not depend on who asks: it depends on the session. The only thing the old computer body used the asking window for
  // was the "inherited by transfer" mark (read to EOF for a window that missed the live stream); `toEnd` says that
  // directly, and `session:open` (session-open.ts) always sets it, so the mark and its registry bookkeeping are gone.
  const transcriptPage = async (req: TranscriptPageRequest): Promise<TranscriptPageResult> => {
    const empty: TranscriptPageResult = { events: [], cursor: null, hasMore: false };
    if (!req || typeof req.sessionId !== 'string') return empty;
    const { sessionId, beforeCursor } = req;
    // A screen that opens, or whose renderer was rebuilt, missed the live stream: its first page reads to EOF.
    const readToEnd = !beforeCursor && req.toEnd === true;

    // Native sessions page over the merged event array; getHistoryPage returns
    // null for non-native ids, so CC's watcher stays the source for claude
    // sessions — the same discrimination the replay handler uses.
    const idleBeforeRead = nativeHost.isLive(sessionId) && nativeHost.isIdle(sessionId);
    let nativePage: Awaited<ReturnType<typeof nativeHost.getHistoryPageAsync>>;
    // An existing-but-unreadable native transcript throws: answer `unresolved` (retry), never an empty beginning.
    try { nativePage = await nativeHost.getHistoryPageAsync(sessionId, beforeCursor ? beforeCursor.offset : null); }
    catch { return { ...empty, unresolved: true }; }
    if (nativePage !== null) {
      return {
        events: nativePage.events,
        // `offset` carries an ARRAY INDEX for native sources; opaque to the renderer.
        cursor: nativePage.hasMore ? { path: `native:${sessionId}`, offset: nativePage.nextIndex!, sizeAtRead: 0 } : null,
        hasMore: nativePage.hasMore,
        reconcileInterrupted: shouldReconcileNativePage({ nativeIdle: idleBeforeRead && nativeHost.isIdle(sessionId), olderPage: !!beforeCursor }),
      };
    }

    let source: ResolvedPageSource | null = transcriptWatcher.pageSourceFor(sessionId);
    if (!source) {
      // No watcher yet (pre-hook resume), anymore (exit), or ever (buddy).
      // Resolve from validated locator ids supplied now or on the first page;
      // later scroll-up requests carry only the cursor, not those ids.
      pageSources.rememberLocator(sessionId, req.claudeSessionId, req.projectSlug);
      source = pageSources.get(sessionId);
      // The id may itself be the conversation's transcript id (what the old phone body probed the projects folder for).
      // Checked last, and only for an id that passes the plain-id gate, before it can shape a path.
      if (!source && SAFE_ID_RE.test(sessionId)) {
        const found = await findTranscriptSlug(sessionId, req.projectSlug);
        if (found.slug) {
          const jsonlPath = path.join(found.projectsDir, found.slug, sessionId + '.jsonl');
          source = { jsonlPath, subagentsDir: path.join(path.dirname(jsonlPath), sessionId, 'subagents'), startOffset: 0 };
        }
      }
      // NOT `empty`: "I cannot find the file" and "this is the beginning of the
      // conversation" were the same answer until 2026-09-07, and the renderer
      // acted on the second — dropping the cursor and the scroll-up sentinel
      // for good. Say which one this is so the caller can retry.
      if (!source) return { ...empty, unresolved: true };
    }
    // The first page stops at the watcher cutoff; zero, a screen that opened or a rebuilt renderer reads to EOF.
    // HISTORY_PAGE_LOADED dedups any overlap against the live seenUuids.
    const saved = resumePageBoundaries.get(sessionId);
    const resumeOffset = saved?.jsonlPath === source.jsonlPath ? saved.offset : null;
    const endOffset = beforeCursor ? beforeCursor.offset : (readToEnd ? null : (source.startOffset || null));
    const page = await readTranscriptPage({
      jsonlPath: source.jsonlPath, sessionId, endOffset, subagentsDir: source.subagentsDir,
    });
    // Preserve the entire page (including new output before SessionStart), but
    // reap ONLY tools that began before spawn. A watcher cutoff can be too late.
    const entirelyOld = resumeOffset != null && !!beforeCursor && beforeCursor.offset <= resumeOffset;
    const reconcile = resumeOffset != null && !entirelyOld;
    const old = reconcile ? await readTranscriptPage({ jsonlPath: source.jsonlPath,
      sessionId, endOffset: resumeOffset }) : null;
    return { ...page, reconcileInterrupted: entirelyOld, reconcileInterruptedToolIds: old
      ? [...new Set(old.events.filter(ev => ev.type === 'tool-use').map(ev => ev.data.toolUseId).filter((id): id is string => !!id))]
      : undefined };
  };


  // WHY (2026-09-30 one-core R3-5): the native:* request channels (send, queue, interrupt, compact, models,
  // permission mode, context prefs, step guard, sessions-list, kill-shell, admin password, context text) are
  // table entries (main/ipc/native.ts). The PUSH below stays here: it fans out to windows and phones as before.
  // Push every seeded or changed mode to each window showing the session AND
  // every phone. WHY: the get above can answer before a starting session has
  // its mode, and a change made in one window or on the phone used to reach
  // only the caller — so chips elsewhere could show a stricter mode than the
  // session was really running on. The host emits from ONE place (seedMode /
  // setPermissionMode), so both the IPC and the remote set paths are covered.
  // One-core R5-4a: the messages waiting behind a running turn, as the host holds them, so EVERY screen draws (and can cancel) the same strip.
  nativeHost.on('queue-changed', (e: { sessionId: string; queue: { queueId: string; content: string; timestamp: number }[] }) => {
    publish(e.sessionId, IPC.SESSION_LIVE, { sessionId: e.sessionId, kind: 'queue', queue: e.queue });
  });
  // A native compaction began or ended without a summary line (stopped or refused): the spinner on every screen.
  nativeHost.on('compaction', (e: { sessionId: string; phase: 'start' | 'end'; outcome?: 'cancelled' | 'failed' }) => {
    if (e.phase === 'start') liveFacts.compactStarted(e.sessionId);
    else liveFacts.compactEnded(e.sessionId, e.outcome ?? 'failed');
  });
  // A native session's model changed (the picker, from any screen): the label on every screen.
  nativeHost.on('model-changed', (e: { sessionId: string; model: string }) => {
    publish(e.sessionId, IPC.SESSION_LIVE, { sessionId: e.sessionId, kind: 'model', model: e.model });
  });
  nativeHost.on('permission-mode', (e: { sessionId: string; mode: NativePermissionMode }) => {
    publish(e.sessionId, IPC.NATIVE_PERMISSION_MODE, e);
  });
  // WHY (2026-09-30 one-core R3-6): provider:*, chatgpt:*, openrouter:*, claude-code:*, search:*, engine:*,
  // models:* and endpoints:detect request channels are table entries (main/ipc/provider.ts, chatgpt.ts,
  // openrouter.ts, claude-code.ts, search.ts, engine.ts, models.ts). Their PUSHES (engine:install-progress,
  // engine:status-changed, models:download-progress ...) stay below: they fan out to windows and phones as before.
  // WHY (2026-09-30 one-core R3-5): permissions:* and specialists:* request channels are table entries
  // (main/ipc/permissions.ts, specialists.ts); their pushes (specialists:event ...) are sent from the ledger wiring above.
  // --- Local engine pushes (Plan B) ---
  // Install progress + run-state transitions → every window + remotes.
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
        publish(sessionId, IPC.NATIVE_MODEL_STATE, full);
      }
    }
  });
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

  // /clear and /compact both truncate or rewrite the JSONL. App.tsx listens
  // to detect compaction completion (pending → COMPACTION_COMPLETE).
  transcriptWatcher.on('transcript-shrink', (payload: any) => {
    publish(payload.sessionId, IPC.TRANSCRIPT_SHRINK, payload);
  });

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

  // Async (2026-09-16 C5): the polling fallback below read this synchronously
  // every 2 s for every session that fell into it — which was every session,
  // because the topic file rarely exists when the session starts.
  async function readTopicFile(claudeSessionId: string): Promise<string | null> {
    try {
      const content = (await fs.promises.readFile(path.join(topicDir, `topic-${claudeSessionId}`), 'utf8')).trim();
      return content || null;
    } catch {
      return null;
    }
  }

  const pendingWatchers = new Set<string>();

  /**
   * Apply a topic the Auto-Title hook wrote. The hook asks the conversation's
   * OWN model, in-session, so this is the free naming lane for Claude Code —
   * but it is still automatic naming, so it goes through the same ownership
   * gate and the same persist-then-paint order as everything else.
   */
  async function applyTopic(desktopId: string, claudeId: string, topic: string): Promise<void> {
    try {
      const applied = await applyAutomaticTitle(desktopId, claudeId, 'claude', topic);
      // Recorded even when REFUSED (the user owns the name). This map's job is
      // "have I already dealt with this exact topic string" — not "did I paint
      // it". The polling fallback re-reads every 2s, so a refused topic left
      // unrecorded meant an ownership read plus a conflict-directory scan every
      // two seconds, per manually-named session, for the life of the session.
      lastTopics.set(desktopId, topic);
      if (!applied) return;
      // A topic that landed is also a completed review: advance the cursor so
      // the next ask is the next SCHEDULED one. (applyAutomaticTitle already
      // recorded the name itself.)
      await mutateNamingRecord('claude', claudeId, (cur) => ({
        ...cur, reviewed: Math.max(cur.reviewed, cur.replies),
      }));
    } catch { /* best-effort: the next topic write retries */ }
  }

  function startWatching(desktopId: string, claudeId: string) {
    if (topicWatchers.has(desktopId) || pendingWatchers.has(desktopId)) return;
    pendingWatchers.add(desktopId);

    // Read initial value
    void readTopicFile(claudeId).then((initial) => {
      // Torn down (a /clear remap or exit) while the read was in flight: the
      // topic belongs to a session id this desktop id no longer maps to.
      if (!topicWatchers.has(desktopId)) return;
      if (initial && initial !== 'New Session') {
        // lastTopics is set only if the title was actually APPLIED. A topic
        // refused because the user owns the name must stay un-recorded, or a
        // later Use-automatic-name would find it "unchanged" and never repaint.
        void applyTopic(desktopId, claudeId, initial);
      }
    });

    attachTopicWatch(desktopId, claudeId);
  }

  /** Prefer fs.watch for efficiency; fall back to polling if watch fails
   *  (e.g., on network filesystems or platforms with limited inotify), or when
   *  the file does not exist yet — the poll upgrades back to a watch once it does. */
  function attachTopicWatch(desktopId: string, claudeId: string) {
    const topicFilePath = path.join(topicDir, `topic-${claudeId}`);
    try {
      const watcher: fs.FSWatcher = fs.watch(topicFilePath, { persistent: false }, (eventType) => {
        // WHY the rename branch (review, 2026-09-16): the hook's daily prune
        // deletes topic files older than 30 days and recreates them on a new
        // inode; Linux reports that as 'rename' and the old watch goes dead
        // without an 'error'. Fall back to the poll, which re-attaches a watch
        // the moment the file reads again.
        if (eventType === 'rename') {
          watcher.close();
          if (topicWatchers.get(desktopId) === watcher) { topicWatchers.delete(desktopId); startPolling(desktopId, claudeId); }
          return;
        }
        void readTopicFile(claudeId).then((topic) => {
          if (topicWatchers.get(desktopId) !== watcher) return; // torn down or replaced mid-read
          if (topic && topic !== 'New Session' && topic !== lastTopics.get(desktopId)) {
            void applyTopic(desktopId, claudeId, topic);
          }
        });
      });
      watcher.on('error', () => {
        // File may not exist yet — fall back to polling
        watcher.close();
        if (topicWatchers.get(desktopId) === watcher) topicWatchers.delete(desktopId);
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
      void readTopicFile(claudeId).then((topic) => {
        if (topicWatchers.get(desktopId) !== interval) return; // torn down or replaced mid-read
        if (topic && topic !== 'New Session' && topic !== lastTopics.get(desktopId)) {
          void applyTopic(desktopId, claudeId, topic);
        }
        // WHY upgrade (2026-09-16 C5): the poll used to run for the session's
        // whole life once it started, because nothing re-tried fs.watch after
        // the file appeared. Once a read succeeds the file exists, so hand the
        // session back to the watcher; if that attach fails it falls back here.
        if (topic !== null && topicWatchers.get(desktopId) === interval) {
          clearInterval(interval);
          topicWatchers.delete(desktopId);
          attachTopicWatch(desktopId, claudeId);
        }
      });
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
      // A resumed CC identity is registered before spawn. Its matching first
      // SessionStart still must install transcript watchers, but not reacquire.
      const firstAdmittedStart = awaitingFirstResumeHook.has(desktopId) && current === claudeId
        && hookEventName === 'SessionStart';
      if (!firstAdmittedStart && resolveMappingAction(current, claudeId, hookEventName, source) !== 'adopt') {
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
        // One-core R5-4a: Claude Code's own `source: "clear"` says this rotation is a /clear, so every screen draws "Conversation cleared"
        // (it used to be drawn only by the screen that typed it, and could double on a phone that typed it too).
        liveFacts.noteSessionStart(desktopId, source, claudeId);
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
      awaitingFirstResumeHook.delete(desktopId);
      if (current && current !== claudeId) {
        runtime.records.startNewTranscript(desktopId); // /clear or an in-session /resume: the pre-rotation messages are no longer what a screen shows
        admittedResumes.delete(desktopId);
        teardownSessionWatchers(desktopId);
        // 2b: /clear rotates the CC session id WITHOUT firing session-exit, so the
        // pre-rotation claudeId's lease + its 30s renew timer would otherwise leak
        // (renewing a dead id every 30s until app quit). Release it here.
        // Idempotent + best-effort; release() never rejects, .catch guards a future change.
        if (leaseWiring) resumeAdmission.end(current);
      }

      writerGenerations.set(desktopId, (writerGenerations.get(desktopId) ?? 0) + 1);
      sessionIdMap.set(desktopId, claudeId);
      // Welcome back (design §2): keep a tracked session's remembered
      // conversation id in sync with a rotation (/clear, in-session /resume).
      // A no-op if `desktopId` isn't tracked yet — this fires for every
      // mapping change, tracked or not.
      welcomeBackStore?.remap(desktopId, claudeId);
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
        // Resumed ids already acquired before spawn. New identities (including
        // in-session /resume) acquire here; a confirmed denial must stop their
        // writer rather than leave it running without authority. An unavailable
        // hub still permits offline access. No lease when sync is disabled.
        if (leaseWiring && !admittedResumes.has(desktopId) && leasesEnabled()) {
          void leaseWiring.client.acquire(claudeId)
            .then((res) => {
              if (res && res.ok === false) {
                log('WARN', 'Lease', 'stopping session denied its lease', { claudeId, holder: res.holder });
                if (sessionIdMap.get(desktopId) === claudeId && sessionManager.getSession(desktopId)) {
                  sessionManager.destroySession(desktopId);
                }
              }
            })
            .catch(() => { /* never-block */ });
        }
      }
    });
  }

  // WHY: a PTY exit frame, not the early session-exit from destroySession,
  // is the proof needed to release a transferred Claude writer's pin.
  sessionManager.on('session-stopped', transferredExit.onStopped);
  // Stop watching when a session is destroyed
  sessionManager.on('session-exit', (sessionId: string) => {
    if (nativeStarting.has(sessionId)) nativeExited.add(sessionId);
    teardownSessionWatchers(sessionId);
    // WHY: exit also occurs without SESSION_DESTROY. Coordinate the native
    // append-chain drain with lease release; a failed stop must retain the hold.
    const isNative = sessionManager.getSession(sessionId)?.provider === 'native';
    const stop = nativeHost.destroy(sessionId);
    // WHY: capture provider before the await; SessionManager deletes its entry after emit.
    void stop.then(() => { if (isNative) handoffAttempts?.ended(sessionId); },
      (e) => log('ERROR', 'IPC', 'native teardown on session-exit failed', { sessionId, error: String(e) }));
    // Task 7: same backstop reasoning as the destroy() call above — this
    // path also covers crashes/takeovers that never went through
    // SESSION_DESTROY, so the feeder's per-session state needs the same
    // cleanup here too.
    sessionNamer.forget(sessionId);
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
      // A teardown from a previous writer must not free a successor's lease.
      // The holder handoff releases explicitly only after the writer stops.
      const anotherWriter = [...sessionIdMap.entries()].some(([did, cid]) =>
        did !== sessionId && cid === claudeId && !!sessionManager.getSession(did));
      if (!anotherWriter && !resumeAdmission.isHandingOff(claudeId)) {
        // WHY: all destroy callers share this event. Its early emission by
        // SessionManager must not release a transferred writer's hub lease.
        if (!transferredExit.onExit(sessionId, claudeId, stop) && leaseWiring)
          resumeAdmission.markExit(claudeId, stop);
      }
      // WHY (2026-09-16, per-session-maps investigation): the last-model
      // dedupe is keyed by CLAUDE id and was never cleared, so every
      // conversation opened this run left a string behind for the life of the
      // process. Resolved here, while the claude id is still known.
      lastModelSeen.delete(claudeId);
    }
    sessionIdMap.delete(sessionId);
    admittedResumes.delete(sessionId);
    awaitingFirstResumeHook.delete(sessionId);
    lastAttentionBySession.delete(sessionId);
    // Same investigation: the per-session model-state signature (native
    // sessions) had no removal path either.
    lastSessionModelState.delete(sessionId);
    // And the attention aggregate in main.ts only ever forgot a session when
    // its renderer volunteered `{ clear: true }` — a session that died
    // without one kept reporting its last state in every window's summary.
    forgetSessionAttention(sessionId);
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
  const canWriteStoreRecord = (sessionId: string): boolean => {
    return sessionIdMap.has(sessionId) || !sessionManager.getSession(sessionId);
  };

  // WHY (2026-09-30 one-core R3-7): the phone's "which conversation is this session" lookup (setSessionMetaWiring) is gone:
  // the file channels read the runtime's one id map directly (ipc/artifacts.ts).

  // session:menu-lock / :set-flag / :set-tag are table entries (main/ipc/session.ts).

  // --- Set/clear a session note ---
  /* ── Session naming ────────────────────────────────────────────────────
   * Four handlers: the Assistant-settings preference, and per-conversation
   * name ownership. `sessionId` here may be a LIVE desktop id (the session
   * strip) or a SAVED conversation id (the Resume Browser) — sessionIdMap
   * resolves the first and passes the second through unchanged, the same
   * resolution session:set-note uses.
   */

  const namingGet = async () => {
    const prefs = namingSettings.read();
    // The picker speaks ModelChoice; the preference stores a ModelBinding.
    // Converted here rather than storing the renderer's shape, so a future
    // picker change cannot reinterpret what is already on disk.
    return {
      mode: prefs.mode,
      model: prefs.model
        ? { runtime: 'native' as const, providerId: prefs.model.providerId, modelId: prefs.model.modelId }
        : null,
    };
  };

  const namingSet = async (value: unknown) => {
    const v = (value && typeof value === 'object' ? value : {}) as { mode?: unknown; model?: unknown };
    const choice = v.model as { runtime?: string; providerId?: string; modelId?: string } | null | undefined;
    try {
      let model: ModelBinding | null = null;
      if (choice && choice.providerId && choice.modelId) {
        // Naming runs through the provider registry, so a Claude-runtime
        // choice has nowhere to execute. The picker is opened with
        // includeClaude={false}; this refuses the case anyway rather than
        // storing a choice that would silently never be used.
        if (choice.runtime !== 'native') {
          return { ok: false, error: 'Pick a model from a provider you have set up.' };
        }
        // Same confirm-against-the-catalog rule as the specialist defaults: a
        // model we cannot see is refused, never quietly swapped for another.
        const catalog = await modelCatalog.get(await providerRegistry.list()).catch(() => null);
        if (catalog && !catalog.some((m) => m.id === choice.modelId && m.providerId === choice.providerId)) {
          return { ok: false, error: `"${choice.modelId}" isn’t in the model list right now — pick it from the list.` };
        }
        model = { providerId: choice.providerId, modelId: choice.modelId };
      }
      await namingSettings.update({ mode: v.mode, model });
      publishNamingMode();
      // A mode or model change invalidates every generation in flight: a name
      // produced under the old setting must not land after it changed.
      sessionNamer.invalidateAll();
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Your naming settings were not saved.' };
    }
  };

  const namingTitle = async (sessionId: string, fallback: string) => {
    const resolved = sessionIdMap.get(sessionId) || sessionId;
    const provider = await sessionProviderFor(resolved);
    const { name, manual } = await resolveSessionName(provider, resolved, String(fallback ?? ''));
    return { title: name, manual };
  };

  const namingRename = async (sessionId: string, title: string) => {
    // TWO id spaces meet here. The session strip renames a LIVE session by its
    // desktop id; the Resume Browser renames a SAVED conversation by its store
    // id. sessionIdMap resolves the first to the store's id and passes the
    // second through — but the live-session broadcast must go back out under
    // the DESKTOP id, because that is what App.tsx matches its rows on. For a
    // Claude Code session the two genuinely differ (desktop id -> Claude UUID),
    // and broadcasting the resolved one silently repainted nothing.
    const resolved = sessionIdMap.get(sessionId) || sessionId;
    const desktopId = sessionIdMap.has(sessionId) ? sessionId : resolved;
    const provider = await sessionProviderFor(resolved);
    // Invalidate before waiting for any earlier projection, not after its
    // store await. The queue then makes the manual projection/broadcast last.
    sessionNamer.invalidate(sessionId);
    sessionNamer.invalidate(resolved);
    return queueTitle(`${provider}/${resolved}`, async () => {
      try {
        const res = await setManualSessionName(provider, resolved, String(title ?? ''));
        if (!res.ok) return res;
        sendForSession(desktopId, IPC.SESSION_RENAMED, [desktopId, res.name]);
        broadcastRename(desktopId, res.name);
        emitConversationMetaChanged();
        return { ok: true, name: res.name };
      } catch (e: any) {
        return { ok: false, error: e?.message || 'The name was not saved.' };
      }
    });
  };

  // The four naming channels are table entries (main/ipc/session.ts) over these closures, so a phone's
  // rename cannot bypass a gate the local path enforces (design §12).
  publishNamingMode();

  // session:set-note / :get-meta / :reopen-list / :forget-reopen are table entries (main/ipc/session.ts).

  // --- Sync management, sync spaces, GitHub connect ---
  // WHY (2026-09-30 one-core R3-4): sync:*, syncspaces:* and the github:* request/response channels are
  // table entries (main/ipc/sync.ts, sync-spaces.ts, github.ts) served to windows and phones by one body.
  // What stays here is what only this function can build: the deps those entries reach, and the
  // GitHub device-flow orchestrator whose done-push has to fan out to windows AND phones.
  bindSyncSpacesDeps({ sessionManager, leaseWiring });

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
  // The request/response side (status, connect-start/cancel, install-gh, disconnect) is main/ipc/github.ts.

  // WHY (2026-09-30 one-core R3-5): permission:respond and native:submit-admin-password are table entries
  // (main/ipc/permissions.ts, native.ts). The hook relay is the one thing the permission entry needs that the
  // runtime does not carry, so it is handed over here.
  bindPermissionHooks(hookRelay);

  // WHY (2026-09-30 one-core R3-2): the dev:* handlers moved to main/ipc/dev.ts (the channel table).

  // WHY (2026-09-30 one-core R3-7): the artifacts:*, project:*, chatsearch:* , git:* and pages:* request/response
  // channels, fs:read-head and get-home-path are table entries (main/ipc/artifacts.ts, project.ts, chatsearch.ts,
  // git.ts, pages.ts, files.ts) served to windows and phones by one body. What stays here is what only this
  // function can build: the change PUSHES (artifacts:changed from the watchers, git:changed, pages:changed) and
  // the watcher / pages-service setup below.

  // WHY (2026-09-30 one-core R3-7): artifact and git changes made by the computer's own windows have always
  // gone to every window and never to a phone; the table entries reach that audience through this.
  const sendToWindows = (channel: string, payload: unknown) =>
    webContents.getAllWebContents().forEach((wc) => wc.send(channel, payload));

  // ── External-change watcher (spec §8) ──
  // Watchers live in main, refcounted per webContents (project-watcher.ts owns
  // the lifecycle). Events reuse the existing CHANGED broadcast contract with
  // by:'external' — the renderer filters on projectRoot exactly like user events.
  initProjectWatchers((evt, subscriberIds) => {
    // Created/deleted files must show up in the next file-list fetch.
    if (evt.kind !== 'edit') invalidateDiscoveryCache(evt.projectRoot);
    // Only the windows subscribed to this root (2026-09-16 C8) — every
    // consumer of this event lives in a surface that called useProjectWatch
    // (the drawer, its viewer and git footer, the Files tab). A phone's
    // subscriber id is not a webContents id; fromId() answers undefined for it
    // and the remote broadcast below carries the event there.
    // (Guarded: test harnesses fake `webContents` with only getAllWebContents,
    // and a throw here would also swallow the remote broadcast below.)
    const byId = typeof webContents.fromId === 'function' ? webContents.fromId.bind(webContents) : () => undefined;
    for (const id of subscriberIds) {
      try {
        const wc = byId(id);
        if (wc && !wc.isDestroyed()) wc.send(ARTIFACT_IPC.CHANGED, evt);
      } catch { /* a window closing mid-send must not cost the others their event */ }
    }
    // A phone subscribed over remote access (remote-server.ts watch-project)
    // is not a webContents; without this line the phone's file list never
    // updated while the assistant worked (contract row R12). Every consumer
    // filters on its own projectRoot, so an unrelated root costs one dropped
    // message.
    remoteServer?.broadcast({ type: ARTIFACT_IPC.CHANGED, payload: evt });
    // A change under a known project's Pages/ is a pages change too (F8).
    getPagesService()?.onProjectChange(evt);
  });

  // ── YouCoded Pages (Phase 1) ──
  // One store over the Personal space's Pages/ and every known project's
  // Pages/; one debounced push with the fresh list to every window and to
  // remote clients. Design: youcoded-dev docs/active/specs/2026-09-17-youcoded-pages-phase1-technical-design.md
  const pagesService = initPagesService({
    personalRoot: () => getManagedRoots()?.personalRoot ?? null,
    listProjects: async () => (await listProjects(CLAUDE_DIR)).map((p) => ({ name: path.basename(p.path), path: p.path })),
    // The BUILT app's identity, like main.ts: a dev instance shares it and the
    // live app's pins (PITFALLS → Shared state); null → local, unsynced pins.
    deviceId: () => getMachineIdentity(app.getPath('userData'))?.id ?? null,
    localFallbackDir: () => app.getPath('userData'),
    noteOwnWrite,
    // Phase 2: approvals and key POINTERS beside the model-provider keys in
    // userData, never in a sync space — a key is machine-bound ciphertext.
    connections: new PageConnectionsStore(app.getPath('userData'), secretsStore),
    // A FRESH reader per call, not a held instance: the fs-backed store caches
    // after its first load, so a long-lived one here would keep answering with
    // the token from before the person signed in or out.
    youcodedToken: () => createAuthStore(app.getPath('userData')).getToken(),
    githubToken: async () => (await getGithubClient()?.getToken())?.token ?? null,
    broadcast: (pages) => {
      webContents.getAllWebContents().forEach((wc) => wc.send(IPC.PAGES_CHANGED, pages));
      remoteServer?.broadcast({ type: IPC.PAGES_CHANGED, payload: pages });
    },
  });
  // ── Document comments (T3, design docs/active/specs/2026-09-26-doc-comments-build-design.md §1.5/§1.6) ──
  // WHY (2026-10-01 one-core R3-8): the docComments:* request channels are table entries (main/ipc/doc-comments.ts); only
  // the watcher's change push (to every window and every phone) is wired here.
  wireDocCommentsPush({
    getAllWebContents: () => webContents.getAllWebContents(),
    remoteBroadcast: (msg) => remoteServer?.broadcast(msg),
  });

  // ── Git surface: the change PUSH (spec docs/archive/specs/2026-07-22-git-surface.md) ──
  // WHY (2026-09-30 one-core R3-7): the git:* request channels are table entries (main/ipc/git.ts). The watcher
  // reports a repo change to every window (never a phone), exactly as before; the entries' own commits and
  // stages announce through the same function.
  initGitWatchers((evt) => broadcastGitChanged(sendToWindows, evt.repoRoot));

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
    statusPush.stop();
    summaryPush.stop();
    transcriptWatcher.stopAll();
    // The runtime's half of quit (sign-in listener, native sessions, admin-password asks,
    // the llama-server, and session-state's topic watchers + maps) lives with the runtime
    // (create-runtime.ts). It returns the engine-stop promise so quit can AWAIT it.
    return runtime.cleanup();
  };
  // firstRunDeps (first-run local models, 2026-09-14): the native objects setup
  // reaches for an API key, a model app or a local download. Built here because
  // this is the only place they exist; main.ts hands them to both first-run
  // registrations.
  // `installed` goes through registryHook(), the same answer the registry's
  // local-engine `ready` reads, so setup and the provider list cannot disagree.
  const firstRunDeps: FirstRunNativeDeps = {
    providers: providerRegistry,
    engine: { installed: () => engineManager.registryHook().installed(), install: () => engineManager.install() },
    models: modelManager,
  };
  // WHY (2026-09-30 one-core R3-3): the first-run:* channels are table entries (main/ipc/first-run.ts);
  // the wizard's manager arrives later from main.ts (bindFirstRunManager), the rest is built here.
  bindFirstRunNative({ nativeDeps: firstRunDeps, openRouterSignIn, providerRegistry, claudeAccount, engineManager, modelManager });
  // WHY (2026-09-30 one-core R3-4): session:* / session-naming:* / transcript:page / transcript:read-meta are
  // table entries (main/ipc/session.ts). They lean on this function's private state — the window-ownership
  // bookkeeping and the create / destroy teardown — so those bodies stay here as closures and are handed over.
  bindSessionOps({
    sessionManager, sessionIdMap, nativeHost, stampProviderTypes, windowRegistry, welcomeBackStore,
    createSession: (sender, opts) => createSession(sender ? { sender } : null, opts),
    destroySession, signalTerminalReady, transcriptPage, canWriteStoreRecord, publish, liveFacts, screens,
    naming: { get: namingGet, set: namingSet, title: namingTitle, rename: namingRename },
  });
  // WHY (2026-09-29 one-core R2, filled by R3): the channel table's desktop half. Every family moved
  // into the table registers here, and its hand-written ipcMain.handle blocks are gone from this file.
  // Kept last so a table entry can never shadow a hand-written one (Electron refuses a second
  // handler for the same name, which surfaces as a startup throw).
  registerDesktopChannels(ipcMain, () => runtime, (channel, payload) => {
    // Every screen: the phones, then this computer's own windows (the same pair tagsChanged fires).
    remoteServer?.broadcast({ type: channel, payload });
    broadcastToAllWindows(channel, payload);
  }, () => ({
    sessionManager, sendToWindows,
    // WHY (2026-10-01 one-core R3-8): a theme change in one window reaches the phones through this, and the document-comment
    // gate counts a live session's folder as a known project root (the F1 fix's "records" carve-out).
    sendToPhones: (message) => remoteServer?.broadcast(message),
    sessionRoots: () => sessionManager.listSessions().filter((s) => s.status !== 'destroyed').map((s) => s.cwd),
  }));
  return {
    cleanup, hasUsableProvider, firstRunDeps, openRouterSignIn, handoffAttempts, publish,
    outboxBroadcast: { sessionMeta: broadcastSessionMeta, tagsChanged: broadcastTagsChanged } satisfies OutboxBroadcast,
  };
}
