// The right-hand pane — Session Files or Games — and the glide between its states.
// One component for BOTH homes of the pane: ChatView's framed-shell, and
// TerminalRightSlot's clone of it. What is shown and what room is reserved is
// decided by state/right-pane-motion.ts (App owns it); this file only MOVES the
// pane's visible edge to match, and reports back when it has.
//
// Destin, 2026-09-18: "i want the animation to smoothly handle open/close and
// switching between differently sized game/file panels" — "interruptible and
// smooth ... aware of performance".
//
// HOW IT MOVES: the pane's box is already the size the layout reserved (the
// reducer reserves first when growing and releases last when shrinking), so the
// motion is a `clip-path: inset()` on the pane's LEFT edge plus opacity. Neither
// lays anything out, inside the pane or outside it.
//   • NOT a transform: `.drawer-pane` is overflow-hidden with `.layer-surface`
//     children, and a transform-animating parent of those is the paint bug this
//     repo shipped twice on Windows Electron (516411a5, 1f68a7f0).
//   • NOT a width: the pane is a flex sibling of the chat, so its width re-wraps
//     the whole transcript, and doing that per frame is the measured stutter.
//   • The Web Animations API, not a CSS class: every step starts FROM WHERE THE
//     PANE IS (read off the computed style before the running animation is
//     cancelled), which is what makes a second click mid-glide a reversal rather
//     than a jump — and nothing is left on the element afterwards, so the pane is
//     not a permanent clip-path stacking context / backdrop root.
// Guards: RightPaneSlot.test.tsx (the view), right-pane-motion.test.ts (the table).
import React, { useLayoutEffect, useRef } from 'react';
import { ArtifactProvider, useArtifactOptional } from '../state/ArtifactContext';
import { paneContentWidth } from '../state/right-pane-motion';
import type { RightPane } from '../hooks/use-right-pane-motion';

interface Props {
  pane: RightPane;
  sessionId: string;
  /** App's one GamePanel element; App keeps it alive while the game pane leaves. */
  gamePane: React.ReactNode;
  renderDrawer: () => React.ReactNode;
}

interface Visual { inset: number; opacity: number }
const REST: Visual = { inset: 0, opacity: 1 };

/** Both gates, as everywhere: the OS preference and the app's own toggle. */
function motionOff(): boolean {
  return document.documentElement.hasAttribute('data-reduced-effects')
    || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/** Where the pane visibly IS right now — mid-glide included. */
function currentVisual(el: HTMLElement): Visual {
  const cs = getComputedStyle(el);
  // Computed form: inset(0px 0px 0px 123.4px round 12px) — the 4th length is left.
  const m = /inset\(\s*\S+\s+\S+\s+\S+\s+(-?[\d.]+)px/.exec(cs.clipPath || '');
  const opacity = parseFloat(cs.opacity);
  return { inset: m ? parseFloat(m[1]) : 0, opacity: Number.isFinite(opacity) ? opacity : 1 };
}

function ms(v: string, fallback: number): number {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return v.trim().endsWith('ms') ? n : n * 1000;
}

const NOOP_DISPATCH = () => {};

export function RightPaneSlot({ pane, sessionId, gamePane, renderDrawer }: Props) {
  const { motion, onExited, onSettled } = pane;
  const { shown, closing, from, opening } = motion;
  const paneRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const running = useRef<Animation | null>(null);
  /** True while a finished, fill-forwards glide is HOLDING the pane clipped until
   *  the table releases the room — that state is not "somewhere to glide from". */
  const holding = useRef(false);
  const lastContentWidth = useRef(0);

  // FROZEN CONTENTS WHILE THE FILES PANE LEAVES. Closing it wipes the open file and
  // the expanded flag in the same action (artifact-tracker.ts, DRAWER_CLOSED — and
  // a dozen call sites plus the unsaved-edits guard dispatch it), so the pane would
  // glide out showing an empty list. It renders against the last state it had while
  // open instead, with a dispatch that does nothing: the pane is `inert` for those
  // 260 ms, so nothing in it can be pressed anyway.
  // (Optional: a root with no provider — a unit test of the slot's host — still renders.)
  const live = useArtifactOptional();
  const lastOpen = useRef(live);
  if (live && !closing && live.state.drawerOpenBySession[sessionId]) lastOpen.current = live;

  useLayoutEffect(() => {
    const el = paneRef.current;
    if (!el || !shown) return;
    const box = el.offsetWidth;
    const contentWidth = contentRef.current?.offsetWidth || box;
    const previousWidth = lastContentWidth.current || contentWidth;
    lastContentWidth.current = contentWidth;

    const active = running.current;
    const here = active ? currentVisual(el) : REST;
    let start: Visual = here;
    let end: Visual = REST;
    let done: (() => void) | null = null;
    let hold = false;

    if (closing) {
      end = { inset: box, opacity: 0 };
      done = onExited;
      hold = true;                       // stay gone until the table unmounts it
    } else if (from) {
      if (box > contentWidth + 0.5) {
        // Shrinking: the room is still the old, wider pane's. Glide the edge in to
        // the new pane's width, THEN the table releases the room (one re-wrap).
        end = { inset: box - contentWidth, opacity: 1 };
        hold = true;
      } else if (!active) {
        // Growing: the room is already the new width. Start at the old edge.
        start = { inset: Math.max(0, box - previousWidth), opacity: 1 };
      }
      done = onSettled;
    } else if (opening) {
      if (!active) start = { inset: box, opacity: 0 };
      done = onSettled;
    } else if (!active || holding.current) {
      // At rest. A held glide's room was just released: drop the clip, no motion.
      active?.cancel();
      running.current = null;
      holding.current = false;
      return;
    }
    // (else: a close was interrupted — glide back to rest from wherever it is.)

    active?.cancel();
    running.current = null;
    holding.current = false;
    if (motionOff() || typeof el.animate !== 'function') { done?.(); return; }

    const cs = getComputedStyle(el);
    const round = cs.borderTopLeftRadius || '0px';
    const frame = (v: Visual) => ({ clipPath: `inset(0px 0px 0px ${v.inset}px round ${round})`, opacity: v.opacity });
    const a = el.animate([frame(start), frame(end)], {
      duration: ms(cs.getPropertyValue('--dur-reveal'), 260),
      easing: cs.getPropertyValue('--ease-out').trim() || 'ease-out',
      fill: hold ? 'forwards' : 'none',
    });
    running.current = a;
    a.onfinish = () => {
      if (running.current !== a) return;
      if (hold) holding.current = true; else running.current = null;
      done?.();
    };
    // The callbacks come from a memoised object keyed on `motion`; listing them
    // would re-run this on nothing new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, closing, from, opening]);

  useLayoutEffect(() => () => { running.current?.cancel(); }, []);

  if (!shown) return null;
  const drawer = shown === 'drawer';
  // Laid out at its OWN width while the room is wider than it (a switch to the
  // narrower pane), so it never lays out wide and snaps narrow; 100% otherwise, so
  // the expanded drawer and the phone-width full-screen pane are untouched.
  const constrained = from !== null;
  const contentStyle = constrained
    ? ({ width: `min(100%, ${paneContentWidth(shown)})`, ['--right-pane-width' as string]: paneContentWidth(shown) } as React.CSSProperties)
    : undefined;
  const body = drawer ? renderDrawer() : gamePane;
  return (
    <>
      <div className="frame-divider" />
      <div ref={paneRef} className={`drawer-pane${drawer ? '' : ' game-pane'}`} inert={closing || undefined}>
        <div ref={contentRef} className="right-pane-content" style={contentStyle}>
          {/* ALWAYS wrapped, live or frozen: wrapping only while closing would change
              the tree's shape at that moment and REMOUNT the drawer — a reset of its
              scroll and editor on the very frame it starts to leave. */}
          {drawer && live
            ? <ArtifactProvider value={closing && lastOpen.current ? { state: lastOpen.current.state, dispatch: NOOP_DISPATCH } : live}>{body}</ArtifactProvider>
            : body}
        </div>
      </div>
    </>
  );
}
