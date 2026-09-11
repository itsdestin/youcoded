// src/renderer/components/guide/GuideTipHost.tsx
//
// Renders the active tip (tips.ts) on the buddy's bubble with Got it and Stop
// showing tips (decided 2026-09-10, S-2). Mounted once, in App, beside the
// tour; never while the tour itself is up — one bubble at a time.
//
// It also holds the tip back while the person is typing or the assistant is
// mid-answer (Destin's own con on Q-5: a bubble over your work is an
// interruption). Those two facts are passed in, because the host has no
// business reading chat state itself.
import React, { useEffect, useState } from 'react';
import GuideBubble from './GuideBubble';
import { dismissTip, stopAllTips, useActiveTip } from './tips';

interface Props {
  /** The composer has focus, or a turn is running: wait. */
  busy: boolean;
}

export default function GuideTipHost({ busy }: Props) {
  const tip = useActiveTip();
  // A tip that arrived while busy waits for a quiet moment rather than being
  // lost — the trigger already spent its one-per-sitting allowance on it.
  const [held, setHeld] = useState(false);
  useEffect(() => { if (tip && busy) setHeld(true); if (!busy) setHeld(false); }, [tip, busy]);

  if (!tip || busy || held) return null;
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
