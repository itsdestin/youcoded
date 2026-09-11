// @vitest-environment jsdom
// plan-windows-other.test.tsx — plan windows labelled by their real length
// (Sign in with ChatGPT, words deck W-2 = a, 2026-09-05).
//
// WHY this file exists: the approved bars, chips and /usage rows were drawn for
// a Plus plan's two windows (5h, 7d). Phase 0 ran on Destin's FREE account,
// which reports ONE 30-day window and nothing else — drawn as approved it
// showed two empty bars. Destin chose (W-2 = a): label every window by the
// length OpenAI reports. Two things must hold at once:
//   1. the 5h/7d output is BYTE-IDENTICAL to what was approved — the literal
//      markup below was captured from the code BEFORE this change;
//   2. a free plan shows one 30d bar / chip / row, and a plan with no windows
//      shows nothing at all.
// The clock is fixed and TZ pinned to UTC so the reset strings are literal.
process.env.TZ = 'UTC';

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, screen, cleanup } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import '@testing-library/jest-dom/vitest';
import { PlanWindows, windowLengthLabel, windowBarLabel } from '../src/renderer/components/plan-windows';
import StatusBar from '../src/renderer/components/StatusBar';
import UsageCard from '../src/renderer/components/UsageCard';
import { ChatGptBlock } from '../src/renderer/components/ModelProvidersPopup';
import { makeStoreWrapper } from './helpers/chat-store-harness';
import type { UsageSnapshot } from '../src/renderer/state/chat-types';

const NOW = Date.parse('2026-09-05T15:00:00.000Z');
const H = 3_600_000;
const D = 24 * H;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  (window as any).localStorage = {
    _s: {} as Record<string, string>,
    getItem(k: string) { return this._s[k] ?? null; },
    setItem(k: string, v: string) { this._s[k] = v; },
    removeItem(k: string) { delete this._s[k]; },
  };
  (window as any).claude = {
    tags: { list: async () => [] },
    session: { getMeta: async () => ({}) },
    on: { tagsChanged: () => () => {}, sessionMetaChanged: () => () => {} },
  };
});
afterEach(() => { vi.useRealTimers(); cleanup(); });

// A Plus plan: exactly the two approved windows.
const plus = {
  five_hour: { utilization: 42, resets_at: new Date(NOW + 2 * H + 9 * 60_000).toISOString() },
  seven_day: { utilization: 17, resets_at: new Date(NOW + 4 * D + H).toISOString() },
};
// A free plan: one 30-day window (43200 minutes), 0% used, as Phase 0 saw.
const free = {
  other: [{ minutes: 43200, utilization: 0, resets_at: new Date(NOW + 28 * D).toISOString() }],
};

function renderBar(usage: any, extra: Record<string, unknown> = {}) {
  const statusData = { usage, updateStatus: null, announcement: null, contextPercent: null, gitBranch: null, sessionStats: null, syncWarnings: [] } as any;
  return rtlRender(<StatusBar statusData={statusData} provider="claude" sessionId="s1" {...extra} />, { wrapper: makeStoreWrapper(['s1']).wrapper });
}
const chipsOf = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('button[data-hint="View usage on claude.ai"], button[data-hint="Your ChatGPT plan — click to open Model Providers"]'));

const snapshotBase: UsageSnapshot = {
  entryId: 'u1', timestamp: 1, costUsd: null, costIsPartial: false, countsFromSessionTotals: false, specialistRuns: 0,
  inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, contextTokens: null,
  contextPercent: null, duration: null, apiDuration: null, linesAdded: null, linesRemoved: null,
  fiveHourUtilization: null, fiveHourResetsAt: null, sevenDayUtilization: null, sevenDayResetsAt: null,
  subscriptionPlan: 'chatgpt',
};

describe('the approved 5h/7d output is byte-identical (captured before W-2 landed)', () => {
  it('PlanWindows — the card and /usage bars', () => {
    expect(renderToStaticMarkup(<PlanWindows usage={plus} />)).toBe(
      '<div class="space-y-2 "><div><div class="flex justify-between text-xs mb-1"><span class="text-fg-muted">5-hour limit · resets in 2h 9m</span><span class="tabular-nums" style="color:#10b981">42%</span></div><div class="flex items-center gap-2 w-full"><div class="flex-1 h-1.5 rounded-full bg-inset overflow-hidden" role="progressbar" aria-valuenow="42" aria-valuemin="0" aria-valuemax="100" aria-label="5-hour limit"><div class="h-full rounded-full transition-[width] duration-300 ease-out " style="width:42%;background-color:#10b981"></div></div></div></div><div><div class="flex justify-between text-xs mb-1"><span class="text-fg-muted">7-day limit · resets in 4d</span><span class="tabular-nums" style="color:#10b981">17%</span></div><div class="flex items-center gap-2 w-full"><div class="flex-1 h-1.5 rounded-full bg-inset overflow-hidden" role="progressbar" aria-valuenow="17" aria-valuemin="0" aria-valuemax="100" aria-label="7-day limit"><div class="h-full rounded-full transition-[width] duration-300 ease-out " style="width:17%;background-color:#10b981"></div></div></div></div></div>',
    );
  });

  it('StatusBar — the two chips', () => {
    const { container } = renderBar(plus);
    expect(chipsOf(container).map((b) => b.outerHTML)).toEqual([
      '<button class="flex items-center gap-1 sm:gap-1.5 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim cursor-pointer hover:bg-inset transition-colors" data-hint="View usage on claude.ai"><span>5h:</span><span class="text-[#4CAF50]">42%</span><span class="text-fg-muted hidden sm:inline">Resets @ 5:09pm</span></button>',
      '<button class="flex items-center gap-1 sm:gap-1.5 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim cursor-pointer hover:bg-inset transition-colors" data-hint="View usage on claude.ai"><span>7d:</span><span class="text-[#4CAF50]">17%</span><span class="text-fg-muted hidden sm:inline">Resets Wednesday @ 4:00pm</span></button>',
    ]);
  });

  it('UsageCard — the plan rows', () => {
    const { container } = rtlRender(<UsageCard snapshot={{
      ...snapshotBase,
      fiveHourUtilization: 42, fiveHourResetsAt: plus.five_hour.resets_at,
      sevenDayUtilization: 17, sevenDayResetsAt: plus.seven_day.resets_at,
    }} />);
    const section = container.querySelector('.space-y-2.pt-3.border-t');
    expect(section?.outerHTML).toBe(
      '<div class="space-y-2 pt-3 border-t border-edge-dim"><div class="space-y-2 "><div><div class="flex justify-between text-xs mb-1"><span class="text-fg-muted">5-hour limit · resets in 2h 9m</span><span class="tabular-nums" style="color: rgb(16, 185, 129);">42%</span></div><div class="flex items-center gap-2 w-full"><div class="flex-1 h-1.5 rounded-full bg-inset overflow-hidden" role="progressbar" aria-valuenow="42" aria-valuemin="0" aria-valuemax="100" aria-label="5-hour limit"><div class="h-full rounded-full transition-[width] duration-300 ease-out " style="width: 42%; background-color: rgb(16, 185, 129);"></div></div></div></div><div><div class="flex justify-between text-xs mb-1"><span class="text-fg-muted">7-day limit · resets in 4d</span><span class="tabular-nums" style="color: rgb(16, 185, 129);">17%</span></div><div class="flex items-center gap-2 w-full"><div class="flex-1 h-1.5 rounded-full bg-inset overflow-hidden" role="progressbar" aria-valuenow="17" aria-valuemin="0" aria-valuemax="100" aria-label="7-day limit"><div class="h-full rounded-full transition-[width] duration-300 ease-out " style="width: 17%; background-color: rgb(16, 185, 129);"></div></div></div></div></div><p class="text-3xs text-fg-muted pt-1">Measured across your whole ChatGPT plan, not just this conversation.</p></div>',
    );
  });
});

describe('the label rule — a window is named by its real length', () => {
  it('rounds whole days to "Nd" and anything shorter to "Nh"', () => {
    expect(windowLengthLabel(300)).toBe('5h');
    expect(windowLengthLabel(10080)).toBe('7d');
    expect(windowLengthLabel(43200)).toBe('30d');
    expect(windowLengthLabel(1440)).toBe('1d');
    expect(windowLengthLabel(90)).toBe('2h');
    expect(windowBarLabel(43200)).toBe('30-day limit');
    expect(windowBarLabel(120)).toBe('2-hour limit');
  });
});

describe('a free plan — one 30-day window', () => {
  it('PlanWindows draws one 30-day bar and no 5-hour or 7-day bar', () => {
    rtlRender(<PlanWindows usage={free} />);
    expect(screen.getByRole('progressbar', { name: '30-day limit' })).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByText('30-day limit · resets in 28d')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar', { name: '5-hour limit' })).toBeNull();
    expect(screen.queryByRole('progressbar', { name: '7-day limit' })).toBeNull();
  });

  it('PlanWindows keeps the order 5h, 7d, then the rest', () => {
    rtlRender(<PlanWindows usage={{ ...plus, other: [{ minutes: 43200, utilization: 3, resets_at: free.other[0].resets_at }] }} />);
    expect(screen.getAllByRole('progressbar').map((el) => el.getAttribute('aria-label'))).toEqual(['5-hour limit', '7-day limit', '30-day limit']);
  });

  it('StatusBar shows one "30d:" chip whose reset names the month and day', () => {
    const { container } = renderBar(free);
    const chips = chipsOf(container);
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toBe('30d:0%Resets Oct 3 @ 3:00pm');
    expect(screen.queryByText('5h:')).toBeNull();
    expect(screen.queryByText('7d:')).toBeNull();
  });

  it('StatusBar resets read like the 7d chip up to a week, and like the 5h chip under a day', () => {
    // Fed in longest-first on purpose: main appends whichever window it just
    // refreshed to the end of the list, so without a sort two chips would trade
    // places between polls under the user's cursor. Shortest first, always —
    // the same short-to-long order as the approved 5h-then-7d pair.
    const { container } = renderBar({ other: [
      { minutes: 3 * 1440, utilization: 10, resets_at: new Date(NOW + 2 * D).toISOString() },
      { minutes: 120, utilization: 55, resets_at: new Date(NOW + H).toISOString() },
    ] });
    expect(chipsOf(container).map((b) => b.textContent)).toEqual([
      '2h:55%Resets @ 4:00pm',
      '3d:10%Resets Monday @ 3:00pm',
    ]);
  });

  it('PlanWindows draws the odd-length bars shortest first too', () => {
    rtlRender(<PlanWindows usage={{ other: [
      { minutes: 43200, utilization: 3, resets_at: new Date(NOW + 26 * D).toISOString() },
      { minutes: 120, utilization: 55, resets_at: new Date(NOW + H).toISOString() },
    ] }} />);
    expect(screen.getAllByRole('progressbar').map((el) => el.getAttribute('aria-label')))
      .toEqual(['2-hour limit', '30-day limit']);
  });

  it('hides the 30d chip when the user has switched off the toggle it rides on', () => {
    // The free plan's ONE chip has no toggle of its own — it rides on "7d
    // Usage" in Customize widgets. Deleting that check used to pass every test
    // while silently ignoring a user who had turned the chip off.
    (window as any).localStorage.setItem('youcoded-statusbar-widgets', JSON.stringify(['usage-5h']));
    const { container } = renderBar(free);
    expect(chipsOf(container)).toHaveLength(0);
    cleanup();
    // …and it comes back when that toggle is on.
    (window as any).localStorage.setItem('youcoded-statusbar-widgets', JSON.stringify(['usage-7d']));
    const back = renderBar(free);
    expect(chipsOf(back.container).map((b) => b.textContent)).toEqual(['30d:0%Resets Oct 3 @ 3:00pm']);
  });

  it('never paints a "NaNh" chip or bar for a window whose length did not parse', () => {
    // typeof NaN === 'number', so the old guard let it straight through.
    const broken = { other: [{ minutes: NaN, utilization: 12, resets_at: new Date(NOW + D).toISOString() }] } as any;
    const { container } = renderBar(broken);
    expect(chipsOf(container)).toHaveLength(0);
    expect(renderToStaticMarkup(<PlanWindows usage={broken} />)).toBe('');
  });

  it('a window under half an hour reads as "1h", never "0h"', () => {
    // main clamps the same way, so the chip and the limit card agree.
    expect(windowLengthLabel(20)).toBe('1h');
    expect(windowBarLabel(20)).toBe('1-hour limit');
  });

  it('StatusBar shows the 30d chip for a native session on the ChatGPT plan', () => {
    const { container } = renderBar(free, { provider: 'native', usagePlan: 'chatgpt' });
    expect(chipsOf(container).map((b) => b.textContent)).toEqual(['30d:0%Resets Oct 3 @ 3:00pm']);
  });

  it('UsageCard shows the 30-day row and the plan scope line', () => {
    rtlRender(<UsageCard snapshot={{ ...snapshotBase, otherWindows: free.other }} />);
    expect(screen.getByRole('progressbar', { name: '30-day limit' })).toBeInTheDocument();
    expect(screen.getByText('Measured across your whole ChatGPT plan, not just this conversation.')).toBeInTheDocument();
  });
});

describe('a plan with no windows', () => {
  it('PlanWindows renders nothing — no empty bars', () => {
    expect(renderToStaticMarkup(<PlanWindows usage={null} />)).toBe('');
    expect(renderToStaticMarkup(<PlanWindows usage={{}} />)).toBe('');
    expect(renderToStaticMarkup(<PlanWindows usage={{ other: [] }} />)).toBe('');
  });

  it('StatusBar shows no chips', () => {
    const { container } = renderBar({ other: [] });
    expect(chipsOf(container)).toHaveLength(0);
    expect(screen.getByText('Add tags')).toBeInTheDocument(); // the bar itself mounted
  });

  it('UsageCard shows no plan section', () => {
    rtlRender(<UsageCard snapshot={{ ...snapshotBase, otherWindows: [] }} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText(/Measured across/)).toBeNull();
  });
});

// The kill switch (design §6): `YOUCODED_CHATGPT=0` → preload's
// `chatgpt.supported` is false → the ChatGPT card is not in the popup. Read as
// `=== true`, so a shim with no `chatgpt` namespace hides it too.
describe('Assistant settings — the ChatGPT card and chatgpt.supported', () => {
  function stub(chatgpt: unknown) {
    (window as any).claude = {
      native: { supported: true },
      chatgpt,
      providers: { list: async () => [], catalog: async () => [], test: async () => ({ ok: true, message: '' }) },
      models: { installed: async () => [], curated: async () => [], onDownloadProgress: () => () => {} },
      engine: { status: async () => null, onInstallProgress: () => () => {}, onStatusChanged: () => () => {} },
      on: { statusData: () => () => {} },
      off: () => {},
      firstRun: { getState: async () => ({ authMode: 'oauth', currentStep: 'COMPLETE' }) },
      search: { list: async () => [] },
      shell: { openExternal: () => {} },
    };
  }
  const open = () => rtlRender(<><span>surface</span><ChatGptBlock /></>);

  it('shows the card when supported is true', async () => {
    vi.useRealTimers();
    stub({ supported: true, status: async () => ({ state: 'signed-out' }) });
    open();
    expect(await screen.findByText('Sign in with ChatGPT')).toBeInTheDocument();
  });

  it('hides the card when supported is false', async () => {
    vi.useRealTimers();
    const status = vi.fn(async () => ({ state: 'signed-out' }));
    stub({ supported: false, status });
    open();
    expect(await screen.findByText('surface')).toBeInTheDocument();
    expect(screen.queryByText('Sign in with ChatGPT')).toBeNull();
    expect(screen.queryByText('Not signed in')).toBeNull();
    expect(status).not.toHaveBeenCalled(); // the card is gone, not just blank
  });

  it('hides the card when the namespace does not say supported at all', async () => {
    vi.useRealTimers();
    stub({ status: async () => ({ state: 'signed-out' }) });
    open();
    expect(await screen.findByText('surface')).toBeInTheDocument();
    expect(screen.queryByText('Sign in with ChatGPT')).toBeNull();
  });
});
