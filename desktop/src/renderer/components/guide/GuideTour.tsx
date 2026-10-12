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
import { useGuideAdvance } from './guide-events';
import { tourStops, type GuideAction, type GuideScreen, type GuideStop } from './guide-stops';
import { ScreenMark } from '../../shoot-mode';
import { takeTourStart } from './guide-state';
import { useEscClose } from '../../hooks/use-esc-close';

interface Props {
  stops?: readonly GuideStop[];
  /** Open (or return to) a screen. Called on every stop, including a Back. */
  onOpenScreen: (screen: GuideScreen) => void;
  /** `done` is true on the last Next, false on Skip. `stay` (Escape): close only
   *  the bubble and leave the screen under it open. */
  onExit: (done: boolean, stay?: boolean) => void;
  onMarketplace?: () => void;
}

export default function GuideTour({ stops: given, onOpenScreen, onExit, onMarketplace }: Props) {
  // WHY tourStops() and not the constant: the backup-warning practice (backlog
  // row 18) adds a stop in the workbench; everywhere else it IS GUIDE_STOPS.
  const [stops] = useState(() => given ?? tourStops());
  // The photo-only build may ask for a later stop (guide-state takeTourStart).
  const [index, setIndex] = useState(() => { const at = takeTourStart(); return Math.max(0, at ? stops.findIndex((s) => s.id === at) : 0); });
  const stop = stops[index];
  const last = index === stops.length - 1;

  // `escKey` re-registers Escape (TourEscape below) in the same update that
  // opens the stop's screen, so it lands on top of that screen's own entry.
  const [escKey, setEscKey] = useState(0);
  useEffect(() => { if (stop) { onOpenScreen(stop.screen); setEscKey((k) => k + 1); } }, [stop, onOpenScreen]);

  // "Do it now" only while the control it would press is on screen — a
  // button that does nothing is worse than no button. Polled, because the
  // control arrives with the screen's transition, not with the stop. The
  // same poll decides whether a stop's control is on screen at all, which
  // picks between `text` and `textWhenMissing`.
  const actionAnchor = stop?.action?.kind === 'click-anchor' ? stop.action.anchor : null;
  const [actionAvailable, setActionAvailable] = useState(false);
  const [anchorPresent, setAnchorPresent] = useState(true);
  useEffect(() => {
    const check = () => {
      setActionAvailable(!!actionAnchor && !!findGuideAnchor(actionAnchor));
      setAnchorPresent(!stop?.anchor || !!findGuideAnchor(stop.anchor));
    };
    check();
    const t = setInterval(check, 300);
    return () => clearInterval(t);
  }, [actionAnchor, stop]);

  // Started a session while the form stop was up: move on (guide-events.ts).
  useGuideAdvance(useCallback(() => {
    if (stop?.screen === 'welcome-form' && index < stops.length - 1) setIndex(index + 1);
  }, [stop, index, stops.length]));

  const runAction = useCallback((action: GuideAction) => {
    if (action.kind === 'marketplace') { onMarketplace?.(); return; }
    // "Do it now" presses the very control the ring is around. If the control
    // is not on screen (it is still opening), nothing happens — better than
    // reaching for a second code path that could diverge from the real one.
    findGuideAnchor(action.anchor)?.click();
  }, [onMarketplace]);

  if (!stop) return null;

  // Order (Destin, review deck 2026-09-10, T-1): Back, any action, Skip tour,
  // then Next at the far right — the filled button is the last thing read.
  const buttons: GuideBubbleButton[] = [];
  if (index > 0) buttons.push({ label: 'Back', onClick: () => setIndex(index - 1) });
  if (stop.action && (stop.action.kind !== 'click-anchor' || actionAvailable)) {
    buttons.push({ label: stop.action.label, onClick: () => runAction(stop.action!) });
  }
  if (!last) buttons.push({ label: 'Skip tour', onClick: () => onExit(false) });
  buttons.push({ label: last ? 'Done' : 'Next', role: 'next', onClick: () => (last ? onExit(true) : setIndex(index + 1)) });

  return (
    <>
      <TourEscape key={escKey} onSkip={onExit} />
      {stop.anchor && <GuideRing anchor={stop.anchor} />}
      <GuideBubble eyebrow={`${index + 1} of ${stops.length}`} buttons={buttons} pose={stop.pose} label="Tour">
        {!anchorPresent && stop.textWhenMissing ? stop.textWhenMissing : stop.text}
        {/* shoot's `tour/<stop>` screens prove the bubble is showing that stop
            (renders nothing outside the photo-only build). */}
        <ScreenMark name={`tour/${stop.id}`} />
      </GuideBubble>
    </>
  );
}

/** Escape ends the tour and closes only its bubble, like any popup (guide: Popups).
 *  WHY a keyed child: Escape goes to the LAST overlay that registered, and each
 *  stop opens its screen (the Projects view…) after the tour registered, so
 *  Escape closed that screen under the bubble and left the tour floating over
 *  nothing (shoot --check, tour/files). Remounted (new `key`) in the same update
 *  that opens the screen, it registers after it — the tour is drawn after those
 *  screens in App — so Skip tour is back on top. Settings stops whose dialog
 *  opens ~350ms later still take one Escape for that dialog first. */
function TourEscape({ onSkip }: { onSkip: (done: boolean, stay?: boolean) => void }) {
  useEscClose(true, useCallback(() => onSkip(false, true), [onSkip]));
  return null;
}
