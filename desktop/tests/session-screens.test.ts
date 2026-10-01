// The computer's own reading of each running Claude Code terminal (one-core R5-4b): the "may be stuck" check and the cards a terminal shows.
//
// Equivalence is proved against the REAL captures the renderer's reading was built on (tests/fixtures/plan-menu, tests/fixtures/startup-dialogs): the same
// bytes go through the renderer's own terminal registry (FixtureTerminal, getScreenText / getVisibleScreenText) and through the computer's headless copy,
// and at every step the screen text, the stuck decision and the card must be the same. The renderer's decision logic is kept below as a verbatim reference
// (the body of the old useAttentionClassifier tick), so a mistake in moving it cannot hide behind "both sides use the same new function".
import { describe, it, expect, afterEach } from 'vitest';
import { classifyBuffer, type BufferClass, type ClassifierContext } from '../src/shared/attention-classifier';
import { parseInkSelect, menuToButtons } from '../src/shared/ink-select-parser';
import { cardTitleFor } from '../src/shared/prompt-card-rules';
import { screenTextOf, visibleScreenTextOf } from '../src/shared/terminal-screen-text';
import { getScreenText, getVisibleScreenText } from '../src/renderer/hooks/terminal-registry';
import { FixtureTerminal, listPlanFixtures, loadPlanFixture, STARTUP_FIXTURE_DIR, type PlanFixture } from './helpers/plan-menu-fixtures';
import { makeRig, S, turnStarts, turnEnds } from './helpers/screens-rig';
import { SessionRecords } from '../src/main/session-record';
import { SessionScreens } from '../src/main/session-screens';

// ---- The renderer's decision, as it was (useAttentionClassifier's tick, copied from before R5-4b) -------------------------------------------------
type Att = 'ok' | 'stuck';
function referenceHook(startedAt: number) {
  let previousSpinnerGlyph: string | null = null;
  let previousSpinnerGlyphAt = startedAt;
  let lastSignalSeenAt = startedAt;
  let previousCounterSeconds: number | null = null;
  let pendingState: Att = 'ok';
  let pendingStreak = 0;
  const map = (cls: BufferClass): Att => (cls === 'thinking-stalled' ? 'stuck' : 'ok');
  return (tail: string[], now: number): { mapped: Att; shouldDispatch: boolean } => {
    const ctx: ClassifierContext = { bufferTail: tail, previousSpinnerGlyph, secondsSincePreviousGlyph: (now - previousSpinnerGlyphAt) / 1000, previousCounterSeconds };
    const result = classifyBuffer(ctx);
    if (result.spinnerGlyph !== null) {
      lastSignalSeenAt = now;
      if (result.spinnerGlyph !== previousSpinnerGlyph) { previousSpinnerGlyph = result.spinnerGlyph; previousSpinnerGlyphAt = now; }
    }
    const prior = previousCounterSeconds;
    if (result.counterSeconds !== null && prior !== null && result.counterSeconds > prior) lastSignalSeenAt = now;
    previousCounterSeconds = result.counterSeconds;
    let mapped = map(result.class);
    if (mapped === 'ok' && result.class === 'unknown' && now - lastSignalSeenAt >= 20_000) mapped = 'stuck';
    if (mapped === pendingState) pendingStreak += 1; else { pendingState = mapped; pendingStreak = 1; }
    return { mapped, shouldDispatch: mapped === 'ok' || pendingStreak >= 5 };
  };
}

// A usage-limit menu as Claude Code draws it: the parser titles it from the body's "limit to reset" sentence.
const USAGE_LIMIT = '\x1b[2J\x1b[HYou have hit your usage limit. Wait for the limit to reset, or upgrade.\r\nWhat do you want to do?\r\n\r\n❯ 1. Stop and wait\r\n  2. Upgrade your plan\r\n\r\nEnter to confirm · Esc to cancel';

const open: FixtureTerminal[] = [];
afterEach(() => { while (open.length) open.pop()!.dispose(); });

const decode = (fx: PlanFixture, i: number): string => Buffer.from(fx.chunks[i].b64, 'base64').toString('utf8');

describe('the computer reads a screen exactly as the window does (real captures, every step)', () => {
  const files = listPlanFixtures();
  it('has captures to compare', () => { expect(files.length).toBeGreaterThan(10); });

  it.each(files)('%s: same screen text after every chunk, from both reads', async (file) => {
    const fx = loadPlanFixture(file);
    const ref = new FixtureTerminal(fx); open.push(ref);
    const rig = makeRig({ started: true });
    const resizeAt = fx.marks.find((m) => m.label.startsWith('resize '));
    // A turn is running, so the computer keeps a terminal; the capture is replayed into it chunk by chunk.
    for (const [type, payload] of turnStarts()) rig.note(type, payload);
    rig.screens.noteResize(S, fx.cols, fx.rows);
    for (let i = 0; i < fx.chunks.length; i++) {
      if (resizeAt && i === resizeAt.chunkIndex) { const [c, r] = resizeAt.label.split(' ')[1].split('x').map(Number); rig.screens.noteResize(S, c, r); }
      rig.output(decode(fx, i));
      await ref.advanceTo(i + 1);
      await rig.settle();
      const term = rig.term();
      expect(term, `a terminal exists while a turn runs (chunk ${i})`).not.toBeNull();
      const mine40 = screenTextOf(term!.buffer.active, 40);
      const theirs40 = getScreenText(ref.id, 40) ?? '';
      expect(mine40, `40-row tail, chunk ${i}`).toBe(theirs40);
      expect(visibleScreenTextOf(term!.buffer.active, term!.rows), `visible screen, chunk ${i}`).toBe(getVisibleScreenText(ref.id) ?? '');
    }
  });

  it('the stuck decision matches the window\'s, second by second, through a real capture and a long stall after it', async () => {
    const fx = loadPlanFixture('cc-2.1.281-default-120x40.json');
    const ref = new FixtureTerminal(fx); open.push(ref);
    const rig = makeRig({ started: true });
    for (const [type, payload] of turnStarts()) rig.note(type, payload);
    rig.screens.noteResize(S, fx.cols, fx.rows);
    const refHook = referenceHook(rig.now());
    const startAt = rig.now();
    const shown: Att[] = [];                       // what the window's rule would have shown, each time it would change
    let windowShows: Att = 'ok';
    let next = 0;
    // Replay the capture on its own clock (ms), then keep ticking for 50 s more with nothing changing.
    const lastT = fx.chunks[fx.chunks.length - 1].t;
    for (let sec = 1; sec <= Math.ceil(lastT / 1000) + 50; sec++) {
      const until = sec * 1000;
      while (next < fx.chunks.length && fx.chunks[next].t <= until) { rig.output(decode(fx, next)); next++; }
      await ref.advanceTo(next);
      await rig.settle();
      await rig.advance(startAt + until - rig.now());    // fires the computer's own 1 s tick
      const { mapped, shouldDispatch } = refHook((getScreenText(ref.id, 40) ?? '').split('\n'), startAt + until);
      if (shouldDispatch && mapped !== windowShows) { windowShows = mapped; shown.push(mapped); }
    }
    const mine = rig.lives().filter((l) => l.kind === 'attention').map((l) => l.state);
    expect(shown.length, 'the stall at the end must be long enough to exercise "stuck"').toBeGreaterThan(0);
    expect(mine).toEqual(shown);
  });

  it('a spinner that stops turning is stuck after the same 30 seconds and five readings the window waits for, and an ok clears it at once', async () => {
    const rig = makeRig({ started: true });
    for (const [type, payload] of turnStarts()) rig.note(type, payload);
    rig.output('\x1b[2J\x1b[H✻ Pondering… (12s · esc to interrupt)');
    const at = rig.now();
    await rig.advance(34_000);
    expect(rig.lives().filter((l) => l.kind === 'attention')).toEqual([]);   // 34 s in: past 30 s but the five-reading debounce has not held
    await rig.advance(8_000);
    expect(rig.lives().filter((l) => l.kind === 'attention').map((l) => l.state)).toEqual(['stuck']);
    expect(rig.now() - at).toBeGreaterThan(30_000);
    for (const [type, payload] of turnEnds()) rig.note(type, payload);        // the turn ends: the banner is taken back at once
    expect(rig.lives().filter((l) => l.kind === 'attention').map((l) => l.state)).toEqual(['stuck', 'ok']);
  });
});

describe('every live Claude Code session has one terminal, from its start to its end', () => {
  it('a session has its terminal from the moment it begins, an idle one costs no work, and its end disposes it', async () => {
    const rig = makeRig({ started: true });
    expect(rig.screens.terminalCount()).toBe(1);
    for (let i = 0; i < 50; i++) rig.output(`\x1b[2K\x1b[G❯ \x1b[2mstatus ${i}\x1b[22m`);
    await rig.advance(10_000);
    expect(rig.created()).toBe(1);                                 // never made again, never disposed while the session lives
    expect(rig.lives().length).toBe(0);                            // and says nothing while nothing is wrong
    rig.records.drop(S);
    expect(rig.screens.terminalCount()).toBe(0);
  });

  it('is fed every chunk from the first byte, once each', async () => {
    const rig = makeRig({ started: true });
    rig.output('\x1b[2J\x1b[Hbefore the turn');
    for (const [type, payload] of turnStarts()) rig.note(type, payload);
    rig.output('\r\nduring the turn');
    await rig.settle();
    expect(screenTextOf(rig.term()!.buffer.active, 40)).toBe('before the turn\nduring the turn');
  });

  it('only a Claude Code session is read (a shell or a native session never gets a terminal)', async () => {
    const rig = makeRig({ started: false, claude: false });
    for (const [type, payload] of turnStarts()) rig.note(type, payload);
    rig.output('hello');
    await rig.advance(2_000);
    expect(rig.screens.terminalCount()).toBe(0);
  });

  it('keeps only a short scrollback (the check reads 40 rows and the card reader the visible screen)', async () => {
    const rig = makeRig({ started: true });
    rig.output(Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\r\n'));
    await rig.settle();
    expect(rig.term()!.buffer.active.length).toBeLessThanOrEqual(60 + rig.term()!.rows);
  });

  it('a write that finishes after its terminal was disposed does not disturb the next terminal of the session', () => {
    // Fake terminals whose write callbacks the test fires by hand, and which count how often the stuck check reads them.
    const made: Array<{ callbacks: Array<() => void>; reads: number }> = [];
    const records = new SessionRecords(); records.begin(S);
    records.note(S, 'hook:event', { type: 'SessionStart', sessionId: S, payload: {} });
    const timers: Array<() => void> = [];
    const screens = new SessionScreens({
      records, live: { attention() {}, showPrompt() {}, dismissPrompt() {} } as any, isClaude: () => true,
      setTimer: () => ({}), clearTimer: () => {}, setRepeat: (fn) => { timers.push(fn); return {}; }, clearRepeat: () => {},
      createTerminal: () => {
        const t = { callbacks: [] as Array<() => void>, reads: 0 }; made.push(t);
        return {
          rows: 24, resize() {}, dispose() {}, write: (_d: string, cb?: () => void) => { if (cb) t.callbacks.push(cb); },
          buffer: { active: { get length() { t.reads++; return 0; }, getLine: () => undefined } },
        } as any;
      },
    });
    screens.refresh(S);
    screens.noteOutput(S, 'first');                                 // terminal 1 has a parse in flight
    screens.forget(S);                                              // the session record is recreated: terminal 1 goes
    records.drop(S); records.begin(S);
    records.note(S, 'hook:event', { type: 'SessionStart', sessionId: S, payload: {} });
    screens.refresh(S);                                             // terminal 2
    screens.noteOutput(S, 'second');                                // terminal 2 has a parse in flight
    for (const [type, payload] of turnStarts()) records.note(S, type, payload);   // the check starts, and waits for that parse
    screens.refresh(S);
    const readsBefore = made[1].reads;
    made[0].callbacks.forEach((cb) => cb());                        // terminal 1's late callback lands
    expect(made[1].reads, 'a stale callback must not start the check early').toBe(readsBefore);
    made[1].callbacks.forEach((cb) => cb());                        // terminal 2's own parse finishes: now it may
    expect(made[1].reads).toBeGreaterThan(readsBefore);
    screens.stop();
  });
});

describe('what the turn is doing decides whether the check runs', () => {
  const tool = (type: 'tool-use' | 'tool-result', id: string) => ['transcript:event', { type, sessionId: S, uuid: `${type}-${id}`, timestamp: 1, data: { toolUseId: id, toolName: 'Bash' } }] as const;
  const stalled = async (rig: ReturnType<typeof makeRig>) => { rig.output('\x1b[2J\x1b[H✻ Pondering… (12s · esc to interrupt)'); await rig.advance(45_000); };

  it('does not run while a tool is running, and starts again with a fresh count when it finishes', async () => {
    const rig = makeRig({ started: true });
    for (const [type, payload] of turnStarts()) rig.note(type, payload);
    rig.note(...tool('tool-use', 't1'));
    await stalled(rig);
    expect(rig.lives().filter((l) => l.kind === 'attention')).toEqual([]);       // a long tool is busy, not stuck
    rig.note(...tool('tool-result', 't1'));
    await rig.advance(33_000);
    expect(rig.lives().filter((l) => l.kind === 'attention')).toEqual([]);       // the count restarted at the tool's end
    await rig.advance(10_000);
    expect(rig.lives().filter((l) => l.kind === 'attention').map((l) => l.state)).toEqual(['stuck']);
  });

  it('does not run while an ask is waiting on the person, and a banner already up is taken back when one opens', async () => {
    const rig = makeRig({ started: true });
    for (const [type, payload] of turnStarts()) rig.note(type, payload);
    await stalled(rig);
    expect(rig.lives().filter((l) => l.kind === 'attention').map((l) => l.state)).toEqual(['stuck']);
    rig.note('hook:event', { type: 'PermissionRequest', sessionId: S, payload: { _requestId: 'r1', tool_name: 'Bash' } });
    expect(rig.lives().filter((l) => l.kind === 'attention').map((l) => l.state)).toEqual(['stuck', 'ok']);
  });
});

describe('with no computer window open, the phone is still told (the dots and the banner)', () => {
  it('the summary a phone draws its dot from says "stuck", the event a watching phone applies says so too, and a phone that connects later is handed it', async () => {
    const rig = makeRig({ started: true });
    for (const [type, payload] of turnStarts()) rig.note(type, payload);
    rig.output('\x1b[2J\x1b[H✻ Pondering… (12s · esc to interrupt)');
    await rig.advance(45_000);
    // No window anywhere in this rig: only the record, the screens and the publisher exist.
    expect(rig.records.summary(S)).toMatchObject({ working: true, attention: 'stuck' });
    expect(rig.lives().filter((l) => l.kind === 'attention').map((l) => l.state)).toEqual(['stuck']);
    expect(rig.records.liveFill(S)).toContainEqual({ type: 'session:live', payload: { sessionId: S, kind: 'attention', state: 'stuck' } });
    for (const [type, payload] of turnEnds()) rig.note(type, payload);
    expect(rig.records.summary(S)!.attention).toBe('ok');
  });
});

describe('cards: the computer reads the same menus the window did, from real captures', () => {
  interface Startup extends PlanFixture { marks: { t: number; label: string; chunkIndex: number }[] }
  const startups = listPlanFixtures(STARTUP_FIXTURE_DIR).filter((f) => !f.includes('answer-no') && !f.includes('digit-ignored'));
  const plans = listPlanFixtures();

  /** Replay a capture into the computer's terminal (in pieces of `split` bytes, 0 = as captured) and into the window's own, and collect what each decides. */
  async function replay(dir: string | undefined, file: string, started: boolean, split: number) {
    const fx = (dir ? loadPlanFixture(file, dir) : loadPlanFixture(file)) as Startup;
    const ref = new FixtureTerminal(fx); open.push(ref);
    const rig = makeRig({ started });                       // started:false = Claude Code has run no hook yet; true = an idle, already-started session
    rig.screens.noteResize(S, fx.cols, fx.rows);
    const seen: Array<{ promptId: string; title: string; buttons: any[]; defaultIndex?: number }> = [];
    const expected: typeof seen = [];
    let lastExpectedId = '';
    for (let i = 0; i < fx.chunks.length; i++) {
      const text = decode(fx, i);
      if (split > 0) for (let k = 0; k < text.length; k += split) rig.output(text.slice(k, k + split)); else rig.output(text);
      await ref.advanceTo(i + 1);
      await rig.settle();
      await rig.advance(700);                                   // past the show debounce
      // What the window's own rule decides from the same screen.
      const menu = parseInkSelect(getVisibleScreenText(ref.id) ?? '');
      const title = menu ? cardTitleFor(menu, !started) : null;
      if (menu && title && menu.id !== lastExpectedId) {
        const buttons = menuToButtons(menu);
        expected.push({ promptId: menu.id, title, buttons: buttons.map((b) => ({ label: b.label, input: b.input, ...(b.pick ? { pick: b.pick } : {}) })), ...(buttons.some((b) => b.pick) ? { defaultIndex: menu.selectedIndex } : {}) });
      }
      lastExpectedId = menu ? menu.id : '';
      for (const l of rig.lives()) if (l.kind === 'prompt-show' && !seen.some((x) => x.promptId === l.promptId)) seen.push({ promptId: l.promptId, title: l.title, buttons: l.buttons.map((b: any) => ({ label: b.label, input: b.input, ...(b.pick ? { pick: b.pick } : {}) })), ...(l.defaultIndex !== undefined ? { defaultIndex: l.defaultIndex } : {}) });
    }
    await rig.advance(2_000);
    const stillThere = parseInkSelect(getVisibleScreenText(ref.id) ?? '');
    return { seen, expected, open: rig.records.openPrompts(S).length, shouldBeOpen: stillThere && cardTitleFor(stillThere, !started) ? 1 : 0 };
  }

  it.each(startups)('%s: while the session is starting, a card goes up for each dialog the window would have drawn one for, with the same buttons, and comes down when the dialog goes', async (file) => {
    const r = await replay(STARTUP_FIXTURE_DIR, file, false, 0);
    expect(r.seen).toEqual(r.expected);
    expect(r.open).toBe(r.shouldBeOpen);
  });

  // The review's hole: Claude Code spaces words with cursor moves, so nothing about the bytes "looks like" a dialog. An idle, already-started session must
  // still get exactly the cards the window's rule gives, however the output is cut into chunks.
  it.each([0, 8, 40])('every startup capture replayed into an IDLE, ALREADY-STARTED session (chunks cut every %i bytes) gives the cards the window rule gives', async (split) => {
    let total = 0;
    for (const file of startups) {
      const r = await replay(STARTUP_FIXTURE_DIR, file, true, split);
      expect(r.seen, file).toEqual(r.expected);
      expect(r.open, file).toBe(r.shouldBeOpen);
      total += r.expected.length;
      for (const o of open.splice(0)) o.dispose();
    }
    expect(total, 'the window rule must find cards in these captures, or this proves nothing').toBeGreaterThanOrEqual(15);
  }, 120_000);

  it.each(plans)('%s: replayed into an idle, started session, the same cards as the window rule (a permission menu is no setup card)', async (file) => {
    const r = await replay(undefined, file, true, 0);
    expect(r.seen).toEqual(r.expected);
  });

  it('a menu a permission ask owns is left alone, and a numbered list in a reply is not a card once the session has started', async () => {
    const rig = makeRig({ started: true });
    for (const [type, payload] of turnStarts()) rig.note(type, payload);
    rig.note('hook:event', { type: 'PermissionRequest', sessionId: S, payload: { _requestId: 'r1', tool_name: 'Bash' } });
    rig.output('\x1b[2J\x1b[HDo you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n\r\nEsc to cancel');
    await rig.advance(2_000);
    expect(rig.records.openPrompts(S)).toEqual([]);
    rig.note('hook:event', { type: 'PermissionResolved', sessionId: S, payload: { _requestId: 'r1' } });
    await rig.advance(5_000);
    expect(rig.records.openPrompts(S)).toEqual([]);                       // "Do you want to proceed?" is not a known setup prompt
  });

  it('a usage-limit dialog in an idle session gets a card, and it comes down with the dialog', async () => {
    const rig = makeRig({ started: true });
    rig.output(USAGE_LIMIT);
    await rig.settle();
    await rig.advance(1_000);
    expect(rig.records.openPrompts(S).map((p) => p.title)).toEqual(['Usage Limit Reached']);
    rig.output('\x1b[2J\x1b[H❯ \r\n? for shortcuts');
    await rig.advance(10_000);
    expect(rig.records.openPrompts(S)).toEqual([]);
  });
});
