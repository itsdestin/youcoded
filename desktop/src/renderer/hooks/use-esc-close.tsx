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
//      listener invokes the top entry's onClose (it leaves the stack when
//      that overlay actually closes — see activeTop).
//   2. useDismissTop() — imperative entry point used by the Android
//      hardware-back bridge in App.tsx. Same activeTop() body as the keydown
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

type Closer = {
  id: number;
  ref: React.MutableRefObject<() => void>;
  /** Set for a PANEL that stays open beside the chat (the files drawer). */
  layeredWhile?: React.MutableRefObject<(() => boolean) | undefined>;
  /** A panel entry that already took its one Escape while the keyboard was
   *  elsewhere — see activeTop. */
  spent?: boolean;
};

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

  // WHY the entry is not popped: it belongs to the hook, and leaves the stack
  // only when the hook's `open` goes false or it unmounts (the effect cleanup).
  // A LAYERED overlay — the Resume browser closing its Organize sheet, then its
  // expanded row, then itself — peels one layer per press and stays open; when
  // this used to pop, that first press silently dropped the browser off the
  // stack, so later presses did nothing to it and fell through to the chat,
  // interrupting the assistant. An overlay that really closes still leaves the
  // stack via its cleanup (React flushes a keypress's effects before the next
  // keypress), so one press still closes exactly one thing.
  //
  // A PANEL beside the chat is the exception (review 2026-09-23, F2): the files
  // drawer is open for most of a reply — the app opens it itself — and Escape
  // is how the user stops the assistant. So, exactly as before the fix above,
  // the panel takes at most ONE Escape while the keyboard is elsewhere and is
  // then `spent`: the next press goes to the chat. Its layered peeling applies
  // only while focus is inside the panel (`layeredWhile`).
  activeTop(): Closer | undefined {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const c = this.stack[i];
      if (!c.spent || c.layeredWhile?.current?.()) return c;
    }
    return undefined;
  }

  /** Called with the entry that just handled a press. */
  handled(c: Closer) {
    if (!c.layeredWhile) return;
    const inside = !!c.layeredWhile.current?.();
    if (c.spent !== !inside) { c.spent = !inside; this.emit(); }
  }

  /** The real top, spent or not — what the Android Back button acts on. */
  top(): Closer | undefined {
    return this.stack[this.stack.length - 1];
  }

  // WHY every entry counts, spent or not (re-review C2): this drives Android's
  // Back interception (App.tsx → MainActivity). Counting a spent drawer as
  // empty turned Back off, so the second Back sent the app to the background
  // with the files drawer still open. The "one Escape, then the chat" rule is
  // a KEYBOARD rule (the stop key); Back has no chat to reach.
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
      const top = store.activeTop();
      if (!top) return;
      e.preventDefault();
      e.stopPropagation();
      store.handled(top);
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
export function useEscClose(
  open: boolean,
  onClose: () => void,
  // For a panel that stays open beside the chat: true while its layered
  // peeling should apply (keyboard focus inside it). See EscStore.activeTop.
  opts?: { layeredWhile?: () => boolean },
): void {
  const store = useContext(EscStoreContext);
  const ref = useRef(onClose);
  useEffect(() => { ref.current = onClose; }, [onClose]);
  const layeredRef = useRef(opts?.layeredWhile);
  useEffect(() => { layeredRef.current = opts?.layeredWhile; });
  const isPanel = !!opts?.layeredWhile;

  useEffect(() => {
    if (!store || !open) return;
    const id = nextId++;
    store.push({ id, ref, ...(isPanel ? { layeredWhile: layeredRef } : {}) });
    return () => store.remove(id);
  }, [open, store, isPanel]);
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

// Imperative dismissal trigger — invokes the top of the stack's
// onClose. Used by the Android hardware-back bridge so back press doesn't
// synthesize a keyboard event. ESC keydown listener and this hook share
// the same activeTop() body; behavior is identical regardless of trigger source.
//
// The returned function is stable across renders (keyed only on the store
// identity, which never changes within a provider). Callers can safely
// cache it in a ref or pass it as a dependency without retriggering effects.
export function useDismissTop(): () => void {
  const store = useContext(EscStoreContext);
  return useCallback(() => {
    if (!store) return;
    // Back peels the drawer's layers and then closes it — every press, focus
    // or not (re-review C2); the spent rule is for Escape only.
    const top = store.top();
    if (!top) return;
    try {
      top.ref.current();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[useDismissTop] onClose threw:', err);
    }
  }, [store]);
}
