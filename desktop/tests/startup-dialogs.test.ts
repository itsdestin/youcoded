// Claude Code's startup dialogs, replayed from REAL captures
// (tests/fixtures/startup-dialogs/, recorded by
// test-conpty/capture-startup-dialogs.mjs) through a headless xterm and the
// app's own screen serializer — the same text the parser reads in the app.
//
// Why this file exists: Claude Code 2.1.281 stopped numbering the options of
// its folder-trust and bypass-permissions dialogs, the parser (which required
// "1." / "2.") stopped seeing them, and new sessions sat on "Initializing
// session…" with no card. The same class of break had happened before (the
// 2.1.2xx trust rewrite). These tests pin, for every captured situation:
//   • what the parser reads (title, options, where the cursor starts);
//   • that answering types exactly what the real Claude Code accepted, and that
//     Claude Code then did what the button says (trusted / exited / accepted);
//   • that anything uncertain is refused rather than guessed.
// After a Claude Code update: re-run the capture, then this file.
import { describe, it, expect, afterEach } from 'vitest';
import {
  parseInkSelect, menuToButtons, readStartupDialog,
} from '../src/renderer/parser/ink-select-parser';
import { answerInkMenu, INK_MENU_TIMING, type InkMenuIO } from '../src/renderer/state/ink-menu-driver';
import {
  FixtureTerminal, listPlanFixtures, loadPlanFixture, STARTUP_FIXTURE_DIR, type PlanFixture,
} from './helpers/plan-menu-fixtures';

interface StartupFixture extends PlanFixture {
  key: string;
  scenario: string;
  marks: { t: number; label: string; chunkIndex: number; data?: string }[];
  dialogs: unknown[];
  outcome: {
    steps: Array<{ dialog: number; answered?: string; stayed?: boolean }>;
    folderTrusted?: boolean;
    bypassAccepted?: boolean;
    exitCode: number | null;
    reachedMainPrompt?: boolean;
    error?: string;
  };
}

const TRUST = { title: 'Trust This Folder?', options: ['No, exit', 'Yes, I trust this folder'], cursor: 0 };
const BYPASS = { title: 'Skip Permissions Warning', options: ['No, exit', 'Yes, I accept'], cursor: 0 };
const MCP_ONE = {
  title: 'New MCP Server Found',
  options: ['Use this MCP server', 'Use this and all future MCP servers in this project', 'Continue without using this MCP server'],
  cursor: 2,
};
/** A multi-select checkbox dialog: deliberately NOT turned into buttons. */
const UNREADABLE = (heading: string) => ({ unreadable: heading });
type Expect = typeof TRUST | ReturnType<typeof UNREADABLE>;

// Every captured scenario → what each of its dialogs must read as. A fixture
// missing from this table fails the "every capture is covered" test below, so a
// newly captured situation cannot slip in untested.
const EXPECTED: Record<string, Expect[]> = {
  'untrusted': [TRUST],
  'untrusted-answer-no': [TRUST],
  'untrusted-digit-ignored': [TRUST, TRUST],
  'home-folder': [TRUST],
  'git-repo': [TRUST],
  'project-settings': [TRUST],
  'project-hooks-only': [TRUST],
  'mcp-one': [TRUST, MCP_ONE],
  'mcp-two': [TRUST, UNREADABLE('2 new MCP servers found in this project')],
  'trusted': [],
  'bypass-trusted': [BYPASS],
  'bypass-answer-no': [BYPASS],
  'bypass-untrusted': [TRUST, BYPASS],
  'untrusted-signed-in': [TRUST],
  'bypass-untrusted-signed-in': [TRUST, BYPASS],
};

const open: FixtureTerminal[] = [];
afterEach(() => { while (open.length) open.pop()!.dispose(); });

const FILES = listPlanFixtures(STARTUP_FIXTURE_DIR);
const load = (f: string) => loadPlanFixture(f, STARTUP_FIXTURE_DIR) as StartupFixture;

async function screenAt(fx: StartupFixture, label: string): Promise<string> {
  const t = new FixtureTerminal(fx);
  open.push(t);
  await t.advanceToMark(label);
  return t.screen();
}

describe('startup-dialog captures', () => {
  it('has captures, and every one is in the expectation table', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(15);
    for (const f of FILES) {
      const fx = load(f);
      expect(fx.outcome.error, `${fx.key} capture failed`).toBeUndefined();
      expect(EXPECTED, `no expectation for scenario "${fx.scenario}" (${f})`).toHaveProperty([fx.scenario]);
      expect(fx.marks.filter((m) => /^dialog-\d+-visible$/.test(m.label)).length).toBe(EXPECTED[fx.scenario].length);
    }
  });

  for (const file of FILES) {
    const fx0 = load(file);
    describe(fx0.key, () => {
      EXPECTED[fx0.scenario]?.forEach((want, i) => {
        it(`dialog ${i + 1} reads as ${'unreadable' in want ? 'unreadable (answer in terminal)' : `"${want.title}"`}`, async () => {
          const screen = await screenAt(load(file), `dialog-${i + 1}-visible`);
          const menu = parseInkSelect(screen);
          if ('unreadable' in want) {
            expect(menu).toBeNull();
            expect(readStartupDialog(screen)).toEqual({ heading: want.unreadable });
            return;
          }
          expect(menu).not.toBeNull();
          expect(menu!.title).toBe(want.title);
          expect(menu!.options).toEqual(want.options);
          expect(menu!.selectedIndex).toBe(want.cursor);
          expect(menu!.dialog).toBe(true);
          // No printed numbers on 2.1.281 → every button answers by verified
          // navigation, none by a fixed keystroke.
          const buttons = menuToButtons(menu!);
          expect(buttons.map((b) => b.label)).toEqual(want.options);
          expect(buttons.every((b) => b.pick && b.input === '' && b.submitInput === undefined)).toBe(true);
        });
      });

      if (EXPECTED[fx0.scenario]?.length === 0) {
        it('shows no dialog at all', async () => {
          const fx = load(file);
          const screen = await screenAt(fx, 'main-prompt-visible');
          expect(parseInkSelect(screen)).toBeNull();
          expect(readStartupDialog(screen)).toBeNull();
        });
      }
    });
  }
});

/**
 * A capture played back as Claude Code: when the driver types exactly what the
 * capture harness typed next, the screen advances to what Claude Code printed
 * in reply. Anything else is recorded as a mismatch and the screen stays put.
 */
async function replay(fx: StartupFixture, dialog: number) {
  const term = new FixtureTerminal(fx);
  open.push(term);
  const visible = fx.marks.find((m) => m.label === `dialog-${dialog}-visible`)!;
  const nextVisible = fx.marks.find((m) => m.label === `dialog-${dialog + 1}-visible`);
  const boundary = nextVisible ? nextVisible.chunkIndex : fx.chunks.length;
  const sends = fx.marks.filter((m) => m.label === 'send' && m.chunkIndex >= visible.chunkIndex && m.chunkIndex < boundary);
  await term.advanceTo(visible.chunkIndex);
  const writes: string[] = [];
  const mismatches: string[] = [];
  let pending: Promise<void> = Promise.resolve();
  let t = 0;
  const io: InkMenuIO = {
    read: () => term.screen(),
    write: (d) => {
      writes.push(d);
      const want = sends.shift();
      if (!want || want.data !== d) { mismatches.push(JSON.stringify(d)); return; }
      const end = sends[0] ? sends[0].chunkIndex : boundary;
      pending = pending.then(() => term.advanceTo(end));
    },
    settle: async (ms) => { await pending; t += ms; },
    now: () => t,
  };
  const menu = parseInkSelect(term.screen())!;
  return { io, writes, mismatches, menu };
}

describe('answering a startup dialog types exactly what real Claude Code accepted', () => {
  const cases: Array<{ file: string; dialog: number; label: string; exits?: boolean; check: (fx: StartupFixture) => void }> = [
    { file: 'untrusted-100x35', dialog: 1, label: 'Yes, I trust this folder', check: (fx) => expect(fx.outcome.folderTrusted).toBe(true) },
    { file: 'untrusted-50x30', dialog: 1, label: 'Yes, I trust this folder', check: (fx) => expect(fx.outcome.folderTrusted).toBe(true) },
    { file: 'untrusted-180x50', dialog: 1, label: 'Yes, I trust this folder', check: (fx) => expect(fx.outcome.folderTrusted).toBe(true) },
    // Trusting the HOME folder lets the session start but is not remembered —
    // Claude Code asks again next time (measured on 2.1.281).
    {
      file: 'home-folder-100x35', dialog: 1, label: 'Yes, I trust this folder',
      check: (fx) => { expect(fx.outcome.reachedMainPrompt).toBe(true); expect(fx.outcome.folderTrusted).toBe(false); },
    },
    { file: 'project-settings-50x30', dialog: 1, label: 'Yes, I trust this folder', check: (fx) => expect(fx.outcome.folderTrusted).toBe(true) },
    // "No, exit": Claude Code quits and leaves its dialog painted on the dead
    // terminal, so the driver cannot see it leave (it reports not-taken; in the
    // app the session closes and the card with it). What matters: the keys
    // picked "No, exit" and nothing was trusted.
    {
      file: 'untrusted-answer-no-100x35', dialog: 1, label: 'No, exit', exits: true,
      check: (fx) => { expect(fx.outcome.folderTrusted).toBe(false); expect(fx.outcome.exitCode).toBe(1); },
    },
    { file: 'bypass-trusted-100x35', dialog: 1, label: 'Yes, I accept', check: (fx) => expect(fx.outcome.bypassAccepted).toBe(true) },
    {
      file: 'bypass-answer-no-100x35', dialog: 1, label: 'No, exit', exits: true,
      check: (fx) => { expect(fx.outcome.bypassAccepted).toBe(false); expect(fx.outcome.exitCode).not.toBeNull(); },
    },
    // Dialog 1 answered and dialog 2 drawn straight after: "answered" means
    // THIS dialog left, even though another menu is now on screen.
    { file: 'bypass-untrusted-100x35', dialog: 1, label: 'Yes, I trust this folder', check: (fx) => expect(fx.outcome.folderTrusted).toBe(true) },
    { file: 'mcp-one-100x35', dialog: 1, label: 'Yes, I trust this folder', check: (fx) => expect(fx.outcome.folderTrusted).toBe(true) },
    { file: 'bypass-untrusted-100x35', dialog: 2, label: 'Yes, I accept', check: (fx) => expect(fx.outcome.bypassAccepted).toBe(true) },
    { file: 'bypass-untrusted-50x30', dialog: 2, label: 'Yes, I accept', check: (fx) => expect(fx.outcome.bypassAccepted).toBe(true) },
    { file: 'mcp-one-100x35', dialog: 2, label: 'Continue without using this MCP server', check: (fx) => expect(fx.outcome.reachedMainPrompt).toBe(true) },
    { file: 'mcp-one-40x30', dialog: 2, label: 'Continue without using this MCP server', check: (fx) => expect(fx.outcome.reachedMainPrompt).toBe(true) },
  ];
  for (const c of cases) {
    it(`${c.file}: "${c.label}"`, async () => {
      // By scenario key, not version, so a fresh capture from a newer Claude
      // Code (check-startup-drift.mjs --app) is checked by the same cases.
      const file = FILES.filter((f) => f.endsWith(`-${c.file}.json`)).pop();
      expect(file, `no capture for ${c.file}`).toBeDefined();
      const fx = load(file!);
      const { io, writes, mismatches, menu } = await replay(fx, c.dialog);
      const index = menu.options.indexOf(c.label);
      expect(index).toBeGreaterThanOrEqual(0);
      const res = await answerInkMenu({ signature: menu.signature!, index, label: c.label }, io);
      expect(mismatches).toEqual([]);
      expect(res).toEqual(c.exits ? { ok: false, reason: 'not-taken', typed: true } : { ok: true });
      // Arrows one per write, Enter alone and last — never together.
      expect(writes[writes.length - 1]).toBe('\r');
      expect(writes.every((w) => w === '\r' || w === '\u001b[A' || w === '\u001b[B')).toBe(true);
      c.check(fx);
    });
  }

  it('a typed digit does nothing on these dialogs (why the app no longer types one)', () => {
    const fx = load(FILES.filter((f) => f.endsWith('-untrusted-digit-ignored-100x35.json')).pop()!);
    expect(fx.outcome.steps[0]).toMatchObject({ keys: '2', stayed: true });
  });
});

// ---- fail-safe: hand-made screens for what a capture cannot stage ----------

const RULE = '─'.repeat(60);
function trustScreen(cursor: 0 | 1, extra: { footer?: boolean; options?: string[] } = {}): string {
  const options = extra.options ?? ['No, exit', 'Yes, I trust this folder'];
  return [
    RULE,
    ' Accessing workspace:',
    '',
    ' /home/someone/project',
    '',
    " Claude Code'll be able to read, edit, and execute files here.",
    '',
    ' Security guide',
    '',
    ...options.map((o, i) => (i === cursor ? ` ❯ ${o}` : `   ${o}`)),
    '',
    ...(extra.footer === false ? [] : [' Enter to confirm · Esc to cancel']),
  ].join('\n');
}

/** A scripted Claude Code: `react(key, screen)` returns the next screen. */
function scripted(first: string, react: (key: string, screen: string) => string) {
  let screen = first;
  const writes: string[] = [];
  let t = 0;
  const io: InkMenuIO = {
    read: () => screen,
    write: (d) => { writes.push(d); screen = react(d, screen); },
    settle: async (ms) => { t += ms; },
    now: () => t,
  };
  return { io, writes, set: (s: string) => { screen = s; } };
}

describe('the startup-dialog driver never guesses', () => {
  const sig = parseInkSelect(trustScreen(0))!.signature!;

  it('refuses without typing when the options on screen are not the ones on the card', async () => {
    const cc = scripted(trustScreen(0, { options: ['No, exit', 'Yes, I trust this folder', 'Something new'] }), (_k, s) => s);
    const r = await answerInkMenu({ signature: sig, index: 1, label: 'Yes, I trust this folder' }, cc.io);
    expect(r).toEqual({ ok: false, reason: 'menu-changed', typed: false });
    expect(cc.writes).toEqual([]);
  });

  it('refuses without typing when the label at that position is not the button\'s', async () => {
    const cc = scripted(trustScreen(0), (_k, s) => s);
    const r = await answerInkMenu({ signature: sig, index: 0, label: 'Yes, I trust this folder' }, cc.io);
    expect(r).toMatchObject({ ok: false, reason: 'menu-changed', typed: false });
    expect(cc.writes).toEqual([]);
  });

  it('refuses without typing when the dialog is gone', async () => {
    const cc = scripted('❯ \n? for shortcuts', (_k, s) => s);
    const r = await answerInkMenu({ signature: sig, index: 1, label: 'Yes, I trust this folder' }, cc.io);
    expect(r).toEqual({ ok: false, reason: 'menu-gone', typed: false });
    expect(cc.writes).toEqual([]);
  });

  it('never sends Enter when the cursor does not move', async () => {
    const cc = scripted(trustScreen(0), (_k, s) => s); // arrows ignored
    const r = await answerInkMenu({ signature: sig, index: 1, label: 'Yes, I trust this folder' }, cc.io);
    expect(r).toEqual({ ok: false, reason: 'not-taken', typed: true });
    // ONE arrow, unconfirmed → stop. Never a second key, never Enter.
    expect(cc.writes).toEqual(['\u001b[B']);
  });

  it('never sends Enter when the options change mid-walk', async () => {
    const cc = scripted(trustScreen(0), () => trustScreen(1, { options: ['No, exit', 'Yes, I trust this folder', 'Other'] }));
    const r = await answerInkMenu({ signature: sig, index: 1, label: 'Yes, I trust this folder' }, cc.io);
    expect(r).toMatchObject({ ok: false });
    expect(cc.writes).not.toContain('\r');
  });

  it('walks UP when the cursor is below the target, and sends Enter alone', async () => {
    const cc = scripted(trustScreen(1), (k, s) => (k === '\u001b[A' ? trustScreen(0) : k === '\r' ? '❯ \n? for shortcuts' : s));
    const r = await answerInkMenu({ signature: sig, index: 0, label: 'No, exit' }, cc.io);
    expect(r).toEqual({ ok: true });
    expect(cc.writes).toEqual(['\u001b[A', '\r']);
  });

  it('reports not-taken when Enter does not make the dialog leave', async () => {
    const cc = scripted(trustScreen(1), (_k, s) => s);
    const r = await answerInkMenu({ signature: sig, index: 1, label: 'Yes, I trust this folder' }, cc.io);
    expect(r).toEqual({ ok: false, reason: 'not-taken', typed: true });
    expect(cc.writes).toEqual(['\r']);
    expect(INK_MENU_TIMING.leaveMs).toBeGreaterThan(0);
  });
});

describe('the unnumbered reader refuses what it cannot be sure of', () => {
  it('no dialog footer → not a menu (a quoted list in the conversation)', () => {
    expect(parseInkSelect(trustScreen(0, { footer: false }))).toBeNull();
  });

  it('no box rule above → not a menu', () => {
    expect(parseInkSelect(trustScreen(0).split('\n').slice(1).join('\n'))).toBeNull();
  });

  it('two cursors on screen → not one menu', () => {
    const screen = trustScreen(0).replace('   Yes, I trust this folder', ' ❯ Yes, I trust this folder');
    expect(parseInkSelect(screen.replace(' ❯ No, exit', ' ❯ No, exit'))).toBeNull();
  });

  it('a checkbox (multi-select) dialog → not buttons, but reported as a startup dialog', () => {
    const screen = [RULE, '  2 new MCP servers found in this project', '', '  ❯ [✔] demo', '    [✔] other', '       Enable selected', ' Space to select · Esc to reject all'].join('\n');
    expect(parseInkSelect(screen)).toBeNull();
    expect(readStartupDialog(screen)).toEqual({ heading: '2 new MCP servers found in this project' });
  });

  it('a row too close to call (wrap or new option?) → the whole dialog is refused', () => {
    // Width 40; "Use this and all future MCP servers" is 35 wide at column 4 = 39
    // ends at col 39; the next word "in" would need 39+1+2 = 42 > 40 → a wrap
    // (fine). Shorten it so the next word would land exactly in the 2-column
    // band the dialog's padding makes uncertain.
    const r = '─'.repeat(40);
    const screen = [r, '  New MCP server found in this', '  project: demo', '', '    Use this MCP server', '    Use this and all future MCP serv', '    xy', '  ❯ Continue without', '', '  Enter to confirm · Esc to cancel'].join('\n');
    expect(parseInkSelect(screen)).toBeNull();
  });

  it('still reads the older NUMBERED trust dialog, and answers it by digit', () => {
    const menu = parseInkSelect(' ❯ 1. Yes, I trust this folder\n   2. No, exit');
    expect(menu!.title).toBe('Trust This Folder?');
    expect(menuToButtons(menu!).map((b) => b.input)).toEqual(['1', '2']);
    expect(menuToButtons(menu!).some((b) => b.pick)).toBe(false);
  });
});

// ---- Android parity ---------------------------------------------------------
// Android parses Claude Code's screen natively (app/.../parser/InkSelectParser.kt)
// and its buttons are answered by THIS renderer's driver, which refuses unless
// its own parse's signature matches the Kotlin one. So both parsers must read
// every capture identically. This writes/checks the screens and the desktop
// verdicts the Kotlin test (InkSelectParserStartupTest) replays. After a new
// capture: UPDATE_ANDROID_STARTUP_SCREENS=1 npx vitest run tests/startup-dialogs.test.ts
import fs from 'fs';
import path from 'path';

const ANDROID_DIR = path.join(__dirname, '..', '..', 'app', 'src', 'test', 'resources', 'startup-dialogs');

// Skipped when replaying a fresh capture (STARTUP_FIXTURE_DIR): the Android
// screens belong to the SAVED set.
describe.skipIf(!!process.env.STARTUP_FIXTURE_DIR)('Android parity screens', () => {
  it('app/src/test/resources/startup-dialogs matches what the desktop parser reads', async () => {
    const want = new Map<string, string>();
    for (const file of FILES) {
      const fx = load(file);
      for (const m of fx.marks.filter((x) => /^dialog-\d+-visible$/.test(x.label))) {
        const t = new FixtureTerminal(fx);
        open.push(t);
        await t.advanceToMark(m.label);
        const screen = t.androidScreen();
        const menu = parseInkSelect(screen);
        const expected = menu && menu.dialog ? {
          title: menu.title, options: menu.options, selectedIndex: menu.selectedIndex,
          signature: menu.signature, heading: menu.heading ?? null,
          picks: menuToButtons(menu).every((b) => !!b.pick),
        } : null;
        want.set(`${fx.key}-${m.label}.json`, JSON.stringify({ screen, expected }, null, 1) + '\n');
      }
    }
    if (process.env.UPDATE_ANDROID_STARTUP_SCREENS) {
      fs.rmSync(ANDROID_DIR, { recursive: true, force: true, maxRetries: 3 });
      fs.mkdirSync(ANDROID_DIR, { recursive: true });
      for (const [name, body] of want) fs.writeFileSync(path.join(ANDROID_DIR, name), body);
    }
    const have = fs.existsSync(ANDROID_DIR) ? fs.readdirSync(ANDROID_DIR).sort() : [];
    expect(have).toEqual([...want.keys()].sort());
    for (const [name, body] of want) {
      expect(fs.readFileSync(path.join(ANDROID_DIR, name), 'utf8').replace(/\r/g, ''), name).toBe(body);
    }
  });
});

// ---- review F3/F5: each driver check pinned on its own ---------------------
const MCP_RULE = '─'.repeat(100);
const MCP_OPTS = ['Use this MCP server', 'Use this and all future MCP servers in this project', 'Continue without using this MCP server'];
function mcpScreen(cursor: number, opts: { server?: string; options?: string[] } = {}): string {
  const options = opts.options ?? MCP_OPTS;
  return [
    MCP_RULE,
    `  New MCP server found in this project: ${opts.server ?? 'demo'}`,
    '',
    '  MCP servers may execute code or access system resources. All tool calls require approval. Learn',
    '  more in the MCP documentation.',
    '',
    ...options.map((o, i) => (i === cursor ? `  ❯ ${o}` : `    ${o}`)),
    '',
    '  Enter to confirm · Esc to cancel',
  ].join('\n');
}
const OTHER_OPTS = ['First', 'Second', 'Third'];
const mcpSig = parseInkSelect(mcpScreen(0))!.signature!;

/** A Claude Code whose screen is a fixed sequence of reads (the last repeats). */
function sequence(reads: string[]) {
  const writes: string[] = [];
  let i = 0;
  let t = 0;
  const io: InkMenuIO = {
    read: () => reads[Math.min(i++, reads.length - 1)],
    write: (d) => { writes.push(d); },
    settle: async (ms) => { t += ms; },
    now: () => t,
  };
  return { io, writes };
}

describe('the startup-dialog driver never guesses — each check on its own', () => {
  it('re-checks the option set at the top of every step (a change after a confirmed move stops it)', async () => {
    // reads: start, step0 (cursor 0), wait (cursor 1 — confirmed), step1: a DIFFERENT menu
    // whose cursor happens to sit on the target row.
    const cc = sequence([mcpScreen(0), mcpScreen(0), mcpScreen(1), mcpScreen(2, { options: OTHER_OPTS })]);
    const r = await answerInkMenu({ signature: mcpSig, index: 2, label: MCP_OPTS[2] }, cc.io);
    expect(r).toEqual({ ok: false, reason: 'menu-changed', typed: true });
    expect(cc.writes).toEqual(['\u001b[B']);
  });

  it('re-checks the option set inside the wait (another menu\'s cursor is not our move)', async () => {
    // After the arrow: a different menu with its cursor on the expected row, then
    // ours again with the cursor never moved.
    const cc = sequence([mcpScreen(0), mcpScreen(0), mcpScreen(1, { options: OTHER_OPTS }), mcpScreen(0)]);
    const r = await answerInkMenu({ signature: mcpSig, index: 1, label: MCP_OPTS[1] }, cc.io);
    expect(r).toEqual({ ok: false, reason: 'not-taken', typed: true });
    expect(cc.writes).toEqual(['\u001b[B']);
  });

  it('accepts only a move of exactly one row (a jump is not our move, and Enter is never sent)', async () => {
    const cc = sequence([mcpScreen(0), mcpScreen(0), mcpScreen(2)]);
    const r = await answerInkMenu({ signature: mcpSig, index: 2, label: MCP_OPTS[2] }, cc.io);
    expect(r).toEqual({ ok: false, reason: 'not-taken', typed: true });
    expect(cc.writes).toEqual(['\u001b[B']);
  });

  it('a following dialog with the same options but a different question counts as answered', async () => {
    const cc = scripted(mcpScreen(2), (k, s) => (k === '\r' ? mcpScreen(2, { server: 'other' }) : s));
    const r = await answerInkMenu({ signature: mcpSig, index: 2, label: MCP_OPTS[2] }, cc.io);
    expect(r).toEqual({ ok: true });
  });

  it('an IDENTICAL dialog redrawn after our Enter, cursor back on its default, is the next dialog', async () => {
    let out = 0;
    const cc = scripted(mcpScreen(1), (k, s) => {
      if (k === '\u001b[A') return mcpScreen(0);
      if (k === '\r') { out++; return mcpScreen(2); }
      return s;
    });
    const r = await answerInkMenu({ signature: mcpSig, index: 0, label: MCP_OPTS[0] }, { ...cc.io, outputCount: () => out });
    expect(r).toEqual({ ok: true });
    expect(cc.writes).toEqual(['\u001b[A', '\r']);
  });

  it('without any output after Enter the same dialog is "not taken" — never assumed answered', async () => {
    // Even with its cursor somewhere else afterwards (say, moved in terminal
    // view): no redraw from Claude Code after our Enter = not proof it acted.
    const cc = scripted(mcpScreen(0), (k, s) => (k === '\r' ? mcpScreen(2) : s));
    const r = await answerInkMenu({ signature: mcpSig, index: 0, label: MCP_OPTS[0] }, { ...cc.io, outputCount: () => 0 });
    expect(r).toEqual({ ok: false, reason: 'not-taken', typed: true });
  });
});
