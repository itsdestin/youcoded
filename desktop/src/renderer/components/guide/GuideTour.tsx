// src/renderer/components/guide/GuideTour.tsx
//
// The tour: walks GUIDE_STOPS with Back / Next / Skip on the buddy's bubble,
// asks the app to open each stop's screen, rings the stop's control, and offers
// "Do it now" where a stop has an action. It owns only the index; what "open
// the Projects screen" means is App.tsx's business, passed in as callbacks, so
// the tour cannot drift from how the app really opens things.
//
// Decided 2026-09-10 (deck Q-1 corner bubble, Q-2 once after setup, Q-3
// explain with a button, S-1 the eight stops; Destin's note: open the real
// screens as it talks).
import React, { useCallback, useEffect, useState } from 'react';
import GuideBubble, { type GuideBubbleButton } from './GuideBubble';
import GuideRing, { findGuideAnchor } from './GuideRing';
import { GUIDE_STOPS, type GuideAction, type GuideScreen, type GuideStop } from './guide-stops';

interface Props {
  stops?: readonly GuideStop[];
  /** Open (or return to) a screen. Called on every stop, including a Back. */
  onOpenScreen: (screen: GuideScreen) => void;
  /** `done` is true on the last Next, false on Skip. */
  onExit: (done: boolean) => void;
  onMarketplace?: () => void;
}

export default function GuideTour({ stops = GUIDE_STOPS, onOpenScreen, onExit, onMarketplace }: Props) {
  const [index, setIndex] = useState(0);
  const stop = stops[index];
  const last = index === stops.length - 1;

  useEffect(() => { if (stop) onOpenScreen(stop.screen); }, [stop, onOpenScreen]);

  // "Do it now" only while the control it would press is on screen — a
  // button that does nothing is worse than no button. Polled, because the
  // control arrives with the screen's transition, not with the stop.
  const actionAnchor = stop?.action?.kind === 'click-anchor' ? stop.action.anchor : null;
  const [actionAvailable, setActionAvailable] = useState(false);
  useEffect(() => {
    if (!actionAnchor) { setActionAvailable(false); return; }
    const check = () => setActionAvailable(!!findGuideAnchor(actionAnchor));
    check();
    const t = setInterval(check, 300);
    return () => clearInterval(t);
  }, [actionAnchor]);

  const runAction = useCallback((action: GuideAction) => {
    if (action.kind === 'marketplace') { onMarketplace?.(); return; }
    // "Do it now" presses the very control the ring is around. If the control
    // is not on screen (it is still opening), nothing happens — better than
    // reaching for a second code path that could diverge from the real one.
    findGuideAnchor(action.anchor)?.click();
  }, [onMarketplace]);

  if (!stop) return null;

  const buttons: GuideBubbleButton[] = [];
  if (index > 0) buttons.push({ label: 'Back', onClick: () => setIndex(index - 1) });
  buttons.push({ label: last ? 'Done' : 'Next', role: 'next', onClick: () => (last ? onExit(true) : setIndex(index + 1)) });
  if (stop.action && (stop.action.kind !== 'click-anchor' || actionAvailable)) {
    buttons.push({ label: stop.action.label, onClick: () => runAction(stop.action!) });
  }
  if (!last) buttons.push({ label: 'Skip tour', onClick: () => onExit(false) });

  return (
    <>
      {stop.anchor && <GuideRing anchor={stop.anchor} />}
      <GuideBubble eyebrow={`${index + 1} of ${stops.length}`} buttons={buttons} pose={stop.pose} label="Tour">
        {stop.text}
      </GuideBubble>
    </>
  );
}
