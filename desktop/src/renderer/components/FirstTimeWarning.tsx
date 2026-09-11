// The first-time warning dialog and the gate hook around it.
//
// Spec: docs/active/specs/2026-09-10-first-run-guide-design.md §1 item 7, §3
// "First-time warning", §5 "Warnings". One <Dialog> for the three kinds; copy
// and the acknowledgement flag live in first-time-warnings.ts so they can be
// tested without a DOM.
//
// Shape of the wiring: a caller does not open the dialog itself. It calls
// `gate(proceed)` and the hook decides — run `proceed` now (already
// acknowledged), or show the dialog and run `proceed` only if the person
// presses Continue. Cancel and the ✕ do nothing at all, which means the
// control the person touched stays where it was (the toggle stays off, the
// session is not created, the mode does not change). That is why every wired
// site routes the ACTION through the gate rather than the state change.

import React, { useCallback, useRef, useState, type ReactNode } from 'react';
import { Button, Checkbox, Dialog } from './ui';
import {
  hasAcknowledged,
  markAcknowledged,
  WARNING_COPY,
  type WarningKind,
} from './first-time-warnings';

export interface FirstTimeWarningProps {
  kind: WarningKind;
  open: boolean;
  onCancel: () => void;
  onContinue: () => void;
}

export function FirstTimeWarning({ kind, open, onCancel, onContinue }: FirstTimeWarningProps) {
  const copy = WARNING_COPY[kind];
  const [checked, setChecked] = useState(false);
  // WHY: the checkbox state is reset whenever the dialog closes rather than on
  // open, so a Cancel followed by a second attempt starts unticked again — the
  // consent has to be given on the attempt that goes through.
  const close = (then: () => void) => {
    setChecked(false);
    then();
  };
  const needsConsent = Boolean(copy.checkbox);
  const canContinue = !needsConsent || checked;

  return (
    // "panel", not "prompt": at prompt width (340px) the header truncates
    // "Before you turn on Skip Permissions" to "…Permissi…" beside its close
    // button (seen in the workbench 2026-09-10), and the design guide calls a
    // truncated title a bug. 420px fits every title and keeps the three
    // paragraphs at a comfortable measure.
    <Dialog open={open} onClose={() => close(onCancel)} title={copy.title} size="panel">
      {/* Paragraph style matches the Permissions page's mode definitions, so the
          Full auto warning reads as the same voice as the page it echoes. */}
      <div className="space-y-2">
        {copy.body.map((paragraph, i) => (
          <React.Fragment key={i}>
            <p className="text-2xs text-fg-2 leading-relaxed">{paragraph}</p>
            {i === 0 && copy.bullets && (
              <ul className="text-2xs text-fg-2 leading-relaxed list-disc pl-4 space-y-1">
                {copy.bullets.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </React.Fragment>
        ))}
      </div>
      {copy.checkbox && (
        // Same row shape as ProjectView's delete-consent checkbox (the
        // primitive's intended site): a clickable div, because a <label> cannot
        // associate with a button-role checkbox, and a stopPropagation span so
        // the box's own click toggles exactly once instead of twice via the row.
        <div
          className="flex items-start gap-2 text-2xs text-fg cursor-pointer"
          onClick={() => setChecked((v) => !v)}
        >
          <span className="mt-0.5" onClick={(e) => e.stopPropagation()}>
            <Checkbox checked={checked} onChange={setChecked} aria-label={copy.checkbox} />
          </span>
          <span className="leading-relaxed">{copy.checkbox}</span>
        </div>
      )}
      {/* Footer: a decision to confirm, so Cancel + one primary (design guide
          G-4, §4.3). Continue is disabled, not hidden, until the box is ticked
          so the person can see what the checkbox unlocks — and one muted line
          says so (UX tester run 1, U26: a greyed button with no hint). */}
      {needsConsent && !checked && (
        <p className="text-2xs text-fg-muted text-right">Tick the box to continue</p>
      )}
      <div className="flex gap-2 justify-end">
        <Button variant="secondary" onClick={() => close(onCancel)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!canContinue} onClick={() => close(onContinue)}>
          {copy.continueLabel}
        </Button>
      </div>
    </Dialog>
  );
}

export interface FirstTimeGateOptions {
  /** Runs when the dialog actually opens (not when `gate` proceeds at once). */
  onShow?: () => void;
  /** Runs when the dialog closes by either path, BEFORE `proceed` on Continue. */
  onSettle?: () => void;
}

/**
 * `gate(proceed)` runs `proceed` at once when this kind was acknowledged
 * before, else shows the warning and runs `proceed` only on Continue (which
 * also records the acknowledgement). Render `dialog` next to the component's
 * other dialogs.
 *
 * `onShow` / `onSettle` exist for one host: SessionStrip's new-session popover
 * sits at z-9000 (load-bearing, see react-renderer.md), above every <Dialog>,
 * and its outside-click closer would treat a click inside the dialog as
 * "outside". So that host hides the popover while the warning is up and shows
 * it again after — the same yield-to-modal move "Manage models…" already makes.
 */
export function useFirstTimeGate(kind: WarningKind, options: FirstTimeGateOptions = {}): {
  gate: (proceed: () => void) => void;
  dialog: ReactNode;
} {
  const [open, setOpen] = useState(false);
  // WHY refs, not state: the pending action and the callbacks are only ever
  // read from the Continue/Cancel handlers, and holding them in state would
  // re-render the host component (SessionStrip is large) for no visible
  // change. Reading options through a ref also keeps `gate` stable even when
  // the caller passes fresh arrow functions each render.
  const pending = useRef<(() => void) | null>(null);
  const opts = useRef(options);
  opts.current = options;

  const gate = useCallback((proceed: () => void) => {
    if (hasAcknowledged(kind)) {
      proceed();
      return;
    }
    pending.current = proceed;
    setOpen(true);
    opts.current.onShow?.();
  }, [kind]);

  const onCancel = useCallback(() => {
    pending.current = null;
    setOpen(false);
    opts.current.onSettle?.();
  }, []);

  const onContinue = useCallback(() => {
    // WHY mark first: if `proceed` throws (a create handler hitting a bad
    // binding, say), the person has still read and agreed, and must not be
    // asked again on the retry.
    markAcknowledged(kind);
    const proceed = pending.current;
    pending.current = null;
    setOpen(false);
    opts.current.onSettle?.();
    proceed?.();
  }, [kind]);

  const dialog = <FirstTimeWarning kind={kind} open={open} onCancel={onCancel} onContinue={onContinue} />;
  return { gate, dialog };
}
