// session-screens.ts — the computer's own copy of each running Claude Code terminal, read for two things (one-core R5-4b, seam S5).
//
//   1. "MAY BE STUCK": while a turn runs with nothing else to explain the quiet (no tool running, nothing waiting on the person), the screen's
//      spinner and seconds counter say whether Claude Code is alive (shared/stuck-tracker.ts). The computer is the ONLY writer of this reading.
//   2. CARDS: a question Claude Code asks in its terminal (usage limit, trust folder, resume, ...) becomes a card (shared/prompt-card-rules.ts).
//
// WHY here (2026-10-01, Destin approved "the computer runs it"): both used to be worked out by each WINDOW from its own xterm. A phone with no
// computer window open (closed, hidden, reloading) got neither: no stuck banner, no setup card, a dot that never turned red. Main already
// relays every terminal byte, so it keeps a headless xterm (the same engine the window uses) and reads the same screen the same way
// (shared/terminal-screen-text.ts). Everything it finds leaves through SessionLiveFacts, as numbered events every screen draws.
//
// COST (measured, scratchpad r5-4b-cpu): a terminal exists ONLY while it is wanted — a turn is running, the session has not yet started (its
// startup dialogs), a card is open, or an idle chunk looked like a dialog — is seeded from the last 256K units of the record's terminal stream, keeps
// 60 rows of scrollback, and is disposed a few seconds after nothing wants it. An idle session has no terminal at all (tests/session-screens.test.ts).
//
// Electron-free and injected, like session-live.ts: tests drive it with a real record and a fake terminal or the real @xterm/headless.
import { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { SessionRecords } from './session-record';
import type { SessionLiveFacts } from './session-live';
import { screenTextOf, visibleScreenTextOf, type ScreenBuffer } from '../shared/terminal-screen-text';
import { StuckTracker, STUCK_TICK_MS, STUCK_TAIL_ROWS } from '../shared/stuck-tracker';
import { PromptCardReader } from '../shared/prompt-card-reader';

/** How much of the record's terminal stream a new headless terminal is fed first (UTF-16 units; about 4 ms of parsing). */
const SEED_UNITS = 256 * 1024;
/** Rows of history the headless copy keeps. The check reads 40 rows and the card reader the visible screen, so 60 is plenty (1,000 cost 4x the memory). */
const SCREEN_SCROLLBACK_ROWS = 60;
/** The card reader looks at most this often. The window's reader looked on every flush (up to 60 a second); a menu is a human-speed thing. */
const SCAN_MS = 100;
/** A terminal nothing wants any more is kept this long before it is disposed (a dialog right after a turn's end is still caught). */
const IDLE_DISPOSE_MS = 3000;
/** The size a terminal has until a window reports its real one. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** What an idle chunk must contain for the computer to start reading the screen: Claude Code's dialog footer, or a numbered select row. */
const DIALOG_HINT = /enter to confirm|esc to (?:cancel|exit|reject)|space to select|[❯>]\s*1[.:]\s/i;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** The slice of an xterm terminal this uses (so a test can pass a fake). */
export interface ScreenTerminal {
  readonly rows: number;
  readonly buffer: { readonly active: ScreenBuffer };
  write(data: string, callback?: () => void): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
}

export interface SessionScreensDeps {
  records: Pick<SessionRecords, 'screenNeed' | 'ptyTail'>;
  live: Pick<SessionLiveFacts, 'attention' | 'showPrompt' | 'dismissPrompt'>;
  /** A Claude Code session (not native, not a shell)? */
  isClaude(sessionId: string): boolean;
  /** The terminal's current size, when main knows it. */
  size?(sessionId: string): { cols: number; rows: number } | null;
  /** Told when the computer's reading of "stuck" changes (so the status relay and the tray follow). */
  onAttention?(sessionId: string, state: 'ok' | 'stuck'): void;
  now?: () => number;
  /** Timers are injectable so a test does not wait seconds. */
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  setRepeat?(fn: () => void, ms: number): unknown;
  clearRepeat?(handle: unknown): void;
  /** The terminal factory; the real one is @xterm/headless. */
  createTerminal?(cols: number, rows: number): ScreenTerminal;
}

interface PerSession {
  term: ScreenTerminal | null;
  /** Stream position (record units) the terminal has been fed up to; a chunk that ends at or before it is already in there. */
  fedEnd: number;
  /** Writes handed to the terminal that have not finished parsing. */
  pending: number;
  /** An idle chunk looked like a dialog: keep reading until the menu is resolved. */
  dialogHint: boolean;
  disposeTimer: unknown | null;
  scanTimer: unknown | null;
  /** The stuck check, while its gate is open. */
  tracker: StuckTracker | null;
  tickTimer: unknown | null;
  tickWhenReady: boolean;
  /** What the computer last said about "stuck" for this session. */
  stuckShown: boolean;
  /** Reads this terminal's menus into cards (shared/prompt-card-reader.ts: the same decisions the Android app's renderer makes). */
  reader: PromptCardReader | null;
  /** The card whose menu was answered by navigation (an Enter went into the terminal while it was up). */
  answeredId: string | null;
  /** Live asks: when the last one closed (the post-permission cooldown) and whether one was open at the last look. */
  lastAskClearedAt: number;
  wasAsking: boolean;
}

const fresh = (): PerSession => ({
  term: null, fedEnd: 0, pending: 0, dialogHint: false, disposeTimer: null, scanTimer: null, tracker: null, tickTimer: null, tickWhenReady: false,
  stuckShown: false, reader: null, answeredId: null, lastAskClearedAt: 0, wasAsking: false,
});

export class SessionScreens {
  private readonly per = new Map<string, PerSession>();
  private readonly now: () => number;
  private readonly sizes = new Map<string, { cols: number; rows: number }>();

  constructor(private readonly deps: SessionScreensDeps) {
    this.now = deps.now ?? Date.now;
  }

  private setTimer(fn: () => void, ms: number): unknown {
    if (this.deps.setTimer) return this.deps.setTimer(fn, ms);
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  }
  private clearTimer(h: unknown): void {
    if (h === null || h === undefined) return;
    if (this.deps.clearTimer) this.deps.clearTimer(h); else clearTimeout(h as NodeJS.Timeout);
  }
  private setRepeat(fn: () => void, ms: number): unknown {
    if (this.deps.setRepeat) return this.deps.setRepeat(fn, ms);
    const t = setInterval(fn, ms);
    t.unref?.();
    return t;
  }
  private clearRepeat(h: unknown): void {
    if (h === null || h === undefined) return;
    if (this.deps.clearRepeat) this.deps.clearRepeat(h); else clearInterval(h as NodeJS.Timeout);
  }

  private state(sessionId: string): PerSession {
    let s = this.per.get(sessionId);
    if (!s) { s = fresh(); this.per.set(sessionId, s); }
    return s;
  }

  /** How many terminals exist right now (the idle test and the memory number read this). */
  terminalCount(): number {
    let n = 0;
    for (const s of this.per.values()) if (s.term) n++;
    return n;
  }
  hasTerminal(sessionId: string): boolean { return !!this.per.get(sessionId)?.term; }

  // ------------------------------------------------------------------------------------------------------------------------------------
  // Feeding
  // ------------------------------------------------------------------------------------------------------------------------------------

  /**
   * One chunk of a session's terminal output. `at` is where the record put it in the terminal stream (the record notes the chunk BEFORE this runs, so
   * a terminal created by this very chunk is seeded with it and must not be fed it twice).
   */
  noteOutput(sessionId: string, data: string, at?: { offset: number } | null): void {
    if (!data || !this.deps.isClaude(sessionId)) return;
    const s = this.per.get(sessionId);
    if (s?.term) { this.feed(sessionId, s, data, at); return; }
    // No terminal: only a chunk that looks like a dialog (or a session that wants one anyway) starts reading.
    const hint = DIALOG_HINT.test(data.replace(ANSI, ''));
    const need = this.deps.records.screenNeed(sessionId);
    if (!need) return;
    if (!hint && !(need.working || !need.started || need.cards > 0)) return;
    const st = this.state(sessionId);
    if (hint) st.dialogHint = true;
    this.ensure(sessionId, st);
    this.feed(sessionId, st, data, at);
  }

  private feed(sessionId: string, s: PerSession, data: string, at?: { offset: number } | null): void {
    let chunk = data;
    if (at) {
      const end = at.offset + data.length;
      if (end <= s.fedEnd) return; // already in the seed
      if (at.offset < s.fedEnd) chunk = data.slice(s.fedEnd - at.offset);
      s.fedEnd = end;
    }
    this.write(sessionId, s, chunk);
  }

  private write(sessionId: string, s: PerSession, data: string): void {
    if (!s.term) return;
    s.pending++;
    s.term.write(data, () => {
      s.pending--;
      if (s.pending > 0 || !s.term) return;
      if (s.tickWhenReady) { s.tickWhenReady = false; this.tick(sessionId); }
    });
    this.scheduleScan(sessionId, s);
  }

  /** A window changed the terminal's size: the headless copy follows (it lays text out at the same width). */
  noteResize(sessionId: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 || cols > 1000 || rows > 1000) return;
    this.sizes.set(sessionId, { cols, rows });
    const s = this.per.get(sessionId);
    if (s?.term) { try { s.term.resize(cols, rows); } catch { /* disposed */ } }
  }

  /** Something was typed into the session's terminal. An Enter while a navigated card is up is its answer (see the reissue rule). */
  noteInput(sessionId: string, text: string): void {
    const s = this.per.get(sessionId);
    if (!s?.reader?.shownNavigatedCard) return;
    if (typeof text === 'string' && text.includes('\r')) s.answeredId = s.reader.shownCardId;
  }

  // ------------------------------------------------------------------------------------------------------------------------------------
  // Lifetime
  // ------------------------------------------------------------------------------------------------------------------------------------

  /** Make this session's terminal if it has none, seeded from the record's terminal stream. */
  private ensure(sessionId: string, s: PerSession): void {
    this.clearTimer(s.disposeTimer); s.disposeTimer = null;
    if (s.term) return;
    const size = this.deps.size?.(sessionId) ?? this.sizes.get(sessionId) ?? { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
    s.term = this.deps.createTerminal ? this.deps.createTerminal(size.cols, size.rows) : realTerminal(size.cols, size.rows);
    s.fedEnd = 0;
    s.reader = new PromptCardReader({
      readScreen: () => { try { return s.term ? visibleScreenTextOf(s.term.buffer.active, s.term.rows) : null; } catch { return null; } },
      need: () => { const n = this.deps.records.screenNeed(sessionId); return n ? { asking: n.asking, started: n.started } : null; },
      askClearedAt: () => s.lastAskClearedAt,
      isAnswered: (id) => s.answeredId === id,
      show: (card) => this.deps.live.showPrompt(sessionId, card),
      dismiss: (id) => { s.answeredId = null; this.deps.live.dismissPrompt(sessionId, id); this.afterDismiss(sessionId); },
      now: this.now,
      setTimer: (fn, ms) => this.setTimer(fn, ms),
      clearTimer: (h) => this.clearTimer(h),
    });
    const tail = this.deps.records.ptyTail(sessionId, SEED_UNITS);
    if (tail) { s.fedEnd = tail.end; if (tail.data) this.write(sessionId, s, tail.data); }
  }

  private dispose(sessionId: string, s: PerSession): void {
    this.clearTimer(s.disposeTimer); s.disposeTimer = null;
    this.clearTimer(s.scanTimer); s.scanTimer = null;
    s.reader?.dispose(); s.reader = null; s.answeredId = null;
    this.stopTicks(sessionId, s);
    const t = s.term;
    s.term = null; s.tracker = null; s.dialogHint = false; s.pending = 0; s.tickWhenReady = false;
    try { t?.dispose(); } catch { /* already gone */ }
  }

  /** The session is over (or the app is closing): nothing left to read. */
  forget(sessionId: string): void {
    const s = this.per.get(sessionId);
    if (s) { this.dispose(sessionId, s); this.per.delete(sessionId); }
    this.sizes.delete(sessionId);
  }

  /** Quit teardown. */
  stop(): void { for (const id of [...this.per.keys()]) this.forget(id); }

  /**
   * What the record says a session needs has changed (SessionRecords.onScreenNeedChange): a turn began or ended, a tool started or finished, an ask
   * opened or closed, Claude Code started, a card opened or closed. Decides whether a terminal should exist and whether the stuck check runs.
   */
  refresh(sessionId: string): void {
    const need = this.deps.records.screenNeed(sessionId);
    if (!need || !this.deps.isClaude(sessionId)) { this.forget(sessionId); return; }
    const s = this.state(sessionId);

    // The post-permission cooldown: remember when the last live ask closed.
    if (s.wasAsking && !need.asking) s.lastAskClearedAt = this.now();
    s.wasAsking = need.asking;

    const busy = !!s.reader?.busy;
    const wanted = need.working || !need.started || need.cards > 0 || s.dialogHint || busy;
    if (wanted) {
      this.ensure(sessionId, s);
      this.scheduleScan(sessionId, s);
    } else if (s.term && s.disposeTimer === null) {
      s.disposeTimer = this.setTimer(() => {
        s.disposeTimer = null;
        const n = this.deps.records.screenNeed(sessionId);
        const still = !!n && (n.working || !n.started || n.cards > 0 || s.dialogHint || !!s.reader?.busy);
        if (!still) this.dispose(sessionId, s);
      }, IDLE_DISPOSE_MS);
    }

    // The stuck check runs only while the turn is "thinking": nothing running, nothing waiting on the person (the window's gate, unchanged).
    const gate = !!s.term && need.working && !need.toolRunning && !need.asking;
    if (gate && s.tickTimer === null) this.startTicks(sessionId, s);
    else if (!gate && s.tickTimer !== null) this.stopTicks(sessionId, s);
    else if (!gate && s.stuckShown) this.clearStuck(sessionId, s);
  }

  // ------------------------------------------------------------------------------------------------------------------------------------
  // The stuck check
  // ------------------------------------------------------------------------------------------------------------------------------------

  private startTicks(sessionId: string, s: PerSession): void {
    s.tracker = new StuckTracker(this.now());
    s.tickTimer = this.setRepeat(() => this.tick(sessionId), STUCK_TICK_MS);
    // Once immediately, so a short-lived stuck state surfaces inside a second (after the seed has been parsed).
    if (s.pending > 0) s.tickWhenReady = true; else this.tick(sessionId);
  }

  private stopTicks(sessionId: string, s: PerSession): void {
    this.clearRepeat(s.tickTimer); s.tickTimer = null; s.tracker = null; s.tickWhenReady = false;
    if (s.stuckShown) this.clearStuck(sessionId, s);
  }

  /** The turn ended or something explains the quiet: take back "stuck" so no screen keeps a stale banner. */
  private clearStuck(sessionId: string, s: PerSession): void {
    s.stuckShown = false;
    this.deps.live.attention(sessionId, 'ok');
    this.deps.onAttention?.(sessionId, 'ok');
  }

  private tick(sessionId: string): void {
    const s = this.per.get(sessionId);
    if (!s?.term || !s.tracker) return;
    let text: string;
    try { text = screenTextOf(s.term.buffer.active, STUCK_TAIL_ROWS); } catch { return; }
    const { state, show } = s.tracker.tick(text.split('\n'), this.now());
    const stuck = state === 'stuck';
    if (show && stuck !== s.stuckShown) {
      s.stuckShown = stuck;
      this.deps.live.attention(sessionId, state);
      this.deps.onAttention?.(sessionId, state);
    }
  }

  // ------------------------------------------------------------------------------------------------------------------------------------
  // Cards (the window's usePromptDetector, ported: same menus, same timings, same re-issue rule)
  // ------------------------------------------------------------------------------------------------------------------------------------

  private scheduleScan(sessionId: string, s: PerSession): void {
    if (s.scanTimer !== null) return;
    s.scanTimer = this.setTimer(() => { s.scanTimer = null; this.scan(sessionId); }, SCAN_MS);
  }

  private scan(sessionId: string): void {
    const s = this.per.get(sessionId);
    if (!s?.term || !s.reader) return;
    s.reader.scan();
    // Nothing on screen needs reading: a terminal kept only for a dialog hint can go.
    if (!s.reader.busy) {
      if (s.dialogHint) s.dialogHint = false;
      this.refresh(sessionId);
    }
  }

  /** A card came down: a terminal nothing wants any more can go. */
  private afterDismiss(sessionId: string): void { this.refresh(sessionId); }
}

/** The real thing: @xterm/headless, with the same width table the window's terminal uses (so a wrapped line breaks in the same place). */
function realTerminal(cols: number, rows: number): ScreenTerminal {
  const term = new Terminal({ cols, rows, scrollback: SCREEN_SCROLLBACK_ROWS, allowProposedApi: true });
  const unicode11 = new Unicode11Addon();
  term.loadAddon(unicode11 as never);
  term.unicode.activeVersion = '11';
  return term as unknown as ScreenTerminal;
}
