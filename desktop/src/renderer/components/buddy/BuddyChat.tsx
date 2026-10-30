import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionInfo } from '../../../shared/types';
import type { SessionStatusColor } from '../StatusDot';
import InputBar from '../InputBar';
import ChatView from '../ChatView';
import SessionStrip from '../SessionStrip';
import { ArtifactProvider, createArtifactStore } from '../../state/ArtifactContext';
import { useAttentionSummary } from '../../hooks/useAttentionSummary';
import { useSessionDefaults } from '../../hooks/useSessionDefaults';
import { useChromeMeasurements } from '../../hooks/useChromeMeasurements';
import { buildSessionCreateArgs } from '../../../shared/session-create-args';
import { BuddyWelcome } from './BuddyWelcome';
import { useBuddyFeed } from './useBuddyFeed';
import { CompactSurfaceContext, type CompactSurface } from '../../state/compact-surface-context';
import { Toast } from '../ui';
import { useBlockedSend } from '../../hooks/useBlockedSend';
import type { BlockedSendToast } from '../../utils/blocked-send-toast';
import { useChatStore } from '../../state/chat-context';
import type { SessionChatState } from '../../state/chat-types';

/**
 * The buddy's chat window: the MAIN window's chat, hosted small (buddy rebuild, 2026-10-25 —
 * buddy-rebuild-questions#Q-2 "a small main chat"). Every piece a user sees is the main window's own:
 * SessionStrip at the top (its dots, its All sessions menu — #Q-4, #S-1), ChatView in the middle
 * (question and permission cards, warnings with buttons, scroll-back, skill cards — #Q-3) and the
 * InputBar at the bottom. Only the window's own concerns live here: which session it shows, the feed
 * that fills this window's chat store (useBuddyFeed — in the main window App does that), and the
 * compact density, which is CSS scoped to html[data-mode="buddy-chat"] (buddy.css). The buddy's actions
 * (screenshot, size, open YouCoded, hide) are NOT in here: they are the panel beside the mascot (BuddyBarApp,
 * buddy-rebuild-review5#C-5).
 */
export function BuddyChat({ tools = 'summary', shown = true, opened = 0 }: { tools?: CompactSurface['tools']; /** false while main has the window hidden */ shown?: boolean; /** how many times the chat has been opened */ opened?: number } = {}) {
  // The main window's cards draw themselves for the small window under this (state/compact-surface-context.ts).
  // 'summary' — one row for a reply's steps and files — was chosen (buddy-rebuild-review2#D-1, review4#A-2).
  const compactSurface = useMemo<CompactSurface>(() => ({ tools }), [tools]);
  const [viewedSession, setViewedSession] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  // WHY the shared hook (#S-1): it PULLS the summary on mount, then listens. The buddy used to only
  // listen, so every dot was grey until something changed somewhere.
  const summary = useAttentionSummary();
  // The saved new-session defaults (model, project folder, skip permissions), the same hook the main window reads — the
  // buddy's New session form started from the app's built-in values instead (buddy-rebuild-tryit2#U-3). Re-read on
  // every open: the window regains focus then, and the hook asks again on focus.
  const sessionDefaults = useSessionDefaults(false);
  // Every close of the window starts the session strip afresh, so a menu, a half-filled New session form or an open
  // folder list never greets the next open (buddy-rebuild-tryit2#U-3). The chat itself is NOT rebuilt (BuddyChatApp).
  // `opened` counts the opens (BuddyChatApp, from main's buddy:chat-state cue — the one signal every platform sends).
  // This window's own files-and-previews store, created once (ChatView and SessionStrip read it, as in the main window).
  const [artifactStore] = useState(() => createArtifactStore());

  useBuddyFeed(viewedSession);

  const select = useCallback((sid: string | null) => {
    setViewedSession(sid);
    if (sid) void window.claude.buddy?.setSession?.(sid);
  }, []);

  // Every session in every window — the buddy owns none, it can show any.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const dir = await window.claude.detach.getDirectory();
      if (cancelled || !dir?.windows) return;
      const all: SessionInfo[] = [];
      const seen = new Set<string>();
      for (const entry of dir.windows) {
        for (const s of (entry.sessions ?? [])) {
          if (seen.has(s.id)) continue;
          seen.add(s.id);
          all.push(s);
        }
      }
      setSessions(all);
    };
    void load();
    const unsub = window.claude.detach.onDirectoryUpdated(load);
    return () => { cancelled = true; unsub?.(); };
  }, []);

  // Which session to show: the one main remembers for the buddy, else the first there is.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const sid = await window.claude.buddy?.getViewedSession?.() ?? null;
      if (!cancelled && sid) setViewedSession(sid);
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    // The remembered session is gone (closed, or never set): move to another, or to the welcome screen.
    if (viewedSession && sessions.some((s) => s.id === viewedSession)) return;
    if (viewedSession && sessions.length === 0) return; // directory not loaded yet
    const next = sessions[0]?.id ?? null;
    if (next !== viewedSession) select(next);
  }, [sessions, viewedSession, select]);

  // The main window's colours, keyed for SessionStrip.
  const statuses = useMemo(() => {
    const m = new Map<string, SessionStatusColor>();
    for (const [id, s] of Object.entries(summary.perSession)) m.set(id, (s?.status ?? 'gray') as SessionStatusColor);
    return m;
  }, [summary]);

  const createSession = useCallback(async (cwd: string, dangerous: boolean, model: string, provider?: 'claude' | 'native', _newWindow?: boolean, binding?: { providerId: string; modelId: string }, preset?: string) => {
    const info = await (window.claude.session.create as any)(buildSessionCreateArgs({
      name: 'New Session', cwd, runtime: provider === 'native' ? 'native' : 'claude', model, skipPermissions: dangerous, binding, preset,
    }));
    if (info?.id) select(info.id);
  }, [select]);
  const closeSession = useCallback((id: string) => { void window.claude.session.destroy(id); }, []);
  // Resuming happens in the main window's Resume browser — the buddy has no room for it.
  const openResume = useCallback(() => { void window.claude.buddy?.openMain?.(); }, []);

  // Close the chat window on Escape — unless something inside (a menu, a card) used it first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) window.claude.buddy?.toggleChat?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const headerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // The same --top/--bottom-chrome-height the main window publishes, so ChatView's messages scroll
  // behind the header and the message box exactly as they do there.
  useChromeMeasurements(headerRef, bottomRef, viewedSession, 'chat');

  const current = sessions.find((s) => s.id === viewedSession);

  // A send the session cannot take right now — Claude Code showing a permission, question or plan menu — is refused
  // with the main window's own toast and "Send anyway", instead of typing into the menu and confirming whatever it
  // highlights (card 85a; buddy-rebuild-questions#Q-8). The same gate and the same words as App.tsx; the buddy has no
  // terminal view of its own, so the toast's terminal action opens the main window instead.
  const chatStore = useChatStore();
  const chatStateRef = useRef<Map<string, SessionChatState>>(chatStore.getState());
  useEffect(() => {
    chatStateRef.current = chatStore.getState();
    return chatStore.subscribeAll(() => { chatStateRef.current = chatStore.getState(); });
  }, [chatStore]);
  const [toast, setToast] = useState<BlockedSendToast | null>(null);
  const { showBlockedSend } = useBlockedSend({
    chatState: chatStateRef,
    showToast: setToast,
    openTerminal: () => { void window.claude.buddy?.openMain?.(); },
  });
  const onSendBlocked = useCallback((retry: () => void, block: Parameters<typeof showBlockedSend>[1]) => {
    if (viewedSession) showBlockedSend(viewedSession, block, retry);
  }, [viewedSession, showBlockedSend]);
  const getSessionState = useCallback((sid: string) => chatStateRef.current.get(sid), []);

  if (!viewedSession) {
    return (
      <div className="buddy-chat-shell" style={{ height: '100vh', padding: '12px 10px' }}>
        <BuddyWelcome onSessionCreated={(sid) => select(sid)} />
      </div>
    );
  }

  return (
    <ArtifactProvider store={artifactStore}>
      <CompactSurfaceContext.Provider value={compactSurface}>
      <div className="buddy-chat-shell relative h-screen overflow-hidden">
        <div ref={headerRef} className="buddy-chat-header">
          <div className="header-bar">
            <SessionStrip
              key={opened}
              sessions={sessions as any}
              defaultModel={sessionDefaults.model}
              defaultStartModel={sessionDefaults.startModel}
              defaultSkipPermissions={sessionDefaults.skipPermissions}
              defaultProjectFolder={sessionDefaults.projectFolder}
              activeSessionId={viewedSession}
              onSelectSession={select}
              onCreateSession={createSession}
              onCloseSession={closeSession}
              sessionStatuses={statuses}
              onOpenResumeBrowser={openResume}
              viewer
            />
          </div>
        </div>
        <ChatView
          sessionId={viewedSession}
          // While the window is hidden ChatView pauses its read of the chat (it catches up on show) — hidden means idle.
          visible={shown}
          sessionActive
          compact
          cwd={current?.cwd}
          provider={(current as any)?.provider}
          model={(current as any)?.model}
          providerType={(current as any)?.providerType}
        />
        <div ref={bottomRef} className="chrome-wrapper chrome-wrapper--bottom bottom-float buddy-chat-bottom">
          <InputBar sessionId={viewedSession} compact onSendBlocked={onSendBlocked} getSessionState={getSessionState} />
        </div>
        {toast && <Toast message={toast.message} durationMs={toast.durationMs} actions={toast.actions} onDismiss={() => setToast(null)} />}
      </div>
      </CompactSurfaceContext.Provider>
    </ArtifactProvider>
  );
}
