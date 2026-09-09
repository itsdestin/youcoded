// Registers window.__terminalRegistry so main-process executeJavaScript
// can call getScreenText for the attention classifier's ~1s buffer reads.
// Must run before any TerminalView mounts (which call registerTerminal).
import { guardDirtyEditor } from './components/artifact-views/dirty-editor-guard';
import './bootstrap/terminal-bridge';
import React, { useState, useEffect, useRef, useCallback, useMemo, useReducer } from 'react';
import TerminalView from './components/TerminalView';
import ChatView from './components/ChatView';
import HeaderBar, { BareHeaderBar } from './components/HeaderBar';
import InputBar, { type InputBarHandle } from './components/InputBar';
import StatusBar from './components/StatusBar';
import { MODELS, type ModelAlias } from './components/StatusBar';
import { modelChipFor, supportsAliasCycling } from './components/model-chip';
import FolderSwitcher from './components/FolderSwitcher';
import { isTypingTarget } from './utils/is-typing-target';
import { isPlaceholderModelId } from '../shared/model-ids';

import ErrorBoundary from './components/ErrorBoundary';
import { AnchorTip, Button, Dialog, Toast, Toggle } from './components/ui';
import ViewToggleHint from './components/ViewToggleHint';
import { takeoverDialogCopy } from './components/takeover-dialog-copy';
import GamePanel from './components/game/GamePanel';
import TerminalRightSlot from './components/TerminalRightSlot';
import { ChatProvider, useChatDispatch, useChatStore } from './state/chat-context';
import { artifactReducer, initialArtifactState } from './state/artifact-tracker';
import { ArtifactProvider } from './state/ArtifactContext';
import { createArtifactToolUseTracker } from './state/artifact-tool-use-tracker';
import { createDeliverableAutoOpen } from './state/deliverable-auto-open';
import { openFilepath } from './hooks/useOpenFilepath';
// Central slash-command router — also used by the drawer so drawer-initiated
// slash commands behave the same as typed ones (otherwise drawer bypasses InputBar's intercept).
import { dispatchSlashCommand, type DispatcherResult } from './state/slash-command-dispatcher';
import { runNativeSlashAction, routeSlashResult } from './state/native-slash-actions';
import { GameProvider, useGameState, useGameDispatch } from './state/game-context';
import { hookEventToAction } from './state/hook-dispatcher';
import { buildUsageSnapshot, pruneExpiredUsage, type SubscriptionUsage } from './state/usage-snapshot';
import { invalidateProviderTypeCache, resolveProviderType, useModelProviderType } from './hooks/use-provider-type';
import { hasPendingInteraction, canPtySend } from './state/pty-input-gate';
import { buildOutgoingMessage } from './components/outgoing-message';
import type { SyncWarning } from '../main/sync-state';
import { usePromptDetector } from './hooks/usePromptDetector';
import { useVisualViewport } from './hooks/useVisualViewport';
import { usePresence } from './hooks/usePresence';
import { usePartyGame } from './hooks/usePartyGame';
import { useChessGame } from './hooks/useChessGame';
import { useRemoteAttentionSync } from './hooks/useRemoteAttentionSync';
import { useSubmitConfirmation } from './hooks/useSubmitConfirmation';
import { useSessionAttention, mergePeerSessionStatuses } from './hooks/useSessionAttention';
import { useAttentionSummary } from './hooks/useAttentionSummary';
import { useActiveSessionModel } from './hooks/useActiveSessionModel';
import { useNativeSessionUsage, useTurnsWithUsage } from './hooks/useNativeSessionUsage';
import { useNativeSessionTotals } from './hooks/useNativeSessionTotals';
import { useZoomControls } from './hooks/useZoomControls';
import { useChromeMeasurements } from './hooks/useChromeMeasurements';
import { broadcastExpandAll, broadcastCollapseAll, isInExpandAllMode } from './hooks/useExpandAllToggle';
import { AppIcon, WelcomeAppIcon, ThemeMascot } from './components/Icons';
import CommandDrawer from './components/CommandDrawer';
import { TerminalScrollButtons } from './components/TerminalToolbar';
import TrustGate, { useTrustGateActive } from './components/TrustGate';
import MovedGate from './components/MovedGate';
import SettingsPanel from './components/SettingsPanel';
import ResumeBrowser from './components/ResumeBrowser';
import CloseSessionPrompt, { CLOSE_PROMPT_SUPPRESS_KEY } from './components/CloseSessionPrompt';
import PreferencesPopup from './components/PreferencesPopup';
import { useNativeBinding, usePreset, NativeExtras, loadLastBinding, persistLastBinding, defaultRuntime, type Runtime, type Binding } from './components/RuntimeBinding';
import ModelPicker, { type ModelChoice } from './components/model/ModelPicker';
import ModelPickerPopup from './components/ModelPickerPopup';
import type { ModelBinding } from '../shared/provider-types';
import OpenTasksPopup from './components/OpenTasksPopup';
import { useSessionTasks } from './hooks/useSessionTasks';
import MarketplaceScreen from './components/marketplace/MarketplaceScreen';
import LibraryScreen from './components/library/LibraryScreen';
import { MarketplaceProvider } from './state/marketplace-context';
import ThemeShareSheet from './components/ThemeShareSheet';
import SkillEditor from './components/SkillEditor';
import ShareSheet from './components/ShareSheet';
import { ProjectView } from './components/project-view/ProjectView';

import type { SkillEntry, PermissionMode, AttentionState, CommandEntry, SessionProvider } from '../shared/types';
import type { NativePermissionMode } from '../shared/permission-types';
import { RESUMING_NATIVE, RESUMING_CLAUDE } from '../shared/session-title';
import { decideFirstPage, FIRST_PAGE_RETRY_MS } from './state/first-page-retry';

import FirstRunView from './components/FirstRunView';
import { getPlatform, isRemoteMode, onConnectionModeChange } from './platform';
import type { SessionStatusColor } from './components/StatusDot';
import { ThemeProvider } from './state/theme-context';
import { SkillProvider } from './state/skill-context';
import { AccountProvider } from './state/account-context';
import HandlePrompt from './components/HandlePrompt';
import { WorkerHealthProvider } from './state/worker-health-context';
import { ThemeBg } from './components/ThemeBg';
import { StatsWithHealthBridge } from './components/StatsWithHealthBridge';
import { RootErrorBoundary } from './components/RootErrorBoundary';
import ThemeEffects from './components/ThemeEffects';
import { ZoomOverlay } from './components/ZoomOverlay';
import { RemoteSnapshotExporter } from './components/RemoteSnapshotExporter';
import RemoteUnsupportedNotice from './components/RemoteUnsupportedNotice';
import { SessionDropZone } from './components/SessionDropZone';
import { ContextMenuHost } from './components/context-menu/ContextMenuHost';
import { BuddyMascotApp } from './components/buddy/BuddyMascotApp';
import { BuddyChatApp } from './components/buddy/BuddyChatApp';
import { BuddyBarApp } from './components/buddy/BuddyBarApp';
import { BuddyOverlayApp } from './components/buddy/BuddyOverlayApp';

// ESC-passthrough: provider owns capture-phase ESC routing for overlays.
// Mounted at app root so every overlay component is a descendant.
import { EscCloseProvider, useEscStackEmpty, useDismissTop } from './hooks/use-esc-close';
// Pure guard for the chat-focused ESC -> PTY forwarding listener below.
import { shouldForwardEscToPty } from './state/should-forward-esc-to-pty';
import { NARROW_VIEWPORT_QUERY } from './hooks/use-narrow-viewport';

type ViewMode = 'chat' | 'terminal';

// Detect buddy mode from URL query param — computed at module scope, before component render
const buddyMode = new URLSearchParams(
  typeof window !== 'undefined' ? window.location.search : ''
).get('mode');

// --- Sound notifications (shared engine) ---
import { playSound } from './utils/sounds';

interface SessionStats {
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  contextTokens: number | null;
  duration: number | null;       // seconds (converted from ms in statusline.sh)
  apiDuration: number | null;    // seconds (converted from ms in statusline.sh)
  linesAdded: number | null;
  linesRemoved: number | null;
}

interface StatusDataState {
  usage: any;
  /** The ChatGPT plan's rolling windows (Sign in with ChatGPT, 2026-09-04),
   *  pushed beside Claude's on status:data. Shown only for a session bound to
   *  a 'chatgpt' provider — see the StatusBar props below. */
  chatgptUsage: any;
  announcement: any;
  updateStatus: any;
  model: string | null;
  contextMap: Record<string, number>;
  gitBranchMap: Record<string, string>;
  sessionStatsMap: Record<string, SessionStats>;
  // Cross-window/cross-platform attention feed (main's `lastAttentionBySession`,
  // pushed every ~10s) — remote browsers have always used this for their dots;
  // desktop now also reads it for a peer window's sessions in the switcher,
  // since a peer session has no local chat-store entry to derive a color from.
  attentionMap: Record<string, string>;
  syncWarnings: SyncWarning[] | null;
  lastSyncEpoch: number | null;
  syncInProgress: boolean;
  backupMeta: any;
}

// Match a raw model id (e.g. 'claude-sonnet-4-6') back to a status-bar
// ModelAlias (e.g. 'claude-sonnet-4-6' → 'sonnet'). Returns 'unknown' — never
// a guessed alias — when the string is missing or doesn't match anything
// YouCoded recognizes (crash/resume state with a model id that predates this
// build, a wiring bug upstream, etc.) so the badge can say so honestly instead
// of silently mislabeling the session as whatever the previous default was.
function matchModelAlias(modelStr?: string | null): ModelAlias | 'unknown' {
  return MODELS.find((m) => modelStr?.includes(m.replace(/\[.*\]/, ''))) ?? 'unknown';
}

// For call sites that need a REAL model to send to CC (new/resumed session
// creation) rather than something to display — 'unknown' is only ever a
// display sentinel and must never be sent as a literal `/model unknown`.
function realModelAlias(model: ModelAlias | 'unknown'): ModelAlias {
  return model === 'unknown' ? 'sonnet' : model;
}

const VALID_PERMISSION_MODES: PermissionMode[] = ['normal', 'auto-accept', 'plan', 'auto', 'bypass'];

// Same idea as matchModelAlias for permission mode: only accept a value that's
// actually one of CC's known modes, otherwise surface 'unknown' rather than
// defaulting to 'normal' and implying a permission posture that may not be real.
function matchPermissionMode(mode?: string | null): PermissionMode | 'unknown' {
  return VALID_PERMISSION_MODES.includes(mode as PermissionMode) ? (mode as PermissionMode) : 'unknown';
}

function AppInner() {
  // Dev-only: count AppInner's OWN re-renders (the tranche-1 metric — see
  // AppInnerProfiler). No-dep effect → runs once per AppInner commit; when
  // AppInner does NOT re-render (a child like ChatView re-rendering on its own
  // subscription), this does not run, so the counter stays flat — which is the
  // whole point. DEV-gated body; the hook call itself is unconditional (rules
  // of hooks). Tree-shaken from prod.
  useEffect(() => {
    // @ts-ignore TS1343 — import.meta is intercepted by Vite at build time
    if (import.meta.env.DEV && window.__appInnerProfile) window.__appInnerProfile.appInnerRenders += 1;
  });

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  // Ref mirror of `sessions` for handlers that need to read the latest list
  // without re-subscribing on every change (e.g. the artifact tool-use handler
  // which needs to resolve cwd by sessionId).
  const sessionsRef = useRef<any[]>([]);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  // The focused conversation, readable from mount-once effects (the
  // deliverable auto-open rule needs it without re-subscribing per switch).
  const focusedSessionIdRef = useRef<string | null>(null);
  useEffect(() => { focusedSessionIdRef.current = sessionId; }, [sessionId]);
  // Multi-window detach state (desktop-only; remote-shim stubs these as no-ops).
  // `myWindowId` identifies this renderer's BrowserWindow so the switcher can
  // distinguish local sessions from sessions owned by peer windows. `directory`
  // and `leaderWindowId` are pushed from main whenever window topology changes.
  const [myWindowId, setMyWindowId] = useState<number | null>(null);
  const [windowDirectory, setWindowDirectory] = useState<any>(null);
  const [leaderWindowId, setLeaderWindowId] = useState<number>(-1);
  const isLeader = myWindowId != null && leaderWindowId === myWindowId;
  const [viewModes, setViewModes] = useState<Map<string, ViewMode>>(new Map());
  const [statusData, setStatusData] = useState<StatusDataState>({
    usage: null, chatgptUsage: null, announcement: null, updateStatus: null,
    model: null, contextMap: {}, gitBranchMap: {}, sessionStatsMap: {},
    attentionMap: {},
    syncWarnings: [],
    lastSyncEpoch: null, syncInProgress: false, backupMeta: null,
  });

  // 'unknown' is a display-only sentinel (never fed back into the real
  // PermissionMode enforcement logic) — see matchPermissionMode below.
  const [permissionModes, setPermissionModes] = useState<Map<string, PermissionMode | 'unknown'>>(new Map());
  // Native sessions carry a SEPARATE permission mode (harness policy, not a CC
  // PTY mode). Kept in its own map so the two unions never mix; default 'ask' is
  // read lazily (no per-session seeding) since NativeSessionHost also defaults to
  // 'ask' and the chip is the only setter. Task 13.
  const [nativePermissionModes, setNativePermissionModes] = useState<Map<string, NativePermissionMode | 'unknown'>>(new Map());
  // Sessions that have received their first hook event (Claude is initialized).
  // Until this fires, show an "Initializing" overlay to prevent premature input.
  const [initializedSessions, setInitializedSessions] = useState<Set<string>>(new Set());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerSearchMode, setDrawerSearchMode] = useState(false);
  const [drawerFilter, setDrawerFilter] = useState<string | undefined>(undefined);
  const inputBarRef = useRef<InputBarHandle>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const bottomBarRef = useRef<HTMLDivElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsBadge, setSettingsBadge] = useState(false);
  const [syncAutoOpen, setSyncAutoOpen] = useState(false);
  // Deep-link flag for the Model Providers popup — set by a provider-error
  // bubble's "Open Settings" jump so Settings opens straight to that section.
  const [providersAutoOpen, setProvidersAutoOpen] = useState(false);

  // "Manage models…" in the unified ModelPicker. The picker renders inside
  // SessionStrip (which HeaderBar owns) and inside ResumeBrowser, so a prop
  // would have to drill through HeaderBar for a rarely-used escape hatch.
  // Deep component → top-level destination via a window event, because a prop
  // would have to drill through HeaderBar for a rarely-used escape hatch.
  useEffect(() => {
    const open = () => { setProvidersAutoOpen(true); setSettingsOpen(true); };
    window.addEventListener('youcoded:open-model-providers', open);
    return () => window.removeEventListener('youcoded:open-model-providers', open);
  }, []);
  // Track which sessions the user has "seen" (switched to after activity completed)
  const [viewedSessions, setViewedSessions] = useState<Set<string>>(new Set());
  const [resumeRequested, setResumeRequested] = useState(false);
  // Plan 2b "Moved Gate" (2026-07-14). Sessions another device took over: we keep
  // the pill and render <MovedGate> (instead of chat/terminal) when it's clicked.
  // The RENDER reads `movedSessions` state; the `destroyedHandler` — registered
  // once in a mount effect whose only dep is the stable `dispatch`, so its closure
  // captured `movedSessions` at mount (permanently the initial empty Map) — reads
  // `movedSessionsRef.current` instead. recordMoved/clearMoved keep the state and
  // the ref in lockstep, the ref updated synchronously so the destroy handler
  // (which fires ms after the moved push) reliably sees the entry.
  // provider: which runtime the moved session ran as. Threaded so MovedGate's
  // Resume takes the native path (pre-resume model picker) for a native session
  // rather than launching it as CC (which would find no JSONL and spawn blank).
  type MovedInfo = { device?: string; claudeSessionId?: string; projectSlug?: string; projectPath?: string; provider?: string };
  const [movedSessions, setMovedSessions] = useState<Map<string, MovedInfo>>(new Map());
  const movedSessionsRef = useRef(movedSessions);
  const recordMoved = useCallback((sessionId: string, info: MovedInfo) => {
    const next = new Map(movedSessionsRef.current);
    next.set(sessionId, info);
    movedSessionsRef.current = next;
    setMovedSessions(next);
  }, []);
  const clearMoved = useCallback((sessionId: string) => {
    if (!movedSessionsRef.current.has(sessionId)) return;
    const next = new Map(movedSessionsRef.current);
    next.delete(sessionId);
    movedSessionsRef.current = next;
    setMovedSessions(next);
  }, []);
  // Conversation-lease takeover dialog (Plan 2b Task 9; 3-state redesign
  // Destin sign-off 2026-07-23). When resuming a conversation held live on
  // another device, we ask before yanking it here. The resume flow AWAITS the
  // user's choice via a promise resolved by the dialog buttons
  // (takeoverResolveRef), so handleResumeSession stays one linear async
  // function instead of splitting across callbacks. phase 'confirm' is the
  // first ask; 'force' is the "asked, but no answer" ask (a request WAS
  // delivered to the holder); 'undeliverable' is the honest third state — the
  // hub had no delivery path at all, so the holder was never asked (distinct
  // from 'force': never claim a device ignored a request it never received).
  const [takeoverPrompt, setTakeoverPrompt] = useState<{ device: string; phase: 'confirm' | 'force' | 'undeliverable' } | null>(null);
  const takeoverResolveRef = useRef<((choice: boolean) => void) | null>(null);
  const askTakeover = useCallback((device: string, phase: 'confirm' | 'force' | 'undeliverable') =>
    new Promise<boolean>((resolve) => {
      // Reentrancy guard: only one resolver slot exists. If a second resume opens
      // a dialog while one is pending, resolve the prior one as "declined" so its
      // awaiting handleResumeSession returns cleanly instead of hanging forever.
      takeoverResolveRef.current?.(false);
      takeoverResolveRef.current = resolve;
      setTakeoverPrompt({ device, phase });
    }), []);
  const resolveTakeover = useCallback((choice: boolean) => {
    setTakeoverPrompt(null);
    const r = takeoverResolveRef.current;
    takeoverResolveRef.current = null;
    r?.(choice);
  }, []);
  // Task 6 — the resume-time model selector's pre-resume modal. Destin's
  // ruling: native resume ALWAYS offers the provider-scoped model selector and
  // NEVER auto-launches a binding. handleResumeSession's native branch opens
  // this instead of creating whenever it's called WITHOUT a nativeBinding
  // already in hand — e.g. a call site that has no inline picker of its own
  // (MovedGate's Resume button, ProjectView's resume path), as opposed to the
  // Resume Browser's own expanded row, which always resolves a binding first
  // (its Resume button is disabled until one exists) and so never lands here.
  // Nothing below is MovedGate-specific — this is the shared surface Task 9
  // reuses for that gate's resume affordance.
  const [pendingNativeResume, setPendingNativeResume] = useState<{
    claudeSessionId: string; projectSlug: string; projectPath: string; launchInNewWindow?: boolean;
  } | null>(null);
  const [pendingNativeBinding, setPendingNativeBinding] = useState<ModelBinding | null>(null);
  // True while the pre-resume picker's create is in flight — keeps the modal open
  // (and its Resume button busy) until the create acks, so a failure doesn't close
  // the modal over a silent nothing (Task 6 review ack-gap).
  const [pendingNativeResuming, setPendingNativeResuming] = useState(false);
  // Shown when the user closes an active session — offers to mark it complete
  // in one step so it's hidden from the resume menu by default.
  const [closePromptFor, setClosePromptFor] = useState<string | null>(null);
  // WHY (2026-09-07): a "sessions in other windows" close can't look its name
  // up in `sessions` — that session isn't in this window's local list.
  const [closePromptName, setClosePromptName] = useState<string | undefined>(undefined);
  // Preferences popup state — opened by /config in chat view or from SettingsPanel
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  // Model/effort/fast picker — opened by bare /model, /fast, /effort (and future status-bar chip clicks)
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  // Open Tasks popup — opened by the OpenTasksChip in the StatusBar
  const [openTasksPopupOpen, setOpenTasksPopupOpen] = useState(false);
  // SINGLE useSessionTasks instance for the whole page. The chip (in StatusBar)
  // and the popup both read from this one derivation so their inactiveMap state
  // stays in sync — two independent useSessionTasks calls would each keep their
  // own localStorage-backed state, and the `storage` event doesn't fire within
  // the same page (only across tabs). Fallback '' when there's no session gives
  // an empty task list via useChatState's singleton EMPTY_SESSION_STATE.
  const openTasks = useSessionTasks(sessionId ?? '');
  // Fast + effort state — surfaced via status bar chips. Persisted to ~/.claude/youcoded-model-modes.json.
  const [fastMode, setFastMode] = useState(false);
  const [effortLevel, setEffortLevel] = useState<string>('auto');
  // Load persisted modes on mount, and re-load when popup closes (picks up
  // edits made in the popup). Simple poll on popup close keeps the chips in sync.
  useEffect(() => {
    const api = (window.claude as any).modes;
    if (!api) return;
    api.get().then((m: { fast?: boolean; effort?: string }) => {
      setFastMode(!!m?.fast);
      if (m?.effort) setEffortLevel(m.effort);
    }).catch(() => {});
  }, [modelPickerOpen]);
  // App-scoped marketplace destinations (NOT per-session). The full-screen
  // marketplace + library replaced the legacy three-tab modal entirely.
  const [activeView, setActiveView] = useState<'chat' | 'terminal' | 'marketplace' | 'library'>('chat');
  // Preferred type chip when the marketplace is opened from a legacy entry
  // point (e.g. SettingsPanel theme picker). Cleared after the screen reads it.
  const [marketplaceInitialType, setMarketplaceInitialType] = useState<'plugin' | 'theme' | undefined>(undefined);
  // When the CommandDrawer's plugin-name badge is clicked, we navigate to
  // the marketplace AND immediately open that plugin's detail overlay.
  // MarketplaceScreen reads this, opens the overlay on mount, then calls
  // the passed clearing callback so subsequent manual navigations start fresh.
  const [marketplaceInitialDetailId, setMarketplaceInitialDetailId] = useState<string | undefined>(undefined);
  // Tab to show when Library opens — consumed by LibraryScreen (Task 5.2 wires
  // the prop; this state is lifted here so the event listener below can set it).

  // Open the marketplace destination; `installed` routes to the Library
  // sibling. Omit `tab` (or pass undefined) to land on the discovery page
  // with no type chip pre-selected — the command drawer uses this so the
  // user sees the hero + rails, not a pre-filtered grid.
  const openMarketplace = useCallback((tab?: 'installed' | 'skills' | 'themes') => {
    if (tab === 'installed') {
      setActiveView('library');
      return;
    }
    if (tab === 'skills') setMarketplaceInitialType('plugin');
    else if (tab === 'themes') setMarketplaceInitialType('theme');
    else setMarketplaceInitialType(undefined);
    setActiveView('marketplace');
  }, []);

  // Navigate to the marketplace AND open a specific plugin's detail
  // overlay. Called from the plugin-name badge on skill cards.
  const openMarketplaceDetail = useCallback((pluginId: string) => {
    setMarketplaceInitialType(undefined);
    setMarketplaceInitialDetailId(pluginId);
    setActiveView('marketplace');
  }, []);

  // Stable callback so MarketplaceScreen's useEffect doesn't re-fire every
  // render. Prior inline lambda recreated every parent render → the child's
  // effect saw a new dep identity → re-ran → caused a setState-during-render
  // React warning.
  const clearMarketplaceInitialDetail = useCallback(
    () => setMarketplaceInitialDetailId(undefined),
    [],
  );

  const [publishThemeSlug, setPublishThemeSlug] = useState<string | null>(null);
  const [editorSkillId, setEditorSkillId] = useState<string | null>(null);
  const [shareSkillId, setShareSkillId] = useState<string | null>(null);

  const [isFirstRun, setIsFirstRun] = useState<boolean | null>(null); // null = loading
  const handleFirstRunComplete = useCallback(() => setIsFirstRun(false), []);

  // Welcome screen "New Session" expansion form state
  const [welcomeFormOpen, setWelcomeFormOpen] = useState(false);
  const [welcomeCwd, setWelcomeCwd] = useState('');
  const [welcomeModel, setWelcomeModel] = useState('sonnet');
  const [welcomeDangerous, setWelcomeDangerous] = useState(false);
  // Runtime (Claude Code vs YouCoded native harness) + native binding for the
  // welcome/app-open new-session form — mirrors the SessionStrip form via the
  // shared RuntimeBinding hook so the two forms can't drift.
  // Opens on the install's remembered default (see RuntimeBinding.defaultRuntime):
  // 'claude' normally, 'native' on an install that signed in with ChatGPT.
  const [welcomeRuntime, setWelcomeRuntime] = useState<Runtime>(() => defaultRuntime());
  const [welcomeBinding, setWelcomeBinding] = useState<Binding | null>(() => loadLastBinding());
  const welcomeNb = useNativeBinding({ active: welcomeFormOpen, runtime: welcomeRuntime, binding: welcomeBinding, setBinding: setWelcomeBinding });
  // Native harness preset for the welcome form — shared lifecycle hook (see
  // RuntimeBinding.usePreset). Follows the folder heuristic until the user picks a
  // card, then latches; re-arms every time the form (re)opens via welcomeFormOpen.
  const { preset: welcomePreset, setPreset: setWelcomePreset } = usePreset({ active: welcomeFormOpen, cwd: welcomeCwd });

  // Bridge between the unified <ModelPicker> and the welcome form's existing
  // create-time state (welcomeRuntime / welcomeModel / welcomeBinding). Same
  // shape as SessionStrip's — the runtime is DERIVED from the model the user
  // picks, so this form no longer asks "Runtime?" before "Model?". Kept as a
  // derived value + one setter so the createSession call below is untouched.
  const welcomeModelChoice: ModelChoice | null = welcomeRuntime === 'native'
    ? (welcomeNb.effectiveBinding
        ? { runtime: 'native', providerId: welcomeNb.effectiveBinding.providerId, modelId: welcomeNb.effectiveBinding.modelId }
        : null)
    : { runtime: 'claude', alias: welcomeModel };

  const applyWelcomeModelChoice = (c: ModelChoice) => {
    if (c.runtime === 'claude') {
      setWelcomeRuntime('claude');
      setWelcomeModel(c.alias);
    } else {
      setWelcomeRuntime('native');
      welcomeNb.setBinding({ providerId: c.providerId, modelId: c.modelId });
    }
  };

  // Per-session model state — keyed by sessionId, same pattern as permissionModes.
  // 'unknown' is a display-only sentinel — never a real /model target.
  const [sessionModels, setSessionModels] = useState<Map<string, ModelAlias | 'unknown'>>(new Map());
  const currentModel: ModelAlias | 'unknown' = sessionId ? (sessionModels.get(sessionId) ?? 'unknown') : 'sonnet';
  const [pendingModel, setPendingModel] = useState<ModelAlias | null>(null);
  const consecutiveFailures = useRef(0);
  // Fix: track whether a new user turn has started after the model switch.
  // Events from the in-flight turn (before the switch takes effect) use the
  // old model and would cause false "failed to switch" errors.
  const postSwitchTurnReady = useRef(false);
  // A toast is either a plain message or a message with one action button
  // (used by the pending-prompt "Send anyway" override). Keeping the string
  // form means the ~8 plain setToast('…') call sites need no change.
  //
  // Change 44: `durationMs` moved ONTO the state because the dismiss timer now
  // lives in the <Toast> primitive, and the call sites did not all agree — they
  // ran 3s/4s/6s/8s depending on how much text there was to read. A single
  // primitive default would have silently cut the 8s handoff-failure messages to
  // 3s. Omit it for the common 3s case; the primitive supplies that default.
  type ToastState =
    | string
    | { message: string; durationMs?: number; action?: { label: string; onClick: () => void } };
  const [toast, setToast] = useState<ToastState | null>(null);
  // Zoom state + handlers extracted to useZoomControls (tranche 1).
  const { zoomPercent, zoomVisible, handleZoomIn, handleZoomOut, handleZoomReset } = useZoomControls();

  // `startModel` is the saved default across EVERY provider (Assistant settings,
  // Q-3a). The inferred shape had only the Claude alias, which is exactly why the
  // setting was written, read back, and then ignored by every form that starts a
  // conversation (contract R5).
  const [sessionDefaults, setSessionDefaults] = useState<{
    skipPermissions: boolean;
    model: string;
    projectFolder: string;
    startModel?: ModelChoice;
    startModelLabel?: { provider: string; model: string };
  }>({ skipPermissions: false, model: 'sonnet', projectFolder: '' });

  // Check first-run state with a 3-second safety timeout — never hang the app
  useEffect(() => {
    let resolved = false;
    const resolve = (value: boolean) => {
      if (!resolved) { resolved = true; setIsFirstRun(value); }
    };
    const timeout = setTimeout(() => resolve(false), 3000);

    (window as any).claude?.firstRun?.getState?.()
      .then((state: any) => {
        clearTimeout(timeout);
        resolve(!!(state && state.currentStep !== 'COMPLETE'));
      })
      .catch(() => { clearTimeout(timeout); resolve(false); });

    return () => clearTimeout(timeout);
  }, []);

  // Load session defaults on mount and whenever settings panel closes
  useEffect(() => {
    (window as any).claude?.defaults?.get?.().then((defs: any) => {
      if (defs) setSessionDefaults(defs);
    }).catch(() => {});
  }, [settingsOpen]);

  usePromptDetector();
  // Recovers chat→PTY submits that get lost on Windows ConPTY when Claude is
  // busy — see useSubmitConfirmation for the full mechanism. Pass active
  // session + its view mode so the hook can suppress the `\r` retry while the
  // user is actively in terminal view (xterm routes keystrokes straight to
  // PTY, so an injected `\r` would commit the partial line they're typing).
  useSubmitConfirmation({
    activeSessionId: sessionId,
    activeViewMode: sessionId ? viewModes.get(sessionId) ?? 'chat' : 'chat',
    // Native sessions never enter the PTY-only `\r` retry path.
    providerForSession: (sid) => sessions.find((s) => s.id === sid)?.provider,
  });
  // Drives --vvp-offset from window.visualViewport so the input bar stays glued
  // to the top of the soft keyboard on Android / mobile browsers.
  useVisualViewport();
  useRemoteAttentionSync();

  // Removed: data-theme-layout effect. The chrome-glass refactor replaced
  // the data-theme-layout gating with data-chrome-style / data-input-style,
  // which are already published by theme-engine.ts. No CSS consumes
  // data-theme-layout anymore, so the effect was dead code.

  const dispatch = useChatDispatch();
  const chatStore = useChatStore();
  // Artifact tracker — global reducer for session/project artifact state.
  const [artifactState, dispatchArtifact] = useReducer(artifactReducer, initialArtifactState);
  // Ref mirror of artifact state so the (once-registered) tool-use handler can
  // dedup Read-tracking against the session's already-known artifacts without
  // re-subscribing on every reducer tick.
  const artifactStateRef = useRef(artifactState);
  useEffect(() => { artifactStateRef.current = artifactState; }, [artifactState]);
  // Latest-value ref so transcript-shrink and turn-complete handlers see
  // up-to-date compactionPending state without re-subscribing on every reducer tick.
  // Tranche 1: fed by a store subscription instead of a [chatStateMap] effect,
  // so AppInner no longer re-renders per dispatch just to keep this ref current.
  // The ~12 chatStateMapRef.current reads all over this file are unchanged.
  const chatStateMapRef = useRef(chatStore.getState());
  useEffect(() => {
    chatStateMapRef.current = chatStore.getState();
    return chatStore.subscribeAll(() => { chatStateMapRef.current = chatStore.getState(); });
  }, [chatStore]);

  // Guarded PTY send for command-shaped writes triggered by UI actions
  // (command drawer, skill runs, /sync, /config, /model, Settings sends).
  // While a permission/AskUserQuestion/plan request is pending, CC's native
  // Ink select menu is live in the PTY — the sent text would be eaten as menu
  // input and its trailing \r would press Enter on the highlighted option,
  // silently answering the prompt (stray-Enter fix, youcoded#110). Same rule
  // InputBar.sendMessage applies to typed messages. Deliberate menu-driving
  // writes (ToolCard plan keys, TrustGate, prompt option clicks, terminal
  // view) must NOT use this helper. Returns false when the send was refused.
  const notifyIfPtyBlocked = useCallback((sid: string): boolean => {
    const session = chatStateMapRef.current.get(sid);
    if (session && hasPendingInteraction(session)) {
      setToast('Claude is waiting for your response — answer the prompt first.');
      return true;
    }
    return false;
  }, []);

  const guardedPtySend = useCallback((sid: string, text: string): boolean => {
    // Honest guard (M1): refuse before sending, so callers' `if (!guardedPtySend)`
    // bails actually fire for native/destroyed sessions and skip optimistic writes.
    if (!canPtySend(sessionsRef.current.find((x) => x.id === sid), chatStateMapRef.current.get(sid))) return false;
    if (notifyIfPtyBlocked(sid)) return false;
    window.claude.session.sendInput(sid, text);
    return true;
  }, [notifyIfPtyBlocked]);

  // Route a handled slash-command result to the transport this session actually
  // has (M3 item 2). A command can carry BOTH a PTY string (Claude Code's path)
  // and a `nativeAction` (the harness's); the dispatcher stays provider-agnostic
  // and the choice is made here, where the provider is known.
  //
  // Reads the provider from sessionsRef rather than the `isNativeSession` value
  // declared later in this component — a ref lookup can't be caught out by
  // declaration order, and this helper is called from several places.
  // Returns true when the result was consumed here, so callers know whether to
  // fall through to their own send path.
  const runSlashResult = useCallback((sid: string, result: DispatcherResult): boolean => {
    const provider = sessionsRef.current.find((x) => x.id === sid)?.provider;
    const route = routeSlashResult(provider, result);
    switch (route.via) {
      case 'native':
        void runNativeSlashAction(route.action, {
          sessionId: sid,
          dispatch,
          // Dismissal is <Toast>'s job since master's change 44 (3s default, which
          // is what this call site rolled by hand before the merge).
          onToast: (msg: string) => setToast(msg),
        });
        return true;
      case 'pty':
        guardedPtySend(sid, route.text);
        return true;
      case 'none-native-no-pty':
        // Was a silent drop: guardedPtySend refuses for native sessions and its
        // own toast only fires for the pending-interaction case, so a native user
        // choosing this command got no feedback at all (handoff §2.3).
        setToast(provider === 'shell'
          // A shell session is a plain terminal — the command would have been
          // typed into the user's shell, which is not what they asked for. Say
          // that, rather than the native-runtime sentence, which would be a lie.
          ? `${route.command} isn't available in a terminal session — it's a Claude Code command.`
          : `${route.command} isn't available in YouCoded-runtime sessions yet.`);
        return true;
      case 'none':
        return true;
      case 'passthrough':
        return false;
    }
  }, [guardedPtySend, dispatch]);

  // Task 11 (cancel/edit queued messages), rewired for Task 12's docked strip
  // (was UserMessage's Cancel/Edit affordances — now QueuedMessagesStrip's):
  // Cancel — invoke removeQueued, then dispatch the reducer's removal either
  // way. true: the id was found and removed on the host — the row is
  // genuinely gone. false: the drain already won the race (same outcome as
  // an interrupt landing a tick too late elsewhere in this file) — toast the
  // honest reason, but ALSO dispatch QUEUED_MESSAGE_REMOVED (Task 12 addition:
  // the strip row must not linger beside its just-confirmed timeline entry;
  // TRANSCRIPT_USER_MESSAGE's own drain-side removal would eventually clear
  // it too, but that races the transcript watcher — dispatching here removes
  // it immediately, and QUEUED_MESSAGE_REMOVED is a safe no-op if the
  // transcript event's removal already won).
  const handleCancelQueued = useCallback(async (sid: string, queueId: string) => {
    const removed = await window.claude.native.queueRemove(sid, queueId);
    if (!removed) {
      setToast('Already sending — too late to cancel.');
      dispatch({ type: 'QUEUED_MESSAGE_REMOVED', sessionId: sid, queueId });
      return;
    }
    dispatch({ type: 'QUEUED_MESSAGE_REMOVED', sessionId: sid, queueId });
  }, [dispatch]);

  // Edit = cancel + refill (design ruling — no in-place editing). The draft
  // check MUST happen BEFORE removeQueued runs — brief invariant: never
  // destroy the queued message if the refill can't land. inputBarRef is the
  // single ChatInputBar instance (mounted once, bound to the active session);
  // see InputBarHandle's hasDraft/fillDraft for why this ref was extended
  // instead of introducing new App state. Same too-late handling as Cancel
  // above (dispatch QUEUED_MESSAGE_REMOVED either way) — but the draft is
  // NOT refilled on the too-late path, since the message already reached the
  // host and refilling would duplicate it if the user re-sent.
  const handleEditQueued = useCallback(async (sid: string, queueId: string, text: string) => {
    if (inputBarRef.current?.hasDraft()) {
      setToast({ message: 'Finish or clear your current draft first, then edit the queued message.', durationMs: 4000 });
      return;
    }
    const removed = await window.claude.native.queueRemove(sid, queueId);
    if (!removed) {
      setToast('Already sending — too late to cancel.');
      dispatch({ type: 'QUEUED_MESSAGE_REMOVED', sessionId: sid, queueId });
      return;
    }
    dispatch({ type: 'QUEUED_MESSAGE_REMOVED', sessionId: sid, queueId });
    inputBarRef.current?.fillDraft(text);
  }, [dispatch]);

  // Compaction watchdog: activity-aware — resets on any reducer update for a
  // session with compactionPending set. Any transcript event bumps the timer
  // forward, so long compactions (large sessions) don't trigger a false "may
  // have failed" message as long as events keep flowing. Only fires if nothing
  // happens for 180s straight, which genuinely means something's stuck.
  //
  // Prior bug: fixed 60s timer. Big sessions took longer than 60s legitimately,
  // hit the watchdog, dispatched aborted=true, cleared pending flag — then the
  // real shrink event arrived but had no pending flag to key off of, so the
  // user saw "may have failed" even though compaction succeeded.
  const compactWatchdogs = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // Tranche 1: store subscription instead of a [chatStateMap] effect. Same
  // activity-aware body (the timer still resets on every dispatch while a
  // compaction is pending); AppInner no longer re-renders per dispatch to run
  // it. The pre-existing no-clear-timers-on-unmount behavior is preserved.
  useEffect(() => {
    const check = () => {
      const map = chatStore.getState();
      // Perf: this runs on every reducer dispatch. Steady state (no compaction
      // in flight, no live watchdogs) short-circuits without walking the
      // session map. When a compaction is live we still iterate — preserving
      // the activity-awareness described above (timer resets on every dispatch).
      if (compactWatchdogs.current.size === 0) {
        let anyPending = false;
        for (const session of map.values()) {
          if (session.compactionPending) { anyPending = true; break; }
        }
        if (!anyPending) return;
      }
      for (const [sid, session] of map) {
        const existing = compactWatchdogs.current.get(sid);
        if (session.compactionPending) {
          // Reset on every reducer tick while pending — if transcript events are
          // flowing for this session, the timer keeps bumping and never fires.
          if (existing) clearTimeout(existing);
          const timer = setTimeout(() => {
            const current = chatStateMapRef.current.get(sid);
            if (current?.compactionPending) {
              dispatch({
                type: 'COMPACTION_COMPLETE',
                sessionId: sid,
                markerId: `compact-timeout-${Date.now()}`,
                afterContextTokens: null,
                aborted: true,
              });
            }
            compactWatchdogs.current.delete(sid);
          }, 180_000);
          compactWatchdogs.current.set(sid, timer);
        } else if (existing) {
          clearTimeout(existing);
          compactWatchdogs.current.delete(sid);
        }
      }
    };
    check();
    return chatStore.subscribeAll(check);
  }, [chatStore, dispatch]);

  // Attention-reporter ref declared up here so hooks-order stays deterministic;
  // the useEffect that writes to it lives AFTER sessionStatuses is computed
  // (search for "Attention reporter effect" below).
  const lastAttentionReportedRef = useRef<Map<string, { attentionState: AttentionState; awaitingApproval: boolean; status: SessionStatusColor }>>(new Map());

  const gameState = useGameState();
  const gameDispatch = useGameDispatch();
  // The game pane and the artifact drawer share the framed-shell's single right
  // slot, so they're mutually exclusive: opening one closes the other. Two
  // transition-gated effects (each keyed on only the OTHER pane's open flag)
  // enforce this without ping-ponging — closing one pane never re-opens the
  // other. Covers every open path, including the game panel auto-opening on an
  // incoming challenge (CHALLENGE_RECEIVED sets panelOpen) and the artifact
  // drawer opening from a file-pill / tool-card click.
  // Drawer open/closed is per-session; exclusivity acts on the ACTIVE session.
  const activeDrawerOpen = sessionId ? (artifactState.drawerOpenBySession[sessionId] ?? false) : false;
  useEffect(() => {
    if (gameState.panelOpen && activeDrawerOpen && sessionId) {
      dispatchArtifact({ type: 'DRAWER_CLOSED', sessionId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState.panelOpen]);
  useEffect(() => {
    if (activeDrawerOpen && gameState.panelOpen) {
      gameDispatch({ type: 'TOGGLE_PANEL' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDrawerOpen]);
  // Gate on isLeader so only the first-launched window opens the lobby
  // socket — avoids duplicate presence for the same GitHub identity when
  // multiple peer windows are open. When detach isn't available (remote
  // shim / Android), myWindowId stays null so isLeader is false — fall
  // back to true-by-default so the lobby still connects.
  const lobbyLeader = (window as any).claude?.detach?.openDetached ? isLeader : true;
  // Presence socket lives in the platform layer now (spec §3); usePresence
  // expresses desired state and maps relayed events onto the same reducer
  // actions the retired PartyKit lobby hook used. Same public API shape.
  const lobby = usePresence(lobbyLeader);
  const game = usePartyGame(lobby.updateStatus, lobby.challengePlayer);
  // Chess brings its own PartyKit client and its own room (spec §3.1) — a chess
  // move is not a column number, so it cannot ride Connect 4's hook. Both hooks
  // stay mounted for the life of the app; only the one whose game is actually
  // open ever opens a socket, so this costs nothing when you are not playing.
  const chess = useChessGame(lobby.updateStatus, lobby.challengePlayer);

  // createGame is gone from GameConnection (2026-07-09): the manual room-code
  // UI was removed — challenges are the only game entry. joinGame stays (an
  // accepted challenge joins by the received code).
  const gameConnection = useMemo(() => ({
    joinGame: game.joinGame,
    makeMove: game.makeMove,
    sendChat: game.sendChat,
    requestRematch: game.requestRematch,
    leaveGame: game.leaveGame,
    challengePlayer: game.challengePlayer,
    respondToChallenge: lobby.respondToChallenge,
    reconnectLobby: lobby.reconnect,
  }), [game.joinGame, game.makeMove, game.sendChat, game.requestRematch, game.leaveGame, game.challengePlayer, lobby.respondToChallenge, lobby.reconnect]);

  // Same interface, different game. The arcade shell picks between them by the
  // id of the game that is open — every other consumer sees one shape.
  const chessConnection = useMemo(() => ({
    joinGame: chess.joinGame,
    makeMove: chess.makeMove,
    sendChat: chess.sendChat,
    requestRematch: chess.requestRematch,
    leaveGame: chess.leaveGame,
    challengePlayer: chess.challengePlayer,
    respondToChallenge: lobby.respondToChallenge,
    reconnectLobby: lobby.reconnect,
  }), [chess.joinGame, chess.makeMove, chess.sendChat, chess.requestRematch, chess.leaveGame, chess.challengePlayer, lobby.respondToChallenge, lobby.reconnect]);

  // Tranche 1: sessionStatuses now derives from the cached selector — AppInner
  // re-renders only when a triple changes, not on every dispatch (see
  // useSessionAttention). sessionStatuses keeps its old shape for HeaderBar.
  const sessionAttention = useSessionAttention(sessions, viewedSessions, sessionId);
  const attentionSummary = useAttentionSummary();
  const sessionStatuses = useMemo(() => {
    const m = new Map<string, SessionStatusColor>();
    for (const [id, info] of sessionAttention) m.set(id, info.status);
    // WHY (2026-09-07, Destin: "status lights properly displayed across
    // windows"): a peer-window session has no transcript events in this
    // renderer at all, so nothing here can derive its colour locally — the
    // switcher's "sessions in other windows" rows read gray/Inactive whatever
    // the truth. Two cross-window feeds can answer, and they are NOT
    // equivalent:
    //   1. attentionSummary — main's merge of every window's own derived dot
    //      colour, pushed ~100ms after any change. Carries the colour itself,
    //      green and blue included. Authoritative; the buddy pill already uses it.
    //   2. statusData.attentionMap — "needs attention" STATES on the 10s status
    //      push. Can only ever say red or amber, and is up to 10s stale, but it
    //      survives places the summary doesn't run (remote browsers, and the
    //      instant before this window's first summary arrives).
    // So: summary first, attentionMap as the fallback. A session THIS window
    // owns always keeps its local derivation — blue depends on what *you* have
    // looked at, which only this window knows. Precedence lives in the pure
    // mergePeerSessionStatuses so it can be pinned by tests.
    return mergePeerSessionStatuses({
      base: m,
      localSessionIds: new Set<string>(sessions.map((s: any) => s.id)),
      windowDirectory,
      summaryPerSession: attentionSummary.perSession,
      attentionMap: statusData.attentionMap,
    });
  }, [sessionAttention, attentionSummary, sessions, windowDirectory, statusData.attentionMap]);

  // Play the 'attention' sound when any session transitions to red (awaiting
  // approval). Red is a visible state, so color-driven dedup is correct here.
  const prevStatusSoundRef = useRef<Map<string, SessionStatusColor>>(new Map());
  // Remote attention diffing: tracks the last-seen attentionMap from status:data
  // so we only dispatch ATTENTION_STATE_CHANGED when a session's state actually flips.
  // On desktop, useAttentionClassifier already handles this locally (no-op here because
  // the reducer is idempotent for same-value transitions and the diff prevents redundant
  // dispatches). On remote browsers the classifier doesn't run, so this is the only path.
  const prevAttentionRef = useRef<Record<string, string>>({});
  // Perf: last status:data payload (serialized). Main pushes every 10s even
  // when nothing changed; without this guard the unconditional setStatusData
  // re-rendered the whole app tree at idle, forever.
  const lastStatusJsonRef = useRef<string | null>(null);
  // Did the last status push carry ChatGPT plan usage? Main starts (and stops)
  // that usage poll the moment the browser sign-in completes or the user signs
  // out, so this yes/no answer flipping is a reliable, app-wide "the ChatGPT
  // account just changed" signal. WHY we need one at all: the only other place
  // that notices a sign-in is the card inside the Settings popup, and the
  // sign-in happens in a BROWSER TAB — close Settings on the way back from the
  // browser and the card is gone before the sign-in lands, so a conversation on
  // a plan model would show no usage chips and no plan on /usage until the app
  // was restarted. For anyone who never signs in with ChatGPT this value is
  // `false` on every push forever and nothing below ever runs.
  const hadChatGptUsageRef = useRef(false);
  // WHY (2026-09-07) this walks `sessions` rather than the whole map: since the
  // switcher started colouring peer-window rows, sessionStatuses also contains
  // sessions OTHER windows own. Chiming on those would play the same alert once
  // per open window, all at once, on top of the owning window's own chime — and
  // the owner is already chiming, so no alert is lost by staying owner-only.
  useEffect(() => {
    const prev = prevStatusSoundRef.current;
    const next = new Map<string, SessionStatusColor>();
    for (const s of sessions) {
      const color = sessionStatuses.get(s.id);
      if (!color) continue;
      next.set(s.id, color);
      const was = prev.get(s.id);
      if (was === color) continue;
      if (color === 'red' && was !== 'red') playSound('attention');
    }
    prevStatusSoundRef.current = next;
  }, [sessionStatuses, sessions]);

  // Play the 'ready' sound when any session's isThinking transitions true → false.
  // Replaces the prior blue-color-transition trigger, which never fired for the
  // currently-viewed session (blue requires "unseen, not active"). Thinking-false
  // is the actual "response finished" signal and fires regardless of visibility.
  const prevThinkingRef = useRef<Map<string, boolean>>(new Map());
  // Tranche 1: this MUST stay a React effect keyed on [sessionAttention], NOT a
  // per-dispatch store subscription (mirrors the attention-sound effect above,
  // deliberately left keyed on [sessionStatuses]). A per-dispatch subscription
  // observed every INTRA-BATCH isThinking toggle: transcript replay/hydrate
  // dispatches N turn events inside one rAF flush, and a session with K
  // completed turns toggles isThinking true→false K times within the batch →
  // K spurious 'ready' chimes where the old coalesced [chatStateMap] effect
  // stayed silent (adversarial review finding #1, 2026-07-17). Keying on the
  // selector coalesces to one post-commit run on the final state, and reading
  // raw isThinking from the store there is safe (effect body, not render). This
  // catches every real transition because isThinking→false only happens via
  // endTurn / process-exit / native-error, each of which also flips the status
  // triple → sessionAttention identity changes → this effect runs.
  useEffect(() => {
    const prev = prevThinkingRef.current;
    const next = new Map<string, boolean>();
    for (const [id, state] of chatStore.getState()) {
      const was = prev.get(id);
      const isThinking = !!state.isThinking;
      next.set(id, isThinking);
      // Only fire when we actually observed a true → false transition. Skip if
      // the session just appeared (was === undefined) to avoid a spurious chime
      // on reducer init or remote hydrate when isThinking arrives already false.
      if (was === true && !isThinking) playSound('ready');
    }
    prevThinkingRef.current = next;
  }, [sessionAttention]);

  // Attention reporter effect: pushes per-session attention state + the
  // derived dot color to main whenever sessionAttention changes. Main
  // aggregates across all windows and broadcasts
  // session:attention-summary so buddy surfaces can render the same dots.
  //
  // A ref-based diff ensures we only report when state actually changes —
  // the selector already collapses no-op dispatches, and we compare the
  // derived triple before sending as a second guard. Session removal sends
  // { clear: true } so main drops stale entries.
  //
  // Tranche 1: the triple (attentionState, awaitingApproval, status) now
  // comes from the useSessionAttention selector rather than being re-derived
  // here from chatStateMap + sessionStatuses.
  //
  // Stays a REACT EFFECT (not a store subscription) and is declared here (not
  // where the ref is) because it must observe the post-render selector output
  // — running it before sessionAttention is computed would read `undefined`.
  //
  // WHY (2026-09-07) this reports only sessions THIS window owns: sessionAttention
  // also holds placeholder entries for peer-window sessions (App dispatches
  // ATTENTION_STATE_CHANGED for every id in the 10s attentionMap, whoever owns
  // it), and those placeholders can only ever derive gray/red/amber — they have
  // no transcript, so they never know "green". Main's aggregate is keyed by
  // session id across all windows, last report wins, so reporting them let a
  // non-owner's stale gray overwrite the owner's green in the very feed the
  // switcher now reads. One session, one reporter: its owner.
  useEffect(() => {
    const prev = lastAttentionReportedRef.current;
    const currentIds = new Set<string>();
    for (const s of sessions) {
      const sid = s.id;
      const info = sessionAttention.get(sid);
      if (!info) continue;
      currentIds.add(sid);
      // Thread the same dot color the main switcher renders for this
      // session so the buddy pill's dot is visually identical.
      const next = { attentionState: info.attentionState, awaitingApproval: info.awaitingApproval, status: info.status };
      const last = prev.get(sid);
      if (!last
        || last.attentionState !== next.attentionState
        || last.awaitingApproval !== next.awaitingApproval
        || last.status !== next.status
      ) {
        window.claude.attention.report({ sessionId: sid, ...next });
        prev.set(sid, next);
      }
    }
    for (const sid of prev.keys()) {
      if (!currentIds.has(sid)) {
        window.claude.attention.report({ sessionId: sid, clear: true });
        prev.delete(sid);
      }
    }
  }, [sessionAttention, sessions]);

  // Buddy "open main app" → land on the buddy's viewed session. Reads the
  // existing sessionsRef mirror so the IPC subscription survives
  // sessions-array churn without resubscribing.
  useEffect(() => {
    const off = window.claude?.buddy?.onFocusSession?.((sid: string) => {
      if (sessionsRef.current.some((s: any) => s.id === sid)) {
        setSessionId(sid);
        // Notify Android/remote bridge so the native terminal view switches too
        (window as any).claude?.session?.switch?.(sid);
      }
    });
    return off;
  }, []);

  // Push stack-state changes to the host. On Android, MainActivity uses this
  // to flip OnBackPressedCallback.isEnabled so hardware back is intercepted
  // when an overlay is open and falls through to Android default (background)
  // when nothing is dismissable. On desktop this call is a no-op (preload.ts's
  // window.claude.system.notifyStackState is a stub).
  const escStackEmpty = useEscStackEmpty();
  useEffect(() => {
    window.claude.system?.notifyStackState?.(escStackEmpty);
  }, [escStackEmpty]);

  // Hardware back button (Android) → dismiss top of stack. dismissTop is a
  // hook so we capture it in a ref the WS listener (which lives outside
  // React's render cycle) can read. Re-subscribing the listener on every
  // dismissTop change would churn the WebSocket subscription needlessly.
  const dismissTop = useDismissTop();
  const dismissTopRef = useRef(dismissTop);
  useEffect(() => { dismissTopRef.current = dismissTop; }, [dismissTop]);

  useEffect(() => {
    const handler = () => dismissTopRef.current();
    const unsubscribe = window.claude.system?.onBack?.(handler);
    return unsubscribe;
  }, []);

  // Native local-model residency → per-session ModelLoadingBar (2026-07-14).
  // Main joins per-model engine state with session→model and pushes each native
  // session its bound model's state (loaded/loading/sleeping/unloaded).
  useEffect(() => {
    const off = window.claude.native?.onModelState?.((s: any) => {
      if (!s?.sessionId || !s?.modelId || !s?.state) return;
      dispatch({
        type: 'NATIVE_MODEL_STATE_CHANGED',
        sessionId: s.sessionId,
        state: s.state,
        modelId: s.modelId,
        sizeBytes: typeof s.sizeBytes === 'number' ? s.sizeBytes : null,
        loadedBytes: typeof s.loadedBytes === 'number' ? s.loadedBytes : null,
      });
    });
    return () => { off?.(); };
  }, []);

  useEffect(() => {
    const createdHandler = window.claude.on.sessionCreated((info) => {
      setSessions((prev) => {
        // Deduplicate — replay buffers resend session:created for existing sessions
        if (prev.some((s) => s.id === info.id)) return prev;
        dispatch({ type: 'SESSION_INIT', sessionId: info.id });
        // Only auto-focus genuinely new sessions (not replayed ones)
        setSessionId(info.id);
        return [...prev, info];
      });
      // Native harness sessions (roadmap Phase 1+) are chat-first — they have
      // no PTY, so 'terminal' would be an empty pane. Claude sessions also
      // default to chat. (Gemini, the old terminal-only provider, is gone.)
      // A shell session is the opposite: it IS a terminal and has no chat at
      // all, so it opens on the terminal (and stays there — see currentViewMode).
      const defaultView = info.provider === 'shell' ? 'terminal' : 'chat';
      setViewModes((prev) => prev.has(info.id) ? prev : new Map(prev).set(info.id, defaultView));
      setPermissionModes((prev) => prev.has(info.id) ? prev : new Map(prev).set(info.id, matchPermissionMode(info.permissionMode)));
      setSessionModels((prev) => {
        if (prev.has(info.id)) return prev;
        return new Map(prev).set(info.id, matchModelAlias(info.model));
      });
      // A shell session is made by Settings' "Run in terminal" button, which sits
      // on top of the app — without closing Settings the user would never see the
      // terminal that just opened with their command typed into it.
      if (info.provider === 'shell') setSettingsOpen(false);
      // Native harness sessions (roadmap Phase 1+) have no hook relay, so they'd
      // never trigger the "first hook = initialized" gate. Mark them ready
      // immediately. A shell session has no hook relay either (it is spawned with
      // no pipe), so this already covers it.
      if (info.provider && info.provider !== 'claude') {
        setInitializedSessions((prev) => {
          if (prev.has(info.id)) return prev;
          const next = new Set(prev);
          next.add(info.id);
          return next;
        });
      }
      // Seed the native permission chip from the harness's ACTUAL starting mode
      // (a fresh Coder preset starts on 'auto-edit', not the default 'ask') —
      // fetch async and validate against the known modes, mirroring
      // cycleNativePermission's guard. Fires for both fresh + resumed native
      // sessions (both flow through session:created). Skip if already seeded.
      if (info.provider === 'native' && (window as any).claude?.native?.getPermissionMode) {
        (window.claude.native as any).getPermissionMode(info.id).then((mode: string) => {
          const VALID: NativePermissionMode[] = ['ask', 'auto-edit', 'full-auto'];
          // Unrecognized response → 'unknown', not a silent 'ask' guess: an
          // older/remote host that answered with something we don't understand
          // could actually be sitting on 'full-auto', and showing 'ASK FIRST'
          // in that case would understate what the session is allowed to do.
          setNativePermissionModes((prev) => prev.has(info.id) ? prev : new Map(prev).set(
            info.id, VALID.includes(mode as NativePermissionMode) ? (mode as NativePermissionMode) : 'unknown',
          ));
        }).catch(() => {
          // getPermissionMode unavailable (remote/older host) — we genuinely
          // don't know the mode, so say so instead of defaulting to 'ask'.
          setNativePermissionModes((prev) => prev.has(info.id) ? prev : new Map(prev).set(info.id, 'unknown'));
        });
      }
    });

    const destroyedHandler = window.claude.on.sessionDestroyed((id: string, exitCode: number = 0) => {
      // Plan 2b Moved Gate: this session was TAKEN OVER, not closed. Keep its pill
      // (so clicking it hits the gate), skip the "session died" banner
      // (SESSION_PROCESS_EXITED), and DON'T wipe chat state (SESSION_REMOVE) — the
      // gate replaces the view; state is freed on Exit/Resume. Read the REF, not
      // `movedSessions`: this handler's mount-effect closure captured the state at
      // mount (empty), so a state read here would never see the moved entry.
      if (movedSessionsRef.current.has(id)) {
        // Drop from the aux maps (inert once the gate owns the view). Dropping
        // initializedSessions also keeps the input bar disabled as defence-in-depth.
        setViewModes((prev) => { const n = new Map(prev); n.delete(id); return n; });
        setPermissionModes((prev) => { const n = new Map(prev); n.delete(id); return n; });
        setNativePermissionModes((prev) => { const n = new Map(prev); n.delete(id); return n; });
        setSessionModels((prev) => { const n = new Map(prev); n.delete(id); return n; });
        setInitializedSessions((prev) => { if (!prev.has(id)) return prev; const n = new Set(prev); n.delete(id); return n; });
        return;
      }
      // Fire BEFORE removing the session from state — the reducer needs the
      // current SessionChatState to decide whether this warrants a 'session-died'
      // banner (in-flight tools OR nonzero exit). SESSION_REMOVE below wipes it.
      dispatch({ type: 'SESSION_PROCESS_EXITED', sessionId: id, exitCode });
      setSessions((prev) => {
        const remaining = prev.filter((s) => s.id !== id);
        // Auto-switch to another session when closing the active one
        setSessionId((curr) => {
          if (curr !== id) return curr;
          return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
        });
        return remaining;
      });
      setViewModes((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      setPermissionModes((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      setNativePermissionModes((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      setSessionModels((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      dispatch({ type: 'SESSION_REMOVE', sessionId: id });
      setInitializedSessions((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    });

    // Specialists 1c: the host's delegation feed — a hire's ledger record
    // changed (status/steps/stale/model/notes). Lands on the launching Task
    // card. MUST mirror BubbleFeed.tsx. Task 10: typed bridge — `on.specialistEvent`
    // RETURNS the unsubscribe function directly (it does not hand back a raw
    // listener for `.off()`, unlike most of this file's other `on.X` calls);
    // there is also no separate 'note' event kind any more — a note is a
    // field on the run record, so the SAME 'run' event carries it and
    // SPECIALIST_RUN_CHANGED's reducer case derives the Activity-trail row.
    const specialistHandler = window.claude.on.specialistEvent((event) => {
      if (event.kind === 'run') {
        dispatch({ type: 'SPECIALIST_RUN_CHANGED', sessionId: event.sessionId, run: event.run });
      }
    });

    // G-1: a background command's run record changed — lands on its Bash
    // card. MUST mirror BubbleFeed.tsx. on.shellEvent returns the unsubscribe fn.
    const shellHandler = window.claude.on.shellEvent((event) => {
      dispatch({ type: 'SHELL_RUN_CHANGED', sessionId: event.sessionId, run: event.run });
    });

    const hookHandler = window.claude.on.hookEvent((event) => {
      const action = hookEventToAction(event);
      if (action) {
        dispatch(action);
      }
      // First hook event for a session = Claude is initialized
      if (event.sessionId) {
        setInitializedSessions((prev) => {
          if (prev.has(event.sessionId)) return prev;
          const next = new Set(prev);
          next.add(event.sessionId);
          // Broadcast so other devices transition out of Initializing too
          (window as any).claude?.remote?.broadcastAction({ type: '_SESSION_INITIALIZED', sessionId: event.sessionId });
          return next;
        });
      }
    });

    // Batch transcript dispatches into animation frames — multiple fs.watch events
    // within a single frame become one React render instead of N separate renders.
    //
    // Hidden-window caveat: Electron suspends requestAnimationFrame while the
    // window is minimized/occluded, which used to FREEZE chat state (queued
    // actions never flushed) while wall-clock timers kept firing — the 8s
    // submit-retry then evaluated its idle gate against stale state and could
    // send a stray \r into the PTY. While hidden we batch on a 16ms timeout
    // instead: same batching cost, but state keeps advancing.
    const pendingTranscriptActions: any[] = [];
    let transcriptRafId: number | null = null;
    let transcriptTimerId: ReturnType<typeof setTimeout> | null = null;
    let transcriptBatchCancelled = false;

    function flushTranscriptActions() {
      transcriptRafId = null;
      transcriptTimerId = null;
      if (transcriptBatchCancelled) return;
      const batch = pendingTranscriptActions.splice(0);
      // React 18 batches all synchronous dispatches → single render for the whole batch
      for (const action of batch) {
        dispatch(action);
      }
    }

    function batchTranscriptDispatch(action: any) {
      pendingTranscriptActions.push(action);
      if (transcriptRafId !== null || transcriptTimerId !== null) return;
      if (document.visibilityState === 'hidden') {
        transcriptTimerId = setTimeout(flushTranscriptActions, 16);
      } else {
        transcriptRafId = requestAnimationFrame(flushTranscriptActions);
      }
    }

    // If the window hides while an rAF flush is pending, that rAF may never
    // fire — hand the pending batch to a timeout so it can't strand.
    function onTranscriptVisibilityChange() {
      if (document.visibilityState === 'hidden' && transcriptRafId !== null) {
        cancelAnimationFrame(transcriptRafId);
        transcriptRafId = null;
        if (transcriptTimerId === null) {
          transcriptTimerId = setTimeout(flushTranscriptActions, 16);
        }
      }
    }
    document.addEventListener('visibilitychange', onTranscriptVisibilityChange);

    const transcriptHandler = (window.claude.on as any).transcriptEvent?.((event: any) => {
      if (!event?.type || !event?.sessionId) return;

      switch (event.type) {
        case 'user-message':
          batchTranscriptDispatch({
            type: 'TRANSCRIPT_USER_MESSAGE',
            sessionId: event.sessionId,
            uuid: event.uuid,
            text: event.data.text,
            timestamp: event.timestamp,
            // Host-injected turn marker (a delivered specialist report) + its
            // structured header — MUST mirror BubbleFeed.tsx. See TimelineEntry.injected.
            injected: event.data.injected,
            injectedMeta: event.data.injectedMeta,
            // Forward the subagent stamp so the reducer can tell "briefing
            // written into a subagent's JSONL" apart from a real user prompt
            // and drop the former (it's already shown on the Agent card).
            parentAgentToolUseId: event.data.parentAgentToolUseId,
            agentId: event.data.agentId,
          });
          break;
        case 'user-interrupt':
          // ESC-passthrough: transcript-watcher detected a user-initiated
          // interrupt (ESC sent to the PTY). Reducer records it so we can
          // tag the next assistant turn as interrupted.
          batchTranscriptDispatch({
            type: 'TRANSCRIPT_INTERRUPT',
            sessionId: event.sessionId,
            uuid: event.uuid,
            timestamp: event.timestamp,
            kind: event.data.kind,
          });
          break;
        case 'assistant-text':
          batchTranscriptDispatch({
            type: 'TRANSCRIPT_ASSISTANT_TEXT',
            sessionId: event.sessionId,
            uuid: event.uuid,
            text: event.data.text,
            timestamp: event.timestamp,
            // Task 2.4: forward the per-message model from the transcript so the
            // reducer can stamp turn.model on the first text of each turn.
            model: event.data.model,
            // Native runtime: per-token delta id — same partId merges into the
            // last text segment (mirror BubbleFeed.tsx, must stay identical).
            partId: event.data.partId,
            parentAgentToolUseId: event.data.parentAgentToolUseId,
            agentId: event.data.agentId,
          });
          break;
        case 'tool-use':
          batchTranscriptDispatch({
            type: 'TRANSCRIPT_TOOL_USE',
            sessionId: event.sessionId,
            uuid: event.uuid,
            toolUseId: event.data.toolUseId,
            toolName: event.data.toolName,
            toolInput: event.data.toolInput || {},
            // Carried so a specialist's mid-run note can be placed among its
            // tool rows by time (reconcileNoteSegments); the top-level card
            // ignores it. Three mirrors must stay identical: this switch,
            // BubbleFeed.tsx (buddy window) and transcript-page-actions.ts
            // (replayed page) — pinned by transcript-event-surface-parity.test.ts.
            timestamp: event.timestamp,
            parentAgentToolUseId: event.data.parentAgentToolUseId,
            agentId: event.data.agentId,
          });
          break;
        case 'tool-result':
          batchTranscriptDispatch({
            type: 'TRANSCRIPT_TOOL_RESULT',
            sessionId: event.sessionId,
            uuid: event.uuid,
            toolUseId: event.data.toolUseId,
            result: event.data.toolResult || '',
            isError: event.data.isError || false,
            structuredPatch: event.data.structuredPatch,
            parentAgentToolUseId: event.data.parentAgentToolUseId,
            agentId: event.data.agentId,
          });
          break;
        case 'replay-complete':
          // End of a transcript replay — reap cards the history left 'running'.
          // Synthesized by the replay handler in main, never parsed from a
          // transcript. sessionIdle false means main could not affirm the
          // session is idle (live re-dock, or a CC session), so the reducer
          // leaves everything alone.
          batchTranscriptDispatch({
            type: 'TRANSCRIPT_REPLAY_COMPLETE',
            sessionId: event.sessionId,
            sessionIdle: event.data?.sessionIdle === true,
          });
          break;
        case 'turn-complete':
          // Task 2.2: forward the full metadata payload. transcript-watcher emits these as
          // optional fields on event.data (shared/types.ts); coalesce undefined → null so
          // the action type (string | null, not optional) stays well-typed.
          batchTranscriptDispatch({
            type: 'TRANSCRIPT_TURN_COMPLETE',
            sessionId: event.sessionId,
            uuid: event.uuid,
            timestamp: event.timestamp,
            stopReason: event.data.stopReason ?? null,
            model: event.data.model ?? null,
            anthropicRequestId: event.data.anthropicRequestId ?? null,
            usage: event.data.usage ?? null,
            // Forward the subagent stamp so the reducer can drop a sub-agent's
            // end_turn instead of overwriting parent turn.model and tearing down
            // the parent's in-flight state via endTurn(). Mirrors assistant-text /
            // tool-use / tool-result dispatches above.
            parentAgentToolUseId: event.data.parentAgentToolUseId,
            agentId: event.data.agentId,
          });
          // Native StatusBar chips (context/tokens/speed) are sourced from THIS
          // turn-complete usage via the reducer (App.tsx `nativeStatusUsage` memo →
          // selectNativeStatusChips), which serves both desktop and remote. The old
          // reportUsage → native:usage-report → status:data cache path was dead
          // (nothing read its nativeUsageMap) and was removed in the whole-branch review.
          break;
        case 'subagent-usage':
          // Bookkeeping only — never touches the timeline, the turn state, or
          // the subagent card's segments. It exists so the parent's totals can
          // include the work it delegated (spec §2). Arrives on the PARENT's
          // stream (native-session-host emits it there), and replays from the
          // parent's record on resume like any other persisted event.
          batchTranscriptDispatch({
            type: 'TRANSCRIPT_SUBAGENT_USAGE',
            sessionId: event.sessionId,
            uuid: event.uuid,
            timestamp: event.timestamp,
            usage: event.data.usage ?? null,
            parentAgentToolUseId: event.data.parentAgentToolUseId,
            agentId: event.data.agentId,
          });
          break;
        case 'assistant-thinking': {
          // Text payload → real reasoning content (collapsible in chat).
          // No payload → lifecycle heartbeat only (existing behavior:
          // bumps lastActivityAt and clears any stale attention banner).
          if (event.data?.text) {
            batchTranscriptDispatch({
              type: 'TRANSCRIPT_ASSISTANT_REASONING',
              sessionId: event.sessionId,
              uuid: event.uuid,
              text: event.data.text,
              timestamp: event.timestamp,
              partId: event.data.partId,
              // Specialists 1c: a child's stamped reasoning routes into its
              // Task card, not the parent's bubble. MUST mirror BubbleFeed.tsx.
              parentAgentToolUseId: event.data.parentAgentToolUseId,
            });
          } else {
            // Argument-generation progress: draw/update the preparing tool card.
            // Dispatched IN ADDITION to the heartbeat, not instead of it — the
            // heartbeat's promptProcessing:null is the right outcome here (prefill
            // is over once arguments are streaming), and suppressing it would
            // strand the previous phase's progress line on screen.
            // MUST mirror BubbleFeed.tsx.
            if (event.data?.toolPreparing) {
              batchTranscriptDispatch({
                type: 'NATIVE_TOOL_PREPARING',
                sessionId: event.sessionId,
                toolCallId: event.data.toolPreparing.toolCallId,
                toolName: event.data.toolPreparing.toolName,
                chars: event.data.toolPreparing.chars,
                cleared: event.data.toolPreparing.cleared,
              });
            }
            // Fix: erase an abandoned half-written sentence BEFORE the heartbeat
            // below parks/clears the turn — if this ran after a retry's new text
            // landed, it would erase the wrong (retried) content instead of the
            // stale one. MUST mirror BubbleFeed.tsx, and must stay in this order.
            if (event.data?.dropPart) {
              batchTranscriptDispatch({
                type: 'NATIVE_PARTS_DROPPED',
                sessionId: event.sessionId,
                partIds: event.data.dropPart.partIds,
              });
            }
            batchTranscriptDispatch({
              type: 'TRANSCRIPT_THINKING_HEARTBEAT',
              sessionId: event.sessionId,
              // Native watchdog: a stall-warning payload drives the countdown,
              // `stalled` parks the turn, a plain heartbeat clears both.
              // MUST mirror BubbleFeed.tsx.
              stallWarning: event.data?.stallWarning,
              stalled: event.data?.stalled,
              promptProcessing: event.data?.promptProcessing,
            });
          }
          break;
        }
        case 'session-error':
          // Native runtime only: a provider/stream failure. End the turn and
          // surface the 'error' AttentionBanner (mirror BubbleFeed.tsx).
          batchTranscriptDispatch({
            type: 'NATIVE_SESSION_ERROR',
            sessionId: event.sessionId,
            message: event.data.text ?? 'The model request failed.',
          });
          break;
        case 'skill-invoked':
          // /skill-name (M3 item 1). The instructions live in event.data.body and
          // are deliberately NOT dispatched — they belong to the model's history,
          // not the timeline. Rendering them as a user bubble put 26k characters
          // of SKILL.md on screen (Destin, 2026-07-28).
          dispatch({
            type: 'TRANSCRIPT_SKILL_INVOKED',
            sessionId: event.sessionId,
            uuid: event.uuid,
            timestamp: event.timestamp,
            skillId: event.data.skillId ?? 'skill',
            displayName: event.data.displayName ?? event.data.skillId ?? 'Skill',
            args: event.data.args,
            skillPath: event.data.skillPath,
          });
          break;
        case 'context-clear':
          // The durable /clear barrier (native runtime). This is the ONLY thing
          // that clears a native session's timeline — the dispatcher defers to
          // it rather than clearing optimistically, so a refused clear leaves
          // the conversation untouched. It also fires during transcript REPLAY,
          // which is what makes a resumed session show the same post-clear view
          // the user left behind instead of resurrecting the old conversation.
          dispatch({
            type: 'CLEAR_TIMELINE',
            sessionId: event.sessionId,
            markerId: `clear-${event.uuid}`,
            timestamp: event.timestamp,
          });
          break;
        case 'compact-summary': {
          // Canonical compaction-complete signal — fired by the transcript
          // watcher when Claude Code writes an isCompactSummary entry. Works
          // for both in-session /compact (appends to same JSONL, so shrink
          // never fires) and resume-from-summary (first entry of new JSONL).
          const sessionState = chatStateMapRef.current.get(event.sessionId);
          // event.data.autoCompaction marks a SPONTANEOUS native compaction —
          // it has no compactionPending flag (that's only set by /compact), yet
          // the user must still see a marker since ~all their history was just
          // summarized away. Render it in that case too, bypassing the guard.
          if (sessionState?.compactionPending || event.data.autoCompaction) {
            const contextTokens = statusData.sessionStatsMap[event.sessionId]?.contextTokens ?? null;
            dispatch({
              type: 'COMPACTION_COMPLETE',
              sessionId: event.sessionId,
              markerId: `compact-done-${Date.now()}`,
              afterContextTokens: contextTokens,
              // Forward the summary text so the SystemMarker can offer
              // click-to-expand (replaces the dead "ctrl+o to see full summary"
              // affordance from CC's TUI, which never worked inside YouCoded).
              ...(event.data.summary ? { summary: event.data.summary } : {}),
              ...(event.data.autoCompaction ? { auto: true } : {}),
            });
          }
          break;
        }
      }
    });

    // Backup completion path: file-shrink detection. Primary detection now
    // runs through the 'compact-summary' transcript event above (canonical
    // isCompactSummary field). Shrink is still wired so we recover correctly
    // if Claude Code's future behavior changes to rewrite/truncate the JSONL.
    const shrinkHandler = (window.claude.on as any).transcriptShrink?.((payload: { sessionId: string }) => {
      if (!payload?.sessionId) return;
      const sessionState = chatStateMapRef.current.get(payload.sessionId);
      if (!sessionState?.compactionPending) return; // /clear or unrelated shrink — ignore
      const contextTokens = statusData.sessionStatsMap[payload.sessionId]?.contextTokens ?? null;
      dispatch({
        type: 'COMPACTION_COMPLETE',
        sessionId: payload.sessionId,
        markerId: `compact-done-${Date.now()}`,
        afterContextTokens: contextTokens,
      });
    });

    const renamedHandler = window.claude.on.sessionRenamed((sid, name) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === sid ? { ...s, name } : s)),
      );
    });

    // Plan 2b Moved Gate: another device took over this session's lease. Record
    // it so its pill survives the imminent destroy and clicking it renders
    // <MovedGate>. Still dispatch SESSION_MOVED for its endTurn effect (cleanly
    // stops any 'thinking' state on the now-dead session). The push carries the
    // resume params so the gate's "Resume on this device" needs no extra lookup.
    const movedHandler = (window.claude.on as any).sessionMoved?.((payload: { sessionId: string; device?: string; claudeSessionId?: string; projectSlug?: string; projectPath?: string; provider?: string }) => {
      if (!payload?.sessionId) return;
      recordMoved(payload.sessionId, {
        device: payload.device,
        claudeSessionId: payload.claudeSessionId,
        projectSlug: payload.projectSlug,
        projectPath: payload.projectPath,
        provider: payload.provider,
      });
      dispatch({ type: 'SESSION_MOVED', sessionId: payload.sessionId, device: payload.device });
    });

    // Permission-mode detection (per-session) is wired up in a dedicated
    // effect below, scoped to the current sessions list. Previously this used
    // a global pty:output listener; that channel is no longer broadcast
    // (every PTY chunk used to be double-sent to pay for a single listener —
    // see ipc-handlers.ts pty-output comments).

    const statusHandler = window.claude.on.statusData((data) => {
      // Skip byte-identical payloads. Safe to skip the attention diff below
      // too: an identical payload implies an identical attentionMap, which
      // was already folded into prevAttentionRef when first seen.
      const json = JSON.stringify(data);
      if (json === lastStatusJsonRef.current) return;
      lastStatusJsonRef.current = json;
      const chatgptUsage = pruneExpiredUsage(data.chatgptUsage);
      // Signed in or signed out since the last push → the list of providers and
      // models has changed, so anything showing "which plan is this session on"
      // has to look again. See hadChatGptUsageRef above for why the Settings
      // card cannot be relied on to notice this itself.
      const hasChatGptUsage = chatgptUsage != null;
      if (hasChatGptUsage !== hadChatGptUsageRef.current) {
        hadChatGptUsageRef.current = hasChatGptUsage;
        invalidateProviderTypeCache();
      }
      setStatusData((prev) => ({
        ...prev,
        // A window past its reset time is stale, not current — see pruneExpiredUsage.
        usage: pruneExpiredUsage(data.usage),
        chatgptUsage,
        announcement: data.announcement,
        updateStatus: data.updateStatus,
        syncWarnings: Array.isArray(data.syncWarnings) ? data.syncWarnings : [],
        lastSyncEpoch: data.lastSyncEpoch ?? prev.lastSyncEpoch,
        syncInProgress: data.syncInProgress ?? prev.syncInProgress,
        backupMeta: data.backupMeta ?? prev.backupMeta,
        contextMap: data.contextMap || prev.contextMap,
        gitBranchMap: data.gitBranchMap || prev.gitBranchMap,
        sessionStatsMap: data.sessionStatsMap || prev.sessionStatsMap,
        attentionMap: data.attentionMap || prev.attentionMap,
      }));

      // Diff attentionMap and dispatch per-session when state flips.
      // On desktop, useAttentionClassifier already does this from the xterm buffer —
      // the reducer's same-value guard and the diff here make this a no-op locally.
      // On remote browsers the classifier never runs, so this is the only attention path.
      const incoming = (data?.attentionMap ?? {}) as Record<string, string>;
      const prev = prevAttentionRef.current;
      for (const [sessionId, state] of Object.entries(incoming)) {
        if (prev[sessionId] !== state) {
          dispatch({
            type: 'ATTENTION_STATE_CHANGED',
            sessionId,
            state: state as any,
          });
        }
      }
      prevAttentionRef.current = incoming;
    });

    // UI action sync — receive actions broadcast from other devices
    const uiActionHandler = (window.claude.on as any).uiAction?.((action: any) => {
      if (!action) return;
      // Handle view switching from native side (e.g. Chat button in TerminalKeyboardRow)
      if (action.action === 'switch-view' && action.mode) {
        setSessionId((currentSid) => {
          if (currentSid) {
            setViewModes((prev) => new Map(prev).set(currentSid, action.mode));
          }
          return currentSid;
        });
        return;
      }
      if (!action.type) return;
      // Handle session initialization sync (not a chat reducer action)
      if (action.type === '_SESSION_INITIALIZED' && action.sessionId) {
        setInitializedSessions((prev) => {
          if (prev.has(action.sessionId)) return prev;
          const next = new Set(prev);
          next.add(action.sessionId);
          return next;
        });
        return;
      }
      dispatch(action);
    });

    // Prompt events — Android bridge broadcasts Ink menu prompts detected from PTY screen
    const promptShowHandler = (window.claude.on as any).promptShow?.((payload: any) => {
      // A prompt arriving proves the session is alive — dismiss "Initializing" overlay
      setInitializedSessions((prev) => {
        if (prev.has(payload.sessionId)) return prev;
        const next = new Set(prev);
        next.add(payload.sessionId);
        return next;
      });
      dispatch({
        type: 'SHOW_PROMPT',
        sessionId: payload.sessionId,
        promptId: payload.promptId,
        title: payload.title,
        description: payload.description,
        buttons: payload.buttons || [],
      });
    });
    const promptDismissHandler = (window.claude.on as any).promptDismiss?.((payload: any) => {
      dispatch({
        type: 'DISMISS_PROMPT',
        sessionId: payload.sessionId,
        promptId: payload.promptId,
      });
    });
    const promptCompleteHandler = (window.claude.on as any).promptComplete?.((payload: any) => {
      dispatch({
        type: 'COMPLETE_PROMPT',
        sessionId: payload.sessionId,
        promptId: payload.promptId,
        selection: payload.selection || '',
      });
    });

    // Android-only: corrects optimistic permission-mode cycling. Desktop's
    // detection runs through ptyOutput above, but Android doesn't forward
    // raw PTY bytes — ManagedSession.detectPermissionMode broadcasts this
    // event from its 1Hz screen poll instead.
    const sessionPermissionModeHandler = (window.claude.on as any).sessionPermissionMode?.((sid: string, mode: string) => {
      const valid: PermissionMode[] = ['normal', 'auto-accept', 'plan', 'bypass'];
      if (!valid.includes(mode as PermissionMode)) return;
      setPermissionModes((prev) => {
        if (prev.get(sid) === mode) return prev;
        return new Map(prev).set(sid, mode as PermissionMode);
      });
    });

    // Remote-only: host sends a full chat state snapshot immediately after the
    // remote client connects. Dispatches HYDRATE_CHAT_STATE so the reducer
    // pre-populates all session timelines without waiting for transcript replay.
    // Typed-optional on the shared surface — present only on remote-shim.
    const chatHydrateHandler = window.claude.on.chatHydrate?.((payload: any) => {
      dispatch({ type: 'HYDRATE_CHAT_STATE', sessions: payload });
    });

    // Artifact tracker: when Claude writes/edits a file inside the active project
    // root, call appendVersion so the central index is populated, then refresh the
    // session drawer from disk. We piggyback on the existing transcriptEvent
    // subscription — filtering to Write/Edit/MultiEdit tool-use events and only
    // paths inside the session's working directory (external files are never
    // auto-tracked). appendVersion + ensureProject (called inside the IPC handler)
    // are both idempotent, so duplicate events are safe.
    //
    // Note: the transcript event payload does NOT include cwd — only sessionId.
    // We resolve cwd by looking up the session in the sessions state. Because
    // the handler is registered in a useEffect that doesn't re-subscribe on
    // sessions changes, we read via sessionsRef.current to always see fresh data.
    // The handler itself lives in state/artifact-tool-use-tracker.ts (pinned by
    // tests/artifacts/artifact-tool-use-tracker.test.ts). It appends one version
    // per tracked tool call and refreshes the session's drawer list ONCE per
    // burst — see the WHY there for the 2026-08-15 out-of-memory incident.
    const artifactTracker = createArtifactToolUseTracker({
      getSessions: () => sessionsRef.current,
      getSessionArtifacts: (sessionId) => artifactStateRef.current.sessionArtifacts[sessionId] ?? [],
      appendVersion: (projectRoot, sessionId, args) =>
        (window.claude as any).artifacts?.appendVersion?.(projectRoot, sessionId, args) ?? Promise.resolve(),
      listSession: (sessionId, projectRoot) =>
        (window.claude as any).artifacts?.listSession?.(sessionId, projectRoot) ?? Promise.resolve(undefined),
      onSessionArtifacts: (sessionId, artifacts) =>
        dispatchArtifact({ type: 'SESSION_ARTIFACTS_LOADED', sessionId, artifacts: artifacts as any }),
    });
    const artifactToolUseHandler = (window.claude.on as any).transcriptEvent?.((event: any) => {
      artifactTracker.handle(event);
    });

    // Deliverables auto-open (spec 2026-08-25 §3): a SendUserFile result whose
    // call asked for display:"render" opens the panel to its first file — once
    // per reply, focused conversation only, desktop only, never for replayed
    // history, and never over unsaved edits. Same raw event feed as the tracker.
    const deliverableAutoOpen = createDeliverableAutoOpen({
      getFocusedSessionId: () => focusedSessionIdRef.current,
      canAutoOpen: () => getPlatform() === 'electron' && !window.matchMedia?.(NARROW_VIEWPORT_QUERY).matches,
      guard: guardDirtyEditor,
      open: (sid, path) => {
        // drawerOpensImmediately: false — nobody clicked this. Opening the
        // panel before the lookup resolves just shows an empty/list-only
        // viewer for however long resolution takes (measured ~4s on a large
        // workspace); deferred mode reveals the panel already showing the
        // file, or stays silent entirely on a miss.
        void openFilepath(
          { state: artifactStateRef.current, dispatch: dispatchArtifact },
          sid,
          path,
          { drawerOpensImmediately: false }
        );
      },
    });
    const deliverableAutoOpenHandler = (window.claude.on as any).transcriptEvent?.((event: any) => {
      deliverableAutoOpen.handle(event);
    });

    // NOTE: the artifacts:changed push event is consumed directly by
    // ActiveArtifactView (edit-conflict banner). An earlier App-level
    // subscription here only set a pendingRefresh flag that nothing read —
    // removed as dead state.

    return () => {
      transcriptBatchCancelled = true;
      if (transcriptRafId !== null) cancelAnimationFrame(transcriptRafId);
      if (transcriptTimerId !== null) clearTimeout(transcriptTimerId);
      document.removeEventListener('visibilitychange', onTranscriptVisibilityChange);
      window.claude.off('session:created', createdHandler);
      window.claude.off('session:destroyed', destroyedHandler);
      window.claude.off('hook:event', hookHandler);
      // Task 10 fix: specialistHandler IS the unsubscribe function
      // (on.specialistEvent's return type), not a listener reference — the
      // old `window.claude.off('specialists:event', specialistHandler)` call
      // passed that function where `.off` expects the ORIGINAL callback, so
      // it silently unsubscribed nothing and the feed kept running per mount.
      specialistHandler();
      shellHandler();
      window.claude.off('session:renamed', renamedHandler);
      if (movedHandler) window.claude.off('session:moved', movedHandler);
      window.claude.off('status:data', statusHandler);
      if (transcriptHandler) window.claude.off('transcript:event', transcriptHandler);
      if (shrinkHandler) window.claude.off('transcript:shrink', shrinkHandler);
      if (uiActionHandler) window.claude.off('ui:action:received', uiActionHandler);
      if (promptShowHandler) window.claude.off('prompt:show', promptShowHandler);
      if (promptDismissHandler) window.claude.off('prompt:dismiss', promptDismissHandler);
      if (promptCompleteHandler) window.claude.off('prompt:complete', promptCompleteHandler);
      if (sessionPermissionModeHandler) window.claude.off('session:permission-mode', sessionPermissionModeHandler);
      if (chatHydrateHandler) window.claude.off('chat:hydrate', chatHydrateHandler);
      if (artifactToolUseHandler) window.claude.off('transcript:event', artifactToolUseHandler);
      artifactTracker.dispose();
      if (deliverableAutoOpenHandler) window.claude.off('transcript:event', deliverableAutoOpenHandler);
      deliverableAutoOpen.dispose();
    };
  }, [dispatch]);

  // Desktop permission-mode detection, scoped per-session. Watches for Claude
  // Code's in-terminal mode indicator strings ("bypass permissions on", etc.)
  // and updates the HeaderBar badge. Previously a single global pty:output
  // listener handled this, forcing every PTY chunk to be dual-broadcast.
  // Subscribing per-session halves steady-state IPC traffic.
  //
  // Android doesn't forward raw PTY bytes — it emits 'session:permission-mode'
  // instead (handled in the big effect above), so this effect is effectively
  // desktop-only. On Android the ptyOutputForSession call is still safe but
  // will never deliver data matching the mode strings.
  useEffect(() => {
    const claudeOn = (window.claude.on as any);
    if (typeof claudeOn.ptyOutputForSession !== 'function') return;
    const handles: Array<{ sid: string; remove: () => void }> = [];
    for (const s of sessions) {
      const remove = claudeOn.ptyOutputForSession(s.id, (data: string) => {
        const lower = data.toLowerCase();
        let mode: PermissionMode | null = null;
        // CC v2.1.83+ auto mode banner reads "auto mode on (shift+tab to cycle)" —
        // checked before "accept edits on" because the substring "auto mode" doesn't
        // overlap, but order is preserved for symmetry with the off-list below.
        if (lower.includes('bypass permissions on')) mode = 'bypass';
        else if (lower.includes('auto mode on')) mode = 'auto';
        else if (lower.includes('accept edits on')) mode = 'auto-accept';
        else if (lower.includes('plan mode on')) mode = 'plan';
        else if (lower.includes('bypass permissions off')
              || lower.includes('auto mode off')
              || lower.includes('accept edits off')
              || lower.includes('plan mode off')) mode = 'normal';
        if (mode) {
          setPermissionModes((prev) => {
            if (prev.get(s.id) === mode) return prev;
            return new Map(prev).set(s.id, mode!);
          });
        }
      });
      handles.push({ sid: s.id, remove });
    }
    return () => {
      for (const h of handles) {
        try { h.remove(); } catch { /* unsubscribe API may no-op */ }
      }
    };
  }, [sessions]);

  // Fetch session list on mount — catches sessions that existed before event handlers were registered
  // (e.g., remote browser reconnecting after the replay buffer events already fired, or a renderer
  // crash/reload, where main kept every session alive but this is a brand-new React tree).
  // Perf cycle 2: load a session's most recent PAGE of history instead of
  // replaying its whole transcript. Opening a huge conversation used to stream
  // thousands of events through the reducer (~22s); a page is ~30 turns.
  //
  // claudeSessionId/projectSlug are the fallback locator for a session the
  // transcript watcher does not know yet (a just-resumed CC session) — see
  // TranscriptPageRequest.
  // Sessions whose first page has already been asked for — asking twice would
  // prepend the newest page a second time. An id is removed only when its
  // session leaves the list (the effect below), never on the strength of the
  // ANSWER: for the life of a session, the first request to arrive is the only
  // one that ever runs.
  const firstPageAsked = useRef<Set<string>>(new Set());

  const loadFirstPage = useCallback(async (sid: string, locator?: { claudeSessionId: string; projectSlug: string }) => {
    if (firstPageAsked.current.has(sid)) return;
    firstPageAsked.current.add(sid);
    dispatch({ type: 'HISTORY_PAGE_REQUESTED', sessionId: sid });
    for (let attempt = 0; ; attempt++) {
      try {
        const page = await (window as any).claude?.detach?.requestTranscriptPage?.({
          sessionId: sid,
          beforeCursor: null,
          claudeSessionId: locator?.claudeSessionId,
          projectSlug: locator?.projectSlug,
        });
        if (!page) { dispatch({ type: 'HISTORY_PAGE_FAILED', sessionId: sid }); return; }
        // An empty page used to be ambiguous: either the session genuinely has
        // no history, or main could not resolve its transcript YET (a
        // just-started session is not watched until Claude Code's hook reports
        // its path). Main now says which — `unresolved` — so the two get
        // different budgets, and an unresolved one is never RECORDED: writing
        // hasMore:false + a null cursor is what permanently removes the
        // scroll-up sentinel (Destin, 2026-09-07). See first-page-retry.ts.
        const decision = decideFirstPage(page, attempt);
        if (decision === 'accept') {
          dispatch({ type: 'HISTORY_PAGE_LOADED', sessionId: sid, events: page.events, cursor: page.cursor, hasMore: page.hasMore });
          return;
        }
        if (decision === 'give-up') { dispatch({ type: 'HISTORY_PAGE_FAILED', sessionId: sid }); return; }
      } catch {
        // The scroll sentinel can retry; a failed first page leaves an empty
        // view rather than a wrong one.
        dispatch({ type: 'HISTORY_PAGE_FAILED', sessionId: sid });
        return;
      }
      await new Promise((r) => setTimeout(r, FIRST_PAGE_RETRY_MS));
    }
  }, [dispatch]);

  // Every session this window knows about gets its most recent page — not just
  // the paths that happen to create one. History used to arrive as a side effect
  // of the live tailer replaying from byte 0, which covered every entry point by
  // accident; now that the tailer starts at EOF, a session that appears by any
  // OTHER route (adopted from the directory, created through the session API
  // directly) would render EMPTY. Guarded by firstPageAsked, so the explicit
  // resume calls below — which carry a locator — win the race and this skips them.
  useEffect(() => {
    // Forget closed sessions first. A native session is keyed by the id it
    // resumes, so the same id can legitimately come back — and a stale entry
    // here would silently deny it any history at all.
    const live = new Set(sessions.map((s) => s.id));
    for (const id of firstPageAsked.current) if (!live.has(id)) firstPageAsked.current.delete(id);
    for (const s of sessions) void loadFirstPage(s.id);
  }, [sessions, loadFirstPage]);

  useEffect(() => {
    window.claude.session.list().then((list: any[]) => {
      // Perf lab: boot-time session fetch has resolved (catches pre-existing
      // sessions on mount — see comment above this effect).
      performance.mark('yc:sessions-listed');
      if (!list || list.length === 0) return;

      // Fix: this per-session seeding used to run INSIDE the setSessions updater
      // below. Updaters must be PURE — React re-invokes them (concurrent
      // rendering, StrictMode) and keeps only the returned value, so nested
      // dispatch/setState calls could be replayed or dropped on the floor. That
      // left the session list populated while the model/permission maps stayed
      // empty, which surfaces as "Model Unknown" / "PERMISSION UNKNOWN" chips
      // after a reload. Every setter here is has()-guarded, so running it across
      // the whole list (rather than only the not-yet-known ones) is idempotent
      // and never clobbers what session:created already seeded.
      for (const s of list) {
        dispatch({ type: 'SESSION_INIT', sessionId: s.id });
        setViewModes((vm) => vm.has(s.id) ? vm : new Map(vm).set(s.id, 'chat'));
        setPermissionModes((pm) => pm.has(s.id) ? pm : new Map(pm).set(s.id, matchPermissionMode(s.permissionMode)));
        // These sessions were already running before this window's event
        // handlers attached (e.g. a remote reconnect) — session:created never
        // fired for them, so this is the only place their model gets seeded.
        setSessionModels((sm) => sm.has(s.id) ? sm : new Map(sm).set(s.id, matchModelAlias(s.model)));
      }

      // Pure updater — dedup against whatever session:created already added.
      setSessions((prev) => {
        const existingIds = new Set(prev.map((s) => s.id));
        const newSessions = list.filter((s) => !existingIds.has(s.id));
        if (newSessions.length === 0) return prev;
        return [...prev, ...newSessions];
      });
      setSessionId((prev) => prev ?? list[0].id);
      // Mark all existing sessions as initialized — they're already running,
      // so skip the "Initializing" overlay (which waits for first hook event)
      setInitializedSessions((prev) => {
        const next = new Set(prev);
        for (const s of list) next.add(s.id);
        return next;
      });

      // Rehydrate each session's chat from disk. Fix: without this, a renderer
      // reload (crash, Ctrl+R) left every pre-existing session with an EMPTY
      // timeline — SESSION_INIT only allocates a blank slot, and no live
      // transcript event ever re-sends history, so the conversation looked
      // deleted. Every OTHER entry into an already-running session already
      // replays (ownership handoff, native resume, buddy feed); the mount path
      // was the one that didn't.
      //
      // Ordering: the transcript:event listener is registered by an effect
      // declared ABOVE this one, so it is already attached when these replayed
      // events stream back; uuid dedup absorbs any overlap with live events.
      // History is requested by the session-list effect above, which covers every
      // entry point rather than only this one. Remote/Android hydrate via
      // chat:hydrate on connect instead.
    }).catch(() => {});
  }, [dispatch]);

  // Multi-window ownership wiring (Phase 2 of detach feature).
  // Subscribes to directory/leader/ownership pushes from main and mutates
  // local session list + chat reducer in response. When this window acquires
  // a session (via detach or re-dock), we request transcript replay so the
  // reducer hydrates from disk — the reducer is deterministic from TRANSCRIPT_*
  // events and uuid dedup handles any overlap with live events.
  useEffect(() => {
    const det = (window as any).claude?.detach;
    const getId = (window as any).claude?.window?.getId;
    if (getId) getId().then((id: number) => {
      setMyWindowId(id);
      // Stash globally so non-React code (SessionStrip drop resolution) can
      // identify this window without threading a prop through every consumer.
      (window as any).__youcodedWindowId = id;
    }).catch(() => {});
    if (!det) return;

    const cleanupDir = det.onDirectoryUpdated?.((dir: any) => {
      setWindowDirectory(dir);
      // The directory snapshot carries leaderWindowId too. Pull it from every
      // directory push so non-leader windows still learn who the leader is —
      // main only fires WINDOW_LEADER_CHANGED when the id *changes* from the
      // previously broadcast value, so window 2+ would otherwise never hear
      // about the existing leader and stay stuck on "Connecting…" forever.
      if (typeof dir?.leaderWindowId === 'number') setLeaderWindowId(dir.leaderWindowId);
    });
    const cleanupLeader = det.onLeaderChanged?.((id: number) => setLeaderWindowId(id));
    // Pull the current directory immediately — the push from main may have
    // fired before this effect ran (on a brand-new window, React mounts after
    // registerWindow already broadcast, so we'd miss it). Same applies to the
    // leader — hydrate both from this response.
    det.getDirectory?.().then((dir: any) => {
      if (!dir) return;
      setWindowDirectory(dir);
      if (typeof dir.leaderWindowId === 'number') setLeaderWindowId(dir.leaderWindowId);
    }).catch(() => {});

    // Named, not inline: BOTH the push (onOwnershipAcquired) and the pull
    // (claimPending, below) run the identical acquisition. See claimPending's
    // WHY — a fresh tear-off window is handed its session before this
    // subscription exists, and that push is dropped, not queued.
    const applyAcquired = (payload: any) => {
      const { sessionId: sid, sessionInfo, freshWindow, refocusOnly } = payload;
      if (refocusOnly) {
        // Switcher asked us to focus an existing local session — just flip active.
        setSessionId(sid);
        return;
      }
      setSessions((prev) => {
        if (prev.some((s) => s.id === sid)) return prev;
        return [...prev, sessionInfo];
      });
      dispatch({ type: 'SESSION_INIT', sessionId: sid });
      // Native harness sessions (roadmap Phase 1+) are chat-first — they have
      // no PTY, so 'terminal' would be an empty pane. Claude sessions also
      // default to chat. (Gemini, the old terminal-only provider, is gone.)
      const defaultView = 'chat';
      setViewModes((prev) => prev.has(sid) ? prev : new Map(prev).set(sid, defaultView));
      setPermissionModes((prev) => prev.has(sid) ? prev : new Map(prev).set(sid, matchPermissionMode(sessionInfo.permissionMode)));
      // A window-transfer handoff never fires session:created here — this is
      // the only place this window seeds the transferred session's model.
      setSessionModels((prev) => prev.has(sid) ? prev : new Map(prev).set(sid, matchModelAlias(sessionInfo.model)));
      // Transferred sessions were already initialized on the source — skip the
      // "Initializing" overlay, it would flash briefly before replay completes.
      setInitializedSessions((prev) => {
        if (prev.has(sid)) return prev;
        const next = new Set(prev); next.add(sid); return next;
      });
      if (freshWindow) setSessionId(sid);
      // Hydrate from ONE page, not a whole-transcript replay. Main knows this
      // window INHERITED the session and serves its first page read to EOF
      // (WindowRegistry.markInheritedByTransfer) — so the page is complete
      // through the newest message, which the stop-at-startOffset page was not.
      //
      // Called here rather than left to the sessions effect below so the order
      // is deterministic: this claims `firstPageAsked` first, and replayLiveState
      // is chained AFTER the page resolves. That ordering is load-bearing —
      // replayLiveState ends with the replay-complete marker, which reaps tool
      // cards the history left 'running', and it must not run before the page
      // that creates those cards has been applied.
      void loadFirstPage(sid).then(() => det.replayLiveState?.(sid));
    };

    const cleanupAcquired = det.onOwnershipAcquired?.(applyAcquired);

    // The pull half. A window created BY a tear-off is handed its session one
    // statement after `new BrowserWindow()` — long before this React tree
    // exists — and Electron DROPS a send with no listener rather than queueing
    // it (measured on 41.10.7). Every tear-off into a fresh window therefore
    // skipped the whole handoff: no history hydration (so the conversation
    // ended at the moment the session was resumed), no "open on the session you
    // just dragged", no re-send of an open permission ask. Main queues the
    // payload for a window that has not pulled yet; this drains that queue.
    det.claimPending?.().then((queued: any[]) => {
      for (const payload of queued ?? []) applyAcquired(payload);
    }).catch(() => {});

    const cleanupLost = det.onOwnershipLost?.((payload: any) => {
      const { sessionId: sid } = payload;
      setSessions((prev) => {
        const remaining = prev.filter((s) => s.id !== sid);
        setSessionId((curr) => {
          if (curr !== sid) return curr;
          return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
        });
        return remaining;
      });
      setViewModes((prev) => { const n = new Map(prev); n.delete(sid); return n; });
      setPermissionModes((prev) => { const n = new Map(prev); n.delete(sid); return n; });
      setNativePermissionModes((prev) => { const n = new Map(prev); n.delete(sid); return n; });
      setInitializedSessions((prev) => {
        if (!prev.has(sid)) return prev;
        const n = new Set(prev); n.delete(sid); return n;
      });
      // Use SESSION_REMOVE — NOT SESSION_PROCESS_EXITED — because the session
      // is still alive, just owned by another window now.
      dispatch({ type: 'SESSION_REMOVE', sessionId: sid });
    });

    return () => {
      cleanupDir?.();
      cleanupLeader?.();
      cleanupAcquired?.();
      cleanupLost?.();
    };
  }, [dispatch, loadFirstPage]);

  // (Removed) A mount effect used to fetch skills.list() and store it in a `skills`
  // state that nothing ever read — a wasted IPC round-trip on every mount. The real
  // skills provider is state/skill-context.tsx, which every consumer already uses.

  // Flush and reload session state when connection mode changes (local ↔ remote).
  // On Android, switching to remote means the WebSocket now talks to the desktop server —
  // all local session state is stale and must be replaced with the desktop's sessions.
  useEffect(() => {
    const unsub = onConnectionModeChange(() => {
      // Flush all session state
      setSessions([]);
      setSessionId(null);
      setViewModes(new Map());
      setPermissionModes(new Map());
      setNativePermissionModes(new Map());
      setSessionModels(new Map());
      setInitializedSessions(new Set());
      setViewedSessions(new Set());
      dispatch({ type: 'RESET' });

      // Reload session list from the new server
      window.claude.session.list().then((list: any[]) => {
        if (!list || list.length === 0) return;
        setSessions(list);
        for (const s of list) {
          dispatch({ type: 'SESSION_INIT', sessionId: s.id });
          setViewModes((vm) => new Map(vm).set(s.id, 'chat'));
          setPermissionModes((pm) => new Map(pm).set(s.id, matchPermissionMode(s.permissionMode)));
          setSessionModels((sm) => new Map(sm).set(s.id, matchModelAlias(s.model)));
        }
        setSessionId(list[0].id);
        // Mark existing sessions as initialized (already running)
        setInitializedSessions(new Set(list.map((s) => s.id)));
      }).catch(() => {});
    });
    return unsub;
  }, [dispatch]);

  // Mark session as viewed when the user switches to it
  useEffect(() => {
    if (sessionId) {
      setViewedSessions((prev) => {
        if (prev.has(sessionId)) return prev;
        const next = new Set(prev);
        next.add(sessionId);
        return next;
      });
    }
  }, [sessionId]);

  // Clear viewed status when a session starts thinking (user sent a new message).
  // Tranche 1: store subscription instead of a [chatStateMap] effect — reads
  // sessionsRef.current (the existing mirror) so it doesn't need `sessions` as a
  // dep. setViewedSessions is a stable setState, safe from a subscription cb.
  useEffect(() => {
    const check = () => {
      const map = chatStore.getState();
      const sessions = sessionsRef.current;
      // Early-exit: skip iteration if no sessions are currently thinking.
      let anyThinking = false;
      for (const s of sessions) {
        const chatState = map.get(s.id);
        if (chatState?.isThinking) { anyThinking = true; break; }
      }
      if (!anyThinking) return;

      for (const s of sessions) {
        const chatState = map.get(s.id);
        if (chatState?.isThinking) {
          setViewedSessions((prev) => {
            if (!prev.has(s.id)) return prev;
            const next = new Set(prev);
            next.delete(s.id);
            return next;
          });
        }
      }
    };
    check();
    return chatStore.subscribeAll(check);
  }, [chatStore]);

  // Check if remote setup banner is active (show badge on gear icon)
  // Badge shows whenever the blue "Set Up Remote Access" banner would be visible
  // in the settings panel — i.e., no remote clients are connected
  useEffect(() => {
    const claude = (window as any).claude;
    if (!claude?.remote) return;
    const check = () => {
      claude.remote.getClientCount().then((count: number) => {
        setSettingsBadge(count === 0);
      }).catch(() => {});
    };
    check();
    const interval = setInterval(check, 10000);
    return () => clearInterval(interval);
  }, []);

  // Seed syncWarnings once at mount so a danger badge shows instantly at
  // launch. Ongoing updates ride the status:data push (same authoritative
  // .sync-warnings.json source) — the old 15s getStatus poll duplicated data
  // the push already carried and woke the main process for nothing.
  useEffect(() => {
    const claude = (window as any).claude;
    if (!claude?.sync?.getStatus) return;
    claude.sync.getStatus()
      .then((s: any) => {
        if (!Array.isArray(s?.warnings)) return;
        setStatusData((prev) =>
          prev.syncWarnings && prev.syncWarnings.length > 0
            ? prev // a status:data push beat us — it's the fresher source
            : { ...prev, syncWarnings: s.warnings });
      })
      .catch(() => {});
  }, []);

  // Red dot on the gear icon so the user can't miss a push failure —
  // derived from the pushed warnings, no dedicated poll.
  const settingsDangerBadge = useMemo(
    () => (statusData.syncWarnings ?? []).some((w) => w?.level === 'danger'),
    [statusData.syncWarnings],
  );

  const handleOpenDrawer = useCallback((searchMode: boolean) => {
    setDrawerSearchMode(searchMode);
    setDrawerOpen(true);
    // When opened via "/" in InputBar, the InputBar drives the filter
    // When opened via compass button, use the drawer's internal search
    if (!searchMode) setDrawerFilter(undefined);
  }, []);

  const handleCloseDrawer = useCallback(() => {
    setDrawerOpen(false);
    setDrawerFilter(undefined);
  }, []);

  // Shift+Space cycles model in chat view
  const cycleModelRef = useRef<(() => void) | null>(null);
  const cycleModel = useCallback(() => {
    if (!sessionId) return;
    // Native sessions can't cycle CC aliases — see supportsAliasCycling for the
    // failure this prevents (a chip relabeled to a model the session isn't
    // running, plus a stray write to the global model preference).
    if (!supportsAliasCycling(sessions.find((s) => s.id === sessionId))) return;
    // currentModel may be 'unknown' — indexOf then legitimately returns -1,
    // which wraps to index 0 below, so cycling from an unknown state starts fresh.
    const idx = MODELS.indexOf(currentModel as ModelAlias);
    const next = MODELS[(idx + 1) % MODELS.length];
    // Send first, guarded: while a prompt is pending, "/model …\r" would land
    // on CC's live Ink menu and answer it. Refusing BEFORE the optimistic
    // state writes also keeps the model pill truthful when nothing was sent.
    if (!guardedPtySend(sessionId, `/model ${next}\r`)) return;
    setSessionModels((prev) => new Map(prev).set(sessionId, next));
    setPendingModel(next);
    // Fix: don't verify against in-flight events from the current turn —
    // wait until a new user turn starts so we know Claude is using the new model.
    postSwitchTurnReady.current = false;
    // Persist preference optimistically — the /model command is reliable,
    // verification is just a safety net. If verification later shows a
    // mismatch, the failure handler overwrites with the actual model.
    (window.claude as any).model?.setPreference(next);
  }, [currentModel, sessionId, guardedPtySend, sessions]);
  cycleModelRef.current = cycleModel;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip when a text input (or the CodeMirror editor) is focused —
      // Shift+Space is a normal typing combo and would fire accidentally
      // (spec §12.6).
      if (isTypingTarget(e.target as Element)) return;
      if (e.shiftKey && e.key === ' ') {
        e.preventDefault();
        cycleModelRef.current?.();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  // Verify model switch via transcript events.
  // Fix: (1) properly remove the listener on cleanup to prevent leaked handlers
  // that fire stale closures and cause repeated false "failed to switch" errors.
  // (2) Wait for a new user turn after the switch before verifying — events
  // from the in-flight turn still carry the old model and would false-alarm.
  useEffect(() => {
    if (!pendingModel) return;

    const handler = (window.claude.on as any).transcriptEvent?.((event: any) => {
      if (!event || event.sessionId !== sessionId) return;

      // A user-message after the switch means the next assistant response
      // will reflect the new model — safe to verify from here on.
      if (event.type === 'user-message') {
        postSwitchTurnReady.current = true;
        return;
      }

      if (event.type !== 'assistant-text' || !event.data?.model) return;
      // Skip events from the turn that was already in-flight when we switched
      if (!postSwitchTurnReady.current) return;

      const actualModel = event.data.model as string;
      // Fix: a `<synthetic>` turn is CC talking, not a model — "You've hit your
      // session limit", "You're out of usage credits", "Please run /login". It
      // carries no evidence about which model the switch landed on, so
      // verifying against it produced "Couldn't switch to Sonnet" (and on a
      // second one, "Model switch failed again… report a bug") when the switch
      // had not failed at all. That is a guessed cause in a user-facing string
      // — see docs/error-message-standards.md. Stay pending and verify against
      // the next REAL turn instead.
      if (isPlaceholderModelId(actualModel)) return;
      const baseKey = (k: string) => k.replace(/\[.*\]/, '');
      const matches = actualModel.includes(baseKey(pendingModel));
      if (matches) {
        setPendingModel(null);
        consecutiveFailures.current = 0;
        // Preference already persisted optimistically in cycleModel
      } else {
        const actual = MODELS.find(m => actualModel.includes(baseKey(m)));
        // Revert this session's model and persisted preference to what Claude is actually using
        if (actual) {
          if (sessionId) setSessionModels((prev) => new Map(prev).set(sessionId, actual));
          (window.claude as any).model?.setPreference(actual);
        }
        const failures = consecutiveFailures.current + 1;
        consecutiveFailures.current = failures;
        setPendingModel(null);
        if (failures >= 2) {
          setToast({ message: "Model switch failed again. Ask Claude to diagnose with /model, or report a bug.", durationMs: 4000 });
        } else {
          setToast({ message: "Couldn't switch to " + pendingModel.charAt(0).toUpperCase() + pendingModel.slice(1), durationMs: 4000 });
        }
      }
    });

    // Fix: properly remove the IPC/WebSocket listener on cleanup so stale
    // closures don't accumulate and fire on future transcript events.
    return () => {
      if (handler) {
        (window.claude as any).off?.('transcript:event', handler);
      }
    };
  }, [pendingModel, sessionId]);

  // Passive drift reconciliation: silently align the session pill with what
  // Claude actually used, whenever the transcript reveals they disagree.
  //
  // The verify-model-switch effect above only runs during a user-initiated
  // Shift+Space / picker flip (pendingModel !== null). This effect catches the
  // cases that flow doesn't see:
  //   - user typed `/model sonnet` directly into the terminal view
  //   - Claude Code auto-downshifted on rate-limit
  //   - session resume picked up a different model than was selected
  //
  // Walks the timeline back to the most recent assistant turn with a known
  // model (set by TRANSCRIPT_ASSISTANT_TEXT in Task 2.4 and reconfirmed by
  // TRANSCRIPT_TURN_COMPLETE in Task 2.3), maps it to a ModelAlias, and if it
  // disagrees with sessionModels[sessionId], silently updates both the pill
  // state AND the persisted preference. No PTY writes — we're reflecting
  // reality, not trying to change the backend model.
  //
  // Gated on !pendingModel so this doesn't race with the verify effect during
  // a user-initiated switch (the in-flight turn still carries the old model
  // and would cause this effect to undo the user's intent prematurely).
  //
  // Tranche 1: the timeline walk moved into useActiveSessionModel (a cached
  // store selector). That preserves BOTH of this effect's original triggers —
  // a transcript event that reveals a new model for the active session
  // (activeSessionModel dep), AND a session switch (sessionId dep, so switching
  // INTO a session that drifted while backgrounded still reconciles its pill) —
  // without AppInner re-rendering on every dispatch the way the old
  // [chatStateMap] dep forced. See the plan's Task 9 option (c).
  const activeSessionModel = useActiveSessionModel(sessionId);
  useEffect(() => {
    if (!sessionId || pendingModel) return;
    // Moved-session guard (merged from master's self-heal fix): a moved session
    // (Plan 2b Moved Gate) deliberately deletes its sessionModels entry while
    // KEEPING its timeline (destroyedHandler). Without this guard the loosened
    // check below would read that undefined entry as drift, fire a spurious
    // GLOBAL setPreference() for a session the user didn't pick and this window
    // no longer owns, and resurrect the map entry the gate just cleaned up.
    if (movedSessionsRef.current.has(sessionId)) return;
    if (!activeSessionModel) return;

    const currentAlias = sessionModels.get(sessionId);
    // Compare directly, NOT `currentAlias && currentAlias !== …` (master's fix):
    // a session with NO map entry renders 'unknown' on the pill, but currentAlias
    // is `undefined` here — falsy — so the old truthiness gate skipped the repair
    // and the pill stayed stuck (red/unknown) forever. Direct comparison heals
    // both the explicit 'unknown' sentinel and the missing-entry case.
    if (currentAlias !== activeSessionModel) {
      // Drift detected — reconcile silently. Also the self-heal path for a pill
      // stuck on the 'unknown' sentinel: the moment a real model shows up in
      // the transcript, this overwrites it. setPreference persists to disk
      // (so next session boots with the correct default); setSessionModels
      // updates the status-bar pill + Shift+Space cycle start point.
      (window.claude as any).model?.setPreference(activeSessionModel);
      setSessionModels((prev) => new Map(prev).set(sessionId, activeSessionModel));
    }
  }, [sessionId, activeSessionModel, sessionModels, pendingModel]);

  // Snapshot factory for /cost and /usage. Pulls live stats from statusData
  // and freezes them as a point-in-time snapshot. Returns null only when the
  // session has nothing at all to describe — that is a Claude Code session
  // whose statusline hook hasn't run yet (it runs after each command, so a
  // brand-new one has no data for a few seconds). A NATIVE session always has
  // its own session totals to fall back on (Task 14), so it gets a card
  // immediately; "returns null if stats haven't arrived" stopped being true
  // then.
  const getUsageSnapshot = useCallback(
    // The derivation itself lives in state/usage-snapshot.ts — a pure function,
    // so the thing /usage is entirely made of can be tested without rendering
    // App (no test imports this file). This wrapper only gathers the inputs.
    (sid: string) => {
      const info = sessionsRef.current.find((x) => x.id === sid);
      // A session bound to the ChatGPT plan reports THAT plan's windows on the
      // card (questions deck Q-4a); every other session keeps Claude's.
      // info.providerType is what the session itself says it is billed to; the
      // model-id lookup is only the fallback (see hooks/use-provider-type.ts).
      const onChatGpt = info?.provider === 'native' && resolveProviderType(info.model, info.providerType) === 'chatgpt';
      return buildUsageSnapshot({
        sessionId: sid,
        now: Date.now(),
        stats: statusData.sessionStatsMap[sid],
        contextPercent: statusData.contextMap[sid] ?? null,
        usage: (onChatGpt ? statusData.chatgptUsage : statusData.usage) as SubscriptionUsage | null,
        subscriptionPlan: onChatGpt ? 'chatgpt' : 'claude',
        isNative: info?.provider === 'native',
        session: chatStateMapRef.current.get(sid),
      });
    },
    [statusData],
  );

  const handleSelectCommand = useCallback(
    (entry: CommandEntry) => {
      // Defensive: disabled cards should never fire onClick in the UI, but if
      // something does route a CC-builtin here, no-op rather than sending
      // text that won't work in chat view.
      if (!entry.clickable) return;
      if (!sessionId) return;
      setDrawerOpen(false);
      setDrawerFilter(undefined);
      inputBarRef.current?.clear();

      if (entry.source === 'youcoded') {
        const currentView = viewModes.get(sessionId) || 'chat';
        const result = dispatchSlashCommand({
          raw: entry.name,
          sessionId,
          view: currentView,
          files: [],
          dispatch,
          timeline: [],
          // onToast: master's change 44 moved the dismiss timer INTO <Toast>, so
          // the hand-rolled setTimeout this branch carried would now be a second,
          // competing timer. Take master's plain form.
          callbacks: { onResumeCommand: () => setResumeRequested(true), getUsageSnapshot, onOpenPreferences: () => setPreferencesOpen(true), onToast: (msg: string) => setToast(msg), getSessionState: (sid: string) => chatStateMapRef.current.get(sid), onOpenModelPicker: () => setModelPickerOpen(true) },
          // Native /clear is durable-first — see deferUiEffectsToRuntime.
          deferUiEffectsToRuntime: sessionsRef.current.find((x) => x.id === sessionId)?.provider === 'native',
        });
        // Not gated on `result.handled`: an unrecognized command is handled:false
        // yet still carries an invoke-skill intent for native sessions (see
        // routeSlashResult). Returning true means it was consumed here.
        if (runSlashResult(sessionId, result)) return;
        // Dispatcher declined (e.g. missing callback) — fall through to raw PTY send.
      }

      // Filesystem commands (and any unhandled YouCoded command) — send the
      // slash command to the PTY so Claude Code executes it. Also record the
      // optimistic user prompt so the chat timeline shows the action.
      // Send first, guarded (pending-prompt gate) — dispatching the bubble for
      // a refused send would leave a stale pending entry in the timeline.
      if (!guardedPtySend(sessionId, `${entry.name}\r`)) {
        // Was a bare `return`: guardedPtySend refuses for native sessions and
        // toasts only for the pending-interaction case, so a native user clicking
        // a drawer command got nothing at all (handoff §2.3).
        setToast(`${entry.name} isn't available in YouCoded-runtime sessions yet.`);
        return;
      }
      dispatch({
        type: 'USER_PROMPT',
        sessionId,
        content: entry.name,
        timestamp: Date.now(),
      });
    },
    [sessionId, dispatch, viewModes, getUsageSnapshot, guardedPtySend],
  );

  const handleSelectSkill = useCallback(
    (skill: SkillEntry) => {
      // No '_resume' branch: resume was once a synthetic skill injected into the
      // drawer list, but that list was the dead `skills` state above, so this was
      // already unreachable. Resume is reached via onResumeCommand / the welcome
      // card / onOpenResumeBrowser — all of which call setResumeRequested directly.
      if (!sessionId) return;
      setDrawerOpen(false);
      setDrawerFilter(undefined);
      inputBarRef.current?.clear();

      // If the skill's prompt is a slash command, route it through the dispatcher
      // so drawer-initiated /clear (etc.) behaves the same as typed /clear.
      // Non-slash prompts (natural language) fall through to the existing send path.
      const trimmedPrompt = skill.prompt.trim();
      if (trimmedPrompt.startsWith('/')) {
        const currentView = viewModes.get(sessionId) || 'chat';
        const result = dispatchSlashCommand({
          raw: skill.prompt,
          sessionId,
          view: currentView,
          files: [],
          dispatch,
          timeline: [],
          // onToast: master's change 44 moved the dismiss timer INTO <Toast>, so
          // the hand-rolled setTimeout this branch carried would now be a second,
          // competing timer. Take master's plain form.
          callbacks: { onResumeCommand: () => setResumeRequested(true), getUsageSnapshot, onOpenPreferences: () => setPreferencesOpen(true), onToast: (msg: string) => setToast(msg), getSessionState: (sid: string) => chatStateMapRef.current.get(sid), onOpenModelPicker: () => setModelPickerOpen(true) },
          // Native /clear is durable-first — see deferUiEffectsToRuntime.
          deferUiEffectsToRuntime: sessionsRef.current.find((x) => x.id === sessionId)?.provider === 'native',
        });
        // Same reasoning as the drawer path: not gated on `result.handled`,
        // because a skill whose prompt is /<another-skill> lands on the
        // unhandled branch carrying an invoke-skill intent.
        if (runSlashResult(sessionId, result)) return;
      }

      // Sanitize through the same one-source helper InputBar uses: skill
      // prompts can be multiline, and (a) raw newlines written to the PTY act
      // as premature Enter presses on short sends, (b) the optimistic bubble
      // must exactly match the sanitized text or the transcript confirm never
      // clears its pending flag (see outgoing-message.ts).
      const outgoing = buildOutgoingMessage(skill.prompt, []);
      if (!outgoing) return;
      // Send first, guarded (pending-prompt gate) — dispatching the bubble for
      // a refused send would leave a stale pending entry in the timeline.
      if (!guardedPtySend(sessionId, outgoing.ptyText + '\r')) {
        // Native sessions have no PTY. A skill's natural-language prompt has no
        // harness path yet (that is the Skill tool's job, model-invoked), so say
        // so rather than dropping it silently (handoff §2.3).
        setToast("That skill can't be started from here in a YouCoded-runtime session yet.");
        return;
      }
      dispatch({
        type: 'USER_PROMPT',
        sessionId,
        content: outgoing.content,
        timestamp: Date.now(),
      });
    },
    [sessionId, dispatch, viewModes, getUsageSnapshot, guardedPtySend],
  );

  const createSession = useCallback(async (cwd: string, dangerous: boolean, sessionModel?: string, provider?: 'claude' | 'native', launchInNewWindow?: boolean, binding?: { providerId: string; modelId: string }, preset?: string) => {
    // Use the explicitly chosen model; fall back to the current session's model.
    // realModelAlias guards against sending the literal 'unknown' sentinel to CC.
    const m = sessionModel || realModelAlias(currentModel);
    const info = await (window.claude.session.create as any)({
      name: 'New Session',
      cwd,
      skipPermissions: dangerous,
      // A Claude alias is meaningless for a native session (the harness uses
      // binding.modelId; SessionManager's native branch ignores `model`), so
      // omit it to keep the payload honest.
      model: provider === 'native' ? undefined : m,
      provider: provider || 'claude',
      // Native runtime only — the provider/model binding for the harness. The
      // main handler requires it for a fresh native session (session-manager
      // throws otherwise); undefined for claude sessions.
      binding: provider === 'native' ? binding : undefined,
      // Native runtime only — the harness preset (Assistant | Coder) the fresh
      // session is stamped with. Ignored for claude sessions.
      preset: provider === 'native' ? preset : undefined,
    });
    // I1 fix: deliver the RESOLVED harnessId to the live session pill. The
    // session:created event that seeds the sessions entry is emitted+sent
    // (process.nextTick) BEFORE the main handler finishes create/resume, so on a
    // resume it carries harnessId=undefined (session-manager can only seed it for
    // a fresh create; the resumed id is header-derived, known only after
    // nativeHost.resume awaits). The main handler re-stamps the resolved id onto
    // the SessionInfo it RETURNS — patch the entry from that invoke result here.
    if (info?.harnessId) {
      setSessions((prev) => prev.map((s) => (s.id === info.id ? { ...s, harnessId: info.harnessId } : s)));
    }
    // Launch-in-new-window: hand the freshly-created session off to a peer
    // window via the same ownership-transfer path used by drag-detach.
    if (launchInNewWindow && info?.id) {
      (window as any).claude?.detach?.openDetached?.({ sessionId: info.id });
    }
  }, [currentModel]);

  // Client-side removal for a session that is ALREADY dead in the main process
  // (Moved Gate Exit/Resume, where `session.destroy()` would no-op and emit no
  // session:destroyed event). Mirrors destroyedHandler's state cleanup MINUS the
  // death banner (SESSION_PROCESS_EXITED) — the session moved, it didn't die.
  const removeSessionLocally = useCallback((id: string) => {
    setSessions((prev) => {
      const remaining = prev.filter((s) => s.id !== id);
      setSessionId((curr) => (curr !== id ? curr : (remaining.length > 0 ? remaining[remaining.length - 1].id : null)));
      return remaining;
    });
    setViewModes((prev) => { const n = new Map(prev); n.delete(id); return n; });
    setPermissionModes((prev) => { const n = new Map(prev); n.delete(id); return n; });
    setNativePermissionModes((prev) => { const n = new Map(prev); n.delete(id); return n; });
    setSessionModels((prev) => { const n = new Map(prev); n.delete(id); return n; });
    setInitializedSessions((prev) => { if (!prev.has(id)) return prev; const n = new Set(prev); n.delete(id); return n; });
    dispatch({ type: 'SESSION_REMOVE', sessionId: id });
    clearMoved(id);
  }, [dispatch, clearMoved]);

  // Returns whether a resume was actually launched (true), or was aborted / failed
  // / deferred to the pre-resume picker (false). Callers that own a modal or row
  // spinner (the pendingNativeResume modal, ResumeBrowser) await this and keep
  // their UI open on false instead of closing over a silent failure (Task 6 review
  // — the create ack-gap: a create that never returned an id used to be a silent
  // `return`, leaving the user staring at nothing).
  const handleResumeSession = useCallback(async (claudeSessionId: string, projectSlug: string, projectPath: string, resumeModel?: string, resumeDangerous?: boolean, launchInNewWindow?: boolean, provider?: string, nativeBinding?: ModelBinding): Promise<boolean> => {
    const cwd = projectPath;

    // Plan 2b Task 9 — conversation-lease takeover gate. Before resuming, ask the
    // hub whether this conversation is actively held on ANOTHER device. If so,
    // offer to take over here (the holder hands off), falling back to a
    // force-takeover if the holder doesn't respond. NEVER hard-blocks the resume:
    // any lease error just proceeds (spec §3 never-block).
    //
    // Self-device decision: the query result's `self` flag is computed in the
    // main process from the per-install deviceId (NOT the hostname label). We gate
    // the dialog on "held AND not self" so a lease left over from OUR OWN install
    // (e.g. after an unclean shutdown) resumes straight through instead of popping
    // a confusing "active on <your-own-hostname>" takeover dialog.
    try {
      const q = await window.claude.syncSpaces?.leaseQuery?.(claudeSessionId);
      if (q?.held && !q.self) {
        const device = q.device || 'another device';
        const confirmed = await askTakeover(device, 'confirm');
        if (!confirmed) return false; // "Never mind" — abort the resume
        const r = await window.claude.syncSpaces?.leaseTakeover?.(claudeSessionId);
        // 'timeout' (asked, no answer) and 'undeliverable' (never asked — hub had
        // no delivery path) both offer the SAME force path, just with different
        // dialog copy — see takeoverDialogCopy. Never collapse them into one
        // phase: that's exactly the dishonest "isn't responding" framing this
        // 3-state redesign replaced.
        if (r?.outcome === 'timeout' || r?.outcome === 'undeliverable') {
          const forced = await askTakeover(device, r.outcome === 'undeliverable' ? 'undeliverable' : 'force');
          if (!forced) return false; // "Never mind" — abort
          const fr = await window.claude.syncSpaces?.leaseForce?.(claudeSessionId);
          // A failed force means the lease was never overwritten — the other device
          // may STILL be live and holding it. Never-block (proceed with the resume),
          // but say so: the user is about to have two writers on one transcript and
          // recent turns may be missing. Silent here was the 2026-07-18 bug's mask.
          if (fr && fr.ok === false) {
            setToast({ message: `Couldn't confirm the handoff from ${device} — it may still be editing this conversation, and recent turns may be missing.`, durationMs: 8000 });
          }
        } else if (r?.outcome === 'error') {
          // The takeover request itself failed (hub error / exception). Same deal:
          // proceed (never-block) but warn that the other device may still be live.
          setToast({ message: `Couldn't reach ${device} to hand off this conversation — it may still be editing, and recent turns may be missing.`, durationMs: 8000 });
        }
        // 'acquired' -> clean handoff, fall through and resume.
      }
    } catch { /* never-block: a lease query/takeover failure must not stop the resume */ }

    // Native-harness resume. Task 6 / Destin's ruling: NEVER auto-launch a
    // binding — the resume-time model selector is ALWAYS the source of the
    // binding this resume launches on, on any device. Without one in hand yet,
    // open the pre-resume picker modal instead of creating with the (possibly
    // stale, possibly entirely absent on this device) header binding.
    if (provider === 'native' && !nativeBinding) {
      setPendingNativeBinding(null);
      setPendingNativeResume({ claudeSessionId, projectSlug, projectPath, launchInNewWindow });
      return false; // deferred to the pre-resume picker — not launched yet
    }
    if (provider === 'native') {
      const nativeSession = await (window.claude.session.create as any)({
        // WHY the constant: main's title feeder must be able to RECOGNIZE this
        // as a placeholder (shared/session-title.ts). A bare literal here is
        // what let it pass as a real title and block auto-titling on resume.
        name: RESUMING_NATIVE,
        cwd,
        skipPermissions: false, // native sessions have no PTY permission flow
        provider: 'native',
        resumeSessionId: claudeSessionId,
        binding: nativeBinding, // the selector's pick — becomes the live binding (native-session-host.ts resume() override)
      });
      if (!nativeSession?.id) {
        // The create never acked (Task 6 review — was a silent return). Main also
        // emits a session-error for the split not-synced / folder-missing / data-
        // missing REFUSAL cases (those DO return an id, so they don't land here);
        // this covers a create that returned nothing at all. Non-committal per
        // error standards — the exact cause isn't known on this side.
        setToast({ message: "Couldn't resume this conversation.", durationMs: 6000 });
        return false;
      }
      // I1 fix (resume path): same invoke-result patch as createSession — the
      // session:created event seeded this entry with harnessId=undefined (resume
      // can't seed it synchronously), so the live pill would read "Assistant" for
      // a resumed Coder session. The returned SessionInfo carries the resolved id.
      if (nativeSession.harnessId) {
        setSessions((prev) => prev.map((s) => (s.id === nativeSession.id ? { ...s, harnessId: nativeSession.harnessId } : s)));
      }
      if (launchInNewWindow) {
        (window as any).claude?.detach?.openDetached?.({ sessionId: nativeSession.id });
      }
      // Hydrate the chat view from disk — the most recent page only.
      void loadFirstPage(nativeSession.id);
      return true;
    }

    // Use explicitly chosen resume model; fall back to the current session's model.
    // realModelAlias guards against sending the literal 'unknown' sentinel to CC.
    const m = resumeModel || realModelAlias(currentModel);

    // Pass --resume flag so Claude Code boots directly into the resumed session
    const newSession = await (window.claude.session.create as any)({
      name: RESUMING_CLAUDE, // see RESUMING_NATIVE above — different spelling, same contract
      cwd,
      skipPermissions: resumeDangerous || false,
      resumeSessionId: claudeSessionId,
      model: m,
    });
    if (!newSession?.id) {
      // Honest failure instead of a silent return (Task 6 review — the CC ack-gap).
      setToast({ message: "Couldn't resume this conversation.", durationMs: 6000 });
      return false;
    }

    // Launch-in-new-window for resumed sessions — same peer-window spawn path.
    if (launchInNewWindow) {
      (window as any).claude?.detach?.openDetached?.({ sessionId: newSession.id });
    }

    // Load the most recent page into the chat view. The transcript watcher does
    // not know this session yet (CC's hook reports the path moments later), so
    // pass the locator the page handler can resolve the file from.
    void loadFirstPage(newSession.id, { claudeSessionId, projectSlug });
    return true;
  }, [dispatch, currentModel, askTakeover, loadFirstPage]);

  // Cards deep in the chat tree ask for a resume by event — the same
  // deep-component→destination pattern as youcoded:open-library (~:397).
  // It has to live HERE rather than next to that listener: it closes over
  // handleResumeSession, a `const` declared just above, and referencing a
  // later const from an earlier point in the same function body throws
  // (temporal dead zone) — this is the earliest point after its declaration.
  // launchInNewWindow is passed undefined on purpose (spec
  // 2026-08-26-conversation-preview-header-design.md A2, Destin: "not new
  // 'window' just new tab in session") — chat-search Resume always opens a
  // tab, never the detached-window path SessionStrip/ResumeBrowser offer.
  useEffect(() => {
    const onResume = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        claudeSessionId?: string; projectSlug?: string; projectPath?: string; provider?: string;
        model?: string; dangerous?: boolean; binding?: ModelBinding;
      };
      // The three fields SessionRefActions.requestResume always sends
      // (SessionDrawer's preview header sends the same shape). A detail
      // missing any of them can't be resumed — silently drop it rather than
      // calling handleResumeSession with a hole in its arguments.
      if (!d?.claudeSessionId || !d.projectSlug || !d.projectPath) return;
      // model / dangerous / binding arrive only from the preview header's
      // Resume popover (M-header). A search row's own Resume sends none of
      // them, and undefined here is what handleResumeSession already treated
      // as "use the session defaults" — so that path is unchanged.
      void handleResumeSession(d.claudeSessionId, d.projectSlug, d.projectPath, d.model, d.dangerous, undefined, d.provider, d.binding);
    };
    window.addEventListener('youcoded:resume-session', onResume);
    return () => window.removeEventListener('youcoded:resume-session', onResume);
  }, [handleResumeSession]);

  // A shell session has no chat side — no transcript, no model, nothing to show
  // in the chat pane — so its view is FORCED to the terminal here rather than
  // merely defaulted. Forcing (not seeding) is what makes the header's toggle
  // and the Ctrl+` shortcut unable to strand the user on an empty chat pane.
  const activeSessionProvider = sessionId ? sessions.find((s) => s.id === sessionId)?.provider : undefined;
  const isShellSession = activeSessionProvider === 'shell';
  const currentViewMode = isShellSession ? 'terminal' : (sessionId ? (viewModes.get(sessionId) || 'chat') : 'chat');

  // Mirror the active view mode onto <html data-view-mode="..."> so CSS can
  // react to it. Needed on Android to hide the wallpaper layer over the native
  // terminal — the React-side bg div sits on top of the native TerminalView
  // and opaque wallpapers were blocking the terminal text from showing through.
  useEffect(() => {
    document.documentElement.dataset.viewMode = currentViewMode;
  }, [currentViewMode]);

  // Auto-dismiss: the hint has done its job the moment the user is back in chat.
  // Keyed on the view rather than on the toggle's own click so the keyboard
  // shortcut and a remote switch clear it too.
  useEffect(() => {
    if (currentViewMode === 'chat') setBackToChatHint(false);
  }, [currentViewMode]);

  const handleToggleView = useCallback(
    (mode: ViewMode) => {
      if (!sessionId) return;
      // A shell session is terminal-only. The header hides its toggle, but Ctrl+`
      // still lands here, so refuse rather than trust the callers. (A remote or
      // Android `switch-view` does NOT come through here — it writes viewModes
      // directly, up in the uiAction handler — and is neutralised instead by
      // currentViewMode forcing the terminal for a shell session.)
      if (sessionsRef.current.find((x) => x.id === sessionId)?.provider === 'shell') return;
      setViewModes((prev) => new Map(prev).set(sessionId, mode));
      // On Android, tell the native side to switch views
      if (getPlatform() === 'android') {
        (window as any).claude?.remote?.broadcastAction?.({ action: 'switch-view', mode });
      }
    },
    [sessionId],
  );

  // Ctrl+` toggles between chat and terminal view
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
        handleToggleView(currentViewMode === 'chat' ? 'terminal' : 'chat');
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [handleToggleView, currentViewMode]);

  // ESC-passthrough: forward ESC to the active session's PTY when chat is
  // focused and no overlay consumed the event. Single \x1b byte — Claude Code
  // treats it as an interrupt. See
  // docs/superpowers/specs/2026-04-21-esc-chat-passthrough-design.md and
  // docs/PITFALLS.md -> "PTY Writes". Reactive state is read via a ref so the
  // listener isn't re-registered on every sessionId/viewMode change.
  const escPassthroughStateRef = useRef<{
    activeSessionId: string;
    viewMode: 'chat' | 'terminal';
    // Widened for the 'shell' provider (2026-09-05). ESC into a shell session is
    // correct — it reaches the PTY, which is what ESC does in any terminal.
    provider: SessionProvider | undefined;
  }>({ activeSessionId: '', viewMode: 'chat', provider: 'claude' });
  escPassthroughStateRef.current = {
    activeSessionId: sessionId ?? '',
    viewMode: currentViewMode,
    // Inlined (not currentSession, which is declared below) — this ref is
    // assigned during render before currentSession exists.
    provider: sessions.find((s) => s.id === sessionId)?.provider,
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const s = escPassthroughStateRef.current;
      const forward = shouldForwardEscToPty({
        defaultPrevented: e.defaultPrevented,
        viewMode: s.viewMode,
        hasActiveSession: !!s.activeSessionId,
      });
      if (!forward) return;
      // Native sessions have no PTY — interrupt the in-process harness stream
      // directly. (native.interrupt is the provider-side equivalent of the ESC
      // byte; a raw \x1b would go nowhere.)
      if (s.provider === 'native') {
        window.claude.native.interrupt(s.activeSessionId);
        return;
      }
      // One byte to the PTY — Claude Code treats it as an interrupt.
      // Single-byte writes do NOT trigger Ink's 500ms paste-mode coalescing,
      // so no chunking or pacing is needed. See docs/PITFALLS.md -> "PTY Writes".
      window.claude.session.sendInput(s.activeSessionId, '\x1b');
    };
    // Bubble phase on purpose — EscCloseProvider owns capture phase, and we
    // need to read e.defaultPrevented AFTER capture-phase overlay handlers run.
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Ctrl+O toggles expand-all / collapse-all across every collapsible tool
  // card, tool group, and agent section in the chat view. The hook module
  // persists the current mode so child ToolCards that mount AFTER the
  // shortcut fires (e.g. inside a tool group that just opened) read the mode
  // via getInitialExpanded() and come up in the right state. Terminal view
  // ignores the shortcut so the keystroke passes to the PTY.
  const viewModeRef = useRef(currentViewMode);
  viewModeRef.current = currentViewMode;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.shiftKey || e.altKey) return;
      if (e.key !== 'o' && e.key !== 'O') return;
      if (viewModeRef.current !== 'chat') return;
      e.preventDefault();
      if (isInExpandAllMode()) {
        broadcastCollapseAll();
      } else {
        broadcastExpandAll();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  const currentSession = sessions.find((s) => s.id === sessionId);
  const canBypass = currentSession?.skipPermissions ?? false;
  // Native sessions: permission modes are a harness policy (Phase 2), not a
  // PTY shift+tab cycle — hide the badge + cycle affordance for them.
  const isNativeSession = currentSession?.provider === 'native';
  // Sign in with ChatGPT (2026-09-04): which provider the bound model runs on,
  // and what to offer when its plan window runs out (the plan-limit card).
  const activeProviderType = useModelProviderType(
    isNativeSession ? currentSession?.model : null,
    isNativeSession ? currentSession?.providerType : null,
  );
  const onChatGptPlan = activeProviderType === 'chatgpt';
  // What the StatusBar model chip renders — see model-chip.ts for why native
  // sessions bypass the Claude Code alias matcher entirely.
  const modelChip = modelChipFor(currentSession, currentModel);
  // Native StatusBar chips (Plan C Task 12): the active native session's
  // most-recent completed-turn usage. MERGE RECONCILIATION — this was originally
  // a useMemo over `chatStateMap`, but AppInner perf tranche 1 replaced that
  // reactive value with `chatStateMapRef` (a ref fed by a store subscription), so
  // the memo no longer compiles and a ref would never re-render the chips. It is
  // re-expressed here as a cached store selector, mirroring useActiveSessionModel.
  const nativeStatusUsage = useNativeSessionUsage(isNativeSession ? sessionId : null);
  // NOT gated on isNativeSession — CC turns carry usage too (the transcript
  // watcher stamps it), and the reuse chip serves both runtimes.
  const turnsWithUsage = useTurnsWithUsage(sessionId);
  // Session-so-far totals for the bar's token / cost / code-change chips.
  //
  // Fix (2026-09-03): this used to be gated on isNativeSession, with the note
  // "Null for CC sessions, which take those numbers from the statusline". The
  // statusline cannot supply them: `context_window.total_input_tokens` and
  // `total_output_tokens` describe the CURRENT REQUEST, not the session (the
  // shipped CLI builds that whole object from one usage record — see
  // hook-scripts/statusline.sh), which is why a 42-hour session's Out: chip read
  // 713. Claude Code turns DO accumulate into session.totals — the reducer says
  // so at TRANSCRIPT_TURN_COMPLETE — and now that the transcript watcher sums
  // every request of a turn rather than only its last one, those totals are
  // real. Ungated, so In:/Out:/Cached:/Reuse mean "this session so far" on both
  // runtimes, which is what their shared labels have always claimed.
  const sessionTotals = useNativeSessionTotals(sessionId);
  // A session with no map entry at all (a gap in the seeding paths above) reads
  // as 'unknown', not 'normal' — 'normal' would claim a specific, possibly wrong
  // permission posture instead of admitting YouCoded hasn't determined it yet.
  const currentPermissionMode: PermissionMode | 'unknown' = sessionId ? (permissionModes.get(sessionId) ?? 'unknown') : 'normal';
  // Native mode defaults to 'ask' only for the brief window before the async
  // getPermissionMode() call above resolves (mirrors NativeSessionHost's real
  // starting mode) — once it resolves, the map always holds either the real
  // mode or the explicit 'unknown' sentinel, never a guess.
  const currentNativeMode: NativePermissionMode | 'unknown' = sessionId ? (nativePermissionModes.get(sessionId) ?? 'ask') : 'ask';

  // Native permission chip: cycle ask → auto-edit → full-auto → ask via the
  // Task 12 IPC (NOT a PTY Shift+Tab — native sessions have no PTY). The IPC
  // returns the APPLIED mode, which is authoritative — state updates from the
  // return value, not the optimistic `next` (no screen-scrape correction path).
  const cycleNativePermission = useCallback(async () => {
    if (!sessionId) return;
    const cycle: NativePermissionMode[] = ['ask', 'auto-edit', 'full-auto'];
    // currentNativeMode may be 'unknown' — indexOf then legitimately returns -1,
    // which wraps to index 0 below, so cycling from an unknown state starts fresh.
    const idx = cycle.indexOf(currentNativeMode as NativePermissionMode);
    const next = cycle[(idx + 1) % cycle.length];
    try {
      const applied = await window.claude.native.setPermissionMode(sessionId, next);
      // Validate before storing: the normal path returns a bare mode string, but
      // the remote path converts a host throw into a resolved {ok:false,...}
      // object (remote-shim). Storing that would corrupt the chip's
      // PERMISSION_DISPLAY lookup — leave state unchanged on anything unexpected.
      const VALID: NativePermissionMode[] = ['ask', 'auto-edit', 'full-auto'];
      if (VALID.includes(applied as NativePermissionMode)) {
        setNativePermissionModes((prev) => new Map(prev).set(sessionId, applied as NativePermissionMode));
      } else {
        console.error('Native permission mode not applied:', applied);
      }
    } catch (err) {
      // A rejected invoke means an unknown-mode wiring bug in the host — leave
      // the chip on its current (unchanged) mode rather than lying about state.
      console.error('Failed to set native permission mode:', err);
    }
  }, [sessionId, currentNativeMode]);

  // Shift+Tab cycles permission mode in chat view
  // (In terminal view, the raw escape code reaches the PTY directly)
  const cyclePermissionRef = useRef<(() => void) | null>(null);
  const cyclePermission = useCallback(() => {
    if (!sessionId) return;
    // 'auto' is plan-gated by Anthropic — only included in the optimistic cycle
    // when the active session is on Opus 4.7 1M (the only model in our
    // ModelAlias union that has access). On other models, CC's Shift+Tab won't
    // surface auto, so showing it would create a click-but-nothing-happens
    // state. The PTY watcher above corrects mismatches within ~1 tick anyway.
    // A shell session has no permission modes to cycle, and the write below is a
    // RAW sendInput that bypasses guardedPtySend/canPtySend entirely — its only
    // other shield is isTypingTarget, which is false whenever xterm does not
    // hold focus. Open Run in terminal, click the header pill, press Shift+Tab,
    // and the app types \x1b[Z at the user's own prompt. Inert on a default
    // bash/zsh/fish, but a bound shift-tab (oh-my-zsh reverse-menu-complete,
    // fish complete-and-search) edits the line they are about to run. This is
    // the guard that makes pty-input-gate's "exactly once, at creation, and
    // never again" true.
    if (sessionsRef.current.find((x) => x.id === sessionId)?.provider === 'shell') return;
    const canAuto = currentModel === 'opus[1m]';
    const cycle: PermissionMode[] = [
      'normal',
      'auto-accept',
      'plan',
      ...(canAuto ? ['auto' as PermissionMode] : []),
      ...(canBypass ? ['bypass' as PermissionMode] : []),
    ];
    // currentPermissionMode may be 'unknown' — indexOf then legitimately returns
    // -1, which wraps to index 0 below, so cycling from an unknown state starts fresh.
    const idx = cycle.indexOf(currentPermissionMode as PermissionMode);
    const next = cycle[(idx + 1) % cycle.length];
    setPermissionModes((prev) => new Map(prev).set(sessionId, next));
    // Send Shift+Tab to the PTY to cycle Claude Code's permission mode
    window.claude.session.sendInput(sessionId, '\x1b[Z');
  }, [sessionId, canBypass, currentPermissionMode, currentModel]);
  cyclePermissionRef.current = cyclePermission;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Shift+Tab inside a text editor means OUTDENT — this capture-phase
      // handler would otherwise steal it and cycle the session's permission
      // mode from inside the CodeMirror editor (spec §12.6).
      if (isTypingTarget(e.target as Element)) return;
      if (e.shiftKey && e.key === 'Tab') {
        e.preventDefault();
        cyclePermissionRef.current?.();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  const trustGateActive = useTrustGateActive(sessionId);

  // Once trust gate activates, permanently mark the session as initialized
  // so the "Initializing" overlay doesn't reappear after trust is completed
  // (there's a gap between trust completion and the first hook event).
  useEffect(() => {
    if (trustGateActive && sessionId) {
      setInitializedSessions((prev) => {
        if (prev.has(sessionId)) return prev;
        const next = new Set(prev);
        next.add(sessionId);
        (window as any).claude?.remote?.broadcastAction({ type: '_SESSION_INITIALIZED', sessionId });
        return next;
      });
    }
  }, [trustGateActive, sessionId]);

  const sessionInitialized = sessionId ? initializedSessions.has(sessionId) : true;
  // Plan 2b Moved Gate: when the active session was taken over by another device,
  // its info lives here and we render <MovedGate> over the content instead of the
  // (now-dead) chat/terminal view.
  const movedGate = sessionId ? movedSessions.get(sessionId) : undefined;

  // Show a "something may be wrong" hint after 15s of waiting on initialization.
  // Resets whenever the active session changes or the session becomes initialized.
  const [initSlowWarning, setInitSlowWarning] = useState(false);
  // The init warning's button is a one-way door: switching to terminal view also
  // hides the overlay that named the toggle. This coach mark is the way back.
  const [backToChatHint, setBackToChatHint] = useState(false);
  useEffect(() => {
    if (sessionInitialized) { setInitSlowWarning(false); return; }
    setInitSlowWarning(false);
    const t = setTimeout(() => setInitSlowWarning(true), 15000);
    return () => clearTimeout(t);
  }, [sessionId, sessionInitialized]);

  // Terminal mode on touch/remote platforms — show minimal input with special keys
  const isTerminalTouch = currentViewMode === 'terminal' && getPlatform() !== 'electron';

  // Chrome geometry observers (--bottom/top-chrome-* CSS vars + Android layout
  // report). Extracted to useChromeMeasurements in tranche 1 — logic unchanged.
  // Called here (before the early returns below) so hook order stays stable.
  useChromeMeasurements(headerRef, bottomBarRef, sessionId, currentViewMode);

  // Still loading first-run check
  if (isFirstRun === null) {
    // Change 24: bg-canvas, not a stock near-black. This paints before the app
    // chrome mounts, so on Light/Crème the old bg-gray-950 was a black flash.
    return <div className="flex-1 flex items-center justify-center bg-canvas" />;
  }

  // First-run mode — show setup UI instead of normal app
  if (isFirstRun) {
    return (
      <div className="h-screen flex flex-col bg-canvas">
        <FirstRunView onComplete={handleFirstRunComplete} />
      </div>
    );
  }

  // The active session's game pane. Hoisted so BOTH ChatView (chat view) and
  // TerminalRightSlot (terminal view) can place it — only one renders at a
  // time (ChatView gates on `visible`, the overlay only mounts in terminal
  // view), so this single element is never mounted twice. The live connection
  // lives in App's usePartyGame hook, so re-placing GamePanel on a view toggle
  // is a cheap view remount, not a reconnect.
  const activeGamePane = gameState.panelOpen ? (
    <ErrorBoundary name="Game">
      <GamePanel connection={gameConnection} chessConnection={chessConnection} incognito={lobby.incognito} onToggleIncognito={lobby.toggleIncognito} />
    </ErrorBoundary>
  ) : null;

  return (
    // ArtifactProvider: exposes artifact state + dispatch to the entire AppInner
    // subtree. Sits inside all top-level providers (ChatProvider, ThemeProvider,
    // etc.) because artifact operations may eventually consume chat/theme context.
    <ArtifactProvider value={{ state: artifactState, dispatch: dispatchArtifact }}>
    <div className={`app-shell flex w-screen h-full text-fg ${getPlatform() === 'android' && currentViewMode === 'terminal' ? '' : 'bg-canvas'}`}>
      {/* Mount-only: listens for chat:export-snapshot from main, serializes
          ChatState, and sends the snapshot back for remote-browser hydration. */}
      <RemoteSnapshotExporter />
      {/* Mount-only: announces channels the remote WS server doesn't bridge
          yet, so a remote browser gets "X isn't available via remote access
          yet" instead of a silently empty panel. No-op on desktop. */}
      <RemoteUnsupportedNotice />
      {/* Mount-only: app-wide right-click menu for chat content + the composer
          (copy/paste, Ask about this, file-pill actions). Opens only over
          surfaces it owns; leaves the terminal and other chrome untouched. */}
      <ContextMenuHost />
      {/* Main area — relative so bottom-float chrome can position against it.
          When a Phase-2 full-screen destination is active, hide the chat
          chrome entirely. Unmounting via `hidden` is cleaner than z-index
          games — chrome has backdrop-filter stacking contexts that trap
          sibling z-index values. */}
      <div
        className="flex-1 flex flex-col overflow-hidden relative"
        hidden={activeView === 'marketplace' || activeView === 'library'}
        // --right-pane-width drives BOTH the framed-shell drawer-pane width and
        // the chrome-glass cutout offset (both descend from here). BOTH right
        // panes are user-resizable and each remembers its OWN width — the games
        // pane via --game-pane-width (spec §4.3, was a fixed 400px) and the
        // artifact drawer via --drawer-width (youcoded#105), both set on <html>
        // by ThemeProvider. Two vars, not one, so dragging a game board wider
        // never moves the document drawer. Referencing the vars here (instead of
        // a px literal) means mid-drag App re-renders rewrite the SAME string and
        // can't snap the width back while the user is dragging.
        style={{ ['--right-pane-width' as any]: gameState.panelOpen ? 'var(--game-pane-width, 420px)' : 'var(--drawer-width, 480px)' }}
      >
        {sessions.length > 0 && sessionId && currentSession ? (
          <>
            {/* On Linux/Wayland a session pill dragged over the chat area can
                be dropped there — "open in a new window" for this window's
                own pill, "move here" for another window's. Inert everywhere
                else. A child of this positioned box so it covers the chat and
                not the header. See SessionDropZone for why the empty desktop
                is not a drop target there. */}
            <SessionDropZone sessions={sessions} />
            {/* Chrome-glass: single backdrop-filter layer for the entire
                frame chrome. Replaces the per-element backdrop-filters on
                HeaderBar, frame-edges, frame-divider, drawer-pane, and the
                rounded-corner pseudos. Subpixel boundaries between those
                elements at non-100% zoom levels caused either tiny gaps
                (sharp wallpaper bleed through) or tiny overlaps (darker
                tone from double translucent-panel + double backdrop-filter).
                A single chrome-glass element clipped to the donut shape via
                clip-path: polygon() has only ONE backdrop-filter sampling the
                wallpaper directly, so the whole chrome reads as one
                continuous tone. */}
            <div className={`chrome-glass${(activeDrawerOpen || gameState.panelOpen) ? ' chrome-glass--drawer-open' : ''}`} />
            <div ref={headerRef} className="chrome-wrapper bg-canvas">
              <HeaderBar
                sessions={sessions}
                activeSessionId={sessionId}
                onSelectSession={(id: string) => {
                  // Switching sessions REMOUNTS the artifact drawer, which
                  // would silently discard a dirty editor draft — route the
                  // user-initiated switch through the D3 guard. Programmatic
                  // switches (session died/closed) stay unguarded on purpose.
                  guardDirtyEditor(() => {
                    setSessionId(id);
                    // Notify Android/remote bridge so the native terminal view switches too
                    (window as any).claude?.session?.switch?.(id);
                  });
                }}
                onCreateSession={createSession}
                onCloseSession={(id, name) => {
                  // Skip prompt if the user has checked "Don't show again".
                  // In that case destroy immediately without any flags — the
                  // user can still tag sessions from the resume menu later.
                  // WHY: session:destroy is a global main-process command keyed
                  // only by session id — it works the same for a peer window's
                  // session as it does for a local one, no ownership check.
                  if (localStorage.getItem(CLOSE_PROMPT_SUPPRESS_KEY) === '1') {
                    try { window.claude.session.destroy(id); } catch {}
                  } else {
                    setClosePromptName(name);
                    setClosePromptFor(id);
                  }
                }}
                onReorderSessions={(fromIndex: number, toIndex: number) => {
                  setSessions(prev => {
                    const next = [...prev];
                    const [moved] = next.splice(fromIndex, 1);
                    next.splice(toIndex, 0, moved);
                    return next;
                  });
                }}
                viewMode={currentViewMode}
                onToggleView={handleToggleView}
                gamePanelOpen={gameState.panelOpen}
                onToggleGamePanel={() => gameDispatch({ type: 'TOGGLE_PANEL' })}
                gameConnected={gameState.connected}
                challengePending={gameState.challengeFrom !== null}
                settingsOpen={settingsOpen}
                onToggleSettings={() => setSettingsOpen(prev => !prev)}
                settingsBadge={settingsBadge}
                settingsDangerBadge={settingsDangerBadge}
                sessionStatuses={sessionStatuses}
                onOpenResumeBrowser={() => setResumeRequested(true)}
                defaultModel={sessionDefaults.model}
                defaultStartModel={sessionDefaults.startModel}
                defaultSkipPermissions={sessionDefaults.skipPermissions}
                defaultProjectFolder={sessionDefaults.projectFolder}
                windowDirectory={windowDirectory}
                myWindowId={myWindowId}
              />
            </div>
            <div
              // app-content: the chat/terminal content region. In framed
              // terminal view the bottom frame strip comes from chrome-glass's
              // donut (--bottom-chrome-height) + the xterm grid lifted by
              // --terminal-bottom-inset on TerminalView's container (NOT an
              // .app-content margin — absolute children anchor to the padding
              // box, so a margin here can't move them; see globals.css).
              className="app-content flex-1 overflow-hidden relative"
            >
              {/* Tier 2 of android-terminal-data-parity: xterm.js is the sole
                  terminal renderer on every platform. The Android-only style
                  (backgroundColor transparent + pointerEvents none) and the
                  `getPlatform() !== 'android'` gate around <TerminalView /> are
                  gone — they existed so touches/visibility passed through the
                  WebView to the native Termux TerminalView underneath. xterm
                  now lives in the WebView, so the WebView itself is the
                  terminal surface. The native Compose TerminalView is still
                  rendering during this intermediate task; xterm's opaque
                  background covers it. Task 5 deletes the native renderer. */}
              {sessions.map((s) => (
                <React.Fragment key={s.id}>
                  <ErrorBoundary name="Chat">
                    <ChatView
                      sessionId={s.id}
                      // currentViewMode, not the raw map: a shell session FORCES
                      // the terminal, and reading the map here would show the
                      // chat pane for a session whose map entry was never seeded.
                      visible={s.id === sessionId && currentViewMode === 'chat'}
                      // Drives content-visibility so INACTIVE sessions leave the
                      // layout tree entirely — see ChatView's root style block.
                      // Deliberately not folded into `visible`: the two hide
                      // different things for different reasons.
                      sessionActive={s.id === sessionId}
                      provider={s.provider}
                      cwd={s.cwd}
                      // Game pane lives in the active session's framed-shell
                      // right slot. Only the active session renders it (others
                      // get null) so there's a single GamePanel instance.
                      // ChatView only actually mounts it in chat view; in
                      // terminal view TerminalRightSlot (below) places it.
                      gamePane={s.id === sessionId ? activeGamePane : null}
                      // Provider-config error bubble → open Settings straight to
                      // the Model Providers section so the key can be fixed.
                      onOpenProviderSettings={() => { setProvidersAutoOpen(true); setSettingsOpen(true); }}
                      // Plan-limit card (review round 2, P-9): Switch Providers
                      // opens the same picker the status-bar chip opens.
                      onSwitchProviders={() => setModelPickerOpen(true)}
                      onCancelQueued={handleCancelQueued}
                      onEditQueued={handleEditQueued}
                    />
                  </ErrorBoundary>
                  <ErrorBoundary name="Terminal">
                    <TerminalView
                      sessionId={s.id}
                      visible={s.id === sessionId && currentViewMode === 'terminal'}
                    />
                  </ErrorBoundary>
                </React.Fragment>
              ))}
              {/* Terminal-view right-slot panel (Bug #2): the artifact drawer +
                 game pane live in ChatView's framed-shell, which is hidden in
                 terminal view — so opening one there expanded the frame but
                 showed nothing. Render a single framed-shell clone here, only
                 in terminal view, so the same panel overlays the terminal's
                 right side. ChatView gates its own copy on `visible`, so
                 exactly one instance mounts. Electron-only for now (Android's
                 terminal overlay sizing is native — separate follow-up). */}
              {getPlatform() === 'electron' && currentViewMode === 'terminal' && sessionId
                && (activeDrawerOpen || gameState.panelOpen) && (
                <TerminalRightSlot
                  sessionId={sessionId}
                  cwd={currentSession?.cwd}
                  gamePane={gameState.panelOpen ? activeGamePane : null}
                  drawerOpen={activeDrawerOpen}
                  expanded={artifactState.drawerExpanded}
                />
              )}
              {/* Initializing overlay — shown before Claude is ready, but only in chat view.
                 Terminal view must stay accessible during init so the user can interact there.
                 z-10: must stay below glassmorphism chrome (z-20) so header/bottom bars remain accessible */}
              {!sessionInitialized && sessionId && currentViewMode !== 'terminal' && !movedGate && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-canvas">
                  <ThemeMascot small={false} variant="idle" fallback={AppIcon} className="w-16 h-16 text-fg-dim mb-6 animate-pulse" />
                  <p className="text-sm text-fg-dim font-medium">Initializing session...</p>
                  {initSlowWarning && (
                    <div className="mt-4 text-xs text-fg-muted text-center max-w-xs flex flex-col items-center gap-2">
                      <p>Something may be wrong. The terminal may show what it is waiting on.</p>
                      {/* Fix: the old copy told the user to go find the chat/terminal toggle
                         themselves. This does it in one tap — and because the overlay is
                         hidden in terminal view, switching also clears it. */}
                      <Button variant="secondary" size="sm" onClick={() => { setBackToChatHint(true); handleToggleView('terminal'); }}>
                        Check terminal view
                      </Button>
                    </div>
                  )}
                </div>
              )}
              {backToChatHint && currentViewMode === 'terminal' && (
                <ViewToggleHint onDismiss={() => setBackToChatHint(false)} />
              )}
              {trustGateActive && sessionId && <TrustGate sessionId={sessionId} />}
              {/* Plan 2b Moved Gate — covers the content area for a taken-over
                 session (the ChatView/TerminalView below are dead). z-10 like
                 TrustGate so the header strip stays reachable to switch away. */}
              {movedGate && sessionId && (
                <MovedGate
                  device={movedGate.device}
                  // Resume from a remote browser would run on the HOST, not here —
                  // hide it there to avoid the semantic oddity; local desktop always shows it.
                  canResume={!isRemoteMode()}
                  onExit={() => removeSessionLocally(sessionId)}
                  onResume={() => {
                    // Capture resume params BEFORE removeSessionLocally clears the entry.
                    const info = movedSessionsRef.current.get(sessionId);
                    // Drop the dead pill first so resume creates a fresh one (no duplicate).
                    removeSessionLocally(sessionId);
                    if (info?.claudeSessionId && info.projectSlug && info.projectPath) {
                      // Thread the provider so a native moved session lands in the
                      // pre-resume model picker (Task 6's pendingNativeResume path)
                      // instead of auto-launching — handleResumeSession's native
                      // branch opens the modal when called without a binding.
                      void handleResumeSession(info.claudeSessionId, info.projectSlug, info.projectPath, undefined, undefined, undefined, info.provider);
                    } else {
                      // Main couldn't resolve the resume params (no cwd) — fall back
                      // to the Resume Browser so the user isn't stranded.
                      setResumeRequested(true);
                    }
                  }}
                />
              )}
              {currentViewMode === 'chat' && (
                <CommandDrawer
                  open={drawerOpen}
                  searchMode={drawerSearchMode}
                  externalFilter={drawerFilter}
                  onSelect={handleSelectSkill}
                  onSelectCommand={handleSelectCommand}
                  onClose={handleCloseDrawer}
                  onOpenManager={() => openMarketplace('installed')}
                  onOpenMarketplace={() => openMarketplace()}
                  onOpenLibrary={() => setActiveView('library')}
                  onOpenMarketplaceDetail={openMarketplaceDetail}
                />
              )}
              {isTerminalTouch && sessionId && (
                <TerminalScrollButtons sessionId={sessionId} />
              )}
            </div>
            {/* Always mounted so draft text survives chat↔terminal switches.
               inert disables focus/keyboard/paste when hidden so keystrokes
               reach xterm instead of the buried textarea. */}
              <div ref={bottomBarRef} className={`chrome-wrapper chrome-wrapper--bottom bg-canvas${currentViewMode === 'chat' ? ' bottom-float' : ''}`} {...(currentViewMode !== 'chat' && getPlatform() === 'electron' ? { inert: true, style: { position: 'absolute', width: 0, height: 0, overflow: 'hidden' } as React.CSSProperties } : {})}>
                {/* A shell session draws NONE of the bottom chrome: no composer
                    (there is nothing to send a message to), and so no Stop
                    button, no model chip and no way into the model picker — all
                    three live inside these two children. The wrapper itself stays
                    mounted because useChromeMeasurements measures it.
                    TerminalToolbar (Esc/Tab/Ctrl/arrows) now renders inside
                    ChatInputBar when minimal={isTerminalTouch}, slotted in
                    the QuickChips position so both modes share one container. */}
                {!isShellSession && (<>
                <ChatInputBar ref={inputBarRef} sessionId={sessionId} view={currentViewMode} onOpenDrawer={handleOpenDrawer} onCloseDrawer={handleCloseDrawer} onDrawerSearch={setDrawerFilter} disabled={trustGateActive || !!movedGate || !sessionInitialized} minimal={isTerminalTouch} onResumeCommand={() => setResumeRequested(true)} getUsageSnapshot={getUsageSnapshot} onOpenPreferences={() => setPreferencesOpen(true)} onToast={(msg) => setToast(msg)} onSendBlocked={(retry) => setToast({ message: 'Claude is waiting for your response — answer the prompt first.', durationMs: 8000, action: { label: 'Send anyway', onClick: () => { setToast(null); retry(); } } })} getSessionState={(sid) => chatStateMapRef.current.get(sid)} onOpenModelPicker={() => setModelPickerOpen(true)} initialInput={currentSession?.initialInput} provider={currentSession?.provider} />
                <StatusBar
                  statusData={{
                    usage: onChatGptPlan ? statusData.chatgptUsage : statusData.usage,
                    updateStatus: statusData.updateStatus,
                    announcement: statusData.announcement,
                    contextPercent: sessionId ? (statusData.contextMap[sessionId] ?? null) : null,
                    gitBranch: sessionId ? (statusData.gitBranchMap[sessionId] ?? null) : null,
                    sessionStats: sessionId ? (statusData.sessionStatsMap[sessionId] ?? null) : null,
                    syncWarnings: statusData.syncWarnings,
                  }}
                  onOpenSync={() => {
                    // Open settings panel with sync popup auto-opened
                    setSyncAutoOpen(true);
                    setSettingsOpen(true);
                  }}
                  onRunSync={!trustGateActive && sessionId && !isNativeSession ? () => {
                    // Send first, guarded — a refused send must not leave a
                    // stale pending "/sync" bubble in the timeline. Hide /sync for
                    // native sessions — they have no PTY send capability.
                    if (!guardedPtySend(sessionId, '/sync\r')) return;
                    dispatch({ type: 'USER_PROMPT', sessionId, content: '/sync', timestamp: Date.now() });
                  } : undefined}
                  model={modelChip}
                  modelProviderType={activeProviderType}
                  usagePlan={onChatGptPlan ? 'chatgpt' : 'claude'}
                  provider={isNativeSession ? 'native' : 'claude'}
                  permissionMode={isNativeSession ? currentNativeMode : currentPermissionMode}
                  onCyclePermission={isNativeSession ? cycleNativePermission : cyclePermission}
                  fast={fastMode}
                  effort={effortLevel}
                  onOpenModelPicker={() => setModelPickerOpen(true)}
                  sessionId={sessionId}
                  onDispatch={(input: string) => {
                    if (!sessionId) return;
                    // Pass live timeline (drawer paths pass []) so future popup-dispatched commands
                    // that inspect history can read it without rewiring this wrapper.
                    const timeline = chatStateMapRef.current.get(sessionId)?.timeline ?? [];
                    const result = dispatchSlashCommand({
                      raw: input,
                      sessionId,
                      view: currentViewMode,
                      files: [],
                      dispatch,
                      timeline,
                      callbacks: {
                        onResumeCommand: () => setResumeRequested(true),
                        getUsageSnapshot,
                        onOpenPreferences: () => setPreferencesOpen(true),
                        onToast: (msg: string) => setToast(msg),
                        getSessionState: (sid: string) => chatStateMapRef.current.get(sid),
                        onOpenModelPicker: () => setModelPickerOpen(true),
                      },
                      deferUiEffectsToRuntime: currentSession?.provider === 'native',
                    });
                    // Forward alsoSendToPty so Claude Code itself runs the command. We deliberately skip the
                    // USER_PROMPT optimistic bubble that InputBar dispatches — for /compact and /clear, the
                    // COMPACTION_PENDING / CLEAR_TIMELINE reducer actions already update the timeline, so a
                    // USER_PROMPT bubble would render redundantly alongside them.
                    runSlashResult(sessionId, result);
                  }}
                  openTasksCounts={sessionId ? { running: openTasks.counts.running, pending: openTasks.counts.pending } : undefined}
                  onOpenOpenTasks={() => setOpenTasksPopupOpen(true)}
                  nativeUsage={nativeStatusUsage}
                  nativeContextLength={nativeStatusUsage?.contextLength ?? null}
                  turnsWithUsage={turnsWithUsage}
                  nativeTotals={sessionTotals}
                />
                </>)}
              </div>
          </>
        ) : (
          <>
            {/* Welcome screen gets the app's bare frame (P-6, Destin
                2026-08-27: "a full frame around the welcome screen, as exists
                in terminal view ... just bare frame like terminal view").
                Same chrome-glass + chrome-wrapper + headerRef as the session
                branch so a wallpaper theme paints this header exactly the way
                it paints the session header, and useChromeMeasurements (keyed
                on the same headerRef) publishes --top-chrome-height for the
                glass cutout. `chrome-glass--bare` gives the donut a thin
                --frame-edge bottom strip, like terminal view, instead of the
                5rem fallback reserved for an input bar that isn't here — as
                wide as the header, so the frame closes evenly top and bottom. */}
            <div className="chrome-glass chrome-glass--bare" />
            <div ref={headerRef} className="chrome-wrapper bg-canvas">
              <BareHeaderBar
                settingsOpen={settingsOpen}
                onToggleSettings={() => setSettingsOpen(prev => !prev)}
                settingsBadge={settingsBadge}
                settingsDangerBadge={settingsDangerBadge}
              />
            </div>
          <div
            className="flex-1 flex flex-col items-center justify-center gap-3"
            // The header is position:absolute over the top of this area, so
            // center the welcome content in the space BELOW it (and above the
            // bare frame's bottom strip) rather than behind it. --top-chrome-
            // bottom, not -height, so a floating header pill's own margin is
            // cleared too — same reason ChatView's empty-state hint uses it.
            // paddingBottom matches the bottom strip, which is now the header's
            // own height (globals.css .chrome-glass--bare), so the content
            // still centres in the open middle instead of drifting downward.
            style={{ paddingTop: 'var(--top-chrome-bottom, 2.5rem)', paddingBottom: 'var(--top-chrome-height, 2.5rem)' }}
          >
            <p className="text-xl text-fg-muted">No Active Session</p>
            {/* scene: the hero surface renders the theme's companions (sun,
                motes, sparkles) orbiting the mascot — big canvas, no clipping. */}
            <ThemeMascot small={false} variant="welcome" fallback={WelcomeAppIcon} className="w-36 h-36 text-fg-dim" scene />
            {/* Welcome screen: New Session (expandable) + Resume Session */}
            <div className="flex flex-col items-center gap-2 mt-1 w-64">
              {welcomeFormOpen ? (
                /* Expanded new-session form with toggles */
                <div className="layer-surface w-full p-3 flex flex-col gap-2">
                  <div>
                    <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-1 block">Project Folder</label>
                    {/* Match SessionStrip: the picker's "Manage projects…"
                        footer opens Project View (where adding lives). */}
                    <FolderSwitcher
                      value={welcomeCwd}
                      onChange={setWelcomeCwd}
                      onManageProjects={() => dispatchArtifact({ type: 'PROJECT_VIEW_OPENED' })}
                    />
                  </div>
                  {/* ONE model list — the third and last form to drop the
                      Runtime toggle + provider/model <Select> pair + its own
                      Claude alias row (SessionStrip and the Resume Browser were
                      converted first). Runtime is DERIVED from the pick, so the
                      user answers "which model?" instead of decoding "Runtime"
                      first. */}
                  <div>
                    <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-1 block">Model</label>
                    <ModelPicker
                      value={welcomeModelChoice}
                      onSelect={applyWelcomeModelChoice}
                      onManageModels={() => { setProvidersAutoOpen(true); setSettingsOpen(true); }}
                    />
                  </div>
                  {/* Native-only extras that are NOT model selection (harness
                      preset, local-engine memory-fit warning). They appear
                      because a native model was picked, not because a runtime
                      was declared. */}
                  {welcomeRuntime === 'native' && welcomeNb.nativeSupported && (
                    <NativeExtras nb={welcomeNb} preset={welcomePreset} onPreset={setWelcomePreset} />
                  )}
                  {/* Skip Permissions is CLAUDE-CODE ONLY — it bypasses the CLI's
                      permission flow, and a native session has neither a PTY nor
                      that flow, so on a native runtime the control did nothing.
                      Same gate as SessionStrip's create form and the Resume
                      Browser's per-row one. */}
                  {welcomeRuntime !== 'native' && (
                    <>
                      <div className="flex items-center justify-between">
                        <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Skip Permissions</label>
                        {/* Was a hand-rolled 32x18 track with a raw #DD4444 on-state; now
                            the shared Toggle on the danger tone, so theme packs can restyle
                            it (changes 15/17). The <label> beside it isn't bound to this
                            control, so it carries its own aria-label. */}
                        <Toggle
                          checked={welcomeDangerous}
                          onChange={setWelcomeDangerous}
                          tone="danger"
                          aria-label="Skip Permissions"
                        />
                      </div>
                      {/* Warning text was a raw text-[#DD4444] hex — the THIRD copy of
                          this same string (ResumeBrowser and SessionStrip have the
                          others). Change 17 puts it on the destructive token so it
                          tracks the toggle above it under a community theme. */}
                      {welcomeDangerous && (
                        <p className="text-3xs text-destructive-fg">Claude will execute tools without asking for approval.</p>
                      )}
                    </>
                  )}
                  <div className="flex gap-2">
                    {/* secondary, not ghost: this was the filled-grey family
                        (bg-inset text-fg-dim hover:bg-edge) that decision 60 collapses
                        into the outline, and it sits beside Create as a peer choice —
                        the exact case decision 60 gives for rejecting ghost. */}
                    <Button
                      variant="secondary"
                      size="lg"
                      onClick={() => setWelcomeFormOpen(false)}
                    >
                      Cancel
                    </Button>
                    {/* Third skip-permissions Create button — spec decision 62 cited only
                        SessionStrip and ResumeBrowser plus App.tsx's toggle, and missed this
                        one on the welcome form. Same call: FILLED danger, deliberately
                        identical to "Remove project". See the note in SessionStrip. */}
                    <Button
                      onClick={() => {
                        // Native runtime carries a provider/model binding; persist
                        // the choice so it sticks. The disabled guard already blocks
                        // a missing binding, but bail defensively.
                        if (welcomeRuntime === 'native') {
                          if (!welcomeNb.effectiveBinding) return;
                          persistLastBinding(welcomeNb.effectiveBinding);
                        }
                        createSession(
                          welcomeCwd,
                          // Hidden for native (see the gate above), so a value left
                          // over from an earlier Claude pick must not ride along.
                          welcomeRuntime === 'native' ? false : welcomeDangerous,
                          welcomeModel,
                          welcomeRuntime,
                          undefined, // welcome form has no launch-in-new-window toggle
                          welcomeRuntime === 'native' ? (welcomeNb.effectiveBinding ?? undefined) : undefined,
                          welcomeRuntime === 'native' ? welcomePreset : undefined,
                        );
                        setWelcomeFormOpen(false);
                        // Reset to the remembered default, NOT the literal 'claude' --
                        // otherwise a ChatGPT-only install's default would last one
                        // session (review R2-3). The saved default then goes back on
                        // top, or it too would survive exactly one conversation.
                        setWelcomeRuntime(defaultRuntime());
                        if (sessionDefaults.startModel) applyWelcomeModelChoice(sessionDefaults.startModel);
                      }}
                      disabled={welcomeNb.nativeCreateBlocked}
                      variant={welcomeDangerous && welcomeRuntime !== 'native' ? 'danger' : 'primary'}
                      size="lg"
                      className="flex-1 py-1.5"
                    >
                      {welcomeDangerous && welcomeRuntime !== 'native' ? 'Create (Dangerous)' : 'Create Session'}
                    </Button>
                  </div>
                </div>
              ) : (
                /* Collapsed state: two side-by-side buttons */
                <>
                  {/* `panel-glass` and `text-base` are deliberate className
                      overrides, NOT leftovers (spec §11.3 decision 69):
                      panel-glass re-tiers translucency from bubble→panel on
                      wallpaper themes (globals.css:843-856), and text-base is
                      larger than any Button size. buttonClasses() merges both
                      correctly — it drops the conflicting base tokens. */}
                  <Button
                    variant="primary"
                    size="lg"
                    className="panel-glass w-full px-8 text-base"
                    onClick={() => {
                      setWelcomeCwd(sessionDefaults.projectFolder || '');
                      setWelcomeDangerous(sessionDefaults.skipPermissions || false);
                      setWelcomeModel(sessionDefaults.model || 'sonnet');
                      // The saved default, whatever provider it names. Routed
                      // through the picker's own setter so a ChatGPT or local
                      // default moves the engine with it — setWelcomeModel alone
                      // only ever moved the Claude alias, which is why this form
                      // fell back to the last-used memory instead (contract R5).
                      if (sessionDefaults.startModel) applyWelcomeModelChoice(sessionDefaults.startModel);
                      // usePreset re-arms the heuristic itself on the welcomeFormOpen
                      // false→true edge — no manual touched reset needed here.
                      setWelcomeFormOpen(true);
                    }}
                  >
                    New Session
                  </Button>
                  {/* Same decision-69 rationale as above: panel-glass is preserved
                      as a className override so wallpaper themes still re-tier it. */}
                  <Button
                    variant="secondary"
                    size="lg"
                    className="panel-glass w-full px-6"
                    onClick={() => setResumeRequested(true)}
                  >
                    <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span className="text-sm font-medium">Resume Session</span>
                  </Button>
                </>
              )}
            </div>
          </div>
          </>
        )}
      </div>

      {/* The game panel now renders inside the active session's framed-shell
          right slot (passed as ChatView's gamePane prop above), so it shares the
          artifact drawer's framed chrome instead of being a separate slide-out. */}
      <SettingsPanel
        open={settingsOpen}
        onClose={() => { setSettingsOpen(false); setSyncAutoOpen(false); setProvidersAutoOpen(false); }}
        onSendInput={(text) => {
          // Guarded: with a permission/question pending, the text would land on
          // CC's live Ink menu and the trailing \r would answer it.
          if (sessionId) guardedPtySend(sessionId, text + '\r');
        }}
        // Slash commands from settings (currently only "Build New Theme with
        // Claude") route through the dispatcher instead of raw PTY text. In a
        // native session onSendInput reached guardedPtySend, which refuses and
        // whose return value was discarded — so that button did NOTHING at all
        // (handoff §2.3). Per Q5 this runs in the CURRENT session.
        onRunCommand={(command) => {
          if (!sessionId) { setToast('Open a conversation first, then try again.'); return; }
          const result = dispatchSlashCommand({
            raw: command,
            sessionId,
            view: viewModes.get(sessionId) || 'chat',
            files: [],
            dispatch,
            timeline: [],
            callbacks: { onResumeCommand: () => setResumeRequested(true), getUsageSnapshot, onOpenPreferences: () => setPreferencesOpen(true), onToast: (msg: string) => setToast(msg), getSessionState: (sid: string) => chatStateMapRef.current.get(sid), onOpenModelPicker: () => setModelPickerOpen(true) },
            deferUiEffectsToRuntime: sessionsRef.current.find((x) => x.id === sessionId)?.provider === 'native',
          });
          if (runSlashResult(sessionId, result)) return;
          // Claude Code fallback: not a dispatcher command, so hand the raw text
          // to the PTY the way this button always did.
          if (!guardedPtySend(sessionId, `${command} \r`)) {
            setToast(`${command} isn't available in YouCoded-runtime sessions yet.`);
          }
        }}
        hasActiveSession={!!sessionId}
        // Task 10: Settings → Specialists needs the active session's cwd to
        // show that project's OWN .claude/agents specialists, not just the
        // two global sources — sourced from the same artifactState this
        // ArtifactProvider tree already holds (SpecialistEnvelope reads the
        // same field for the same reason).
        activeSessionCwd={sessionId ? artifactState.sessionCwd[sessionId] : undefined}
        onOpenThemeMarketplace={() => { setSettingsOpen(false); openMarketplace('themes'); }}
        onPublishTheme={(slug) => { setSettingsOpen(false); setPublishThemeSlug(slug); }}
        // Model Providers popup → Claude Code section → opens the /config prefs popup.
        onOpenClaudePreferences={() => { setSettingsOpen(false); setPreferencesOpen(true); }}
        syncAutoOpen={syncAutoOpen}
        onSyncAutoOpenHandled={() => setSyncAutoOpen(false)}
        providersAutoOpen={providersAutoOpen}
        onProvidersAutoOpenHandled={() => setProvidersAutoOpen(false)}
      />
      <ResumeBrowser
        open={resumeRequested}
        onClose={() => setResumeRequested(false)}
        onResume={handleResumeSession}
        defaultModel={sessionDefaults.model}
        defaultSkipPermissions={sessionDefaults.skipPermissions}
      />
      <CloseSessionPrompt
        open={closePromptFor !== null}
        sessionName={closePromptName ?? sessions.find((s) => s.id === closePromptFor)?.name}
        sessionId={closePromptFor}
        onCancel={() => { setClosePromptFor(null); setClosePromptName(undefined); }}
        onConfirm={(result) => {
          const id = closePromptFor;
          if (!id) return;
          // Every field is a DELTA vs. what the prompt loaded on open — reserved
          // flags whose value moved, tags toggled on/off, the note if it changed.
          // Each write is fire-and-forget; main resolves the desktop id to the
          // Claude id. The .catch() swallows an IPC rejection (remote timeout) so
          // it can't become an unhandled rejection.
          //
          // `flags` carries a VALUE per entry, not just a list to set true — a
          // Priority the user un-toggled has to be cleared, the same way an
          // un-toggled tag is (see CloseSessionPrompt's onConfirm doc comment).
          for (const [flag, value] of Object.entries(result.flags)) {
            try { Promise.resolve((window as any).claude.session.setFlag(id, flag, value)).catch(() => {}); } catch {}
          }
          for (const tagId of result.addTagIds) {
            try { Promise.resolve((window as any).claude.session.setTag(id, tagId, true)).catch(() => {}); } catch {}
          }
          for (const tagId of result.removeTagIds) {
            try { Promise.resolve((window as any).claude.session.setTag(id, tagId, false)).catch(() => {}); } catch {}
          }
          if (result.noteChanged) { try { Promise.resolve((window as any).claude.session.setNote(id, result.note)).catch(() => {}); } catch {} }
          try { window.claude.session.destroy(id); } catch {}
          setClosePromptFor(null);
          setClosePromptName(undefined);
        }}
      />
      <PreferencesPopup
        open={preferencesOpen}
        onClose={() => setPreferencesOpen(false)}
        // Advanced → switch to terminal view and forward /config to Claude Code's
        // native TUI. The user sees the full config menu rendered in xterm.
        onOpenAdvanced={() => {
          if (!sessionId) return;
          setViewModes((prev) => new Map(prev).set(sessionId, 'terminal'));
          // Small delay so the view switch happens before input lands.
          // pty-worker will auto-split "/config\r" into "/config" + 600ms + "\r"
          // to avoid Ink's paste timer swallowing Enter. Guarded: with a prompt
          // pending, "/config\r" would answer CC's live Ink menu instead.
          setTimeout(() => guardedPtySend(sessionId, '/config\r'), 50);
        }}
        // "Advanced" opens Claude Code's own /config screen by typing into the
        // PTY. A native session has no PTY; a shell session has one, but it is
        // the user's shell — /config there is just a wrong command typed at
        // their prompt. Both hide the button.
        showAdvanced={currentSession?.provider !== 'native' && currentSession?.provider !== 'shell'}
      />
      <ModelPickerPopup
        // A shell session has no model, so it must never open the picker — the
        // popup would offer Claude Code aliases whose only effect would be
        // typing "/model sonnet" at the user's shell prompt. Its two entry
        // points (the composer and the status bar) are already gone for a shell
        // session; this closes the third — a /model typed into a command list
        // while Settings is open.
        open={modelPickerOpen && !isShellSession}
        onClose={() => setModelPickerOpen(false)}
        sessionId={sessionId}
        // The popup only knows real ModelAlias values (highlights the active
        // row) — 'unknown' has no row to highlight, so pass null, same as
        // "no session yet".
        currentModel={currentModel === 'unknown' ? null : currentModel}
        onSelectModel={(m) => {
          if (!sessionId) return;
          // Send first, guarded (pending-prompt gate) — refusing before the
          // optimistic state writes keeps the model pill truthful when the
          // command never reached CC. Mirrors cycleModel.
          if (!guardedPtySend(sessionId, `/model ${m}\r`)) return;
          setSessionModels((prev) => new Map(prev).set(sessionId, m));
          setPendingModel(m);
          postSwitchTurnReady.current = false;
          (window.claude as any).model?.setPreference(m);
        }}
        // /fast and /effort are PTY writes just like /model — route them
        // through the same pending-prompt gate so they can't answer a live Ink
        // menu (stray-Enter fix, youcoded#110). Returns false when refused so
        // the popup skips its optimistic state writes.
        sendPtyCommand={(text) => (sessionId ? guardedPtySend(sessionId, text) : false)}
        provider={currentSession?.provider}
        // Native model picker — the live bound modelId + a refresh callback so
        // the header reflects a mid-session swap (SessionInfo.model is the pill's
        // source; setBinding is in-memory, so we must update it here).
        currentModelId={currentSession?.provider === 'native' ? currentSession?.model : undefined}
        onNativeModelChanged={(modelId) => {
          if (!sessionId) return;
          setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, model: modelId } : s)));
        }}
      />
      {/* Open Tasks popup — rendered at App root so it escapes any inner stacking context.
          Reads from the single `openTasks` useSessionTasks instance declared in AppInner. */}
      {sessionId && (
        <OpenTasksPopup
          open={openTasksPopupOpen}
          tasks={openTasks.tasks}
          onClose={() => setOpenTasksPopupOpen(false)}
          onMarkInactive={openTasks.markInactive}
          onUnhide={openTasks.unhide}
        />
      )}
      {/* Full-screen glass marketplace + library destinations. MarketplaceProvider
          is now app-wide (root provider tree) so ThemeScreen can also consume it.
          (The "Browse all themes" button that used to deep-link the Library's
          Themes tab was removed in Phase C, 2026-08-27, so no initialTab is passed.) */}
      {(activeView === 'marketplace' || activeView === 'library') && (
        activeView === 'marketplace' ? (
          <MarketplaceScreen
            onExit={() => { setActiveView('chat'); setMarketplaceInitialType(undefined); setMarketplaceInitialDetailId(undefined); }}
            onOpenLibrary={() => { setActiveView('library'); setMarketplaceInitialType(undefined); setMarketplaceInitialDetailId(undefined); }}
            onOpenShareSheet={(id) => setShareSkillId(id)}
            onOpenThemeShare={(slug) => setPublishThemeSlug(slug)}
            initialTypeChip={marketplaceInitialType}
            initialDetailId={marketplaceInitialDetailId}
            onDetailConsumed={clearMarketplaceInitialDetail}
          />
        ) : (
          <LibraryScreen
            onExit={() => setActiveView('chat')}
            onOpenMarketplace={() => setActiveView('marketplace')}
            onOpenShareSheet={(id) => setShareSkillId(id)}
            onOpenThemeShare={(slug) => setPublishThemeSlug(slug)}
          />
        )
      )}
      {publishThemeSlug && (
        <ThemeShareSheet themeSlug={publishThemeSlug} onClose={() => setPublishThemeSlug(null)} />
      )}
      {editorSkillId && (
        <SkillEditor skillId={editorSkillId} onClose={() => setEditorSkillId(null)} />
      )}
      {shareSkillId && (
        <ShareSheet skillId={shareSkillId} onClose={() => setShareSkillId(null)} />
      )}
      {/* Change 44: the hand-rolled strip (its own bg-panel/border-edge/shadow-lg
          AND its own z-50, outside Overlay.tsx's authority) is now the shared
          <Toast>. The primitive owns auto-dismiss, which is why 14 setTimeout
          calls came out of this file — every one of them was a chance to leak a
          timer past unmount. */}
      {toast && (
        <Toast
          message={typeof toast === 'string' ? toast : toast.message}
          durationMs={typeof toast === 'string' ? undefined : toast.durationMs}
          onDismiss={() => setToast(null)}
          action={
            typeof toast !== 'string' && toast.action ? (
              <Button variant="secondary" size="sm" onClick={toast.action.onClick}>
                {toast.action.label}
              </Button>
            ) : undefined
          }
        />
      )}
      {/* Plan 2b Task 9 — conversation-lease takeover dialog (3-state redesign,
          Destin sign-off 2026-07-23). L2 popup via the shared Scrim/OverlayPanel
          primitives (theme-driven scrim/blur/shadow; PITFALLS → Overlays). Plain
          words, no status glyphs. 'confirm' asks to take a live session over;
          'force' asks after a DELIVERED request went unanswered; 'undeliverable'
          is the honest state where the hub never reached the holder at all — see
          takeover-dialog-copy.ts for why these are worded differently (never
          blame a device for "not responding" to a request it never received). */}
      {takeoverPrompt && (() => {
        const copy = takeoverDialogCopy(takeoverPrompt.phase, takeoverPrompt.device);
        // Bold just the device name within `lead` for the two richer phases —
        // the copy module returns plain interpolated strings (no JSX
        // dependency, so its output stays pinnable); splitting here is the only
        // place that needs to know about the `font-medium` span.
        const boldDevice = (text: string) => {
          const idx = text.indexOf(takeoverPrompt.device);
          if (idx === -1) return text;
          return (
            <>
              {text.slice(0, idx)}
              <span className="font-medium">{takeoverPrompt.device}</span>
              {text.slice(idx + takeoverPrompt.device.length)}
            </>
          );
        };
        const infoTip = (
          <AnchorTip label="How taking over works" title="Taking over a conversation" className="ml-1 -mb-px align-middle">
            <p>A conversation runs on one device at a time.</p>
            <p>Taking over asks the current device to stop, save everything, and hand off — nothing is lost.</p>
            <p>Taking over <em>without</em> a confirmed handoff doesn&apos;t wait. When the other device reconnects, it stops and saves on its own — but anything it wrote in the meantime is kept as a separate copy, not added to this conversation.</p>
          </AnchorTip>
        );
        return (
          <>
            <Dialog
              open
              onClose={() => resolveTakeover(false)}
              size="panel"
              aria-label="Take over conversation"
              scrollBody={false}
              className="p-5"
            >
              {takeoverPrompt.phase === 'confirm' ? (
                <p className="text-sm text-fg mb-4">
                  {copy.lead}
                  {infoTip}
                </p>
              ) : (
                <>
                  <p className="text-sm text-fg mb-2">
                    {boldDevice(copy.lead)}
                    {infoTip}
                  </p>
                  <p className="text-xs text-fg-2 mb-4">{copy.consequence}</p>
                </>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  variant="secondary"
                  size="lg"
                  onClick={() => resolveTakeover(false)}
                >
                  Never mind
                </Button>
                <Button
                  variant="primary"
                  size="lg"
                  className="px-3 py-1.5"
                  onClick={() => resolveTakeover(true)}
                >
                  Take over
                </Button>
              </div>
            </Dialog>
          </>
        );
      })()}
      {/* Task 6 — pre-resume model picker for a native conversation resumed
          from a call site with no inline picker of its own (the Resume
          Browser's expanded row has one and never opens this — see
          pendingNativeResume's doc comment above). Same unified <ModelPicker>
          as the Resume Browser, SCOPED to native (a resume cannot move a
          conversation across runtimes, so offering Claude models here would be
          a pick that cannot be honoured). Resume stays disabled until a binding
          exists — Destin's ruling forbids auto-launching one. Cancel discards
          the pending resume entirely (no partial/implicit resume). */}
      {pendingNativeResume && (
        <>
          <Dialog
            open
            // Dismissal stays suppressed while the resume is in flight.
            onClose={() => { if (pendingNativeResuming) return; setPendingNativeResume(null); setPendingNativeBinding(null); }}
            size="panel"
            aria-label="Choose a model to resume with"
            scrollBody={false}
            className="p-5"
          >
            <h3 className="text-sm font-semibold text-fg mb-3">Choose a model to resume with</h3>
            <ModelPicker
              value={pendingNativeBinding ? { runtime: 'native', providerId: pendingNativeBinding.providerId, modelId: pendingNativeBinding.modelId } : null}
              onSelect={(c) => { if (c.runtime === 'native') setPendingNativeBinding({ providerId: c.providerId, modelId: c.modelId }); }}
              includeClaude={false}
              onManageModels={() => { setProvidersAutoOpen(true); setSettingsOpen(true); }}
            />
            <div className="flex justify-end gap-2 mt-4">
              <Button
                variant="secondary"
                size="lg"
                disabled={pendingNativeResuming}
                onClick={() => { setPendingNativeResume(null); setPendingNativeBinding(null); }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="lg"
                disabled={!pendingNativeBinding || pendingNativeResuming}
                onClick={async () => {
                  const p = pendingNativeResume;
                  const binding = pendingNativeBinding;
                  if (!p || !binding) return;
                  // Keep the modal open until the create acks (Task 6 review ack-gap).
                  // On success it closes; on failure it stays open — handleResumeSession
                  // has already surfaced the honest reason via a toast — so the user
                  // can retry or pick a different model instead of facing a blank pill.
                  setPendingNativeResuming(true);
                  const ok = await handleResumeSession(p.claudeSessionId, p.projectSlug, p.projectPath, undefined, undefined, p.launchInNewWindow, 'native', binding);
                  setPendingNativeResuming(false);
                  if (ok) { setPendingNativeResume(null); setPendingNativeBinding(null); }
                }}
              >
                {pendingNativeResuming ? 'Resuming…' : 'Resume'}
              </Button>
            </div>
          </Dialog>
        </>
      )}
      <ZoomOverlay
        zoomPercent={zoomPercent}
        visible={zoomVisible}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onZoomReset={handleZoomReset}
      />
      {/* ProjectView — full-screen artifact browser across all projects.
          Renders null when projectViewOpen === false so no DOM overhead when closed.
          z-[8000]: sits below the SessionStrip dropdown (9000) but above all
          L1–L4 overlays, the same tier used by similar full-screen views. */}
      <ProjectView
        // Project view homes to the focused conversation's folder on every open.
        activeSessionCwd={currentSession?.cwd}
        onNewConversation={(cwd) => { dispatchArtifact({ type: 'PROJECT_VIEW_CLOSED' }); createSession(cwd, false); }}
        onResumeConversation={(sid, slug, path, provider) => { dispatchArtifact({ type: 'PROJECT_VIEW_CLOSED' }); handleResumeSession(sid, slug, path, undefined, undefined, undefined, provider); }}
      />
    </div>
    </ArtifactProvider>
  );
}

// view is forwarded so InputBar's slash-command dispatcher can behave
// differently in chat vs terminal view (e.g. /config opens Preferences in
// chat view but passes through to Claude Code's TUI in terminal view).
// getUsageSnapshot lets /cost and /usage snapshot live stats from App state.
import type { UsageSnapshot } from './state/chat-types';
import type { SessionChatState } from './state/chat-types';
const ChatInputBar = React.forwardRef<InputBarHandle, { sessionId: string; view?: ViewMode; onOpenDrawer: (searchMode: boolean) => void; onCloseDrawer?: () => void; onDrawerSearch?: (query: string) => void; disabled?: boolean; minimal?: boolean; onResumeCommand?: () => void; getUsageSnapshot?: (sessionId: string) => UsageSnapshot | null; onOpenPreferences?: () => void; onToast?: (msg: string) => void; onSendBlocked?: (retry: () => void) => void; getSessionState?: (sessionId: string) => SessionChatState | undefined; onOpenModelPicker?: () => void; initialInput?: string; provider?: 'claude' | 'native' }>(
  function ChatInputBar({ sessionId, view, onOpenDrawer, onCloseDrawer, onDrawerSearch, disabled, minimal, onResumeCommand, getUsageSnapshot, onOpenPreferences, onToast, onSendBlocked, getSessionState, onOpenModelPicker, initialInput, provider }, ref) {
    return <InputBar ref={ref} sessionId={sessionId} view={view} onOpenDrawer={onOpenDrawer} onCloseDrawer={onCloseDrawer} onDrawerSearch={onDrawerSearch} disabled={disabled} minimal={minimal} onResumeCommand={onResumeCommand} getUsageSnapshot={getUsageSnapshot} onOpenPreferences={onOpenPreferences} onToast={onToast} onSendBlocked={onSendBlocked} getSessionState={getSessionState} onOpenModelPicker={onOpenModelPicker} initialInput={initialInput} provider={provider} />;
  },
);

// Dev-only profiler for the AppInner perf work, read via the dev window's
// console or scripts/cdp-eval.mjs against the DEV instance. Statically dead
// code in production builds (DEV-gated), tree-shaken by Vite.
//
// TWO distinct metrics — read BOTH:
// - appInnerRenders — how many times the AppInner COMPONENT itself re-rendered.
//   This is the tranche-1 metric. Before the tranche it climbed ~1:1 with
//   transcript dispatches during streaming; after, it should stay near-flat
//   (only dot-color/attention/active-model/session-switch changes). Counted by
//   a no-dep effect INSIDE AppInner (see its body), not here.
// - subtreeCommits / totalMs / maxMs — React.Profiler stats for the whole
//   AppInner SUBTREE. These stay high during streaming because ChatView
//   re-renders per transcript event BY DESIGN (the visible session's view must
//   update). That child cost is what a FUTURE tranche (memoized BottomChrome/
//   ContentArea) targets — it is NOT what tranche 1 changed, so don't read it
//   as the tranche-1 result.
declare global { interface Window { __appInnerProfile?: { appInnerRenders: number; subtreeCommits: number; totalMs: number; maxMs: number; since: number; reset: () => void } } }
function ensureAppInnerProfile() {
  if (!window.__appInnerProfile) {
    window.__appInnerProfile = {
      appInnerRenders: 0, subtreeCommits: 0, totalMs: 0, maxMs: 0, since: Date.now(),
      reset() { this.appInnerRenders = 0; this.subtreeCommits = 0; this.totalMs = 0; this.maxMs = 0; this.since = Date.now(); },
    };
  }
  return window.__appInnerProfile;
}
function AppInnerProfiler({ children }: { children: React.ReactNode }) {
  // @ts-ignore TS1343 — import.meta is intercepted by Vite at build time
  if (!import.meta.env.DEV) return <>{children}</>;
  ensureAppInnerProfile();
  const onRender: React.ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
    const p = window.__appInnerProfile!;
    p.subtreeCommits += 1;
    p.totalMs += actualDuration;
    if (actualDuration > p.maxMs) p.maxMs = actualDuration;
  };
  return <React.Profiler id="AppInner" onRender={onRender}>{children}</React.Profiler>;
}

// ─── R12: the one-time Linux buddy hide ────────────────────────────────────
// Design §6 of docs/active/design/2026-09-04-linux-buddy-helper/.
//
// WHAT THE USER SEES: a Linux user who already had the buddy switched on finds it
// OFF exactly once, the first time they launch the version that adds the KDE
// helper. Turning it back on is one click in Settings → Buddy Floater, and that
// click is where the helper is offered. Nothing pops up at launch (R13).
//
// WHY it has to happen at all: before this version the buddy appeared on Wayland
// but could not be dragged. Leaving it switched on would put a stuck buddy back on
// screen with no explanation; hiding it once turns "it's broken" into "it's off,
// switch it on and it asks you a question".
//
// WHY IT IS NOT "every Linux user" (design §4, revision 7): only a buddy that is
// actually broken gets hidden. On Linux X11 — and on Wayland sessions whose
// windows are really XWayland ones, which look identical from every environment
// variable — the app moves its own windows perfectly well and the buddy has
// always worked. Hiding THEIR buddy would take away something that was fine, and
// they could not get it back: the switch is where the hiding is undone, and a
// user who never needed a helper would be handed a consent card for one. So the
// question this asks the desktop is "does the buddy need a helper here, and is
// one missing?" — nothing else qualifies.
//
// WHY IN THE RENDERER, not the main process: the preference is
// localStorage['youcoded-buddy-enabled'], which only the renderer can read or
// write — a main-process one-shot cannot clear it.
const BUDDY_LINUX_HIDE_MIGRATION_KEY = 'youcoded-buddy-linux-hidden-once';

// Exported for tests/buddy-linux-migration.test.ts. Resolves to what it did, so a
// test can prove "exactly once" rather than inferring it from storage.
export async function runBuddyLinuxHideMigration(): Promise<
  'hid' | 'nothing-to-hide' | 'already-run' | 'skipped'
> {
  // The three buddy renderers (and the dormant overlay one) are separate windows
  // running this same App module. They share the profile's localStorage, so
  // without this guard the migration would run up to four times per launch and,
  // worse, could fire inside a buddy window after the main window had already
  // been re-enabled by the user.
  if (buddyMode) return 'skipped';
  // Remote browsers and Android: same Electron-only probe the boot effect uses
  // below. A phone has no buddy and no KDE, and every buddy method there throws.
  if (!(window as any).claude?.window) return 'skipped';
  if (localStorage.getItem(BUDDY_LINUX_HIDE_MIGRATION_KEY) === '1') return 'already-run';
  // The desktop's own three-fact answer, NOT "is this Linux". This one call is
  // the difference between hiding a broken buddy and taking a working one away.
  let helper: { needed?: boolean; installed?: boolean } | undefined;
  try {
    helper = await window.claude.buddy?.helperStatus?.();
  } catch {
    // Never let a boot-time IPC failure take the launch path down: if we cannot
    // tell what kind of desktop this is, we change nothing and try again next
    // launch. Doing nothing costs the user exactly today's behaviour.
    return 'skipped';
  }
  // No helper is wanted here (Windows, macOS, Linux/X11, XWayland): the buddy is
  // not broken, so there is nothing to hide. Deliberately WITHOUT writing the
  // marker — someone who is on X11 today and logs into a Wayland session
  // tomorrow still gets their one hide on the launch where it would matter.
  if (!helper?.needed) return 'skipped';
  // The helper is already in place, so the buddy can be dragged and works as
  // promised. Hiding it would be a mystery, not a rescue.
  if (helper.installed) return 'skipped';
  // The marker is written whether or not the buddy was on, so this is a true
  // one-shot: a user who switches the buddy back on is never hidden again.
  localStorage.setItem(BUDDY_LINUX_HIDE_MIGRATION_KEY, '1');
  if (localStorage.getItem('youcoded-buddy-enabled') !== '1') return 'nothing-to-hide';
  localStorage.setItem('youcoded-buddy-enabled', '0');
  return 'hid';
}

// The launch path for the buddy, extracted from the effect below so the ordering
// it depends on is testable: the R12 one-shot must finish BEFORE the preference
// is read, or a launch would still re-open the buddy this version means to hide.
export async function bootBuddyOnLaunch(): Promise<void> {
  if (buddyMode) return;
  // Fix: buddy.show() is an error-throwing stub in remote-shim (browser and
  // Android). Optional chaining does NOT help — the stub exists, it throws —
  // so a remote client with this flag set in localStorage threw out of this
  // effect and RootErrorBoundary replaced the whole app with "YouCoded failed
  // to start". Gate on window.claude.window, the Electron-only window-controls
  // surface the shim deliberately omits; getPlatform() is NOT usable here
  // because the shim sets __PLATFORM__ to the host's 'desktop' on auth:ok, so
  // a remote browser does not report as 'browser'.
  if (!(window as any).claude?.window) return;
  await runBuddyLinuxHideMigration();
  if (localStorage.getItem('youcoded-buddy-enabled') !== '1') return;
  // show() can now answer "no" (design §5) — a Wayland desktop whose helper has
  // gone missing since last launch refuses rather than putting a buddy on screen
  // that cannot be dragged. When it does, the stored preference is cleared, so
  // Settings → Buddy Floater does not sit there reading "On" with nothing on the
  // desktop. The refusal itself is main's to explain; the launch path stays
  // silent (R13: no dialog interrupts you).
  try {
    const res = await window.claude.buddy?.show?.();
    if (res && res.ok === false) localStorage.setItem('youcoded-buddy-enabled', '0');
  } catch { /* a throwing bridge is not a refusal — leave the preference alone */ }
}

export default function App() {
  // Perf lab: React has mounted the app shell (first commit).
  useEffect(() => { performance.mark('yc:app-mounted'); }, []);

  // Auto-show buddy on launch if the user previously enabled it. The effect
  // is called unconditionally (React rules-of-hooks) but no-ops inside
  // buddy windows themselves — only the main window should re-open the
  // buddy. Optional chaining guards against preload not being ready.
  useEffect(() => {
    void bootBuddyOnLaunch();
  }, []);

  // Buddy windows render as isolated placeholders without main-app providers
  if (buddyMode === 'buddy-mascot') return <BuddyMascotApp />;
  if (buddyMode === 'buddy-chat') return <BuddyChatApp />;
  if (buddyMode === 'buddy-bar') return <BuddyBarApp />;
  // The overlay strategy: the whole floater (mascot + chat + bar) mounted as DOM
  // inside one screen-sized window instead of the three separate windows above.
  //
  // Correction 2026-09-04 (design §7): this comment used to say Linux Wayland
  // takes this route. It does not, and has not — chooseBuddyStrategy
  // (buddy-manager.ts) returns 'windows' on every path except an explicit
  // YOUCODED_BUDDY_STRATEGY env override, so NO platform reaches
  // ?mode=buddy-overlay on its own. The overlay code is dormant, kept behind that
  // override; on Linux Wayland the buddy is three real windows moved by the KWin
  // helper. Believing the old sentence sends a session to the wrong file.
  if (buddyMode === 'buddy-overlay') return <BuddyOverlayApp />;

  // Main app wrapped in providers
  return (
    // Root boundary catches provider-level crashes that sub-tree boundaries can't.
    // Uses inline styles only — no theme tokens, no context — so it renders even
    // when ThemeProvider itself is the thing that crashed.
    <RootErrorBoundary>
      {/* EscCloseProvider owns capture-phase ESC routing — must wrap all
          overlay-bearing providers so every overlay is a descendant. Buddy
          windows (early-returned above) don't need it. */}
      <EscCloseProvider>
      <ThemeProvider>
        <ThemeBg />
        <ThemeEffects />
        {/* Fix: AccountProvider sits outside SkillProvider so marketplace-
            context can consume auth state without introducing a circular dependency.
            MarketplaceStatsProvider sits inside auth so it can co-exist with auth
            state, but outside SkillProvider/GameProvider/ChatProvider which may
            eventually consume live stats via useMarketplaceStats(). */}
        <AccountProvider>
          {/* Always-mounted, self-driven overlay: shows a one-time handle prompt
              right after sign-in (renders nothing when not applicable). Lives here
              so it can consume useAccount() regardless of the active view. */}
          <HandlePrompt />
          {/* WorkerHealthProvider wraps stats so the stats provider can report
              network results to the health indicator via the onNetworkResult prop. */}
          <WorkerHealthProvider>
            <StatsWithHealthBridge>
              <SkillProvider>
                <GameProvider>
                  <ChatProvider>
                    {/* MarketplaceProvider lifted to app root so ThemeScreen in
                        SettingsPanel (outside the library/marketplace view) can
                        consume useMarketplace() for the favorites star + filter. */}
                    <MarketplaceProvider>
                      <AppInnerProfiler>
                        <AppInner />
                      </AppInnerProfiler>
                    </MarketplaceProvider>
                  </ChatProvider>
                </GameProvider>
              </SkillProvider>
            </StatsWithHealthBridge>
          </WorkerHealthProvider>
        </AccountProvider>
      </ThemeProvider>
      </EscCloseProvider>
    </RootErrorBoundary>
  );
}
