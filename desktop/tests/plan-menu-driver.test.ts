// answerPlanMenu types into Claude Code's plan menu. The contract under test:
// a click can only ever pick the row it is labelled with, and when the screen
// does not confirm a step, the next key (above all Enter) is never sent.
//
// Two kinds of fake terminal:
//  • ReplayCC — a REAL capture (tests/fixtures/plan-menu) that advances to the
//    next recorded screen when the driver types what the capture typed. Proves
//    the driver works against Claude Code's real screens.
//  • ScriptCC — hand-written screens for the situations a capture cannot stage
//    (cursor already in the text box, options changing under a click, text that
//    does not echo).
import { describe, it, expect, afterEach } from 'vitest';
import { answerPlanMenu, sanitizeFeedback, PLAN_TIMING, type PlanDriverIO } from '../src/renderer/state/plan-menu-driver';
import { parsePlanMenu } from '../src/renderer/parser/plan-menu-parser';
import { FixtureTerminal, loadPlanFixture, markIndex, type PlanFixture } from './helpers/plan-menu-fixtures';

const open: FixtureTerminal[] = [];
afterEach(() => { while (open.length) open.pop()!.dispose(); });

/** A virtual clock so timeouts cost no wall time. */
function clock() {
  let t = 0;
  return { now: () => t, tick: (ms: number) => { t += ms; } };
}

/** Replays a capture: each expected write moves the screen to the capture's next mark. */
async function replayCC(file: string, steps: Array<{ expect: string | RegExp; to: string }>) {
  const fx: PlanFixture = loadPlanFixture(file);
  const term = new FixtureTerminal(fx);
  open.push(term);
  await term.advanceToMark('menu-settled');
  const writes: string[] = [];
  let pending: Promise<void> = Promise.resolve();
  let buffered = '';
  const c = clock();
  const io: PlanDriverIO = {
    read: () => term.screen(),
    write: (d) => {
      writes.push(d);
      buffered += d;
      const step = steps[0];
      if (!step) return;
      const hit = typeof step.expect === 'string' ? buffered === step.expect : step.expect.test(buffered);
      if (hit) {
        steps.shift();
        buffered = '';
        const end = step.to === 'END' ? fx.chunks.length : markIndex(fx, step.to);
        pending = pending.then(() => term.advanceTo(end));
      }
    },
    settle: async (ms) => { await pending; c.tick(ms); },
    now: c.now,
  };
  const menu = parsePlanMenu(term.screen());
  if (menu.status !== 'ready') throw new Error('capture has no ready menu at menu-settled');
  return { io, writes, menu: menu.menu, fx };
}

describe('answerPlanMenu against real Claude Code 2.1.281 captures', () => {
  it('"Yes, manually approve edits" types exactly its own number, and Claude Code approved', async () => {
    const { io, writes, menu, fx } = await replayCC('cc-2.1.281-answer-digit2-120x40.json', [{ expect: '2', to: 'after-answer-6s' }]);
    const row = menu.options.find((o) => o.label === 'Yes, manually approve edits')!;
    expect(row.number).toBe(2);
    const res = await answerPlanMenu(menu.signature, { kind: 'choice', number: row.number, label: row.label }, io);
    expect(res).toEqual({ ok: true });
    expect(writes).toEqual(['2']);
    // What Claude Code did with that "2" in the capture: approved the plan.
    const results = fx.outcome.exitPlanToolResults as Array<{ is_error: boolean; content: string }>;
    expect(results[0].is_error).toBe(false);
    expect(results[0].content).toMatch(/^User has approved your plan/);
  });

  it('"Yes, clear context … and auto-accept edits" types 1, and Claude Code cleared context into accept-edits', async () => {
    const { io, writes, menu, fx } = await replayCC('cc-2.1.281-answer-clear1-120x40.json', [{ expect: '1', to: 'after-answer-6s' }]);
    const row = menu.options[0];
    expect(row.label).toBe('Yes, clear context (5% used) and auto-accept edits');
    expect(await answerPlanMenu(menu.signature, { kind: 'choice', number: 1, label: row.label }, io)).toEqual({ ok: true });
    expect(writes).toEqual(['1']);
    expect(fx.outcome.modeLine).toBe('accept edits on');
    // A cleared context continues in a NEW transcript file.
    expect((fx.outcome.transcriptFiles as string[]).length).toBe(2);
  });

  it('feedback focuses the box, types, checks the echo, THEN presses Enter — and Claude Code kept planning with it', async () => {
    const text = 'Use the word hello 2 times instead';
    const { io, writes, menu, fx } = await replayCC('cc-2.1.281-answer-feedback-120x40.json', [
      { expect: '3', to: 'after-digit' },
      { expect: text, to: 'after-typing' },
      { expect: '\r', to: 'after-answer-6s' },
    ]);
    const res = await answerPlanMenu(menu.signature, { kind: 'feedback', text }, io);
    expect(res).toEqual({ ok: true });
    expect(writes[0]).toBe('3');
    expect(writes.slice(1, -1).join('')).toBe(text);
    expect(writes.slice(1, -1).every((w) => w.length <= PLAN_TIMING.chunk)).toBe(true);
    expect(writes[writes.length - 1]).toBe('\r');
    const results = fx.outcome.exitPlanToolResults as Array<{ is_error: boolean; content: string }>;
    expect(results[0].content).toContain(`the user said:\n${text}`);
  });

  it('long feedback that wraps onto three lines is still verified before Enter', async () => {
    const text = 'Please change the plan so that the file is named greeting.txt instead, and also make sure it ends with a trailing newline, '
      + 'and add a second line that says bye, then show me the updated plan before doing anything else ok';
    const { io, writes, menu } = await replayCC('cc-2.1.281-answer-feedback-long-120x40.json', [
      { expect: '3', to: 'after-digit' },
      { expect: text, to: 'after-typing' },
      { expect: '\r', to: 'after-answer-6s' },
    ]);
    expect(await answerPlanMenu(menu.signature, { kind: 'feedback', text }, io)).toEqual({ ok: true });
    expect(writes[writes.length - 1]).toBe('\r');
  });

  it('"Don\'t proceed" sends Esc, and Claude Code rejected the plan and stopped', async () => {
    const { io, writes, menu, fx } = await replayCC('cc-2.1.281-answer-esc-120x40.json', [{ expect: '\u001b', to: 'after-answer-6s' }]);
    expect(await answerPlanMenu(menu.signature, { kind: 'reject' }, io)).toEqual({ ok: true });
    expect(writes).toEqual(['\u001b']);
    const results = fx.outcome.exitPlanToolResults as Array<{ is_error: boolean; content: string }>;
    expect(results[0].content).toMatch(/STOP what you are doing/);
  });

  it('does NOT press Enter when the typed text never shows up in the box', async () => {
    // The capture is only advanced for the digit — the typed text "never echoes".
    const { io, writes, menu } = await replayCC('cc-2.1.281-answer-feedback-120x40.json', [{ expect: '3', to: 'after-digit' }]);
    const res = await answerPlanMenu(menu.signature, { kind: 'feedback', text: 'Use the word hello 2 times instead' }, io);
    expect(res).toEqual({ ok: false, reason: 'text-mismatch', typed: true });
    expect(writes).not.toContain('\r');
  });

  it('does NOT press Enter when the box shows different text than was typed', async () => {
    // Capture advances to a box holding "Use the word hello 2 times instead"
    // while the driver typed something else.
    const { io, writes, menu } = await replayCC('cc-2.1.281-answer-feedback-120x40.json', [
      { expect: '3', to: 'after-digit' },
      { expect: /./, to: 'after-typing' },
    ]);
    const res = await answerPlanMenu(menu.signature, { kind: 'feedback', text: 'Something else entirely' }, io);
    expect(res).toMatchObject({ ok: false, reason: 'text-mismatch' });
    expect(writes).not.toContain('\r');
  });

  it('reports "not taken" when the menu never leaves after the digit', async () => {
    const { io, menu } = await replayCC('cc-2.1.281-answer-digit2-120x40.json', []); // screen never changes
    const res = await answerPlanMenu(menu.signature, { kind: 'choice', number: 2, label: 'Yes, manually approve edits' }, io);
    expect(res).toEqual({ ok: false, reason: 'not-taken', typed: true });
  });
});

// What the captures recorded about Claude Code itself — the facts the card's
// design rests on. If a re-capture on a new version changes any of these, the
// design needs re-checking, not just the fixture.
describe('Claude Code 2.1.281 behaviour the plan card depends on (recorded)', () => {
  const outcome = (file: string) => loadPlanFixture(file).outcome as {
    exitPlanToolResults: Array<{ is_error: boolean; content: string }>; menuStillShown?: boolean; modeLine?: string | null;
  };

  it('the OLD card\'s "Tell Claude what to change" keys (3 down-arrows + Enter, one write) APPROVED the plan', () => {
    // The bug this card replaces: the menu has 3 rows, so 3 downs wrap to row 1.
    const o = outcome('cc-2.1.281-old-card-tell-claude-120x40.json');
    expect(o.exitPlanToolResults[0].content).toMatch(/^User has approved your plan/);
    expect(o.modeLine).toBe('accept edits on');
  });

  it('a hook "allow" does NOT approve a plan — the menu stays up (why the floater offers no Allow)', () => {
    const o = outcome('cc-2.1.281-hook-allow-only-120x40.json');
    expect(o.menuStillShown).toBe(true);
    expect(o.exitPlanToolResults).toEqual([]);
  });

  it('releasing the hook with NO decision leaves the menu answerable (how the card frees the socket)', () => {
    const o = outcome('cc-2.1.281-answer-digit2-after-release-120x40.json');
    expect(o.exitPlanToolResults[0].content).toMatch(/^User has approved your plan/);
  });

  it('a hook deny that arrives AFTER the menu was answered changes nothing', () => {
    const o = outcome('cc-2.1.281-answer-digit2-latedeny-120x40.json');
    expect(o.exitPlanToolResults).toHaveLength(1);
    expect(o.exitPlanToolResults[0].content).toMatch(/^User has approved your plan/);
  });
});

// ---- hand-written screens -------------------------------------------------

const Q = '   Claude has written up a plan and is ready to execute. Would you like to proceed?';
function screen(cursor: number, opts: string[], box = 'Tell Claude what to change') {
  const rows = [...opts, box].map((label, i) => `   ${cursor === i + 1 ? '❯' : ' '} ${i + 1}. ${label}`);
  return [Q, ...rows, '        shift+tab to approve with this feedback'].join('\n');
}

/** A tiny fake Claude Code: a screen plus rules for how keys change it. */
function scriptCC(initial: string, react: (key: string, s: { screen: string }) => void) {
  const s = { screen: initial };
  const writes: string[] = [];
  const c = clock();
  const io: PlanDriverIO = {
    read: () => s.screen,
    write: (d) => { writes.push(d); react(d, s); },
    settle: async (ms) => { c.tick(ms); },
    now: c.now,
  };
  return { io, writes, s };
}

const OPTS = ['Yes, auto-accept edits', 'Yes, manually approve edits'];
const sig = (txt: string) => { const r = parsePlanMenu(txt); if (r.status !== 'ready') throw new Error('bad'); return r.menu.signature; };

describe('answerPlanMenu safety on hand-written screens', () => {
  it('with the cursor IN the text box, steps out with up-arrow (its own write) before the digit', async () => {
    const { io, writes } = scriptCC(screen(3, OPTS), (k, s) => {
      if (k === '\u001b[A') s.screen = screen(2, OPTS);
      else if (k === '1') s.screen = '❯ ';
    });
    const res = await answerPlanMenu(sig(screen(1, OPTS)), { kind: 'choice', number: 1, label: OPTS[0] }, io);
    expect(res).toEqual({ ok: true });
    expect(writes).toEqual(['\u001b[A', '1']);
  });

  it('never types the digit while the cursor is still in the text box', async () => {
    const { io, writes } = scriptCC(screen(3, OPTS), () => { /* the up-arrow is ignored */ });
    const res = await answerPlanMenu(sig(screen(1, OPTS)), { kind: 'choice', number: 1, label: OPTS[0] }, io);
    expect(res).toEqual({ ok: false, reason: 'not-taken', typed: true });
    expect(writes).toEqual(['\u001b[A']);
  });

  it('types nothing when the row the button showed now has different wording', async () => {
    const shown = screen(1, OPTS);
    const now = screen(1, ['Yes, clear context (9% used) and auto-accept edits', ...OPTS]);
    const { io, writes } = scriptCC(now, () => {});
    const res = await answerPlanMenu(sig(shown), { kind: 'choice', number: 2, label: OPTS[1] }, io);
    expect(res).toEqual({ ok: false, reason: 'menu-changed', typed: false });
    expect(writes).toEqual([]);
  });

  it('types nothing when the button label does not match its row even if the set did not change', async () => {
    const txt = screen(1, OPTS);
    const { io, writes } = scriptCC(txt, () => {});
    const res = await answerPlanMenu(sig(txt), { kind: 'choice', number: 1, label: OPTS[1] }, io);
    expect(res).toMatchObject({ ok: false, reason: 'menu-changed' });
    expect(writes).toEqual([]);
  });

  it('types nothing when the menu is gone or unreadable', async () => {
    const txt = screen(1, OPTS);
    for (const now of ['❯ \n  ? for shortcuts', [Q, '     1. Yes'].join('\n')]) {
      const { io, writes } = scriptCC(now, () => {});
      const res = await answerPlanMenu(sig(txt), { kind: 'choice', number: 1, label: OPTS[0] }, io);
      expect(res.ok).toBe(false);
      expect(writes).toEqual([]);
    }
  });

  it('refuses feedback when something is already typed into the terminal box', async () => {
    const { io, writes } = scriptCC(screen(3, OPTS, 'half-written note'), () => {});
    const res = await answerPlanMenu(sig(screen(1, OPTS)), { kind: 'feedback', text: 'hi' }, io);
    expect(res).toEqual({ ok: false, reason: 'draft-in-terminal', typed: false });
    expect(writes).toEqual([]);
  });

  it('does not type feedback when the digit did not move the cursor into the box', async () => {
    const { io, writes } = scriptCC(screen(1, OPTS), () => {});
    const res = await answerPlanMenu(sig(screen(1, OPTS)), { kind: 'feedback', text: 'hi' }, io);
    expect(res).toEqual({ ok: false, reason: 'not-taken', typed: true });
    expect(writes).toEqual(['3']);
  });

  it('a menu that blinks off for a moment (redraw) is not mistaken for an answer', async () => {
    const txt = screen(1, OPTS);
    let reads = 0;
    const c = clock();
    const writes: string[] = [];
    const io: PlanDriverIO = {
      // Blank for two reads right after the key, then the SAME menu again.
      read: () => (writes.length && reads++ < 2 ? '' : txt),
      write: (d) => { writes.push(d); },
      settle: async (ms) => { c.tick(ms); },
      now: c.now,
    };
    const res = await answerPlanMenu(sig(txt), { kind: 'choice', number: 2, label: OPTS[1] }, io);
    expect(res).toEqual({ ok: false, reason: 'not-taken', typed: true });
  });

  it('flattens multi-line feedback to one line before typing', () => {
    expect(sanitizeFeedback('  first line\nsecond\tline\r\n\u0007third  ')).toBe('first line second line third');
  });
});

// Each check the driver makes before typing, pinned so removing it fails a test
// (review 2026-09-23, F4 — these were mutation-tested).
describe('answerPlanMenu re-checks the screen before every key', () => {
  /** read() walks through `screens` one call at a time, then stays on the last. */
  function sequenceCC(screens: string[]) {
    let i = 0;
    const writes: string[] = [];
    const c = clock();
    const io: PlanDriverIO = {
      read: () => screens[Math.min(i++, screens.length - 1)],
      write: (d) => { writes.push(d); },
      settle: async (ms) => { c.tick(ms); },
      now: c.now,
    };
    return { io, writes };
  }
  const SHOWN = screen(1, OPTS);
  // Same rows 1–2 with the same numbers and words — only a new row before the
  // text box. The clicked row still "matches"; only the option-SET check sees it.
  const GREW = screen(1, [...OPTS, 'No, refine with Ultraplan in a cloud session']);

  it('choice: types nothing when the option set changed, even if the clicked row looks the same', async () => {
    const { io, writes } = sequenceCC([GREW]);
    const res = await answerPlanMenu(sig(SHOWN), { kind: 'choice', number: 2, label: OPTS[1] }, io);
    expect(res).toMatchObject({ ok: false, reason: 'menu-changed' });
    expect(writes).toEqual([]);
  });

  it('reject: does not press Esc when the option set changed', async () => {
    const { io, writes } = sequenceCC([GREW]);
    const res = await answerPlanMenu(sig(SHOWN), { kind: 'reject' }, io);
    expect(res).toMatchObject({ ok: false, reason: 'menu-changed' });
    expect(writes).toEqual([]);
  });

  it('feedback: types nothing when the option set changed', async () => {
    const { io, writes } = sequenceCC([GREW]);
    const res = await answerPlanMenu(sig(SHOWN), { kind: 'feedback', text: 'hi' }, io);
    expect(res).toMatchObject({ ok: false, reason: 'menu-changed' });
    expect(writes).toEqual([]);
  });

  it('choice: re-reads right before the digit — a menu that changed after the first read gets no digit', async () => {
    const { io, writes } = sequenceCC([SHOWN, GREW]);
    const res = await answerPlanMenu(sig(SHOWN), { kind: 'choice', number: 2, label: OPTS[1] }, io);
    expect(res).toMatchObject({ ok: false, reason: 'menu-changed' });
    expect(writes).toEqual([]);
  });

  it('choice: no digit when the cursor moved into the text box after the first read (it would be typed into the box)', async () => {
    const { io, writes } = sequenceCC([SHOWN, screen(3, OPTS)]);
    const res = await answerPlanMenu(sig(SHOWN), { kind: 'choice', number: 1, label: OPTS[0] }, io);
    expect(res).toMatchObject({ ok: false, reason: 'not-taken' });
    expect(writes).toEqual([]);
  });

  it('feedback: no text typed when the box re-check shows a different menu', async () => {
    // Cursor already in the box (no focusing digit), then the menu changes.
    const { io, writes } = sequenceCC([screen(3, OPTS), GREW]);
    const res = await answerPlanMenu(sig(SHOWN), { kind: 'feedback', text: 'hi' }, io);
    expect(res).toMatchObject({ ok: false, reason: 'menu-changed' });
    expect(writes).toEqual([]);
  });

  it('refuses a two-digit row number outright', async () => {
    const { io, writes } = sequenceCC([SHOWN]);
    const res = await answerPlanMenu(sig(SHOWN), { kind: 'choice', number: 12, label: OPTS[0] }, io);
    expect(res.ok).toBe(false);
    expect(writes).toEqual([]);
  });
});

describe('feedbackChunks', () => {
  it('never splits a character: emoji, flags and accents stay whole', async () => {
    const { feedbackChunks } = await import('../src/renderer/state/plan-menu-driver');
    const text = 'a'.repeat(31) + '👍🏽' + ' café 🇬🇧 ' + 'x'.repeat(40) + '😀';
    const chunks = feedbackChunks(text);
    expect(chunks.join('')).toBe(text);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(PLAN_TIMING.chunk);
      // No lone surrogate at either end of a chunk.
      expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(c)).toBe(false);
    }
    expect(chunks[0]).toBe('a'.repeat(31)); // the 4-unit emoji moved whole to the next chunk
  });
});

describe('Claude Code 2.1.281 with a hook that exits 0 printing nothing (recorded)', () => {
  // How the app now hands back an ask from a session it does not own.
  for (const [file, tool] of [['cc-2.1.281-passthrough-write-120x40.json', 'Write'], ['cc-2.1.281-passthrough-ask-120x40.json', 'AskUserQuestion']] as const) {
    it(`${tool}: Claude Code showed its own prompt and the terminal answer went through`, () => {
      const o = loadPlanFixture(file).outcome as { hookLog: string; toolResults: Array<{ is_error: boolean; content: string }> };
      expect(o.hookLog).toMatch(new RegExp(`start ${tool}\\n\\d+ passthrough`));
      expect(o.toolResults).toHaveLength(1);
      expect(o.toolResults[0].is_error).toBe(false);
    });
  }
});
