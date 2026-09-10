import React from 'react';
import BrailleSpinner from '../BrailleSpinner';
import { Button } from './Button';
import { triggerTip } from '../guide/tips';

/**
 * The loading / empty / error family (changes 31-34, §1.6).
 *
 * Shared anatomy: [mark] message [action].
 * Marks carry meaning — braille spinner = working, nothing = empty,
 * destructive dot = failed.
 *
 * Two variants everywhere:
 *   block  — list surfaces, text-sm, vertical breathing room
 *   inline — inside sections, text-2xs, tight
 */

export type StateVariant = 'block' | 'inline';

export type LoadingStateProps = {
  /** What is loading. Always name it — "Loading sessions…", not "Loading…". */
  what: string;
  /**
   * The verb. Defaults to "Loading", which is right for a fetch and WRONG for
   * everything else — the Tailscale install read "Loading Tailscale…" while it
   * was downloading 50MB, and the sign-in wait read "Loading the Tailscale
   * sign-in…" while it was waiting on a browser. Name the actual operation:
   * "Installing", "Waiting for", "Saving".
   */
  verb?: string;
  variant?: StateVariant;
  className?: string;
};

export function LoadingState({ what, verb = 'Loading', variant = 'block', className = '' }: LoadingStateProps) {
  const block = variant === 'block';
  return (
    <div
      className={[
        block
          ? 'flex items-center justify-center gap-2 py-8 text-sm text-fg-muted'
          : 'flex items-center gap-2 px-1 text-2xs text-fg-muted',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <BrailleSpinner size={block ? 'sm' : 'xs'} />
      <span>{verb} {what}…</span>
    </div>
  );
}

export type EmptyStateProps = {
  message: React.ReactNode;
  /** Optional way out — "Clear filters", "Browse themes". */
  action?: { label: string; onClick: () => void };
  variant?: StateVariant;
  className?: string;
};

export function EmptyState({ message, action, variant = 'block', className = '' }: EmptyStateProps) {
  const block = variant === 'block';
  return (
    <div
      className={[
        // No mark: absence IS the empty state's mark.
        block ? 'flex flex-col items-center gap-2 py-8' : 'flex items-center gap-3 px-1',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span className={block ? 'text-sm text-fg-muted text-center' : 'text-2xs text-fg-muted'}>
        {message}
      </span>
      {action && (
        <Button variant="secondary" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

/** The failure mark. Shared with Toast's error tone. */
function ErrorDot() {
  return <span className="w-1.5 h-1.5 rounded-full bg-destructive shrink-0" aria-hidden="true" />;
}

type ErrorStateRecoverable = {
  mode?: 'recoverable';
  /** Specific and accurate — the real detail, never a guessed cause. */
  message: React.ReactNode;
  onRetry: () => void;
  variant?: StateVariant;
  className?: string;
};

type ErrorStateGeneral = {
  mode: 'general';
  title: React.ReactNode;
  explainer: React.ReactNode;
  onReportBug: () => void;
  onDiagnose: () => void;
  className?: string;
};

export type ErrorStateProps = ErrorStateRecoverable | ErrorStateGeneral;

/**
 * Option C, chosen explicitly over A ("quiet inline") and B ("destructive-tinted
 * callout"): the container is NEUTRAL, and the destructive dot alone carries the
 * failure. Errors are not red boxes (design rule 6).
 *
 * The `general` mode IS the two-action fallback component that
 * docs/error-message-standards.md schedules for v1.3.1 — every user-facing error
 * is either specific+Retry or general+two-actions.
 */
export function ErrorState(props: ErrorStateProps) {
  const container = `bg-inset/50 rounded-lg p-3 ${props.className ?? ''}`.trim();
  // The help tip's moment: the first general error a new user sees is the
  // moment "Report bug" and the community become worth knowing about.
  const general = props.mode === 'general';
  React.useEffect(() => { if (general) triggerTip('help'); }, [general]);

  if (props.mode === 'general') {
    return (
      <div className={container} role="alert">
        <div className="flex items-start gap-2">
          <span className="mt-1.5">
            <ErrorDot />
          </span>
          <div className="flex flex-col gap-2 min-w-0">
            <span className="text-sm font-medium text-fg">{props.title}</span>
            <span className="text-2xs text-fg-dim leading-relaxed">{props.explainer}</span>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={props.onReportBug}>
                Report bug
              </Button>
              <Button variant="primary" size="sm" onClick={props.onDiagnose}>
                Diagnose with Claude
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const block = (props.variant ?? 'block') === 'block';
  return (
    <div className={container} role="alert">
      <div className="flex items-center gap-2">
        <ErrorDot />
        <span className={`flex-1 min-w-0 text-fg-2 ${block ? 'text-sm' : 'text-2xs'}`}>
          {props.message}
        </span>
        {/* Retry is FILLED primary — an explicit review correction from secondary,
            because secondary reads as a dim outline on dark themes. */}
        <Button variant="primary" size="sm" onClick={props.onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}

export type FieldErrorProps = {
  children: React.ReactNode;
  className?: string;
  /** Type step. The app has always used both: 19 of the 25 hand-rolled copies
   *  this primitive replaced were `text-3xs`, 6 were `text-2xs`. It is a PROP
   *  rather than something a caller passes through `className` because this
   *  component CONCATENATES className onto the base — and Tailwind resolves two
   *  competing utilities by CSS SOURCE ORDER, not by the order they appear in
   *  the attribute, so `className="text-2xs"` would silently keep rendering at
   *  3xs (the same trap that made Button's pills render as rectangles). */
  size?: '3xs' | '2xs';
  /** Element to render. Default `span` (inline) matches how the primitive
   *  shipped. Pass `p`/`div` where the line is a BLOCK under a field: vertical
   *  margin and padding (`mt-1`, `pb-2`) do not lay out on an inline element,
   *  so a `<p className="mt-1 …">` swapped to a bare span would silently lose
   *  its gap wherever the parent is not a flex/grid container. */
  as?: 'span' | 'p' | 'div';
};

/** Field-level errors stay short lines under the input — not cards. */
export function FieldError({ children, className = '', size = '3xs', as: Tag = 'span' }: FieldErrorProps) {
  // Literal class strings, not `text-${size}` — Tailwind scans source text for
  // whole class names and never sees an interpolated one.
  const sizeClass = size === '2xs' ? 'text-2xs' : 'text-3xs';
  return (
    <Tag className={`${sizeClass} text-destructive-fg ${className}`.trim()} role="alert">
      {children}
    </Tag>
  );
}
