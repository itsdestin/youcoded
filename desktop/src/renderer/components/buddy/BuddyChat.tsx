import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionInfo } from '../../../shared/types';
import type { SessionStatusColor } from '../StatusDot';
import InputBar from '../InputBar';
import ChatView from '../ChatView';
import SessionStrip from '../SessionStrip';
import { ArtifactProvider, createArtifactStore } from '../../state/ArtifactContext';
import { useAttentionSummary } from '../../hooks/useAttentionSummary';
import { useChromeMeasurements } from '../../hooks/useChromeMeasurements';
import { buildSessionCreateArgs } from '../../../shared/session-create-args';
import { BuddyWelcome } from './BuddyWelcome';
import { useBuddyFeed } from './useBuddyFeed';
import { CaptureButton, OpenMainButton, HideBuddyButton } from './BuddyActions';

/** Where the buddy's three actions live (buddy-rebuild-questions#Q-5 — shown as pictures before choosing):
 *  'header' = icons beside the session strip; 'composer' = screenshot beside Attach, the other two in the header;
 *  'beside' = today's round buttons next to the mascot (their own window, BuddyBarApp), none in here. */
export type BuddyActionsAt = 'header' | 'composer' | 'beside';

/**
 * The buddy's chat window: the MAIN window's chat, hosted small (buddy rebuild, 2026-10-25 —
 * buddy-rebuild-questions#Q-2 "a small main chat"). Every piece a user sees is the main window's own:
 * SessionStrip at the top (its dots, its All sessions menu — #Q-4, #S-1), ChatView in the middle
 * (question and permission cards, warnings with buttons, scroll-back, skill cards — #Q-3) and the
 * InputBar at the bottom. Only the window's own concerns live here: which session it shows, the feed
 * that fills this window's chat store (useBuddyFeed — in the main window App does that), and the
 * compact density, which is CSS scoped to html[data-mode="buddy-chat"] (buddy.css).
 */
export function BuddyChat({ actionsAt = 'beside' }: { actionsAt?: BuddyActionsAt } = {}) {
  const [viewedSession, setViewedSession] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  // WHY the shared hook (#S-1): it PULLS the summary on mount, then listens. The buddy used to only
  // listen, so every dot was grey until something changed somewhere.
  const summary = useAttentionSummary();
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

  if (!viewedSession) {
    return (
      <div className="buddy-chat-shell" style={{ height: '100vh', padding: '12px 10px' }}>
        <BuddyWelcome onSessionCreated={(sid) => select(sid)} />
      </div>
    );
  }

  return (
    <ArtifactProvider store={artifactStore}>
      <div className="buddy-chat-shell relative h-screen overflow-hidden">
        <div ref={headerRef} className="buddy-chat-header">
          <div className="header-bar">
            <SessionStrip
              sessions={sessions as any}
              activeSessionId={viewedSession}
              onSelectSession={select}
              onCreateSession={createSession}
              onCloseSession={closeSession}
              sessionStatuses={statuses}
              onOpenResumeBrowser={openResume}
              viewer
            />
            {actionsAt !== 'beside' && (
              <div className="buddy-header-actions">
                {actionsAt === 'header' && <CaptureButton />}
                <OpenMainButton />
                <HideBuddyButton />
              </div>
            )}
          </div>
        </div>
        <ChatView
          sessionId={viewedSession}
          visible
          sessionActive
          compact
          cwd={current?.cwd}
          provider={(current as any)?.provider}
          model={(current as any)?.model}
          providerType={(current as any)?.providerType}
        />
        <div ref={bottomRef} className="chrome-wrapper chrome-wrapper--bottom bottom-float buddy-chat-bottom">
          <InputBar
            sessionId={viewedSession}
            compact
            extraTool={actionsAt === 'composer'
              ? <CaptureButton className="shrink-0 text-fg-dim hover:text-fg disabled:opacity-30 transition-colors" />
              : undefined}
          />
        </div>
      </div>
    </ArtifactProvider>
  );
}
