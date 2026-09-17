import React from 'react';
import BrailleSpinner from '../BrailleSpinner';

/**
 * K5 — the status strip. "What is this subsystem doing right now", plus the one
 * action that resolves it.
 *
 * Replaces Remote Access's ELEVEN ad-hoc setup branches (the spec said eight),
 * which between them used loose <p> tags, centred green text, centred muted
 * text, a bare button with no message at all, and full-width buttons stacked
 * mid-scroll. The words were mostly fine — the shape was eleven shapes.
 *
 * THIS IS THE ROLE THAT OWNS AN ACTION. K4's Callout deliberately has no action
 * slot, because a block that states something AND offers a button to resolve it
 * is this, not that. The two collapsed back into each other historically
 * because nothing enforced the split; the two APIs enforce it now.
 *
 * Dot colours are the app's status set and stay hardcoded — status colours are
 * theme-independent by standing rule (desktop/CLAUDE.md).
 */

export type StatusTone = 'ok' | 'warn' | 'idle' | 'busy';

const DOT: Record<Exclude<StatusTone, 'busy'>, string> = {
  ok: 'bg-green-500',
  warn: 'bg-amber-500',
  idle: 'bg-fg-muted/40',
};

/**
 * The tinted surfaces, added 2026-09-06 on Destin's direction: "I want a
 * container/visible pill that goes around both the warning and the buttons".
 * K5's flat `bg-inset` is nearly invisible inside a card that is already inset,
 * so a strip sitting in chat needs the fill to carry its tone. The values are
 * K4 Callout's, deliberately — one colour vocabulary for the two shapes — and
 * the option is opt-in, so every settings-screen strip is untouched.
 */
const TINT: Record<StatusTone, string> = {
  ok: 'bg-green-500/10 border border-green-500/25',
  // Status colours stay hardcoded per the standing rule, same as Callout's.
  warn: 'bg-amber-500/10 border border-amber-500/30',
  idle: 'bg-inset border border-edge',
  busy: 'bg-inset border border-edge',
};

export type StatusStripProps = {
  /** `busy` swaps the dot for a spinner — a state in motion, not a state at rest. */
  tone?: StatusTone;
  /** The status line itself. */
  children: React.ReactNode;
  /**
   * A quieter second line for the thing the user needs to know WHILE waiting —
   * "This may take a few minutes", "Check your browser to sign in". Not for
   * explaining what the feature is; that is a K4 info callout.
   */
  detail?: React.ReactNode;
  /** The single action that resolves this state. Usually a <Button size="sm">. */
  action?: React.ReactNode;
  /**
   * `flat` (default) is K5 as designed: one `bg-inset` geometry for every tone,
   * for a strip sitting on a settings surface. `tinted` fills and outlines the
   * strip in its tone's colour, for a strip sitting INSIDE another card where a
   * flat inset fill disappears. Opt-in, so `flat` callers cannot drift.
   */
  surface?: 'flat' | 'tinted';
  /**
   * Specialists plans, Task 11: let `action` wrap onto its own line when the
   * strip is narrow (a 390 px phone). The words keep at least 10rem before the
   * action moves below them; the caller's action should carry `ml-auto` so it
   * stays on the right. Opt-in: every other strip keeps its one row. WHY: a
   * paused plan card with three buttons crushed its reason into a one-letter
   * column at 390 px, because the text was the only part allowed to shrink.
   */
  wrapAction?: boolean;
  className?: string;
};

export function StatusStrip({ tone = 'idle', children, detail, action, surface = 'flat', wrapAction = false, className = '' }: StatusStripProps) {
  return (
    <div className={`px-3 py-2.5 rounded-lg ${surface === 'tinted' ? TINT[tone] : 'bg-inset'} flex items-center gap-3 ${wrapAction ? 'flex-wrap gap-y-2' : ''} ${className}`.replace(/\s+/g, ' ').trim()}>
      <span className="shrink-0 flex items-center justify-center w-2">
        {tone === 'busy' ? (
          <BrailleSpinner size="xs" />
        ) : (
          <span className={`w-2 h-2 rounded-full ${DOT[tone]}`} aria-hidden="true" />
        )}
      </span>
      <span className={wrapAction ? 'flex-1 min-w-0 basis-40' : 'flex-1 min-w-0'}>
        <span className="block text-xs text-fg-2">{children}</span>
        {detail && <span className="block text-3xs text-fg-muted mt-0.5">{detail}</span>}
      </span>
      {action}
    </div>
  );
}
