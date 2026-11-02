// Shared plumbing for a button-anchored dropdown menu.
//
// Extracted from OverflowMenu so the project-view hero menu doesn't duplicate
// it. Owns three things that are easy to get subtly wrong:
//   1. Position — measured on open, clamped so the menu can't hang off the
//      right edge of a narrow viewport.
//   2. Outside-dismiss — pointerdown in the CAPTURE phase, because these menus
//      float above content that stops propagation.
//   3. Escape-dismiss.
//
// Positioning is measured once per open rather than tracked live: these menus
// are short-lived and the anchors don't move while one is open. If that ever
// stops being true, this is the place to add a scroll/resize listener.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useEscClose } from './use-esc-close';

const EDGE_MARGIN = 8;

export interface AnchoredMenu<T extends HTMLElement> {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
  /** Attach to the trigger element. */
  anchorRef: React.RefObject<T | null>;
  /** Attach to the floating menu element. */
  menuRef: React.RefObject<HTMLDivElement | null>;
  /** null until measured — render the menu only once this is set. */
  pos: { top: number; left: number } | null;
  /** Wrap an item's handler so choosing it also closes the menu. */
  choose: (fn: () => void) => () => void;
}

export function useAnchoredMenu<T extends HTMLElement>(
  width: number,
  align: 'left' | 'right' = 'left',
): AnchoredMenu<T> {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const anchorRef = useRef<T | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const r = anchorRef.current?.getBoundingClientRect();
    if (!r) return;
    // right-align hangs the menu off the anchor's right edge — correct for a
    // trigger that itself sits at the right of its container.
    const raw = align === 'right' ? r.right - width : r.left;
    const left = Math.min(raw, window.innerWidth - width - EDGE_MARGIN);
    setPos({ top: r.bottom + 4, left: Math.max(EDGE_MARGIN, left) });
  }, [open, width, align]);

  // WHY: Android's Back button only dismisses things registered on the Esc stack
  // (use-esc-close). This menu closed on the keyboard Escape but was not on the
  // stack, so Back with the menu open left the app (2026-11-01 phone test).
  useEscClose(open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // stopPropagation: these menus are frequently nested inside overlays that
      // also close on Escape (ProjectView, detail overlays). Without this, one
      // Escape would close the menu AND the surface behind it.
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const toggle = useCallback(() => setOpen(o => !o), []);
  const choose = useCallback((fn: () => void) => () => { setOpen(false); fn(); }, []);

  return { open, setOpen, toggle, anchorRef, menuRef, pos, choose };
}
