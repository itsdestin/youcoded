import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react';

// Centralized dismissal stack. Overlays call useEscClose(open, onClose); a
// LIFO stack tracks them. The stack is triggered from two sources:
//   1. ESC keydown on the window (desktop primary input). The capture-phase
//      listener pops the top of the stack and invokes its onClose.
//   2. useDismissTop() — imperative entry point used by the Android
//      hardware-back bridge in App.tsx. Same popTop() body as the keydown
//      listener; back press is NOT synthesized as a keyboard event.
//
// When the stack is empty, ESC falls through to the chat-passthrough handler
// in App.tsx (which forwards \x1b to the PTY to interrupt Claude). On Android
// the hardware-back callback is disabled when the stack is empty (Android
// default — back backgrounds the app), so the chat-passthrough is never
// reached from a back press.
//
// Reasons for the indirection:
//   1. LIFO semantics — if two overlays are open, only the top one closes per ESC press.
//   2. preventDefault'd events signal to the chat-passthrough listener that an
//      overlay consumed the keypress, so we don't both close an overlay AND
//      interrupt Claude on a single ESC.
//   3. Single source of truth for "is any overlay open right now".

type Closer = { id: number; ref: React.MutableRefObject<() => void> };

type StoreListener = () => void;

class EscStore {
  private stack: Closer[] = [];
  private listeners = new Set<StoreListener>();

  push(closer: Closer) {
    this.stack.push(closer);
    this.emit();
  }

  remove(id: number) {
    const before = this.stack.length;
    this.stack = this.stack.filter((c) => c.id !== id);
    if (this.stack.length !== before) this.emit();
  }

  popTop(): Closer | undefined {
    const top = this.stack.pop();
    if (top) this.emit();
    return top;
  }

  get isEmpty(): boolean {
    return this.stack.length === 0;
  }

  subscribe(l: StoreListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit() {
    for (const l of this.listeners) l();
  }
}

const EscStoreContext = createContext<EscStore | null>(null);

let nextId = 1;

export function EscCloseProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const storeRef = useRef<EscStore | null>(null);
  if (storeRef.current === null) storeRef.current = new EscStore();
  const store = storeRef.current;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (store.isEmpty) return;
      const top = store.popTop();
      if (!top) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        top.ref.current();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[useEscClose] onClose threw:', err);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [store]);

  return <EscStoreContext.Provider value={store}>{children}</EscStoreContext.Provider>;
}

// Soft-fail when no provider is mounted: the hook becomes a no-op rather than
// throwing. Production always has the provider at App root, so the real path
// is always exercised. The soft-fail keeps isolated component tests (which
// render a subtree without the provider) from needing a wrapper — missing
// provider is visible as "ESC doesn't close overlays" during dev, not as a
// cascade of test crashes. Follows the same pattern as React Router hooks.
export function useEscClose(open: boolean, onClose: () => void): void {
  const store = useContext(EscStoreContext);
  const ref = useRef(onClose);
  useEffect(() => { ref.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!store || !open) return;
    const id = nextId++;
    store.push({ id, ref });
    return () => store.remove(id);
  }, [open, store]);
}

export function useEscStackEmpty(): boolean {
  const store = useContext(EscStoreContext);
  // Without a provider there's no stack, so treat it as empty. Matches the
  // soft-fail model above.
  return useSyncExternalStore(
    useCallback((l) => (store ? store.subscribe(l) : () => {}), [store]),
    useCallback(() => (store ? store.isEmpty : true), [store]),
    useCallback(() => true, []),
  );
}

// Imperative dismissal trigger — pops the top of the stack and invokes its
// onClose. Used by the Android hardware-back bridge so back press doesn't
// synthesize a keyboard event. ESC keydown listener and this hook share
// the same popTop() body; behavior is identical regardless of trigger source.
//
// The returned function is stable across renders (keyed only on the store
// identity, which never changes within a provider). Callers can safely
// cache it in a ref or pass it as a dependency without retriggering effects.
export function useDismissTop(): () => void {
  const store = useContext(EscStoreContext);
  return useCallback(() => {
    if (!store) return;
    const top = store.popTop();
    if (!top) return;
    try {
      top.ref.current();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[useDismissTop] onClose threw:', err);
    }
  }, [store]);
}
