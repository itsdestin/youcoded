import React from 'react';

/**
 * K4 — the callout. Passive information, one geometry, three tones.
 *
 * Replaces two competing geometries that were doing the same job:
 * `rounded-md px-2.5 py-2` (3 sites) and `rounded-lg p-3` (2 sites), plus
 * SyncPanel's destructive banner, which was a full-bleed `border-b` strip
 * because no danger tone existed to reach for.
 *
 * THERE IS NO ACTION SLOT, AND THAT IS THE POINT. A block that states something
 * AND offers a button to resolve it is a K5 status strip — a different role with
 * a different geometry (bg-inset, a status dot, a horizontal layout). The two
 * collapsed back into each other historically because nothing stopped a callout
 * from growing a button. The API stops it now: if you need an action here, you
 * are reaching for the wrong component.
 *
 * Tone preserves change 14's rule — accent means information, amber means
 * warning — and adds the danger tone the old set never had.
 */

export type CalloutTone = 'info' | 'warning' | 'danger';

const TONE: Record<CalloutTone, { surface: string; body: string; title: string }> = {
  info: { surface: 'bg-accent/10 border-accent/25', body: 'text-fg-2', title: 'text-fg' },
  // Status colors stay hardcoded per the standing rule (desktop/CLAUDE.md), so
  // amber is a raw Tailwind color rather than a theme token.
  warning: { surface: 'bg-amber-500/10 border-amber-500/25', body: 'text-fg-2', title: 'text-amber-400' },
  // `destructive` is the one status color that IS tokenised: change 17 moved the
  // app's reds onto it so theme packs can restyle their own danger.
  danger: { surface: 'bg-destructive/10 border-destructive/50', body: 'text-destructive-fg', title: 'text-destructive-fg' },
};

export type CalloutProps = {
  tone?: CalloutTone;
  /** Optional bold lead-in line above the body. */
  title?: React.ReactNode;
  className?: string;
  /** Collapse to the title line; the body opens on click. Needs `title`.
   *  Opening is not an action, so this keeps the no-button rule — it is for a
   *  warning whose headline says enough and whose detail is a list (the Sync
   *  box's too-big conversations, 2026-09-16). */
  collapsible?: boolean;
  children: React.ReactNode;
};

export function Callout({ tone = 'info', title, className = '', collapsible = false, children }: CalloutProps) {
  const t = TONE[tone];
  if (collapsible && title) {
    return (
      <details className={`rounded-lg p-3 border ${t.surface} ${className}`.trim()}>
        <summary className={`text-xs font-medium cursor-pointer select-none ${t.title}`}>{title}</summary>
        <div className={`text-xs mt-1.5 ${t.body}`}>{children}</div>
      </details>
    );
  }
  return (
    <div className={`rounded-lg p-3 border ${t.surface} ${className}`.trim()}>
      {/* Both slots are <div>, not <p>. A callout body can legitimately carry a
          block child — SyncSetupWizard's install error puts an "Install manually"
          link on its own line — and a <div> inside a <p> is invalid HTML that the
          browser silently repairs by closing the paragraph early, which would
          drop the body's own text classes off everything after it. */}
      {title && <div className={`text-3xs font-medium mb-0.5 ${t.title}`}>{title}</div>}
      <div className={`text-xs ${t.body}`}>{children}</div>
    </div>
  );
}
