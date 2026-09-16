// src/renderer/components/guide/GuideRing.tsx
//
// An accent ring around the control a tour stop is talking about. The target
// is whatever carries `data-guide-anchor="<id>"`, so a control can move between
// layouts and platforms without the tour knowing — the same idea as the
// chat/terminal hint's `data-view-toggle`. Nothing is rendered when the anchor
// is not on screen (a stop can outlive its control, e.g. a settings page that
// is still sliding open), and the ring re-measures on a short interval for
// exactly that reason: screens animate open, and there is no event for
// "the dialog finished its transition".
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CONTENT_Z } from '../overlays/Overlay';

export const GUIDE_ANCHOR_ATTR = 'data-guide-anchor';
const PAD_PX = 6;
const POLL_MS = 250;

type Box = { top: number; left: number; width: number; height: number };

/** The first anchor of the list that is on screen. */
export function findGuideAnchor(id: string | string[]): HTMLElement | null {
  for (const one of Array.isArray(id) ? id : [id]) {
    const el = document.querySelector<HTMLElement>(`[${GUIDE_ANCHOR_ATTR}="${one}"]`);
    if (el) return el;
  }
  return null;
}

export default function GuideRing({ anchor }: { anchor: string | string[] }) {
  const [box, setBox] = useState<Box | null>(null);
  const key = Array.isArray(anchor) ? anchor.join('|') : anchor;

  useEffect(() => {
    let raf = 0;
    const measure = () => {
      const el = findGuideAnchor(anchor);
      if (!el) { setBox(null); return; }
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) { setBox(null); return; }
      setBox((prev) => {
        const next = { top: r.top - PAD_PX, left: r.left - PAD_PX, width: r.width + PAD_PX * 2, height: r.height + PAD_PX * 2 };
        return prev && prev.top === next.top && prev.left === next.left && prev.width === next.width && prev.height === next.height ? prev : next;
      });
    };
    measure();
    const tick = setInterval(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); }, POLL_MS);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      clearInterval(tick);
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!box) return null;
  return createPortal(
    <div
      aria-hidden="true"
      data-guide-ring=""
      className="fixed pointer-events-none guide-ring"
      style={{
        top: box.top,
        left: box.left,
        width: box.width,
        height: box.height,
        zIndex: CONTENT_Z[4],
        borderRadius: 'var(--radius-md)',
        // Accent at two strengths, like the bubble's fill and edge: a solid
        // rim and a soft halo, so it reads on a busy wallpaper without a
        // second colour.
        border: '2px solid var(--accent)',
        boxShadow: '0 0 0 4px color-mix(in srgb, var(--accent) 30%, transparent)',
      }}
    />,
    document.body,
  );
}
