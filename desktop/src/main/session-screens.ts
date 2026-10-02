// session-screens.ts — the computer's own copy of each running Claude Code terminal, read for two things (one-core R5-4b, seam S5).
//
//   1. "MAY BE STUCK": while a turn runs with nothing else to explain the quiet (no tool running, nothing waiting on the person), the screen's
//      spinner and seconds counter say whether Claude Code is alive (shared/stuck-tracker.ts). The computer is the ONLY writer of this reading.
//   2. CARDS: a question Claude Code asks in its terminal (usage limit, trust folder, resume, ...) becomes a card (shared/prompt-card-rules.ts).
//   3. WHAT HOLDS THE KEYBOARD (sync with master's popups work, 2026-10-01): whether a pop-up (or a mode like history search) has taken the keyboard from
//      Claude Code's message box (shared/cc-input-focus.ts). Published to every screen, whose chat-send gates refuse a message typed into it ("Switch
//      model?" after a mid-conversation /model is the case that lost Destin a send), and handed to the session manager, which holds back its own automated
//      writes (/reload-plugins) while it is true. ONE reader: before, each window read its own terminal, so a phone had no gate at all.
//
// WHY here (2026-10-01, Destin approved "the computer runs it"): both used to be worked out by each WINDOW from its own xterm. A phone with no
// computer window open (closed, hidden, reloading) got neither: no stuck banner, no setup card, a dot that never turned red. Main already
// relays every terminal byte, so it keeps a headless xterm (the same engine the window uses) and reads the same screen the same way
// (shared/terminal-screen-text.ts). Everything it finds leaves through SessionLiveFacts, as numbered events every screen draws.
//
// COST (measured, scratchpad r54b-bench): every live Claude Code session keeps ONE terminal from its start to its end, with a small scrollback. It
// does work only when bytes arrive (a write is parsed when it is written), so an idle session costs memory and no CPU. (Review fix, R5-4b: the first
// version made a terminal only while a turn ran or a chunk "looked like a dialog"; Claude Code positions words with cursor moves, so no real chunk
// ever looked like one and a dialog in an idle session was missed. Nothing is guessed from bytes any more.) The terminal sees the session's output
// from its first byte, so it never has to be seeded from the middle of a stream (a cut stream leaves stale rows behind Claude Code's erase-up redraws).
//
// Electron-free and injected, like session-live.ts: tests drive it with a real record and a fake terminal or the real @xterm/headless.
import { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { SessionRecords } from './session-record';
import type { SessionLiveFacts } from './session-live';
import { screenTextOf, visibleScreenTextOf, type ScreenBuffer } from '../shared/terminal-screen-text';
import { StuckTracker, STUCK_TICK_MS, STUCK_TAIL_ROWS } from '../shared/stuck-tracker';
import { PromptCardReader } from '../shared/prompt-card-reader';
import { readInputFocus, inputIsBlocked, type InputBlock } from '../shared/cc-input-focus';

/** Rows of history the headless copy keeps. The check reads 40 rows and the card reader the visible screen, so 60 is plenty (1,000 cost 4x the memory). */
const SCREEN_SCROLLBACK_ROWS = 60;
/** The card reader looks at most this often. The window's reader looked on every flush (up to 60 a second); a menu is a human-speed thing. */
const SCAN_MS = 100;
/** The size a terminal has until a window reports its real one. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** The slice of an xterm terminal this uses (so a test can pass a fake). */
export interface ScreenTerminal {
  readonly rows: number;
  readonly buffer: { readonly active: ScreenBuffer };
  write(data: string, callback?: () => void): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
}

export interface SessionScreensDeps {
  records: Pick<SessionRecords, 'screenNeed'>;
  live: Pick<SessionLiveFacts, 'attention' | 'showPrompt' | 'dismissPrompt' | 'inputBlock'>;
  /** A Claude Code session (not native, not a shell)? */
  isClaude(sessionId: string): boolean;
  /** The terminal's current size, when main knows it. */
  size?(sessionId: string): { cols: number; rows: number } | null;
  /** Told when the computer's reading of "stuck" changes (so the status relay and the tray follow). */
  onAttention?(sessionId: string, state: 'ok' | 'stuck'): void;
  /** Told when a pop-up starts or stops holding the session's keyboard (the session manager gates its own automated writes on it). */
  onInputBlocked?(sessionId: string, blocked: boolean): void;
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
  /** Writes handed to THIS terminal that have not finished parsing (reset with each new terminal, so a late callback of a disposed one cannot touch it). */
  pending: number;
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
  /** What the computer last said holds this session's keyboard (null = the message box), as a key so a redraw of the same pop-up says nothing. */
  inputKey: string;
}

const fresh = (): PerSession => ({
  term: null, pending: 0, scanTimer: null, tracker: null, tickTimer: null, tickWhenReady: false,
  stuckShown: false, reader: null, answeredId: null, lastAskClearedAt: 0, wasAsking: false, inputKey: '',
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

  /** One chunk of a session's terminal output, fed to the session's terminal (made here if the session has none yet). */
  noteOutput(sessionId: string, data: string): void {
    if (!data || !this.deps.isClaude(sessionId)) return;
    let s = this.per.get(sessionId);
    if (!s?.term) {
      if (!this.deps.records.screenNeed(sessionId)) return; // no record: the session is over
      s = this.state(sessionId);
      this.ensure(sessionId, s);
    }
    this.write(sessionId, s, data);
  }

  private write(sessionId: string, s: PerSession, data: string): void {
    const term = s.term;
    if (!term) return;
    s.pending++;
    term.write(data, () => {
      // A callback from a terminal that has since been disposed (the session record was recreated) must not touch the one that replaced it.
      if (s.term !== term) return;
      s.pending--;
      if (s.pending > 0) return;
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

  /** Make this session's terminal if it has none. It lives until the session ends. */
  private ensure(sessionId: string, s: PerSession): void {
    if (s.term) return;
    const size = this.deps.size?.(sessionId) ?? this.sizes.get(sessionId) ?? { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
    s.term = this.deps.createTerminal ? this.deps.createTerminal(size.cols, size.rows) : realTerminal(size.cols, size.rows);
    s.pending = 0;
    s.reader = new PromptCardReader({
      readScreen: () => { try { return s.term ? visibleScreenTextOf(s.term.buffer.active, s.term.rows) : null; } catch { return null; } },
      need: () => { const n = this.deps.records.screenNeed(sessionId); return n ? { asking: n.asking, started: n.started, permissionCard: n.permissionCard } : null; },
      askClearedAt: () => s.lastAskClearedAt,
      isAnswered: (id) => s.answeredId === id,
      show: (card) => this.deps.live.showPrompt(sessionId, card),
      dismiss: (id) => { s.answeredId = null; this.deps.live.dismissPrompt(sessionId, id); },
      now: this.now,
      setTimer: (fn, ms) => this.setTimer(fn, ms),
      clearTimer: (h) => this.clearTimer(h),
    });
  }

  private dispose(sessionId: string, s: PerSession): void {
    this.clearTimer(s.scanTimer); s.scanTimer = null;
    s.reader?.dispose(); s.reader = null; s.answeredId = null;
    this.stopTicks(sessionId, s);
    const t = s.term;
    s.term = null; s.tracker = null; s.pending = 0; s.tickWhenReady = false;
    try { t?.dispose(); } catch { /* already gone */ }
  }

  /** The session is over (or the app is closing): its terminal goes. */
  forget(sessionId: string): void {
    const s = this.per.get(sessionId);
    if (s) { this.dispose(sessionId, s); this.per.delete(sessionId); }
    this.sizes.delete(sessionId);
  }

  /** Quit teardown. */
  stop(): void { for (const id of [...this.per.keys()]) this.forget(id); }

  /**
   * What the record says a session needs has changed (SessionRecords.onScreenNeedChange): a session began, a turn began or ended, a tool started or
   * finished, an ask opened or closed, Claude Code started, a card opened or closed. Makes sure the session has its terminal and decides whether the
   * stuck check runs.
   */
  refresh(sessionId: string): void {
    const need = this.deps.records.screenNeed(sessionId);
    if (!need || !this.deps.isClaude(sessionId)) { this.forget(sessionId); return; }
    const s = this.state(sessionId);
    this.ensure(sessionId, s);

    // The post-permission cooldown: remember when the last live ask closed.
    if (s.wasAsking && !need.asking) s.lastAskClearedAt = this.now();
    s.wasAsking = need.asking;
    this.scheduleScan(sessionId, s);

    // The stuck check runs only while the turn is "thinking": nothing running, nothing waiting on the person (the window's gate, unchanged).
    const gate = need.working && !need.toolRunning && !need.asking;
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
    if (!s) return;
    s.reader?.scan();
    this.scanInputFocus(sessionId, s);
  }

  /**
   * Is Claude Code's message box live, or does something else hold the keyboard? Read on the same 10 Hz scan as the cards, from the same visible
   * screen, and published only when the answer changes. No readable screen is no verdict (the box is assumed live: no new refusal), as in the window.
   * Latency: a pop-up that opens is known to every screen within one scan (about 0.1 s) plus the round trip, where the window's own read was instant;
   * a person cannot type and press Enter into it faster than that.
   */
  private scanInputFocus(sessionId: string, s: PerSession): void {
    if (!s.term) return;
    let screen: string | null = null;
    try { screen = visibleScreenTextOf(s.term.buffer.active, s.term.rows); } catch { return; }
    const focus = readInputFocus(screen);
    const block: InputBlock | null = inputIsBlocked(focus) ? (focus as InputBlock) : null;
    const key = block ? (block.kind === 'other-view' ? `other-view:${block.view}` : 'popup') : '';
    if (key === s.inputKey) return;
    s.inputKey = key;
    this.deps.live.inputBlock(sessionId, block);
    this.deps.onInputBlocked?.(sessionId, block !== null);
  }
}

/** The real thing: @xterm/headless, with the same width table the window's terminal uses (so a wrapped line breaks in the same place). */
function realTerminal(cols: number, rows: number): ScreenTerminal {
  const term = new Terminal({ cols, rows, scrollback: SCREEN_SCROLLBACK_ROWS, allowProposedApi: true });
  const unicode11 = new Unicode11Addon();
  term.loadAddon(unicode11 as never);
  term.unicode.activeVersion = '11';
  return term as unknown as ScreenTerminal;
}
