"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = App;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = __importStar(require("react"));
const TerminalView_1 = __importDefault(require("./components/TerminalView"));
const ChatView_1 = __importDefault(require("./components/ChatView"));
const HeaderBar_1 = __importDefault(require("./components/HeaderBar"));
const InputBar_1 = __importDefault(require("./components/InputBar"));
const StatusBar_1 = __importDefault(require("./components/StatusBar"));
const ErrorBoundary_1 = __importDefault(require("./components/ErrorBoundary"));
const GamePanel_1 = __importDefault(require("./components/game/GamePanel"));
const chat_context_1 = require("./state/chat-context");
const game_context_1 = require("./state/game-context");
const hook_dispatcher_1 = require("./state/hook-dispatcher");
const usePromptDetector_1 = require("./hooks/usePromptDetector");
const usePartyLobby_1 = require("./hooks/usePartyLobby");
const usePartyGame_1 = require("./hooks/usePartyGame");
const Icons_1 = require("./components/Icons");
const CommandDrawer_1 = __importDefault(require("./components/CommandDrawer"));
const TrustGate_1 = __importStar(require("./components/TrustGate"));
const SettingsPanel_1 = __importDefault(require("./components/SettingsPanel"));
const ResumeBrowser_1 = __importDefault(require("./components/ResumeBrowser"));
const platform_1 = require("./platform");
function AppInner() {
    const [sessionId, setSessionId] = (0, react_1.useState)(null);
    const [sessions, setSessions] = (0, react_1.useState)([]);
    const [viewModes, setViewModes] = (0, react_1.useState)(new Map());
    const [statusData, setStatusData] = (0, react_1.useState)({
        usage: null, announcement: null, updateStatus: null,
        model: null, contextPercent: null,
        syncStatus: null, syncWarnings: null,
    });
    const [permissionModes, setPermissionModes] = (0, react_1.useState)(new Map());
    // Sessions that have received their first hook event (Claude is initialized).
    // Until this fires, show an "Initializing" overlay to prevent premature input.
    const [initializedSessions, setInitializedSessions] = (0, react_1.useState)(new Set());
    const [drawerOpen, setDrawerOpen] = (0, react_1.useState)(false);
    const [drawerSearchMode, setDrawerSearchMode] = (0, react_1.useState)(false);
    const [settingsOpen, setSettingsOpen] = (0, react_1.useState)(false);
    const [settingsBadge, setSettingsBadge] = (0, react_1.useState)(false);
    const [skills, setSkills] = (0, react_1.useState)([]);
    // Track which sessions the user has "seen" (switched to after activity completed)
    const [viewedSessions, setViewedSessions] = (0, react_1.useState)(new Set());
    const [resumeInfo, setResumeInfo] = (0, react_1.useState)(new Map());
    const [resumeRequested, setResumeRequested] = (0, react_1.useState)(false);
    const [model, setModel] = (0, react_1.useState)('sonnet');
    const [pendingModel, setPendingModel] = (0, react_1.useState)(null);
    const consecutiveFailures = (0, react_1.useRef)(0);
    const [toast, setToast] = (0, react_1.useState)(null);
    const MODELS_LIST = ['sonnet', 'opus', 'haiku'];
    (0, usePromptDetector_1.usePromptDetector)();
    const dispatch = (0, chat_context_1.useChatDispatch)();
    const chatStateMap = (0, chat_context_1.useChatStateMap)();
    const gameState = (0, game_context_1.useGameState)();
    const gameDispatch = (0, game_context_1.useGameDispatch)();
    const lobby = (0, usePartyLobby_1.usePartyLobby)();
    const game = (0, usePartyGame_1.usePartyGame)(lobby.updateStatus, lobby.challengePlayer);
    const gameConnection = (0, react_1.useMemo)(() => ({
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
    const sessionStatusesRef = (0, react_1.useRef)(new Map());
    const sessionStatuses = (0, react_1.useMemo)(() => {
        const newStatuses = new Map();
        let changed = false;
        for (const s of sessions) {
            const chatState = chatStateMap.get(s.id);
            if (!chatState) {
                newStatuses.set(s.id, 'gray');
            }
            else {
                const hasAwaiting = [...chatState.toolCalls.values()].some(t => t.status === 'awaiting-approval');
                const hasRunning = [...chatState.toolCalls.values()].some(t => t.status === 'running');
                const status = hasAwaiting
                    ? 'red'
                    : (chatState.isThinking || hasRunning)
                        ? 'green'
                        : (chatState.timeline.length > 0 && !viewedSessions.has(s.id) && s.id !== sessionId)
                            ? 'blue'
                            : 'gray';
                newStatuses.set(s.id, status);
            }
            const prev = sessionStatusesRef.current.get(s.id);
            if (prev !== newStatuses.get(s.id))
                changed = true;
        }
        if (!changed && newStatuses.size === sessionStatusesRef.current.size) {
            return sessionStatusesRef.current;
        }
        sessionStatusesRef.current = newStatuses;
        return newStatuses;
    }, [sessions, chatStateMap, viewedSessions, sessionId]);
    (0, react_1.useEffect)(() => {
        const createdHandler = window.claude.on.sessionCreated((info) => {
            setSessions((prev) => {
                // Deduplicate — replay buffers resend session:created for existing sessions
                if (prev.some((s) => s.id === info.id))
                    return prev;
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
                    if (curr !== id)
                        return curr;
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
                if (!prev.has(id))
                    return prev;
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
        });
        const hookHandler = window.claude.on.hookEvent((event) => {
            const action = (0, hook_dispatcher_1.hookEventToAction)(event);
            if (action) {
                dispatch(action);
            }
            // First hook event for a session = Claude is initialized
            if (event.sessionId) {
                setInitializedSessions((prev) => {
                    if (prev.has(event.sessionId))
                        return prev;
                    const next = new Set(prev);
                    next.add(event.sessionId);
                    // Broadcast so other devices transition out of Initializing too
                    window.claude?.remote?.broadcastAction({ type: '_SESSION_INITIALIZED', sessionId: event.sessionId });
                    return next;
                });
            }
        });
        const transcriptHandler = window.claude.on.transcriptEvent?.((event) => {
            if (!event?.type || !event?.sessionId)
                return;
            switch (event.type) {
                case 'user-message':
                    dispatch({
                        type: 'TRANSCRIPT_USER_MESSAGE',
                        sessionId: event.sessionId,
                        uuid: event.uuid,
                        text: event.data.text,
                        timestamp: event.timestamp,
                    });
                    break;
                case 'assistant-text':
                    dispatch({
                        type: 'TRANSCRIPT_ASSISTANT_TEXT',
                        sessionId: event.sessionId,
                        uuid: event.uuid,
                        text: event.data.text,
                        timestamp: event.timestamp,
                    });
                    break;
                case 'tool-use':
                    dispatch({
                        type: 'TRANSCRIPT_TOOL_USE',
                        sessionId: event.sessionId,
                        uuid: event.uuid,
                        toolUseId: event.data.toolUseId,
                        toolName: event.data.toolName,
                        toolInput: event.data.toolInput || {},
                    });
                    break;
                case 'tool-result':
                    dispatch({
                        type: 'TRANSCRIPT_TOOL_RESULT',
                        sessionId: event.sessionId,
                        uuid: event.uuid,
                        toolUseId: event.data.toolUseId,
                        result: event.data.toolResult || '',
                        isError: event.data.isError || false,
                    });
                    break;
                case 'turn-complete':
                    dispatch({
                        type: 'TRANSCRIPT_TURN_COMPLETE',
                        sessionId: event.sessionId,
                        uuid: event.uuid,
                        timestamp: event.timestamp,
                    });
                    break;
            }
        });
        const renamedHandler = window.claude.on.sessionRenamed((sid, name) => {
            setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, name } : s)));
        });
        // Sync permission mode by reading Claude Code's mode indicator from PTY output.
        // Same approach as the mobile app — just check for mode text in the output.
        const ptyModeHandler = window.claude.on.ptyOutput((sid, data) => {
            const lower = data.toLowerCase();
            let mode = null;
            if (lower.includes('bypass permissions on'))
                mode = 'bypass';
            else if (lower.includes('accept edits on'))
                mode = 'auto-accept';
            else if (lower.includes('plan mode on'))
                mode = 'plan';
            else if (lower.includes('bypass permissions off')
                || lower.includes('accept edits off')
                || lower.includes('plan mode off'))
                mode = 'normal';
            if (mode) {
                setPermissionModes((prev) => {
                    if (prev.get(sid) === mode)
                        return prev;
                    return new Map(prev).set(sid, mode);
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
            }));
        });
        // UI action sync — receive actions broadcast from other devices
        const uiActionHandler = window.claude.on.uiAction?.((action) => {
            if (!action)
                return;
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
            if (!action.type)
                return;
            // Handle session initialization sync (not a chat reducer action)
            if (action.type === '_SESSION_INITIALIZED' && action.sessionId) {
                setInitializedSessions((prev) => {
                    if (prev.has(action.sessionId))
                        return prev;
                    const next = new Set(prev);
                    next.add(action.sessionId);
                    return next;
                });
                return;
            }
            dispatch(action);
        });
        // Prompt events — Android bridge broadcasts Ink menu prompts detected from PTY screen
        const promptShowHandler = window.claude.on.promptShow?.((payload) => {
            // A prompt arriving proves the session is alive — dismiss "Initializing" overlay
            setInitializedSessions((prev) => {
                if (prev.has(payload.sessionId))
                    return prev;
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
        const promptDismissHandler = window.claude.on.promptDismiss?.((payload) => {
            dispatch({
                type: 'DISMISS_PROMPT',
                sessionId: payload.sessionId,
                promptId: payload.promptId,
            });
        });
        const promptCompleteHandler = window.claude.on.promptComplete?.((payload) => {
            dispatch({
                type: 'COMPLETE_PROMPT',
                sessionId: payload.sessionId,
                promptId: payload.promptId,
                selection: payload.selection || '',
            });
        });
        return () => {
            window.claude.off('session:created', createdHandler);
            window.claude.off('session:destroyed', destroyedHandler);
            window.claude.off('hook:event', hookHandler);
            window.claude.off('session:renamed', renamedHandler);
            window.claude.off('pty:output', ptyModeHandler);
            window.claude.off('status:data', statusHandler);
            if (transcriptHandler)
                window.claude.off('transcript:event', transcriptHandler);
            if (uiActionHandler)
                window.claude.off('ui:action:received', uiActionHandler);
            if (promptShowHandler)
                window.claude.off('prompt:show', promptShowHandler);
            if (promptDismissHandler)
                window.claude.off('prompt:dismiss', promptDismissHandler);
            if (promptCompleteHandler)
                window.claude.off('prompt:complete', promptCompleteHandler);
        };
    }, [dispatch]);
    // Fetch session list on mount — catches sessions that existed before event handlers were registered
    // (e.g., remote browser reconnecting after the replay buffer events already fired)
    (0, react_1.useEffect)(() => {
        window.claude.session.list().then((list) => {
            if (!list || list.length === 0)
                return;
            setSessions((prev) => {
                const existingIds = new Set(prev.map((s) => s.id));
                const newSessions = list.filter((s) => !existingIds.has(s.id));
                if (newSessions.length === 0)
                    return prev;
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
                for (const s of list)
                    next.add(s.id);
                return next;
            });
        }).catch(() => { });
    }, [dispatch]);
    // Load skills once on mount
    (0, react_1.useEffect)(() => {
        window.claude.skills.list().then((list) => {
            // Inject built-in resume skill at the top
            const resumeSkill = {
                id: '_resume',
                displayName: 'Resume Session',
                description: 'Resume a previous conversation',
                category: 'personal',
                prompt: '',
                source: 'destinclaude',
            };
            setSkills([resumeSkill, ...list]);
        }).catch(console.error);
    }, []);
    // Flush and reload session state when connection mode changes (local ↔ remote).
    // On Android, switching to remote means the WebSocket now talks to the desktop server —
    // all local session state is stale and must be replaced with the desktop's sessions.
    (0, react_1.useEffect)(() => {
        const unsub = (0, platform_1.onConnectionModeChange)((mode) => {
            // Flush all session state
            setSessions([]);
            setSessionId(null);
            setViewModes(new Map());
            setPermissionModes(new Map());
            setInitializedSessions(new Set());
            setViewedSessions(new Set());
            dispatch({ type: 'RESET' });
            // Reload session list from the new server
            window.claude.session.list().then((list) => {
                if (!list || list.length === 0)
                    return;
                setSessions(list);
                for (const s of list) {
                    dispatch({ type: 'SESSION_INIT', sessionId: s.id });
                    setViewModes((vm) => new Map(vm).set(s.id, 'chat'));
                    setPermissionModes((pm) => new Map(pm).set(s.id, s.permissionMode || 'normal'));
                }
                setSessionId(list[0].id);
                // Mark existing sessions as initialized (already running)
                setInitializedSessions(new Set(list.map((s) => s.id)));
            }).catch(() => { });
        });
        return unsub;
    }, [dispatch]);
    // Mark session as viewed when the user switches to it
    (0, react_1.useEffect)(() => {
        if (sessionId) {
            setViewedSessions((prev) => {
                if (prev.has(sessionId))
                    return prev;
                const next = new Set(prev);
                next.add(sessionId);
                return next;
            });
        }
    }, [sessionId]);
    // Load model preference on mount
    (0, react_1.useEffect)(() => {
        if (window.claude.model) {
            window.claude.model.getPreference().then((m) => {
                if (MODELS_LIST.includes(m)) setModel(m);
            });
        }
    }, []);
    // Clear viewed status when a session starts thinking (user sent a new message).
    // Early-exit: skip iteration if no sessions are currently thinking.
    (0, react_1.useEffect)(() => {
        let anyThinking = false;
        for (const s of sessions) {
            const chatState = chatStateMap.get(s.id);
            if (chatState?.isThinking) {
                anyThinking = true;
                break;
            }
        }
        if (!anyThinking)
            return;
        for (const s of sessions) {
            const chatState = chatStateMap.get(s.id);
            if (chatState?.isThinking) {
                setViewedSessions((prev) => {
                    if (!prev.has(s.id))
                        return prev;
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
    (0, react_1.useEffect)(() => {
        const claude = window.claude;
        if (!claude?.remote)
            return;
        const check = () => {
            claude.remote.getClientCount().then((count) => {
                setSettingsBadge(count === 0);
            }).catch(() => { });
        };
        check();
        const interval = setInterval(check, 10000);
        return () => clearInterval(interval);
    }, []);
    const handleOpenDrawer = (0, react_1.useCallback)((searchMode) => {
        setDrawerSearchMode(searchMode);
        setDrawerOpen(true);
    }, []);
    const handleSelectSkill = (0, react_1.useCallback)((skill) => {
        if (skill.id === '_resume') {
            setDrawerOpen(false);
            setResumeRequested(true);
            return;
        }
        if (!sessionId)
            return;
        setDrawerOpen(false);
        dispatch({
            type: 'USER_PROMPT',
            sessionId,
            content: skill.prompt,
            timestamp: Date.now(),
        });
        window.claude.session.sendInput(sessionId, skill.prompt + '\r');
    }, [sessionId, dispatch]);
    const createSession = (0, react_1.useCallback)(async (cwd, dangerous) => {
        await window.claude.session.create({
            name: 'New Session',
            cwd,
            skipPermissions: dangerous,
        });
    }, []);
    const handleResumeSession = (0, react_1.useCallback)(async (claudeSessionId, projectSlug) => {
        const slugToPath = (s) => {
            if (/^[A-Z]--/.test(s))
                return s.replace(/^([A-Z])--/, '$1:\\').replace(/-/g, '\\');
            return s.replace(/-/g, '/');
        };
        const cwd = slugToPath(projectSlug);
        // Pass --resume flag so Claude Code boots directly into the resumed session
        const newSession = await window.claude.session.create({
            name: 'Resuming...',
            cwd,
            skipPermissions: false,
            resumeSessionId: claudeSessionId,
        });
        if (!newSession?.id)
            return;
        setResumeInfo((prev) => new Map(prev).set(newSession.id, { claudeSessionId, projectSlug }));
        // Load recent history into chat view
        try {
            const messages = await window.claude.session.loadHistory(claudeSessionId, projectSlug, 10, false);
            if (messages.length > 0) {
                dispatch({
                    type: 'HISTORY_LOADED',
                    sessionId: newSession.id,
                    messages,
                    hasMore: true,
                });
            }
        }
        catch (err) {
            console.error('Failed to load history:', err);
        }
    }, [dispatch]);
    const currentViewMode = sessionId ? (viewModes.get(sessionId) || 'chat') : 'chat';
    const handleToggleView = (0, react_1.useCallback)((mode) => {
        if (!sessionId)
            return;
        setViewModes((prev) => new Map(prev).set(sessionId, mode));
        // On Android, tell the native side to switch views
        if ((0, platform_1.getPlatform)() === 'android') {
            window.claude?.remote?.broadcastAction?.({ action: 'switch-view', mode });
        }
    }, [sessionId]);
    const currentSession = sessions.find((s) => s.id === sessionId);
    const canBypass = currentSession?.skipPermissions ?? false;
    const currentPermissionMode = sessionId ? (permissionModes.get(sessionId) || 'normal') : 'normal';
    const cyclePermission = (0, react_1.useCallback)(() => {
        if (!sessionId)
            return;
        const cycle = canBypass
            ? ['normal', 'auto-accept', 'plan', 'bypass']
            : ['normal', 'auto-accept', 'plan'];
        const idx = cycle.indexOf(currentPermissionMode);
        const next = cycle[(idx + 1) % cycle.length];
        setPermissionModes((prev) => new Map(prev).set(sessionId, next));
        // Send Shift+Tab to the PTY to cycle Claude Code's permission mode
        window.claude.session.sendInput(sessionId, '\x1b[Z');
    }, [sessionId, canBypass, currentPermissionMode]);
    const cycleModel = (0, react_1.useCallback)(() => {
        const idx = MODELS_LIST.indexOf(model);
        const next = MODELS_LIST[(idx + 1) % MODELS_LIST.length];
        setModel(next);
        setPendingModel(next);
        if (sessionId && window.claude.model) {
            window.claude.model.switch(sessionId, next);
        }
    }, [model, sessionId]);
    // Verify model switch via transcript events
    (0, react_1.useEffect)(() => {
        if (!pendingModel) return;
        const handler = window.claude.on.transcriptEvent?.((event) => {
            if (!event || event.type !== 'assistant-text' || !event.data?.model) return;
            if (event.sessionId !== sessionId) return;
            const actualModel = event.data.model;
            const matches = actualModel.includes(pendingModel);
            if (matches) {
                setPendingModel(null);
                consecutiveFailures.current = 0;
                if (window.claude.model) window.claude.model.setPreference(pendingModel);
            } else {
                const actual = MODELS_LIST.find(m => actualModel.includes(m));
                if (actual) setModel(actual);
                consecutiveFailures.current += 1;
                setPendingModel(null);
                if (consecutiveFailures.current >= 2) {
                    setToast("Model switch failed again. Ask Claude to diagnose with /model, or report a bug.");
                } else {
                    setToast("Couldn't switch to " + pendingModel.charAt(0).toUpperCase() + pendingModel.slice(1));
                }
                setTimeout(() => setToast(null), 4000);
            }
        });
        return handler;
    }, [pendingModel, sessionId]);
    const trustGateActive = (0, TrustGate_1.useTrustGateActive)(sessionId);
    // Once trust gate activates, permanently mark the session as initialized
    // so the "Initializing" overlay doesn't reappear after trust is completed
    // (there's a gap between trust completion and the first hook event).
    (0, react_1.useEffect)(() => {
        if (trustGateActive && sessionId) {
            setInitializedSessions((prev) => {
                if (prev.has(sessionId))
                    return prev;
                const next = new Set(prev);
                next.add(sessionId);
                window.claude?.remote?.broadcastAction({ type: '_SESSION_INITIALIZED', sessionId });
                return next;
            });
        }
    }, [trustGateActive, sessionId]);
    const sessionInitialized = sessionId ? initializedSessions.has(sessionId) : true;
    // Parse announcement
    const announcementText = statusData.announcement?.message || null;
    return ((0, jsx_runtime_1.jsxs)("div", { className: "flex w-screen h-full bg-gray-950 text-gray-200", children: [(0, jsx_runtime_1.jsx)("div", { className: "flex-1 flex flex-col overflow-hidden", children: sessions.length > 0 && sessionId && currentSession ? ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(HeaderBar_1.default, { sessions: sessions, activeSessionId: sessionId, onSelectSession: setSessionId, onCreateSession: createSession, onCloseSession: (id) => window.claude.session.destroy(id), onReorderSessions: (fromIndex, toIndex) => {
                                setSessions(prev => {
                                    const next = [...prev];
                                    const [moved] = next.splice(fromIndex, 1);
                                    next.splice(toIndex, 0, moved);
                                    return next;
                                });
                            }, viewMode: currentViewMode, onToggleView: handleToggleView, gamePanelOpen: gameState.panelOpen, onToggleGamePanel: () => gameDispatch({ type: 'TOGGLE_PANEL' }), gameConnected: gameState.connected, challengePending: gameState.challengeFrom !== null, permissionMode: currentPermissionMode, onCyclePermission: cyclePermission, announcement: announcementText, settingsOpen: settingsOpen, onToggleSettings: () => setSettingsOpen(prev => !prev), settingsBadge: settingsBadge, sessionStatuses: sessionStatuses, onResumeSession: handleResumeSession, onOpenResumeBrowser: () => setResumeRequested(true) }), (0, jsx_runtime_1.jsxs)("div", { className: "flex-1 overflow-hidden relative", children: [sessions.map((s) => ((0, jsx_runtime_1.jsxs)(react_1.default.Fragment, { children: [(0, jsx_runtime_1.jsx)(ErrorBoundary_1.default, { name: "Chat", children: (0, jsx_runtime_1.jsx)(ChatView_1.default, { sessionId: s.id, visible: s.id === sessionId && (viewModes.get(s.id) || 'chat') === 'chat', resumeInfo: resumeInfo }) }), (0, platform_1.getPlatform)() !== 'android' && ((0, jsx_runtime_1.jsx)(ErrorBoundary_1.default, { name: "Terminal", children: (0, jsx_runtime_1.jsx)(TerminalView_1.default, { sessionId: s.id, visible: s.id === sessionId && (viewModes.get(s.id) || 'chat') === 'terminal' }) }))] }, s.id))), !sessionInitialized && sessionId && ((0, jsx_runtime_1.jsxs)("div", { className: "absolute inset-0 z-30 flex flex-col items-center justify-center bg-gray-950", children: [(0, jsx_runtime_1.jsx)(Icons_1.AppIcon, { className: "w-16 h-16 text-gray-400 mb-6 animate-pulse" }), (0, jsx_runtime_1.jsx)("p", { className: "text-sm text-gray-400 font-medium", children: "Initializing session..." })] })), trustGateActive && sessionId && (0, jsx_runtime_1.jsx)(TrustGate_1.default, { sessionId: sessionId })] }), currentViewMode === 'chat' && ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(ChatInputBar, { sessionId: sessionId, onOpenDrawer: handleOpenDrawer, disabled: trustGateActive || !sessionInitialized, onResumeCommand: () => setResumeRequested(true) }), (0, jsx_runtime_1.jsx)(CommandDrawer_1.default, { open: drawerOpen, searchMode: drawerSearchMode, skills: skills, onSelect: handleSelectSkill, onClose: () => setDrawerOpen(false) }), (0, jsx_runtime_1.jsx)(StatusBar_1.default, { statusData: {
                                        usage: statusData.usage,
                                        updateStatus: statusData.updateStatus,
                                        contextPercent: statusData.contextPercent,
                                        syncStatus: statusData.syncStatus,
                                        syncWarnings: statusData.syncWarnings,
                                    }, onRunSync: !trustGateActive && sessionId ? () => {
                                        dispatch({ type: 'USER_PROMPT', sessionId, content: '/sync', timestamp: Date.now() });
                                        window.claude.session.sendInput(sessionId, '/sync\r');
                                    } : undefined, model: model, onCycleModel: cycleModel })] }))] })) : ((0, jsx_runtime_1.jsxs)("div", { className: "flex-1 flex flex-col items-center justify-center gap-3", children: [(0, jsx_runtime_1.jsx)("p", { className: "text-xl text-gray-500", children: "No Active Session" }), (0, jsx_runtime_1.jsx)(Icons_1.WelcomeAppIcon, { className: "w-36 h-36 text-gray-400" }), (0, jsx_runtime_1.jsxs)("div", { className: "flex flex-col items-center gap-2 mt-1", children: [(0, jsx_runtime_1.jsx)("button", { onClick: () => createSession('', false), className: "px-8 py-2 text-base font-medium rounded-lg bg-gray-300 text-gray-950 hover:bg-gray-200 transition-colors", children: "New Session" }), (0, jsx_runtime_1.jsxs)("button", { onClick: () => createSession('', true), className: "px-6 py-1 rounded-lg bg-red-600/40 hover:bg-red-600/60 text-red-200 transition-colors flex flex-col items-center", children: [(0, jsx_runtime_1.jsx)("span", { className: "text-sm font-medium leading-none", children: "New Session" }), (0, jsx_runtime_1.jsx)("span", { className: "text-[10px] text-red-300/70 font-normal leading-tight", children: "Dangerous Mode" })] })] })] })) }), gameState.panelOpen && ((0, jsx_runtime_1.jsx)(ErrorBoundary_1.default, { name: "Game", children: (0, jsx_runtime_1.jsx)(GamePanel_1.default, { connection: gameConnection, incognito: lobby.incognito, onToggleIncognito: lobby.toggleIncognito }) })), (0, jsx_runtime_1.jsx)(SettingsPanel_1.default, { open: settingsOpen, onClose: () => setSettingsOpen(false), onSendInput: (text) => {
                    if (sessionId) {
                        const claude = window.claude;
                        claude.session.sendInput(sessionId, text + '\r');
                    }
                }, hasActiveSession: !!sessionId }), (0, jsx_runtime_1.jsx)(ResumeBrowser_1.default, { open: resumeRequested, onClose: () => setResumeRequested(false), onResume: handleResumeSession }), toast && ((0, jsx_runtime_1.jsx)("div", { className: "fixed bottom-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-200 shadow-lg", children: toast }))] }));
}
function ChatInputBar({ sessionId, onOpenDrawer, disabled, onResumeCommand }) {
    return (0, jsx_runtime_1.jsx)(InputBar_1.default, { sessionId: sessionId, onOpenDrawer: onOpenDrawer, disabled: disabled, onResumeCommand: onResumeCommand });
}
function App() {
    return ((0, jsx_runtime_1.jsx)(game_context_1.GameProvider, { children: (0, jsx_runtime_1.jsx)(chat_context_1.ChatProvider, { children: (0, jsx_runtime_1.jsx)(AppInner, {}) }) }));
}
