// The plan-approval card reads Claude Code's REAL menu (plan-menu-parser.ts).
// These tests replay real captures from Claude Code 2.1.281 — every variant we
// could trigger — through a headless xterm and the app's own screen serializer,
// then check the parser reads exactly what Claude Code drew, and that a menu it
// cannot be sure of comes back 'unreadable' instead of a guess.
import { describe, it, expect, afterEach } from 'vitest';
import { parsePlanMenu, PLAN_FEEDBACK_PLACEHOLDER, type PlanMenuRead } from '../src/renderer/parser/plan-menu-parser';
import { FixtureTerminal, listPlanFixtures, loadPlanFixture, markIndex } from './helpers/plan-menu-fixtures';

const open: FixtureTerminal[] = [];
afterEach(() => { while (open.length) open.pop()!.dispose(); });

async function screenAt(file: string, mark: string): Promise<string> {
  const t = new FixtureTerminal(loadPlanFixture(file));
  open.push(t);
  await t.advanceToMark(mark);
  return t.screen();
}

function ready(read: PlanMenuRead) {
  if (read.status !== 'ready') throw new Error(`expected a ready menu, got ${JSON.stringify(read)}`);
  return read.menu;
}

const FB = { kind: 'feedback', label: PLAN_FEEDBACK_PLACEHOLDER } as const;

/** Replaying every capture chunk by chunk: measured 4.4s for 18 captures on
 *  Linux (2026-09-23); the Windows runner is several times slower. */
const REPLAY_ALL_BUDGET_MS = 60_000;

// What Claude Code 2.1.281 actually drew in each captured variant.
const VARIANTS: Array<{ file: string; mark: string; options: Array<{ number: number; kind: string; label: string }> }> = [
  {
    file: 'cc-2.1.281-default-120x40.json', mark: 'menu-settled',
    options: [
      { number: 1, kind: 'choice', label: 'Yes, auto-accept edits' },
      { number: 2, kind: 'choice', label: 'Yes, manually approve edits' },
      { number: 3, ...FB },
    ],
  },
  {
    file: 'cc-2.1.281-narrow-50x30.json', mark: 'menu-settled',
    options: [
      { number: 1, kind: 'choice', label: 'Yes, auto-accept edits' },
      { number: 2, kind: 'choice', label: 'Yes, manually approve edits' },
      { number: 3, ...FB },
    ],
  },
  {
    file: 'cc-2.1.281-clear-context-120x40.json', mark: 'menu-settled',
    options: [
      { number: 1, kind: 'choice', label: 'Yes, clear context (5% used) and auto-accept edits' },
      { number: 2, kind: 'choice', label: 'Yes, auto-accept edits' },
      { number: 3, kind: 'choice', label: 'Yes, manually approve edits' },
      { number: 4, ...FB },
    ],
  },
  {
    // 40 columns: Claude Code wraps row 1 and the hint onto second lines.
    file: 'cc-2.1.281-clear-context-narrow-40x30.json', mark: 'menu-settled',
    options: [
      { number: 1, kind: 'choice', label: 'Yes, clear context (5% used) and auto-accept edits' },
      { number: 2, kind: 'choice', label: 'Yes, auto-accept edits' },
      { number: 3, kind: 'choice', label: 'Yes, manually approve edits' },
      { number: 4, ...FB },
    ],
  },
  {
    // Resized 120x40 → 60x30 while the menu was up (Claude Code redraws).
    file: 'cc-2.1.281-resized-120x40.json', mark: 'resize-settled',
    options: [
      { number: 1, kind: 'choice', label: 'Yes, clear context (5% used) and auto-accept edits' },
      { number: 2, kind: 'choice', label: 'Yes, auto-accept edits' },
      { number: 3, kind: 'choice', label: 'Yes, manually approve edits' },
      { number: 4, ...FB },
    ],
  },
  {
    // Session started with --allow-dangerously-skip-permissions.
    file: 'cc-2.1.281-bypass-120x40.json', mark: 'menu-settled',
    options: [
      { number: 1, kind: 'choice', label: 'Yes, and switch to BYPASS PERMISSIONS (no further prompts) for this session' },
      { number: 2, kind: 'choice', label: 'Yes, manually approve edits' },
      { number: 3, ...FB },
    ],
  },
];

describe('parsePlanMenu on real Claude Code 2.1.281 captures', () => {
  for (const v of VARIANTS) {
    it(`reads ${v.file} exactly as Claude Code drew it`, async () => {
      const menu = ready(parsePlanMenu(await screenAt(v.file, v.mark)));
      expect(menu.options).toEqual(v.options);
      expect(menu.selectedNumber).toBe(1);
      expect(menu.feedbackDraft).toBe('');
    });
  }

  it('tracks the terminal cursor as it moves, and the option set never changes', async () => {
    // focus-input: six down-arrows, one at a time — the menu wraps 1→2→3→1…
    const fx = loadPlanFixture('cc-2.1.281-focus-input-120x40.json');
    const t = new FixtureTerminal(fx);
    open.push(t);
    await t.advanceToMark('menu-settled');
    const first = ready(parsePlanMenu(t.screen()));
    const seen: number[] = [first.selectedNumber];
    for (let i = markIndex(fx, 'menu-settled') + 1; i <= markIndex(fx, 'arrowed-down-6'); i++) {
      await t.advanceTo(i);
      const m = ready(parsePlanMenu(t.screen()));
      expect(m.signature).toBe(first.signature);
      // Some chunks change nothing visible (mouse-mode toggles) — record moves only.
      if (m.selectedNumber !== seen[seen.length - 1]) seen.push(m.selectedNumber);
    }
    expect(seen).toEqual([1, 2, 3, 1, 2, 3, 1]);
  });

  it('reads the feedback row once it is focused, and the text typed into it', async () => {
    const afterDigit = ready(parsePlanMenu(await screenAt('cc-2.1.281-answer-feedback-120x40.json', 'after-digit')));
    expect(afterDigit.selectedNumber).toBe(3);
    expect(afterDigit.feedbackDraft).toBe('');
    const afterTyping = ready(parsePlanMenu(await screenAt('cc-2.1.281-answer-feedback-120x40.json', 'after-typing')));
    expect(afterTyping.selectedNumber).toBe(3);
    expect(afterTyping.feedbackDraft).toBe('Use the word hello 2 times instead');
    // The typed text never changes WHICH options exist.
    expect(afterTyping.signature).toBe(afterDigit.signature);
  });

  it('joins a long feedback draft that Claude Code wrapped over three lines', async () => {
    const m = ready(parsePlanMenu(await screenAt('cc-2.1.281-answer-feedback-long-120x40.json', 'after-typing')));
    expect(m.feedbackDraft).toBe(
      'Please change the plan so that the file is named greeting.txt instead, and also make sure it ends with a trailing newline, '
      + 'and add a second line that says bye, then show me the updated plan before doing anything else ok',
    );
  });

  for (const file of [
    'cc-2.1.281-answer-digit2-120x40.json',
    'cc-2.1.281-answer-esc-120x40.json',
    'cc-2.1.281-answer-clear1-120x40.json',
    'cc-2.1.281-answer-digit2-latedeny-120x40.json',
    'cc-2.1.281-answer-digit2-after-release-120x40.json',
  ]) {
    it(`sees the menu gone after it was answered (${file})`, async () => {
      expect(parsePlanMenu(await screenAt(file, 'after-answer-6s')).status).toBe('absent');
    });
  }

  it('never reads a half-drawn frame as a smaller menu: every prefix of every capture is the final menu or not-ready', async () => {
    // Replays each capture one PTY chunk at a time — every intermediate screen
    // the app could ever have parsed — up to the settled menu. A 'ready' read is
    // only allowed if it is the complete, final option set.
    for (const file of listPlanFixtures()) {
      const fx = loadPlanFixture(file);
      const settledMark = fx.marks.find((m) => m.label === 'menu-settled');
      if (!settledMark) continue;
      const t = new FixtureTerminal(fx);
      open.push(t);
      await t.advanceTo(settledMark.chunkIndex);
      const final = ready(parsePlanMenu(t.screen()));
      t.dispose(); open.pop();
      const replay = new FixtureTerminal(fx);
      open.push(replay);
      for (let i = 1; i <= settledMark.chunkIndex; i++) {
        await replay.advanceTo(i);
        const read = parsePlanMenu(replay.screen());
        if (read.status === 'ready') expect(read.menu.signature, `${file} @ chunk ${i}`).toBe(final.signature);
      }
      replay.dispose(); open.pop();
    }
  }, REPLAY_ALL_BUDGET_MS);
});

// Shapes we could not trigger on this machine, written from Claude Code
// 2.1.281's own source for the plan dialog (the options builder pushes: an
// optional "Yes, clear context…" row, a keep-context row, "Yes, manually approve
// edits", an optional "No, refine with Ultraplan in a cloud session" row, and
// last the text-input row) — plus the malformed screens the parser must refuse.
describe('parsePlanMenu on shapes that must be read or refused', () => {
  const Q = '   Claude has written up a plan and is ready to execute. Would you like to proceed?';

  it('reads the Ultraplan row as an ordinary choice with its own wording', () => {
    const m = ready(parsePlanMenu([
      Q,
      '   ❯ 1. Yes, auto-accept edits',
      '     2. Yes, manually approve edits',
      '     3. No, refine with Ultraplan in a cloud session',
      '     4. Tell Claude what to change',
      '        shift+tab to approve with this feedback',
    ].join('\n')));
    expect(m.options.map((o) => [o.number, o.kind, o.label])).toEqual([
      [1, 'choice', 'Yes, auto-accept edits'],
      [2, 'choice', 'Yes, manually approve edits'],
      [3, 'choice', 'No, refine with Ultraplan in a cloud session'],
      [4, 'feedback', PLAN_FEEDBACK_PLACEHOLDER],
    ]);
  });

  it('reads the approvals-withheld shape (feedback row only, no hint)', () => {
    const m = ready(parsePlanMenu([Q, '   ❯ 1. Tell Claude what to change'].join('\n')));
    expect(m.options).toEqual([{ number: 1, kind: 'feedback', label: PLAN_FEEDBACK_PLACEHOLDER }]);
  });

  it('accepts the Windows ">" cursor', () => {
    const m = ready(parsePlanMenu([
      Q, '   > 1. Yes, auto-accept edits', '     2. Yes, manually approve edits',
      '     3. Tell Claude what to change', '        shift+tab to approve with this feedback',
    ].join('\n')));
    expect(m.selectedNumber).toBe(1);
  });

  it('uses the LAST plan question on screen', () => {
    const m = ready(parsePlanMenu([
      Q, '   ❯ 1. Old option', '     2. Tell Claude what to change', '        shift+tab to approve with this feedback',
      '   some output',
      Q, '     1. Yes, auto-accept edits', '   ❯ 2. Yes, manually approve edits',
      '     3. Tell Claude what to change', '        shift+tab to approve with this feedback',
    ].join('\n')));
    expect(m.options[0].label).toBe('Yes, auto-accept edits');
    expect(m.selectedNumber).toBe(2);
  });

  const refuse: Array<[string, string[]]> = [
    ['no cursor (mid-redraw)', [Q, '     1. Yes, auto-accept edits', '     2. Tell Claude what to change', '        shift+tab to approve with this feedback']],
    ['two cursors (mid-redraw)', [Q, '   ❯ 1. Yes, auto-accept edits', '   ❯ 2. Tell Claude what to change', '        shift+tab to approve with this feedback']],
    ['a skipped number', [Q, '   ❯ 1. Yes, auto-accept edits', '     3. Tell Claude what to change', '        shift+tab to approve with this feedback']],
    ['no feedback row yet (half-drawn)', [Q, '   ❯ 1. Yes, auto-accept edits', '     2. Yes, manually approve edits']],
    ['hint only half drawn', [Q, '   ❯ 1. Yes, auto-accept edits', '     2. Tell Claude what to change', '        shift+tab to approve']],
    ['feedback row not last', [Q, '   ❯ 1. Tell Claude what to change', '        shift+tab to approve with this feedback', '     2. Yes, auto-accept edits']],
    ['question with nothing under it', [Q]],
  ];
  for (const [name, lines] of refuse) {
    it(`refuses to guess: ${name}`, () => {
      expect(parsePlanMenu(lines.join('\n')).status).toBe('unreadable');
    });
  }

  it('calls the empty-plan "Exit plan mode?" prompt unreadable, not absent', () => {
    const read = parsePlanMenu(['   Exit plan mode?', '   Claude wants to exit plan mode', '   ❯ 1. Yes', '     2. No'].join('\n'));
    expect(read).toEqual({ status: 'unreadable', reason: 'empty-plan-variant' });
  });

  it('reports absent when no plan question is on screen', () => {
    expect(parsePlanMenu('❯ \n  ? for shortcuts').status).toBe('absent');
    expect(parsePlanMenu('').status).toBe('absent');
    expect(parsePlanMenu(null).status).toBe('absent');
  });

  it('a numbered list in ordinary output is not a plan menu', () => {
    expect(parsePlanMenu(['Steps:', '  1. Do this', '  2. Do that'].join('\n')).status).toBe('absent');
  });
});
