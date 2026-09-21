// Pins the Destin-approved (2026-07-23; 'force' reworded 2026-09-21) takeover
// dialog copy verbatim, per phase. Failing this test on a copy change is the
// point — it forces a deliberate edit instead of a silent drive-by wording drift.
import { describe, it, expect } from 'vitest';
import { takeoverDialogCopy } from '../src/renderer/components/takeover-dialog-copy';

describe('takeoverDialogCopy', () => {
  it('confirm: single-paragraph ask, no consequence', () => {
    expect(takeoverDialogCopy('confirm', 'Laptop-B')).toEqual({
      lead: 'This session is active on Laptop-B — take over here?',
    });
  });

  it('undeliverable: honest "can\'t be reached" framing, never blames the device', () => {
    expect(takeoverDialogCopy('undeliverable', 'Laptop-B')).toEqual({
      lead: "This conversation is open on Laptop-B, and that device can't be reached right now.",
      consequence:
        'You can still take over. When Laptop-B reconnects it will stop and save on its own — but anything it writes before then is kept as a separate copy, not added to this conversation.',
    });
  });

  it('force: "couldn\'t confirm" framing — never claims the device was reached', () => {
    expect(takeoverDialogCopy('force', 'Laptop-B')).toEqual({
      lead: "We couldn't confirm that Laptop-B handed off this conversation. It may be offline or busy.",
      consequence:
        'You can still take over. When Laptop-B catches up it will stop and save on its own — but anything it writes before then is kept as a separate copy, not added to this conversation.',
    });
  });
});
