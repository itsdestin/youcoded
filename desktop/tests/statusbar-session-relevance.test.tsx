// @vitest-environment jsdom
// desktop/tests/statusbar-session-relevance.test.tsx
//
// The bar must not render another runtime's furniture. 5h/7d describe a Claude
// subscription a native session doesn't spend; Fast mode is a Claude Code
// toggle nothing native honours (spec §3).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, cleanup } from '@testing-library/react';
import type { ReactElement } from 'react';
import { makeStoreWrapper } from './helpers/chat-store-harness';
import '@testing-library/jest-dom/vitest';
import StatusBar from '../src/renderer/components/StatusBar';
import { emptyTotals, addTurnUsage, addSubagentUsage } from '../src/renderer/state/session-totals';

/**
 * Find a chip by the words of its hover hint.
 *
 * These assertions used to be `screen.getByTitle(...)`. The hints are now the
 * app's own `<Tooltip>` rather than the browser's `title=` bubble, so the copy
 * lives on the control as `data-hint` and in a portal while the bubble is open.
 * The assertions are unchanged in substance — still about the WORDS the chip
 * offers, not about how it draws them.
 */
/**
 * Open every info button on screen, so the copy behind them is readable.
 *
 * The chips whose explanation is a whole SENTENCE no longer hover at all — that
 * copy moved to the app's click-open info bubble (`AnchorTip`), which is what
 * Destin chose on the questions deck (Q-5) and confirmed on the live deck. Its
 * words are in the DOM only while it is open, so these assertions open them all
 * first and then read the page. That is closer to what a person does than
 * reading an attribute ever was.
 */
const hintNodes = () => Array.from(document.querySelectorAll('[data-hint]'));

/**
 * The words behind every info button, read ONE AT A TIME.
 *
 * Only one of these bubbles can be open at once — opening the next dismisses the
 * last, which is the whole point of a click-open explanation. So this opens each
 * one, reads it, and closes it again rather than opening them all and reading
 * the page.
 */
function infoBubbleTexts(): string[] {
  const out: string[] = [];
  document.querySelectorAll('button[aria-expanded]').forEach((b) => {
    fireEvent.click(b);
    document.querySelectorAll('[role="dialog"], [role="tooltip"]').forEach((n) => {
      if (n.textContent) out.push(n.textContent);
    });
    fireEvent.click(b);
  });
  return out;
}
const hit = (text: string, re: RegExp | string) =>
  typeof re === 'string' ? text === re : re.test(text);

/** Every place a hint's words can live: on the control for a hover hint, inside
 *  the bubble for a click-open explanation. */
const matchHint = (re: RegExp | string): string[] => [
  ...hintNodes().map((el) => el.getAttribute('data-hint') ?? '').filter((t) => hit(t, re)),
  ...infoBubbleTexts().filter((t) => hit(t, re)),
];
function byHint(re: RegExp | string): string {
  const found = matchHint(re);
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one hint matching ${re}, found ${found.length}` +
        (found.length ? '' : `\nhints present: ${[...hintNodes().map((e) => e.getAttribute('data-hint')), ...infoBubbleTexts()].join(' | ')}`),
    );
  }
  return found[0];
}
const queryByHint = (re: RegExp | string): string | null => matchHint(re)[0] ?? null;

// Master added <SpecialistsChip> to the bar (useSpecialistSummary → useChatStore),
// so StatusBar can no longer mount outside a ChatProvider. Every render here
// goes through the REAL store + reducer this branch already uses for hook tests
// (helpers/chat-store-harness.ts), seeded with the 's1' session these tests name.
// With no specialist runs in that session the chip renders null, so the bar's
// DOM — and every assertion below — is unchanged.
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: makeStoreWrapper(['s1']).wrapper });
}

// Multiple <StatusBar> renders share one jsdom document in this file — without
// explicit cleanup a later test's queryByText/getByText would see the
// previous test's DOM too (this repo doesn't enable vitest's `globals`, so
// Testing Library's implicit afterEach cleanup never registers).
afterEach(cleanup);

beforeEach(() => {
  // This repo's jsdom ships no localStorage (Node's experimental global
  // storage needs --localstorage-file, which isn't passed) — stub it the same
  // way tests/remote-shim-unsupported.test.ts does.
  (window as any).localStorage = {
    _s: {} as Record<string, string>,
    getItem(k: string) { return this._s[k] ?? null; },
    setItem(k: string, v: string) { this._s[k] = v; },
    removeItem(k: string) { delete this._s[k]; },
  };
  // StatusBar renders SessionTagsChip unconditionally whenever sessionId is
  // set; that chip reads the tag registry and session meta over
  // window.claude. Stub the minimal surface so mounting it doesn't crash in
  // this DOM-only harness — none of these values are under test here.
  (window as any).claude = {
    tags: { list: async () => [] },
    session: { getMeta: async () => ({}) },
    on: { tagsChanged: () => () => {}, sessionMetaChanged: () => () => {} },
  };
});

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
    // The Fast chip is icon-only (FastIcon, no text node) — its only
    // accessible name is aria-label="Fast mode on", so getByText can never
    // find it regardless of the runtime gate. getByRole reads the computed
    // accessible name instead.
    expect(screen.getByRole('button', { name: /fast/i })).toBeInTheDocument();
  });

  it('renders none of them in a native session', () => {
    render(<StatusBar statusData={statusData} provider="native" fast sessionId="s1" />);
    expect(screen.queryByText('5h:')).toBeNull();
    expect(screen.queryByText('7d:')).toBeNull();
    expect(screen.queryByRole('button', { name: /fast/i })).toBeNull();
    // Positive control: an assertion that only checks absences would also pass
    // if the whole bar failed to render. SessionTagsChip renders for ANY
    // runtime whenever sessionId is set (verified against its source: the only
    // gate is `!isAndroid()`) and shows "Add tags" synchronously — before the
    // stubbed getMeta() promise resolves — since useSessionMeta initializes
    // tags/note empty. Its presence here proves the bar actually mounted.
    expect(screen.getByText('Add tags')).toBeInTheDocument();
  });

  it('treats an unwired provider as Claude Code, so nothing hides by accident', () => {
    render(<StatusBar statusData={statusData} fast sessionId="s1" />);
    expect(screen.getByText('5h:')).toBeInTheDocument();
  });
});

describe('StatusBar renders no empty chips', () => {
  // Rule 1 (spec §3): a chip with no value hides. Verified today: Session
  // Duration (StatusBar.tsx:1289) and Active Ratio (:1377) both print a literal
  // '--' in every native session, forever, and the token/speed chips do the same
  // before their first turn.
  const widgets = ['session-time', 'active-ratio', 'tokens-in', 'tokens-out', 'output-speed', 'cache-stats', 'cache-hit-rate'];

  it('renders no "--" anywhere in a native session with no data', () => {
    window.localStorage.setItem('youcoded-statusbar-widgets', JSON.stringify(widgets));
    const { container } = render(<StatusBar statusData={statusData} provider="native" sessionId="s1" />);
    expect(container.textContent).not.toContain('--');
    // Positive control (see the runtime-relevance describe above for why):
    // proves this render actually mounted the bar rather than the assertion
    // above passing vacuously on an empty container.
    expect(screen.getByText('Add tags')).toBeInTheDocument();
  });

  it('renders no "--" in a Claude Code session whose stats have not arrived yet', () => {
    window.localStorage.setItem('youcoded-statusbar-widgets', JSON.stringify(widgets));
    const { container } = render(<StatusBar statusData={statusData} provider="claude" sessionId="s1" />);
    expect(container.textContent).not.toContain('--');
    // Positive control, same reasoning as above.
    expect(screen.getByText('Add tags')).toBeInTheDocument();
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

describe('StatusBar session totals', () => {
  it('renders cumulative In/Out from totals in a native session, abbreviated, with the exact count in the tooltip', () => {
    withWidgets(['tokens-in', 'tokens-out']);
    const totals = { ...emptyTotals(), inputTokens: 12_345, outputTokens: 678 };
    render(<StatusBar statusData={statusData} provider="native" nativeTotals={totals} sessionId="s1" />);
    // The chip's displayed value stays abbreviated (formatTokens) even though
    // this is now a whole-session total that can run much larger than a
    // single turn — a status-bar chip must not read "1,234,567".
    expect(screen.getByText('12.3k')).toBeInTheDocument();
    expect(screen.getByText('678')).toBeInTheDocument();
    // The exact count is still pinned somewhere: the tooltip.
    expect(byHint(/Input tokens: 12,345\./)).toBeTruthy();
    expect(byHint(/Output tokens: 678\./)).toBeTruthy();
  });

  it('renders a derived Code Changes count in a native session', () => {
    withWidgets(['code-changes']);
    const totals = { ...emptyTotals(), linesAdded: 40, linesRemoved: 9 };
    render(<StatusBar statusData={statusData} provider="native" nativeTotals={totals} sessionId="s1" />);
    expect(screen.getByText('+40')).toBeInTheDocument();
    expect(screen.getByText('-9')).toBeInTheDocument();
  });

  it('renders NOTHING for Code Changes when nothing has been edited — never "No changes"', () => {
    withWidgets(['code-changes']);
    render(<StatusBar statusData={statusData} provider="native" nativeTotals={emptyTotals()} sessionId="s1" />);
    expect(screen.queryByText(/no changes/i)).toBeNull();
    expect(screen.queryByText(/lines/i)).toBeNull();
    // Positive control (Finding 3): the two assertions above only check
    // absence, so a total render failure (bar never mounted) would pass them
    // too. SessionTagsChip renders "Add tags" for any runtime the instant
    // sessionId is set (see the earlier positive controls in this file) —
    // its presence proves the bar actually mounted around the missing chip.
    expect(screen.getByText('Add tags')).toBeInTheDocument();
  });

  it('says what the numbers include', () => {
    withWidgets(['tokens-in']);
    const totals = { ...emptyTotals(), inputTokens: 10, specialistRuns: 2 };
    render(<StatusBar statusData={statusData} provider="native" nativeTotals={totals} sessionId="s1" />);
    expect(byHint(/including specialists/i)).toBeTruthy();
  });
});

describe('StatusBar — a brand-new native session has measured nothing (Finding 1)', () => {
  // createSessionChatState() seeds a fresh native session's totals with
  // emptyTotals() — all-zero, NOT null — the instant the session enters the
  // store, before any turn has completed. The token chips used to gate on
  // `value != null`, and 0 != null is true, so In/Out/Cached rendered "0"
  // from session creation onward for anyone with those opt-in chips on. This
  // pins the fix: a chip must gate on having measured something, not merely
  // on the value being present.
  it('renders no In, Out, Cached or Reuse chip for a session that has completed no turns', () => {
    withWidgets(['tokens-in', 'tokens-out', 'cache-stats', 'cache-hit-rate']);
    render(<StatusBar statusData={statusData} provider="native" nativeTotals={emptyTotals()} sessionId="s1" />);
    expect(screen.queryByText('In:')).toBeNull();
    expect(screen.queryByText('Out:')).toBeNull();
    expect(screen.queryByText('Cached:')).toBeNull();
    expect(screen.queryByText('Reuse:')).toBeNull();
    // Positive control: proves the bar mounted rather than the four absence
    // checks above passing vacuously on an empty container.
    expect(screen.getByText('Add tags')).toBeInTheDocument();
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

  it('uses friendlier zero-reuse tooltip copy for a native session with real prompt tokens but no cache hits (Finding 4)', () => {
    withWidgets(['cache-hit-rate']);
    const totals = { ...emptyTotals(), inputTokens: 1000, cacheReadTokens: 0 };
    render(<StatusBar statusData={statusData} provider="native" nativeTotals={totals} turnsWithUsage={2} sessionId="s1" />);
    expect(byHint(
      "None of this session's prompt tokens came from cache; all 1,000 were read fresh. Counts this session so far, including specialists."
    )).toBeTruthy();
  });
});

describe('StatusBar — a measured zero is a real reading, not an unmeasured one (regression)', () => {
  // A reviewer once caught a version of the zero-collapse that swallowed a
  // genuine reading of 0 — Out: 0 on a turn that produced none, or Cached: 0 on
  // a cold/expired prompt cache (common, not an edge case). This pins it back.
  //
  // Rewritten 2026-09-03: the fixture used to be a Claude Code STATUSLINE with
  // zeros, because that was where the chips read tokens from. It isn't any more
  // — the statusline's token fields describe one request, so a 42-hour session
  // showed Out: 713 — and the chips read session totals on both runtimes. The
  // invariant is unchanged and now has a single expression of it: inputTokens
  // > 0 means "a turn was counted", and every other zero beside it is real.
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
    // Non-zero In still renders (sanity — proves the fixture is wired right).
    expect(screen.getByText('In:')).toBeInTheDocument();
    expect(screen.getByText('1.5k')).toBeInTheDocument();
    // The regression: Out: 0 and Cached: 0 are REAL measurements and must show.
    expect(screen.getByText('Out:')).toBeInTheDocument();
    expect(screen.getByText('Cached:')).toBeInTheDocument();
    // Both chips display the literal measured value: 0.
    expect(screen.getAllByText('0')).toHaveLength(2);
  });
});

describe('Session Cost chip', () => {
  const costTotals = (over: Partial<ReturnType<typeof emptyTotals>>) => ({ ...emptyTotals(), ...over });

  it('shows a cost when priced work happened', () => {
    withWidgets(['session-cost']);
    render(<StatusBar statusData={statusData} provider="native" sessionId="s1"
      nativeTotals={costTotals({ costUsd: 1.3749, anyPriced: true })} />);
    expect(screen.getByText('$1.37')).toBeInTheDocument();
  });

  it('renders NOTHING — never $0.00 — for a local session that costs nothing to run', () => {
    withWidgets(['session-cost']);
    // Destin declined a "Free" chip (checkpoint #2): silence stays the answer
    // for a local session. This fixture used to be `{ anyUnpriced: true }`,
    // which now has a chip of its own ("not listed") — free-to-run and
    // metered-but-unpriced are opposite situations and no longer share a
    // branch, which is the whole point of checkpoint #3.
    render(<StatusBar statusData={statusData} provider="native" sessionId="s1"
      nativeTotals={costTotals({ costUsd: 0, anyFree: true })} />);
    // Assert the CHIP is gone, not just the '$' glyph: an earlier version of
    // this test looked for /\$/, which the pre-fix code satisfied by rendering
    // the literal '--' — so it passed against the very defect it claimed to
    // guard. The chip's label is the thing that must be absent.
    expect(screen.queryByText('Cost:')).toBeNull();
    expect(screen.queryByText(/\$/)).toBeNull();
    expect(screen.queryByText('not listed')).toBeNull();
    // Positive control: the three absence checks above would also pass if the
    // bar never mounted.
    expect(screen.getByText('Add tags')).toBeInTheDocument();
  });

  it('renders NOTHING when the session has measured nothing at all', () => {
    withWidgets(['session-cost']);
    render(<StatusBar statusData={statusData} provider="native" sessionId="s1"
      nativeTotals={costTotals({})} />);
    expect(screen.queryByText('Cost:')).toBeNull();
    expect(screen.queryByText('not listed')).toBeNull();
    expect(screen.getByText('Add tags')).toBeInTheDocument();
  });

  // Checkpoint #3. Before this, a free local session and a metered session
  // whose model has no published price rendered an IDENTICAL bar (verified
  // with `magick compare`: 0 differing pixels) because both simply hid the
  // chip. One of those two is spending the user's money.
  it('says "not listed" when the provider bills but this model has no published price', () => {
    withWidgets(['session-cost']);
    render(<StatusBar statusData={statusData} provider="native" sessionId="s1"
      nativeTotals={costTotals({ costUsd: 0, anyUnpriced: true })} />);
    expect(screen.getByText('Cost:')).toBeInTheDocument();
    expect(screen.getByText('not listed')).toBeInTheDocument();
    // It is an absence, not a figure — no dollar amount may appear.
    expect(screen.queryByText(/\$/)).toBeNull();
    // "not available", not "not published": pricingFor returns null for ANY
    // model missing from the catalog, and an empty catalog after a failed
    // fetch looks exactly like a model with no rate. Saying "no price is
    // published" states a cause that was never checked
    // (docs/error-message-standards.md). This wording is true either way.
    expect(byHint(
      "This provider bills for usage, but no price is available for this model here, so the session cost can't be totalled."
    )).toBeTruthy();
  });

  // Both flags can be true at once: a free local parent that delegated to a
  // metered specialist. A real figure must win — "not listed" alongside a
  // number would read as two different answers to the same question.
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

  // Checkpoint #4: name where the money came from on the chip itself, not only
  // in a tooltip nobody hovers.
  it('names specialist spend on the chip and splits it in the tooltip', () => {
    withWidgets(['session-cost']);
    render(<StatusBar statusData={statusData} provider="native" sessionId="s1"
      nativeTotals={costTotals({ costUsd: 1.2, anyPriced: true, specialistRuns: 1, specialistCostUsd: 0.3 })} />);
    expect(screen.getByText('$1.20')).toBeInTheDocument();
    expect(screen.getByText('· specialists')).toBeInTheDocument();
    // One specialist is "1 specialist", not "1 specialists".
    expect(byHint(/\$0\.30 of this was spent by 1 specialist this session delegated to\./)).toBeTruthy();
  });

  it('shows no specialist marker when the session delegated nothing', () => {
    withWidgets(['session-cost']);
    render(<StatusBar statusData={statusData} provider="native" sessionId="s1"
      nativeTotals={costTotals({ costUsd: 0.42, anyPriced: true })} />);
    expect(screen.getByText('$0.42')).toBeInTheDocument();
    expect(screen.queryByText('· specialists')).toBeNull();
    expect(queryByHint(/specialists this session delegated to/)).toBeNull();
  });

  // The sub-cent guard from commit 4c5b06d3 must survive the new marker: the
  // marker is appended to the SAME chip that guard protects.
  it('keeps the <$0.01 guard when the specialist marker is appended', () => {
    withWidgets(['session-cost']);
    render(<StatusBar statusData={statusData} provider="native" sessionId="s1"
      nativeTotals={costTotals({ costUsd: 0.0004, anyPriced: true, specialistRuns: 1, specialistCostUsd: 0.0004 })} />);
    expect(screen.getByText('<$0.01')).toBeInTheDocument();
    expect(screen.getByText('· specialists')).toBeInTheDocument();
    expect(screen.queryByText('$0.00')).toBeNull();
    // The tooltip's split figure gets the same guard — a sub-cent split must
    // not read "$0.00 of this was spent by…".
    expect(byHint(/<\$0\.01 of this was spent by 1 specialist this session delegated to\./)).toBeTruthy();
  });

  // A fraction of a cent is REAL money. toFixed(2) alone rounds it to "$0.00",
  // which spec §5 forbids — and it is the first thing a native session on a
  // cheap metered model shows (a few hundred tokens ≈ $0.0004).
  it('renders <$0.01 for a real sub-cent cost, never $0.00', () => {
    withWidgets(['session-cost']);
    render(<StatusBar statusData={statusData} provider="native" sessionId="s1"
      nativeTotals={costTotals({ costUsd: 0.0004, anyPriced: true })} />);
    expect(screen.queryByText('Cost:')).toBeInTheDocument();
    expect(screen.queryByText('<$0.01')).toBeInTheDocument();
    expect(screen.queryByText('$0.00')).toBeNull();
  });

  // Same guard on the Claude Code side — that runtime HAD this behaviour
  // before the native-cost work and must keep it.
  it('renders <$0.01 for a sub-cent Claude Code session cost', () => {
    withWidgets(['session-cost']);
    const withCost = { ...statusData, sessionStats: { costUsd: 0.003 } };
    render(<StatusBar statusData={withCost} provider="claude" sessionId="s1" />);
    expect(screen.queryByText('<$0.01')).toBeInTheDocument();
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
    // Task 24: the full sentence, not a fragment. The chip's title is a
    // concatenation, so this is matched inside it — but the whole sentence is
    // pinned, byte-for-byte with UsageCard's PARTIAL_NOTE, because the bar and
    // the card saying different things about the same total is the bug this
    // pair of assertions exists to catch. "available", not "published": the
    // price lookup returns nothing for a model with no rate AND for a catalog
    // that never loaded, so "published" asserted a cause nobody checked
    // (docs/error-message-standards.md).
    expect(
      byHint(/Models with no available price are not included in this total\./),
    ).toBeTruthy();
  });
});

// Task 21 — the gap between two individually-correct unit tests. The totals
// unit tests fed the accumulator hand-written flags; the chip tests fed the
// bar hand-written flags. Neither ever fed the REAL bar what the REAL
// accumulator produces from what main actually stamps, and the defect lived
// exactly there: a local-engine turn is stamped `costUsd: null, free: true`
// (a local model has no rate card), the accumulator read the null alone as
// "unpriced", and the bar drew "Cost: not listed" with a tooltip claiming the
// provider bills the user for a model running on their own machine.
describe('Session Cost — a purely local session, end to end (Task 21)', () => {
  // Built through the real accumulator, never by hand: hand-built flags are
  // what let this through the first time.
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
    // textContent as well as queryByText: the string must not appear anywhere
    // on the bar, however it happens to be split across elements.
    expect(container.textContent).not.toContain('not listed');
    expect(screen.queryByText(/\$/)).toBeNull();
    // Positive control: every assertion above is an absence, and absences pass
    // just as happily against a bar that never mounted.
    expect(screen.getByText('Add tags')).toBeInTheDocument();
  });

  it('still draws no cost chip when that local session delegated to a free local specialist', () => {
    withWidgets(['session-cost']);
    let t = localSessionTotals();
    t = addSubagentUsage(t, { inputTokens: 300, outputTokens: 60, costUsd: null, free: true });
    const { container } = render(<StatusBar statusData={statusData} provider="native"
      sessionId="s1" nativeTotals={t} />);
    expect(screen.queryByText('Cost:')).toBeNull();
    expect(container.textContent).not.toContain('not listed');
    expect(screen.getByText('Add tags')).toBeInTheDocument();
  });

  // The other half of the same defect: the Customize menu's local sentence is
  // gated on !anyUnpriced, so a wrongly-unpriced local session made it
  // unreachable dead code. Same real totals, driven through the real menu.
  it('offers the Cost row with the local sentence the defect made unreachable', () => {
    render(<StatusBar statusData={statusData} provider="native"
      sessionId="s1" nativeTotals={localSessionTotals()} />);
    fireEvent.click(screen.getByRole('button', { name: /status bar widgets|customize/i }));
    expect(screen.getByText("Models on your own machine don't cost anything to run")).toBeInTheDocument();
    expect(screen.queryByText('not listed')).toBeNull();
  });

  // Guard the other direction so the fix can't be "never mark anything
  // unpriced": a metered model with no published rate is a different state and
  // still has to say so.
  it('still says "not listed" for a metered session whose model has no published price', () => {
    withWidgets(['session-cost']);
    let t = emptyTotals();
    t = addTurnUsage(t, { inputTokens: 1200, outputTokens: 340, costUsd: null });
    render(<StatusBar statusData={statusData} provider="native" sessionId="s1" nativeTotals={t} />);
    expect(screen.getByText('Cost:')).toBeInTheDocument();
    expect(screen.getByText('not listed')).toBeInTheDocument();
  });
});
