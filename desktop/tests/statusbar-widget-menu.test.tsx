// @vitest-environment jsdom
// desktop/tests/statusbar-widget-menu.test.tsx
//
// The menu must never offer what the bar refuses to draw, and must never
// explain away a widget that is missing for a different reason (git-branch).
//
// Scaffolding note: the brief's draft uses @testing-library/user-event, which
// is not a dependency of this repo (task 6 hit the same gap — see
// import-file-dialog.test.tsx). Swapped to RTL's own `fireEvent`, this repo's
// existing convention; every assertion below is verbatim from the brief.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, cleanup } from '@testing-library/react';
import type { ReactElement } from 'react';
import { makeStoreWrapper } from './helpers/chat-store-harness';
import StatusBar from '../src/renderer/components/StatusBar';

// Master added <SpecialistsChip> to the bar (useSpecialistSummary → useChatStore),
// so StatusBar can no longer mount outside a ChatProvider. Every render here
// goes through the REAL store + reducer this branch already uses for hook tests
// (helpers/chat-store-harness.ts), seeded with the 's1' session these tests name.
// With no specialist runs in that session the chip renders null, so the bar's
// DOM — and every assertion below — is unchanged.
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: makeStoreWrapper(['s1']).wrapper });
}

// Multiple <StatusBar> renders share one jsdom document in this file — see
// statusbar-session-relevance.test.tsx for why explicit cleanup is required
// here (this repo doesn't enable vitest's `globals`).
afterEach(cleanup);

beforeEach(() => {
  // This repo's jsdom ships no localStorage — stub it the same way
  // statusbar-session-relevance.test.tsx / remote-shim-refusals.test.ts do.
  (window as any).localStorage = {
    _s: {} as Record<string, string>,
    getItem(k: string) { return this._s[k] ?? null; },
    setItem(k: string, v: string) { this._s[k] = v; },
    removeItem(k: string) { delete this._s[k]; },
  };
  // StatusBar renders SessionTagsChip unconditionally whenever sessionId is
  // set; stub the minimal window.claude surface it reads so mounting doesn't
  // crash — none of these values are under test here.
  (window as any).claude = {
    tags: { list: async () => [] },
    session: { getMeta: async () => ({}) },
    on: { tagsChanged: () => () => {}, sessionMetaChanged: () => () => {} },
  };
});

const statusData = {
  usage: null, updateStatus: null, announcement: null, contextPercent: null,
  gitBranch: null, sessionStats: null, syncWarnings: [],
} as any;

async function openMenu(
  provider: 'claude' | 'native',
  nativeTotals?: any,
  sessionStats?: any,
  usagePlan?: 'claude' | 'chatgpt',
) {
  // sessionStats is only needed by the bar/menu agreement table below, which
  // renders a Claude Code session that already has a cost figure.
  const data = sessionStats ? { ...statusData, sessionStats } : statusData;
  render(
    <StatusBar
      statusData={data}
      provider={provider}
      sessionId="s1"
      nativeTotals={nativeTotals ?? null}
      usagePlan={usagePlan}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /status bar widgets|customize/i }));
}

// Session totals shaped like the ones the chat reducer accumulates. Only the
// three pricing flags matter to the Customize menu.
function totals(over: Record<string, unknown>) {
  return {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    costUsd: 0, anyPriced: false, anyUnpriced: false, anyFree: false,
    linesAdded: 0, linesRemoved: 0, specialistRuns: 0, specialistCostUsd: 0,
    ...over,
  };
}

// The row a dimmed widget occupies: walk up from its label to the first
// ancestor that also holds the reason line, then TWO levels further, so the
// element under test is at least the whole row however the row is stacked.
// Deliberately not a class-name lookup — this file's point is structure.
//
// WHY two levels and not one (review of 7ec9e8e7): one level lands on the
// opacity-50 wrapper, which is a SIBLING of the row's "(i)" info button, not
// an ancestor of it. With one level the focusable-element test passed even
// when the info button's `!reason` gate was removed entirely — it simply could
// not see the button. Proven by mutation: un-gate the "(i)" at StatusBar.tsx
// and this file must go red.
function rowAround(label: HTMLElement, reason: string): HTMLElement {
  let el: HTMLElement | null = label;
  while (el && !(el.textContent ?? '').includes(reason)) el = el.parentElement;
  return (el?.parentElement?.parentElement ?? el)!;
}

describe('Always On section and announcement popup', () => {
  // WHY: these four are the controls the bar always draws; the menu names them
  // once, at the top, instead of tagging a single row "always on".
  it('lists Model, Permissions, Tags & Note and Announcements first, with no per-row tag', async () => {
    await openMenu('claude');
    const headings = screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent);
    expect(headings[0]).toBe('Always On');
    for (const label of ['Model', 'Permissions', 'Tags & Note', 'Announcements']) {
      expect(screen.getByText(label).closest('button')!.hasAttribute('disabled')).toBe(true);
    }
    expect(screen.queryByText('always on')).toBeNull();
  });

  it('turns Git Branch off for a fresh install', async () => {
    await openMenu('claude');
    const box = screen.getByText('Git Branch').closest('button')!.querySelector('span')!;
    expect(box.className).not.toContain('bg-accent');
  });

  it('shows the announcement even when it was hidden before, and opens the full text on click', async () => {
    window.localStorage.setItem('youcoded-statusbar-widgets', JSON.stringify(['usage-5h']));
    const message = 'A long announcement that would be cut off by the chip\nwith a second line.';
    render(<StatusBar statusData={{ ...statusData, announcement: { message } }} provider="claude" sessionId="s1" nativeTotals={null} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /long announcement/ }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getAllByText(/second line/).length).toBeGreaterThan(0);
  });
});

describe('Customize Status Bar menu', () => {
  it('explains the subscription rows in a native session', async () => {
    await openMenu('native');
    expect(screen.getAllByText('Claude Code sessions only').length).toBe(2);
  });

  it('explains the unavailable rows without promising them later', async () => {
    await openMenu('native');
    expect(screen.getAllByText('Not available in this kind of session').length).toBe(2);
  });

  it('leaves Git Branch unexplained — it is a missing feed, not a relevance rule', async () => {
    await openMenu('native');
    const row = screen.getByText('Git Branch').closest('div')!;
    expect(row.textContent).not.toMatch(/only|not measured|no published/i);
  });

  // The reported bug: a ChatGPT-plan session's 5h/7d chips draw real numbers
  // on the bar (they have their own rolling ChatGPT-plan windows), but the
  // Customize menu judged the row on session runtime alone — which is
  // 'native' for a ChatGPT session too — and called it "Claude Code sessions
  // only" even though that exact chip was on screen with a real number.
  it('leaves the subscription rows switchable for a ChatGPT-plan session', async () => {
    window.localStorage.setItem('youcoded-statusbar-widgets', JSON.stringify(['usage-5h', 'usage-7d']));
    await openMenu('native', undefined, undefined, 'chatgpt');
    expect(screen.queryByText('Claude Code sessions only')).toBeNull();
    expect(screen.getByText('5h Usage').closest('button')).toBeTruthy();
    expect(screen.getByText('7d Usage').closest('button')).toBeTruthy();
  });

  it('explains nothing in a Claude Code session', async () => {
    await openMenu('claude');
    // Positive control FIRST: the two assertions below are absence checks, and
    // an absence check passes just as happily against a menu that never opened.
    // The 5h Usage row is the row those reasons would attach to, so finding it
    // proves the menu is open AND that this row carries no reason line.
    expect(screen.getByText('5h Usage')).toBeTruthy();
    expect(screen.queryByText(/Claude Code sessions only/)).toBeNull();
    expect(screen.queryByText(/Not available in this kind/)).toBeNull();
  });

  it('dims the row without touching the saved choice', async () => {
    window.localStorage.setItem('youcoded-statusbar-widgets', JSON.stringify(['usage-5h']));
    await openMenu('native');
    expect(JSON.parse(window.localStorage.getItem('youcoded-statusbar-widgets')!)).toContain('usage-5h');
  });

  it('says a local session costs nothing to run, not that it is unpriced', async () => {
    // End-to-end for checkpoint #9: proves StatusBar actually feeds anyFree
    // through as runsLocally, which the status-widgets unit test cannot see.
    await openMenu('native', totals({ anyFree: true }));
    expect(screen.queryByText("Models on your own machine don't cost anything to run")).toBeTruthy();
    expect(screen.queryByText('No published price for this model')).toBeNull();
  });

  // Task 20, defect A. This row used to read "No published price for this
  // model" while the bar was drawing a `Cost: not listed` chip — a chip on the
  // bar whose switch looked unavailable, and which the user could not turn off.
  it('leaves the Cost row switchable for a metered model with no published rate', async () => {
    await openMenu('native', totals({ anyUnpriced: true }));
    expect(screen.queryByText('No published price for this model')).toBeNull();
    expect(screen.queryByText("Models on your own machine don't cost anything to run")).toBeNull();
    expect(screen.getByText('Session Cost').closest('button')).toBeTruthy();
  });

  // Task 20, defect B. A free local parent that delegated to a metered
  // specialist has anyFree AND anyUnpriced: metered work really ran, so the
  // "costs nothing to run" sentence would be false (spec §5 names exactly this
  // delegation shape as the one that must not be hidden).
  it('never tells a session it is free to run when metered work also ran', async () => {
    await openMenu('native', totals({ anyFree: true, anyUnpriced: true }));
    expect(screen.queryByText("Models on your own machine don't cost anything to run")).toBeNull();
    expect(screen.getByText('Session Cost').closest('button')).toBeTruthy();
  });

  it('stacks the reason under the label instead of beside it', async () => {
    // Checkpoint #6: the reason used to sit BESIDE the label on the same
    // single-line flex row, which wrapped "Session Duration" onto two lines and
    // made that row taller than its neighbours. Structure, not pixels: the
    // reason must not be a direct child of the row that holds the checkbox
    // spacer, and must share a two-child wrapper with the label.
    await openMenu('native');
    const label = screen.getByText('5h Usage');
    const reason = screen.getAllByText('Claude Code sessions only')[0];
    const stack = label.parentElement!;
    expect(reason.parentElement).toBe(stack);
    expect(stack.children.length).toBe(2);
    const row = stack.parentElement!;
    expect(Array.from(row.children).includes(reason)).toBe(false);
    // The label comes first; the reason is on the line beneath it.
    expect(!!(label.compareDocumentPosition(reason) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it('leaves a dimmed row with zero focusable elements', async () => {
    await openMenu('native');
    const row = rowAround(screen.getByText('5h Usage'), 'Claude Code sessions only');
    expect(row.querySelectorAll('button, a, input, select, textarea, [tabindex]').length).toBe(0);
  });

  it('positive control: an enabled row still has its controls', async () => {
    // Without this, the assertion above would pass just as happily against a
    // selector that finds nothing anywhere.
    await openMenu('native');
    const themeRow = screen.getByText('Theme').parentElement!.parentElement!;
    expect(themeRow.querySelectorAll('button').length > 0).toBe(true);
  });
});

// The bar and the Customize menu are ONE rule written in two places: the chip's
// render condition in StatusBar.tsx and the session-cost branch in
// status-widgets.ts. This table is what keeps them honest — it drives both
// surfaces from a SINGLE render of the real <StatusBar/>, so changing either
// one alone turns it red. The invariant that matters (spec §9) is stated at the
// bottom of the test body: the bar must never draw a chip whose switch looks
// unavailable.
describe('the bar and the Customize menu agree about Cost', () => {
  // chip:       the value the bar draws, or null when it draws no chip at all.
  // rowEnabled: whether the menu row is still a switch the user can operate —
  //             a dimmed row renders its label in a plain div, an offered row
  //             renders it inside the checkbox <button>.
  // reason:     the dimmed row's sentence, asserted byte-for-byte.
  const shapes: Array<{
    name: string;
    provider: 'claude' | 'native';
    sessionStats?: Record<string, unknown>;
    totals: Record<string, unknown> | null;
    chip: string | null;
    rowEnabled: boolean;
    reason: string | null;
  }> = [
    {
      name: 'a Claude Code session with its own figure',
      provider: 'claude', sessionStats: { costUsd: 0.42 }, totals: null,
      chip: '$0.42', rowEnabled: true, reason: null,
    },
    {
      name: 'a metered native session with priced work',
      provider: 'native', totals: totals({ costUsd: 1.37, anyPriced: true }),
      chip: '$1.37', rowEnabled: true, reason: null,
    },
    {
      name: 'a metered model with no published rate',
      provider: 'native', totals: totals({ anyUnpriced: true }),
      chip: 'not listed', rowEnabled: true, reason: null,
    },
    {
      name: 'a free local session',
      provider: 'native', totals: totals({ anyFree: true }),
      chip: null, rowEnabled: false,
      reason: "Models on your own machine don't cost anything to run",
    },
    {
      name: 'a free local parent whose specialist ran unpriced',
      provider: 'native', totals: totals({ anyFree: true, anyUnpriced: true }),
      chip: 'not listed', rowEnabled: true, reason: null,
    },
    {
      name: 'a free local parent whose specialist cost real money',
      provider: 'native',
      totals: totals({
        costUsd: 0.61, anyPriced: true, anyUnpriced: true, anyFree: true,
        specialistRuns: 3, specialistCostUsd: 0.61,
      }),
      chip: '$0.61', rowEnabled: true, reason: null,
    },
    {
      name: 'a session that has measured nothing yet',
      provider: 'native', totals: totals({}),
      chip: null, rowEnabled: true, reason: null,
    },
  ];

  for (const shape of shapes) {
    it(`${shape.name}: bar ${shape.chip ? `shows "${shape.chip}"` : 'shows nothing'}, menu row ${shape.rowEnabled ? 'stays a switch' : 'is dimmed'}`, async () => {
      // Session Cost is defaultVisible:false — switch it on, or the bar would
      // be silent for a reason that has nothing to do with pricing.
      window.localStorage.setItem('youcoded-statusbar-widgets', JSON.stringify(['session-cost']));
      await openMenu(shape.provider, shape.totals, shape.sessionStats);

      // --- what the bar drew ---
      const chipLabel = screen.queryByText('Cost:');
      if (shape.chip === null) {
        expect(chipLabel).toBeNull();
      } else {
        expect(chipLabel).toBeTruthy();
        expect(screen.queryByText(shape.chip)).toBeTruthy();
      }

      // --- what the menu offered ---
      const label = screen.getByText('Session Cost');
      const rowEnabled = label.closest('button') !== null;
      expect(rowEnabled).toBe(shape.rowEnabled);
      if (shape.reason === null) {
        // Nothing but the label on the row — no sentence at all.
        expect(label.parentElement!.textContent).toBe('Session Cost');
      } else {
        expect(label.nextElementSibling!.textContent).toBe(shape.reason);
      }

      // --- the invariant, checked for every shape ---
      // spec §9: the bar can never show a chip the menu won't offer.
      if (chipLabel !== null) expect(rowEnabled).toBe(true);
    });
  }
});
