// A previewed past conversation — the Resume browser, the side drawer and the
// Projects page all show one through this pane. Reads one PAGE at a time
// through chatsearch:read and pages backwards as the reader scrolls up; there
// is deliberately no "load everything" (a 42 MB transcript would cross IPC and
// be rendered bubble by bubble, inside a 480px pane, on a phone).
//
// WHY a private chat reducer (2026-09-16): a page is the same transcript
// events a resumed chat pages its history with, and replaying them through
// chatReducer's own HISTORY_PAGE_LOADED is what makes the preview group tools,
// reasoning and messages exactly as the chat will once resumed. The state is
// LOCAL — never the app's chat store — because that store is serialized to
// remote browsers and read by every session-keyed hook; a preview is not a
// session.
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import PreviewTimeline from './PreviewTimeline';
import { ErrorState } from './ui/states';
import { BugReportPopup } from './development/BugReportPopup';
import type { ReportContext } from './development/ReportDesign';
import { chatReducer } from '../state/chat-reducer';
import { useEntryFolding } from '../hooks/use-entry-folding';
import type { ChatAction, ChatState } from '../state/chat-types';
import { COPY, previewSessionKey, type ChatsearchProvider } from '../../shared/chatsearch-refs';
import type { TranscriptPageResult } from '../../shared/types';

// Fix (2026-08-27): the conversation title for the right-click scaffold (A3)
// arrives as a `title` prop instead of being resolved a second time in here —
// every host already has it. Passing '' is fine: askPreviewContext
// (build-menu.ts) falls back to COPY.untitled when it's empty.
type Phase = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };

const RESET = { type: '__preview_reset' } as const;
function previewReducer(state: ChatState, action: ChatAction | typeof RESET): ChatState {
  return action.type === RESET.type ? new Map() : chatReducer(state, action as ChatAction);
}

export default function SessionPreviewPane({ provider, id, title, onSettled, projectSlug, backdrop = true }: {
  provider: ChatsearchProvider;
  id: string;
  title: string;
  /** Fired once a first load has SETTLED (ready or error) for this id. The
   *  Resume browser holds its arrival animation until this fires: a transcript
   *  is read off disk, and on a large one that is a second, so animating on the
   *  click played the whole arrival over a loading line and let the bubbles
   *  land afterwards — "chat bubbles in the preview feel like they pop in a
   *  second or so after the actual animation" (Destin, 2026-09-10). */
  onSettled?: (id: string) => void;
  /** The conversation's project folder slug, when the caller has it (a Resume
   *  list row does). Main then opens the file directly instead of looking the
   *  id up in the search index — see ChatsearchReadRequest.projectSlug. */
  projectSlug?: string;
  /** Paint the preview surface (`.preview-backdrop`, globals.css). A host
   *  that paints it over a larger area — the Resume browser's sheet, whose
   *  action card sits below this pane — passes false, so the two do not meet
   *  at a seam. */
  backdrop?: boolean;
}) {
  const key = previewSessionKey(id);
  const [chat, dispatch] = useReducer(previewReducer, undefined, () => new Map() as ChatState);
  const session = chat.get(key);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  // A failed older page reports its error HERE, at the top of the list,
  // instead of through `phase` — `phase` stays 'ready' so the messages already
  // on screen are never replaced by a full-pane error. An object, not a bare
  // string: `message` can legitimately be '' (no reason given), and a bare ''
  // is falsy, which would read a real failure as no failure.
  const [olderError, setOlderError] = useState<{ message: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Perf cycle 3, extended to previews: a distant entry renders as a same-
  // height spacer instead of its full body (use-entry-folding.ts) — this pane
  // gets slower the further back a read scrolls otherwise, same as the chat.
  // WHY always enabled (unlike ChatView's `!findOpen`): no find bar reaches a
  // preview pane — `ContentFindBar` only hosts in ChatView and the drawer's
  // own artifact branch, never here — so there is no DOM-walking search this
  // could ever need to suspend for.
  const folding = useEntryFolding(true, scrollRef);
  // Set when the first page lands: jump to the newest message once it is laid out.
  const jumpToEnd = useRef(false);
  // Distance from the BOTTOM, captured just before an older page is prepended,
  // so the message being read stays put while the content above it grows.
  const keepFromBottom = useRef<number | null>(null);

  // Generation token guarding every in-flight read. Bumped by every
  // loadNewest() call (mount, prop swap, or Retry); a response is applied only
  // if the token it captured is still current. WHY: this pane is reused for a
  // NEW conversation without unmounting (the drawer swaps provider/id in
  // place), and a late answer for the first must not land on the second.
  const genRef = useRef(0);

  // Opens BugReportPopup for a read failure with no reason given — both
  // "Report bug" and "Diagnose" land on this popup (docs/error-message-standards.md).
  const [reportContext, setReportContext] = useState<ReportContext | null>(null);

  const read = useCallback(async (before?: number): Promise<TranscriptPageResult> => {
    const req = {
      provider, id,
      ...(before === undefined ? {} : { before }),
      ...(projectSlug ? { projectSlug } : {}),
    };
    const res = await (window.claude as any).chatsearch.read(req);
    // WHY: never invent a cause for a failure nobody diagnosed. `res.error` is
    // the real reason when chatsearch:read supplied one — surfaced verbatim.
    // When it did not, `new Error(undefined)` has an EMPTY message, which the
    // render reads as "we don't know why" and answers with the general
    // Report-bug/Diagnose card. The workspace ast-grep rule
    // no-hardcoded-error-fallback guards this line; don't put a hardcoded
    // fallback cause back.
    if (!res?.ok) throw new Error(res?.error);
    // An answer with no event list is not a page. Treat it as an unexplained
    // failure (the general card) rather than letting the reducer throw on it.
    if (!Array.isArray(res.events)) throw new Error();
    return res as TranscriptPageResult;
  }, [provider, id, projectSlug]);

  // Held in a ref, not a dep: a caller that passes an inline arrow would
  // otherwise rebuild loadNewest on every one of ITS renders and re-read.
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  const loadNewest = useCallback(() => {
    const myGen = ++genRef.current;
    dispatch(RESET);
    setPhase({ kind: 'loading' });
    setOlderError(null);
    keepFromBottom.current = null;
    return read().then((page) => {
      if (genRef.current !== myGen) return; // superseded — see genRef above
      dispatch({ type: 'SESSION_INIT', sessionId: key });
      dispatch({ type: 'HISTORY_PAGE_LOADED', sessionId: key, events: page.events, cursor: page.cursor, hasMore: page.hasMore });
      jumpToEnd.current = true;
      setPhase({ kind: 'ready' });
      onSettledRef.current?.(id);
    }).catch((e) => {
      if (genRef.current !== myGen) return;
      // An error settles too: the card that says so should arrive the same way
      // a conversation does, rather than appearing without motion.
      onSettledRef.current?.(id);
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : '' });
    });
  }, [read, key, id]);

  useEffect(() => { void loadNewest(); }, [loadNewest]);

  const cursor = session?.history.cursor ?? null;
  const hasMore = !!session?.history.hasMore;
  const loadingOlder = !!session?.history.loading;

  const loadOlder = useCallback(async () => {
    if (!cursor || loadingOlder) return;
    const myGen = genRef.current; // captured, not bumped: a swap bumps it and invalidates this answer too
    // Announce FIRST: `history.loading` is the one-in-flight guard (the same
    // one ChatView's pager relies on), so a second trigger sees it set.
    dispatch({ type: 'HISTORY_PAGE_REQUESTED', sessionId: key });
    setOlderError(null);
    try {
      const page = await read(cursor.offset);
      if (genRef.current !== myGen) return;
      const el = scrollRef.current;
      keepFromBottom.current = el ? el.scrollHeight - el.scrollTop : null;
      dispatch({ type: 'HISTORY_PAGE_LOADED', sessionId: key, events: page.events, cursor: page.cursor, hasMore: page.hasMore });
    } catch (e) {
      if (genRef.current !== myGen) return;
      // Keeps the cursor, so Retry asks for this same older page.
      dispatch({ type: 'HISTORY_PAGE_FAILED', sessionId: key });
      setOlderError({ message: e instanceof Error ? e.message : '' });
    }
  }, [cursor, loadingOlder, read, key]);

  // Scroll-up paging, as in the chat: crossing the sentinel above the first
  // message loads the page before it. Not re-armed while an error is showing —
  // the sentinel would still be on screen and retry in a loop; Retry does it.
  useEffect(() => {
    if (!hasMore || loadingOlder || olderError || typeof IntersectionObserver === 'undefined') return;
    const el = sentinelRef.current;
    const root = scrollRef.current;
    if (!el || !root) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) void loadOlder(); },
      { root, rootMargin: '400px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadingOlder, olderError, loadOlder]);

  // Before paint, so neither the jump nor the prepend is ever SEEN moving.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (jumpToEnd.current) {
      jumpToEnd.current = false;
      el.scrollTop = el.scrollHeight;
    } else if (keepFromBottom.current !== null) {
      el.scrollTop = el.scrollHeight - keepFromBottom.current;
      keepFromBottom.current = null;
    }
  }, [chat, phase]);

  return (
    <div className={`relative flex h-full min-h-0 w-full min-w-0 flex-col${backdrop ? ' preview-backdrop' : ''}`}>
      {/* overflow-anchor: none — the prepend is anchored by hand above; the
          browser's own anchoring would move it a second time. */}
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto py-3" style={{ overflowAnchor: 'none' }}>
        {/* WHY: this pane deliberately has NO header/close of its own — each
            host's top bar supplies the title and the single close button (the
            "two X's" bug Destin flagged). The read-only/lane line still
            matters, so it is a quiet caption, not a control. */}
        <div className="mb-2 px-4 text-xs text-fg-muted">{COPY.paneSubtitle(provider)}</div>
        {phase.kind === 'loading' && <p className="px-4 text-sm text-fg-muted">{COPY.loading}</p>}
        {/* First load has nothing to show behind it, so a full-pane error is
            correct here. Two shapes per docs/error-message-standards.md:
            a reason → shown verbatim with Retry; none → say so, and offer
            Report bug / Diagnose instead of asserting a cause. */}
        {phase.kind === 'error' && (
          <div className="px-4">
            {phase.message
              ? <ErrorState mode="recoverable" message={`${COPY.errReadPrefix}${phase.message}`} onRetry={() => void loadNewest()} />
              : (
                <ErrorState
                  mode="general"
                  title={COPY.errReadUnknownTitle}
                  explainer={COPY.errReadUnknownExplainer}
                  onReportBug={() => setReportContext({ surface: 'Reading a past conversation' })}
                  onDiagnose={() => setReportContext({ surface: 'Reading a past conversation', diagnose: true })}
                />
              )}
          </div>
        )}
        {phase.kind === 'ready' && session && (
          // data-conversation-id/-title: what lets the right-click menu fire in
          // here (build-menu.ts widens its `.chat-scroll` gate to this
          // container) and name the conversation in "Ask about this".
          // w-full + min-w-0: .drawer-pane collapses to 100% on narrow screens
          // WITHOUT resizing children (.claude/rules/narrow-viewport.md).
          <div className="w-full min-w-0" data-conversation-id={id} data-conversation-title={title}>
            {olderError && (
              <div className="px-4 py-2">
                {olderError.message
                  ? <ErrorState mode="recoverable" variant="inline" message={`${COPY.errReadPrefix}${olderError.message}`} onRetry={() => void loadOlder()} />
                  : (
                    <ErrorState
                      mode="general"
                      title={COPY.errReadUnknownTitle}
                      explainer={COPY.errReadUnknownExplainer}
                      onReportBug={() => setReportContext({ surface: 'Loading older messages' })}
                      onDiagnose={() => setReportContext({ surface: 'Loading older messages', diagnose: true })}
                    />
                  )}
              </div>
            )}
            {hasMore && !olderError && <div ref={sentinelRef} data-history-sentinel className="h-px" aria-hidden="true" />}
            <PreviewTimeline state={session} sessionId={key} provider={provider} folding={folding} />
          </div>
        )}
      </div>
      <BugReportPopup open={!!reportContext} onClose={() => setReportContext(null)} context={reportContext ?? undefined} />
    </div>
  );
}
