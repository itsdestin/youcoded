import { useSyncExternalStore } from 'react';

/** The command drawer's slash-search text ("/abc" → "abc"), held OUTSIDE React state.
 *
 * WHY: this used to be a `useState` in App, so every letter typed after "/" re-rendered
 * the whole App shell — header, session strip, chat pane and all — just to hand one
 * string to the command drawer. Now InputBar writes here and ONLY the drawer
 * subscribes, so a keystroke re-renders the drawer alone. The value is read
 * synchronously (useSyncExternalStore), so the filtered list updates in the same
 * frame it did before — no debounce, no delay.
 *
 * One store per App instance (created in App with `useState(createDrawerFilterStore)`),
 * not a module global, so two App trees (tests, detached windows) never share a filter. */
export interface DrawerFilterStore {
  get: () => string | undefined;
  /** Stable identity — safe to pass straight down as InputBar's `onDrawerSearch`. */
  set: (value: string | undefined) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createDrawerFilterStore(): DrawerFilterStore {
  let value: string | undefined;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (next === value) return;
      value = next;
      for (const l of listeners) l();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

const noStore = { subscribe: () => () => {}, get: () => undefined };

/** Read the filter. With no store (older callers/tests passing `externalFilter`
 *  directly), returns undefined and subscribes to nothing. */
export function useDrawerFilter(store: DrawerFilterStore | undefined): string | undefined {
  const s = store ?? noStore;
  return useSyncExternalStore(s.subscribe, s.get, s.get);
}
