import React from 'react';

/**
 * The small section label — 12px medium, muted, NORMAL CASE, no letter-spacing.
 *
 * WHY: design guide rewrite (decisions.md "Heading ladder" — H-3/L-1…L-4, all
 * "No capitals"; guide-draft.md "Headings" → Small label) retired the
 * spaced-capitals eyebrow (`text-3xs font-medium text-fg-muted tracking-wider
 * uppercase`) app-wide. This is the ONE shared primitive so a screen migrating
 * off that class string doesn't hand-type a replacement instead — fix batch 1
 * (2026-09-24) is the first adopter, in the screens named in
 * `docs/active/design/2026-09-23-ui-element-review/decisions.md` ("See it
 * applied"). Screens outside that batch keep the old eyebrow class (still
 * guarded by `section-label-canonical-classes`/`-ts`) until their own
 * migration — this primitive does not retire that guard, it gives the next
 * migration somewhere to land instead of a fourth hand-typed spelling.
 *
 * 12px is `text-xs` here (the app's scale: 3xs=11 since 2026-09-26 (was 10),
 * 2xs=11, xs=12, sm=14 — Dialog.tsx's own width-derivation comment has the
 * full ladder), not the old eyebrow's `text-3xs` — the guide's own number for
 * a small label.
 *
 * No default margin: callers vary (mb-2 above a group's rows, px-3 pt-2 pb-1
 * ahead of a sub-list, none at all inline in a header row) and guessing one
 * would just move the inconsistency inside this file instead of removing it.
 *
 * `reading` — a label heading a SECTION OF READING TEXT (About's Disclaimer,
 * an explainer's headings) also gets a soft underline under its words: edge
 * colour, 4px below the text (decisions.md "Labels over reading sections",
 * `ui-element-review-final#F-1`). Labels over short settings groups stay plain,
 * which is why this is opt-in rather than the default.
 */
export function SectionLabel({ children, className = '', reading = false }: { children: React.ReactNode; className?: string; reading?: boolean }) {
  const underline = reading ? ' underline decoration-edge underline-offset-4' : '';
  return <h3 className={`text-xs font-medium text-fg-muted${underline} ${className}`.trim()}>{children}</h3>;
}
