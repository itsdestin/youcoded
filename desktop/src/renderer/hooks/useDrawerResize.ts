// The skills drawer's grab handle: drag to any height, click to jump to full height
// and back, drag far down to close. WHY (Destin, ui-labels-batch#LB-3 + 2026-10-01
// chat, "your recommendations are fine"): the drawer opened too low (45% of the
// window) and its handle was decoration only. It now opens at 70% and EVERY open
// starts there again — "no memory of last position" — so nothing here is persisted.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

/** Default open height, as a share of the window. */
const DEFAULT_SHARE = 0.7;
/** Room left above a full-height drawer so the window's top bar stays visible. */
const TOP_GAP_PX = 48;
/** Shortest the drawer can be dragged before letting go closes it. */
const MIN_PX = 160;
/** A press that moves less than this is a click, not a drag. */
const CLICK_SLOP_PX = 4;

export function useDrawerResize(open: boolean, onClose: () => void) {
  // null = the default height; a number = pixels the user dragged or clicked to.
  const [heightPx, setHeightPx] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startY: number; startH: number; moved: boolean } | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  // Reset on every open AND close: the drawer never remembers where it was left. WHY on close too
  // (final review F43): reset only on open, the next open drew one frame at the old height first.
  useEffect(() => { setHeightPx(null); }, [open]);

  const maxPx = () => window.innerHeight - TOP_GAP_PX;
  const defaultPx = () => Math.round(window.innerHeight * DEFAULT_SHARE);
  const isMax = heightPx !== null && heightPx >= maxPx() - 1;

  const toggleMax = useCallback(() => {
    setHeightPx(h => (h !== null && h >= window.innerHeight - TOP_GAP_PX - 1 ? null : window.innerHeight - TOP_GAP_PX));
  }, []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const h = drawerRef.current?.getBoundingClientRect().height ?? defaultPx();
    drag.current = { startY: e.clientY, startH: h, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dy = d.startY - e.clientY;
    if (!d.moved && Math.abs(dy) < CLICK_SLOP_PX) return;
    if (!d.moved) { d.moved = true; setDragging(true); }
    // Below MIN_PX it keeps following the finger (so closing feels like a pull), but
    // never past the top gap.
    setHeightPx(Math.max(40, Math.min(maxPx(), d.startH + dy)));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
    if (!d) return;
    if (!d.moved) { toggleMax(); return; }
    const h = d.startH + (d.startY - e.clientY);
    if (h < MIN_PX) onClose();
  };
  // WHY its own handler (final review F43): cancel used to run the DROP, so on Android a touch the
  // system took away mid-drag (a scroll, a gesture) could close the drawer or toggle full height.
  // A cancelled drag only stops following the finger, and never leaves the drawer below its minimum.
  const onPointerCancel = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
    if (d?.moved) setHeightPx(h => (h !== null && h < MIN_PX ? MIN_PX : h));
  };
  // Keyboard: Enter/Space = the click; arrows nudge by a tenth of the window.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMax(); return; }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const step = Math.round(window.innerHeight / 10) * (e.key === 'ArrowUp' ? 1 : -1);
    const cur = drawerRef.current?.getBoundingClientRect().height ?? defaultPx();
    setHeightPx(Math.max(MIN_PX, Math.min(maxPx(), cur + step)));
  };

  return {
    drawerRef,
    dragging,
    isMax,
    /** The drawer's height style: 70% of the window until the user moves it. */
    // A dragged height is capped by the window as it is at this render (F43), so a window made
    // smaller after a drag does not keep a drawer taller than the room under the top bar.
    height: heightPx === null ? `${DEFAULT_SHARE * 100}vh` : `${Math.min(heightPx, maxPx())}px`,
    handleProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onKeyDown },
  };
}
