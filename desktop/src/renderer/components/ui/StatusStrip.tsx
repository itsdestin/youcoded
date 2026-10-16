import React from 'react';
import BrailleSpinner from '../BrailleSpinner';

/**
 * K5 — the status strip. "What is this subsystem doing right now", plus the one
 * action that resolves it.
 *
 * Replaces Remote access's ELEVEN ad-hoc setup branches (the spec said eight),
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
  className?: string;
};

export function StatusStrip({ tone = 'idle', children, detail, action, className = '' }: StatusStripProps) {
  return (
    <div className={`status-strip px-3 py-2.5 rounded-lg bg-inset flex items-center gap-3 ${className}`.trim()}>
      <span className="shrink-0 flex items-center justify-center w-2">
        {tone === 'busy' ? (
          <BrailleSpinner size="xs" />
        ) : (
          <span className={`w-2 h-2 rounded-full ${DOT[tone]}`} aria-hidden="true" />
        )}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-xs text-fg-2">{children}</span>
        {detail && <span className="block text-3xs text-fg-muted mt-0.5">{detail}</span>}
      </span>
      {action}
    </div>
  );
}
