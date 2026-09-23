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
// Tests marked `it.fails` are budgets master does NOT meet yet; each names the
// fix it waits on and what was observed. When that fix lands, flip it to `it`.
// (An `it.fails` also "passes" if the harness itself breaks — so the three
// plain `it` controls at the bottom prove the probes can see renders at all.)
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
  // Waits on: hidden terminals rendering. The turn starting flips "thinking",
  // which re-renders App once (allowed); SessionTerminal/TerminalView are not
  // memoised, so every Claude Code tab's terminal re-renders with it.
  // Observed on master: 2 renders (turn opened, turn ended) in each of the 3
  // other Claude Code tabs' terminals; 0 in every other tab's chat.
  it.fails('into a hidden tab redraws no other tab', async () => {
    const [visible, hidden] = app.sessionIds;
    const reply = await app.beginReply(hidden);
    await reply.words(WORDS / 2);
    await reply.tool();
    await reply.words(WORDS / 2);
    await reply.end();
    expect(app.otherTabRenders(hidden)).toEqual(zeros(hidden));
    expect(app.visibleId()).toBe(visible);
  });

  // NEW FINDING (no fix in flight as of 2026-09-23): ChatView reads its whole
  // session with useChatState(sessionId) whether or not it is visible, so a
  // hidden tab redraws its timeline once per streamed word.
  // Observed on master: 45 renders for a 40-word reply with one tool call.
  it.fails('into a hidden tab redraws that tab a few times, never once per word', async () => {
    const hidden = app.sessionIds[1];
    const reply = await app.beginReply(hidden);
    await reply.words(WORDS / 2);
    await reply.tool();
    await reply.words(WORDS / 2);
    await reply.end();
    expect(app.chatRenders(hidden) + app.terminalRenders(hidden)).toBeLessThanOrEqual(BUDGET.hiddenTabWholeReply);
  });

  // Waits on: hidden terminals rendering (same cause as the first test).
  // Observed on master: 2 renders in each of the 3 hidden Claude Code terminals.
  it.fails('into the visible tab redraws no hidden tab', async () => {
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

  // Waits on: slash typing re-rendering App. Each character after "/" changes
  // App state for the command drawer's filter.
  // Observed on master: "/" → 0 shell renders, then 1 per character (3 for "/a", "/ab", "/abc").
  it.fails('a slash command does not redraw the shell', async () => {
    await app.type('/');
    app.resetCounts();
    for (const value of ['/a', '/ab', '/abc']) await app.type(value);
    expect(app.shellRenders()).toBe(BUDGET.shellPerSlashKeystroke * 3);
  });

  // Waits on: slash typing re-rendering App AND hidden terminals rendering —
  // either fix alone should make this pass (the App render is what reaches
  // the hidden terminals).
  // Observed on master: 5 renders in each hidden Claude Code terminal for
  // typing "/" through "/abc"; 0 in hidden chats.
  it.fails('a slash command redraws no hidden tab', async () => {
    const visible = app.visibleId();
    for (const value of ['/', '/a', '/ab', '/abc']) await app.type(value);
    expect(app.otherTabRenders(visible)).toEqual(zeros(visible));
  });
});

describe('eight tabs open: background events', () => {
  // Waits on: ArtifactContext redrawing all tabs on any file change (and hidden
  // terminals rendering). The file list lives in App's artifact state, and every
  // tab's chat reads that context.
  // Observed on master: after the list refresh, 1 render in every other tab's
  // chat, plus 2 in each Claude Code tab's terminal (3 per Claude Code tab).
  it.fails('a file written in a hidden tab redraws no other tab', async () => {
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

  // Waits on: ThinkingIndicator timers in hidden tabs. The indicator rotates
  // its word every 2.5 s with a setInterval, mounted or not visible.
  // Observed on master: 4 renders per hidden thinking tab per 10 s.
  it.fails('hidden tabs that are thinking run no timer that redraws them', async () => {
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
  // Waits on: hidden terminals rendering. A switch re-renders App (allowed),
  // which re-renders every Claude Code terminal.
  // Observed on master: 1 render in each uninvolved Claude Code terminal per switch.
  it.fails('redraws only the tab left and the tab opened', async () => {
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

  // Waits on: per-session window listeners in ChatView (capture-phase keydown,
  // keyup and pointerdown on window, added by every mounted ChatView).
  // Observed on master: +7 keyup, +7 pointerdown, +14 keydown for 7 more tabs.
  it.fails('for keys and pointer do not grow with the number of tabs', () => {
    expect(total(growth((t) => INPUT.has(t)))).toBeLessThanOrEqual(BUDGET.listenersFor7MoreTabs);
  });

  // NEW FINDING (no fix in flight as of 2026-09-23): every mounted
  // TerminalView adds its own window 'resize' listener (TerminalView.tsx
  // fitAndSync), hidden or not — one per Claude Code tab.
  // Observed on master: +3 resize for 3 more Claude Code tabs.
  it.fails('of every other kind do not grow with the number of tabs', () => {
    expect(total(growth((t) => !INPUT.has(t)))).toBeLessThanOrEqual(BUDGET.listenersFor7MoreTabs);
  });
});

// Controls: each proves a probe the budgets above rely on can see a render at
// all, so an `it.fails` above cannot be "passing" because the probe went blind.
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
