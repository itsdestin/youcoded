import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
import type { Dispatch, ReactNode } from 'react';
import { artifactReducer, initialArtifactState } from './artifact-tracker';
import type { ArtifactState } from './artifact-tracker';
import type { ArtifactAction } from './artifact-actions';

// WHY a store and not a plain context value (perf, 2026-09-23 — "many tabs"):
// the context used to carry `{ state, dispatch }`, whose identity changed on
// EVERY artifact dispatch anywhere — an agent writing a file in any session, a
// drawer click, a preview. React re-renders every useContext reader when the
// value changes, and React.memo cannot stop it, so every open session's
// ChatView and every tool card's body redrew for a file another tab wrote.
//
// Now the context carries a STORE whose identity never changes. Readers pick
// the slice they need with useArtifactSelector(s => …); useSyncExternalStore
// compares the picked value (Object.is) after each dispatch and re-renders the
// reader only when it moved. Same idea as state/chat-context.ts.
//
// Selector rule: return a value the state already holds (a record entry, a
// boolean, a string) or a primitive — never build a new object/array inside the
// selector (`?? []` included), or every dispatch looks like a change and React
// warns about an uncached snapshot. Default outside the selector instead.

export interface ArtifactStore {
  getState: () => ArtifactState;
  subscribe: (callback: () => void) => () => void;
  dispatch: Dispatch<ArtifactAction>;
}

/** The legacy shape: a fixed state plus a dispatch. Still accepted by the
 *  provider so tests and workbench mockups can script a state directly; a new
 *  object here re-renders readers through context the way it always did. */
export interface ArtifactContextValue {
  state: ArtifactState;
  dispatch: Dispatch<ArtifactAction>;
}

// Exported for App (which owns the one real store) and for tests.
export function createArtifactStore(initial: ArtifactState = initialArtifactState): ArtifactStore {
  let state = initial;
  const listeners = new Set<() => void>();
  // Stable for the store's lifetime — safe in effect dependency arrays.
  const dispatch: Dispatch<ArtifactAction> = (action) => {
    const next = artifactReducer(state, action);
    if (next === state) return;
    state = next;
    for (const cb of listeners) cb();
  };
  return {
    getState: () => state,
    subscribe: (cb) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    dispatch,
  };
}

export const ArtifactContext = createContext<ArtifactStore | ArtifactContextValue | null>(null);

const noopUnsubscribe = () => {};
const noopSubscribe = () => noopUnsubscribe;

function isStore(v: ArtifactStore | ArtifactContextValue): v is ArtifactStore {
  return typeof (v as ArtifactStore).subscribe === 'function';
}

/** The store under this component, or null when rendered without a provider
 *  (the buddy window, the workbench tool gallery, unit tests). A scripted
 *  `{ state, dispatch }` value is wrapped in a store that never notifies —
 *  a new value arrives through context, which already re-renders readers. */
export function useArtifactStoreOptional(): ArtifactStore | null {
  const v = useContext(ArtifactContext);
  return useMemo(() => {
    if (v == null) return null;
    if (isStore(v)) return v;
    return { getState: () => v.state, subscribe: noopSubscribe, dispatch: v.dispatch };
  }, [v]);
}

function useArtifactStore(): ArtifactStore {
  const store = useArtifactStoreOptional();
  if (!store) throw new Error('useArtifact* must be used inside ArtifactProvider');
  return store;
}

function useSelectFrom<T>(store: ArtifactStore | null, selector: (s: ArtifactState) => T): T | undefined {
  const subscribe = useCallback(
    (cb: () => void) => (store ? store.subscribe(cb) : noopUnsubscribe),
    [store],
  );
  const getSnapshot = () => (store ? selector(store.getState()) : undefined);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Read one slice of artifact state; re-renders only when that slice changes. */
export function useArtifactSelector<T>(selector: (s: ArtifactState) => T): T {
  return useSelectFrom(useArtifactStore(), selector) as T;
}

/** Non-throwing variant: `undefined` when there is no provider, so file chips
 *  and tool previews degrade gracefully instead of crashing the window. */
export function useArtifactSelectorOptional<T>(selector: (s: ArtifactState) => T): T | undefined {
  return useSelectFrom(useArtifactStoreOptional(), selector);
}

/** Dispatch only — never re-renders on a state change. */
export function useArtifactDispatch(): Dispatch<ArtifactAction> {
  return useArtifactStore().dispatch;
}

export function useArtifactDispatchOptional(): Dispatch<ArtifactAction> | null {
  return useArtifactStoreOptional()?.dispatch ?? null;
}

export function ArtifactProvider({
  store,
  value,
  children,
}: {
  /** App's real store — created once, so this never changes identity. */
  store?: ArtifactStore;
  /** Scripted state for tests and workbench mockups. */
  value?: ArtifactContextValue;
  children: ReactNode;
}) {
  return <ArtifactContext.Provider value={store ?? value ?? null}>{children}</ArtifactContext.Provider>;
}
