import type { ReactNode } from 'react';

/**
 * The small tinted pill — a short label about a thing ("Read-only",
 * "1 warning"), in normal case, with its colour in the TINT and the words in
 * the normal text colour.
 *
 * WHY (design guide "Status and notices": "a status label is a small tinted
 * pill in its status colour, normal case"; decisions.md "Status labels",
 * `ui-element-review-status#S-1`): the Specialists roster drew these as tiny
 * spaced-out capitals in a hairline box ("READ-ONLY", "CAN EDIT & RUN
 * COMMANDS"), which the guide retires everywhere. There was no shared pill in
 * `components/ui/` yet — every tinted pill in the app is hand-typed — so this
 * is the one the next screen reaches for instead of a seventh spelling.
 *
 * Not `Badge`: Badge is the neutral, square-cornered record chip (counts,
 * "Optional") and deliberately has no colour. A pill is round and tinted.
 *
 * Words stay `text-fg-2` in every tone: the status colours are fixed across
 * themes, so as TEXT they fail the pale themes (react-renderer rule "Status
 * colour … goes in the ring/tint, NEVER the word"). The tint is /15, not the
 * callout's /10 — a label, not a notice box.
 */
export type PillTone = 'neutral' | 'info' | 'ok' | 'warning' | 'danger';

const TONE: Record<PillTone, string> = {
  neutral: 'bg-inset border-edge-dim',
  info: 'bg-accent/15 border-accent/30',
  ok: 'bg-green-400/15 border-green-400/30',
  warning: 'bg-amber-500/15 border-amber-500/30',
  danger: 'bg-destructive/15 border-destructive/30',
};

export function Pill({ tone = 'neutral', children, className = '' }: { tone?: PillTone; children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex items-center shrink-0 rounded-full border px-2 py-px text-3xs leading-tight text-fg-2 whitespace-nowrap ${TONE[tone]} ${className}`.trim()}
    >
      {children}
    </span>
  );
}
