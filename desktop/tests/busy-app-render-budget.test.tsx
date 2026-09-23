// @vitest-environment jsdom
// With eight tabs open, everyday actions redraw only what the user can see.
//
// Destin reported heavy lag switching tabs and typing with many sessions open
// (2026-09-23). The causes were all the same shape: work done for tabs nobody
// can see — a root re-render reaching every tab's terminal, one window listener
// per tab, a "thinking…" timer ticking in a hidden tab. Each was fixed (or is
// being fixed) in its own component, and each could come back through a
// component nobody thought to test. So this file does not test components: it
// mounts the REAL app shell against the UI Workbench's fake backend
// (tests/helpers/busy-app.tsx), opens eight sessions the way the app opens them,
// drives the things a user does all day, and counts what React redrew.
// A new surface mounted in the app is inside these budgets automatically.
//
// How renders are counted: a <Profiler> inside a copy of each session's
// ChatView and TerminalView (busy-app-probes.tsx) — it fires when that tab's
// chat or terminal renders, or when anything under it commits. The shell count
// is App.tsx's own DEV counter (AppInner commits).
//
// Every budget is met (2026-09-23, the many-tabs perf batch). Each test's
// comment names the fix that met it and what master did before. A zero can
// also "pass" because a probe went blind, so the three controls at the bottom
// prove the probes can see renders at all.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

vi.mock('@xterm/xterm', async () => (await import('./helpers/busy-app-probes')).fakeXtermModule());
vi.mock('@xterm/addon-fit', async () => (await import('./helpers/busy-app-probes')).fakeAddonModule('FitAddon'));
vi.mock('@xterm/addon-unicode11', async () => (await import('./helpers/busy-app-probes')).fakeAddonModule('Unicode11Addon'));
vi.mock('@xterm/addon-webgl', async () => (await import('./helpers/busy-app-probes')).fakeAddonModule('WebglAddon'));
vi.mock('../src/renderer/components/ChatView', async (importOriginal) => {
  const real = await importOriginal<any>();
  return { ...real, default: (await import('./helpers/busy-app-probes')).probe(real.default, 'chat') };
});
vi.mock('../src/renderer/components/TerminalView', async (importOriginal) => {
  const real = await importOriginal<any>();
  return { ...real, default: (await import('./helpers/busy-app-probes')).probe(real.default, 'terminal') };
});

import { mountBusyApp, FAKE_TIMERS, type BusyApp } from './helpers/busy-app';
import { terminalWrites } from './helpers/busy-app-probes';

// ── The budgets. Change a number here only with a reason in the commit. ──────
const BUDGET = {
  /** Renders of the app shell (AppInner) per plain character typed. */
  shellPerKeystroke: 0,
  /** …per character typed after "/" (the command drawer is open). */
  shellPerSlashKeystroke: 0,
  /** …per streamed word after the first, in the visible tab. */
  shellPerStreamedWord: 0,
  /** Renders of a tab the event does not concern (hidden, not the one it happened in). */
  unrelatedTab: 0,
  /** Renders of a HIDDEN tab for a whole reply streamed into it — its structure
   *  may change (turn start, tool card, turn end), but never once per word. */
  hiddenTabWholeReply: 4,
  /** Renders of hidden-but-thinking tabs over 10 idle seconds. */
  hiddenThinkingTabPer10s: 0,
  /** Extra window/document listeners for opening 7 more tabs (keys+pointer, and everything else, each). */
  listenersFor7MoreTabs: 2,
};

const SESSIONS = 8;
const WORDS = 40;

// Importing App.tsx transforms the whole renderer graph — seconds on a
// loaded machine, and over the 30 s test budget on the Windows runner if the
// first test paid it. Paid once here instead (test-suite-hygiene.md).
const WARM_IMPORT_BUDGET_MS = 120_000;
beforeAll(async () => { await import('../src/renderer/App'); }, WARM_IMPORT_BUDGET_MS);

let app: BusyApp;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
  app = await mountBusyApp({ sessions: SESSIONS });
});
afterEach(() => {
  // No boundary tripped during the test: a crashed tab draws nothing, which
  // would meet every budget above.
  expect(app?.crashes() ?? []).toEqual([]);
  vi.useRealTimers();
});

/** A tab-by-tab map of zeros, for readable failure diffs. */
const zeros = (...except: string[]) => Object.fromEntries(app.sessionIds.filter((id) => !except.includes(id)).map((id) => [id, BUDGET.unrelatedTab]));

describe('eight tabs open: a reply streaming', () => {
  // Met by: TerminalView is memoised. The turn starting flips "thinking",
  // which re-renders App once (allowed); an unmemoised terminal re-rendered
  // with it in every Claude Code tab.
  // Before (master): 2 renders (turn opened, turn ended) in each of the 3
  // other Claude Code tabs' terminals; 0 in every other tab's chat. Now: 0.
  it('into a hidden tab redraws no other tab', async () => {
    const [visible, hidden] = app.sessionIds;
    const reply = await app.beginReply(hidden);
    await reply.words(WORDS / 2);
    await reply.tool();
    await reply.words(WORDS / 2);
    await reply.end();
    expect(app.otherTabRenders(hidden)).toEqual(zeros(hidden));
    expect(app.visibleId()).toBe(visible);
  });

  // Met by: a hidden ChatView reads useChatState(id, { paused: true }) and
  // holds its last picture until shown (chat-state-paused.test.tsx pins that
  // it is current on the first shown frame).
  // Before (master): 45 renders for a 40-word reply with one tool call. Now: 0.
  it('into a hidden tab redraws that tab a few times, never once per word', async () => {
    const hidden = app.sessionIds[1];
    const reply = await app.beginReply(hidden);
    await reply.words(WORDS / 2);
    await reply.tool();
    await reply.words(WORDS / 2);
    await reply.end();
    expect(app.chatRenders(hidden) + app.terminalRenders(hidden)).toBeLessThanOrEqual(BUDGET.hiddenTabWholeReply);
  });

  // Met by: TerminalView is memoised (same cause as the first test).
  // Before (master): 2 renders in each of the 3 hidden Claude Code terminals. Now: 0.
  it('into the visible tab redraws no hidden tab', async () => {
    const visible = app.visibleId();
    const reply = await app.beginReply(visible);
    await reply.words(WORDS);
    await reply.end();
    expect(app.otherTabRenders(visible)).toEqual(zeros(visible));
  });

  it('word by word in the visible tab does not redraw the shell', async () => {
    const reply = await app.beginReply(app.visibleId());
    await reply.words(1); // the first word may change the shell (the turn opened)
    app.resetCounts();
    await reply.words(WORDS - 1);
    expect(app.shellRenders()).toBe(BUDGET.shellPerStreamedWord * (WORDS - 1));
    await reply.end();
  });
});

describe('eight tabs open: typing in the composer', () => {
  it('plain text redraws neither the shell nor any hidden tab', async () => {
    const visible = app.visibleId();
    for (const value of ['h', 'he', 'hel', 'hell', 'hello']) await app.type(value);
    expect(app.shellRenders()).toBe(BUDGET.shellPerKeystroke * 5);
    expect(app.otherTabRenders(visible)).toEqual(zeros(visible));
  });

  // Met by: the command drawer's filter lives in a small store only the drawer
  // reads, not in App state.
  // Before (master): "/" → 0 shell renders, then 1 per character (3 for "/a", "/ab", "/abc"). Now: 0.
  it('a slash command does not redraw the shell', async () => {
    await app.type('/');
    app.resetCounts();
    for (const value of ['/a', '/ab', '/abc']) await app.type(value);
    expect(app.shellRenders()).toBe(BUDGET.shellPerSlashKeystroke * 3);
  });

  // Met by: the slash filter leaving App state AND TerminalView's memo. The
  // "/" itself still opens the drawer through App (allowed), which reached the
  // hidden terminals until the memo.
  // Before (master): 5 renders in each hidden Claude Code terminal for typing
  // "/" through "/abc" (2 with the slash fix alone); 0 in hidden chats. Now: 0.
  it('a slash command redraws no hidden tab', async () => {
    const visible = app.visibleId();
    for (const value of ['/', '/a', '/ab', '/abc']) await app.type(value);
    expect(app.otherTabRenders(visible)).toEqual(zeros(visible));
  });
});

describe('eight tabs open: background events', () => {
  // Met by: chats read the artifact store through narrow selectors (not the
  // whole context), and TerminalView's memo.
  // Before (master): after the list refresh, 1 render in every other tab's
  // chat, plus 2 in each Claude Code tab's terminal (3 per Claude Code tab). Now: 0.
  it('a file written in a hidden tab redraws no other tab', async () => {
    const hidden = app.sessionIds[3];
    await app.writeFile(hidden, 'notes.md');
    await app.wait(3000); // the file list refresh is debounced
    // The event really reached the file list (else a zero proves nothing).
    expect(app.bridgeCalls).toContain('artifacts.listSession');
    expect(app.otherTabRenders(hidden)).toEqual(zeros(hidden));
  });

  it('terminal output for hidden tabs redraws nothing', async () => {
    const hiddenClaude = app.sessionIds.filter((_, i) => i % 2 === 0).slice(1);
    for (const id of hiddenClaude) for (let i = 0; i < 20; i++) app.ptyOutput(id, `line ${i} of ${id}\r\n`);
    await app.wait(500);
    // The bytes reached each hidden xterm (else a zero proves nothing).
    for (const id of hiddenClaude) expect(terminalWrites.join('')).toContain(`line 19 of ${id}`);
    expect(app.shellRenders()).toBe(0);
    expect(app.otherTabRenders()).toEqual(zeros());
  });

  // Met by: clocks read the on-screen context (state/on-screen-context.ts) and
  // stand still while their chat is hidden.
  // Before (master): 4 renders per hidden thinking tab per 10 s. Now: 0.
  it('hidden tabs that are thinking run no timer that redraws them', async () => {
    const hidden = [app.sessionIds[1], app.sessionIds[2]];
    for (const id of hidden) await app.beginReply(id);
    await app.wait(3000); // past the "just started" window
    app.resetCounts();
    await app.wait(10_000);
    expect(Object.fromEntries(hidden.map((id) => [id, app.chatRenders(id) + app.terminalRenders(id)])))
      .toEqual(Object.fromEntries(hidden.map((id) => [id, BUDGET.hiddenThinkingTabPer10s])));
  });
});

describe('eight tabs open: switching tabs', () => {
  // Met by: TerminalView's memo. A switch re-renders App (allowed), which
  // re-rendered every Claude Code terminal.
  // Before (master): 1 render in each uninvolved Claude Code terminal per switch. Now: 0.
  it('redraws only the tab left and the tab opened', async () => {
    const [first, , , , , sixth] = app.sessionIds;
    await app.switchTo(sixth);
    expect(app.otherTabRenders(first, sixth)).toEqual(zeros(first, sixth));
    app.resetCounts();
    await app.switchTo(first);
    expect(app.otherTabRenders(first, sixth)).toEqual(zeros(first, sixth));
  });
});

describe('eight tabs open: global listeners', () => {
  /** Listeners gained between one tab and eight, per event type, for `types`. */
  const growth = (keep: (type: string) => boolean) => {
    const one = app.listenersAfterOpening[0];
    const all = app.listenersAfterOpening[SESSIONS - 1];
    const out: Record<string, number> = {};
    for (const type of new Set([...Object.keys(one), ...Object.keys(all)])) {
      const d = (all[type] ?? 0) - (one[type] ?? 0);
      if (keep(type) && d > 0) out[type] = d;
    }
    return out;
  };
  const total = (g: Record<string, number>) => Object.values(g).reduce((a, b) => a + b, 0);
  const INPUT = new Set(['keydown', 'keyup', 'pointerdown']);

  // Met by: ChatView's window key/pointer listeners attach only while visible.
  // Before (master): +7 keyup, +7 pointerdown, +14 keydown for 7 more tabs.
  it('for keys and pointer do not grow with the number of tabs', () => {
    expect(total(growth((t) => INPUT.has(t)))).toBeLessThanOrEqual(BUDGET.listenersFor7MoreTabs);
  });

  // Met by: all terminals share ONE window 'resize' listener (TerminalView.tsx
  // onWindowResize); each used to add its own, hidden or not.
  // Before (master): +3 resize for 3 more Claude Code tabs. Now: 0.
  it('of every other kind do not grow with the number of tabs', () => {
    expect(total(growth((t) => !INPUT.has(t)))).toBeLessThanOrEqual(BUDGET.listenersFor7MoreTabs);
  });
});

// Controls: each proves a probe the budgets above rely on can see a render at
// all, so a zero above cannot be "passing" because the probe went blind.
describe('the probes see real work', () => {
  it('a reply streaming into the visible tab redraws that tab per word', async () => {
    const visible = app.visibleId();
    const reply = await app.beginReply(visible);
    await reply.words(WORDS);
    await reply.end();
    expect(app.chatRenders(visible)).toBeGreaterThanOrEqual(WORDS);
  });

  it('the visible thinking tab ticks its own timer', async () => {
    const visible = app.visibleId();
    await app.beginReply(visible);
    await app.wait(3000);
    app.resetCounts();
    await app.wait(10_000);
    expect(app.chatRenders(visible)).toBeGreaterThan(0);
  });

  it('switching tabs redraws both tabs involved and the shell', async () => {
    const [first, second] = app.sessionIds;
    await app.switchTo(second);
    expect(app.chatRenders(first)).toBeGreaterThan(0);
    expect(app.chatRenders(second)).toBeGreaterThan(0);
    expect(app.shellRenders()).toBeGreaterThan(0);
    expect(app.listenersAfterOpening).toHaveLength(SESSIONS);
  });
});
