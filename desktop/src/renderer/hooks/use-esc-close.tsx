import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react';

// Centralized ESC-key dismissal stack. Overlays call useEscClose(open, onClose);
// a single window-level capture-phase listener pops the top of the stack on ESC
// and invokes its onClose. When the stack is empty the listener is a no-op, so
// ESC can fall through to the chat-passthrough handler in App.tsx (which then
// forwards \x1b to the PTY to interrupt the active Claude session).
//
// This replaces ~13 ad-hoc `useEffect(() => { ... if (e.key === 'Escape') onClose(); ... })`
// copies across overlay components. Reasons for the indirection:
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
