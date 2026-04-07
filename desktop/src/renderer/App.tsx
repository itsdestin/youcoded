import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import TerminalView from './components/TerminalView';
import ChatView from './components/ChatView';
import HeaderBar from './components/HeaderBar';
import InputBar, { type InputBarHandle } from './components/InputBar';
import StatusBar from './components/StatusBar';
import { MODELS, type ModelAlias } from './components/StatusBar';
import ErrorBoundary from './components/ErrorBoundary';
import GamePanel from './components/game/GamePanel';
import { ChatProvider, useChatDispatch, useChatState, useChatStateMap } from './state/chat-context';
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
import Marketplace from './components/Marketplace';
import ThemeMarketplace from './components/ThemeMarketplace';
import ThemeShareSheet from './components/ThemeShareSheet';
import SkillManager from './components/SkillManager';
import SkillEditor from './components/SkillEditor';
import ShareSheet from './components/ShareSheet';
import CreatePromptSheet from './components/CreatePromptSheet';
import type { SkillEntry, PermissionMode } from '../shared/types';
import FirstRunView from './components/FirstRunView';
import { getPlatform, isRemoteMode, onConnectionModeChange } from './platform';
import type { SessionStatusColor } from './components/StatusDot';
import { ThemeProvider, useTheme } from './state/theme-context';
import { SkillProvider } from './state/skill-context';
import ThemeEffects from './components/ThemeEffects';

type ViewMode = 'chat' | 'terminal';

// --- Completion sound (Web Audio API) ---
const SOUND_STORAGE_KEY = 'destincode-sound-muted';
const SOUND_VOLUME_KEY = 'destincode-sound-volume';

function isSoundMuted(): boolean {
  try { return localStorage.getItem(SOUND_STORAGE_KEY) === '1'; } catch { return false; }
}

function getSoundVolume(): number {
  try {
    const v = parseFloat(localStorage.getItem(SOUND_VOLUME_KEY) || '0.3');
    return isNaN(v) ? 0.3 : Math.max(0, Math.min(1, v));
  } catch { return 0.3; }
}

function playCompletionSound() {
  if (isSoundMuted()) return;
  try {
    const ctx = new AudioContext();
    const vol = getSoundVolume();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);

    // Two-tone chime: C5 then E5
    const freqs = [523.25, 659.25];
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + i * 0.12);
      osc.stop(ctx.currentTime + i * 0.12 + 0.3);
    });

    // Clean up after playback
    setTimeout(() => ctx.close(), 1000);
  } catch { /* audio not available */ }
}

interface StatusDataState {
  usage: any;
  announcement: any;
  updateStatus: any;
  model: string | null;
  contextMap: Record<string, number>;
  syncStatus: string | null;
  syncWarnings: string | null;
}

function AppInner() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  const [viewModes, setViewModes] = useState<Map<string, ViewMode>>(new Map());
  const [statusData, setStatusData] = useState<StatusDataState>({
    usage: null, announcement: null, updateStatus: null,
    model: null, contextMap: {},
    syncStatus: null, syncWarnings: null,
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
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  // Track which sessions the user has "seen" (switched to after activity completed)
  const [viewedSessions, setViewedSessions] = useState<Set<string>>(new Set());
  const [resumeInfo, setResumeInfo] = useState<Map<string, { claudeSessionId: string; projectSlug: string }>>(new Map());
  const [resumeRequested, setResumeRequested] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  const [themeMarketplaceOpen, setThemeMarketplaceOpen] = useState(false);
  const [publishThemeSlug, setPublishThemeSlug] = useState<string | null>(null);
  const [editorSkillId, setEditorSkillId] = useState<string | null>(null);
  const [shareSkillId, setShareSkillId] = useState<string | null>(null);
  const [createPromptOpen, setCreatePromptOpen] = useState(false);
  const [isFirstRun, setIsFirstRun] = useState<boolean | null>(null); // null = loading
  const handleFirstRunComplete = useCallback(() => setIsFirstRun(false), []);

  const [model, setModel] = useState<ModelAlias>('sonnet');
  const [pendingModel, setPendingModel] = useState<ModelAlias | null>(null);
  const consecutiveFailures = useRef(0);
  const [toast, setToast] = useState<string | null>(null);
  const [sessionDefaults, setSessionDefaults] = useState({ skipPermissions: false, model: 'sonnet', projectFolder: '' });

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
        // Single pass, no temporary array allocation — hot path during streaming
        let hasAwaiting = false;
        let hasRunning = false;
        for (const t of chatState.toolCalls.values()) {
          if (t.status === 'awaiting-approval') hasAwaiting = true;
          else if (t.status === 'running') hasRunning = true;
          if (hasAwaiting) break; // awaiting takes priority in the status logic
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
      setViewModes((prev) => prev.has(info.id) ? prev : new Map(prev).set(info.id, 'chat'));
      setPermissionModes((prev) => prev.has(info.id) ? prev : new Map(prev).set(info.id, info.permissionMode || 'normal'));
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
      // Play completion sound on Stop events
      if (event.type === 'Stop') {
        playCompletionSound();
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
          break;
      }
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
        contextMap: data.contextMap || prev.contextMap,
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
      if (uiActionHandler) window.claude.off('ui:action:received', uiActionHandler);
      if (promptShowHandler) window.claude.off('prompt:show', promptShowHandler);
      if (promptDismissHandler) window.claude.off('prompt:dismiss', promptDismissHandler);
      if (promptCompleteHandler) window.claude.off('prompt:complete', promptCompleteHandler);
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

  const cycleModel = useCallback(() => {
    const idx = MODELS.indexOf(model);
    const next = MODELS[(idx + 1) % MODELS.length];
    setModel(next);
    setPendingModel(next);
    if (sessionId) {
      window.claude.session.sendInput(sessionId, `/model ${next}\r`);
    }
  }, [model, sessionId]);

  // Verify model switch via transcript events
  useEffect(() => {
    if (!pendingModel) return;
    const handler = (window.claude.on as any).transcriptEvent?.((event: any) => {
      if (!event || event.type !== 'assistant-text' || !event.data?.model) return;
      if (event.sessionId !== sessionId) return;

      const actualModel = event.data.model as string;
      const baseKey = (k: string) => k.replace(/\[.*\]/, '');
      const matches = actualModel.includes(baseKey(pendingModel));
      if (matches) {
        setPendingModel(null);
        consecutiveFailures.current = 0;
        (window.claude as any).model?.setPreference(pendingModel);
      } else {
        const actual = MODELS.find(m => actualModel.includes(baseKey(m)));
        if (actual) setModel(actual);
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
    return handler;
  }, [pendingModel, sessionId]);

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
      dispatch({
        type: 'USER_PROMPT',
        sessionId,
        content: skill.prompt,
        timestamp: Date.now(),
      });
      window.claude.session.sendInput(sessionId, skill.prompt + '\r');
    },
    [sessionId, dispatch],
  );

  const createSession = useCallback(async (cwd: string, dangerous: boolean, sessionModel?: string) => {
    const m = sessionModel || model;
    // Update the active model to match what was chosen in the form
    if (sessionModel && MODELS.includes(sessionModel as any)) {
      setModel(sessionModel as ModelAlias);
    }
    await (window.claude.session.create as any)({
      name: 'New Session',
      cwd,
      skipPermissions: dangerous,
      model: m,
    });
  }, [model]);

  const handleResumeSession = useCallback(async (claudeSessionId: string, projectSlug: string, resumeModel?: string, resumeDangerous?: boolean) => {
    const slugToPath = (s: string) => {
      if (/^[A-Z]--/.test(s)) return s.replace(/^([A-Z])--/, '$1:\\').replace(/-/g, '\\');
      return s.replace(/-/g, '/');
    };
    const cwd = slugToPath(projectSlug);
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
      // On Android, tell the native side to switch views
      if (getPlatform() === 'android') {
        (window as any).claude?.remote?.broadcastAction?.({ action: 'switch-view', mode });
      }
    },
    [sessionId],
  );

  const currentSession = sessions.find((s) => s.id === sessionId);
  const canBypass = currentSession?.skipPermissions ?? false;
  const currentPermissionMode = sessionId ? (permissionModes.get(sessionId) || 'normal') : 'normal';

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
      {/* Main area */}
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
                onCloseSession={(id) => window.claude.session.destroy(id)}
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
              {/* Initializing overlay — shown before Claude is ready */}
              {!sessionInitialized && sessionId && (
                <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-canvas">
                  <ThemeMascot variant="idle" fallback={AppIcon} className="w-16 h-16 text-fg-dim mb-6 animate-pulse" />
                  <p className="text-sm text-fg-dim font-medium">Initializing session...</p>
                </div>
              )}
              {trustGateActive && sessionId && <TrustGate sessionId={sessionId} />}
              {currentViewMode === 'chat' && (
                <CommandDrawer
                  open={drawerOpen}
                  searchMode={drawerSearchMode}
                  onSelect={handleSelectSkill}
                  onClose={handleCloseDrawer}
                  onOpenManager={() => setManagerOpen(true)}
                  onOpenMarketplace={() => setMarketplaceOpen(true)}
                />
              )}
              {isTerminalTouch && sessionId && (
                <TerminalScrollButtons sessionId={sessionId} />
              )}
            </div>
            {(currentViewMode === 'chat' || getPlatform() !== 'electron') && (
              <div ref={bottomBarRef} className="chrome-wrapper bg-canvas">
                {isTerminalTouch && sessionId && (
                  <TerminalToolbar sessionId={sessionId} />
                )}
                <ChatInputBar ref={inputBarRef} sessionId={sessionId} onOpenDrawer={handleOpenDrawer} onCloseDrawer={handleCloseDrawer} onDrawerSearch={setDrawerFilter} disabled={trustGateActive || !sessionInitialized} minimal={isTerminalTouch} onResumeCommand={() => setResumeRequested(true)} />
                <StatusBar
                  statusData={{
                    usage: statusData.usage,
                    updateStatus: statusData.updateStatus,
                    contextPercent: sessionId ? (statusData.contextMap[sessionId] ?? null) : null,
                    syncStatus: statusData.syncStatus,
                    syncWarnings: statusData.syncWarnings,
                  }}
                  onRunSync={!trustGateActive && sessionId ? () => {
                    dispatch({ type: 'USER_PROMPT', sessionId, content: '/sync', timestamp: Date.now() });
                    window.claude.session.sendInput(sessionId, '/sync\r');
                  } : undefined}
                  model={model}
                  onCycleModel={cycleModel}
                  permissionMode={currentPermissionMode}
                  onCyclePermission={cyclePermission}
                />
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-3">
            <p className="text-xl text-fg-muted">No Active Session</p>
            <ThemeMascot variant="welcome" fallback={WelcomeAppIcon} className="w-36 h-36 text-fg-dim" />
            <div className="flex flex-col items-center gap-2 mt-1">
              <button
                onClick={() => createSession('', false)}
                className="px-8 py-2 text-base font-medium rounded-lg bg-accent text-on-accent hover:brightness-110 transition-colors"
              >
                New Session
              </button>
              <button
                onClick={() => createSession('', true)}
                className="px-6 py-1 rounded-lg bg-red-600/40 hover:bg-red-600/60 text-red-200 transition-colors flex flex-col items-center"
              >
                <span className="text-sm font-medium leading-none">New Session</span>
                <span className="text-[10px] text-red-300/70 font-normal leading-tight">Dangerous Mode</span>
              </button>
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
        onClose={() => setSettingsOpen(false)}
        onSendInput={(text) => {
          if (sessionId) {
            const claude = (window as any).claude;
            claude.session.sendInput(sessionId, text + '\r');
          }
        }}
        hasActiveSession={!!sessionId}
        onOpenThemeMarketplace={() => { setSettingsOpen(false); setThemeMarketplaceOpen(true); }}
        onPublishTheme={(slug) => { setSettingsOpen(false); setPublishThemeSlug(slug); }}
      />
      <ResumeBrowser
        open={resumeRequested}
        onClose={() => setResumeRequested(false)}
        onResume={handleResumeSession}
        defaultModel={sessionDefaults.model}
        defaultSkipPermissions={sessionDefaults.skipPermissions}
      />
      {marketplaceOpen && (
        <Marketplace onClose={() => setMarketplaceOpen(false)} />
      )}
      {themeMarketplaceOpen && (
        <ThemeMarketplace onClose={() => setThemeMarketplaceOpen(false)} />
      )}
      {publishThemeSlug && (
        <ThemeShareSheet themeSlug={publishThemeSlug} onClose={() => setPublishThemeSlug(null)} />
      )}
      {managerOpen && (
        <SkillManager
          onClose={() => setManagerOpen(false)}
          onOpenMarketplace={() => { setManagerOpen(false); setMarketplaceOpen(true); }}
          onOpenShareSheet={(id) => setShareSkillId(id)}
          onOpenEditor={(id) => setEditorSkillId(id)}
          onOpenCreatePrompt={() => setCreatePromptOpen(true)}
        />
      )}
      {editorSkillId && (
        <SkillEditor skillId={editorSkillId} onClose={() => setEditorSkillId(null)} />
      )}
      {shareSkillId && (
        <ShareSheet skillId={shareSkillId} onClose={() => setShareSkillId(null)} />
      )}
      {createPromptOpen && (
        <CreatePromptSheet onClose={() => setCreatePromptOpen(false)} />
      )}
      {toast && (
        <div className="fixed bottom-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-panel border border-edge text-sm text-fg shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

const ChatInputBar = React.forwardRef<InputBarHandle, { sessionId: string; onOpenDrawer: (searchMode: boolean) => void; onCloseDrawer?: () => void; onDrawerSearch?: (query: string) => void; disabled?: boolean; minimal?: boolean; onResumeCommand?: () => void }>(
  function ChatInputBar({ sessionId, onOpenDrawer, onCloseDrawer, onDrawerSearch, disabled, minimal, onResumeCommand }, ref) {
    return <InputBar ref={ref} sessionId={sessionId} onOpenDrawer={onOpenDrawer} onCloseDrawer={onCloseDrawer} onDrawerSearch={onDrawerSearch} disabled={disabled} minimal={minimal} onResumeCommand={onResumeCommand} />;
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
  );
}
