// App's handle on the right pane's motion table (state/right-pane-motion.ts).
import { useEffect, useMemo, useState } from 'react';
import { paneMotionReducer, PANE_IDLE, type PaneKind, type PaneMotion } from '../state/right-pane-motion';

export interface RightPane {
  motion: PaneMotion;
  /** The view calls these when its glide finishes. */
  onExited: () => void;
  onSettled: () => void;
}

/** How long the table waits for the view before finishing a step ITSELF.
 *
 *  WHY it must exist: the pane's view is not always mounted — Android's terminal
 *  view renders no right slot at all, and a view can unmount mid-glide (a session
 *  switch). With no one to report back, a close would leave the room reserved and
 *  the frosted frame cut out for a pane that is not there, for the rest of the
 *  session. Comfortably past --dur-reveal (260ms), so a real glide always wins. */
export const PANE_MOTION_SAFETY_MS = 700;

export function useRightPaneMotion(wanted: PaneKind | null): RightPane {
  const [motion, setMotion] = useState<PaneMotion>(() =>
    // Already open at mount (a restored session): shown, and NOT "opening" —
    // nothing opened, so nothing should glide.
    wanted ? { ...PANE_IDLE, shown: wanted } : PANE_IDLE);
  const [seen, setSeen] = useState(wanted);

  // Derived DURING RENDER, not in an effect — the same pattern and the same
  // reason as use-one-shot-window.ts. Closing the Files pane wipes its contents
  // in the very action that closes it; an effect would commit one frame in which
  // the pane still reads as open while its contents are already gone, which is
  // exactly the frame the view freezes the contents against.
  if (seen !== wanted) {
    setSeen(wanted);
    setMotion(paneMotionReducer(motion, { type: 'want', kind: wanted }));
  }

  const inFlight = motion.closing ? 'exited' : (motion.from !== null || motion.opening) ? 'settled' : null;
  useEffect(() => {
    if (!inFlight) return;
    const t = setTimeout(() => setMotion((m) => paneMotionReducer(m, { type: inFlight })), PANE_MOTION_SAFETY_MS);
    return () => clearTimeout(t);
    // `motion` on purpose: any new step restarts the clock.
  }, [inFlight, motion]);

  // A stable object while nothing changes — ChatView is memoised on its props.
  return useMemo(() => ({
    motion,
    onExited: () => setMotion((m) => paneMotionReducer(m, { type: 'exited' })),
    onSettled: () => setMotion((m) => paneMotionReducer(m, { type: 'settled' })),
  }), [motion]);
}
