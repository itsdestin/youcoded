import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useChatState, useChatDispatch } from '../state/chat-context';
import { HISTORY_EXPAND_PROMPT_ID, shouldRenderAssistantTurn } from '../state/chat-types';
import UserMessage from './UserMessage';
import SpecialistReportCard from './SpecialistReportCard';
import QueuedMessagesStrip from './QueuedMessagesStrip';
import AssistantTurnBubble from './AssistantTurnBubble';
import ToolCard from './ToolCard';
import PromptCard, { PromptCardButton } from './PromptCard';
import { sendPromptInput } from '../state/prompt-input';
import UsageCard from './UsageCard';
import SystemMarker from './SystemMarker';
import SkillInvocationCard from './SkillInvocationCard';
import { findArchiveBoundary } from '../state/archive-boundary';
import CompactingCard from './CompactingCard';
import CopyPicker from './CopyPicker';
import ThinkingIndicator from './ThinkingIndicator';
import AttentionBanner from './AttentionBanner';
import ModelLoadingBar from './ModelLoadingBar';
import { useObservedRef } from '../hooks/use-observed-ref';
import { useEntryFolding } from '../hooks/use-entry-folding';
import { SessionContextBanner } from './SessionContextBanner';
import SessionContextPopup from './SessionContextPopup';
import { useAttentionClassifier } from '../hooks/useAttentionClassifier';
import { useTheme } from '../state/theme-context';
import { useOneShotWindow } from '../hooks/use-one-shot-window';
import { useArtifact } from '../state/ArtifactContext';
import { SessionDrawer } from './SessionDrawer';
import { useActiveProject } from '../hooks/useActiveProject';
import { assistantName } from '../utils/assistant-name';
import { ContentFindBar } from './ContentFindBar';
import { isTypingTarget } from '../utils/is-typing-target';
import { useStickToBottom } from '../hooks/use-stick-to-bottom';
import { useSessionPreviewListener } from '../hooks/useSessionPreviewListener';
import { Tooltip } from './ui';

/** How long the prepend anchor keeps correcting for late-laying-out content
 *  (code blocks, images) before it lets go. Long enough for markdown to settle,
 *  short enough that it can never feel like the view is fighting you. Any user
 *  input releases it immediately. */
const ANCHOR_SETTLE_MS = 700;

/** Retry budget for a page main could not LOCATE (`unresolved`) — as opposed to
 *  a page that genuinely does not exist. The usual cause is a just-resumed
 *  Claude Code session whose SessionStart hook has not reported its transcript
 *  path yet, so the window that matters is a second or two; the cap exists so a
 *  transcript that never resolves cannot become a permanent background poll for
 *  as long as the conversation stays open. Doubling from 400ms, capped: 8
 *  attempts span ~13s. */
const UNRESOLVED_RETRY_MS = 400;
const UNRESOLVED_RETRY_MAX_MS = 3000;
const UNRESOLVED_RETRY_LIMIT = 8;

interface Props {
  sessionId: string;
  visible: boolean;
  /** True when this is the ACTIVE session, regardless of whether the user is
   *  currently on its chat or terminal tab. Distinct from `visible`, which is
   *  false for the active session's chat while its terminal is showing — see
   *  the root element's style block for why the two axes are hidden
   *  differently. */
  sessionActive: boolean;
  /** Working directory of the session — used to resolve the active project for the artifact drawer. */
  cwd?: string;
  /** Game pane content, when the multiplayer panel is open. Rendered in the
   *  framed-shell's right slot (same chrome as the artifact drawer). Only the
   *  active session's ChatView receives this — App passes null otherwise. When
   *  present it takes precedence over the artifact drawer in the right slot. */
  gamePane?: React.ReactNode;
  /** Runtime backend — forwarded to useAttentionClassifier so it
   *  short-circuits for sessions without a PTY (native harness). */
  provider?: 'claude' | 'native';
  /** Opens Settings → Model Providers. Threaded to the AttentionBanner so a
   *  provider-config error bubble (missing/disabled key) can jump the user
   *  straight to the fix. App owns Settings open-state, so it passes this down. */
  onOpenProviderSettings?: () => void;
  /** Plan-limit card's Switch Providers button (Sign in with ChatGPT): opens
   *  the model picker. The banner shows it only for a plan-limit error. */
  onSwitchProviders?: () => void;
  // Task 12 (docked strip, replaces Task 11's UserMessage-bubble affordances):
  // App owns the native:queue-remove invoke, the QUEUED_MESSAGE_REMOVED
  // dispatch, the toast state, and the input-bar ref the Edit flow refills —
  // none of which ChatView/QueuedMessagesStrip have access to, so these are
  // threaded straight through to the strip. sessionId is explicit (not
  // closed over) because App wires ONE pair of handlers shared across every
  // session's ChatView instance.
  onCancelQueued?: (sessionId: string, queueId: string) => void;
  onEditQueued?: (sessionId: string, queueId: string, text: string) => void;
}

export default function ChatView({ sessionId, visible, sessionActive, cwd, gamePane, provider, onOpenProviderSettings, onSwitchProviders, onCancelQueued, onEditQueued }: Props) {
  const state = useChatState(sessionId);
  const dispatch = useChatDispatch();
  const { showTimestamps, reducedEffects } = useTheme();

  // Motion on a SESSION SWITCH only.
  //  • `sessionActive`, not `visible` — `visible` also flips on the Ctrl+`
  //    chat↔terminal toggle, which is frequent; a switch is deliberate.
  //  • the trailing `&& sessionActive` makes it one-directional: the window
  //    also opens when the pane goes INACTIVE, and this is what suppresses it.
  //  • `reducedEffects` is folded in here rather than at the class, so the
  //    timer never even starts when the user has effects off.
  const arriving = useOneShotWindow(sessionActive) && sessionActive && !reducedEffects;
  // Artifact drawer state — read from ArtifactContext so ChatView reacts to
  // the drawer toggle without needing a prop threaded down from App.tsx.
  const { state: artifactState, dispatch: artifactDispatch } = useArtifact();
  // Preview cards (SessionRefActions, deep in the chat tree) ask for a past
  // conversation by event. Mounted here — not in SessionDrawer, which is
  // unmounted until it opens — so it hears the very first Preview click.
  // `sessionActive` gates which of the many mounted ChatViews actually
  // responds — see the WHY comment inside the hook (deliberately not
  // `visible`, which also depends on the chat/terminal toggle).
  useSessionPreviewListener(sessionId, sessionActive, artifactDispatch);
  // Drawer open/closed is per-session — read this session's flag (absent → closed).
  const drawerOpen = artifactState.drawerOpenBySession[sessionId] ?? false;
  const drawerExpanded = artifactState.drawerExpanded;
  // The game pane and artifact drawer share the framed-shell's right slot.
  // The game pane wins when both are somehow open (App also enforces mutual
  // exclusivity, so this is just a render-time safety net).
  const gameOpen = !!gamePane;
  // Either occupant means the right slot is in use → frame the chat accordingly.
  const rightPaneOpen = gameOpen || drawerOpen;

  // Resolve the active project when the artifact drawer opens — SessionDrawer's
  // in-place `save` IPC needs projectRoot/id/name. Lazy + non-blocking (renders
  // with empty strings until it resolves). Shared with TerminalRightSlot via
  // the useActiveProject hook so both resolve the same target.
  const activeProject = useActiveProject(cwd, drawerOpen);

  // Backfill this session's artifact list from the on-disk sidecar so the chat
  // artifact drawer AND inline filepath pills work immediately after an app
  // reload/restart. WHY: the live tracker (App.tsx) only APPENDS to
  // sessionArtifacts on NEW transcript Write/Edit events — without this, a reload
  // leaves the list empty until the next file write, so the drawer shows
  // "0 artifacts" and clicking an inline pill falls back to opening Project View
  // (its no-match behavior) instead of the file. listSession reads the sidecar at
  // cwd and filters by sessionId; the live tracker keeps it current afterward.
  // Not gated on drawerOpen — pills can be clicked without opening the drawer.
  useEffect(() => {
    if (!cwd || !sessionId) return;
    // Remember this session's cwd so the inline filepath pills (rendered deep in
    // markdown, without a cwd prop) can resolve a clicked path against the whole
    // project's artifacts.
    artifactDispatch({ type: 'SET_SESSION_CWD', sessionId, cwd });
    let cancelled = false;
    (window.claude as any).artifacts?.listSession?.(sessionId, cwd)
      .then((res: any) => {
        if (cancelled || !res?.ok || !Array.isArray(res.artifacts)) return;
        artifactDispatch({ type: 'SESSION_ARTIFACTS_LOADED', sessionId, artifacts: res.artifacts });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [cwd, sessionId, artifactDispatch]);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Auto-scroll ("stick to bottom"). See use-stick-to-bottom.ts for why this is
  // intent-driven instead of observer-driven — the old IntersectionObserver
  // could not see a scroll that a streaming delta undid in the same frame.
  const {
    atBottom, stickRef, scrollToBottom, stickToBottom, jumpToBottom, releaseStick,
  } = useStickToBottom(scrollContainerRef);
  // Task 12 review fix: refs for the --queued-strip-height measurement effect
  // below (chatRootRef = this component's OUTER root; queuedStripRef = the
  // strip's own rendered element).
  const chatRootRef = useRef<HTMLDivElement>(null);
  const queuedStripRef = useRef<HTMLDivElement>(null);
  const modelStatusRef = useRef<HTMLDivElement>(null);
  // Ctrl+F find-over-chat-history. Searches the message timeline (contentRef)
  // via the same CSS-Highlight ContentFindBar the artifact viewer uses.
  const [findOpen, setFindOpen] = useState(false);

  // "What the assistant was given" — opened ONLY from the strip above the
  // conversation. It used to open itself once per session; Destin chose "never"
  // on review-5 Q-1, with the note that the strip carries the warning state
  // instead. WHY that is the safer default even though the panel matters most on
  // a small model: a panel nobody asked for lands exactly when they were about to
  // type, and an interruption you did not ask for is the fastest way to teach
  // someone to dismiss a warning unread. The strip is amber when something was
  // cut, which is the signal that has to earn the click.
  const [contextPopupOpen, setContextPopupOpen] = useState(false);

  // Single pass — compute all tool status flags, memoized to avoid re-iterating
  // the Map on every render (toolCalls is a new ref on every reducer dispatch)
  const { hasAwaitingApproval, hasRunningTools, awaitingTools } = useMemo(() => {
    let hasAwaiting = false;
    let hasRunning = false;
    const awaiting: any[] = [];
    for (const id of state.activeTurnToolIds) {
      const t = state.toolCalls.get(id);
      if (!t) continue;
      if (t.status === 'awaiting-approval') {
        hasAwaiting = true;
        awaiting.push(t);
      } else if (t.status === 'running') {
        hasRunning = true;
      }
    }
    return { hasAwaitingApproval: hasAwaiting, hasRunningTools: hasRunning, awaitingTools: awaiting };
  }, [state.toolCalls, state.activeTurnToolIds]);



  // Find the most recent assistant turn's Anthropic request ID — surfaced on
  // the AttentionBanner only for session-died / error so users can cite it
  // when reporting an issue. Walk the timeline from the end for O(1) typical cost.
  const lastTurnRequestId = useMemo(() => {
    for (let i = state.timeline.length - 1; i >= 0; i--) {
      const entry = state.timeline[i];
      if (entry.kind === 'assistant-turn') {
        return state.assistantTurns.get(entry.turnId)?.anthropicRequestId ?? null;
      }
    }
    return null;
  }, [state.timeline, state.assistantTurns]);

  // Perf (cycle 1, N1): findArchiveBoundary walks the WHOLE timeline backwards
  // looking for the last /compact or /clear marker — and in the common
  // never-compacted case it walks all the way to index 0 and finds nothing. It
  // used to run inline in the render body, i.e. once per render, and a
  // streaming session renders once per delta. The timeline array's identity
  // only changes when an entry is appended (a delta updates assistantTurns,
  // not timeline), so memoising on it turns a once-per-token scan into a
  // once-per-entry scan. Pinned by tests/chatview-archive-boundary-memo.test.tsx.
  const archiveBoundary = useMemo(() => findArchiveBoundary(state.timeline), [state.timeline]);

  // PTY-buffer classifier drives the attention banner. Replaces the old
  // 30s thinking-timeout watchdog + TERMINAL_ACTIVITY heartbeat — the hook
  // reads the xterm buffer directly and decides 'ok' vs. 'stuck'/'shell-idle'/etc.
  useAttentionClassifier(sessionId, {
    isThinking: state.isThinking,
    hasRunningTools,
    hasAwaitingApproval,
    visible,
    currentAttentionState: state.attentionState,
    provider,
  });

  // Scroll to bottom on tab switch / mount. The follow-up ResizeObserver below
  // handles the chrome-height race (input bar can differ per session).
  useEffect(() => {
    if (!visible) return;
    const raf = requestAnimationFrame(stickToBottom);
    return () => cancelAnimationFrame(raf);
  }, [visible, stickToBottom]);

  // Fix: input bar height can differ between sessions (drafts, multi-line),
  // so --bottom-chrome-height changes right after tab switch. App's ResizeObserver
  // updates the CSS var asynchronously, which grows .chat-scroll's padding-bottom
  // AFTER we already scrolled — leaving the last message a few px behind the bar.
  // Re-snap to bottom whenever the chrome-wrapper resizes while stuck && visible.
  useEffect(() => {
    if (!visible) return;
    // Fix: target the BOTTOM chrome-wrapper (input bar) specifically — there are
    // two .chrome-wrapper elements in App.tsx (header + bottom), and plain
    // querySelector returns the first (header), whose height doesn't change per
    // session. The bottom bar is the one whose height varies with drafts/multi-line.
    const chrome = document.querySelector('.chrome-wrapper--bottom');
    if (!chrome) return;
    const observer = new ResizeObserver(() => {
      if (stickRef.current) scrollToBottom();
    });
    observer.observe(chrome);
    return () => observer.disconnect();
  }, [visible, scrollToBottom, stickRef]);

  // Auto-scroll when new content arrives and the view is still stuck to the
  // bottom. Keyed on the things that add content — an appended entry, the
  // thinking indicator — not on Map references, which change on every dispatch.
  // Fix: reads stickRef, NOT the atBottom state — a native session dispatches
  // one delta per streamed token, and the state value is a render behind, so a
  // scroll the user just made would be undone before React caught up.
  //
  // Perf (cycle 1, N2): state.lastActivityAt used to be a dep here. The reducer
  // re-stamps it on EVERY streamed delta (and on tool events, heartbeats, …),
  // and scrollToBottom reads scrollHeight — which, right after a commit that
  // dirtied the DOM, is a forced synchronous layout of the whole document (the
  // hook's own PERF note: "a FULL forced reflow of a large transcript"). So a
  // streaming session paid one forced reflow per token. The growth those deltas
  // cause is ALREADY re-pinned by the ResizeObserver on contentRef below, which
  // runs after layout, where the same read is free. Dropping the timestamp
  // loses nothing and removes the per-token reflow. Pinned by
  // tests/chatview-scroll-pin-deps.test.tsx.
  useEffect(() => {
    if (stickRef.current) scrollToBottom();
  }, [state.timeline.length, state.isThinking, scrollToBottom, stickRef]);

  // Sending a message re-arms auto-scroll. Without this, reading back through
  // history (which now correctly unsticks) and then sending would leave you
  // parked mid-transcript watching nothing happen. Keyed on timeline length so
  // it fires once per appended entry, and only when that entry is the user's.
  const timelineLength = state.timeline.length;
  const lastEntryRef = useRef<unknown>(undefined);
  useEffect(() => {
    const last = state.timeline[timelineLength - 1];
    // Paged history PREPENDS, which changes the length while the last entry stays
    // the very same object (the reducer spreads the existing tail). Without this
    // identity check, loading older history yanked the view to the bottom whenever
    // the newest entry happened to be the user's — a jump, not a re-arm.
    const isNewBottomEntry = last !== lastEntryRef.current;
    lastEntryRef.current = last;
    if (isNewBottomEntry && (last as { kind?: string } | undefined)?.kind === 'user') stickToBottom();
    // state.timeline is intentionally not a dep — only its length matters here,
    // and the array identity changes on every reducer dispatch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timelineLength, stickToBottom]);

  // Fix: when a tool/permission card expands at the bottom of the chat, its new
  // content grows below the input bar and the user has to manually scroll. The
  // reducer-based effect above doesn't fire because expansion is local ToolCard
  // state, invisible to ChatView. Watch the content wrapper's size instead and
  // re-stick to bottom on any growth while still stuck.
  const contentRef = useRef<HTMLDivElement>(null);

  // --- Paged history (perf cycle 2) ------------------------------------------
  // Opening a huge conversation renders only its most recent ~30 turns. Older
  // turns arrive when a 1px sentinel above the first entry scrolls into view —
  // the same "don't do the work until it's needed" shape ResumeBrowser uses for
  // its row list.
  const history = state.history ?? { cursor: null, hasMore: false, loading: false };
  const historySentinelRef = useRef<HTMLDivElement | null>(null);
  // Scroll anchoring. Anchored to an ELEMENT, not to a height delta.
  //
  // The first version measured scrollHeight before the fetch and added the growth
  // to scrollTop afterwards. Destin's verdict was "a little jumpy" (2026-08-28),
  // and height arithmetic is why: the number is captured a network round-trip
  // early, so anything that changes height meanwhile corrupts it; it is applied
  // exactly once, so markdown and code blocks that lay out a frame later shift the
  // view again; and it fights Chromium's own scroll anchoring, which is already
  // compensating for the same insertion.
  //
  // Anchoring to the topmost visible entry has none of those failure modes: it
  // measures the drift that ACTUALLY happened and can be re-applied as late
  // content settles, because "put this element back where it was" stays true no
  // matter what else moved.
  const prependAnchorRef = useRef<{ el: Element; topOffset: number } | null>(null);

  /** The topmost entry still on screen, and how far below the viewport's top edge
   *  it sits. Null when nothing is rendered yet. */
  const captureScrollAnchor = useCallback(() => {
    const scroller = scrollContainerRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return null;
    const scrollerTop = scroller.getBoundingClientRect().top;
    for (const el of Array.from(content.querySelectorAll('.timeline-entry'))) {
      const r = el.getBoundingClientRect();
      if (r.bottom > scrollerTop) return { el, topOffset: r.top - scrollerTop };
    }
    return null;
  }, []);

  /** Backoff state for `unresolved` answers. Load-bearing: an unresolved answer
   *  ends in HISTORY_PAGE_FAILED, which clears `loading`, which re-runs the
   *  observer effect, which re-observes a sentinel that is still on screen and
   *  fires immediately — a request-per-frame busy loop without this gate. */
  const unresolvedRetryRef = useRef({ attempts: 0, notBefore: 0 });
  const unresolvedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The timer fires long after the closure that scheduled it went stale. */
  const loadOlderPageRef = useRef<() => void>(() => {});

  const loadOlderPage = useCallback(async () => {
    const cursor = history.cursor;
    if (!cursor || history.loading) return;
    if (Date.now() < unresolvedRetryRef.current.notBefore) return;
    // Announce FIRST: `loading` is the one-in-flight guard, so a second sentinel
    // hit in the same frame must already see it set.
    dispatch({ type: 'HISTORY_PAGE_REQUESTED', sessionId });
    try {
      const page = await (window as any).claude?.detach?.requestTranscriptPage?.({ sessionId, beforeCursor: cursor });
      // Main could not LOCATE the transcript — NOT "this is the beginning of the
      // conversation". Recording it as a page would write hasMore:false and a
      // null cursor into the reducer, which removes the sentinel for good and
      // makes the rest of the conversation unreachable in this window (Destin,
      // 2026-09-07). Treat it as a failed fetch, which keeps the cursor, and
      // retry on a timer so it heals without needing a gesture the user may not
      // even be able to make — at the top of the list there is nothing left to
      // scroll, so nothing would re-trigger the sentinel.
      if (page?.unresolved) {
        const retry = unresolvedRetryRef.current;
        if (retry.attempts < UNRESOLVED_RETRY_LIMIT) {
          const delay = Math.min(UNRESOLVED_RETRY_MS * 2 ** retry.attempts, UNRESOLVED_RETRY_MAX_MS);
          retry.attempts += 1;
          retry.notBefore = Date.now() + delay;
          if (unresolvedTimerRef.current) clearTimeout(unresolvedTimerRef.current);
          unresolvedTimerRef.current = setTimeout(() => {
            unresolvedTimerRef.current = null;
            unresolvedRetryRef.current.notBefore = 0;
            void loadOlderPageRef.current();
          }, delay);
        }
        dispatch({ type: 'HISTORY_PAGE_FAILED', sessionId });
        return;
      }
      if (page) {
        unresolvedRetryRef.current = { attempts: 0, notBefore: 0 };
        // Captured HERE, one statement before the prepend — not before the await,
        // where a round-trip's worth of streaming could have moved everything.
        prependAnchorRef.current = captureScrollAnchor();
        dispatch({ type: 'HISTORY_PAGE_LOADED', sessionId, events: page.events, cursor: page.cursor, hasMore: page.hasMore });
      } else {
        dispatch({ type: 'HISTORY_PAGE_FAILED', sessionId });
      }
    } catch {
      // Clear the flag so the next scroll retries — a stuck `loading` would make
      // the rest of the conversation permanently unreachable.
      dispatch({ type: 'HISTORY_PAGE_FAILED', sessionId });
    }
  }, [dispatch, sessionId, history.cursor, history.loading, captureScrollAnchor]);

  useEffect(() => { loadOlderPageRef.current = loadOlderPage; });

  // A pending retry belongs to the conversation that scheduled it. Switching
  // sessions (this component is reused per session id) must not fire it against
  // the new one, and must give the new one a full budget of its own.
  useEffect(() => {
    unresolvedRetryRef.current = { attempts: 0, notBefore: 0 };
    return () => {
      if (unresolvedTimerRef.current) clearTimeout(unresolvedTimerRef.current);
      unresolvedTimerRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!history.hasMore || history.loading || !history.cursor) return;
    // No IntersectionObserver (an exotic WebView): fall back to nothing rather
    // than eagerly loading the whole conversation, which is the cost this
    // feature exists to avoid. There is NO scroll-handler backstop — this
    // observer is the only trigger for an older page, so on such a WebView the
    // conversation simply does not page. (A comment here used to promise "the
    // scroll handler below covers that case"; there has never been one.)
    if (typeof IntersectionObserver === 'undefined') return;
    const el = historySentinelRef.current;
    const root = scrollContainerRef.current;
    if (!el || !root) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) void loadOlderPage(); },
      { root, rootMargin: '400px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [history.hasMore, history.loading, history.cursor, loadOlderPage]);

  // Put the anchored entry back where it was. Runs BEFORE paint
  // (useLayoutEffect), so the prepended turns are never SEEN to push the view
  // down, and keeps correcting for a short window afterwards because a code block
  // or an image inside the new page finishes laying out a frame or two later.
  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    if (!anchor) return;
    prependAnchorRef.current = null;
    const scroller = scrollContainerRef.current;
    const content = contentRef.current;
    if (!scroller || !content || !anchor.el.isConnected) return;

    let live = true;
    const restore = () => {
      if (!live || !anchor.el.isConnected) return;
      const drift = (anchor.el.getBoundingClientRect().top - scroller.getBoundingClientRect().top) - anchor.topOffset;
      // Sub-pixel drift is not worth a write — and writing would restart the
      // ResizeObserver for nothing.
      if (Math.abs(drift) > 0.5) scroller.scrollTop += drift;
    };
    restore();

    // Stop the moment the user takes over. Deliberately NOT the 'scroll' event:
    // restore() scrolls, so that would cancel the correction with its own effect.
    const release = () => { live = false; cleanup(); };
    const ro = new ResizeObserver(restore);
    ro.observe(content);
    for (const ev of ['wheel', 'touchstart', 'keydown'] as const) scroller.addEventListener(ev, release, { passive: true });
    const stop = setTimeout(() => { live = false; cleanup(); }, ANCHOR_SETTLE_MS);
    function cleanup() {
      clearTimeout(stop);
      ro.disconnect();
      for (const ev of ['wheel', 'touchstart', 'keydown'] as const) scroller!.removeEventListener(ev, release);
    }
    return cleanup;
  }, [state.timeline]);

  useEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    let lastHeight = node.scrollHeight;
    const observer = new ResizeObserver(() => {
      const next = node.scrollHeight;
      if (next > lastHeight && stickRef.current) {
        scrollToBottom();
      }
      lastHeight = next;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [scrollToBottom, stickRef]);

  // IntersectionObserver for backdrop-filter optimization: only apply blur
  // to visible bubbles on wallpaper themes (reduces GPU compositing cost)
  const bubbleObserverRef = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    bubbleObserverRef.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          entry.target.classList.toggle('in-view', entry.isIntersecting);
        }
      },
      { rootMargin: '200px 0px' },
    );
    return () => bubbleObserverRef.current?.disconnect();
  }, []);

  // Fix (perf cycle 3): release the element when React detaches the ref.
  //
  // An IntersectionObserver holds a STRONG reference to every target it
  // observes, and this ref is attached to EVERY timeline entry. The old body
  // only ever called observe(), so any entry removed from the DOM stayed
  // reachable from the live observer for as long as this ChatView was mounted.
  // Nothing removes a timeline entry today, so it never leaked in practice —
  // but it means the FIRST change that drops an entry (eviction, or collapsing
  // a distant entry to a placeholder) would free nothing at all, silently, with
  // every existing test still green. Measured context: a conversation read to
  // the top holds ~1.44M DOM nodes.
  //
  // React 19 supports returning a cleanup function from a callback ref, which
  // fires on detach — that is the only hook where unobserve can be called, so
  // it is used rather than hand-tracking a Set of observed nodes.
  const observeEntry = useObservedRef<HTMLDivElement>(bubbleObserverRef);

  // Perf cycle 3: entries far outside the viewport render as a spacer of the
  // height they last occupied, instead of their full body. Nothing leaves the
  // reducer — see use-entry-folding.ts for why eviction was rejected on review.
  //
  // Suspended while the find bar is open: ContentFindBar finds text by walking
  // the DOM, so a folded entry would be unfindable and the user would be told
  // "0 results" for text that is in their conversation.
  const folding = useEntryFolding(!findOpen, scrollContainerRef);

  // One ref for both observers — the blur-gating one and the folding one — so a
  // timeline entry still carries a single callback ref.
  // Depends on the two REGISTRATION callbacks, never on the `folding` object.
  //
  // That object is a fresh literal every render, so depending on it made
  // attachEntry's identity change every render — and a ref callback whose
  // identity changes is detached and re-attached by React on EVERY entry, every
  // render. For a 7,000-entry conversation that is 7,000 unobserve+observe pairs
  // per render, each observe delivering a fresh intersection report, which in
  // turn restarted the fold idle timer so folding could never fire. It made the
  // measured numbers WORSE than doing nothing (2026-08-28).
  const registerFold = folding.registerEntry;
  const attachEntry = useCallback((el: HTMLDivElement | null) => {
    const releaseBlur = observeEntry(el);
    const releaseFold = registerFold(el);
    return () => { releaseBlur(); releaseFold(); };
  }, [observeEntry, registerFold]);

  // Arrow key scrolling with acceleration when not typing
  const scrollSpeed = useRef(0);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(document.activeElement)) return;
      // A focused game board owns its own arrow keys. Without this the chat
      // scrolls BEHIND you while you play 2048, because a board is not a text
      // field and so `isTypingTarget` says nothing about it. This listener is
      // on `window` and registers first, so the game cannot win the race from
      // its own side — the yield has to happen here.
      if (document.activeElement?.closest('[data-game-keys]')) return;
      if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;

      e.preventDefault();
      const container = scrollContainerRef.current;
      if (!container) return;

      // Accelerate: start at 40px, increase by 20px per repeat, cap at 300px
      scrollSpeed.current = Math.min(scrollSpeed.current + 20, 300);
      const direction = e.key === 'ArrowUp' ? -1 : 1;
      // Fix: stop following new content the moment the user scrolls up. Done
      // here (synchronously, before layout) rather than by observing where the
      // scroll landed — during a streaming turn the auto-scroll would re-pin us
      // in the same frame and the observation would never see it. ArrowDown
      // doesn't unstick: when already pinned it cannot move the container, so
      // no scroll event would fire to re-arm.
      if (direction < 0) releaseStick();
      container.scrollBy({ top: direction * scrollSpeed.current, behavior: 'auto' });
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        scrollSpeed.current = 0;
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [releaseStick]);

  // Ctrl/Cmd+F opens the chat-history find bar. Only the visible ChatView
  // responds (one per session is mounted). Defers to the artifact drawer's own
  // find when the pointer is over the drawer — that handler preventDefaults in
  // its hover case, and we additionally bail on drawer-hover so the two never
  // both open regardless of which window listener runs first.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || (e.key !== 'f' && e.key !== 'F')) return;
      if (e.defaultPrevented) return;
      const drawer = document.querySelector('.framed-shell .drawer-pane');
      if (drawer && drawer.matches(':hover')) return; // drawer owns find when hovered
      e.preventDefault();
      setFindOpen(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [visible]);

  // The find row changes the scroll container's height (it takes its own row
  // above the messages). Shrinking a container does not fire a scroll event
  // and none of the ResizeObservers above watch the container itself, so a
  // view pinned to the bottom would be left the row's height short of it.
  // Re-pin synchronously after layout while still stuck; a user who scrolled
  // up keeps their place (the browser preserves scrollTop) and just sees the
  // messages shift down by the row, which is the intended behaviour.
  useLayoutEffect(() => {
    if (stickRef.current) scrollToBottom();
  }, [findOpen, scrollToBottom, stickRef]);

  // Wheel scroll: burst acceleration + momentum ("flick") glide.
  //
  // Burst acceleration: rapid successive flicks compound — the 5th flick in a
  // row scrolls farther than the 1st. A pause (~350ms) resets the multiplier so
  // an intentional small scroll stays small.
  //
  // Momentum glide: on macOS the OS appends a ~20-30-event momentum tail to a
  // flick, so scrolling coasts for free. Linux/libinput emits NO such tail —
  // the wheel events stop the instant the finger lifts, so scrolling died
  // immediately (Destin's report). We fix that ourselves: sample the recent
  // wheel velocity and, once events stop, keep scrolling under exponential
  // friction until it decays away. A single mouse-wheel notch (one isolated
  // event) never reaches flick velocity, so discrete mouse scrolling stays
  // snappy — only a fast multi-event trackpad flick coasts.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    // — Burst acceleration state (unchanged behavior) —
    let multiplier = 1;
    let lastWheelTime = 0;
    let lastBumpTime = 0;
    const RESET_MS = 350;
    const BURST_GAP = 120;
    const STEP = 0.25;
    const MAX = 4;

    // — Momentum glide state —
    let velocity = 0; // px/ms, signed; the speed the glide coasts at
    let momentumRaf: number | null = null;
    let gliding = false; // true only while coasting on inertia (finger is OFF the pad)
    let lastFrameTime = 0;
    const samples: { d: number; t: number }[] = []; // recent applied deltas
    const VELOCITY_WINDOW = 90; // ms window the velocity estimate averages over
    const IDLE_GAP = 28; // ms with no wheel event ⇒ finger lifted, start coasting
    const FRICTION = 0.0021; // per-ms exponential decay — controls deceleration rate
    const MIN_VELOCITY = 0.03; // px/ms ⇒ glide has effectively stopped
    const MIN_FLICK_VELOCITY = 0.35; // px/ms ⇒ fast enough to coast at all

    const stopMomentum = () => {
      if (momentumRaf !== null) {
        cancelAnimationFrame(momentumRaf);
        momentumRaf = null;
      }
      velocity = 0;
      gliding = false;
      samples.length = 0;
    };

    // Estimate current velocity as total recent scroll ÷ its time span. A lone
    // event (one sample) can't establish a velocity, so it never coasts.
    const estimateVelocity = (now: number): number => {
      while (samples.length && now - samples[0].t > VELOCITY_WINDOW) samples.shift();
      if (samples.length < 2) return 0;
      const span = Math.max(now - samples[0].t, 16);
      const total = samples.reduce((sum, s) => sum + s.d, 0);
      return total / span;
    };

    const glide = (now: number) => {
      const dt = Math.min(now - lastFrameTime, 32); // clamp tab-switch jumps
      lastFrameTime = now;

      // Finger still down (events still arriving): the direct scroll in onWheel
      // is driving. Idle, so the hand-off to inertia is seamless.
      if (now - lastWheelTime < IDLE_GAP) {
        gliding = false; // an OS momentum tail (macOS) is still feeding us
        momentumRaf = requestAnimationFrame(glide);
        return;
      }

      // Past the idle gap ⇒ the finger is off and we're coasting on our own
      // inertia. A touch/tap now should "catch" and freeze it (see onWheel).
      gliding = true;
      velocity *= Math.exp(-FRICTION * dt);
      if (Math.abs(velocity) < MIN_VELOCITY) {
        stopMomentum();
        return;
      }

      const before = container.scrollTop;
      container.scrollTop = before + velocity * dt;
      // Hit the top/bottom and couldn't move ⇒ nothing left to coast into.
      if (Math.abs(container.scrollTop - before) < 0.5) {
        stopMomentum();
        return;
      }
      momentumRaf = requestAnimationFrame(glide);
    };

    const onWheel = (e: WheelEvent) => {
      // Let browser zoom (Ctrl+wheel) pass through untouched
      if (e.ctrlKey) return;

      // "Catch the glide": while we're coasting on inertia, ANY new wheel input —
      // including the sub-pixel jitter of just resting fingers on the pad — means
      // the user touched the pad to stop it. Freeze in place and swallow this
      // event (don't scroll by it), so a tap parks the view exactly where it is;
      // the next real scroll then fine-tunes from there. Runs BEFORE the small-
      // delta guard because a tap's delta is often < 1px. Only fires during our
      // own inertia (gliding), never mid-flick or during a macOS momentum tail.
      if (gliding) {
        e.preventDefault();
        stopMomentum();
        lastWheelTime = performance.now();
        return;
      }

      if (Math.abs(e.deltaY) < 1) return;

      const now = performance.now();
      const gapSinceLastEvent = now - lastWheelTime;
      const gapSinceLastBump = now - lastBumpTime;

      if (gapSinceLastEvent > RESET_MS) {
        // Long pause — reset to baseline (next flick = 1x)
        multiplier = 1;
        lastBumpTime = now;
      } else if (gapSinceLastBump > BURST_GAP) {
        // New flick after previous flick's momentum settled — compound
        multiplier = Math.min(multiplier + STEP, MAX);
        lastBumpTime = now;
      }
      // else: mid-burst momentum events — leave multiplier alone
      lastWheelTime = now;

      const applied = e.deltaY * multiplier;

      // Feed the velocity estimator with the delta we actually apply, so the
      // glide coasts at the speed the content was visibly moving.
      samples.push({ d: applied, t: now });
      velocity = estimateVelocity(now);

      e.preventDefault();
      // Direct 1:1 scroll while the finger is down (zero latency); the glide
      // loop takes over only once events stop.
      container.scrollBy({ top: applied, behavior: 'auto' });

      // Arm the glide loop once the gesture is fast enough to be a real flick.
      if (momentumRaf === null && Math.abs(velocity) >= MIN_FLICK_VELOCITY) {
        lastFrameTime = now;
        momentumRaf = requestAnimationFrame(glide);
      }
    };

    // Any deliberate interaction cancels an in-flight glide (standard "grab to
    // stop" behavior): a click, a touch, or a key (incl. the arrow-key scroll).
    const cancelOnInput = () => {
      if (momentumRaf !== null) stopMomentum();
    };

    // Non-passive so preventDefault() works and our delta replaces native scroll
    container.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('pointerdown', cancelOnInput, true);
    window.addEventListener('keydown', cancelOnInput, true);
    return () => {
      container.removeEventListener('wheel', onWheel);
      window.removeEventListener('pointerdown', cancelOnInput, true);
      window.removeEventListener('keydown', cancelOnInput, true);
      stopMomentum();
    };
  }, []);

  const handlePromptSelect = useCallback(
    (promptId: string, button: PromptCardButton, label: string, promptTitle?: string) => {
      // Resume-from-summary tie-in: clicking "Resume from summary" (or similar)
      // on the Resume Session prompt triggers Claude Code's compaction flow.
      // Dispatch COMPACTION_PENDING NOW so the spinner appears immediately —
      // otherwise the user watches a blank chat for 15-30s with no feedback.
      // Completion is detected via first-turn-complete fallback in App.tsx
      // (resume creates a new JSONL file, so transcript-shrink never fires).
      if (promptTitle === 'Resume Session' && /summar/i.test(label)) {
        dispatch({
          type: 'COMPACTION_PENDING',
          sessionId,
          cardId: `compact-resume-${Date.now()}`,
          beforeContextTokens: null, // Resume doesn't have pre-compaction stats
        });
      }
      // Send the keystroke(s) that pick this option in the live Ink menu — a bare
      // option digit, or (fallback only) arrows plus a separately-written \r.
      sendPromptInput(sessionId, button);
      // Mark the prompt as completed in the UI
      dispatch({
        type: 'COMPLETE_PROMPT',
        sessionId,
        promptId,
        selection: label,
      });
    },
    [sessionId, dispatch],
  );

  // Task 12 review fix (Important — float collision): .model-status-strip and
  // .jump-to-bottom float in THIS component's OUTER absolute root (see their
  // render sites below) sharing the same --bottom-chrome-height offset band
  // as .queued-messages-strip — with the strip visible, they'd sit at the
  // exact same height and overlap it. .chat-pane (the strip's own DOM parent)
  // is NOT an ancestor of those two floats, so a var set there wouldn't reach
  // them; this measures the strip's OWN rendered height and publishes
  // --queued-strip-height on chatRootRef (the true common ancestor of all
  // three), and globals.css adds it into their bottom calc so they lift above
  // the strip instead of overlapping it — offset coordination, not z-index.
  //
  // Task 12 dogfood fix (follow-up): the SAME var also gets folded into
  // .chat-scroll's own padding-bottom (globals.css) — Destin found live/
  // streaming timeline content settling BEHIND the strip, because nothing
  // was reserving the strip's footprint inside the scrollable content area
  // itself (only the OUTER floats were accounted for). One measured value,
  // two consumers: the outer floats' bottom offset, and the scroll
  // container's bottom padding — both need to clear the same strip, so both
  // read the same var rather than duplicating the measurement.
  //
  // Measurement idiom: ResizeObserver + CSS var, mirroring
  // useChromeMeasurements.ts's --bottom-chrome-height/--top-chrome-height
  // (this file's own established precedent) rather than a fixed
  // rows-times-row-height calc — the strip's row height isn't a constant
  // (long content can wrap, font size varies per theme/user setting), so a
  // real measurement is the only way to stay correct as those vary.
  //
  // Scoped to chatRootRef (per-ChatView-instance), NOT document.documentElement
  // like useChromeMeasurements' vars: every session's ChatView is mounted
  // simultaneously (only the active one is `visible`), so a root-scoped var
  // would let a background session's queue count corrupt the visible
  // session's float offset.
  //
  // Re-runs only when the list crosses the empty/non-empty boundary — a
  // ResizeObserver on the already-attached element handles continuous height
  // changes (wrapping, row count changes) without re-attaching.
  //
  // auto-scroll verified unaffected: scrollToBottom()/jumpToBottom() below
  // both read the scroll container's REAL scrollTop/scrollHeight — neither
  // hardcodes an offset — so once .chat-scroll's padding-bottom grows by
  // this var, both naturally settle content above the strip. No JS change
  // needed there.
  const QUEUED_STRIP_GAP = '0.5rem'; // visual breathing room above the strip's top edge (Destin's ask)
  const hasQueuedMessages = state.queuedMessages.length > 0;
  useEffect(() => {
    const root = chatRootRef.current;
    if (!root) return;
    if (!hasQueuedMessages) {
      // No strip mounted (QueuedMessagesStrip returns null) — nothing to
      // observe. Explicit 0px (not removeProperty) so the floats' calc reads
      // a real value immediately rather than depending on their own fallback.
      root.style.setProperty('--queued-strip-height', '0px');
      return;
    }
    const el = queuedStripRef.current;
    if (!el) return;
    const update = () => {
      // calc(...) keeps the gap in real rem units (respects root font-size /
      // zoom) while the measured part is a real px value — string-concat
      // into ONE var rather than adding a second var, so every consumer
      // (.chat-scroll padding, the two floats' bottom offset) only has to
      // read a single number instead of remembering to add the gap itself.
      const h = Math.ceil(el.getBoundingClientRect().height);
      root.style.setProperty('--queued-strip-height', `calc(${h}px + ${QUEUED_STRIP_GAP})`);
    };
    const observer = new ResizeObserver(update);
    observer.observe(el);
    update();
    // No removeProperty on cleanup: unlike useChromeMeasurements' document-
    // level vars (which must be cleaned up because the root persists across
    // the app's lifetime), this var lives on chatRootRef — it disappears
    // with the DOM node on unmount, and on a boundary re-run the branch
    // above already overwrites it with a fresh value.
    return () => observer.disconnect();
  }, [hasQueuedMessages]);

  // Fix (Destin, 2026-07-28 — "jump to bottom overlaps model unloaded popup"):
  // .jump-to-bottom and .model-status-strip previously shared the BYTE-FOR-BYTE
  // identical `bottom:` calc formula, so whenever both were visible at once
  // (model asleep + user scrolled up) they rendered at the exact same rect and
  // visually overlapped. Same fix shape as --queued-strip-height above: measure
  // ModelLoadingBar's own rendered height and publish it as --model-status-height
  // on chatRootRef, then globals.css folds it into ONLY .jump-to-bottom's bottom
  // calc (not model-status-strip's own — that would push it up above itself).
  //
  // ModelLoadingBar's shown/hidden condition depends on modelState/isThinking/
  // everResident math that lives inside that component (loading || showReload) —
  // rather than duplicating that logic here and risking drift, this reads
  // modelStatusRef.current directly after each render: null means the component
  // rendered nothing this pass, so the effect zeroes the var instead of
  // guessing from a re-derived boolean.
  const MODEL_STATUS_GAP = '0.75rem'; // matches .jump-to-bottom's own gap so the two bands stack evenly
  useEffect(() => {
    const root = chatRootRef.current;
    if (!root) return;
    const el = modelStatusRef.current;
    if (!el) {
      root.style.setProperty('--model-status-height', '0px');
      return;
    }
    const update = () => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      root.style.setProperty('--model-status-height', `calc(${h}px + ${MODEL_STATUS_GAP})`);
    };
    const observer = new ResizeObserver(update);
    observer.observe(el);
    update();
    return () => observer.disconnect();
  }, [state.modelState, state.modelInfo, state.modelLoadedBytes, state.modelEverResident, state.isThinking]);

  return (
    <div
      // Fix: previously toggled display:none/flex, which forced a full reflow of
      // both views on every chat↔terminal toggle (the #1 cause of visual jank
      // reports). Using visibility+opacity+pointer-events keeps the layout box
      // stable across toggles — no reflow, no flash, and focus/IME survive.
      // `inert` removes hidden subtree from tab order + a11y tree.
      ref={chatRootRef}
      inert={!visible}
      aria-hidden={visible ? undefined : true}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: 'flex',
        flexDirection: 'column',
        visibility: visible ? 'visible' : 'hidden',
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? 'auto' : 'none',
        // Fix (window-resize jank): App renders a ChatView for EVERY open
        // session, and visibility:hidden does NOT remove an element from
        // layout — so every resize tick re-wrapped every open conversation,
        // not just the one on screen. With 6 sessions of real content that
        // measured 117ms per resize step (13 long tasks), which reads as the
        // window content freezing and then snapping to the new size.
        //
        // content-visibility:hidden skips layout of the subtree like
        // display:none, but preserves rendering state so re-showing is cheap.
        // Measured on the same 6-pane fixture: resize 117ms → 43ms per step
        // with zero long tasks, and session switching got FASTER than the
        // visibility-only behaviour it replaces (5.3ms → 0.5ms median;
        // display:none would have cost 25.3ms). Scroll position survives.
        //
        // Keyed on sessionActive, NOT visible: the chat↔terminal toggle within
        // the active session must stay on the visibility path above, because
        // that toggle is frequent and is exactly what the original fix
        // addressed. Switching SESSIONS is deliberate and infrequent, so
        // paying a skipped-subtree re-render there is the right trade.
        contentVisibility: sessionActive ? 'visible' : 'hidden',
      }}
    >
      {/* framed-shell: horizontal flex row holding the chat pane + optional
          Session Drawer. The frame-edge strips are filled with --panel so the
          chat area reads as inset inside header/status-bar chrome (Task 6.2).
          Floating themes suppress the edge fill via [data-theme-layout] on <html>.
          projectRoot/projectId/projectName are stubbed with empty strings — these
          are only needed by the drawer's artifacts.save IPC call and will be
          resolved in a later task when session metadata is threaded to ChatView. */}
      {/* drawer-open modifier collapses chat pane on narrow screens (Task 6.3) */}
      <div className={`framed-shell${rightPaneOpen ? ' drawer-open' : ''}${drawerExpanded && !gameOpen ? ' drawer-expanded' : ''}`}>
        <div className="frame-edge" />
        <div className="chat-pane">
          {/* Empty-state hint — absolutely centered in the chat-pane between the
              top and bottom chrome. Uses --top-chrome-bottom (not the broken
              h-full centering it replaces) so it clears a FLOATING header pill,
              which sits below --top-chrome-height by its own margin; otherwise
              the text tucked slightly behind the pill. Provider-aware: native
              (local/cloud) sessions shouldn't be told to talk to "Claude". */}
          {state.timeline.length === 0 && !state.isThinking && (
            <div
              // select-none: a hint, not content. Ctrl+A must not paint it
              // (Destin, 2026-09-10).
              className="absolute inset-x-0 flex items-center justify-center text-fg-muted text-sm pointer-events-none select-none"
              style={{ top: 'var(--top-chrome-bottom, 3rem)', bottom: 'var(--bottom-chrome-height, 5rem)' }}
            >
              Start a conversation with {assistantName(provider)}
            </div>
          )}
          {/* Chat-history find bar — sibling of (not inside) the scroll/content
              container so its own text isn't matched. Its own ROW above the
              messages, like a browser's (P-14, Destin 2026-08-27): the old
              floating card (right-3, just under the header) sat on top of the
              first right-aligned user message and hid the end of it. In flow
              here, .chat-pane (a flex column, globals.css) lets the scroll
              container below take the remaining height, so the messages shift
              down while the bar is open and back when it closes. `.find-row`'s
              top margin clears the overlaid header (globals.css). */}
          {findOpen && (
            <ContentFindBar
              layout="row"
              containerRef={contentRef}
              scrollRef={scrollContainerRef}
              highlightName="chat-find"
              placeholder="Find in chat"
              resetKey={sessionId}
              onClose={() => setFindOpen(false)}
            />
          )}
          {/* flex-1 min-h-0 (was h-full): with the find row in flow above it,
              h-full would overflow the pane by the row's height and clip the
              last message under the input bar. chat-scroll--below-find-row
              drops the header-clearing padding-top while the row is open —
              the content no longer starts under the header, it starts under
              the row. */}
          <div ref={scrollContainerRef} className={`chat-scroll flex-1 min-h-0 overflow-y-auto${findOpen ? ' chat-scroll--below-find-row' : ''}`}>
           {/* The arrival class is on the CONTENT wrapper, not the scroller:
               animating transform on the scroll container would make it a
               containing block and disturb useStickToBottom's measurements. */}
           <div ref={contentRef} className={arriving ? 'switch-arrival' : undefined}>
        {/* Step 3 (2026-08-17, broadened): the session's starting-context strip
            — every session shows one, and clicking it opens the full accounting
            (SessionContextPopup). Mounted above the first message so it also
            shows on a fresh session before any timeline exists. in-view opts it
            into the same wallpaper glassmorphism as the timeline bubbles. */}
        {state.sessionContext && (
          <div className="px-4 pt-3 in-view">
            <SessionContextBanner context={state.sessionContext} onOpen={() => setContextPopupOpen(true)} />
          </div>
        )}
        {/* Paged history: crossing this loads the previous ~30 turns. Rendered
            only while there IS older history, so reaching the beginning of the
            conversation stops the fetching for good. */}
        {history.hasMore && (
          <div ref={historySentinelRef} data-history-sentinel className="h-px" aria-hidden="true" />
        )}
        {state.timeline.length === 0 && !state.isThinking ? null : (
          <>
            {(() => {
              // Find the most recent compaction marker so we can visually fade
              // entries above it — Claude's context is just the post-compaction
              // summary, so pre-compaction messages are "archived" from its POV.
              // Fading signals this without hiding history the user may want to re-read.
              // /clear is treated exactly like /compact here. Both draw a line
              // under the conversation: everything above is out of the model's
              // context but still the user's to re-read. /clear used to WIPE the
              // timeline instead, which threw away readable history to express a
              // context reset (Destin, 2026-07-28).
              const { index: lastArchiveIdx, kind: archiveKind } = archiveBoundary;
              return state.timeline.map((entry, idx) => {
                const isPreCompaction = lastArchiveIdx >= 0 && idx < lastArchiveIdx;
              let key: string;
              let content: React.ReactNode;
              switch (entry.kind) {
                case 'user':
                  key = entry.message.id;
                  // A host-injected user-role turn (a delivered specialist
                  // report) is an EVENT for the assistant, not anyone's words —
                  // a compact collapsed card, see SpecialistReportCard. MUST
                  // mirror BubbleFeed.tsx.
                  content = entry.injected ? (
                    <SpecialistReportCard
                      message={entry.message}
                      injected={entry.injected}
                      meta={entry.injectedMeta}
                      sessionId={sessionId}
                      showTimestamps={showTimestamps}
                    />
                  ) : (
                    <UserMessage
                      message={entry.message}
                      sessionId={sessionId}
                      showTimestamps={showTimestamps}
                    />
                  );
                  break;
                case 'assistant-turn': {
                  const turn = state.assistantTurns.get(entry.turnId);
                  // Shared gate (chat-types.ts): a segment-less turn renders
                  // only when its abnormal stopReason gives the footer row
                  // something to say — the empty_response fix.
                  if (!shouldRenderAssistantTurn(turn)) return null;
                  key = entry.turnId;
                  content = (
                    <AssistantTurnBubble
                      turn={turn}
                      toolGroups={state.toolGroups}
                      toolCalls={state.toolCalls}
                      sessionId={sessionId}
                      provider={provider}
                      showTimestamps={showTimestamps}
                    />
                  );
                  break;
                }
                case 'prompt':
                  // Perf cycle 2: the "See previous messages" marker is retired —
                  // older turns now stream in as the top of the list scrolls into
                  // view. A timeline persisted by an OLDER build can still carry
                  // one, so it is skipped rather than rendered as a dead prompt.
                  if (entry.prompt.promptId === HISTORY_EXPAND_PROMPT_ID) return null;
                  key = entry.prompt.promptId;
                  content = (
                    <PromptCard
                      prompt={entry.prompt}
                      sessionId={sessionId}
                      onSelect={(button, label) => handlePromptSelect(entry.prompt.promptId, button, label, entry.prompt.title)}
                    />
                  );
                  break;
                // /cost and /usage snapshot — entryId is the stable key since the
                // same snapshot object is kept in state across re-renders.
                case 'usage-card':
                  key = entry.snapshot.entryId;
                  content = <UsageCard snapshot={entry.snapshot} />;
                  break;
                // /clear and /compact dividers
                case 'system-marker':
                  key = entry.marker.id;
                  content = <SystemMarker marker={entry.marker} />;
                  break;
                // /skill-name — a compact card, never the instructions themselves.
                case 'skill-invocation':
                  key = entry.id;
                  content = (
                    <SkillInvocationCard
                      skillId={entry.skillId}
                      displayName={entry.displayName}
                      args={entry.args}
                      skillPath={entry.skillPath}
                      sessionId={sessionId}
                    />
                  );
                  break;
                // /compact spinner (and resume-from-summary)
                case 'compacting':
                  key = entry.id;
                  content = <CompactingCard startedAt={entry.startedAt} />;
                  break;
                // /copy multi-block picker
                case 'copy-picker': {
                  key = entry.id;
                  // Capture id in closure so the callbacks work after TS narrowing.
                  const pickerId = entry.id;
                  content = (
                    <CopyPicker
                      id={pickerId}
                      options={entry.options}
                      onCopy={(text, label) => {
                        navigator.clipboard.writeText(text).catch(() => {});
                        dispatch({ type: 'DISMISS_COPY_PICKER', sessionId, id: pickerId });
                        // onToast would be nicer but ChatView doesn't have it — minimal UX for now
                        void label;
                      }}
                      onDismiss={() => dispatch({ type: 'DISMISS_COPY_PICKER', sessionId, id: pickerId })}
                    />
                  );
                  break;
                }
              }
              // Folded: render the wrapper at exactly the height its body last
              // occupied and omit the body. The wrapper stays in the DOM so the
              // scroll height, the observers and captureScrollAnchor's
              // `.timeline-entry` query all see an unchanged list.
              const folded = folding.isFolded(key!);
              const foldHeight = folded ? folding.heightOf(key!) : undefined;
              return (
                <Tooltip key={key!} text={isPreCompaction
                    ? (archiveKind === 'clear'
                      ? 'Cleared — still here to read, but not in Claude\'s context'
                      : 'Archived by compaction — not in Claude\'s active context')
                    : ''}>
                <div
                  ref={attachEntry}
                  data-entry-key={key!}
                  className={`timeline-entry in-view${isPreCompaction ? ' opacity-60 transition-opacity' : ''}`}
                  style={folded && foldHeight ? { height: foldHeight } : undefined}
                >
                  {folded && foldHeight ? null : content}
                </div>
                </Tooltip>
              );
              });
            })()}
            {/* Awaiting-approval tools (incl. AskUserQuestion) pop out as standalone
                bubbles at the bottom. The `in-view` class is required: theme-engine's
                glass selector is `[data-wallpaper] .in-view .bg-inset` — without an
                `.in-view` ancestor the bubble gets the translucent color-mix but NOT
                the backdrop-filter blur, so it reads as a flat panel instead of frosted
                glass. Normal timeline bubbles get `in-view` from their wrapper; these
                pop-out bubbles aren't in that wrapper, so set it here. They're pinned
                at the bottom and always visible, so a static `in-view` is correct. */}
            {awaitingTools.map((tool) => (
                <div key={tool.toolUseId} className="in-view flex justify-start px-4 py-0.5">
                  <div className="assistant-bubble max-w-[85%] rounded-2xl rounded-bl-sm bg-inset px-5 py-3">
                    <ToolCard tool={tool} sessionId={sessionId} />
                  </div>
                </div>
              ))}

            {/* Only show thinking indicator when Claude is between tool completion
                and next text — not when tools are still running or awaiting approval.
                When the classifier flags a non-ok attention state, swap the
                spinner for an AttentionBanner tailored to the state.
                Terminal states ('error'/'session-died') persist AFTER the turn
                ends — endTurn() clears isThinking — so they must render even
                when !isThinking. 'stuck' only occurs mid-thinking, so it stays
                gated on the thinking area. */}
            {(() => {
              const thinkingArea = state.isThinking && !hasAwaitingApproval && !hasRunningTools;
              // 'stalled' joins the terminal states in this gate — NOT because
              // it is terminal (the turn is alive), but because it must render
              // even when a preparing tool card is up. A stall while the model
              // is writing tool arguments leaves a card with status 'running',
              // which turns thinkingArea false; without this the red card would
              // be invisible in precisely the mid-tool stall this design exists
              // for (2026-08-12 incident).
              const terminalAttention =
                state.attentionState === 'error'
                || state.attentionState === 'session-died'
                || state.attentionState === 'stalled';
              // Native local-model: while the model isn't resident yet (cold load
              // / waking from sleep), the turn is waiting on the ENGINE, not the
              // model thinking — show a static "Loading…" instead of the animated
              // spinner until it begins processing. (2026-07-14)
              const modelNotResident = state.modelState != null && state.modelState !== 'loaded';
              if (thinkingArea && state.attentionState === 'ok') {
                // While compaction runs, CompactingCard is already on screen
                // with its own pulse + elapsed counter, so the generic spinner
                // stacked a second "working" signal underneath it — and its
                // rotating copy ("Connecting dots") describes the model
                // thinking, which is not what a summarize step is doing. One
                // status per event. (Destin, 2026-08-16)
                //
                // Gated HERE and not on `thinkingArea`: that flag also gates
                // the 'stuck' AttentionBanner below, so folding it in there
                // silently swallowed the one message saying something is wrong
                // during exactly the long operation most likely to hang.
                if (state.compactionPending) return null;
                return modelNotResident
                  ? (
                    <div className="flex items-center gap-2 px-4 py-1.5 in-view">
                      <div className="flex items-center gap-2 bg-inset rounded-2xl rounded-bl-sm px-4 py-2.5">
                        <span className="text-sm text-fg-dim italic">Loading…</span>
                      </div>
                    </div>
                  )
                  : <ThinkingIndicator stallWarning={state.stallWarning} promptProcessing={state.promptProcessing} lastOutputAt={state.lastOutputAt} />;
              }
              if (state.attentionState !== 'ok' && (thinkingArea || terminalAttention)) {
                return (
                  <AttentionBanner
                    state={state.attentionState}
                    anthropicRequestId={lastTurnRequestId}
                    errorMessage={state.errorMessage}
                    stalledSince={state.stalledSince}
                    // Provider-config errors (missing/disabled key) show an
                    // "Open Settings" button that deep-links to Model Providers.
                    onOpenProviderSettings={onOpenProviderSettings}
                    onSwitchProviders={onSwitchProviders}
                    // Stalled card only. Retry re-runs the PARKED STEP — it is
                    // deliberately NOT the native-send helper the old TODO here
                    // pointed at, which sends a new user message and would fork
                    // the conversation mid-turn.
                    onRetry={state.attentionState === 'stalled'
                      ? () => window.claude.native.retry(sessionId)
                      : undefined}
                    // Stop is ESC: the existing interrupt path, which already
                    // ends the turn cleanly and flushes the partial text to disk.
                    onStop={state.attentionState === 'stalled'
                      ? () => window.claude.native.interrupt(sessionId)
                      : undefined}
                  />
                );
              }
              return null;
            })()}
          </>
        )}
           </div>
          </div>
          {/* Task 12: docked strip for queued messages — a sibling of
              .chat-scroll (NOT inside it), so it neither scrolls with the
              timeline nor lives in the outer absolute ChatView container
              (unlike ModelLoadingBar/jump-to-bottom, which float above the
              WHOLE framed-shell). .chat-pane is `position: relative`, so this
              anchors to ITS bottom edge via the same --bottom-chrome-height
              offset those two floating elements use to clear the real
              InputBar (which lives outside ChatView — see App.tsx's
              chrome-wrapper--bottom). DOM choice documented per the task
              brief: ChatView's scroll container's PARENT. Review fix: ref
              feeds the --queued-strip-height measurement effect above (that
              var is published on chatRootRef, NOT .chat-pane — see the WHY
              comment there for why .chat-pane doesn't work for this). */}
          <QueuedMessagesStrip
            ref={queuedStripRef}
            queuedMessages={state.queuedMessages}
            onCancel={onCancelQueued ? (queueId) => onCancelQueued(sessionId, queueId) : undefined}
            onEdit={onEditQueued ? (queueId, text) => onEditQueued(sessionId, queueId, text) : undefined}
          />
        </div>
        {/* Right frame edge / divider + Session Drawer — only shown when open.
            projectRoot/projectId/projectName are resolved from the session's
            cwd via listProjectsIndex() in the useEffect above. Until the lookup
            completes they fall back to empty strings / 'project', which is safe
            because SessionDrawer renders an empty list rather than crashing. */}
        {/* Right slot: the game pane takes precedence over the artifact drawer
            (App keeps them mutually exclusive, so normally only one is open).
            Both render as a .drawer-pane so they share the framed chrome; the
            game pane is narrower via --right-pane-width (set by App). */}
        {/* Gate the actual pane render on `visible`: in terminal view this
            ChatView is hidden and TerminalRightSlot renders the panel instead.
            Without this gate the drawer/game would mount in BOTH places at
            once (double SessionDrawer / GamePanel). */}
        {visible && (gameOpen ? (
          <>
            <div className="frame-divider" />
            <div className="drawer-pane game-pane">{gamePane}</div>
          </>
        ) : drawerOpen && (
          <>
            <div className="frame-divider" />
            <div className="drawer-pane">
              <SessionDrawer
                sessionId={sessionId}
                cwd={cwd ?? ''}
                projectRoot={activeProject?.path ?? ''}
                projectId={activeProject?.id ?? ''}
                projectName={activeProject?.name ?? 'project'}
              />
            </div>
          </>
        ))}
        <div className="frame-edge" />
      </div>

      {/* Native local-model status: centered strip above the input — a loading
          bar while the model (re)loads, or an "unloaded · Reload" prompt when it
          slept. In the outer absolute div (like jump-to-bottom) so it floats
          above the input chrome, unclipped. No-op for claude sessions. */}
      <ModelLoadingBar
        ref={modelStatusRef}
        modelState={state.modelState}
        modelInfo={state.modelInfo}
        loadedBytes={state.modelLoadedBytes}
        everResident={state.modelEverResident}
        isThinking={state.isThinking}
        onReload={(modelId) => { void window.claude.models.load(modelId); }}
      />

      {/* Jump to bottom button — .jump-to-bottom class handles glassmorphism
         offset so the button appears above the frosted input bar.
         Positioned in the outer absolute div so it floats above the full
         framed-shell (chat + drawer) without being clipped by chat-pane. */}
      {!atBottom && (
        <button
          onClick={jumpToBottom}
          className="jump-to-bottom absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1.5 text-xs bg-inset hover:bg-edge text-fg-2 rounded-full shadow-lg transition-colors z-10"
        >
          Jump to bottom
        </button>
      )}

      {/* Step 3 (2026-08-17, broadened): the session-start context panel —
          "what the assistant began with". Auto-opens once per session (see the
          effect above); the strip stays clickable afterwards. */}
      <SessionContextPopup
        open={contextPopupOpen}
        onClose={() => setContextPopupOpen(false)}
        context={state.sessionContext}
        sessionId={sessionId}
      />
    </div>
  );
}
