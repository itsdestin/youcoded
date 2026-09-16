import React, {
  createContext,
  useContext,
  useRef,
  useCallback,
  useSyncExternalStore,
  Dispatch,
} from 'react';
import { ChatAction, ChatState, SessionChatState, ToolCallState, createSessionChatState } from './chat-types';
import { chatReducer } from './chat-reducer';

// Stable fallback returned by useChatState(id) when the session doesn't exist
// in the map yet. Must be a singleton — useSyncExternalStore requires snapshot
// identity stability to avoid infinite re-render loops.
const EMPTY_SESSION_STATE: SessionChatState = Object.freeze(createSessionChatState()) as SessionChatState;

// Perf rationale for this module:
//
// The old implementation put the full ChatState Map into React Context. Every
// reducer dispatch produced a new Map reference, which re-rendered every
// useContext subscriber — including all mounted ChatViews, their ToolBodies,
// and the App root. With N sessions streaming simultaneously that meant N ×
// timeline-length div reconciliations per event.
//
// The new implementation is a small custom store with per-session subscribers:
// - useChatState(id) re-renders only when THAT session's SessionChatState
//   reference changes. Unaffected sessions skip re-render entirely.
// - useChatStateMap() still re-renders on any change — for render-path callers
//   that genuinely need the whole map. After the 2026-07-17 AppInner perf
//   tranche the only such caller was RemoteSnapshotExporter; since 2026-09-10
//   it reads the store synchronously inside its export callback instead
//   (useChatStore().getState() — the snapshot must reflect the flushed
//   transcript batch, not a render-lagged ref), so no production code calls
//   this today. Prefer a cached selector over this for anything new.
// - useChatStore() exposes the raw store (getState + subscribe*) for two kinds
//   of consumer that must NOT re-render on every dispatch: (a) effect-only
//   readers — subscriptions/timers that read state without rendering it
//   (usePromptDetector, useSubmitConfirmation, useRemoteAttentionSync, and
//   AppInner's watchdog/mirror effects), and (b) cached selectors built on
//   useSyncExternalStore that re-render their host only when a DERIVED value
//   changes (useSessionAttention, useActiveSessionModel). Do NOT call
//   getState() during render for render-path data — it bypasses React's
//   subscription and can tear; use a selector.
// - useChatDispatch() is stable (same store object for the ChatProvider's
//   lifetime).
//
// The reducer is unchanged — still a pure function. SessionChatState reference
// stability is preserved: the reducer returns the same session object when an
// action doesn't affect that session, so unrelated sessions don't notify.

export interface ChatStore {
  getState: () => ChatState;
  getSession: (id: string) => SessionChatState;
  subscribeSession: (id: string, callback: () => void) => () => void;
  subscribeAll: (callback: () => void) => () => void;
  dispatch: Dispatch<ChatAction>;
  /** Apply several actions in order and notify subscribers ONCE, for the
   *  sessions the whole batch changed. See the WHY on the implementation. */
  dispatchMany: (actions: readonly ChatAction[]) => void;
}

// Exported for tests that need a store without a React tree around it.
export function createChatStore(): ChatStore {
  let state: ChatState = new Map();
  const sessionSubs = new Map<string, Set<() => void>>();
  const allSubs = new Set<() => void>();

  // Notify only subscribers for sessions whose state reference changed.
  // Added sessions count (new reference from undefined), removed sessions
  // notify their subscribers too so they can read the EMPTY_SESSION_STATE
  // fallback after deletion.
  const notify = (prev: ChatState, next: ChatState) => {
    for (const [id, session] of next) {
      if (prev.get(id) !== session) {
        const subs = sessionSubs.get(id);
        if (subs) for (const cb of subs) cb();
      }
    }
    for (const id of prev.keys()) {
      if (!next.has(id)) {
        const subs = sessionSubs.get(id);
        if (subs) for (const cb of subs) cb();
      }
    }
    for (const cb of allSubs) cb();
  };

  const dispatch: Dispatch<ChatAction> = (action) => {
    const prev = state;
    const next = chatReducer(prev, action);
    if (next === prev) return;
    state = next;
    notify(prev, next);
  };

  // WHY (2026-09-16 smoothness sweep, A4): the transcript batcher already made
  // ONE React render per animation frame, but it fed the store one action at a
  // time, and every dispatch ran every subscriber — twelve app-wide
  // subscribeAll readers (attention colours, usage totals, the submit-retry
  // tracker that walks every session's timeline, …) plus the per-session
  // ones. A frame carrying ten streamed words ran all of them ten times. The
  // reducer still sees the actions one at a time, in order; only the
  // notification waits for the end of the batch. No subscriber depends on an
  // intermediate state — each re-reads the whole store when told.
  const dispatchMany = (actions: readonly ChatAction[]) => {
    const prev = state;
    let next = prev;
    for (const action of actions) next = chatReducer(next, action);
    if (next === prev) return;
    state = next;
    notify(prev, next);
  };

  return {
    getState: () => state,
    getSession: (id: string) => state.get(id) ?? EMPTY_SESSION_STATE,
    subscribeSession: (id: string, cb: () => void) => {
      let set = sessionSubs.get(id);
      if (!set) {
        set = new Set();
        sessionSubs.set(id, set);
      }
      set.add(cb);
      return () => {
        const s = sessionSubs.get(id);
        if (!s) return;
        s.delete(cb);
        if (s.size === 0) sessionSubs.delete(id);
      };
    },
    subscribeAll: (cb: () => void) => {
      allSubs.add(cb);
      return () => { allSubs.delete(cb); };
    },
    dispatch,
    dispatchMany,
  };
}

const ChatStoreContext = createContext<ChatStore | null>(null);

export function ChatProvider({ children }: { children: React.ReactNode }) {
  // Init once; useRef persists across renders. StrictMode remounts reset the
  // ref, which is safe because the reducer is pure and no dispatches can have
  // happened across the remount window.
  const storeRef = useRef<ChatStore | null>(null);
  if (!storeRef.current) storeRef.current = createChatStore();
  return React.createElement(
    ChatStoreContext.Provider,
    { value: storeRef.current },
    children,
  );
}

function useStore(): ChatStore {
  const store = useContext(ChatStoreContext);
  if (!store) throw new Error('useChatState/useChatDispatch used outside ChatProvider');
  return store;
}

export function useChatState(sessionId: string): SessionChatState {
  const store = useStore();
  const subscribe = useCallback(
    (cb: () => void) => store.subscribeSession(sessionId, cb),
    [store, sessionId],
  );
  const getSnapshot = useCallback(() => store.getSession(sessionId), [store, sessionId]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

// WHY these two exist (2026-09-16 smoothness sweep, A1): AppInner read the
// streaming session's WHOLE state three times — for the tasks chip's map, for
// the trust overlay's flag and for one "is it thinking" boolean — so every
// streamed word re-rendered the entire shell (header, pills, status bar, input
// bar, the parked settings drawer, every session's chat and terminal), ~60×/s
// for the length of a reply. Each selector returns a primitive or a Map whose
// identity the reducer preserves across text deltas (toolCalls only changes on
// a tool event), so useSyncExternalStore skips the render unless the value
// itself moved. Same idiom as useStreamingGate / useSessionAttention.
export function useSessionToolCalls(sessionId: string): Map<string, ToolCallState> {
  const store = useStore();
  const subscribe = useCallback(
    (cb: () => void) => store.subscribeSession(sessionId, cb),
    [store, sessionId],
  );
  const getSnapshot = useCallback(() => store.getSession(sessionId).toolCalls, [store, sessionId]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function useSessionIsThinking(sessionId: string): boolean {
  const store = useStore();
  const subscribe = useCallback(
    (cb: () => void) => store.subscribeSession(sessionId, cb),
    [store, sessionId],
  );
  const getSnapshot = useCallback(() => store.getSession(sessionId).isThinking, [store, sessionId]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function useChatDispatch(): Dispatch<ChatAction> {
  return useStore().dispatch;
}

// Public store accessor for effect-only consumers (subscriptions/timers that
// read state without needing re-renders). Render-path consumers should keep
// using useChatState/useChatStateMap or a cached selector hook — reading
// getState() during render bypasses React's subscription and can tear.
// (The ChatStore type is exported at its declaration above — a second
// `export type { ChatStore }` here would be a duplicate export, TS2484.)
export function useChatStore(): ChatStore {
  return useStore();
}

export function useChatStateMap(): ChatState {
  const store = useStore();
  const subscribe = useCallback(
    (cb: () => void) => store.subscribeAll(cb),
    [store],
  );
  const getSnapshot = useCallback(() => store.getState(), [store]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
