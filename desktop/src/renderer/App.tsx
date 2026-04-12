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
import { usePromptDetector } from './hooks/usePromptDetector';
import { usePartyLobby } from './hooks/usePartyLobby';
import { usePartyGame } from './hooks/usePartyGame';
import { AppIcon, WelcomeAppIcon, ThemeMascot } from './components/Icons';
import CommandDrawer from './components/CommandDrawer';
import TerminalToolbar, { TerminalScrollButtons } from './components/TerminalToolbar';
import TrustGate, { useTrustGateActive } from './components/TrustGate';
import SettingsPanel from './components/SettingsPanel';
import ResumeBrowser from './components/ResumeBrowser';
import CloseSessionPrompt from './components/CloseSessionPrompt';
import PreferencesPopup from './components/PreferencesPopup';
import ModelPickerPopup from './components/ModelPickerPopup';
import Marketplace from './components/Marketplace';
import ThemeShareSheet from './components/ThemeShareSheet';
import SkillEditor from './components/SkillEditor';
import ShareSheet from './components/ShareSheet';

import type { SkillEntry, PermissionMode } from '../shared/types';
import FirstRunView from './components/FirstRunView';
import { getPlatform, isRemoteMode, onConnectionModeChange } from './platform';
import type { SessionStatusColor } from './components/StatusDot';
import { ThemeProvider, useTheme } from './state/theme-context';
import { SkillProvider } from './state/skill-context';
import ThemeEffects from './components/ThemeEffects';
import { ZoomOverlay } from './components/ZoomOverlay';

type ViewMode = 'chat' | 'terminal';

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
  syncWarnings: string | null;
  lastSyncEpoch: number | null;
  syncInProgress: boolean;
  backupMeta: any;
}

function AppInner() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  const [viewModes, setViewModes] = useState<Map<string, ViewMode>>(new Map());
  const [statusData, setStatusData] = useState<StatusDataState>({
    usage: null, announcement: null, updateStatus: null,
    model: null, contextMap: {}, gitBranchMap: {}, sessionStatsMap: {},
    syncStatus: null, syncWarnings: null,
    lastSyncEpoch: null, syncInProgress: false, backupMeta: null,
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
  // Fast + effort state — surfaced via status bar chips. Persisted to ~/.claude/destincode-model-modes.json.
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
  // Unified marketplace modal — null means closed, string selects initial tab
  const [marketplaceTab, setMarketplaceTab] = useState<'installed' | 'skills' | 'themes' | null>(null);
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

  const [model, setModel] = useState<ModelAlias>('sonnet');
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

  // Load persisted model preference on mount
  useEffect(() => {
    (window.claude as any).model?.getPreference().then((m: string) => {
      if (MODELS.includes(m as any)) {
        setModel(m as ModelAlias);
      }
    }).catch(() => {});
  }, []);

  // Load session defaults on mount and whenever settings panel closes
  useEffect(() => {
    (window as any).claude?.defaults?.get?.().then((defs: any) => {
      if (defs) setSessionDefaults(defs);
    }).catch(() => {});
  }, [settingsOpen]);

  usePromptDetector();
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
  const gameState = useGameState();
  const gameDispatch = useGameDispatch();
  const lobby = usePartyLobby();
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
  }), [game.createGame, game.joinGame, game.makeMove, game.sendChat, game.requestRematch, game.leaveGame, game.challengePlayer, lobby.respondToChallenge]);

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

        const status: SessionStatusColor = hasAwaiting
          ? 'red'
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

  // Play sounds when session status transitions to red (attention) or blue (ready).
  // Uses a separate ref so we only fire once per transition, not on every render.
  const prevStatusSoundRef = useRef<Map<string, SessionStatusColor>>(new Map());
  useEffect(() => {
    const prev = prevStatusSoundRef.current;
    for (const [id, color] of sessionStatuses) {
      const was = prev.get(id);
      if (was === color) continue; // no change
      if (color === 'red' && was !== 'red') playSound('attention');
      if (color === 'blue' && was !== 'blue') playSound('ready');
    }
    prevStatusSoundRef.current = new Map(sessionStatuses);
  }, [sessionStatuses]);

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

    const destroyedHandler = window.claude.on.sessionDestroyed((id) => {
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
          });
          break;
        case 'assistant-text':
          batchTranscriptDispatch({
            type: 'TRANSCRIPT_ASSISTANT_TEXT',
            sessionId: event.sessionId,
            uuid: event.uuid,
            text: event.data.text,
            timestamp: event.timestamp,
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
          });
          break;
        case 'turn-complete':
          batchTranscriptDispatch({
            type: 'TRANSCRIPT_TURN_COMPLETE',
            sessionId: event.sessionId,
            uuid: event.uuid,
            timestamp: event.timestamp,
          });
          // Resume-from-summary fallback: resume creates a NEW JSONL file so
          // transcript-shrink never fires on it. The summary arrives as the
          // first turn-complete after COMPACTION_PENDING was set — use that
          // as the completion signal instead.
          {
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
          }
          break;
      }
    });

    // /compact completion (primary path): Claude Code rewrites the JSONL with
    // the compacted summary; we see the file shrink and finalize the marker.
    // For typed /compact (not resume-from-summary), this is the reliable signal.
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

    // Sync permission mode by reading Claude Code's mode indicator from PTY output.
    // Same approach as the mobile app — just check for mode text in the output.
    const ptyModeHandler = window.claude.on.ptyOutput((sid: string, data: string) => {
      const lower = data.toLowerCase();
      let mode: PermissionMode | null = null;
      if (lower.includes('bypass permissions on')) mode = 'bypass';
      else if (lower.includes('accept edits on')) mode = 'auto-accept';
      else if (lower.includes('plan mode on')) mode = 'plan';
      else if (lower.includes('bypass permissions off')
            || lower.includes('accept edits off')
            || lower.includes('plan mode off')) mode = 'normal';
      if (mode) {
        setPermissionModes((prev) => {
          if (prev.get(sid) === mode) return prev;
          return new Map(prev).set(sid, mode!);
        });
      }
    });

    const statusHandler = window.claude.on.statusData((data) => {
      setStatusData((prev) => ({
        ...prev,
        usage: data.usage,
        announcement: data.announcement,
        updateStatus: data.updateStatus,
        syncStatus: data.syncStatus,
        syncWarnings: data.syncWarnings,
        lastSyncEpoch: data.lastSyncEpoch ?? prev.lastSyncEpoch,
        syncInProgress: data.syncInProgress ?? prev.syncInProgress,
        backupMeta: data.backupMeta ?? prev.backupMeta,
        contextMap: data.contextMap || prev.contextMap,
        gitBranchMap: data.gitBranchMap || prev.gitBranchMap,
        sessionStatsMap: data.sessionStatsMap || prev.sessionStatsMap,
      }));
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

    return () => {
      transcriptBatchCancelled = true;
      if (transcriptRafId !== null) cancelAnimationFrame(transcriptRafId);
      window.claude.off('session:created', createdHandler);
      window.claude.off('session:destroyed', destroyedHandler);
      window.claude.off('hook:event', hookHandler);
      window.claude.off('session:renamed', renamedHandler);
      window.claude.off('pty:output', ptyModeHandler);
      window.claude.off('status:data', statusHandler);
      if (transcriptHandler) window.claude.off('transcript:event', transcriptHandler);
      if (shrinkHandler) window.claude.off('transcript:shrink', shrinkHandler);
      if (uiActionHandler) window.claude.off('ui:action:received', uiActionHandler);
      if (promptShowHandler) window.claude.off('prompt:show', promptShowHandler);
      if (promptDismissHandler) window.claude.off('prompt:dismiss', promptDismissHandler);
      if (promptCompleteHandler) window.claude.off('prompt:complete', promptCompleteHandler);
      if (sessionPermissionModeHandler) window.claude.off('session:permission-mode', sessionPermissionModeHandler);
    };
  }, [dispatch]);

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
        source: 'destinclaude',
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
    const idx = MODELS.indexOf(model);
    const next = MODELS[(idx + 1) % MODELS.length];
    setModel(next);
    setPendingModel(next);
    // Fix: don't verify against in-flight events from the current turn —
    // wait until a new user turn starts so we know Claude is using the new model.
    postSwitchTurnReady.current = false;
    // Persist preference optimistically — the /model command is reliable,
    // verification is just a safety net. If verification later shows a
    // mismatch, the failure handler overwrites with the actual model.
    (window.claude as any).model?.setPreference(next);
    if (sessionId) {
      window.claude.session.sendInput(sessionId, `/model ${next}\r`);
    }
  }, [model, sessionId]);
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
        // Revert both UI and persisted preference to what Claude is actually using
        if (actual) {
          setModel(actual);
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

  const createSession = useCallback(async (cwd: string, dangerous: boolean, sessionModel?: string, provider?: 'claude' | 'gemini') => {
    const m = sessionModel || model;
    // Update the active model to match what was chosen in the form
    if (sessionModel && MODELS.includes(sessionModel as any)) {
      setModel(sessionModel as ModelAlias);
    }
    await (window.claude.session.create as any)({
      name: provider === 'gemini' ? 'Gemini Session' : 'New Session',
      cwd,
      skipPermissions: dangerous,
      model: m,
      provider: provider || 'claude',
    });
  }, [model]);

  const handleResumeSession = useCallback(async (claudeSessionId: string, projectSlug: string, projectPath: string, resumeModel?: string, resumeDangerous?: boolean) => {
    const cwd = projectPath;
    const m = resumeModel || model;
    if (resumeModel && MODELS.includes(resumeModel as any)) {
      setModel(resumeModel as ModelAlias);
    }

    // Pass --resume flag so Claude Code boots directly into the resumed session
    const newSession = await (window.claude.session.create as any)({
      name: 'Resuming...',
      cwd,
      skipPermissions: resumeDangerous || false,
      resumeSessionId: claudeSessionId,
      model: m,
    });
    if (!newSession?.id) return;

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
  }, [dispatch, model]);

  const currentViewMode = sessionId ? (viewModes.get(sessionId) || 'chat') : 'chat';

  const handleToggleView = useCallback(
    (mode: ViewMode) => {
      if (!sessionId) return;
      setViewModes((prev) => new Map(prev).set(sessionId, mode));
      // Fix: flag a transition window so CSS can suppress backdrop-filter
      // on the chrome during the 300ms toggle. Blur recomposite was a major
      // driver of jank reports across all themes with panel blur enabled.
      // Timer-based rather than transitionend because the transition lives
      // on multiple elements and cancellation can skip the event.
      const root = document.documentElement;
      root.setAttribute('data-toggling', '');
      window.setTimeout(() => root.removeAttribute('data-toggling'), 320);
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

  const currentSession = sessions.find((s) => s.id === sessionId);
  const canBypass = currentSession?.skipPermissions ?? false;
  const currentPermissionMode = sessionId ? (permissionModes.get(sessionId) || 'normal') : 'normal';

  // Shift+Tab cycles permission mode in chat view
  // (In terminal view, the raw escape code reaches the PTY directly)
  const cyclePermissionRef = useRef<(() => void) | null>(null);
  const cyclePermission = useCallback(() => {
    if (!sessionId) return;
    const cycle: PermissionMode[] = canBypass
      ? ['normal', 'auto-accept', 'plan', 'bypass']
      : ['normal', 'auto-accept', 'plan'];
    const idx = cycle.indexOf(currentPermissionMode);
    const next = cycle[(idx + 1) % cycle.length];
    setPermissionModes((prev) => new Map(prev).set(sessionId, next));
    // Send Shift+Tab to the PTY to cycle Claude Code's permission mode
    window.claude.session.sendInput(sessionId, '\x1b[Z');
  }, [sessionId, canBypass, currentPermissionMode]);
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

  // Parse announcement
  const announcementText = statusData.announcement?.message || null;

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
      {/* Main area — relative so bottom-float chrome can position against it */}
      <div className="flex-1 flex flex-col overflow-hidden relative">
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
                onCloseSession={(id) => setClosePromptFor(id)}
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
                announcement={announcementText}
                settingsOpen={settingsOpen}
                onToggleSettings={() => setSettingsOpen(prev => !prev)}
                settingsBadge={settingsBadge}
                sessionStatuses={sessionStatuses}
                onResumeSession={handleResumeSession}
                onOpenResumeBrowser={() => setResumeRequested(true)}
                defaultModel={sessionDefaults.model}
                defaultSkipPermissions={sessionDefaults.skipPermissions}
                defaultProjectFolder={sessionDefaults.projectFolder}
                geminiEnabled={sessionDefaults.geminiEnabled}
              />
            </div>
            <div
              className="flex-1 overflow-hidden relative"
              style={getPlatform() === 'android' && currentViewMode === 'terminal' ? { backgroundColor: 'transparent', pointerEvents: 'none' } : undefined}
            >
              {sessions.map((s) => (
                <React.Fragment key={s.id}>
                  <ErrorBoundary name="Chat">
                    <ChatView
                      sessionId={s.id}
                      visible={s.id === sessionId && (viewModes.get(s.id) || 'chat') === 'chat'}
                      resumeInfo={resumeInfo}
                    />
                  </ErrorBoundary>
                  {/* On Android, native Termux handles terminal — don't mount xterm.js */}
                  {getPlatform() !== 'android' && (
                    <ErrorBoundary name="Terminal">
                      <TerminalView
                        sessionId={s.id}
                        visible={s.id === sessionId && (viewModes.get(s.id) || 'chat') === 'terminal'}
                      />
                    </ErrorBoundary>
                  )}
                </React.Fragment>
              ))}
              {/* Initializing overlay — shown before Claude is ready.
                 z-10: must stay below glassmorphism chrome (z-20) so header/bottom bars remain accessible */}
              {!sessionInitialized && sessionId && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-canvas">
                  <ThemeMascot variant="idle" fallback={AppIcon} className="w-16 h-16 text-fg-dim mb-6 animate-pulse" />
                  <p className="text-sm text-fg-dim font-medium">Initializing session...</p>
                </div>
              )}
              {trustGateActive && sessionId && <TrustGate sessionId={sessionId} />}
              {currentViewMode === 'chat' && (
                <CommandDrawer
                  open={drawerOpen}
                  searchMode={drawerSearchMode}
                  externalFilter={drawerFilter}
                  onSelect={handleSelectSkill}
                  onClose={handleCloseDrawer}
                  onOpenManager={() => setMarketplaceTab('installed')}
                  onOpenMarketplace={() => setMarketplaceTab('skills')}
                />
              )}
              {isTerminalTouch && sessionId && (
                <TerminalScrollButtons sessionId={sessionId} />
              )}
            </div>
            {/* Always mounted so draft text survives chat↔terminal switches.
               inert disables focus/keyboard/paste when hidden so keystrokes
               reach xterm instead of the buried textarea. */}
              <div ref={bottomBarRef} className={`chrome-wrapper bg-canvas${currentViewMode === 'chat' ? ' bottom-float' : ''}`} {...(currentViewMode !== 'chat' && getPlatform() === 'electron' ? { inert: true, style: { position: 'absolute', width: 0, height: 0, overflow: 'hidden' } as React.CSSProperties } : {})}>
                {isTerminalTouch && sessionId && (
                  <TerminalToolbar sessionId={sessionId} />
                )}
                <ChatInputBar ref={inputBarRef} sessionId={sessionId} view={currentViewMode} onOpenDrawer={handleOpenDrawer} onCloseDrawer={handleCloseDrawer} onDrawerSearch={setDrawerFilter} disabled={trustGateActive || !sessionInitialized} minimal={isTerminalTouch} onResumeCommand={() => setResumeRequested(true)} getUsageSnapshot={getUsageSnapshot} onOpenPreferences={() => setPreferencesOpen(true)} onToast={(msg) => { setToast(msg); setTimeout(() => setToast(null), 3000); }} getSessionState={(sid) => chatStateMapRef.current.get(sid)} onOpenModelPicker={() => setModelPickerOpen(true)} />
                <StatusBar
                  statusData={{
                    usage: statusData.usage,
                    updateStatus: statusData.updateStatus,
                    contextPercent: sessionId ? (statusData.contextMap[sessionId] ?? null) : null,
                    gitBranch: sessionId ? (statusData.gitBranchMap[sessionId] ?? null) : null,
                    sessionStats: sessionId ? (statusData.sessionStatsMap[sessionId] ?? null) : null,
                    syncStatus: statusData.syncStatus,
                    syncWarnings: statusData.syncWarnings,
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
                  model={model}
                  onCycleModel={cycleModel}
                  permissionMode={currentPermissionMode}
                  onCyclePermission={cyclePermission}
                  fast={fastMode}
                  effort={effortLevel}
                  onOpenModelPicker={() => setModelPickerOpen(true)}
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
                <div className="w-full rounded-lg bg-panel border border-edge p-3 flex flex-col gap-2">
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
                    className="w-full px-8 py-2 text-base font-medium rounded-lg bg-accent text-on-accent hover:brightness-110 transition-colors"
                  >
                    New Session
                  </button>
                  <button
                    onClick={() => setResumeRequested(true)}
                    className="w-full px-6 py-2 rounded-lg bg-inset hover:bg-edge text-fg-dim hover:text-fg transition-colors flex items-center justify-center gap-1.5"
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
        onOpenThemeMarketplace={() => { setSettingsOpen(false); setMarketplaceTab('themes'); }}
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
          // Small delay so the view switch happens before input lands
          setTimeout(() => window.claude.session.sendInput(sessionId, '/config\r'), 50);
        }}
      />
      <ModelPickerPopup
        open={modelPickerOpen}
        onClose={() => setModelPickerOpen(false)}
        sessionId={sessionId}
        currentModel={model}
        onSelectModel={(m) => {
          // Reuse the existing cycle plumbing but with an explicit target.
          // pendingModel + setModel + PTY send matches the cycleModel flow.
          setModel(m);
          setPendingModel(m);
          (window.claude as any).model?.setPreference(m);
          if (sessionId) {
            window.claude.session.sendInput(sessionId, `/model ${m}\r`);
          }
        }}
      />
      {/* Unified marketplace modal — replaces old Marketplace + ThemeMarketplace + SkillManager */}
      {marketplaceTab && (
        <Marketplace
          onClose={() => setMarketplaceTab(null)}
          initialTab={marketplaceTab}
          onOpenShareSheet={(id) => setShareSkillId(id)}
          onOpenEditor={(id) => setEditorSkillId(id)}
        />
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
const ChatInputBar = React.forwardRef<InputBarHandle, { sessionId: string; view?: ViewMode; onOpenDrawer: (searchMode: boolean) => void; onCloseDrawer?: () => void; onDrawerSearch?: (query: string) => void; disabled?: boolean; minimal?: boolean; onResumeCommand?: () => void; getUsageSnapshot?: (sessionId: string) => UsageSnapshot | null; onOpenPreferences?: () => void; onToast?: (msg: string) => void; getSessionState?: (sessionId: string) => SessionChatState | undefined; onOpenModelPicker?: () => void }>(
  function ChatInputBar({ sessionId, view, onOpenDrawer, onCloseDrawer, onDrawerSearch, disabled, minimal, onResumeCommand, getUsageSnapshot, onOpenPreferences, onToast, getSessionState, onOpenModelPicker }, ref) {
    return <InputBar ref={ref} sessionId={sessionId} view={view} onOpenDrawer={onOpenDrawer} onCloseDrawer={onCloseDrawer} onDrawerSearch={onDrawerSearch} disabled={disabled} minimal={minimal} onResumeCommand={onResumeCommand} getUsageSnapshot={getUsageSnapshot} onOpenPreferences={onOpenPreferences} onToast={onToast} getSessionState={getSessionState} onOpenModelPicker={onOpenModelPicker} />;
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

export default function App() {
  return (
    // Root boundary catches provider-level crashes that sub-tree boundaries can't.
    // Uses inline styles only — no theme tokens, no context — so it renders even
    // when ThemeProvider itself is the thing that crashed.
    <RootErrorBoundary>
      <ThemeProvider>
        <ThemeBg />
        <ThemeEffects />
        <SkillProvider>
          <GameProvider>
            <ChatProvider>
              <AppInner />
            </ChatProvider>
          </GameProvider>
        </SkillProvider>
      </ThemeProvider>
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
            DestinCode failed to start
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
