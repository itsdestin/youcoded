// usePageAssistant — which chat a page's assistant shows, and starting, reopening and switching it (pages-finish
// step 3; build design youcoded-dev/docs/active/specs/2026-11-05-pages-step3-build.md, section E).
//
// Opening a page's chat shows, in order: its chat still running; else its last saved Claude Code chat, reopened;
// else a new chat. A page chat is an ordinary session (it is in the session strip and Resume), created with the
// page's id so main gives it the page's opening note and windows add it without switching to it.
//
// WHY a native chat that has ended is not reopened here: reopening a native conversation must ask which model
// to run it on (Destin's ruling, see App.handleResumeSession: never launch a binding nobody chose on this
// device), and that ask is the main window's. Earlier chats opens such a chat there instead.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PageAssistantChat, PageSummary, PagesBridge } from '../../../shared/pages-types';
import { buildSessionCreateArgs } from '../../../shared/session-create-args';
import { RESUMING_CLAUDE } from '../../../shared/session-title';
import { runLeaseTakeoverGate } from '../../state/resume-lease-gate';
import { defaultRuntime, loadLastBinding } from '../RuntimeBinding';

export type PageAssistantStatus = 'idle' | 'starting' | 'ready' | 'failed';

const HELD_ELSEWHERE = 'This chat is open on another device. Start a new chat here, or close it there first.';
const NO_MODEL = 'Choose a model in Assistant settings first: new chats use the one you picked last.';
const START_FAILED = 'The chat could not be started.';

function bridge(): PagesBridge | undefined {
  return (window as unknown as { claude?: { pages?: PagesBridge } }).claude?.pages;
}

/** The chat each page showed last, for this window's run: reopening a page's chat is instant, with no lookup. */
const shownChat = new Map<string, string>();

export function usePageAssistant(page: PageSummary | null) {
  const pageId = page?.id ?? null;
  const [sessionId, setSessionId] = useState<string | null>(() => (pageId ? shownChat.get(pageId) ?? null : null));
  const [status, setStatus] = useState<PageAssistantStatus>(() => (sessionId ? 'ready' : 'idle'));
  const [error, setError] = useState<string | null>(null);
  const [chats, setChats] = useState<PageAssistantChat[]>([]);
  // A slow start for page A must not land on page B: every async step checks it is still the same request.
  const epoch = useRef(0);

  useEffect(() => {
    epoch.current += 1;
    const known = pageId ? shownChat.get(pageId) ?? null : null;
    setSessionId(known);
    setStatus(known ? 'ready' : 'idle');
    setError(null);
    setChats([]);
  }, [pageId]);

  const show = useCallback((id: string) => {
    if (pageId) shownChat.set(pageId, id);
    setSessionId(id);
    setStatus('ready');
    setError(null);
  }, [pageId]);

  const fail = useCallback((message: string) => { setStatus('failed'); setError(message); }, []);

  const refreshChats = useCallback(async (): Promise<PageAssistantChat[]> => {
    if (!pageId) return [];
    const list = (await bridge()?.assistantChats?.(pageId).catch(() => [])) ?? [];
    setChats(list);
    return list;
  }, [pageId]);

  const startNew = useCallback(async () => {
    if (!pageId) return;
    const mine = ++epoch.current;
    setStatus('starting');
    setError(null);
    try {
      const defaults = await window.claude.defaults?.get?.().catch(() => null);
      const runtime = defaultRuntime();
      const binding = runtime === 'native' ? loadLastBinding() : null;
      if (runtime === 'native' && !binding) { if (mine === epoch.current) fail(NO_MODEL); return; }
      const info = await window.claude.session.create(buildSessionCreateArgs({
        name: 'New Session',
        // Main starts a new page chat in the page's project folder whatever is sent here.
        cwd: '',
        runtime,
        model: defaults?.model,
        skipPermissions: defaults?.skipPermissions ?? false,
        binding,
        pageId,
      }));
      if (mine !== epoch.current) return;
      if (info && 'id' in info && info.id) show(info.id);
      else fail(START_FAILED);
    } catch (e) {
      if (mine === epoch.current) fail(e instanceof Error && e.message ? e.message : START_FAILED);
    }
  }, [pageId, show, fail]);

  /** Reopen a saved Claude Code chat of this page in the panel. */
  const resume = useCallback(async (chat: PageAssistantChat) => {
    if (!pageId || !chat.conversationId) return;
    const mine = ++epoch.current;
    setStatus('starting');
    setError(null);
    let held = false;
    try {
      const defaults = await window.claude.defaults?.get?.().catch(() => null);
      const info = await runLeaseTakeoverGate({
        claudeSessionId: chat.conversationId,
        // WHY never take over from here: moving a chat off another device is a decision the main window's
        // Resume asks about at full size; the panel says where the chat is and offers a new one instead.
        askTakeover: async () => { held = true; return false; },
        onWarn: () => {},
        open: () => window.claude.session.create(buildSessionCreateArgs({
          name: RESUMING_CLAUDE,
          cwd: chat.cwd,
          runtime: 'claude',
          skipPermissions: defaults?.skipPermissions ?? false,
          resumeSessionId: chat.conversationId,
          pageId,
        })),
      });
      if (mine !== epoch.current) return;
      if (info?.id) show(info.id);
      else fail(held ? HELD_ELSEWHERE : START_FAILED);
    } catch (e) {
      if (mine === epoch.current) fail(e instanceof Error && e.message ? e.message : START_FAILED);
    }
  }, [pageId, show, fail]);

  /** Show a chat picked from Earlier chats. A running one is shown at once; a saved Claude Code one is reopened
   *  here; a saved native one opens in the main window, which asks which model to run it on. */
  const openChat = useCallback(async (chat: PageAssistantChat) => {
    if (chat.live && chat.sessionId) { epoch.current += 1; show(chat.sessionId); return; }
    if (chat.provider === 'claude') { await resume(chat); return; }
    const rows = await window.claude.session.browse().catch(() => []) as Array<{ sessionId: string; projectSlug?: string; projectPath?: string; provider?: string }>;
    const row = rows.find((r) => r.sessionId === chat.conversationId);
    if (row?.projectSlug && row.projectPath) {
      window.dispatchEvent(new CustomEvent('youcoded:resume-session', { detail: {
        claudeSessionId: row.sessionId, projectSlug: row.projectSlug, projectPath: row.projectPath, provider: row.provider,
      } }));
    } else fail('This chat could not be found.');
  }, [show, resume, fail]);

  /** Open the page's chat: the one still running, else its last saved Claude Code chat, else a new one. */
  const open = useCallback(async () => {
    if (!pageId || status === 'starting') return;
    if (sessionId && status === 'ready') return;
    const list = await refreshChats();
    const live = list.find((c) => c.live && c.sessionId);
    if (live?.sessionId) { show(live.sessionId); return; }
    const last = list[0];
    if (last?.conversationId && last.provider === 'claude') { await resume(last); return; }
    await startNew();
  }, [pageId, status, sessionId, refreshChats, show, resume, startNew]);

  /** The chat shown was closed (its tab, or it ended): the next open finds the page's chats again. */
  const forget = useCallback((id: string) => {
    if (pageId && shownChat.get(pageId) === id) shownChat.delete(pageId);
    setSessionId((cur) => (cur === id ? null : cur));
    setStatus((s) => (s === 'ready' ? 'idle' : s));
  }, [pageId]);

  return { sessionId, status, error, chats, refreshChats, open, startNew, openChat, forget };
}
