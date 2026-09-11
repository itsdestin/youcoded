import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTheme } from '../../state/theme-context';
import { useThemeMascot } from '../../hooks/useThemeMascot';
import { useAnyAttentionNeeded } from '../../hooks/useAnyAttentionNeeded';
import { MascotRig, type RigMotion } from '../mascot/MascotRig';
import type { PoseName } from '../mascot/mascot-poses';
import { defaultMascotPaint } from '../mascot/default-mascot-paint';

const DRAG_THRESHOLD_PX = 4;
// Drag velocity is normalized to the 80px buddy-window scale before feeding
// the limb springs (spec §5: k = 80/size × 2.4) so trailing feels identical
// at any render size (the buddy renders at 112px since the 2026-07-16 bump).
const DRAG_VELOCITY_GAIN = (80 / 112) * 2.4;
// Pointer-driven drag state. Anchor-based, in the mascot window's OWN
// coordinates: we capture the cursor's offset inside the mascot at pointerdown
// (grabOffsetX/Y from e.clientX/Y) and send, every pointermove, how far the
// cursor has strayed from it — (e.clientX - grabOffsetX, e.clientY -
// grabOffsetY). Main adds that to where it knows the window is. The cursor
// stays locked to the same pixel inside the mascot for the whole drag,
// regardless of HiDPI rounding, threshold deadzones, or edge-clamp
// rubber-banding, and nothing accumulates, so the per-move rounding drift that
// sank an early delta-based design on fractional-scale (125 / 150%) displays
// has nothing to compound into.
//
// WHY NOT e.screenX/Y, which this used until 2026-09-04: a renderer's screen
// coordinates are its window's origin plus the cursor's position inside it, and
// ON WAYLAND THAT ORIGIN NEVER UPDATES. Probe Round 8 moved the window to
// 500,300 then 900,600 then 200,150 and window.screenX read 0 every time — so
// each frame reported the cursor as having moved by exactly minus the distance
// the window had just travelled, and the buddy bounced between two points as
// fast as the pointer fired ("flickers all over the screen", Destin 2026-09-04).
//
// windowTravelX/Y is how far we have ASKED main to move the window since the
// drag began. Added back to e.clientX it reconstructs a screen position that is
// wrong by a constant (the window's unknown starting origin) but whose
// DIFFERENCES are exact — which is all totalTravel and the limb-spring velocity
// below ever look at. Without it both would read the cursor as motionless the
// moment the window starts following it.
interface DragState {
  grabOffsetX: number;
  grabOffsetY: number;
  // Overlay-only (see OverlayDrive below): offset of the pointer WITHIN the
  // mascot's own rendered box, captured via getBoundingClientRect at
  // pointerdown. Needed because in overlay mode the mascot is a DIV positioned
  // somewhere inside one screen-sized window, unlike the three-window model
  // where the window IS the mascot (so its own top-left is always (0,0) and
  // grabOffsetX/Y — captured from e.clientX/Y — already IS that offset).
  // Kept separate from grabOffsetX/Y rather than redefining them so the
  // legacy (non-overlay) path is untouched byte-for-byte.
  overlayOffsetX: number;
  overlayOffsetY: number;
  lastVirtualX: number;
  lastVirtualY: number;
  windowTravelX: number;
  windowTravelY: number;
  lastMoveTime: number;
  totalTravel: number;
  pointerId: number;
}

export interface MascotDockState { mode: 'free' | 'docked' | 'peeking'; edge: string | null; }

// Linux-Wayland overlay wiring (Task 6): when present, BuddyMascot drives
// drag/tap/dock through this instead of the three-window buddy IPC surface —
// BuddyOverlayApp owns the reducer and hosts mascot/chat/bar as DOM inside one
// transparent window, so there's no separate BrowserWindow for main to push
// buddy:mascot-state to or receive moveMascot/dragEnded/toggleChat from.
export interface OverlayDrive {
  /** Replaces the onMascotState subscription below — dock state lives in
   *  BuddyOverlayApp's reducer and is handed down as a prop instead. */
  dock: MascotDockState;
  /** Replaces the moveMascot IPC. Window-local (the coordinates rule) — the
   *  caller (BuddyOverlayApp) rAF-coalesces via the same pendingTargetRef
   *  machinery below, so this fires at most once per frame. */
  onDragMove(target: { x: number; y: number }): void;
  /** Replaces the dragEnded IPC (edge-snap/dock resolution happens in the
   *  reducer instead of main). */
  onDragEnd(): void;
  /** Replaces the toggleChat IPC. */
  onTap(): void;
}

export function BuddyMascot({ overlayDrive }: { overlayDrive?: OverlayDrive } = {}) {
  const attention = useAnyAttentionNeeded();
  const { theme, activeTheme, reducedEffects } = useTheme();

  // Mascot resolution order (spec §3.5): theme rig → theme flat art →
  // first-party default rig. Flat art is the legacy tier: it gets the
  // wrapper-level effects below but no limb trailing / blink / peek hands.
  const rigUrl = activeTheme?.mascot?.rig ?? null;
  const variantMascot = useThemeMascot(attention ? 'shocked' : 'idle');
  const welcomeMascot = useThemeMascot('welcome');
  const flatMascot = variantMascot ?? welcomeMascot;
  const useRig = !!rigUrl || !flatMascot;

  // Dock/peek state pushed from main (buddy:mascot-state). The sink/lean
  // transforms are data-attr driven via buddy.css so they CSS-transition.
  // In overlay mode this local copy is unused — `dock` below reads straight
  // from overlayDrive.dock (BuddyOverlayApp's reducer) instead.
  const [ipcDock, setIpcDock] = useState<MascotDockState>({ mode: 'free', edge: null });
  const dock = overlayDrive ? overlayDrive.dock : ipcDock;
  // Swing-out whip (spec §6.2): leaving a SIDE peek releases the −/+75° lean
  // through a short overshoot past vertical before settling at 0.
  const [swing, setSwing] = useState<'left' | 'right' | null>(null);
  const swingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const triggerSwing = useCallback((edge: 'left' | 'right') => {
    setSwing(edge);
    // Whip past vertical for ~230ms, then let the rotate transition settle to 0.
    if (swingTimerRef.current) clearTimeout(swingTimerRef.current);
    swingTimerRef.current = setTimeout(() => setSwing(null), 230);
  }, []);
  const prevDockRef = useRef<MascotDockState>({ mode: 'free', edge: null });
  useEffect(() => {
    // Overlay mode: dock comes from the overlayDrive prop (BuddyOverlayApp's
    // reducer), not this IPC push — skip the subscription entirely rather
    // than mounting a listener that will never fire in that mode.
    if (overlayDrive) return;
    const off = window.claude?.buddy?.onMascotState?.((s: MascotDockState) => {
      const prev = prevDockRef.current;
      prevDockRef.current = s;
      if (
        prev.mode === 'peeking' && (prev.edge === 'left' || prev.edge === 'right') &&
        s.mode !== 'peeking'
      ) {
        triggerSwing(prev.edge as 'left' | 'right');
      }
      setIpcDock(s);
    });
    return off;
  }, [triggerSwing, overlayDrive]);

  // Hover peek-out (Destin 2026-07-17): hovering a peeking buddy swings him OUT
  // of the edge and stands him up in idle for as long as the cursor stays over
  // his window; moving away sinks him smoothly back into peek. It's a transient
  // visual acknowledgement, not a dock-state change (only a CLICK brings him out
  // for real — that opens the chat, which engages the dock main-side), which is
  // why `hopping` lives here and not in the dock reducer. Hover-HELD, not timed:
  // he stays out while you're on him and returns the moment you leave, so it
  // never yanks him back under a resting cursor.
  const [hopping, setHopping] = useState(false);
  // Hover is only "armed" after a genuine pointer LEAVE. A press disarms it, so
  // when a drag drops the buddy into peek with the cursor still sitting on him,
  // the hover-swing-out does NOT fire immediately — otherwise you'd get
  // drag→peek → (release, cursor still there) → swing-out → (move away) → re-peek
  // (Destin 2026-07-17). He has to leave and come back before hovering pops him.
  const hoverArmedRef = useRef(true);
  const onPointerEnter = useCallback(() => {
    if (dock.mode !== 'peeking') return;
    if (!hoverArmedRef.current) return; // still holding the post-drag/press state
    // Side peeks whip upright through the lean on the way out; top/bottom slide.
    if (dock.edge === 'left' || dock.edge === 'right') triggerSwing(dock.edge);
    setHopping(true);
  }, [dock.mode, dock.edge, triggerSwing]);
  const onPointerLeave = useCallback(() => {
    hoverArmedRef.current = true; // a real leave — the next enter is a genuine hover
    setHopping(false);
  }, []);
  // Any dock change ends a hop — he's somewhere else now.
  useEffect(() => { setHopping(false); }, [dock.mode, dock.edge]);
  useEffect(() => () => {
    if (swingTimerRef.current) clearTimeout(swingTimerRef.current);
  }, []);

  const [grabbed, setGrabbed] = useState(false);

  // A hop temporarily renders him as if he were docked: sink released, peek
  // pose dropped, grip mittens gone. Everything downstream reads `peeking`
  // rather than dock.mode so the three can't disagree mid-hop.
  const peeking = dock.mode === 'peeking' && !hopping;
  const sidePeek = peeking && (dock.edge === 'left' || dock.edge === 'right');
  // Resting = 'idle' (open-eyed welcome face); the rig-authored chevron-eye
  // face lives in 'pressed', shown only while held (Destin 2026-07-16).
  const pose: PoseName = attention
    ? 'shocked'
    : peeking
      ? (dock.edge === 'left' ? 'peek-left' : dock.edge === 'right' ? 'peek-right' : 'peek')
      : grabbed
        ? 'pressed'
        : 'idle';
  const dragRef = useRef<DragState | null>(null);
  // Smoothed drag velocity for the rig's limb springs. A ref — pointermove-rate
  // React state would re-render 60×/s for nothing.
  const motionRef = useRef<RigMotion>({ vx: 0, vy: 0, dragging: false });
  const rigHostRef = useRef<HTMLDivElement>(null);

  // rAF-coalesce the moveMascot IPC. Without this, captured pointermoves on
  // high-refresh mice can fire faster than the display refresh — every extra
  // event per frame is one extra IPC main has to drain, and every frame it
  // processes an already-stale cursor position. "Squishy" lag under fast
  // drags. rAF throttling keeps at most one move in flight per frame, always
  // targeting the latest cursor position.
  // What it holds depends on the path: overlay mode a window-local POSITION,
  // three-window mode the cursor's OFFSET from the grab point (see DragState).
  const pendingTargetRef = useRef<{ x: number; y: number } | null>(null);
  const rafIdRef = useRef<number | null>(null);

  const flushPendingMove = useCallback(() => {
    rafIdRef.current = null;
    const target = pendingTargetRef.current;
    if (!target) return;
    pendingTargetRef.current = null;
    if (overlayDrive) { overlayDrive.onDragMove({ x: target.x, y: target.y }); return; }
    window.claude?.buddy?.moveMascot?.({ localDx: target.x, localDy: target.y });
    // Record what we just asked for, HERE and not in the pointermove handler:
    // several pointermoves can land in one frame and only this last one is
    // sent, so counting them all would double-count the window's travel.
    const st = dragRef.current;
    if (st) { st.windowTravelX += target.x; st.windowTravelY += target.y; }
  }, [overlayDrive]);

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

  const endDrag = useCallback((notifyMain: boolean) => {
    const wasDragging = !!dragRef.current && dragRef.current.totalTravel > DRAG_THRESHOLD_PX;
    dragRef.current = null;
    motionRef.current = { vx: 0, vy: 0, dragging: false };
    setGrabbed(false);
    // Snap detection runs main-side against final window bounds (spec §6.1).
    if (notifyMain && wasDragging) {
      if (overlayDrive) overlayDrive.onDragEnd();
      else window.claude?.buddy?.dragEnded?.();
    }
  }, [overlayDrive]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Disarm hover-swing-out for the duration of this press and until the
    // cursor next leaves (see hoverArmedRef): a drag that ends in peek must not
    // immediately pop back out just because the cursor is still on him.
    hoverArmedRef.current = false;
    // setPointerCapture keeps pointermove/up flowing even if the pointer
    // leaves the 80×80 window during a fast drag.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    // Overlay-only: the mascot's window-local offset within its own box —
    // see the DragState.overlayOffsetX/Y comment above.
    const rect = overlayDrive ? e.currentTarget.getBoundingClientRect() : null;
    dragRef.current = {
      // clientX/Y is the cursor's offset inside the mascot content area.
      // Captured once and held constant — this is the anchor the rest of
      // the drag rewinds to.
      grabOffsetX: e.clientX,
      grabOffsetY: e.clientY,
      overlayOffsetX: rect ? e.clientX - rect.left : 0,
      overlayOffsetY: rect ? e.clientY - rect.top : 0,
      lastVirtualX: e.clientX,
      lastVirtualY: e.clientY,
      windowTravelX: 0,
      windowTravelY: 0,
      lastMoveTime: performance.now(),
      totalTravel: 0,
      pointerId: e.pointerId,
    };
    setGrabbed(true);
  }, [overlayDrive]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragRef.current;
    if (!st) return;
    // Cursor position reconstructed in a frame that does not move with the
    // window (see DragState) — the only thing here that may be differenced.
    const virtualX = st.windowTravelX + e.clientX;
    const virtualY = st.windowTravelY + e.clientY;
    const dx = virtualX - st.lastVirtualX;
    const dy = virtualY - st.lastVirtualY;
    if (dx === 0 && dy === 0) return;
    const now = performance.now();
    const dt = Math.max(1, now - st.lastMoveTime);
    st.lastVirtualX = virtualX;
    st.lastVirtualY = virtualY;
    st.lastMoveTime = now;
    st.totalTravel += Math.abs(dx) + Math.abs(dy);
    // Only start forwarding moves once we've crossed the click-vs-drag
    // threshold, so a jittery click doesn't nudge the window by a pixel.
    if (st.totalTravel > DRAG_THRESHOLD_PX) {
      // Exponentially smoothed velocity in px/frame (16ms), normalized for
      // the limb springs (spec §5); decay while held runs in the rig's loop.
      const m = motionRef.current;
      m.dragging = true;
      m.vx = 0.7 * m.vx + 0.3 * (dx / dt) * 16 * DRAG_VELOCITY_GAIN;
      m.vy = 0.7 * m.vy + 0.3 * (dy / dt) * 16 * DRAG_VELOCITY_GAIN;
      // Both paths are window-local, and both are recomputed from scratch
      // against the anchor captured at pointerdown — nothing accumulates.
      // Overlay mode wants a POSITION inside its screen-sized window (the
      // coordinates rule: the reducer clamps against a window-local workArea);
      // three-window mode wants the cursor's OFFSET from the grab point, which
      // main turns into a screen position using the window position it owns.
      // Schedule (don't fire) — rAF coalesces multiple moves within a frame to
      // the latest one so we don't queue stale positions behind main.
      pendingTargetRef.current = overlayDrive
        ? { x: e.clientX - st.overlayOffsetX, y: e.clientY - st.overlayOffsetY }
        : { x: e.clientX - st.grabOffsetX, y: e.clientY - st.grabOffsetY };
      if (rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame(flushPendingMove);
      }
    }
  }, [flushPendingMove, overlayDrive]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Flush any unsent move synchronously before release — otherwise the
    // mascot ends one frame behind the cursor's final resting position.
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    flushPendingMove(); // one path for sending, so windowTravel stays honest

    const st = dragRef.current;
    const wasClick = !!st && st.totalTravel <= DRAG_THRESHOLD_PX;
    if (st) { try { e.currentTarget.releasePointerCapture(st.pointerId); } catch { /* ignore */ } }
    endDrag(true);
    if (wasClick) {
      if (overlayDrive) overlayDrive.onTap();
      else if (window.claude?.buddy?.toggleChat) window.claude.buddy.toggleChat();
    }
  }, [flushPendingMove, endDrag, overlayDrive]);

  // Safety net for "stuck being dragged": if the OS revokes pointer capture
  // (system modal, focus loss mid-drag) or a touch/pen device synthesizes
  // pointercancel instead of pointerup, pointerup never fires on this
  // window — without these handlers, dragRef stays set and subsequent
  // pointermoves over the mascot would keep dragging it after the button
  // was already released.
  const onLostPointerCapture = useCallback(() => { cancelPendingMove(); endDrag(true); }, [cancelPendingMove, endDrag]);
  const onPointerCancel = useCallback(() => { cancelPendingMove(); endDrag(true); }, [cancelPendingMove, endDrag]);

  return (
    <div
      className={[
        'mascot-wrap',
        grabbed ? 'mascot-grabbed' : '',
        // Flat art has no rig-root idle loop — it breathes at the wrapper.
        // Rigs breathe internally (MascotRig motion-style loop); double-
        // breathing would compound the translate.
        !useRig && !reducedEffects && !grabbed && !peeking ? 'mascot-breathing' : '',
      ].filter(Boolean).join(' ')}
      style={{
        // 112px window (main.ts buddyDimensions) — sized up 40% per Destin.
        width: 112,
        height: 112,
        // NOTE: we deliberately do NOT set -webkit-app-region: drag here.
        // On Windows, Electron implements drag regions via WM_NCHITTEST →
        // HTCAPTION, which makes the OS consume ALL pointer events for
        // window dragging — pointerdown/up never reach React and the click
        // handler never fires. Instead we drive drag ourselves via the
        // buddy.moveMascot IPC (main-process setPosition with clamping).
        cursor: grabbed ? 'grabbing' : 'grab',
        background: 'transparent',
        // touchAction: 'none' lets us capture the pointer cleanly without
        // the browser's default scroll/pan gestures interfering.
        touchAction: 'none',
        // WHY: default rig paints fall back to yellow until this mascot-window
        // wrapper supplies the same theme tint contract as every other rig host.
        // Custom rigs with authored fills do not read these variables.
        ['--rig-accent' as string]: 'var(--accent)',
        ['--rig-on-accent' as string]: 'var(--on-accent)',
        ['--rig-line' as string]: 'var(--fg)',
        // WHY: default-only variables also reach cloned PeekHands and fetch-failure
        // fallback art, without changing authored rigs' --rig-* token mapping.
        ...defaultMascotPaint(theme),
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onLostPointerCapture={onLostPointerCapture}
      onPointerCancel={onPointerCancel}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {/* Sink layer: dock/peek transforms + the side-peek lean (independent
          `rotate` so it composes with the wrapper's hover/grab `scale` and
          the flat-art breathing `translate`). data-attrs → buddy.css. */}
      <div
        className="mascot-sink"
        // During a hover-hop force 'free' so the sink transform RELEASES and he
        // swings out of the edge — `dock.mode` is still 'peeking' mid-hop (hover
        // doesn't touch dock state), so the old `peeking ? 'peeking' : dock.mode`
        // kept him pinned in the sunk position and only the pose changed (Destin
        // 2026-07-17: "swaps between peek and idle despite staying in the same
        // position"). The 380ms transform+rotate transitions carry the move.
        data-dock-mode={hopping ? 'free' : dock.mode}
        data-dock-edge={dock.edge ?? ''}
        data-swing={swing ?? ''}
      >
        {/* Lean layer: the side-peek ∓75° body lean lives on its OWN element
            INSIDE the sink translate — CSS resolves an element's `rotate`
            property BEFORE its `transform`, so rotate+translate on one element
            would swing the already-translated body around the stale center
            and out of the window (prototype splits the layers the same way). */}
        <div className="mascot-lean" style={{ width: '100%', height: '100%' }}>
          {/* WHY: toggling the class restarts the attention bounce without a key
              remount throwing away the rig's springs and the host PeekHands observes. */}
          <div className={attention && !reducedEffects ? 'mascot-bounce' : ''} style={{ width: '100%', height: '100%' }}>
            {useRig ? (
              <div ref={rigHostRef} style={{ width: '100%', height: '100%' }}>
                <MascotRig svgUrl={rigUrl} pose={pose} motionRef={motionRef} reducedEffects={reducedEffects} />
              </div>
            ) : (
              <img
                src={flatMascot!}
                alt=""
                style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
                // Dragging an <img> would otherwise start an HTML drag. Disable.
                draggable={false}
              />
            )}
          </div>
        </div>
      </div>
      {/* Side-peek grip mittens: pinned at the window's edge-side boundary,
          OUTSIDE the sink/lean transforms — the hands stay planted on the
          screen edge while the body sags between them (spec §6.2 "75° wider").
          Rig-only; flat art degrades to the sink alone. */}
      {useRig && sidePeek && (
        // key on the rig URL so a theme switch REMOUNTS the hands (handSvg
        // resets to null) instead of leaving the new mascot wearing the old
        // theme's mittens — see PeekHands (Destin 2026-07-17).
        <PeekHands key={rigUrl ?? 'default'} side={dock.edge as 'left' | 'right'} rigHostRef={rigHostRef} />
      )}
    </div>
  );
}

/**
 * Clones the rig's `rig-hand-peek-<side>` mitten art into two edge-pinned
 * overlay SVGs (staggered grips, slight opposing tilts — the approved "75°
 * wider" staging: grip gap ≈ 0.73 × mascot size). Renders nothing when the
 * rig has no peek-hand group — sink-only degradation per the plan.
 */
function PeekHands({ side, rigHostRef }: { side: 'left' | 'right'; rigHostRef: React.RefObject<HTMLDivElement | null> }) {
  const [handSvg, setHandSvg] = useState<string | null>(null);

  // Re-extract the mitten art whenever the rig svg inside the host changes.
  // A theme switch swaps a whole new rig into rigHostRef WITHOUT this
  // component's props changing, so the old one-shot extraction left the NEW
  // mascot wearing the OLD theme's hands (Destin 2026-07-17). A MutationObserver
  // on the stable host catches BOTH the async first load (boot into a persisted
  // peek) and every later theme swap. The call site also keys us on rigUrl, so
  // handSvg resets to null on switch — a new rig that happens to lack peek hands
  // then degrades to the sink alone instead of bleeding the previous hands.
  useEffect(() => {
    const host = rigHostRef.current;
    if (!host) return;
    let cancelled = false;
    const extract = () => {
      if (cancelled) return;
      const svg = host.querySelector('svg');
      const hand = svg?.querySelector<SVGGElement>(`#rig-hand-peek-${side}`) ?? null;
      // Rig not landed yet, or this rig has no mittens — leave whatever we have;
      // the observer fires again on the next DOM change (e.g. the rig landing).
      if (!svg || !hand) return;
      // The hand group ships display:none (only this overlay shows it). getBBox
      // needs a rendered box — flip display on synchronously, measure, flip
      // back; no paint happens inside one JS task. We observe childList only
      // (not attributes), so this flip can't re-trigger the observer.
      const prevDisplay = hand.style.display;
      hand.style.display = '';
      let bbox: DOMRect | null = null;
      try { bbox = hand.getBBox(); } catch { /* detached/unrenderable — skip */ }
      hand.style.display = prevDisplay;
      if (!bbox || !bbox.width || !bbox.height) return;
      const clone = hand.cloneNode(true) as SVGGElement;
      clone.style.display = '';
      clone.removeAttribute('id'); // no duplicate ids in the document
      const pad = 0.4; // breathing room for the stroke
      // Content comes from the already-sanitized inlined rig — safe to re-inline.
      setHandSvg(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bbox.x - pad} ${bbox.y - pad} ${bbox.width + pad * 2} ${bbox.height + pad * 2}" width="100%" height="100%">${clone.outerHTML}</svg>`,
      );
    };
    extract(); // the rig may already be present (peek toggled with a stable rig)
    const obs = new MutationObserver(extract);
    obs.observe(host, { childList: true, subtree: true });
    return () => { cancelled = true; obs.disconnect(); };
  }, [side, rigHostRef]);

  if (!handSvg) return null;
  // Grip geometry in fractions of the buddy window. Mittens are ~17% tall
  // (bumped from 15% — Destin 2026-07-17 wanted them slightly taller); width
  // stays 15% and the art meet-fits inside, so it reads as a small vertical
  // grow. Centered on centerFrac; the two centers sit at mid ± gap/2, gap 0.73.
  const H = 0.17;
  const mitten = (centerFrac: number, tilt: number) => (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        [side]: 0,
        top: `${(centerFrac - H / 2) * 100}%`,
        width: '15%',
        height: `${H * 100}%`,
        rotate: `${tilt}deg`,
        pointerEvents: 'none',
      }}
      dangerouslySetInnerHTML={{ __html: handSvg }}
    />
  );
  // Straddle the BODY, not the window. The leaning body's face sits at ~0.39 of
  // the window height (0.5 minus the -11% peek up-shift in buddy.css), so the
  // two mittens must center on 0.39 — centering on 0.5 rode the whole grip low
  // and floated the bottom hand well beneath the compact leaning body (Destin
  // 2026-07-17: "the body should be right between the hands"). Half-gap pulled
  // in from 0.365 too: at the old width, re-centering on 0.39 would shove the
  // top mitten off the top edge (0.39 − 0.365 − H/2 < 0).
  // Grip center sits a touch BELOW the body's face (~0.39) — Destin wanted the
  // pair shifted down slightly from dead-centered, so the head leans up and out
  // over the top hand. Shifting down also buys top-edge headroom, which is what
  // lets the gap widen past the old 0.30 ceiling without the top mitten
  // clipping (top edge = GRIP_CENTER − HALF_GAP − H/2 must stay ≥ 0).
  const GRIP_CENTER = 0.46;
  const HALF_GAP = 0.34;
  return (
    <>
      {mitten(GRIP_CENTER - HALF_GAP, side === 'right' ? -4 : 4)}
      {mitten(GRIP_CENTER + HALF_GAP, side === 'right' ? 4 : -4)}
    </>
  );
}
