// PageCodeChanged — a quiet note beside a connected page's name when its code
// is not the code that was approved (deck 3, Q-code-change: Destin chose "a
// quiet note in the band" over asking again on every edit, which teaches people
// to press Allow without reading, and over saying nothing, which lets an
// installed page change behaviour unseen).
//
// The page still opens and still reaches ONLY what was approved — the note is
// information, not a gate. Dismissing it records the current code as the
// approved code (main's `approve` with nothing waiting); it can never widen
// what the page reaches, because the connection fingerprints are untouched.
import React, { useState } from 'react';
import type { PageSummary, PagesBridge } from '../../../shared/pages-types';
import { CloseButton, Tooltip } from '../ui';
import { publishPages } from './use-pages';

export function PageCodeChanged({ page }: { page: PageSummary }) {
  const [busy, setBusy] = useState(false);
  if (!page.codeChanged) return null;

  const dismiss = async () => {
    const b = (window as unknown as { claude?: { pages?: PagesBridge } }).claude?.pages;
    if (!b?.approve || busy) return;
    setBusy(true);
    try {
      const r = await b.approve(page.id, {});
      if (r.ok) publishPages(r.pages);
    } finally { setBusy(false); }
  };

  return (
    <span
      className="flex items-center gap-1 shrink-0 text-xs font-normal text-fg-muted"
      data-page-code-changed
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <span aria-hidden="true" className="text-fg-faint">·</span>
      <Tooltip text="Its connections are the same, so it still reaches only what you allowed." placement="bottom">
        <span className="max-sm:hidden">Code changed since you allowed this</span>
      </Tooltip>
      <span className="sm:hidden">Code changed</span>
      <CloseButton onClick={() => { void dismiss(); }} label="Dismiss the code-changed note" className="w-6 h-6" />
    </span>
  );
}
