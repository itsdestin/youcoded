import type { HTMLAttributes, ReactNode } from 'react';

/**
 * The fact chip — one short fact in a row of them: "Likely safe", "@destin", "412 installs",
 * "👍 93%", a topic tag. Square-cornered, neutral, normal text height.
 *
 * WHY it is a primitive (marketplace-detail friction, proposal 6; decisions "Detail chips: one
 * size, one row that scrolls"): the Marketplace detail page's chip row mixed three recipes —
 * the trust badges' box, the shared `Badge` (same 11px text but `leading-none`, so a ~4px shorter
 * box) and a thumbs summary with its own 12px text — and Destin saw the difference ("install is
 * tiny"). The trust badges' box was moved here unchanged so every chip in a row is one size.
 *
 * Not `Badge`: Badge is the compact RECORD chip (a count beside a name, "Optional", "4W - 2L")
 * with a tight line; Chip is the fact chip in a row of facts. Not `Pill`: a pill is round and
 * tinted and says a STATUS.
 */
export const CHIP = 'inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs text-fg-2 bg-inset border border-edge-dim whitespace-nowrap';

export function Chip({ children, className = '', ...rest }: { children: ReactNode; className?: string } & Omit<HTMLAttributes<HTMLSpanElement>, 'className' | 'children'> & Record<`data-${string}`, unknown>) {
  return <span className={`${CHIP} ${className}`.trim()} data-chip {...rest}>{children}</span>;
}
