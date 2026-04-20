import React, {
  createContext,
  useContext,
  useRef,
  useCallback,
  useSyncExternalStore,
  Dispatch,
} from 'react';
import { ChatAction, ChatState, SessionChatState, createSessionChatState } from './chat-types';
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
// - useChatStateMap() still re-renders on any change (for callers like
//   usePromptDetector that genuinely need the whole map).
// - useChatDispatch() is stable (same store object for the ChatProvider's
//   lifetime).
//
// The reducer is unchanged — still a pure function. SessionChatState reference
// stability is preserved: the reducer returns the same session object when an
// action doesn't affect that session, so unrelated sessions don't notify.

interface ChatStore {
  getState: () => ChatState;
  getSession: (id: string) => SessionChatState;
  subscribeSession: (id: string, callback: () => void) => () => void;
  subscribeAll: (callback: () => void) => () => void;
  dispatch: Dispatch<ChatAction>;
}

function createChatStore(): ChatStore {
  let state: ChatState = new Map();
  const sessionSubs = new Map<string, Set<() => void>>();
  const allSubs = new Set<() => void>();

  const dispatch: Dispatch<ChatAction> = (action) => {
    const prev = state;
    const next = chatReducer(prev, action);
    if (next === prev) return;
    state = next;
    // Notify only subscribers for sessions whose state reference changed.
    // Added sessions count (new reference from undefined), removed sessions
    // notify their subscribers too so they can read the EMPTY_SESSION_STATE
    // fallback after deletion.
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

export function useChatDispatch(): Dispatch<ChatAction> {
  return useStore().dispatch;
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
