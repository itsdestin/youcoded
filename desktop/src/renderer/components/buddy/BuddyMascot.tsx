import { useCallback, useEffect, useRef } from 'react';
import type { MascotVariant } from '../../themes/theme-types';
import { useThemeMascot } from '../../hooks/useThemeMascot';
import { useAnyAttentionNeeded } from '../../hooks/useAnyAttentionNeeded';
import { WelcomeAppIcon } from '../Icons';

const DRAG_THRESHOLD_PX = 4;

// Pointer-driven drag state. Anchor-based: we capture the cursor's offset
// inside the 80×80 mascot at pointerdown (grabOffsetX/Y from e.clientX/Y)
// and recompute the absolute target on every pointermove as
// (e.screenX - grabOffsetX, e.screenY - grabOffsetY). This keeps the cursor
// locked to the same pixel inside the mascot for the full drag, regardless
// of HiDPI rounding, threshold deadzones, or edge-clamp rubber-banding.
// A prior delta-based design caused visible drift on fractional-scale
// (125 / 150%) Windows displays because each round-tripped dx/dy rounded
// independently and the residual compounded. lastScreenX/Y + totalTravel
// are only used to distinguish a genuine drag from a jittery click.
interface DragState {
  grabOffsetX: number;
  grabOffsetY: number;
  lastScreenX: number;
  lastScreenY: number;
  totalTravel: number;
  pointerId: number;
}

export function BuddyMascot() {
  const attention = useAnyAttentionNeeded();
  // When attention is needed, use the theme's 'shocked' variant. When idle,
  // use the standard 'idle' variant. If the active theme only ships a
  // 'welcome' mascot (very common — main's launch screen uses it) fall
  // through to that so every theme gets a themed mascot instead of a cat
  // emoji. Themes that ship neither fall through to the YouCoded-branded
  // <WelcomeAppIcon/> SVG, which picks up the theme's text-fg-dim color.
  const variant: MascotVariant = attention ? 'shocked' : 'idle';
  const variantMascot = useThemeMascot(variant);
  const welcomeMascot = useThemeMascot('welcome');
  const customMascot = variantMascot ?? welcomeMascot;

  const dragRef = useRef<DragState | null>(null);
  // rAF-coalesce the moveMascot IPC. Without this, captured pointermoves on
  // high-refresh mice can fire faster than the display refresh — every extra
  // event per frame is one extra IPC main has to drain, and every frame it
  // processes an already-stale cursor position. "Squishy" lag under fast
  // drags. rAF throttling keeps at most one move in flight per frame, always
  // targeting the latest cursor position.
  const pendingTargetRef = useRef<{ targetX: number; targetY: number } | null>(null);
  const rafIdRef = useRef<number | null>(null);

  const flushPendingMove = useCallback(() => {
    rafIdRef.current = null;
    const target = pendingTargetRef.current;
    if (!target) return;
    pendingTargetRef.current = null;
    window.claude?.buddy?.moveMascot?.(target);
  }, []);

  const cancelPendingMove = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    pendingTargetRef.current = null;
  }, []);

  // Drop any unflushed frame on unmount so a torn-down component can't keep
  // firing IPCs via a stranded rAF callback.
  useEffect(() => cancelPendingMove, [cancelPendingMove]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // setPointerCapture keeps pointermove/up flowing even if the pointer
    // leaves the 80×80 window during a fast drag.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    dragRef.current = {
      // clientX/Y is the cursor's offset inside the mascot content area.
      // Captured once and held constant — this is the anchor the rest of
      // the drag rewinds to.
      grabOffsetX: e.clientX,
      grabOffsetY: e.clientY,
      lastScreenX: e.screenX,
      lastScreenY: e.screenY,
      totalTravel: 0,
      pointerId: e.pointerId,
    };
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragRef.current;
    if (!st) return;
    const dx = e.screenX - st.lastScreenX;
    const dy = e.screenY - st.lastScreenY;
    if (dx === 0 && dy === 0) return;
    st.lastScreenX = e.screenX;
    st.lastScreenY = e.screenY;
    st.totalTravel += Math.abs(dx) + Math.abs(dy);
    // Only start forwarding moves once we've crossed the click-vs-drag
    // threshold, so a jittery click doesn't nudge the window by a pixel.
    if (st.totalTravel > DRAG_THRESHOLD_PX) {
      // Absolute target in screen coords: cursor position minus the offset
      // captured at pointerdown. Main clamps and rounds once. Schedule
      // (don't fire) — rAF coalesces multiple moves within a frame to the
      // latest target so we don't queue stale positions behind main.
      pendingTargetRef.current = {
        targetX: e.screenX - st.grabOffsetX,
        targetY: e.screenY - st.grabOffsetY,
      };
      if (rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame(flushPendingMove);
      }
    }
  }, [flushPendingMove]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Flush any unsent move synchronously before release — otherwise the
    // mascot ends one frame behind the cursor's final resting position.
    const pending = pendingTargetRef.current;
    cancelPendingMove();
    if (pending) window.claude?.buddy?.moveMascot?.(pending);

    const st = dragRef.current;
    dragRef.current = null;
    if (!st) return;
    try { e.currentTarget.releasePointerCapture(st.pointerId); } catch { /* ignore */ }
    if (st.totalTravel <= DRAG_THRESHOLD_PX && window.claude?.buddy?.toggleChat) {
      window.claude.buddy.toggleChat();
    }
  }, [cancelPendingMove]);

  // Safety net for "stuck being dragged": if the OS revokes pointer capture
  // (system modal, focus loss mid-drag) or a touch/pen device synthesizes
  // pointercancel instead of pointerup, pointerup never fires on this
  // window — without these handlers, dragRef stays set and subsequent
  // pointermoves over the mascot would keep dragging it after the button
  // was already released.
  const onLostPointerCapture = useCallback(() => {
    cancelPendingMove();
    dragRef.current = null;
  }, [cancelPendingMove]);

  const onPointerCancel = useCallback(() => {
    cancelPendingMove();
    dragRef.current = null;
  }, [cancelPendingMove]);

  return (
    <div
      style={{
        width: 80,
        height: 80,
        // NOTE: we deliberately do NOT set -webkit-app-region: drag here.
        // On Windows, Electron implements drag regions via WM_NCHITTEST →
        // HTCAPTION, which makes the OS consume ALL pointer events for
        // window dragging — pointerdown/up never reach React and the click
        // handler never fires. Instead we drive drag ourselves via the
        // buddy.moveMascot IPC (main-process setPosition with clamping).
        cursor: 'grab',
        background: 'transparent',
        // touchAction: 'none' lets us capture the pointer cleanly without
        // the browser's default scroll/pan gestures interfering.
        touchAction: 'none',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onLostPointerCapture={onLostPointerCapture}
      onPointerCancel={onPointerCancel}
    >
      {customMascot ? (
        <img
          src={customMascot}
          alt=""
          style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
          // Dragging an <img> would otherwise start an HTML drag. Disable.
          draggable={false}
        />
      ) : (
        // Final fallback: the YouCoded-branded glyph. `text-fg-dim` picks up
        // the active theme's dimmed foreground color, so the icon tints to
        // whatever theme is active — no cat emoji. Pointer-events none so
        // clicks reach the parent drag-handler div.
        // For the attention/shocked state, wrap in a soft pulse so the
        // fallback still signals "something needs you" without shipping
        // per-theme artwork.
        <WelcomeAppIcon
          className={`w-full h-full text-fg-dim${attention ? ' animate-pulse' : ''}`}
        />
      )}
    </div>
  );
}
