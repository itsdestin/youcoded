import React, { useContext } from 'react';
import { Button } from './ui/Button';

/** How the button moves while the turn is working. Three candidates are under
 *  review (docs/active/design/2026-09-10-stop-button-alive/); the workbench's
 *  compare view mounts one pane per value, the same way VoiceStyleContext lets
 *  the mic's motions sit side by side. The context default is what the app shows. */
export type StopMotion = 'halo' | 'orbit' | 'glow';
// 'glow' picked on the live deck (L-1, 2026-09-10); halo/orbit stay reachable only
// through the workbench compare view's round-1 record, like the mic's alternatives.
export const StopMotionContext = React.createContext<StopMotion>('glow');

interface StopButtonProps {
  sessionId: string;
  /** Same provider union ChatView threads down — determines which IPC call
   *  actually interrupts the turn. */
  provider?: 'claude' | 'native';
  /** Caller-computed visibility. The only caller is InputBar, which passes
   *  `useStreamingGate(sessionId)` — true while a turn is in flight and has
   *  not ENDED. Note it stays true through the stall warning and the parked
   *  "Provider may have stalled" card: those turns are still running, and a
   *  phone user with no ESC key needs the way out most precisely then (see
   *  useStreamingGate.ts for the full reasoning). Extracted as a prop (rather
   *  than computed here) so this component stays a pure function of its inputs
   *  and is testable without mounting a provider tree. */
  visible: boolean;
  /** True while the turn is actually WORKING — `useTurnIsWorking(sessionId)`.
   *  Separate from `visible` on purpose (questions deck, 2026-09-10): the button
   *  must stay reachable through a stall and a permission ask, but its motion
   *  says "busy", so it holds still whenever the assistant is stuck (Q-1) or
   *  waiting on you (Q-2). A still-but-visible button is the honest middle. */
  live?: boolean;
}

/**
 * Visible interrupt control for a streaming turn.
 *
 * Before this, ESC was the ONLY way to interrupt a turn (App.tsx's global
 * keydown handler) — no affordance existed for touch/phone-remote users, who
 * have no ESC key. This gives them one.
 *
 * Click behavior mirrors the ESC handler exactly (App.tsx ~2305-2315): native
 * sessions have no PTY, so interrupt the in-process harness stream directly;
 * Claude Code sessions get the same single ESC byte the physical key sends.
 */
export default function StopButton({ sessionId, provider, visible, live = false }: StopButtonProps) {
  const motion = useContext(StopMotionContext);
  if (!visible) return null;
  return (
    <Button
      size="icon"
      aria-label="Stop generating"
      onClick={() => {
        if (provider === 'native') window.claude.native.interrupt(sessionId);
        else window.claude.session.sendInput(sessionId, '\x1b');
      }}
      // WHY round (deck Q-3, 2026-09-10): Stop and Send were two identical filled
      // squares side by side. Round tells them apart even with motion off, and
      // matches the mic — the other control in the box that shows something live.
      // `relative` anchors the orbit candidate's ring (a ::before outside the box).
      // Motion classes live in globals.css beside the mic's, with both
      // Reduced-Effects gates.
      // WHY 24px, not size="icon"'s 28 (live deck L-1, 2026-09-10: "make the button
      // and glow circumference a bit smaller"). w-/h- replace the size's classes via
      // mergeClasses; `coarse-hit` stays, so the touch target does not shrink.
      className={`relative shrink-0 rounded-full w-6 h-6 ${live ? `stop-live stop-live--${motion}` : ''}`}
      data-live={live ? 'true' : 'false'}
    >
      {/* Square stop glyph, currentColor — same inline-svg-in-Button pattern
          as the send button's arrow (InputBar.tsx). */}
      <svg className="w-2.5 h-2.5 text-on-accent" viewBox="0 0 24 24" fill="currentColor">
        <rect x="6" y="6" width="12" height="12" rx="1.5" />
      </svg>
    </Button>
  );
}
