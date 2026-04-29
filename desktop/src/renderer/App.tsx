// Registers window.__terminalRegistry so main-process executeJavaScript
// can call getScreenText for the attention classifier's ~1s buffer reads.
// Must run before any TerminalView mounts (which call registerTerminal).
import './bootstrap/terminal-bridge';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import TerminalView from './components/TerminalView';
import ChatView from './components/ChatView';
import HeaderBar from './components/HeaderBar';
import InputBar, { type InputBarHandle } from './components/InputBar';
import StatusBar from './components/StatusBar';
import { MODELS, type ModelAlias } from './components/StatusBar';
import FolderSwitcher from './components/FolderSwitcher';

// Labels for the welcome-screen model picker (mirrors SessionStrip)
const WELCOME_MODEL_LABELS: Record<string, string> = {
  sonnet: 'Sonnet',
  'opus[1m]': 'Opus 1M',
  haiku: 'Haiku',
};
import ErrorBoundary from './components/ErrorBoundary';
import GamePanel from './components/game/GamePanel';
import { ChatProvider, useChatDispatch, useChatState, useChatStateMap } from './state/chat-context';
// Central slash-command router — also used by the drawer so drawer-initiated
// slash commands behave the same as typed ones (otherwise drawer bypasses InputBar's intercept).
import { dispatchSlashCommand } from './state/slash-command-dispatcher';
import { GameProvider, useGameState, useGameDispatch } from './state/game-context';
import { hookEventToAction } from './state/hook-dispatcher';
import type { SyncWarning } from '../main/sync-state';
import { usePromptDetector } from './hooks/usePromptDetector';
import { useVisualViewport } from './hooks/useVisualViewport';
import { usePartyLobby } from './hooks/usePartyLobby';
import { usePartyGame } from './hooks/usePartyGame';
import { useRemoteAttentionSync } from './hooks/useRemoteAttentionSync';
import { useSubmitConfirmation } from './hooks/useSubmitConfirmation';
import { broadcastExpandAll, broadcastCollapseAll, isInExpandAllMode } from './hooks/useExpandAllToggle';
import { AppIcon, WelcomeAppIcon, ThemeMascot } from './components/Icons';
import CommandDrawer from './components/CommandDrawer';
import { TerminalScrollButtons } from './components/TerminalToolbar';
import TrustGate, { useTrustGateActive } from './components/TrustGate';
import SettingsPanel from './components/SettingsPanel';
import ResumeBrowser from './components/ResumeBrowser';
import CloseSessionPrompt, { CLOSE_PROMPT_SUPPRESS_KEY } from './components/CloseSessionPrompt';
import PreferencesPopup from './components/PreferencesPopup';
import ModelPickerPopup from './components/ModelPickerPopup';
import OpenTasksPopup from './components/OpenTasksPopup';
import { useSessionTasks } from './hooks/useSessionTasks';
import MarketplaceScreen from './components/marketplace/MarketplaceScreen';
import LibraryScreen from './components/library/LibraryScreen';
import { MarketplaceProvider } from './state/marketplace-context';
import ThemeShareSheet from './components/ThemeShareSheet';
import SkillEditor from './components/SkillEditor';
import ShareSheet from './components/ShareSheet';

import type { SkillEntry, PermissionMode, AttentionState, CommandEntry } from '../shared/types';
import FirstRunView from './components/FirstRunView';
import { getPlatform, isRemoteMode, onConnectionModeChange } from './platform';
import type { SessionStatusColor } from './components/StatusDot';
import { ThemeProvider, useTheme } from './state/theme-context';
import { SkillProvider } from './state/skill-context';
import { MarketplaceAuthProvider } from './state/marketplace-auth-context';
import { MarketplaceStatsProvider } from './state/marketplace-stats-context';
import { WorkerHealthProvider, useWorkerHealth } from './state/worker-health-context';
import ThemeEffects from './components/ThemeEffects';
import { ZoomOverlay } from './components/ZoomOverlay';
import { RemoteSnapshotExporter } from './components/RemoteSnapshotExporter';
import { BuddyMascotApp } from './components/buddy/BuddyMascotApp';
import { BuddyChatApp } from './components/buddy/BuddyChatApp';
import { BuddyCaptureApp } from './components/buddy/BuddyCaptureApp';

// Dev-only ToolCard fixture sandbox wrapper. The React.lazy + dynamic
// import() live inside a `import.meta.env.DEV` ternary so Vite statically
// replaces the prod branch with `null` and tree-shakes the entire sandbox
// module (plus its fixture glob) out of production bundles. A bare
// module-scope `React.lazy(() => import(...))` would keep the chunk
// reachable — Vite emits a chunk for every reachable dynamic import
// regardless of whether the call site is dead code at the CALL SITE.
// By making the lazy itself conditional on DEV, the whole dependency edge
// disappears in prod.
// Named-export unwrap: ToolSandbox is a named export, not default.
// @ts-ignore TS1343 — import.meta is intercepted by Vite at build time
const ToolSandboxRoute: React.ComponentType = import.meta.env.DEV
  ? (() => {
      const Lazy = React.lazy(() =>
        import('./dev/ToolSandbox').then((m) => ({ default: m.ToolSandbox }))
      );
      return function ToolSandboxRouteDev() {
        return (
          <React.Suspense fallback={null}>
            <Lazy />
          </React.Suspense>
        );
      };
    })()
  : () => null;
// ESC-passthrough: provider owns capture-phase ESC routing for overlays.
// Mounted at app root so every overlay component is a descendant.
import { EscCloseProvider } from './hooks/use-esc-close';
// Pure guard for the chat-focused ESC -> PTY forwarding listener below.
import { shouldForwardEscToPty } from './state/should-forward-esc-to-pty';

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
  announcement: any;
  updateStatus: any;
  model: string | null;
  contextMap: Record<string, number>;
  gitBranchMap: Record<string, string>;
  sessionStatsMap: Record<string, SessionStats>;
  syncStatus: string | null;
  syncWarnings: SyncWarning[] | null;
  lastSyncEpoch: number | null;
  syncInProgress: boolean;
  backupMeta: any;
  // Non-null while a recent restore is still pulling older conversations in
  // the background. Drives the StatusBar 'restore-progress' chip.
  backgroundPull: { type: 'conversations'; startedAt: number } | null;
}

function AppInner() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<any[]>([]);
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
    usage: null, announcement: null, updateStatus: null,
    model: null, contextMap: {}, gitBranchMap: {}, sessionStatsMap: {},
    syncStatus: null, syncWarnings: [],
    lastSyncEpoch: null, syncInProgress: false, backupMeta: null,
    backgroundPull: null,
  });

  const [permissionModes, setPermissionModes] = useState<Map<string, PermissionMode>>(new Map());
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
  const [settingsDangerBadge, setSettingsDangerBadge] = useState(false);
  const [syncAutoOpen, setSyncAutoOpen] = useState(false);
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  // Track which sessions the user has "seen" (switched to after activity completed)
  const [viewedSessions, setViewedSessions] = useState<Set<string>>(new Set());
  const [resumeInfo, setResumeInfo] = useState<Map<string, { claudeSessionId: string; projectSlug: string }>>(new Map());
  const [resumeRequested, setResumeRequested] = useState(false);
  // Shown when the user closes an active session — offers to mark it complete
  // in one step so it's hidden from the resume menu by default.
  const [closePromptFor, setClosePromptFor] = useState<string | null>(null);
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
  const [marketplaceInitialType, setMarketplaceInitialType] = useState<'skill' | 'theme' | undefined>(undefined);
  // When the CommandDrawer's plugin-name badge is clicked, we navigate to
  // the marketplace AND immediately open that plugin's detail overlay.
  // MarketplaceScreen reads this, opens the overlay on mount, then calls
  // the passed clearing callback so subsequent manual navigations start fresh.
  const [marketplaceInitialDetailId, setMarketplaceInitialDetailId] = useState<string | undefined>(undefined);
  // Tab to show when Library opens — consumed by LibraryScreen (Task 5.2 wires
  // the prop; this state is lifted here so the event listener below can set it).
  const [libraryInitialTab, setLibraryInitialTab] = useState<'skills' | 'themes' | 'updates' | undefined>(undefined);

  // Open the marketplace destination; `installed` routes to the Library
  // sibling. Omit `tab` (or pass undefined) to land on the discovery page
  // with no type chip pre-selected — the command drawer uses this so the
  // user sees the hero + rails, not a pre-filtered grid.
  const openMarketplace = useCallback((tab?: 'installed' | 'skills' | 'themes') => {
    if (tab === 'installed') {
      setActiveView('library');
      return;
    }
    if (tab === 'skills') setMarketplaceInitialType('skill');
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

  // Listen for the global "open library" event dispatched by ThemeScreen's
  // "Browse all themes" button. Opens Library to the requested tab and closes
  // the Appearance popup (the popup is inside SettingsPanel which the user can
  // close separately; we just navigate away by switching the active view).
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const tab = detail?.tab as 'skills' | 'themes' | 'updates' | undefined;
      setLibraryInitialTab(tab);
      setActiveView('library');
      // Close settings panel so the Library fills the screen unobstructed.
      setSettingsOpen(false);
    };
    window.addEventListener('youcoded:open-library', onOpen);
    return () => window.removeEventListener('youcoded:open-library', onOpen);
  }, []);
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

  // Per-session model state — keyed by sessionId, same pattern as permissionModes
  const [sessionModels, setSessionModels] = useState<Map<string, ModelAlias>>(new Map());
  const currentModel: ModelAlias = sessionId ? (sessionModels.get(sessionId) ?? 'sonnet') : 'sonnet';
  const [pendingModel, setPendingModel] = useState<ModelAlias | null>(null);
  const consecutiveFailures = useRef(0);
  // Fix: track whether a new user turn has started after the model switch.
  // Events from the in-flight turn (before the switch takes effect) use the
  // old model and would cause false "failed to switch" errors.
  const postSwitchTurnReady = useRef(false);
  const [toast, setToast] = useState<string | null>(null);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [zoomVisible, setZoomVisible] = useState(false);
  const zoomHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch actual zoom level on mount — Electron may have persisted a non-100% zoom
  useEffect(() => {
    (window as any).claude?.zoom?.get?.().then((p: number) => {
      if (p && p !== 100) setZoomPercent(p);
    }).catch(() => {});
  }, []);

  const [sessionDefaults, setSessionDefaults] = useState({ skipPermissions: false, model: 'sonnet', projectFolder: '', geminiEnabled: false });

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
  // busy — see useSubmitConfirmation for the full mechanism.
  useSubmitConfirmation();
  // Drives --vvp-offset from window.visualViewport so the input bar stays glued
  // to the top of the soft keyboard on Android / mobile browsers.
  useVisualViewport();
  useRemoteAttentionSync();
  const dispatch = useChatDispatch();
  const chatStateMap = useChatStateMap();
  // Latest-value ref so transcript-shrink and turn-complete handlers see
  // up-to-date compactionPending state without re-subscribing on every reducer tick.
  const chatStateMapRef = useRef(chatStateMap);
  useEffect(() => { chatStateMapRef.current = chatStateMap; }, [chatStateMap]);

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
  useEffect(() => {
    // Perf: this effect fires on every reducer dispatch. Steady state (no
    // compaction in flight, no live watchdogs) short-circuits without walking
    // the session map. When a compaction is live we still iterate — preserving
    // the activity-awareness described above (timer resets on every dispatch).
    if (compactWatchdogs.current.size === 0) {
      let anyPending = false;
      for (const session of chatStateMap.values()) {
        if (session.compactionPending) { anyPending = true; break; }
      }
      if (!anyPending) return;
    }
    for (const [sid, session] of chatStateMap) {
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
  }, [chatStateMap, dispatch]);

  // Attention-reporter ref declared up here so hooks-order stays deterministic;
  // the useEffect that writes to it lives AFTER sessionStatuses is computed
  // (search for "Attention reporter effect" below).
  const lastAttentionReportedRef = useRef<Map<string, { attentionState: AttentionState; awaitingApproval: boolean; status: SessionStatusColor }>>(new Map());

  const gameState = useGameState();
  const gameDispatch = useGameDispatch();
  // Gate on isLeader so only the first-launched window opens the lobby
  // socket — avoids duplicate presence for the same GitHub identity when
  // multiple peer windows are open. When detach isn't available (remote
  // shim / Android), myWindowId stays null so isLeader is false — fall
  // back to true-by-default so the lobby still connects.
  const lobbyLeader = (window as any).claude?.detach?.openDetached ? isLeader : true;
  const lobby = usePartyLobby(lobbyLeader);
  const game = usePartyGame(lobby.updateStatus, lobby.challengePlayer);

  const gameConnection = useMemo(() => ({
    createGame: game.createGame,
    joinGame: game.joinGame,
    makeMove: game.makeMove,
    sendChat: game.sendChat,
    requestRematch: game.requestRematch,
    leaveGame: game.leaveGame,
    challengePlayer: game.challengePlayer,
    respondToChallenge: lobby.respondToChallenge,
    reconnectLobby: lobby.reconnect,
  }), [game.createGame, game.joinGame, game.makeMove, game.sendChat, game.requestRematch, game.leaveGame, game.challengePlayer, lobby.respondToChallenge, lobby.reconnect]);

  // Derive session status colors for status dots.
  // chatStateMap is a new Map reference on every dispatch, so we stabilize with
  // a ref — return the previous reference when the derived values haven't changed.
  const sessionStatusesRef = useRef<Map<string, SessionStatusColor>>(new Map());

  const sessionStatuses = useMemo(() => {
    const newStatuses = new Map<string, SessionStatusColor>();
    let changed = false;

    for (const s of sessions) {
      const chatState = chatStateMap.get(s.id);
      if (!chatState) { newStatuses.set(s.id, 'gray'); }
      else {
        // Only check tools in the active turn — stale tools from old turns are invisible
        let hasAwaiting = false;
        let hasRunning = false;
        for (const id of chatState.activeTurnToolIds) {
          const t = chatState.toolCalls.get(id);
          if (!t) continue;
          if (t.status === 'awaiting-approval') hasAwaiting = true;
          else if (t.status === 'running') hasRunning = true;
          if (hasAwaiting) break;
        }

        // Priority: red (awaiting-approval) → amber (attention banner showing —
        // stuck or session-died) → green (working) → blue (unseen activity) →
        // gray (idle). Amber is between red and green: the session needs the
        // user's eyes but it's not as urgent as a permission prompt, and it's
        // not "all good, just working" either. Overrides green so a stuck
        // session doesn't appear identical to a healthy thinking session.
        const needsAttention = chatState.attentionState !== 'ok';
        const status: SessionStatusColor = hasAwaiting
          ? 'red'
          : needsAttention
            ? 'amber'
            : (chatState.isThinking || hasRunning)
              ? 'green'
              : (chatState.timeline.length > 0 && !viewedSessions.has(s.id) && s.id !== sessionId)
                ? 'blue'
                : 'gray';
        newStatuses.set(s.id, status);
      }

      const prev = sessionStatusesRef.current.get(s.id);
      if (prev !== newStatuses.get(s.id)) changed = true;
    }

    if (!changed && newStatuses.size === sessionStatusesRef.current.size) {
      return sessionStatusesRef.current;
    }
    sessionStatusesRef.current = newStatuses;
    return newStatuses;
  }, [sessions, chatStateMap, viewedSessions, sessionId]);

  // Play the 'attention' sound when any session transitions to red (awaiting
  // approval). Red is a visible state, so color-driven dedup is correct here.
  const prevStatusSoundRef = useRef<Map<string, SessionStatusColor>>(new Map());
  // Remote attention diffing: tracks the last-seen attentionMap from status:data
  // so we only dispatch ATTENTION_STATE_CHANGED when a session's state actually flips.
  // On desktop, useAttentionClassifier already handles this locally (no-op here because
  // the reducer is idempotent for same-value transitions and the diff prevents redundant
  // dispatches). On remote browsers the classifier doesn't run, so this is the only path.
  const prevAttentionRef = useRef<Record<string, string>>({});
  useEffect(() => {
    const prev = prevStatusSoundRef.current;
    for (const [id, color] of sessionStatuses) {
      const was = prev.get(id);
      if (was === color) continue;
      if (color === 'red' && was !== 'red') playSound('attention');
    }
    prevStatusSoundRef.current = new Map(sessionStatuses);
  }, [sessionStatuses]);

  // Play the 'ready' sound when any session's isThinking transitions true → false.
  // Replaces the prior blue-color-transition trigger, which never fired for the
  // currently-viewed session (blue requires "unseen, not active"). Thinking-false
  // is the actual "response finished" signal and fires regardless of visibility.
  const prevThinkingRef = useRef<Map<string, boolean>>(new Map());
  useEffect(() => {
    const prev = prevThinkingRef.current;
    const next = new Map<string, boolean>();
    for (const [id, state] of chatStateMap) {
      const was = prev.get(id);
      const isThinking = !!state.isThinking;
      next.set(id, isThinking);
      // Only fire when we actually observed a true → false transition. Skip if
      // the session just appeared (was === undefined) to avoid a spurious chime
      // on reducer init or remote hydrate when isThinking arrives already false.
      if (was === true && !isThinking) playSound('ready');
    }
    prevThinkingRef.current = next;
  }, [chatStateMap]);

  // Attention reporter effect: pushes per-session attention state + the
  // derived dot color to main whenever chatStateMap or sessionStatuses
  // changes. Main aggregates across all windows and broadcasts
  // session:attention-summary so buddy surfaces can render the same dots.
  //
  // A ref-based diff ensures we only report when state actually changes —
  // chatStateMap is a new Map reference on every dispatch, so we compare
  // the derived triple before sending. Session removal sends
  // { clear: true } so main drops stale entries.
  //
  // Declared here (not where the ref is) because the status comes from
  // sessionStatuses, which is computed above — running the effect before
  // that would read `undefined`.
  useEffect(() => {
    const prev = lastAttentionReportedRef.current;
    const currentIds = new Set<string>();
    for (const [sid, state] of chatStateMap) {
      currentIds.add(sid);
      let awaitingApproval = false;
      for (const id of state.activeTurnToolIds) {
        const t = state.toolCalls.get(id);
        if (t?.status === 'awaiting-approval') { awaitingApproval = true; break; }
      }
      // Thread the same dot color the main switcher renders for this
      // session so the buddy pill's dot is visually identical.
      const status = sessionStatuses.get(sid) ?? 'gray';
      const next = { attentionState: state.attentionState, awaitingApproval, status };
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
  }, [chatStateMap, sessionStatuses]);

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
      // Gemini sessions are terminal-only (no transcript watcher), so default to terminal view
      const defaultView = (info.provider && info.provider !== 'claude') ? 'terminal' : 'chat';
      setViewModes((prev) => prev.has(info.id) ? prev : new Map(prev).set(info.id, defaultView));
      setPermissionModes((prev) => prev.has(info.id) ? prev : new Map(prev).set(info.id, info.permissionMode || 'normal'));
      setSessionModels((prev) => {
        if (prev.has(info.id)) return prev;
        // Match the model string from SessionInfo back to a ModelAlias (e.g. 'claude-sonnet-4-6' → 'sonnet')
        const alias = MODELS.find((m) => info.model?.includes(m.replace(/\[.*\]/, ''))) ?? 'sonnet';
        return new Map(prev).set(info.id, alias);
      });
      // Non-Claude providers (e.g. Gemini) don't emit hook events, so they'd
      // never trigger the "first hook = initialized" gate. Mark them ready immediately.
      if (info.provider && info.provider !== 'claude') {
        setInitializedSessions((prev) => {
          if (prev.has(info.id)) return prev;
          const next = new Set(prev);
          next.add(info.id);
          return next;
        });
      }
    });

    const destroyedHandler = window.claude.on.sessionDestroyed((id: string, exitCode: number = 0) => {
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
    const pendingTranscriptActions: any[] = [];
    let transcriptRafId: number | null = null;
    let transcriptBatchCancelled = false;

    function flushTranscriptActions() {
      transcriptRafId = null;
      if (transcriptBatchCancelled) return;
      const batch = pendingTranscriptActions.splice(0);
      // React 18 batches all synchronous dispatches → single render for the whole batch
      for (const action of batch) {
        dispatch(action);
      }
    }

    function batchTranscriptDispatch(action: any) {
      pendingTranscriptActions.push(action);
      if (transcriptRafId === null) {
        transcriptRafId = requestAnimationFrame(flushTranscriptActions);
      }
    }

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
          break;
        case 'assistant-thinking':
          // Extended-thinking heartbeat — bumps lastActivityAt and clears
          // any stale attention banner. No timeline change.
          batchTranscriptDispatch({
            type: 'TRANSCRIPT_THINKING_HEARTBEAT',
            sessionId: event.sessionId,
          });
          break;
        case 'compact-summary': {
          // Canonical compaction-complete signal — fired by the transcript
          // watcher when Claude Code writes an isCompactSummary entry. Works
          // for both in-session /compact (appends to same JSONL, so shrink
          // never fires) and resume-from-summary (first entry of new JSONL).
          const sessionState = chatStateMapRef.current.get(event.sessionId);
          if (sessionState?.compactionPending) {
            const contextTokens = statusData.sessionStatsMap[event.sessionId]?.contextTokens ?? null;
            dispatch({
              type: 'COMPACTION_COMPLETE',
              sessionId: event.sessionId,
              markerId: `compact-done-${Date.now()}`,
              afterContextTokens: contextTokens,
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

    // Permission-mode detection (per-session) is wired up in a dedicated
    // effect below, scoped to the current sessions list. Previously this used
    // a global pty:output listener; that channel is no longer broadcast
    // (every PTY chunk used to be double-sent to pay for a single listener —
    // see ipc-handlers.ts pty-output comments).

    const statusHandler = window.claude.on.statusData((data) => {
      setStatusData((prev) => ({
        ...prev,
        usage: data.usage,
        announcement: data.announcement,
        updateStatus: data.updateStatus,
        syncStatus: data.syncStatus,
        syncWarnings: Array.isArray(data.syncWarnings) ? data.syncWarnings : [],
        lastSyncEpoch: data.lastSyncEpoch ?? prev.lastSyncEpoch,
        syncInProgress: data.syncInProgress ?? prev.syncInProgress,
        backupMeta: data.backupMeta ?? prev.backupMeta,
        contextMap: data.contextMap || prev.contextMap,
        gitBranchMap: data.gitBranchMap || prev.gitBranchMap,
        sessionStatsMap: data.sessionStatsMap || prev.sessionStatsMap,
        // backgroundPull intentionally trusts the server payload (no `?? prev`):
        // the server's `null` is meaningful — it signals "background pull just
        // completed, hide the chip." Falling back to prev would keep the chip
        // visible forever after the bg-pull finishes.
        backgroundPull: data.backgroundPull ?? null,
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

    return () => {
      transcriptBatchCancelled = true;
      if (transcriptRafId !== null) cancelAnimationFrame(transcriptRafId);
      window.claude.off('session:created', createdHandler);
      window.claude.off('session:destroyed', destroyedHandler);
      window.claude.off('hook:event', hookHandler);
      window.claude.off('session:renamed', renamedHandler);
      window.claude.off('status:data', statusHandler);
      if (transcriptHandler) window.claude.off('transcript:event', transcriptHandler);
      if (shrinkHandler) window.claude.off('transcript:shrink', shrinkHandler);
      if (uiActionHandler) window.claude.off('ui:action:received', uiActionHandler);
      if (promptShowHandler) window.claude.off('prompt:show', promptShowHandler);
      if (promptDismissHandler) window.claude.off('prompt:dismiss', promptDismissHandler);
      if (promptCompleteHandler) window.claude.off('prompt:complete', promptCompleteHandler);
      if (sessionPermissionModeHandler) window.claude.off('session:permission-mode', sessionPermissionModeHandler);
      if (chatHydrateHandler) window.claude.off('chat:hydrate', chatHydrateHandler);
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
  // (e.g., remote browser reconnecting after the replay buffer events already fired)
  useEffect(() => {
    window.claude.session.list().then((list: any[]) => {
      if (!list || list.length === 0) return;
      setSessions((prev) => {
        const existingIds = new Set(prev.map((s) => s.id));
        const newSessions = list.filter((s) => !existingIds.has(s.id));
        if (newSessions.length === 0) return prev;
        for (const s of newSessions) {
          dispatch({ type: 'SESSION_INIT', sessionId: s.id });
          setViewModes((vm) => vm.has(s.id) ? vm : new Map(vm).set(s.id, 'chat'));
          setPermissionModes((pm) => pm.has(s.id) ? pm : new Map(pm).set(s.id, s.permissionMode || 'normal'));
        }
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

    const cleanupAcquired = det.onOwnershipAcquired?.((payload: any) => {
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
      const defaultView = (sessionInfo.provider && sessionInfo.provider !== 'claude') ? 'terminal' : 'chat';
      setViewModes((prev) => prev.has(sid) ? prev : new Map(prev).set(sid, defaultView));
      setPermissionModes((prev) => prev.has(sid) ? prev : new Map(prev).set(sid, sessionInfo.permissionMode || 'normal'));
      // Transferred sessions were already initialized on the source — skip the
      // "Initializing" overlay, it would flash briefly before replay completes.
      setInitializedSessions((prev) => {
        if (prev.has(sid)) return prev;
        const next = new Set(prev); next.add(sid); return next;
      });
      if (freshWindow) setSessionId(sid);
      // Hydrate reducer from disk. Main streams every transcript event back on
      // the normal channel; uuid dedup absorbs any overlap with live events.
      det.requestTranscriptReplay?.(sid);
    });

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
  }, [dispatch]);

  // Load skills once on mount
  useEffect(() => {
    window.claude.skills.list().then((list) => {
      // Inject built-in resume skill at the top
      const resumeSkill: SkillEntry = {
        id: '_resume',
        displayName: 'Resume Session',
        description: 'Resume a previous conversation',
        category: 'personal',
        prompt: '',
        source: 'youcoded-core',
        type: 'prompt',
        visibility: 'published',
      };
      setSkills([resumeSkill, ...list]);
    }).catch(console.error);
  }, []);

  // Flush and reload session state when connection mode changes (local ↔ remote).
  // On Android, switching to remote means the WebSocket now talks to the desktop server —
  // all local session state is stale and must be replaced with the desktop's sessions.
  useEffect(() => {
    const unsub = onConnectionModeChange((mode) => {
      // Flush all session state
      setSessions([]);
      setSessionId(null);
      setViewModes(new Map());
      setPermissionModes(new Map());
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
          setPermissionModes((pm) => new Map(pm).set(s.id, s.permissionMode || 'normal'));
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
  // Early-exit: skip iteration if no sessions are currently thinking.
  useEffect(() => {
    let anyThinking = false;
    for (const s of sessions) {
      const chatState = chatStateMap.get(s.id);
      if (chatState?.isThinking) { anyThinking = true; break; }
    }
    if (!anyThinking) return;

    for (const s of sessions) {
      const chatState = chatStateMap.get(s.id);
      if (chatState?.isThinking) {
        setViewedSessions((prev) => {
          if (!prev.has(s.id)) return prev;
          const next = new Set(prev);
          next.delete(s.id);
          return next;
        });
      }
    }
  }, [sessions, chatStateMap]);

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

  // Poll sync status; if any danger-level warning exists, surface a red
  // dot on the gear icon so the user can't miss a push failure.
  useEffect(() => {
    const claude = (window as any).claude;
    if (!claude?.sync?.getStatus) return;
    const check = () => {
      claude.sync.getStatus()
        .then((s: any) => {
          const hasDanger = Array.isArray(s?.warnings)
            && s.warnings.some((w: any) => w?.level === 'danger');
          setSettingsDangerBadge(hasDanger);
        })
        .catch(() => {});
    };
    check();
    const interval = setInterval(check, 15000);
    return () => clearInterval(interval);
  }, []);

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
    const idx = MODELS.indexOf(currentModel);
    const next = MODELS[(idx + 1) % MODELS.length];
    setSessionModels((prev) => new Map(prev).set(sessionId, next));
    setPendingModel(next);
    // Fix: don't verify against in-flight events from the current turn —
    // wait until a new user turn starts so we know Claude is using the new model.
    postSwitchTurnReady.current = false;
    // Persist preference optimistically — the /model command is reliable,
    // verification is just a safety net. If verification later shows a
    // mismatch, the failure handler overwrites with the actual model.
    (window.claude as any).model?.setPreference(next);
    window.claude.session.sendInput(sessionId, `/model ${next}\r`);
  }, [currentModel, sessionId]);
  cycleModelRef.current = cycleModel;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip when a text input is focused — Shift+Space is a normal typing
      // combo (capitalized word then space) and would fire accidentally.
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
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
          setToast("Model switch failed again. Ask Claude to diagnose with /model, or report a bug.");
        } else {
          setToast("Couldn't switch to " + pendingModel.charAt(0).toUpperCase() + pendingModel.slice(1));
        }
        setTimeout(() => setToast(null), 4000);
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
  useEffect(() => {
    if (!sessionId || pendingModel) return;
    const session = chatStateMap.get(sessionId);
    if (!session) return;

    // Walk backward through the timeline for the most recent assistant-turn
    // with a known model. turn.model is null until the first assistant-text
    // arrives, so new/empty sessions exit here.
    let latestModel: string | null = null;
    for (let i = session.timeline.length - 1; i >= 0; i--) {
      const entry = session.timeline[i];
      if (entry.kind === 'assistant-turn') {
        const turn = session.assistantTurns.get(entry.turnId);
        if (turn?.model) {
          latestModel = turn.model;
          break;
        }
      }
    }
    if (!latestModel) return;

    // Match the raw transcript model (e.g. 'claude-opus-4-7') → ModelAlias,
    // mirroring the SessionInfo matcher at line 372.
    const alias = MODELS.find((m) => latestModel!.includes(m.replace(/\[.*\]/, '')));
    if (!alias) return;

    const currentAlias = sessionModels.get(sessionId);
    if (currentAlias && currentAlias !== alias) {
      // Drift detected — reconcile silently. setPreference persists to disk
      // (so next session boots with the correct default); setSessionModels
      // updates the status-bar pill + Shift+Space cycle start point.
      (window.claude as any).model?.setPreference(alias);
      setSessionModels((prev) => new Map(prev).set(sessionId, alias));
    }
  }, [sessionId, chatStateMap, sessionModels, pendingModel]);

  // Snapshot factory for /cost and /usage. Pulls live stats from statusData
  // and freezes them as a point-in-time snapshot. Returns null if stats haven't
  // arrived yet (status line hook runs after each command, so a brand-new session
  // may have no data for a few seconds).
  const getUsageSnapshot = useCallback(
    (sid: string) => {
      const stats = statusData.sessionStatsMap[sid];
      const ctx = statusData.contextMap[sid] ?? null;
      const usage = statusData.usage as { five_hour?: { utilization: number; resets_at: string }; seven_day?: { utilization: number; resets_at: string } } | null;
      if (!stats && ctx == null && !usage) return null;
      return {
        entryId: `usage-${sid}-${Date.now()}`,
        timestamp: Date.now(),
        costUsd: stats?.costUsd ?? null,
        inputTokens: stats?.inputTokens ?? null,
        outputTokens: stats?.outputTokens ?? null,
        cacheReadTokens: stats?.cacheReadTokens ?? null,
        cacheCreationTokens: stats?.cacheCreationTokens ?? null,
        contextTokens: stats?.contextTokens ?? null,
        contextPercent: ctx,
        duration: stats?.duration ?? null,
        apiDuration: stats?.apiDuration ?? null,
        linesAdded: stats?.linesAdded ?? null,
        linesRemoved: stats?.linesRemoved ?? null,
        fiveHourUtilization: usage?.five_hour?.utilization ?? null,
        fiveHourResetsAt: usage?.five_hour?.resets_at ?? null,
        sevenDayUtilization: usage?.seven_day?.utilization ?? null,
        sevenDayResetsAt: usage?.seven_day?.resets_at ?? null,
      };
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
          callbacks: { onResumeCommand: () => setResumeRequested(true), getUsageSnapshot, onOpenPreferences: () => setPreferencesOpen(true), onToast: (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000); }, getSessionState: (sid: string) => chatStateMapRef.current.get(sid), onOpenModelPicker: () => setModelPickerOpen(true) },
        });
        if (result.handled) {
          if (result.alsoSendToPty) {
            window.claude.session.sendInput(sessionId, result.alsoSendToPty);
          }
          return;
        }
        // Dispatcher declined (e.g. missing callback) — fall through to raw PTY send.
      }

      // Filesystem commands (and any unhandled YouCoded command) — send the
      // slash command to the PTY so Claude Code executes it. Also record the
      // optimistic user prompt so the chat timeline shows the action.
      dispatch({
        type: 'USER_PROMPT',
        sessionId,
        content: entry.name,
        timestamp: Date.now(),
      });
      window.claude.session.sendInput(sessionId, `${entry.name}\r`);
    },
    [sessionId, dispatch, viewModes, getUsageSnapshot],
  );

  const handleSelectSkill = useCallback(
    (skill: SkillEntry) => {
      if (skill.id === '_resume') {
        setDrawerOpen(false);
        setDrawerFilter(undefined);
        setResumeRequested(true);
        return;
      }
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
          callbacks: { onResumeCommand: () => setResumeRequested(true), getUsageSnapshot, onOpenPreferences: () => setPreferencesOpen(true), onToast: (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000); }, getSessionState: (sid: string) => chatStateMapRef.current.get(sid), onOpenModelPicker: () => setModelPickerOpen(true) },
        });
        if (result.handled) {
          if (result.alsoSendToPty) {
            window.claude.session.sendInput(sessionId, result.alsoSendToPty);
          }
          return;
        }
      }

      dispatch({
        type: 'USER_PROMPT',
        sessionId,
        content: skill.prompt,
        timestamp: Date.now(),
      });
      window.claude.session.sendInput(sessionId, skill.prompt + '\r');
    },
    [sessionId, dispatch, viewModes, getUsageSnapshot],
  );

  const createSession = useCallback(async (cwd: string, dangerous: boolean, sessionModel?: string, provider?: 'claude' | 'gemini', launchInNewWindow?: boolean) => {
    // Use the explicitly chosen model; fall back to the current session's model
    const m = sessionModel || currentModel;
    const info = await (window.claude.session.create as any)({
      name: provider === 'gemini' ? 'Gemini Session' : 'New Session',
      cwd,
      skipPermissions: dangerous,
      model: m,
      provider: provider || 'claude',
    });
    // Launch-in-new-window: hand the freshly-created session off to a peer
    // window via the same ownership-transfer path used by drag-detach.
    if (launchInNewWindow && info?.id) {
      (window as any).claude?.detach?.openDetached?.({ sessionId: info.id });
    }
  }, [currentModel]);

  const handleResumeSession = useCallback(async (claudeSessionId: string, projectSlug: string, projectPath: string, resumeModel?: string, resumeDangerous?: boolean, launchInNewWindow?: boolean) => {
    const cwd = projectPath;
    // Use explicitly chosen resume model; fall back to the current session's model
    const m = resumeModel || currentModel;

    // Pass --resume flag so Claude Code boots directly into the resumed session
    const newSession = await (window.claude.session.create as any)({
      name: 'Resuming...',
      cwd,
      skipPermissions: resumeDangerous || false,
      resumeSessionId: claudeSessionId,
      model: m,
    });
    if (!newSession?.id) return;

    // Launch-in-new-window for resumed sessions — same peer-window spawn path.
    if (launchInNewWindow) {
      (window as any).claude?.detach?.openDetached?.({ sessionId: newSession.id });
    }

    setResumeInfo((prev) => new Map(prev).set(newSession.id, { claudeSessionId, projectSlug }));

    // Load recent history into chat view
    try {
      const messages = await (window as any).claude.session.loadHistory(claudeSessionId, projectSlug, 10, false);
      if (messages.length > 0) {
        dispatch({
          type: 'HISTORY_LOADED',
          sessionId: newSession.id,
          messages,
          hasMore: true,
        });
      }
    } catch (err) {
      console.error('Failed to load history:', err);
    }
  }, [dispatch, currentModel]);

  const currentViewMode = sessionId ? (viewModes.get(sessionId) || 'chat') : 'chat';

  // Mirror the active view mode onto <html data-view-mode="..."> so CSS can
  // react to it. Needed on Android to hide the wallpaper layer over the native
  // terminal — the React-side bg div sits on top of the native TerminalView
  // and opaque wallpapers were blocking the terminal text from showing through.
  useEffect(() => {
    document.documentElement.dataset.viewMode = currentViewMode;
  }, [currentViewMode]);

  const handleToggleView = useCallback(
    (mode: ViewMode) => {
      if (!sessionId) return;
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
  }>({ activeSessionId: '', viewMode: 'chat' });
  escPassthroughStateRef.current = {
    activeSessionId: sessionId ?? '',
    viewMode: currentViewMode,
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
  const currentPermissionMode = sessionId ? (permissionModes.get(sessionId) || 'normal') : 'normal';

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
    const canAuto = currentModel === 'opus[1m]';
    const cycle: PermissionMode[] = [
      'normal',
      'auto-accept',
      'plan',
      ...(canAuto ? ['auto' as PermissionMode] : []),
      ...(canBypass ? ['bypass' as PermissionMode] : []),
    ];
    const idx = cycle.indexOf(currentPermissionMode);
    const next = cycle[(idx + 1) % cycle.length];
    setPermissionModes((prev) => new Map(prev).set(sessionId, next));
    // Send Shift+Tab to the PTY to cycle Claude Code's permission mode
    window.claude.session.sendInput(sessionId, '\x1b[Z');
  }, [sessionId, canBypass, currentPermissionMode, currentModel]);
  cyclePermissionRef.current = cyclePermission;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key === 'Tab') {
        e.preventDefault();
        cyclePermissionRef.current?.();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  // --- Zoom controls (Ctrl+/-, Ctrl+0, trackpad pinch) ---
  const showZoom = useCallback((percent: number) => {
    setZoomPercent(percent);
    setZoomVisible(true);
    if (zoomHideTimer.current) clearTimeout(zoomHideTimer.current);
    zoomHideTimer.current = setTimeout(() => setZoomVisible(false), 1500);
  }, []);

  const handleZoomIn = useCallback(async () => {
    const percent = await (window as any).claude.zoom.zoomIn();
    showZoom(percent);
  }, [showZoom]);

  const handleZoomOut = useCallback(async () => {
    const percent = await (window as any).claude.zoom.zoomOut();
    showZoom(percent);
  }, [showZoom]);

  const handleZoomReset = useCallback(async () => {
    const percent = await (window as any).claude.zoom.reset();
    showZoom(percent);
  }, [showZoom]);

  // Refs so the event listeners always see the latest callbacks without re-registering
  const zoomInRef = useRef(handleZoomIn);
  const zoomOutRef = useRef(handleZoomOut);
  const zoomResetRef = useRef(handleZoomReset);
  zoomInRef.current = handleZoomIn;
  zoomOutRef.current = handleZoomOut;
  zoomResetRef.current = handleZoomReset;

  // Keyboard: Ctrl+Plus, Ctrl+Minus, Ctrl+0
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      // '+' comes as '=' on US keyboards (Shift not required), or '+' with Shift,
      // or via numpad ('+'). Ctrl+= is the standard "zoom in" shortcut.
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        zoomInRef.current();
      } else if (e.key === '-') {
        e.preventDefault();
        zoomOutRef.current();
      } else if (e.key === '0') {
        e.preventDefault();
        zoomResetRef.current();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  // Trackpad pinch-to-zoom — Chromium/Electron fires wheel events with ctrlKey
  // set to true for pinch gestures. Debounce to avoid spamming IPC.
  const pinchAccumulator = useRef(0);
  const pinchFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // Only intercept pinch (ctrlKey) wheel events
      e.preventDefault();

      // Accumulate delta and flush after a short pause — prevents one pinch
      // gesture from firing dozens of IPC calls
      pinchAccumulator.current += e.deltaY;

      if (pinchFlushTimer.current) clearTimeout(pinchFlushTimer.current);
      pinchFlushTimer.current = setTimeout(async () => {
        const delta = pinchAccumulator.current;
        pinchAccumulator.current = 0;
        if (Math.abs(delta) < 5) return; // Ignore tiny jitter
        if (delta < 0) {
          zoomInRef.current();
        } else {
          zoomOutRef.current();
        }
      }, 50);
    };
    // Must use { passive: false } to allow preventDefault on wheel
    window.addEventListener('wheel', handler, { passive: false, capture: true });
    return () => window.removeEventListener('wheel', handler, true);
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

  // Show a "something may be wrong" hint after 15s of waiting on initialization.
  // Resets whenever the active session changes or the session becomes initialized.
  const [initSlowWarning, setInitSlowWarning] = useState(false);
  useEffect(() => {
    if (sessionInitialized) { setInitSlowWarning(false); return; }
    setInitSlowWarning(false);
    const t = setTimeout(() => setInitSlowWarning(true), 15000);
    return () => clearTimeout(t);
  }, [sessionId, sessionInitialized]);

  // Terminal mode on touch/remote platforms — show minimal input with special keys
  const isTerminalTouch = currentViewMode === 'terminal' && getPlatform() !== 'electron';

  // Track bottom chrome height for glassmorphism scroll-behind.
  // Sets --bottom-chrome-height CSS variable so .chat-scroll can add matching
  // padding-bottom, allowing messages to scroll behind the frosted input/status bars.
  useEffect(() => {
    const bottom = bottomBarRef.current;
    if (!bottom) return;
    const update = () => {
      const h = Math.ceil(bottom.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--bottom-chrome-height', `${h}px`);
    };
    const observer = new ResizeObserver(update);
    observer.observe(bottom);
    update();
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--bottom-chrome-height');
    };
  }, [sessionId, currentViewMode]);

  // Report header/bottom bar heights to native Android side for terminal overlay sizing.
  // Must be before early returns to maintain consistent hook ordering across renders.
  useEffect(() => {
    if (getPlatform() !== 'android') return;
    const header = headerRef.current;
    const bottom = bottomBarRef.current;
    if (!header && !bottom) return;

    const report = () => {
      const headerH = header?.getBoundingClientRect().height || 0;
      const bottomH = bottom?.getBoundingClientRect().height || 0;
      (window as any).claude?.remote?.broadcastAction?.({
        action: 'layout-update',
        headerHeight: Math.round(headerH),
        bottomHeight: Math.round(bottomH),
      });
    };

    const observer = new ResizeObserver(report);
    if (header) observer.observe(header);
    if (bottom) observer.observe(bottom);
    // Report immediately on mount
    report();
    return () => observer.disconnect();
  }, [sessionId, currentViewMode]);

  // Still loading first-run check
  if (isFirstRun === null) {
    return <div className="flex-1 flex items-center justify-center bg-gray-950" />;
  }

  // First-run mode — show setup UI instead of normal app
  if (isFirstRun) {
    return (
      <div className="h-screen flex flex-col bg-gray-950">
        <FirstRunView onComplete={handleFirstRunComplete} />
      </div>
    );
  }

  return (
    <div className={`app-shell flex w-screen h-full text-fg ${getPlatform() === 'android' && currentViewMode === 'terminal' ? '' : 'bg-canvas'}`}>
      {/* Mount-only: listens for chat:export-snapshot from main, serializes
          ChatState, and sends the snapshot back for remote-browser hydration. */}
      <RemoteSnapshotExporter />
      {/* Main area — relative so bottom-float chrome can position against it.
          When a Phase-2 full-screen destination is active, hide the chat
          chrome entirely. Unmounting via `hidden` is cleaner than z-index
          games — chrome has backdrop-filter stacking contexts that trap
          sibling z-index values. */}
      <div
        className="flex-1 flex flex-col overflow-hidden relative"
        hidden={activeView === 'marketplace' || activeView === 'library'}
      >
        {sessions.length > 0 && sessionId && currentSession ? (
          <>
            <div ref={headerRef} className="chrome-wrapper bg-canvas">
              <HeaderBar
                sessions={sessions}
                activeSessionId={sessionId}
                onSelectSession={(id: string) => {
                  setSessionId(id);
                  // Notify Android/remote bridge so the native terminal view switches too
                  (window as any).claude?.session?.switch?.(id);
                }}
                onCreateSession={createSession}
                onCloseSession={(id) => {
                  // Skip prompt if the user has checked "Don't show again".
                  // In that case destroy immediately without any flags — the
                  // user can still tag sessions from the resume menu later.
                  if (localStorage.getItem(CLOSE_PROMPT_SUPPRESS_KEY) === '1') {
                    try { window.claude.session.destroy(id); } catch {}
                  } else {
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
                permissionMode={currentPermissionMode}
                onCyclePermission={cyclePermission}
                settingsOpen={settingsOpen}
                onToggleSettings={() => setSettingsOpen(prev => !prev)}
                settingsBadge={settingsBadge}
                settingsDangerBadge={settingsDangerBadge}
                sessionStatuses={sessionStatuses}
                onResumeSession={handleResumeSession}
                onOpenResumeBrowser={() => setResumeRequested(true)}
                defaultModel={sessionDefaults.model}
                defaultSkipPermissions={sessionDefaults.skipPermissions}
                defaultProjectFolder={sessionDefaults.projectFolder}
                geminiEnabled={sessionDefaults.geminiEnabled}
                windowDirectory={windowDirectory}
                myWindowId={myWindowId}
              />
            </div>
            <div
              className="flex-1 overflow-hidden relative"
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
                      visible={s.id === sessionId && (viewModes.get(s.id) || 'chat') === 'chat'}
                      resumeInfo={resumeInfo}
                    />
                  </ErrorBoundary>
                  <ErrorBoundary name="Terminal">
                    <TerminalView
                      sessionId={s.id}
                      visible={s.id === sessionId && (viewModes.get(s.id) || 'chat') === 'terminal'}
                    />
                  </ErrorBoundary>
                </React.Fragment>
              ))}
              {/* Initializing overlay — shown before Claude is ready, but only in chat view.
                 Terminal view must stay accessible during init so the user can interact there.
                 z-10: must stay below glassmorphism chrome (z-20) so header/bottom bars remain accessible */}
              {!sessionInitialized && sessionId && currentViewMode !== 'terminal' && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-canvas">
                  <ThemeMascot variant="idle" fallback={AppIcon} className="w-16 h-16 text-fg-dim mb-6 animate-pulse" />
                  <p className="text-sm text-fg-dim font-medium">Initializing session...</p>
                  {initSlowWarning && (
                    <div className="mt-4 text-xs text-fg-muted text-center max-w-xs flex flex-col gap-1">
                      <p>Something may be wrong.</p>
                      <p>Use the chat/terminal toggle to check terminal view for messages.</p>
                    </div>
                  )}
                </div>
              )}
              {trustGateActive && sessionId && <TrustGate sessionId={sessionId} />}
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
                {/* TerminalToolbar (Esc/Tab/Ctrl/arrows) now renders inside
                    ChatInputBar when minimal={isTerminalTouch}, slotted in
                    the QuickChips position so both modes share one container. */}
                <ChatInputBar ref={inputBarRef} sessionId={sessionId} view={currentViewMode} onOpenDrawer={handleOpenDrawer} onCloseDrawer={handleCloseDrawer} onDrawerSearch={setDrawerFilter} disabled={trustGateActive || !sessionInitialized} minimal={isTerminalTouch} onResumeCommand={() => setResumeRequested(true)} getUsageSnapshot={getUsageSnapshot} onOpenPreferences={() => setPreferencesOpen(true)} onToast={(msg) => { setToast(msg); setTimeout(() => setToast(null), 3000); }} getSessionState={(sid) => chatStateMapRef.current.get(sid)} onOpenModelPicker={() => setModelPickerOpen(true)} initialInput={currentSession?.initialInput} />
                <StatusBar
                  statusData={{
                    usage: statusData.usage,
                    updateStatus: statusData.updateStatus,
                    announcement: statusData.announcement,
                    contextPercent: sessionId ? (statusData.contextMap[sessionId] ?? null) : null,
                    gitBranch: sessionId ? (statusData.gitBranchMap[sessionId] ?? null) : null,
                    sessionStats: sessionId ? (statusData.sessionStatsMap[sessionId] ?? null) : null,
                    syncStatus: statusData.syncStatus,
                    syncWarnings: statusData.syncWarnings,
                    backgroundPull: statusData.backgroundPull,
                  }}
                  onOpenSync={() => {
                    // Open settings panel with sync popup auto-opened
                    setSyncAutoOpen(true);
                    setSettingsOpen(true);
                  }}
                  onRunSync={!trustGateActive && sessionId ? () => {
                    dispatch({ type: 'USER_PROMPT', sessionId, content: '/sync', timestamp: Date.now() });
                    window.claude.session.sendInput(sessionId, '/sync\r');
                  } : undefined}
                  model={currentModel}
                  onCycleModel={cycleModel}
                  permissionMode={currentPermissionMode}
                  onCyclePermission={cyclePermission}
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
                        onToast: (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000); },
                        getSessionState: (sid: string) => chatStateMapRef.current.get(sid),
                        onOpenModelPicker: () => setModelPickerOpen(true),
                      },
                    });
                    // Forward alsoSendToPty so Claude Code itself runs the command. We deliberately skip the
                    // USER_PROMPT optimistic bubble that InputBar dispatches — for /compact and /clear, the
                    // COMPACTION_PENDING / CLEAR_TIMELINE reducer actions already update the timeline, so a
                    // USER_PROMPT bubble would render redundantly alongside them.
                    if (result.handled && result.alsoSendToPty) {
                      window.claude.session.sendInput(sessionId, result.alsoSendToPty);
                    }
                  }}
                  openTasksCounts={sessionId ? { running: openTasks.counts.running, pending: openTasks.counts.pending } : undefined}
                  onOpenOpenTasks={() => setOpenTasksPopupOpen(true)}
                />
              </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-3">
            <p className="text-xl text-fg-muted">No Active Session</p>
            <ThemeMascot variant="welcome" fallback={WelcomeAppIcon} className="w-36 h-36 text-fg-dim" />
            {/* Welcome screen: New Session (expandable) + Resume Session */}
            <div className="flex flex-col items-center gap-2 mt-1 w-64">
              {welcomeFormOpen ? (
                /* Expanded new-session form with toggles */
                <div className="layer-surface w-full p-3 flex flex-col gap-2">
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-fg-muted mb-1 block">Project Folder</label>
                    <FolderSwitcher value={welcomeCwd} onChange={setWelcomeCwd} />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-fg-muted mb-1 block">Model</label>
                    <div className="flex gap-1">
                      {MODELS.map((m) => (
                        <button
                          key={m}
                          onClick={() => setWelcomeModel(m)}
                          className={`flex-1 px-1 py-1 rounded-sm text-[10px] transition-colors ${
                            welcomeModel === m
                              ? 'bg-accent text-on-accent font-medium'
                              : 'bg-inset text-fg-dim hover:bg-edge'
                          }`}
                        >
                          {WELCOME_MODEL_LABELS[m] || m}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] uppercase tracking-wider text-fg-muted">Skip Permissions</label>
                    <button
                      onClick={() => setWelcomeDangerous(!welcomeDangerous)}
                      className={`w-8 h-4.5 rounded-full relative transition-colors ${welcomeDangerous ? 'bg-[#DD4444]' : 'bg-inset'}`}
                    >
                      <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${welcomeDangerous ? 'left-[calc(100%-16px)]' : 'left-0.5'}`} />
                    </button>
                  </div>
                  {welcomeDangerous && (
                    <p className="text-[10px] text-[#DD4444]">Claude will execute tools without asking for approval.</p>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={() => setWelcomeFormOpen(false)}
                      className="px-3 py-1.5 text-sm rounded-md bg-inset text-fg-dim hover:bg-edge transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => {
                        createSession(welcomeCwd, welcomeDangerous, welcomeModel);
                        setWelcomeFormOpen(false);
                      }}
                      className={`flex-1 text-sm font-medium rounded-md py-1.5 transition-colors ${
                        welcomeDangerous
                          ? 'bg-[#DD4444] hover:bg-[#E55555] text-white'
                          : 'bg-accent hover:bg-accent text-on-accent'
                      }`}
                    >
                      {welcomeDangerous ? 'Create (Dangerous)' : 'Create Session'}
                    </button>
                  </div>
                </div>
              ) : (
                /* Collapsed state: two side-by-side buttons */
                <>
                  <button
                    onClick={() => {
                      setWelcomeCwd(sessionDefaults.projectFolder || '');
                      setWelcomeDangerous(sessionDefaults.skipPermissions || false);
                      setWelcomeModel(sessionDefaults.model || 'sonnet');
                      setWelcomeFormOpen(true);
                    }}
                    className="panel-glass w-full px-8 py-2 text-base font-medium rounded-lg bg-accent text-on-accent hover:brightness-110 transition-colors"
                  >
                    New Session
                  </button>
                  <button
                    onClick={() => setResumeRequested(true)}
                    className="panel-glass w-full px-6 py-2 rounded-lg bg-inset hover:bg-edge text-fg-dim hover:text-fg transition-colors flex items-center justify-center gap-1.5"
                  >
                    <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span className="text-sm font-medium">Resume Session</span>
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Game panel (conditional) */}
      {gameState.panelOpen && (
        <ErrorBoundary name="Game">
          <GamePanel connection={gameConnection} incognito={lobby.incognito} onToggleIncognito={lobby.toggleIncognito} />
        </ErrorBoundary>
      )}
      <SettingsPanel
        open={settingsOpen}
        onClose={() => { setSettingsOpen(false); setSyncAutoOpen(false); }}
        onSendInput={(text) => {
          if (sessionId) {
            const claude = (window as any).claude;
            claude.session.sendInput(sessionId, text + '\r');
          }
        }}
        hasActiveSession={!!sessionId}
        onOpenThemeMarketplace={() => { setSettingsOpen(false); openMarketplace('themes'); }}
        onPublishTheme={(slug) => { setSettingsOpen(false); setPublishThemeSlug(slug); }}
        syncAutoOpen={syncAutoOpen}
        onSyncAutoOpenHandled={() => setSyncAutoOpen(false)}
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
        sessionName={sessions.find((s) => s.id === closePromptFor)?.name}
        onCancel={() => setClosePromptFor(null)}
        onConfirm={(flagsToSet) => {
          const id = closePromptFor;
          if (!id) return;
          // Fire setFlag for each selected tag (fire-and-forget — backend logs
          // any failure). Main resolves the desktop ID to a Claude session ID
          // via sessionIdMap before writing conversation-index.json.
          for (const flag of flagsToSet) {
            try { (window as any).claude.session.setFlag(id, flag, true); } catch {}
          }
          try { window.claude.session.destroy(id); } catch {}
          setClosePromptFor(null);
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
          // to avoid Ink's paste timer swallowing Enter.
          setTimeout(() => window.claude.session.sendInput(sessionId, '/config\r'), 50);
        }}
      />
      <ModelPickerPopup
        open={modelPickerOpen}
        onClose={() => setModelPickerOpen(false)}
        sessionId={sessionId}
        currentModel={currentModel}
        onSelectModel={(m) => {
          if (!sessionId) return;
          setSessionModels((prev) => new Map(prev).set(sessionId, m));
          setPendingModel(m);
          postSwitchTurnReady.current = false;
          (window.claude as any).model?.setPreference(m);
          window.claude.session.sendInput(sessionId, `/model ${m}\r`);
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
          libraryInitialTab is lifted state set by the youcoded:open-library event
          (dispatched by ThemeScreen's "Browse all themes" button); Task 5.2 wires
          it to LibraryScreen's initialTab prop. */}
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
            onExit={() => { setActiveView('chat'); setLibraryInitialTab(undefined); }}
            onOpenMarketplace={() => setActiveView('marketplace')}
            onOpenShareSheet={(id) => setShareSkillId(id)}
            onOpenThemeShare={(slug) => setPublishThemeSlug(slug)}
            initialTab={libraryInitialTab}
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
      {toast && (
        <div className="fixed bottom-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-panel border border-edge text-sm text-fg shadow-lg">
          {toast}
        </div>
      )}
      <ZoomOverlay
        zoomPercent={zoomPercent}
        visible={zoomVisible}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onZoomReset={handleZoomReset}
      />
    </div>
  );
}

// view is forwarded so InputBar's slash-command dispatcher can behave
// differently in chat vs terminal view (e.g. /config opens Preferences in
// chat view but passes through to Claude Code's TUI in terminal view).
// getUsageSnapshot lets /cost and /usage snapshot live stats from App state.
import type { UsageSnapshot } from './state/chat-types';
import type { SessionChatState } from './state/chat-types';
const ChatInputBar = React.forwardRef<InputBarHandle, { sessionId: string; view?: ViewMode; onOpenDrawer: (searchMode: boolean) => void; onCloseDrawer?: () => void; onDrawerSearch?: (query: string) => void; disabled?: boolean; minimal?: boolean; onResumeCommand?: () => void; getUsageSnapshot?: (sessionId: string) => UsageSnapshot | null; onOpenPreferences?: () => void; onToast?: (msg: string) => void; getSessionState?: (sessionId: string) => SessionChatState | undefined; onOpenModelPicker?: () => void; initialInput?: string }>(
  function ChatInputBar({ sessionId, view, onOpenDrawer, onCloseDrawer, onDrawerSearch, disabled, minimal, onResumeCommand, getUsageSnapshot, onOpenPreferences, onToast, getSessionState, onOpenModelPicker, initialInput }, ref) {
    return <InputBar ref={ref} sessionId={sessionId} view={view} onOpenDrawer={onOpenDrawer} onCloseDrawer={onCloseDrawer} onDrawerSearch={onDrawerSearch} disabled={disabled} minimal={minimal} onResumeCommand={onResumeCommand} getUsageSnapshot={getUsageSnapshot} onOpenPreferences={onOpenPreferences} onToast={onToast} getSessionState={getSessionState} onOpenModelPicker={onOpenModelPicker} initialInput={initialInput} />;
  },
);

function ThemeBg() {
  const { bgStyle, patternStyle } = useTheme();
  return (
    <>
      {bgStyle && <div id="theme-bg" style={bgStyle as unknown as React.CSSProperties} aria-hidden="true" />}
      {patternStyle && <div id="theme-pattern" style={patternStyle as unknown as React.CSSProperties} aria-hidden="true" />}
    </>
  );
}

// Bridge: reads reportResult from WorkerHealthContext and passes it to MarketplaceStatsProvider.
// Must be a child of WorkerHealthProvider and parent of anything that consumes useMarketplaceStats().
function StatsWithHealthBridge({ children }: { children: React.ReactNode }) {
  const { reportResult } = useWorkerHealth();
  return (
    <MarketplaceStatsProvider onNetworkResult={reportResult}>
      {children}
    </MarketplaceStatsProvider>
  );
}

export default function App() {
  // Auto-show buddy on launch if the user previously enabled it. The effect
  // is called unconditionally (React rules-of-hooks) but no-ops inside
  // buddy windows themselves — only the main window should re-open the
  // buddy. Optional chaining guards against preload not being ready.
  useEffect(() => {
    if (buddyMode) return;
    if (localStorage.getItem('youcoded-buddy-enabled') === '1') {
      window.claude.buddy?.show?.();
    }
  }, []);

  // Dev-only ToolCard sandbox route. Gated on import.meta.env.DEV so the
  // entire branch (including the dynamic import() below) is statically
  // dead code in production builds and tree-shaken out by Vite. Follows
  // the same ?mode= query-param convention as buddy windows above.
  // Named-export unwrap: ToolSandbox is a named export, not default.
  // @ts-ignore TS1343 — import.meta is intercepted by Vite at build time
  if (import.meta.env.DEV && buddyMode === 'tool-sandbox') {
    return <ToolSandboxRoute />;
  }

  // Buddy windows render as isolated placeholders without main-app providers
  if (buddyMode === 'buddy-mascot') return <BuddyMascotApp />;
  if (buddyMode === 'buddy-chat') return <BuddyChatApp />;
  if (buddyMode === 'buddy-capture') return <BuddyCaptureApp />;

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
        {/* Fix: MarketplaceAuthProvider sits outside SkillProvider so marketplace-
            context can consume auth state without introducing a circular dependency.
            MarketplaceStatsProvider sits inside auth so it can co-exist with auth
            state, but outside SkillProvider/GameProvider/ChatProvider which may
            eventually consume live stats via useMarketplaceStats(). */}
        <MarketplaceAuthProvider>
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
                      <AppInner />
                    </MarketplaceProvider>
                  </ChatProvider>
                </GameProvider>
              </SkillProvider>
            </StatsWithHealthBridge>
          </WorkerHealthProvider>
        </MarketplaceAuthProvider>
      </ThemeProvider>
      </EscCloseProvider>
    </RootErrorBoundary>
  );
}

/**
 * Outermost error boundary — renders without any provider context.
 * Inline styles only so it works even if CSS/themes fail to load.
 */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[RootErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', height: '100vh', fontFamily: 'system-ui, sans-serif',
          background: '#1a1a2e', color: '#ccc', padding: 24, textAlign: 'center',
        }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>:(</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#e55' }}>
            YouCoded failed to start
          </div>
          <div style={{
            fontSize: 12, color: '#888', marginTop: 8, maxWidth: 400,
            wordBreak: 'break-word',
          }}>
            {this.state.error.message}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: 16, padding: '6px 16px', borderRadius: 4,
              border: '1px solid #444', background: '#2a2a3e', color: '#ccc',
              cursor: 'pointer', fontSize: 12,
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
