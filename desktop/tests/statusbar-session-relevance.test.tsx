// @vitest-environment jsdom
// The status bar must not render another runtime's furniture (5h/7d are a Claude subscription, Fast is a Claude Code
// toggle), must hide chips with no value, and must draw session totals and cost correctly.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, cleanup, act } from '@testing-library/react';
import type { ReactElement } from 'react';
import { makeStoreWrapper } from './helpers/chat-store-harness';
import '@testing-library/jest-dom/vitest';
import StatusBar from '../src/renderer/components/StatusBar';
import { emptyTotals, addTurnUsage, addSubagentUsage } from '../src/renderer/state/session-totals';

// Find a chip by its hover hint: the app's own <Tooltip> keeps the copy on the control as `data-hint`.
const hintNodes = () => Array.from(document.querySelectorAll('[data-hint]'));
const matchHint = (re: RegExp | string) =>
  hintNodes().filter((el) => {
    const h = el.getAttribute('data-hint') ?? '';
    return typeof re === 'string' ? h === re : re.test(h);
  });
function byHint(re: RegExp | string): HTMLElement {
  const found = matchHint(re);
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one hint matching ${re}, found ${found.length}` +
        (found.length ? '' : `\nhints present: ${hintNodes().map((e) => e.getAttribute('data-hint')).join(' | ')}`),
    );
  }
  return found[0] as HTMLElement;
}
const queryByHint = (re: RegExp | string): HTMLElement | null => (matchHint(re)[0] as HTMLElement) ?? null;

// StatusBar reads the chat store (SpecialistsChip), so every render goes through the REAL store + reducer, seeded with 's1'.
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: makeStoreWrapper(['s1']).wrapper });
}

// Explicit cleanup: this repo doesn't enable vitest `globals`, so Testing Library's implicit afterEach never registers.
afterEach(cleanup);

beforeEach(() => {
  // jsdom ships no localStorage here (Node's experimental one needs --localstorage-file): stub it.
  (window as any).localStorage = {
    _s: {} as Record<string, string>,
    getItem(k: string) { return this._s[k] ?? null; },
    setItem(k: string, v: string) { this._s[k] = v; },
    removeItem(k: string) { delete this._s[k]; },
  };
  // SessionTagsChip (always rendered with a sessionId) reads tags and session meta over window.claude; stub the minimal surface.
  (window as any).claude = {
    tags: { list: async () => [] },
    session: { getMeta: async () => ({}) },
    on: { tagsChanged: () => () => {}, sessionMetaChanged: () => () => {} },
  };
});

/** Positive control for absence-only tests: SessionTagsChip renders "Add tags" for any runtime once sessionId is set, so
 *  its presence proves the bar mounted (else the absence checks would pass vacuously on an empty container). */
const mounted = () => expect(screen.getByText('Add tags')).toBeInTheDocument();

const statusData = {
  usage: {
    five_hour: { utilization: 42, resets_at: new Date(Date.now() + 3.6e6).toISOString() },
    seven_day: { utilization: 17, resets_at: new Date(Date.now() + 8.6e7).toISOString() },
  },
  updateStatus: null,
  announcement: null,
  contextPercent: null,
  gitBranch: null,
  sessionStats: null,
  syncWarnings: [],
} as any;

describe('StatusBar runtime relevance', () => {
  it('shows the subscription chips and the Fast chip in a Claude Code session', () => {
    render(<StatusBar statusData={statusData} provider="claude" fast sessionId="s1" />);
    expect(screen.getByText('5h:')).toBeInTheDocument();
    expect(screen.getByText('7d:')).toBeInTheDocument();
    // The Fast chip is icon-only: find it by its accessible name.
    expect(screen.getByRole('button', { name: /fast/i })).toBeInTheDocument();
  });

  it('renders none of them in a native session', () => {
    render(<StatusBar statusData={statusData} provider="native" fast sessionId="s1" />);
    expect(screen.queryByText('5h:')).toBeNull();
    expect(screen.queryByText('7d:')).toBeNull();
    expect(screen.queryByRole('button', { name: /fast/i })).toBeNull();
    mounted();
  });

  it('treats an unwired provider as Claude Code, so nothing hides by accident', () => {
    render(<StatusBar statusData={statusData} fast sessionId="s1" />);
    expect(screen.getByText('5h:')).toBeInTheDocument();
  });
});

describe('StatusBar renders no empty chips', () => {
  // A chip with no value hides: Session Duration, Active ratio and the token/speed chips once printed a literal '--'.
  const widgets = ['session-time', 'active-ratio', 'tokens-in', 'tokens-out', 'output-speed', 'cache-stats', 'cache-hit-rate'];

  it('renders no "--" anywhere in a native session with no data', () => {
    window.localStorage.setItem('youcoded-statusbar-widgets', JSON.stringify(widgets));
    const { container } = render(<StatusBar statusData={statusData} provider="native" sessionId="s1" />);
    expect(container.textContent).not.toContain('--');
    mounted();
  });

  it('renders no "--" in a Claude Code session whose stats have not arrived yet', () => {
    window.localStorage.setItem('youcoded-statusbar-widgets', JSON.stringify(widgets));
    const { container } = render(<StatusBar statusData={statusData} provider="claude" sessionId="s1" />);
    expect(container.textContent).not.toContain('--');
    mounted();
  });

  it('still renders the chip once it has a value', () => {
    window.localStorage.setItem('youcoded-statusbar-widgets', JSON.stringify(['active-ratio']));
    const withStats = { ...statusData, sessionStats: { duration: 1000, apiDuration: 250 } };
    render(<StatusBar statusData={withStats} provider="claude" sessionId="s1" />);
    expect(screen.getByText('25%')).toBeInTheDocument();
  });
});

const withWidgets = (ids: string[]) =>
  window.localStorage.setItem('youcoded-statusbar-widgets', JSON.stringify(ids));

describe('StatusBar live native session totals', () => {
  it('shows first request before any turn completes and keeps absent costs hidden', () => {
    withWidgets(['tokens-in', 'tokens-out', 'cache-stats', 'session-cost']);
    const { wrapper, store } = makeStoreWrapper(['s1']);
    rtlRender(<StatusBar statusData={statusData} provider="native" nativeTotals={emptyTotals()} sessionId="s1" />, { wrapper });
    expect(screen.queryByText('In:')).toBeNull();
    act(() => store.dispatch({ type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: 's1',
      usageProgress: { inputTokens: 40, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
      timestamp: 10, uuid: 'first' }));
    expect(byHint(/Input tokens: 40\./)).toBeInTheDocument();
    expect(byHint(/Output tokens: 5\./)).toBeInTheDocument();
    expect(byHint(/Cache read: 0 \| Cache created: 0/)).toBeInTheDocument();
    expect(screen.queryByText('Cost:')).toBeNull();
  });

  it('shows cumulative request progress plus durable specialists and replaces it at completion', () => {
    withWidgets(['tokens-in', 'tokens-out', 'cache-stats', 'cache-hit-rate', 'session-cost']);
    const { wrapper, store } = makeStoreWrapper(['s1']);
    const totals = { ...emptyTotals(), inputTokens: 100, outputTokens: 20, cacheReadTokens: 30,
      costUsd: 0.02, anyPriced: true, specialistCostUsd: 0.02, specialistRuns: 1 };
    const progress = (inputTokens: number, outputTokens: number, cacheReadTokens: number, costUsd: number) =>
      ({ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens: 0, costUsd });
    const ui = (t = totals) => <StatusBar statusData={statusData} provider="native" nativeTotals={t} sessionId="s1" />;
    const view = rtlRender(ui(), { wrapper });
    act(() => store.dispatch({ type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: 's1',
      usageProgress: progress(200, 30, 50, 0.04), timestamp: 10, uuid: 'p1' }));
    expect(byHint(/Input tokens: 300\./)).toBeInTheDocument();
    expect(byHint(/Output tokens: 50\./)).toBeInTheDocument();
    expect(byHint(/Cache read: 80 \| Cache created: 0/)).toBeInTheDocument();
    expect(screen.getByText('$0.06')).toBeInTheDocument();
    act(() => store.dispatch({ type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: 's1',
      usageProgress: progress(350, 55, 90, 0.07), timestamp: 11, uuid: 'p2' }));
    expect(byHint(/Input tokens: 450\./)).toBeInTheDocument();
    expect(screen.getByText('$0.09')).toBeInTheDocument();
    act(() => store.dispatch({ type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: 's1',
      uuid: 'done', timestamp: 12, model: null, anthropicRequestId: null,
      stopReason: 'end_turn', usage: progress(350, 55, 90, 0.07) }));
    view.rerender(ui({ ...totals, inputTokens: 450, outputTokens: 75, cacheReadTokens: 120, costUsd: 0.09 }));
    expect(byHint(/Input tokens: 450\./)).toBeInTheDocument();
    expect(screen.getByText('$0.09')).toBeInTheDocument();
  });
});

describe('StatusBar session totals', () => {
  it('renders cumulative In/Out from totals in a native session, abbreviated, with the exact count in the tooltip', () => {
    withWidgets(['tokens-in', 'tokens-out']);
    const totals = { ...emptyTotals(), inputTokens: 12_345, outputTokens: 678 };
    render(<StatusBar statusData={statusData} provider="native" nativeTotals={totals} sessionId="s1" />);
    // Displayed value stays abbreviated (a chip must not read "1,234,567"); the exact count lives in the tooltip.
    expect(screen.getByText('12.3k')).toBeInTheDocument();
    expect(screen.getByText('678')).toBeInTheDocument();
    expect(byHint(/Input tokens: 12,345\./)).toBeInTheDocument();
    expect(byHint(/Output tokens: 678\./)).toBeInTheDocument();
  });

  it('renders a derived Code changes count in a native session', () => {
    withWidgets(['code-changes']);
    const totals = { ...emptyTotals(), linesAdded: 40, linesRemoved: 9 };
    render(<StatusBar statusData={statusData} provider="native" nativeTotals={totals} sessionId="s1" />);
    expect(screen.getByText('+40')).toBeInTheDocument();
    expect(screen.getByText('-9')).toBeInTheDocument();
  });

  it('renders NOTHING for Code changes when nothing has been edited — never "No changes"', () => {
    withWidgets(['code-changes']);
    render(<StatusBar statusData={statusData} provider="native" nativeTotals={emptyTotals()} sessionId="s1" />);
    expect(screen.queryByText(/no changes/i)).toBeNull();
    expect(screen.queryByText(/lines/i)).toBeNull();
    mounted();
  });

  it('says what the numbers include', () => {
    withWidgets(['tokens-in']);
    const totals = { ...emptyTotals(), inputTokens: 10, specialistRuns: 2 };
    render(<StatusBar statusData={statusData} provider="native" nativeTotals={totals} sessionId="s1" />);
    expect(byHint(/including specialists/i)).toBeInTheDocument();
  });
});

describe('StatusBar — a brand-new native session has measured nothing', () => {
  // WHY: a fresh session's totals are all-zero, NOT null; chips gated on `value != null` rendered "0" from creation. They must gate on having measured something.
  it('renders no In, Out, Cached or Reuse chip for a session that has completed no turns', () => {
    withWidgets(['tokens-in', 'tokens-out', 'cache-stats', 'cache-hit-rate']);
    render(<StatusBar statusData={statusData} provider="native" nativeTotals={emptyTotals()} sessionId="s1" />);
    expect(screen.queryByText('In:')).toBeNull();
    expect(screen.queryByText('Out:')).toBeNull();
    expect(screen.queryByText('Cached:')).toBeNull();
    expect(screen.queryByText('Reuse:')).toBeNull();
    mounted();
  });

  it('still renders In, Out and Cached once the session has a real measurement', () => {
    withWidgets(['tokens-in', 'tokens-out', 'cache-stats']);
    const totals = { ...emptyTotals(), inputTokens: 500, outputTokens: 300, cacheReadTokens: 200 };
    render(<StatusBar statusData={statusData} provider="native" nativeTotals={totals} sessionId="s1" />);
    expect(screen.getByText('In:')).toBeInTheDocument();
    expect(screen.getByText('500')).toBeInTheDocument();
    expect(screen.getByText('Out:')).toBeInTheDocument();
    expect(screen.getByText('300')).toBeInTheDocument();
    expect(screen.getByText('Cached:')).toBeInTheDocument();
    expect(screen.getByText('200')).toBeInTheDocument();
  });

  it('still renders Reuse once the session has real prompt and cache-read tokens', () => {
    withWidgets(['cache-hit-rate']);
    // turnsWithUsage: 2 so a real (non-first-turn) percentage is exercised.
    const totals = { ...emptyTotals(), inputTokens: 1000, cacheReadTokens: 400 };
    render(<StatusBar statusData={statusData} provider="native" nativeTotals={totals} turnsWithUsage={2} sessionId="s1" />);
    expect(screen.getByText('Reuse:')).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
  });

  it('uses friendlier zero-reuse tooltip copy for a native session with real prompt tokens but no cache hits', () => {
    withWidgets(['cache-hit-rate']);
    const totals = { ...emptyTotals(), inputTokens: 1000, cacheReadTokens: 0 };
    render(<StatusBar statusData={statusData} provider="native" nativeTotals={totals} turnsWithUsage={2} sessionId="s1" />);
    expect(byHint(
      "None of this session's prompt tokens came from cache; all 1,000 were read fresh. Counts this session so far, including specialists."
    )).toBeInTheDocument();
  });
});

describe('StatusBar — a measured zero is a real reading, not an unmeasured one (regression)', () => {
  // inputTokens > 0 means "a turn was counted", so the zeros beside it (Out: 0, a cold prompt cache's Cached: 0) are real readings and must show.
  it('renders Out: 0 and Cached: 0 for a Claude Code session with real zeros', () => {
    withWidgets(['tokens-in', 'tokens-out', 'cache-stats']);
    const withStats = { ...statusData };
    render(
      <StatusBar
        statusData={withStats}
        provider="claude"
        sessionId="s1"
        nativeTotals={{
          ...emptyTotals(),
          inputTokens: 1500,      // a turn WAS counted…
          outputTokens: 0,        // …and these zeros are its real readings
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }}
      />,
    );
    expect(screen.getByText('In:')).toBeInTheDocument();
    expect(screen.getByText('1.5k')).toBeInTheDocument();
    expect(screen.getByText('Out:')).toBeInTheDocument();
    expect(screen.getByText('Cached:')).toBeInTheDocument();
    expect(screen.getAllByText('0')).toHaveLength(2);
  });
});

describe('Session cost chip', () => {
  const costTotals = (over: Partial<ReturnType<typeof emptyTotals>>) => ({ ...emptyTotals(), ...over });

  it('shows a cost when priced work happened', () => {
    withWidgets(['session-cost']);
    render(<StatusBar statusData={statusData} provider="native" sessionId="s1"
      nativeTotals={costTotals({ costUsd: 1.3749, anyPriced: true })} />);
    expect(screen.getByText('$1.37')).toBeInTheDocument();
  });

  it('renders NOTHING — never $0.00 — for a local session that costs nothing to run', () => {
    withWidgets(['session-cost']);
    // Silence is the answer for a free local session; "not listed" (metered but unpriced) is the opposite situation.
    render(<StatusBar statusData={statusData} provider="native" sessionId="s1"
      nativeTotals={costTotals({ costUsd: 0, anyFree: true })} />);
    // Assert the CHIP's label is gone, not just the '$' glyph (the pre-fix code rendered '--' and satisfied a /\$/ check).
    expect(screen.queryByText('Cost:')).toBeNull();
    expect(screen.queryByText(/\$/)).toBeNull();
    expect(screen.queryByText('not listed')).toBeNull();
    mounted();
  });

  it('renders NOTHING when the session has measured nothing at all', () => {
    withWidgets(['session-cost']);
    render(<StatusBar statusData={statusData} provider="native" sessionId="s1"
      nativeTotals={costTotals({})} />);
    expect(screen.queryByText('Cost:')).toBeNull();
    expect(screen.queryByText('not listed')).toBeNull();
    mounted();
  });

  // WHY: a free local session and a metered session with an unpriced model once rendered an IDENTICAL bar; one of them spends the user's money.
  it('says "not listed" when the provider bills but this model has no published price', () => {
    withWidgets(['session-cost']);
    render(<StatusBar statusData={statusData} provider="native" sessionId="s1"
      nativeTotals={costTotals({ costUsd: 0, anyUnpriced: true })} />);
    expect(screen.getByText('Cost:')).toBeInTheDocument();
    expect(screen.getByText('not listed')).toBeInTheDocument();
    // It is an absence, not a figure — no dollar amount may appear.
    expect(screen.queryByText(/\$/)).toBeNull();
    // "not available", not "not published": an empty catalog after a failed fetch looks exactly like a model with no rate.
    expect(byHint(
      "This provider bills for usage, but no price is available for this model here, so the session cost can't be totalled."
    )).toBeInTheDocument();
  });

  // Both flags at once (free local parent, metered specialist): a real figure must win over "not listed".
  it('prefers a real figure over "not listed" when free, unpriced and priced work all happened', () => {
    withWidgets(['session-cost']);
    render(<StatusBar statusData={statusData} provider="native" sessionId="s1"
      nativeTotals={costTotals({
        costUsd: 0.61, anyPriced: true, anyUnpriced: true, anyFree: true,
        specialistRuns: 2, specialistCostUsd: 0.61,
      })} />);
    expect(screen.getByText('$0.61')).toBeInTheDocument();
    expect(screen.getByText('· specialists')).toBeInTheDocument();
    expect(screen.queryByText('not listed')).toBeNull();
  });

  it('names specialist spend on the chip and splits it in the tooltip', () => {
    withWidgets(['session-cost']);
    render(<StatusBar statusData={statusData} provider="native" sessionId="s1"
      nativeTotals={costTotals({ costUsd: 1.2, anyPriced: true, specialistRuns: 1, specialistCostUsd: 0.3 })} />);
    expect(screen.getByText('$1.20')).toBeInTheDocument();
    expect(screen.getByText('· specialists')).toBeInTheDocument();
    // One specialist is "1 specialist", not "1 specialists".
    expect(byHint(/\$0\.30 of this was spent by 1 specialist this session delegated to\./)).toBeInTheDocument();
  });

  it('shows no specialist marker when the session delegated nothing', () => {
    withWidgets(['session-cost']);
    render(<StatusBar statusData={statusData} provider="native" sessionId="s1"
      nativeTotals={costTotals({ costUsd: 0.42, anyPriced: true })} />);
    expect(screen.getByText('$0.42')).toBeInTheDocument();
    expect(screen.queryByText('· specialists')).toBeNull();
    expect(queryByHint(/specialists this session delegated to/)).toBeNull();
  });

  // The sub-cent guard must survive the specialist marker appended to the same chip.
  it('keeps the <$0.01 guard when the specialist marker is appended', () => {
    withWidgets(['session-cost']);
    render(<StatusBar statusData={statusData} provider="native" sessionId="s1"
      nativeTotals={costTotals({ costUsd: 0.0004, anyPriced: true, specialistRuns: 1, specialistCostUsd: 0.0004 })} />);
    expect(screen.getByText('<$0.01')).toBeInTheDocument();
    expect(screen.getByText('· specialists')).toBeInTheDocument();
    expect(screen.queryByText('$0.00')).toBeNull();
    expect(byHint(/<\$0\.01 of this was spent by 1 specialist this session delegated to\./)).toBeInTheDocument();
  });

  // A fraction of a cent is REAL money: toFixed(2) alone would show "$0.00".
  it('renders <$0.01 for a real sub-cent cost, never $0.00', () => {
    withWidgets(['session-cost']);
    render(<StatusBar statusData={statusData} provider="native" sessionId="s1"
      nativeTotals={costTotals({ costUsd: 0.0004, anyPriced: true })} />);
    expect(screen.queryByText('Cost:')).toBeTruthy();
    expect(screen.queryByText('<$0.01')).toBeTruthy();
    expect(screen.queryByText('$0.00')).toBeNull();
  });

  it('renders <$0.01 for a sub-cent Claude Code session cost', () => {
    withWidgets(['session-cost']);
    const withCost = { ...statusData, sessionStats: { costUsd: 0.003 } };
    render(<StatusBar statusData={withCost} provider="claude" sessionId="s1" />);
    expect(screen.queryByText('<$0.01')).toBeTruthy();
    expect(screen.queryByText('$0.00')).toBeNull();
  });

  it('shows the cost of a metered SPECIALIST under a free local parent', () => {
    withWidgets(['session-cost']);
    render(<StatusBar statusData={statusData} provider="native" sessionId="s1"
      nativeTotals={costTotals({ costUsd: 0.42, anyPriced: true, anyUnpriced: true, specialistRuns: 1 })} />);
    expect(screen.getByText('$0.42')).toBeInTheDocument();
  });

  it('says the figure is partial when some work had no price', () => {
    withWidgets(['session-cost']);
    render(<StatusBar statusData={statusData} provider="native" sessionId="s1"
      nativeTotals={costTotals({ costUsd: 0.42, anyPriced: true, anyUnpriced: true })} />);
    // Matched inside the chip's concatenated title; kept in step with UsageCard's PARTIAL_NOTE so bar and card never disagree.
    expect(
      byHint(/Models with no available price are not included in this total\./),
    ).toBeInTheDocument();
  });
});

// WHY end to end: a local-engine turn is stamped `costUsd: null, free: true`; the accumulator once read the null alone as
// "unpriced" and the bar claimed the provider bills for a model on the user's own machine. Hand-built flags hid it, so
// these totals come from the real accumulator.
describe('Session cost — a purely local session, end to end', () => {
  const localSessionTotals = () => {
    let t = emptyTotals();
    t = addTurnUsage(t, { inputTokens: 1200, outputTokens: 340, costUsd: null, free: true });
    t = addTurnUsage(t, { inputTokens: 1500, outputTokens: 120, costUsd: null, free: true });
    return t;
  };

  it('draws no cost chip at all, and never the words "not listed"', () => {
    withWidgets(['session-cost']);
    const { container } = render(<StatusBar statusData={statusData} provider="native"
      sessionId="s1" nativeTotals={localSessionTotals()} />);
    expect(screen.queryByText('Cost:')).toBeNull();
    expect(screen.queryByText('not listed')).toBeNull();
    expect(container.textContent).not.toContain('not listed');
    expect(screen.queryByText(/\$/)).toBeNull();
    mounted();
  });

  it('still draws no cost chip when that local session delegated to a free local specialist', () => {
    withWidgets(['session-cost']);
    let t = localSessionTotals();
    t = addSubagentUsage(t, { inputTokens: 300, outputTokens: 60, costUsd: null, free: true });
    const { container } = render(<StatusBar statusData={statusData} provider="native"
      sessionId="s1" nativeTotals={t} />);
    expect(screen.queryByText('Cost:')).toBeNull();
    expect(container.textContent).not.toContain('not listed');
    mounted();
  });

  // The Customize menu's local sentence is gated on !anyUnpriced, so the defect made it unreachable.
  it('offers the Cost row with the local sentence the defect made unreachable', () => {
    render(<StatusBar statusData={statusData} provider="native"
      sessionId="s1" nativeTotals={localSessionTotals()} />);
    fireEvent.click(screen.getByRole('button', { name: /status bar widgets|customize/i }));
    expect(screen.getByText("Models on your own machine don't cost anything to run")).toBeInTheDocument();
    expect(screen.queryByText('not listed')).toBeNull();
  });

  // Other direction: a metered model with no published rate must still say so.
  it('still says "not listed" for a metered session whose model has no published price', () => {
    withWidgets(['session-cost']);
    let t = emptyTotals();
    t = addTurnUsage(t, { inputTokens: 1200, outputTokens: 340, costUsd: null });
    render(<StatusBar statusData={statusData} provider="native" sessionId="s1" nativeTotals={t} />);
    expect(screen.getByText('Cost:')).toBeInTheDocument();
    expect(screen.getByText('not listed')).toBeInTheDocument();
  });
});
