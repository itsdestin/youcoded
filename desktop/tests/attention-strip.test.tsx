// @vitest-environment jsdom
//
// The buddy floater's attention pill. Added with the M10 fix (whole-branch
// review, 2026-08-16): this component had NO test at all, which is how it came
// to render the new 'stalled' state blue with the raw internal label while the
// rest of the feature drew it red with real copy.
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { AttentionStrip } from '../src/renderer/components/buddy/AttentionStrip';
import type { AttentionSummary, AttentionState } from '../src/shared/types';

const SID = 'sess-1';

function summaryFor(attentionState: AttentionState, awaitingApproval = false): AttentionSummary {
  return {
    anyNeedsAttention: attentionState !== 'ok' || awaitingApproval,
    perSession: { [SID]: { attentionState, awaitingApproval } },
  };
}

/** The pill's dot is the first <span>; its class is the status color.
 *  WHY a class, not an inline hex (2026-10-13, the guide's buddy deviations): the dot now takes
 *  the main session strip's own status classes (bg-red-400 / bg-amber-400), so the buddy's red
 *  and amber are the app's one red and amber rather than a second hand-picked pair. */
function dotColor(container: HTMLElement): string {
  const cls = (container.querySelector('span') as HTMLElement).className;
  return cls.includes('bg-red-400') ? 'red' : cls.includes('bg-amber-400') ? 'amber' : cls;
}

describe('AttentionStrip', () => {
  it('renders nothing when the session is healthy', () => {
    const { container } = render(<AttentionStrip sessionId={SID} summary={summaryFor('ok')} />);
    expect(container.textContent).toBe('');
  });

  // The point of M10: a parked turn is "definitely needs your attention", which
  // is red under Destin's dot rule — and the label must be words, not the
  // internal state name.
  it('a parked turn is RED and reads as prose, not the raw state name', () => {
    const { container } = render(<AttentionStrip sessionId={SID} summary={summaryFor('stalled')} />);
    expect(container.textContent).toBe('provider may have stalled');
    expect(dotColor(container)).toBe('red');
  });

  // The other half of the rule: amber means "may be wrong, I don't know". The
  // stall WARNING is that state, and it must stay distinguishable from the
  // parked card that follows it 15 seconds later.
  it('the stall warning (stuck) is AMBER, so it is distinguishable from parked', () => {
    const { container } = render(<AttentionStrip sessionId={SID} summary={summaryFor('stuck')} />);
    expect(dotColor(container)).toBe('amber');
  });

  // Both terminal states mean "the turn is over, act now" — the same red the
  // sidebar dots and the AttentionBanner's destructive ring already use. This
  // pins the strip to attentionDotColor() rather than to a copy of its table.
  it.each<AttentionState>(['session-died', 'error'])('%s is RED, matching every other dot', (s) => {
    const { container } = render(<AttentionStrip sessionId={SID} summary={summaryFor(s)} />);
    expect(dotColor(container)).toBe('red');
  });

  it('an awaiting-approval session keeps its own amber pill', () => {
    const { container } = render(<AttentionStrip sessionId={SID} summary={summaryFor('ok', true)} />);
    expect(container.textContent).toBe('awaiting approval');
    expect(dotColor(container)).toBe('amber');
  });
});
