// PageFreshness — a bare "2m" and the refresh button (review round 1, C-6:
// "drop this to just a bare 2m with retry. no updated/ago"), in the band
// beside a connected page's name (Pages Phase 2, deck Q-last-updated: the app
// owns it, so it sits in the same place on every page and is true because the
// app made the request). Small and muted on purpose: the band was kept quiet
// over six rounds. A failed update says so here while the page keeps its last
// good numbers; the cause is not guessed (docs/error-message-standards.md).
import React, { useEffect, useState } from 'react';
import type { PageSummary, PagesBridge } from '../../../shared/pages-types';
import { Button, Tooltip } from '../ui';
import { publishPages } from './use-pages';

/** Re-reads the clock every 30s so "2 min ago" stays honest. Skips the tick
 *  while the window is hidden (document.hidden) — tests/visible-intervals. */
function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** Compact age: "now", "2m", "3h", "4d". */
function age(iso: string, now: number): string {
  const m = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(m) || m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

export function PageFreshness({ page, onRefresh }: { page: PageSummary; onRefresh?: () => void }) {
  const now = useClock();
  const [busy, setBusy] = useState(false);
  const r = page.refresh;
  if (!r) return null;

  const refresh = async () => {
    if (busy) return;
    // The page is what actually fetches: the host posts `youcoded:refresh` into
    // the frame and the page re-runs its own requests (design §5). That comes
    // first, and happens even where the host has no `refresh` channel, so the
    // button is never a control that does nothing.
    onRefresh?.();
    const b = (window as unknown as { claude?: { pages?: PagesBridge } }).claude?.pages;
    if (!b?.refresh) return;
    setBusy(true);
    try { publishPages(await b.refresh(page.id)); } finally { setBusy(false); }
  };

  const words = busy ? 'Updating…'
    : r.failed ? "Couldn't update"
    : r.at ? age(r.at, now) : 'Not updated yet';

  return (
    <span className="flex items-center gap-1 shrink-0 text-xs font-normal text-fg-muted" data-page-freshness={r.failed ? 'failed' : 'ok'} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <span aria-hidden="true" className="text-fg-faint">·</span>
      <span>{words}</span>
      {r.failed && r.at && !busy && <span className="max-sm:hidden text-fg-faint">· {age(r.at, now)}</span>}
      <Tooltip text={r.failed ? 'Try again' : 'Update now'} placement="bottom">
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => { void refresh(); }}
          aria-label={r.failed ? `Try updating ${page.name} again` : `Update ${page.name} now`}
          className="w-6 h-6"
        >
          <svg className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 11a8 8 0 1 0-2.3 6.3M20 4v7h-7" />
          </svg>
        </Button>
      </Tooltip>
    </span>
  );
}
