import { useCallback, useRef } from 'react';
import { useSyncExternalStore } from 'react';
import { useChatStore } from '../state/chat-context';
import type { AttentionState, SessionChatState } from '../state/chat-types';
import type { SessionStatusColor } from '../components/StatusDot';
import { hasOpenSpecialistAsk } from '../utils/specialist-cards';

// Attention states that mean "act now" get the same red the permission prompt
// uses. Amber is reserved for the one state that genuinely means "I don't know"
// (Destin's rule, 2026-08-16). Extracted as a pure function so the mapping is
// unit-testable without mounting the hook.
// 'session-died' and 'error' moved here 2026-08-16: AttentionBanner has always
// drawn its red destructive ring around both (its DESTRUCTIVE list) while the
// dot rendered amber — the banner and the dot disagreed about the same event.
// Both mean "the turn is over, act now", which is what red means.
const RED_ATTENTION = new Set<AttentionState>(['stalled', 'session-died', 'error']);

export function attentionDotColor(state: AttentionState): 'red' | 'amber' | null {
  if (state === 'ok') return null;
  return RED_ATTENTION.has(state) ? 'red' : 'amber';
}

/**
 * Fold the two cross-window feeds into the locally-derived status map, for the
 * sessions this window does NOT own. Pure so the precedence rules below are
 * unit-testable without mounting App (same reason attentionDotColor is pure).
 *
 * Precedence, and why each rung is where it is:
 *   1. A session this window OWNS keeps its local colour, always. Blue depends
 *      on what *you* have looked at, and only this window knows that.
 *   2. attentionSummary — main's merge of every window's own derived colour,
 *      pushed ~100ms after any change. The only feed that can say "green".
 *      Overwrites, because `base` may already hold a staler red/amber for the
 *      same id (see 3).
 *   3. attentionMap — "needs attention" states on the 10s status push. Can only
 *      ever produce red or amber, but it reaches remote browsers (which run no
 *      aggregation) and covers the instant before the first summary arrives.
 */
export function mergePeerSessionStatuses(args: {
  base: Map<string, SessionStatusColor>;
  localSessionIds: Set<string>;
  windowDirectory: { windows?: Array<{ sessions?: Array<{ id: string }> | null }> | null } | null | undefined;
  summaryPerSession: Record<string, { status?: SessionStatusColor } | undefined> | undefined;
  attentionMap: Record<string, string> | undefined;
}): Map<string, SessionStatusColor> {
  const { base, localSessionIds, windowDirectory, summaryPerSession, attentionMap } = args;
  const m = new Map(base);
  for (const w of (windowDirectory?.windows ?? [])) {
    for (const s of (w?.sessions ?? [])) {
      if (!s?.id || localSessionIds.has(s.id)) continue;
      const reported = summaryPerSession?.[s.id]?.status;
      if (reported) { m.set(s.id, reported); continue; }
      if (m.has(s.id)) continue;
      const state = attentionMap?.[s.id];
      if (!state) continue;
      const color = attentionDotColor(state as AttentionState);
      if (color) m.set(s.id, color);
    }
  }
  return m;
}

export interface SessionAttentionInfo {
  status: SessionStatusColor;
  attentionState: AttentionState;
  awaitingApproval: boolean;
}

/** One session's last answer, and every input that answer was derived from. */
interface SessionMemo {
  toolCalls: SessionChatState['toolCalls'];
  activeTurnToolIds: SessionChatState['activeTurnToolIds'];
  attentionState: AttentionState;
  isThinking: boolean;
  hasTimeline: boolean;
  /** Not viewed and not active — the only way the arguments reach the colour. */
  unseen: boolean;
  /** Derived by the peer-session branch, whose rules differ (no green/blue). */
  peer: boolean;
  info: SessionAttentionInfo;
}

/**
 * The memo still holds for this session's current state.
 *
 * WHY (2026-09-23): the snapshot runs on EVERY store notification — each word
 * streamed in any tab — and used to redo every session from scratch, including
 * a walk of each one's whole tool history (helper asks), only to find nothing
 * had changed. The reducer keeps `toolCalls` / `activeTurnToolIds` the same
 * objects when a notification does not touch them (react-renderer.md), so
 * identity on the fields the colour is built from is proof enough.
 */
function memoHolds(m: SessionMemo | undefined, c: SessionChatState, unseen: boolean, peer: boolean): m is SessionMemo {
  return !!m
    && m.peer === peer
    && m.toolCalls === c.toolCalls
    && m.activeTurnToolIds === c.activeTurnToolIds
    && m.attentionState === c.attentionState
    && m.isThinking === c.isThinking
    && m.hasTimeline === (c.timeline.length > 0)
    && m.unseen === unseen;
}

function memoOf(c: SessionChatState, unseen: boolean, peer: boolean, info: SessionAttentionInfo): SessionMemo {
  return {
    toolCalls: c.toolCalls, activeTurnToolIds: c.activeTurnToolIds, attentionState: c.attentionState,
    isThinking: c.isThinking, hasTimeline: c.timeline.length > 0, unseen, peer, info,
  };
}

// Cached selector over the chat store. Re-renders the host ONLY when some
// session's (status, attentionState, awaitingApproval) triple changes —
// replaces AppInner's whole-map subscription (tranche 1). Derivation logic is
// verbatim from the old sessionStatuses memo (App.tsx) + attention-reporter
// triple; keep the two consumers (HeaderBar dots, attention.report) in sync
// with this ONE computation. Iterates sessions ∪ chatStateMap keys: the old
// dot memo used `sessions`, the old reporter used `chatStateMap` — the union
// serves both. Minor benign delta vs the old reporter (review finding #3):
// a session in the list but not yet in chat state now gets one extra
// gray/ok/false report during the startup/hydrate window (old reporter stayed
// silent until it had chat state). Self-correcting — gray/ok is the neutral
// default and the switcher already knows every session.
export function useSessionAttention(
  sessions: Array<{ id: string }>,
  viewedSessions: Set<string>,
  activeSessionId: string | null,
): Map<string, SessionAttentionInfo> {
  const store = useChatStore();
  const cacheRef = useRef<Map<string, SessionAttentionInfo>>(new Map());
  // Per-session answers, so a notification that changed nothing a colour is
  // built from costs a few identity checks instead of a recompute (memoHolds).
  const memoRef = useRef(new Map<string, SessionMemo>());
  // Render-phase arg mirror (R8 pattern) so getSnapshot — called by React on
  // subscription ticks AND on ordinary re-renders — always sees current args.
  const argsRef = useRef({ sessions, viewedSessions, activeSessionId });
  argsRef.current = { sessions, viewedSessions, activeSessionId };

  const getSnapshot = useCallback((): Map<string, SessionAttentionInfo> => {
    const { sessions, viewedSessions, activeSessionId } = argsRef.current;
    const state = store.getState();
    const next = new Map<string, SessionAttentionInfo>();
    const prevMemo = memoRef.current;
    const nextMemo = new Map<string, SessionMemo>();

    for (const s of sessions) {
      const chatState = state.get(s.id);
      if (!chatState) {
        next.set(s.id, { status: 'gray', attentionState: 'ok', awaitingApproval: false });
        continue;
      }
      const unseen = !viewedSessions.has(s.id) && s.id !== activeSessionId;
      const memo = prevMemo.get(s.id);
      if (memoHolds(memo, chatState, unseen, false)) {
        next.set(s.id, memo.info);
        nextMemo.set(s.id, memo);
        continue;
      }
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
      // Task 8 (review 6, Q6-1): a specialist waiting on the user — hired or
      // part of a plan — needs the user exactly like the assistant's own ask,
      // so it lights the same red dot. That one signal also drives the alert
      // sound (App.tsx, on a change TO red — so an ask arriving while the dot
      // is already red plays nothing twice) and the buddy's "awaiting
      // approval" (via the attention report below). Its ask lives inside a
      // card, often one from a turn that already ended, hence the separate
      // check over every card (cached per toolCalls Map). Merge note: master added
      // the same rule for hired specialists (hasOpenSpecialistAsk); this check is its
      // superset (hired + plan), so one call covers both.
      if (!hasAwaiting && hasOpenSpecialistAsk(chatState.toolCalls)) hasAwaiting = true;
      // Priority: red (permission prompt OR a state that needs a decision) →
      // amber ("something may be wrong, I don't know") → green (working) →
      // blue (unseen activity) → gray (idle).
      const attentionColor = attentionDotColor(chatState.attentionState);
      const status: SessionStatusColor = hasAwaiting ? 'red'
        : attentionColor ?? (
          (chatState.isThinking || hasRunning) ? 'green'
          : (chatState.timeline.length > 0 && !viewedSessions.has(s.id) && s.id !== activeSessionId) ? 'blue'
          : 'gray'
        );
      const info = { status, attentionState: chatState.attentionState, awaitingApproval: hasAwaiting };
      next.set(s.id, info);
      nextMemo.set(s.id, memoOf(chatState, unseen, false, info));
    }
    // Sessions present in chat state but not in the sessions list — this is
    // now also how a PEER WINDOW's session gets a color: App's statusData
    // handler dispatches ATTENTION_STATE_CHANGED for every session in the
    // cross-window attentionMap, including ones this window doesn't own, so
    // its attentionState lands here even though nothing else about it does
    // (no transcript events ever arrive for it in this renderer). The old
    // reporter hardcoded 'gray' regardless of that state — WHY (2026-09-07,
    // Destin: "status lights properly displayed across windows"): use the
    // same red/amber mapping the local branch above uses, so a peer session
    // that's stalled/errored/awaiting approval reads correctly here too.
    // Known gap: "green" (actively thinking) has no cross-window signal yet
    // (isThinking/toolCalls never populate for a session this window doesn't
    // own), so an actively-working peer session still reads gray, same as
    // idle — only the red/amber "needs attention" states are accurate.
    for (const [sid, chatState] of state) {
      if (next.has(sid)) continue;
      // `unseen` is not an input here (peer sessions never go blue), so the
      // memo is stored with a fixed false.
      const memo = prevMemo.get(sid);
      if (memoHolds(memo, chatState, false, true)) {
        next.set(sid, memo.info);
        nextMemo.set(sid, memo);
        continue;
      }
      let awaitingApproval = false;
      for (const id of chatState.activeTurnToolIds) {
        const t = chatState.toolCalls.get(id);
        if (t?.status === 'awaiting-approval') { awaitingApproval = true; break; }
      }
      // Same specialist-ask rule as the owned-session branch above.
      if (!awaitingApproval && hasOpenSpecialistAsk(chatState.toolCalls)) awaitingApproval = true;
      const status: SessionStatusColor = awaitingApproval ? 'red' : attentionDotColor(chatState.attentionState) ?? 'gray';
      const info = { status, attentionState: chatState.attentionState, awaitingApproval };
      next.set(sid, info);
      nextMemo.set(sid, memoOf(chatState, false, true, info));
    }
    memoRef.current = nextMemo;

    // Identity stabilization: return the previous Map when nothing changed.
    const prev = cacheRef.current;
    if (prev.size === next.size) {
      let changed = false;
      for (const [id, info] of next) {
        const p = prev.get(id);
        if (!p || p.status !== info.status || p.attentionState !== info.attentionState || p.awaitingApproval !== info.awaitingApproval) {
          changed = true; break;
        }
      }
      if (!changed) return prev;
    }
    cacheRef.current = next;
    return next;
  }, [store]);

  const subscribe = useCallback((cb: () => void) => store.subscribeAll(cb), [store]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
