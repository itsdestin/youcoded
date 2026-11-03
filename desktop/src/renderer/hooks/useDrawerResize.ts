// The skills drawer's grab handle: drag to any height, click to jump to full height
// and back, drag far down to close. WHY (Destin, ui-labels-batch#LB-3 + 2026-10-01
// chat, "your recommendations are fine"): the drawer opened too low (45% of the
// window) and its handle was decoration only. It now opens at 70% and EVERY open
// starts there again — "no memory of last position" — so nothing here is persisted.
//
// WHY the drawer is ALWAYS full height, and only slides (Destin, 2026-11-02: "resizing the command drawer causes
// cards to flicker and its VERY laggy"; then the phone speed lab's one ~370 ms frozen frame on the FIRST drag): a
// drawer whose height changed re-rendered and redrew every card per finger movement. A drawer made full height only
// when a drag began had to draw, in that one frame, every card it had never shown. So the box is laid out at full
// height from the moment it opens; the part below the screen's edge is simply out of sight (the phone draws those
// cards in spare moments, before anyone drags), and the "height" the user sets is how far up it slides. A drag,
// a click to full height and back, and opening and closing all move it with transform only: nothing is re-laid
// out or redrawn. The list inside ends at the screen's edge through `hiddenPx` (CommandDrawer pads it by that much).
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';

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
  // The window's height, followed only while the drawer is open (performance.md rule 2: hidden means idle).
  const [winH, setWinH] = useState(() => window.innerHeight);
  const drag = useRef<{ startY: number; startH: number; moved: boolean; h: number } | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  // Reset on every open AND close: the drawer never remembers where it was left. WHY on close too
  // (final review F43): reset only on open, the next open drew one frame at the old height first.
  useEffect(() => { setHeightPx(null); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onResize = () => setWinH(window.innerHeight);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open]);

  const maxPx = Math.max(MIN_PX, winH - TOP_GAP_PX);
  // A dragged height is capped by the window as it is now (F43), so a window made smaller after a drag does not
  // keep a drawer taller than the room under the top bar.
  const visiblePx = Math.min(maxPx, heightPx ?? Math.round(winH * DEFAULT_SHARE));
  const isMax = visiblePx >= maxPx - 1;

  const toggleMax = useCallback(() => {
    setHeightPx(h => (h !== null && h >= window.innerHeight - TOP_GAP_PX - 1 ? null : window.innerHeight - TOP_GAP_PX));
  }, []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { startY: e.clientY, startH: visiblePx, moved: false, h: visiblePx };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dy = d.startY - e.clientY;
    if (!d.moved && Math.abs(dy) < CLICK_SLOP_PX) return;
    if (!d.moved) { d.moved = true; setDragging(true); }
    // Below MIN_PX it keeps following the finger (so closing feels like a pull), but never past the top gap.
    // Written straight onto the element: no React render per finger movement.
    d.h = Math.max(40, Math.min(maxPx, d.startH + dy));
    const el = drawerRef.current;
    if (el) el.style.transform = `translateY(${maxPx - d.h}px)`;
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
    if (!d) return;
    if (!d.moved) { toggleMax(); return; }
    const h = d.startH + (d.startY - e.clientY);
    if (h < MIN_PX) { onClose(); return; }
    setHeightPx(d.h);
  };
  // WHY its own handler (final review F43): cancel used to run the DROP, so on Android a touch the
  // system took away mid-drag (a scroll, a gesture) could close the drawer or toggle full height.
  // A cancelled drag only stops following the finger, and never leaves the drawer below its minimum.
  const onPointerCancel = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
    if (d?.moved) setHeightPx(Math.max(MIN_PX, d.h));
  };
  // Keyboard: Enter/Space = the click; arrows nudge by a tenth of the window.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMax(); return; }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const step = Math.round(window.innerHeight / 10) * (e.key === 'ArrowUp' ? 1 : -1);
    setHeightPx(Math.max(MIN_PX, Math.min(maxPx, visiblePx + step)));
  };

  // Closed, it sits fully below the screen. While dragged it follows the finger at once; otherwise it eases.
  const style: CSSProperties = {
    height: `${maxPx}px`,
    transform: open ? `translateY(${maxPx - visiblePx}px)` : 'translateY(100%)',
    transitionDuration: dragging ? '0s' : undefined,
  };

  return {
    drawerRef,
    dragging,
    isMax,
    /** The drawer's style: full height, slid down so `visiblePx` of it shows. */
    style,
    /** How tall the shown part is. */
    visiblePx,
    /** How much of the drawer is below the screen's edge — the list inside is padded by this, so it ends on screen. */
    hiddenPx: maxPx - visiblePx,
    handleProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onKeyDown },
  };
}
