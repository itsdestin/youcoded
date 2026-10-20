// src/renderer/components/guide/GuideTipHost.tsx
//
// Renders the active tip (tips.ts) on the buddy's bubble with Got it and Stop
// showing tips (decided 2026-09-10, S-2). Mounted once, in App, beside the
// tour; never while the tour itself is up — one bubble at a time.
//
// It holds a new tip back while busy (a bubble appearing over your work is an
// interruption), but leaves an already visible tip readable until dismissed.
// Activity is passed in: the host has no business reading chat state itself.
import React, { useEffect, useState } from 'react';
import GuideBubble from './GuideBubble';
import { dismissTip, stopAllTips, useActiveTip } from './tips';

interface Props {
  /** Activity that defers a tip's first appearance, not one already being read. */
  busy: boolean;
}

export default function GuideTipHost({ busy }: Props) {
  const tip = useActiveTip();
  // WHY: isThinking flips between queued turns. Retracting an unread bubble on
  // every flip made the same resume tip blink. Once shown, keep that exact tip
  // readable; a new tip still waits for quiet and dismissal still owns its life.
  const [shownTip, setShownTip] = useState<typeof tip>(null);
  useEffect(() => {
    if (!tip || !busy) setShownTip(tip);
  }, [tip, busy]);

  if (!tip || (busy && shownTip !== tip)) return null;
  return (
    <GuideBubble
      eyebrow="Tip"
      label="Tip"
      pose="inquisitive"
      buttons={[
        { label: 'Got it', role: 'next', onClick: dismissTip },
        { label: 'Stop showing tips', onClick: stopAllTips },
      ]}
    >
      {tip.text}
    </GuideBubble>
  );
}
