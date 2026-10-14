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
import { Button, CARD_LEVEL_1, ConsentRow, Dialog, Tooltip } from './ui';
import { memoWhileClosed } from './memo-while-closed';
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

function FirstTimeWarningImpl({ kind, open, onCancel, onContinue }: FirstTimeWarningProps) {
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
    // "Before you turn on Skip permissions" to "…Permissi…" beside its close
    // button (seen in the workbench 2026-09-10), and the design guide calls a
    // truncated title a bug. 420px fits every title and keeps the three
    // paragraphs at a comfortable measure.
    <Dialog open={open} onClose={() => close(onCancel)} title={copy.title} size="panel" screen={`chat/first-time-warning/${kind}`}>
      {/* WHY one card holding the explanation, the tick box and the buttons (final-review#PR-7,
          #ST-12, #ST-21 — one popup rule): a popup's body sits in a card, as About's does, and its
          tick box is the shared "I understand" box (ConsentRow), the same one Skip permissions
          and Remove project use. It was a bare 12px square beside a sentence on the popup.
          One card, so no label (the guide's single-card exception). Paragraph style matches the
          Permissions page's mode definitions, so the Full auto warning reads in that voice. */}
      <div className={`${CARD_LEVEL_1} p-3 space-y-2`}>
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
        {copy.checkbox && (
          <ConsentRow checked={checked} onChange={setChecked}>
            {copy.checkbox}
          </ConsentRow>
        )}
        {/* WHY a hover hint on the grey Continue instead of a line at the card's foot
            (final-fixes#ST-12, Destin: "remove "tick the box to continue" and replace with a hover
            tooltip over the action button that would be disabled"). Continue stays disabled, not
            hidden, so the person sees what the tick unlocks; the shared Tooltip reaches a disabled
            button and opens on press-and-hold on a touchscreen. Empty text = no hint once ticked.
            The buttons sit inside the one card (popup-cards-1#PC-1). */}
        <div className="flex gap-2 justify-end pt-1">
          <Button variant="secondary" onClick={() => close(onCancel)}>
            Cancel
          </Button>
          <Tooltip text={canContinue ? '' : 'Tick the box to continue'}>
            <Button variant="primary" disabled={!canContinue} onClick={() => close(onContinue)}>
              {copy.continueLabel}
            </Button>
          </Tooltip>
        </div>
      </div>
    </Dialog>
  );
}

// WHY: mounted in five hosts (the shell, the session strip, resume options) and rebuilt its Dialog
// contents on every session switch although closed. See memo-while-closed.ts.
export const FirstTimeWarning = memoWhileClosed(FirstTimeWarningImpl);

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
