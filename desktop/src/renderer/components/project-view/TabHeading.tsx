// The one heading row every Projects tab opens with (2026-09-29, Destin: "we need
// to fix … header/section consistency" on the Projects view). Before this, Files
// had a small breadcrumb line, Conversations had no heading at all, and
// Instructions & Memories had small labels with a sentence squeezed beside them.
// Now each tab's sections start with the same row: heading on the left (with an
// optional one-line description UNDER it, never beside it), tools on the right.
import React from 'react';
import { SectionLabel } from '../ui';

// WHY a constant: the review deck compares the guide's Large heading (full
// screens: "Big groups on the screen use the Large heading", like Marketplace
// and Library) against the small label; the chosen one stays.
const SIZE: 'large' | 'small' = 'large';

export function TabHeading({ children, description, action }: {
  children: React.ReactNode;
  description?: React.ReactNode;
  /** Right-aligned tools: the file view switch, an info button. */
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 px-1 shrink-0 min-w-0">
      <div className="min-w-0">
        {/* No heading while a search flattens the Files tree — its results
            carry their own "Matches by…" labels; the tools stay put. */}
        {children == null ? null : SIZE === 'large'
          ? <h2 className="text-lg font-medium text-fg flex items-center gap-1.5 flex-wrap min-w-0">{children}</h2>
          : <SectionLabel className="flex items-center gap-1.5 flex-wrap min-w-0">{children}</SectionLabel>}
        {description && <p className="text-xs text-fg-muted mt-0.5">{description}</p>}
      </div>
      {action && <div className="shrink-0 flex items-center gap-0.5">{action}</div>}
    </div>
  );
}
