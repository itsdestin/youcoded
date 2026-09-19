// @vitest-environment jsdom
/**
 * Specialists plans (Destin, 2026-09-18): "how would i go about viewing/editing
 * the actual details of the plan if i desired?" — the row showed only the FIRST
 * LINE of a step's instructions, capped and then clipped by the window, so he
 * was approving real spending on text he could not finish reading. Opening a
 * step now shows the whole thing, exactly as the specialist will receive it.
 * Read-only: editing a plan by hand is roadmapped, not built
 * (docs/roadmap/native-harness.md, 2026-09-18).
 *
 * Extended the same day (decision 30) after he read a real six-step plan: "it's
 * still a bit hard to tell what exactly is going on or what the plan will do
 * from this card." So the rest of this file covers the row itself — the items
 * each specialist is given, the assistant's own plain sentence, the token
 * figure moving off a proposed row, and the line the expansion used to repeat.
 *
 * Extended again (decision 31) after he read the result: "still isnt great for
 * transparency/understanding. like it's not clear to me how this breaks out
 * into 7 reviewers, what the inputs/ouputs are, and how it flows to the next
 * step of the plans inputs/outputs." So a fan-out step breaks out into one row
 * per specialist, and every step says in plain words what it is given, what it
 * produces and which step takes that on. Every word of it comes from the plan
 * document the app already holds — never from reading the model's prose.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import React, { useEffect } from 'react';
import ToolCard from '../src/renderer/components/ToolCard';
import { ChatProvider, useChatDispatch, useChatState } from '../src/renderer/state/chat-context';
import type { PlanView } from '../src/shared/types';
import { resetPlanSupportForTests } from '../src/renderer/components/plans/plan-bridge';
import { NARROW_VIEWPORT_QUERY } from '../src/renderer/hooks/use-narrow-viewport';

const S = 's1';
const CARD = 'call-plan';

const FIRST_LINE = 'EXPECTATION PASS (fresh eyes, no implementation reading).';
const REST = 'Work in /home/destin/youcoded-dev. Do not read the implementation.\nWrite one numbered finding per surface.';
const TASK = `${FIRST_LINE}\n${REST}`;

/** A proposal, the moment it matters: before Approve, nothing has run. */
const proposed = (over: Partial<PlanView['steps'][number]> = {}): PlanView => ({
  planId: 'plan-1', toolUseId: CARD, title: 'Audit every desktop surface', status: 'proposed',
  steps: [{
    id: 's1', kind: 'map', title: FIRST_LINE, task: TASK, specialist: 'reviewer',
    fanOut: 7, budgetTokens: 2000, status: 'pending', ...over,
  }],
  ceilingTokens: 42000, ceilingUsd: null, model: { label: 'm' }, seq: 1,
});

function Card({ initial }: { initial: PlanView }) {
  const dispatch = useChatDispatch();
  useEffect(() => {
    dispatch({ type: 'SESSION_INIT', sessionId: S });
    dispatch({ type: 'TRANSCRIPT_TOOL_USE', sessionId: S, uuid: 'u', toolUseId: CARD, toolName: 'propose_plan', toolInput: {} });
    dispatch({ type: 'PLAN_CHANGED', sessionId: S, plan: initial });
  }, [dispatch, initial]);
  const tool = useChatState(S).toolCalls.get(CARD);
  return tool ? <ToolCard tool={tool} sessionId={S} /> : null;
}

const show = (plan: PlanView) => render(<ChatProvider><Card initial={plan} /></ChatProvider>);
const openStep = () => fireEvent.click(screen.getByTestId('plan-step-title').closest('button')!);

beforeEach(() => {
  resetPlanSupportForTests();
  (window as any).claude = { plans: { getAutoApprove: async () => ({ ok: true, underTokens: 0 }) } };
});
afterEach(() => { cleanup(); delete (window as any).claude; });

describe('a plan step opens onto the instructions its specialist will be sent', () => {
  it('shows the whole task, not just the headline the row is capped to', () => {
    show(proposed());
    // Closed, the card still says only what it always said.
    expect(screen.queryByTestId('plan-step-task')).not.toBeInTheDocument();
    openStep();
    const body = screen.getByTestId('plan-step-task');
    // The lines the row could never show are the point of the change.
    expect(body).toHaveTextContent('Do not read the implementation.');
    expect(body).toHaveTextContent('Write one numbered finding per surface.');
  });

  it('keeps the limit line that was already there, so nothing is traded away', () => {
    show(proposed());
    openStep();
    expect(screen.getByText(/stops at its/)).toBeInTheDocument();
  });

  it('leaves the line breaks the model wrote intact, rather than running them together', () => {
    show(proposed());
    openStep();
    const body = screen.getByTestId('plan-step-task');
    expect(body.textContent).toContain('\n');
  });

  it('says nothing extra for an older record that carries no instructions', () => {
    // Plans proposed before this change, replayed from a saved conversation.
    show(proposed({ task: undefined }));
    openStep();
    expect(screen.queryByTestId('plan-step-task')).not.toBeInTheDocument();
    expect(screen.getByText(/stops at its/)).toBeInTheDocument();
  });

  it('still gives a running step its specialists, not the brief in their place', () => {
    const plan = proposed({
      status: 'running',
      children: [{ childId: 'kid-a', parentToolCallId: CARD, agentType: 'reviewer', title: 'Wren the Reviewer', background: false, status: 'running', startedAt: 1 }],
    });
    show({ ...plan, status: 'running' });
    // A running step opens by itself; its children are what the row is for.
    const step = screen.getByTestId('plan-step-s1');
    expect(within(step).getByText('Wren the Reviewer')).toBeInTheDocument();
  });
});

const SURFACES = ['Chat', 'Files', 'Settings', 'Terminal', 'Specialists', 'Skills', 'Games'];
const row = () => screen.getByTestId('plan-step-detail');

/**
 * jsdom lays nothing out, so every element reports `scrollHeight: 0` and a
 * clamped row can never discover on its own that it is hiding text. A test
 * about the chevron therefore has to DECLARE what the browser would have
 * measured — the same obligation the narrow-viewport rule puts on a test of a
 * component that branches on `matchMedia`. Returns its own undo.
 */
function clampedRows(hiding: boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) { return hiding && this.className.includes('line-clamp-2') ? 100 : 0; },
  });
  return () => {
    if (original) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', original);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
  };
}

/** True when `first` really does come before `second` in the card's markup. */
function drawnBefore(step: HTMLElement, first: string, second: string): boolean {
  const a = within(step).getByTestId(first);
  const b = within(step).getByTestId(second);
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe('a fan-out step says what each of its specialists gets', () => {
  it('names the items on the collapsed row instead of only counting the specialists', () => {
    show(proposed({ items: SURFACES }));
    // "7 reviewers" alone never said on WHAT; the labels are already in the plan.
    expect(row()).toHaveTextContent('7 reviewers');
    expect(row()).toHaveTextContent('one each:');
    expect(row()).toHaveTextContent('Chat');
    expect(row()).toHaveTextContent('Files');
  });

  it('shortens a long list on the row, and still ends it honestly', () => {
    show(proposed({ items: SURFACES }));
    // Not all seven fit one line, so the row says there are more.
    expect(row().textContent).toContain('…');
    expect(row()).not.toHaveTextContent('Games');
  });

  it('says nothing about the items until the step is opened', () => {
    show(proposed({ items: SURFACES }));
    expect(screen.queryByTestId('plan-step-items')).not.toBeInTheDocument();
    openStep();
    expect(screen.getByTestId('plan-step-items')).toBeInTheDocument();
  });

  // What the opened step then shows — a row per specialist rather than a block
  // of lines, and what a long item does there — is pinned by "a fan-out step
  // breaks out into one row per specialist" below (decision 31).

  it('leaves a repeating step exactly as it reads today, with no item list', () => {
    show(proposed({ kind: 'repeat', fanOut: 3 }));
    expect(row()).toHaveTextContent('repeats until done');
    expect(row()).not.toHaveTextContent('one each');
    openStep();
    expect(screen.queryByTestId('plan-step-items')).not.toBeInTheDocument();
  });
});

describe('a plan step reads as a sentence written for the person approving it', () => {
  const SUMMARY = 'Seven reviewers each look at one screen and say what feels wrong.';

  it('shows the assistant\'s plain sentence as the row', () => {
    show(proposed({ summary: SUMMARY }));
    expect(screen.getByTestId('plan-step-title')).toHaveTextContent(SUMMARY);
  });

  it('falls back to the headline of the instructions when no sentence was written', () => {
    show(proposed());
    expect(screen.getByTestId('plan-step-title')).toHaveTextContent(FIRST_LINE);
  });
});

describe('a proposed plan step is about what will happen, a running one about progress', () => {
  it('keeps the token figure off the row while the plan is only proposed', () => {
    show(proposed());
    expect(screen.getByTestId('plan-step-s1')).not.toHaveTextContent('up to');
  });

  it('shows that figure when the step is opened, beside the per-specialist limit', () => {
    show(proposed());
    openStep();
    expect(screen.getByTestId('plan-step-s1')).toHaveTextContent('Up to 14,000 tokens for this step.');
    expect(screen.getByText(/stops at its/)).toBeInTheDocument();
  });

  it('leaves a running plan\'s row saying what it says today', () => {
    const plan = proposed({ status: 'running', done: 2, usedTokens: 4000 });
    show({ ...plan, status: 'running' });
    expect(screen.getByTestId('plan-step-s1')).toHaveTextContent('2 of 7 reviewers done');
    expect(screen.getByTestId('plan-step-s1')).toHaveTextContent('4,000 tokens');
  });

  it('still shows a not-yet-started step\'s figure once the plan is running', () => {
    // Only the PLAN's status decides; a pending step inside a running plan
    // keeps the figure it has always had.
    show({ ...proposed(), status: 'running' });
    expect(screen.getByTestId('plan-step-s1')).toHaveTextContent('up to 14,000 tokens');
  });
});

describe('opening a step does not repeat the line its row already shows', () => {
  it('starts the brief after the headline the row is showing', () => {
    show(proposed());
    openStep();
    const body = screen.getByTestId('plan-step-task');
    expect(body).not.toHaveTextContent(FIRST_LINE);
    expect(body).toHaveTextContent('Do not read the implementation.');
  });

  it('adds nothing at all when the whole brief is the one line the row shows', () => {
    show(proposed({ task: FIRST_LINE, title: FIRST_LINE }));
    openStep();
    expect(screen.queryByTestId('plan-step-task')).not.toBeInTheDocument();
    // The limit line is still there, so the expansion is never empty.
    expect(screen.getByText(/stops at its/)).toBeInTheDocument();
  });

  it('shows the brief entire when the row is showing a sentence instead of it', () => {
    show(proposed({ summary: 'Seven reviewers look at one screen each.' }));
    openStep();
    expect(screen.getByTestId('plan-step-task')).toHaveTextContent(FIRST_LINE);
  });

  it('shows the brief entire when the row had to cut its first line short', () => {
    const long = `${'Read every file under the renderer and report what each one does'.repeat(2)}.`;
    show(proposed({ task: `${long}\nThen stop.`, title: `${long.slice(0, 79)}…` }));
    openStep();
    expect(screen.getByTestId('plan-step-task')).toHaveTextContent(long);
  });
});

// ---- decision 31: the work, and the way it flows -----------------------------

type Step = PlanView['steps'][number];
const aStep = (over: Partial<Step> & { id: string }): Step => ({
  kind: 'map', title: FIRST_LINE, task: TASK, specialist: 'reviewer',
  fanOut: 1, budgetTokens: 2000, status: 'pending', ...over,
});
const planOf = (steps: Step[], status: PlanView['status'] = 'proposed'): PlanView => ({
  planId: 'plan-1', toolUseId: CARD, title: 'Audit every desktop surface', status,
  steps, ceilingTokens: 42000, ceilingUsd: null, model: { label: 'm' }, seq: 1,
});
/** Open step `id` and answer with the words inside it. */
const openAndRead = (id: string): HTMLElement => {
  const step = screen.getByTestId(`plan-step-${id}`);
  fireEvent.click(within(step).getByTestId('plan-step-title').closest('button')!);
  return step;
};
const flowOf = (id: string): string => within(openAndRead(id)).getByTestId('plan-step-flow').textContent ?? '';

describe('a fan-out step breaks out into one row per specialist', () => {
  it('gives every item its own numbered row rather than a block of lines', () => {
    show(proposed({ items: SURFACES }));
    const rows = within(openAndRead('s1')).getAllByTestId('plan-step-item');
    expect(rows).toHaveLength(SURFACES.length);
    // Each row says which of the seven it is, and what that one specialist gets.
    expect(rows[0]).toHaveTextContent('1.');
    expect(rows[0]).toHaveTextContent('Chat');
    expect(rows[6]).toHaveTextContent('7.');
    expect(rows[6]).toHaveTextContent('Games');
  });

  it('holds a long piece of work to a couple of lines until its row is opened', () => {
    const long = 'The whole Settings panel, including Model Providers, Appearance, Remote access, and every row under Advanced that a student is ever shown.';
    // The row offers that click only while it is really hiding text, and jsdom
    // measures nothing — so this test says which rows are clamped (see
    // `clampedRows`), the way a viewport-branching test declares its viewport.
    const restore = clampedRows(true);
    try {
      show(proposed({ items: [long, 'Chat'] }));
      const row = within(openAndRead('s1')).getAllByTestId('plan-step-item')[0];
      const text = within(row).getByTestId('plan-step-item-text');
      expect(text).toHaveClass('line-clamp-2');
      fireEvent.click(within(row).getByRole('button'));
      expect(within(row).getByTestId('plan-step-item-text')).not.toHaveClass('line-clamp-2');
      expect(row).toHaveTextContent('every row under Advanced');
    } finally { restore(); }
  });

  it('draws a bounded number of rows however many items the record carries', () => {
    // The grammar stops at 8, but the card also replays records written by
    // other builds: a fan-out row may never become an unbounded list.
    const many = Array.from({ length: 20 }, (_, i) => `Surface ${i + 1}`);
    show(proposed({ items: many, fanOut: 20 }));
    const step = openAndRead('s1');
    expect(within(step).getAllByTestId('plan-step-item')).toHaveLength(8);
    expect(step).toHaveTextContent('12 more');
  });

  it('still shows a running step its real specialists, not a second set of pending rows', () => {
    const plan = proposed({
      status: 'running', items: SURFACES,
      children: [{ childId: 'kid-a', parentToolCallId: CARD, agentType: 'reviewer', title: 'Wren the Reviewer', background: false, status: 'running', startedAt: 1 }],
    });
    show({ ...plan, status: 'running' });
    const step = screen.getByTestId('plan-step-s1');
    expect(within(step).getByText('Wren the Reviewer')).toBeInTheDocument();
    expect(within(step).queryAllByTestId('plan-step-item')).toHaveLength(0);
  });
});

describe('a plan step says what it is given, what it produces and where that goes', () => {
  const chain = () => planOf([
    aStep({ id: 's1', kind: 'map', fanOut: 7, items: SURFACES }),
    aStep({ id: 's2', kind: 'combine', of: 's1', specialist: 'worker' }),
    aStep({ id: 's3', kind: 'verify', of: 's2' }),
  ]);

  it('tells a fan-out step\'s reader that each specialist takes one of the rows below', () => {
    show(chain());
    expect(flowOf('s1')).toContain('Each reviewer gets one of the 7 below');
  });

  it('says how many reports a fan-out step produces, one per specialist', () => {
    show(chain());
    expect(flowOf('s1')).toContain('produces 7 reports');
  });

  it('says a combining step produces a single report', () => {
    show(chain());
    expect(flowOf('s2')).toContain('produces one report');
  });

  it('names the step whose results it consumes by the number on the card', () => {
    show(chain());
    expect(flowOf('s2')).toContain('Gets the 7 reports from step 1');
    expect(flowOf('s3')).toContain('Gets the report from step 2');
  });

  it('names the step that takes a step\'s results on', () => {
    show(chain());
    expect(flowOf('s1')).toContain('step 2 combines them');
    expect(flowOf('s2')).toContain('step 3 checks it');
  });

  it('names every step when more than one consumes the same results', () => {
    show(planOf([
      aStep({ id: 's1', kind: 'map', fanOut: 3, items: ['a', 'b', 'c'] }),
      aStep({ id: 's2', kind: 'verify', of: 's1' }),
      aStep({ id: 's3', kind: 'combine', of: 's1', specialist: 'worker' }),
    ]));
    expect(flowOf('s1')).toContain('steps 2 and 3 use them');
  });

  it('says nothing about a flow for a step nothing feeds and nothing consumes', () => {
    show(planOf([aStep({ id: 'only', kind: 'combine', specialist: 'worker' })]));
    const flow = flowOf('only');
    expect(flow).toContain('produces one report');
    expect(flow).not.toContain('Gets');
    expect(flow).not.toContain('→');
  });

  it('says nothing rather than a wrong number when the reference names no step on the card', () => {
    show(planOf([
      aStep({ id: 's1', kind: 'map', fanOut: 2, items: ['a', 'b'] }),
      aStep({ id: 's2', kind: 'combine', of: 'a-step-that-is-not-here', specialist: 'worker' }),
    ]));
    expect(flowOf('s2')).not.toContain('from step');
    expect(flowOf('s1')).not.toContain('→');
  });

  it('says nothing rather than a wrong number when the reference points forwards', () => {
    // A document the validator would have refused, replayed from disk.
    show(planOf([
      aStep({ id: 's1', kind: 'combine', of: 's2', specialist: 'worker' }),
      aStep({ id: 's2', kind: 'map', fanOut: 2, items: ['a', 'b'] }),
    ]));
    expect(flowOf('s1')).not.toContain('from step');
  });

  it('counts a repeating step\'s reports as a worst case, because it stops when it is done', () => {
    show(planOf([aStep({ id: 'loop', kind: 'repeat', fanOut: 15, specialist: 'worker' })]));
    expect(flowOf('loop')).toContain('produces up to 15 reports');
  });
});

// ---- the clean-up pass: the card read against a REAL plan ---------------------
//
// Destin, 2026-09-18, looking at the shipped card running on his own seven-item
// plan: "whatever is live in the dev window is still the best i've seen, but
// that's still a mess. lots of bare text at the bottom with no indication how it
// ties into the cards above, substep cards that have chevrons and appear to be
// clickable/expandable but never expand". Every defect below only appears at
// real sizes — seven items that are each a long file list, and a thirty-line
// brief with a `{item}` placeholder — which is what these fixtures carry and
// what `fixtures/bubbles/plan-proposed-heavy.jsonl` shows in the workbench.

const HEAVY_ITEMS = [
  'App chrome: HeaderBar.tsx, SessionStrip.tsx, SessionDrawer.tsx, OverflowMenu.tsx, NarrowViewToggle.tsx, WideViewToggle.tsx, ViewToggleHint.tsx',
  'Chat and status: ChatView.tsx, BubbleFeed.tsx, InputBar.tsx, StatusBar.tsx, ThinkingIndicator.tsx, AttentionBanner.tsx, ToolCard.tsx',
  'Settings: SettingsPanel.tsx, SettingRow.tsx, AppearancePopup.tsx, ModelProviders.tsx, RemoteAccessPanel.tsx, ThemePicker.tsx',
  'Panels and viewers: ArtifactDrawer.tsx, FilesTab.tsx, CsvView.tsx, UnifiedDiff.tsx, SessionPreviewPane.tsx, ResumeBrowser.tsx',
  'Setup, models and providers: SetupWizard.tsx, ModelPicker.tsx, ProviderCard.tsx, EngineManagerPanel.tsx, SignInDialog.tsx',
  'Arcade and buddy: GamePanel.tsx, ConnectFourBoard.tsx, ChessBoard.tsx, FlappyGame.tsx, BuddyBar.tsx, MascotWindow.tsx',
  'Shared primitives: Button.tsx, Dialog.tsx, Callout.tsx, StatusStrip.tsx, TextInput.tsx, Textarea.tsx, Toast.tsx',
];
/** A brief the length of a real one, carrying the placeholder a real one carries. */
const HEAVY_TASK = [FIRST_LINE, '', 'Your group: {item}', '',
  ...Array.from({ length: 26 }, (_, i) => `Instruction line ${i + 1} of the brief.`)].join('\n');
const heavy = (over: Partial<PlanView['steps'][number]> = {}) =>
  proposed({ items: HEAVY_ITEMS, task: HEAVY_TASK, ...over });

describe('an opened step says whose brief it is showing', () => {
  it('labels the brief as the one every specialist in the step is sent', () => {
    show(heavy());
    const step = openAndRead('s1');
    expect(within(step).getByTestId('plan-step-brief')).toHaveTextContent('The same brief for all 7');
  });

  it('draws the shared brief above the rows it is shared between', () => {
    // It is what the seven have in common; the rows are the part that varies.
    show(heavy());
    expect(drawnBefore(openAndRead('s1'), 'plan-step-brief', 'plan-step-items')).toBe(true);
  });

  it('shows a slice of a long brief rather than all thirty lines', () => {
    show(heavy());
    const step = openAndRead('s1');
    expect(within(step).getByTestId('plan-step-task')).not.toHaveTextContent('Instruction line 26');
    expect(within(step).getByText(/Show all \d+ lines/)).toBeInTheDocument();
  });

  it('opens the rest into a capped scroller instead of growing the card', () => {
    show(heavy());
    const step = openAndRead('s1');
    fireEvent.click(within(step).getByText(/Show all \d+ lines/));
    const body = within(step).getByTestId('plan-step-task');
    expect(body).toHaveTextContent('Instruction line 26');
    expect(body.className.split(/\s+/)).toContain('overflow-y-auto');
    expect(within(step).getByText('Show less')).toBeInTheDocument();
  });

  it('leaves a brief that already fits without a Show-all control', () => {
    show(proposed());
    const step = openAndRead('s1');
    expect(within(step).queryByText(/Show all/)).toBeNull();
  });
});

describe('the placeholder in a brief is marked as the slot it is', () => {
  it('leaves {item} in the text rather than filling it in silently', () => {
    // Filling it in would say all seven are sent seven different briefs.
    show(heavy());
    const step = openAndRead('s1');
    expect(within(step).getByTestId('plan-step-task')).toHaveTextContent('Your group: {item}');
    expect(within(step).getAllByTestId('plan-step-slot').length).toBeGreaterThan(0);
  });

  it('says once, plainly, what gets put there', () => {
    show(heavy());
    expect(within(openAndRead('s1')).getByTestId('plan-step-slot-note'))
      .toHaveTextContent('own line from the list below');
  });

  it('says nothing about a slot in a brief that has none', () => {
    show(proposed({ items: SURFACES }));
    expect(within(openAndRead('s1')).queryByTestId('plan-step-slot-note')).toBeNull();
  });
});

describe('a row offers a chevron only when it is really hiding something', () => {
  it('makes a row that has text beyond its two lines pressable', () => {
    const restore = clampedRows(true);
    try {
      show(heavy());
      const rows = within(openAndRead('s1')).getAllByTestId('plan-step-item');
      expect(within(rows[0]).getByRole('button')).toBeInTheDocument();
    } finally { restore(); }
  });

  it('leaves a row that fits as a plain row — no chevron, no focus stop', () => {
    const restore = clampedRows(false);
    try {
      show(proposed({ items: SURFACES }));
      const rows = within(openAndRead('s1')).getAllByTestId('plan-step-item');
      expect(within(rows[0]).queryByRole('button')).toBeNull();
      expect(rows[0]).toHaveTextContent('Chat');
    } finally { restore(); }
  });

  it('leaves a specialist with nothing to open as a plain row too', () => {
    // A specialist Stop caught before its first request has no briefing, no
    // activity and no report, so its sections render empty — the same broken
    // promise, found in the sweep the item rows asked for.
    show({
      ...proposed({
        status: 'skipped',
        children: [{ childId: 'kid-a', parentToolCallId: CARD, agentType: 'reviewer', title: 'Mara the Reviewer', background: false, status: 'interrupted', phase: 'prepared', startedAt: 1 }],
      }),
      status: 'stopped',
    });
    openAndRead('s1');
    const child = screen.getByTestId('plan-child');
    expect(within(child).queryByRole('button')).toBeNull();
    expect(child).toHaveTextContent('Mara the Reviewer');
  });

  it('still opens a specialist that has a briefing to show', () => {
    show({
      ...proposed({
        status: 'running',
        children: [{ childId: 'kid-b', parentToolCallId: CARD, agentType: 'reviewer', title: 'Wren the Reviewer', background: false, status: 'completed', startedAt: 1, prompt: 'Review the sign-in screen.' }],
      }),
      status: 'running',
    });
    const child = screen.getByTestId('plan-child');
    fireEvent.click(within(child).getByRole('button'));
    expect(child).toHaveTextContent('Briefing');
  });
});

describe('the collapsed row keeps the count and drops a preview no one can read', () => {
  it('stands the item preview down when not one label fits the row whole', () => {
    show(heavy());
    expect(row()).toHaveTextContent('7 reviewers');
    expect(row()).not.toHaveTextContent('HeaderBar');
    expect(row()).toHaveTextContent('one piece each');
  });

  it('still previews the labels that do fit, and never half of one', () => {
    show(proposed({ items: SURFACES }));
    const text = row().textContent ?? '';
    expect(text).toContain('Chat, Files');
    // Every label printed is a whole label: the only ellipsis is the list's.
    for (const shown of text.replace(/^.*one each: /, '').split(', ')) {
      expect(shown === '…' || SURFACES.includes(shown)).toBe(true);
    }
  });
});

describe('the limit sentence has a home instead of floating', () => {
  it('sits after the rows, on its own side of a hairline', () => {
    show(heavy());
    const step = openAndRead('s1');
    const limits = within(step).getByTestId('plan-step-limits');
    expect(limits).toHaveTextContent('stops at its');
    expect(limits.className.split(/\s+/)).toContain('border-t');
    expect(drawnBefore(step, 'plan-step-items', 'plan-step-limits')).toBe(true);
  });

  it('is no longer the paragraph directly under the brief', () => {
    show(heavy());
    const step = openAndRead('s1');
    expect(drawnBefore(step, 'plan-step-brief', 'plan-step-limits')).toBe(true);
    expect(within(step).getByTestId('plan-step-brief'))
      .not.toContainElement(within(step).getByTestId('plan-step-limits'));
  });
});

describe('narrow widths (390 px): the breakdown stays readable', () => {
  // narrow-viewport rule: a test of a viewport-branching component declares the
  // viewport (jsdom has no matchMedia, which reads as wide). StepRow branches
  // on it, so the breakdown it draws must be checked on the phone-width branch
  // too — a fan-out item is a long label and the flow line is a sentence.
  beforeEach(() => {
    window.matchMedia = ((q: string) => ({
      matches: q === NARROW_VIEWPORT_QUERY, media: q, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as any;
  });
  afterEach(() => { delete (window as any).matchMedia; });

  it('still breaks a fan-out step out into one row per specialist', () => {
    show(proposed({ items: SURFACES }));
    expect(within(openAndRead('s1')).getAllByTestId('plan-step-item')).toHaveLength(SURFACES.length);
  });

  it('lets the flow line wrap rather than run off the card', () => {
    show(proposed({ items: SURFACES }));
    const flow = within(openAndRead('s1')).getByTestId('plan-step-flow');
    expect(flow.className.split(/\s+/)).toContain('break-words');
    expect(flow.className.split(/\s+/)).not.toContain('truncate');
  });
});
