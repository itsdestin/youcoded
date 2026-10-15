// BrowserService — the ONE owner of the assistant's Browser
// (spec docs/active/specs/2026-10-13-assistant-browser-design.md §2).
//
// Runs inside the Browser's utilityProcess (browser-host.ts), never on the
// Electron main thread: CDP traffic, page outlines and Playwright's own state
// machine are real CPU, and main serves every window (performance rule 1,
// design review 1 #6). Electron-free on purpose, so vitest drives it against a
// real browser.
//
// Shape:
// - ONE browser context (a persistent profile, or the person's own Chrome),
//   shared by every conversation; each conversation OWNS its tabs. Tools only
//   ever see their own conversation's tabs. Popups join their opener.
// - Starts lazily on first use. A conversation's tabs close 30 min after its
//   last browser call; the browser closes 5 min after its last tab; stop() and
//   app quit close it.
// - Show/hide window is app-wide (one process cannot be both): restart() waits
//   briefly for in-flight calls, reopens every tab by address, and bumps
//   adds a note to each conversation's next result that element refs went stale.
// - Asks to the person (site permission, final step, sign-in hand-off, …) are
//   PROMPTS owned here, drawn as a card by the screen, answered over IPC. One
//   prompt per conversation at a time.
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type { Browser, BrowserContext, CDPSession, Page, chromium as ChromiumType } from 'playwright-core';
import type { FoundBrowser } from '../../shared/browser-types';
import { normalUserAgent, readBrowserVersion } from './browser-version';

const SESSION_IDLE_MS = 30 * 60_000;
const BROWSER_IDLE_MS = 5 * 60_000;
/** Bounded wait for in-flight calls before a restart proceeds anyway. */
const RESTART_DRAIN_MS = 10_000;
/** A hidden browser renders a common laptop-sized page so sites serve desktop
 *  layouts — until a Browser panel reports its size (setViewSize). */
const BACKGROUND_VIEWPORT = { width: 1280, height: 800 } as const;
/** The hidden browser's pixel density when the app names none (tests). The app
 *  passes its screens' own (`pixelRatio`), so the picture is as sharp as the
 *  screen. Only pictures get denser — the assistant's screenshots stay page-sized
 *  (`scale: 'css'` in browser-tool-runners.ts). */
const HIDDEN_PIXEL_RATIO = 2;
/** Bounds for a panel-fitted page (CSS px). Below 320 wide no site is usable.
 *  WHY 2560 wide (was 1280, Destin 2026-10-14): an expanded panel on a big
 *  screen showed the page with empty bands either side, unlike any browser. */
const VIEW_MIN = 320;
/** The page width (CSS px) a panel shows by default. WHY (Destin, 2026-10-15):
 *  laid out at the panel's own ~460 px, sites sent phone layouts (menus behind
 *  ☰, sidebars gone) and the assistant's screenshots were small. A laptop-wide
 *  page shrunk to fit the panel keeps desktop layouts, like Ctrl+minus. */
const AUTO_PAGE_WIDTH = 1024;
/** The furthest a page can be zoomed out; below this nothing is readable. */
const ZOOM_MIN = 0.25;
const VIEW_MAX_W = 2560;
const VIEW_MAX_H = 2000;
/** The live picture's largest size in screen pixels. It bounds the cost of a
 *  full-screen panel on a dense screen; anything bigger is scaled down to fit. */
const PICTURE_MAX = 2560;
/** Files kept per conversation's download folder. */
const MAX_DOWNLOADS = 20;
/** Picture rate cap while the person only watches; each frame also waits for
 *  the screen's ack. */
const MIN_FRAME_GAP_MS = 100;
/** After the person clicks, scrolls or types on the picture, frames go out as
 *  fast as the screen acks them (no gap) for this long. WHY (measured
 *  2026-10-13, dev app): with the 100 ms gap the picture managed ~8 frames/s
 *  and trailed the person's hands; with none, ~26/s from the browser alone.
 *  Watching the assistant keeps the gap, so an idle panel stays cheap. */
const PERSON_FAST_MS = 3000;

import type { BrowserFrame, BrowserInputEvent, BrowserPrompt, BrowserRunState, BrowserSessionState, PromptAnswer } from '../../shared/browser-types';
export type { BrowserPrompt, BrowserSessionState, PromptAnswer, BrowserRunState } from '../../shared/browser-types';
export type FrameEvent = BrowserFrame;

interface LaunchConfig {
  showWindow: boolean;
  myChrome: boolean;
  browser: FoundBrowser | null;
}

export interface BrowserServiceOptions {
  /** userData/assistant-browser — profile, shots, downloads live under it. */
  rootDir: string;
  chromium: typeof ChromiumType;
  /** Read at every (re)start. */
  getLaunchConfig: () => Promise<LaunchConfig>;
  /** The person's own Chrome endpoint (browser-my-chrome.ts). */
  findMyChrome?: () => Promise<{ wsEndpoint: string } | { error: string }>;
  log?: (level: 'INFO' | 'WARN' | 'ERROR', msg: string, data?: Record<string, unknown>) => void;
  platform?: NodeJS.Platform;
  /** Decides whether a page or embedded page may load an address (home network /
   *  metadata, browser-tool-runners.ts navigationVerdict). `sessionId` is null for
   *  a tab no conversation owns yet. */
  requestGuard?: (sessionId: string | null, url: string) => Promise<'allow' | 'block'>;
  /** My Chrome only: guard one of the assistant's tabs (CDP, per tab — a
   *  browser-wide route there would also touch the person's own tabs). Awaited
   *  before the tab loads anything. */
  guardPage?: (sessionId: string, page: Page) => Promise<void>;
  /** The person closed the shown window: record "hidden" as their choice
   *  (closing the window means hide it, never stop the browser). */
  onWindowClosedByPerson?: () => Promise<void>;
  /** Test seams. */
  sessionIdleMs?: number;
  browserIdleMs?: number;
  forceHeadless?: boolean;
  /** The screens' pixel density (1–2): the hidden browser draws at it. */
  pixelRatio?: number;
}

/** A refusal the tools turn into a plain error result (not a crash). */
export class BrowserUnavailableError extends Error {
  constructor(message: string, readonly code: 'no-browser' | 'start-failed' | 'my-chrome' | 'other' = 'other') { super(message); }
}

/** Which answers each kind of card offers (BrowserAskCard.tsx). */
const ANSWERS_BY_KIND: Record<BrowserPrompt['kind'], readonly PromptAnswer[]> = {
  site: ['allow_chat', 'allow_always', 'no'],
  final: ['once', 'no'],
  local: ['allow_chat', 'no'],
  handoff: ['done', 'cant'],
  'no-browser': ['download', 'no'],
};

interface SessionEntry {
  pages: Page[];
  active: Page | null;
  used: boolean;
  busy: number;
  prompt: BrowserPrompt | null;
  promptResolve: ((answer: PromptAnswer | 'cancelled' | 'timeout') => void) | null;
  /** Short notes for the NEXT tool result: downloads, dialogs, new tabs, restarts. */
  notes: string[];
  /** Addresses to report/reopen after the browser closed under the conversation. */
  lastUrls: string[];
  queue: Promise<unknown>;
  idleTimer: NodeJS.Timeout | null;
  /** The Browser panel's picture area (CSS px), when a panel has reported one. */
  viewSize: { width: number; height: number } | null;
  /** The page zoom someone picked (0.25–1), or null for the default (zoomOf). */
  zoom: number | null;
  /** The person's clicks and keys, run in order. */
  inputChain: Promise<unknown>;
  /** The scroll waiting its turn in `inputChain`; later scroll steps merge into it. */
  wheelPending: { type: 'wheel'; x: number; y: number; dx: number; dy: number } | null;
  /** The drag step waiting its turn; a later step only moves it to the newer point. */
  movePending: { x: number; y: number } | null;
  /** Tabs that went away without the app closing them, newest last. WHY: when a
   *  window closes, its tabs close one by one BEFORE the browser reports it
   *  closed — this is how the browser-closed path still knows what was open. */
  justClosed: Array<{ url: string; at: number }>;
}

let promptSeq = 0;

export class BrowserService extends EventEmitter {
  private readonly opts: BrowserServiceOptions;
  private context: BrowserContext | null = null;
  /** Only for My Chrome: the connected (not launched) browser. */
  private connected: Browser | null = null;
  private starting: Promise<BrowserContext> | null = null;
  private run: BrowserRunState = 'stopped';
  private lastError: string | null = null;
  private windowShown = false;
  private myChrome = false;
  private browserLabel: string | null = null;
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly owner = new WeakMap<Page, string>();
  private browserIdleTimer: NodeJS.Timeout | null = null;
  private closingOnPurpose = false;
  private readonly cachedVersions = new Map<string, string | null>();
  private readonly watchers = new Map<string, LiveView>();
  private readonly blankToClose = new Set<Page>();
  /** Tabs the app itself is closing (a tool, a chat ending) — not lost ones. */
  private readonly closingPages = new WeakSet<Page>();
  private shotSeq = 0;
  /** Who last clicked, typed or ran a tool — the likely owner of a tab that
   *  is opening right now (see installRequestGuard). */
  private lastActor: { sessionId: string; at: number } | null = null;
  downloadPercent: number | null = null;
  /** While a hand-off asked for a window, the browser runs shown regardless of settings. */
  private windowOverride: boolean | null = null;

  constructor(opts: BrowserServiceOptions) {
    super();
    this.opts = opts;
  }

  // ── state ────────────────────────────────────────────────────────────────

  private entry(sessionId: string): SessionEntry {
    let e = this.sessions.get(sessionId);
    if (!e) {
      e = { pages: [], active: null, used: false, busy: 0, prompt: null, promptResolve: null, notes: [], lastUrls: [], queue: Promise.resolve(), idleTimer: null, viewSize: null, zoom: null, inputChain: Promise.resolve(), wheelPending: null, movePending: null, justClosed: [] };
      this.sessions.set(sessionId, e);
    }
    return e;
  }

  state(sessionId: string): BrowserSessionState {
    const e = this.sessions.get(sessionId);
    const tabs = e ? e.pages.map((p, index) => {
      const n = navInfo.get(p);
      return { index, title: tabTitle(p), url: p.url(), active: p === e.active, loading: n?.loading ?? false, canGoBack: n?.back ?? false, canGoForward: n?.forward ?? false };
    }) : [];
    return {
      sessionId,
      run: this.run,
      windowShown: this.windowShown,
      myChrome: this.myChrome,
      browserLabel: this.browserLabel,
      tabs,
      prompt: e?.prompt ?? null,
      error: this.run === 'error' ? this.lastError : null,
      used: e?.used ?? false,
      busy: (e?.busy ?? 0) > 0,
      downloadPercent: this.downloadPercent,
      zoom: this.canZoom() ? { percent: Math.round((e ? this.zoomOf(e) : 1) * 100), auto: (e?.zoom ?? null) === null } : null,
    };
  }

  emitState(sessionId: string): void { this.emit('state', this.state(sessionId)); }

  emitAll(): void { for (const id of this.sessions.keys()) this.emitState(id); }

  isRunning(): boolean { return this.context !== null; }

  private log(level: 'INFO' | 'WARN' | 'ERROR', msg: string, data?: Record<string, unknown>): void {
    this.opts.log?.(level, msg, data);
  }

  private openTabCount(): number {
    let n = 0;
    for (const e of this.sessions.values()) n += e.pages.length;
    return n;
  }

  /** Conversations other than `except` with tabs open (the restart confirm names the count). */
  otherSessionsWithTabs(except: string | null): number {
    let n = 0;
    for (const [id, e] of this.sessions) if (id !== except && e.pages.length) n++;
    return n;
  }

  // ── per-conversation serialization + idle ─────────────────────────────────

  /** Run `fn` after every earlier call of this conversation settles, so two tool
   *  calls never drive the same tab at once. Marks the conversation busy and
   *  re-arms its idle close. */
  async withSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const e = this.entry(sessionId);
    const prev = e.queue;
    let release!: () => void;
    e.queue = new Promise<void>((r) => { release = r; });
    try {
      await prev.catch(() => undefined);
      e.busy++;
      e.used = true;
      this.lastActor = { sessionId, at: Date.now() };
      this.clearSessionIdle(e);
      if (e.busy === 1) this.emitState(sessionId);
      return await fn();
    } finally {
      e.busy--;
      this.armSessionIdle(sessionId, e);
      release();
      this.emitState(sessionId);
    }
  }

  private armSessionIdle(sessionId: string, e: SessionEntry): void {
    this.clearSessionIdle(e);
    if (!e.pages.length) return;
    e.idleTimer = setTimeout(() => {
      e.idleTimer = null;
      if (e.busy || e.prompt) return this.armSessionIdle(sessionId, e);
      e.notes.push('This conversation\'s browser tabs were closed after 30 minutes without use.');
      void this.closeSession(sessionId, false, true);
    }, this.opts.sessionIdleMs ?? SESSION_IDLE_MS);
    e.idleTimer.unref?.();
  }

  private clearSessionIdle(e: SessionEntry): void {
    if (e.idleTimer) { clearTimeout(e.idleTimer); e.idleTimer = null; }
  }

  private armBrowserIdle(): void {
    this.clearBrowserIdle();
    if (!this.context || this.openTabCount() > 0) return;
    this.browserIdleTimer = setTimeout(() => {
      this.browserIdleTimer = null;
      if (this.openTabCount() === 0 && !this.anyBusy()) void this.stop();
    }, this.opts.browserIdleMs ?? BROWSER_IDLE_MS);
    this.browserIdleTimer.unref?.();
  }

  private clearBrowserIdle(): void {
    if (this.browserIdleTimer) { clearTimeout(this.browserIdleTimer); this.browserIdleTimer = null; }
  }

  private anyBusy(): boolean {
    for (const e of this.sessions.values()) if (e.busy) return true;
    return false;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** The live context, starting the browser if needed. */
  async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.startsBlocked) throw new BrowserUnavailableError('The browser is signing out of every site right now. Try again in a moment.');
    if (!this.starting) this.starting = this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async start(): Promise<BrowserContext> {
    this.run = 'starting';
    this.lastError = null;
    this.emitAll();
    try {
      const cfg = await this.opts.getLaunchConfig();
      const ctx = cfg.myChrome ? await this.startMyChrome() : await this.launchOwn(this.windowOverride ?? cfg.showWindow, cfg.browser);
      // Own browser: every page and embedded-page load is checked at the context,
      // from the very first request — a popup or iframe can't slip past
      // (code review F1/F2). Not in My Chrome: the context there is the person's.
      if (!cfg.myChrome && this.opts.requestGuard) await this.installRequestGuard(ctx, this.opts.requestGuard);
      this.context = ctx;
      this.run = 'running';
      this.closingOnPurpose = false;
      ctx.on('page', (p) => this.adoptPopup(p));
      if (this.connected) this.connected.on('disconnected', () => this.onContextClosed(ctx));
      else ctx.on('close', () => this.onContextClosed(ctx));
      this.armBrowserIdle();
      this.emitAll();
      return ctx;
    } catch (err) {
      // A half-made My Chrome connection must not linger (code review F4).
      const half = this.connected;
      this.connected = null;
      if (half) await half.close().catch(() => undefined);
      this.run = 'error';
      const known = err instanceof BrowserUnavailableError;
      this.lastError = known ? err.message : startFailureMessage(err);
      this.log('ERROR', 'Browser failed to start', { error: firstLine(err) });
      this.emitAll();
      throw known ? err : new BrowserUnavailableError(this.lastError, 'start-failed');
    }
  }

  private async launchOwn(showWindow: boolean, browser: FoundBrowser | null): Promise<BrowserContext> {
    if (!browser) throw new BrowserUnavailableError('No browser was found on this computer for the assistant to use.', 'no-browser');
    const headless = this.opts.forceHeadless ? true : !showWindow;
    const profileDir = path.join(this.opts.rootDir, 'profile');
    await fs.promises.mkdir(profileDir, { recursive: true });
    await clearStaleProfileLock(profileDir, this.opts.platform ?? process.platform, (m, d) => this.log('INFO', m, d));
    let userAgent: string | undefined;
    if (headless) {
      if (!this.cachedVersions.has(browser.executablePath)) {
        this.cachedVersions.set(browser.executablePath, await readBrowserVersion(browser.executablePath, this.opts.platform));
      }
      const v = this.cachedVersions.get(browser.executablePath);
      if (v) userAgent = normalUserAgent(v, this.opts.platform);
    }
    const ratio = this.opts.pixelRatio ?? HIDDEN_PIXEL_RATIO;
    const ctx = await this.opts.chromium.launchPersistentContext(profileDir, {
      executablePath: browser.executablePath,
      headless,
      // A shown window follows its own size; a hidden one renders a laptop-sized page.
      viewport: headless ? BACKGROUND_VIEWPORT : null,
      ...(headless ? { deviceScaleFactor: ratio } : {}),
      userAgent,
      acceptDownloads: true,
      timeout: 60_000,
      // WHY drop --enable-automation: it sets navigator.webdriver and makes many
      // sites refuse ordinary visits. This avoids sites that reject automation
      // flags outright; it does not defeat real bot checks (spec §2, honest).
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check', '--hide-crash-restore-bubble',
        // WHY: a hidden browser's live picture comes at 1x whatever
        // deviceScaleFactor says (measured 2026-10-14: a 463-wide page gave a
        // 463-wide picture at factor 2), so it looked soft on a 1.5x screen.
        // This flag makes the picture follow the density.
        ...(headless ? [`--force-device-scale-factor=${ratio}`] : []),
      ],
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    this.windowShown = !headless;
    this.myChrome = false;
    this.browserLabel = browser.label;
    // The persistent context opens with a tab nobody owns (and a profile may try
    // to restore old ones). Close them once a real tab exists, so no stray page
    // ever shows in the window or keeps old content around (review 1 #10).
    for (const p of ctx.pages()) this.blankToClose.add(p);
    return ctx;
  }

  private async startMyChrome(): Promise<BrowserContext> {
    const find = this.opts.findMyChrome;
    if (!find) throw new BrowserUnavailableError('Using your own Chrome isn\'t available on this computer.', 'my-chrome');
    const found = await find();
    if ('error' in found) throw new BrowserUnavailableError(found.error, 'my-chrome');
    let browser: Browser;
    try {
      // Chrome shows its own "Allow?" question for this connection; 60 s gives
      // the person time to find it.
      browser = await this.opts.chromium.connectOverCDP(found.wsEndpoint, { timeout: 60_000 });
    } catch (err) {
      throw new BrowserUnavailableError(`Couldn't connect to your Chrome: ${firstLine(err)}. If Chrome asked "Allow?", choose Allow and try again.`, 'my-chrome');
    }
    this.connected = browser;
    const ctx = browser.contexts()[0];
    // (start()'s catch closes `connected` on this throw.)
    if (!ctx) throw new BrowserUnavailableError('Chrome is connected but has no open window. Open a Chrome window and try again.', 'my-chrome');
    this.windowShown = true;
    this.myChrome = true;
    this.browserLabel = 'My Chrome';
    return ctx;
  }

  /** Check each Document request (a page or an embedded page) before it is sent. */
  private async installRequestGuard(ctx: BrowserContext, guard: NonNullable<BrowserServiceOptions['requestGuard']>): Promise<void> {
    await ctx.route('**/*', async (route) => {
      const req = route.request();
      if (req.resourceType() !== 'document') return route.continue().catch(() => undefined);
      let sid: string | null;
      let page: Page | null = null;
      // (A new tab's first page request has no frame yet: Playwright throws.)
      try { page = req.frame().page(); } catch { /* a tab not set up yet */ }
      // WHY a likely owner: a tab opened by a link asks for its page before the
      // app has claimed it (the browser holds the claim until this request is
      // answered), so it had no conversation and a home-network address in it
      // was refused even in a chat that allowed it. It is the tab of whoever
      // just acted (its opener's conversation claims it moments later).
      sid = (page && this.owner.get(page)) ?? this.recentActor();
      const verdict = await guard(sid, req.url()).catch(() => 'block' as const);
      if (verdict === 'allow') return route.continue().catch(() => undefined);
      return route.abort('blockedbyclient').catch(() => undefined);
    });
  }

  /** The conversation that clicked, typed or ran a tool in the last few
   *  seconds — never in My Chrome, where unclaimed tabs are the person's own. */
  private recentActor(): string | null {
    const a = this.lastActor;
    if (this.connected || !a || Date.now() - a.at > 10_000 || !this.sessions.has(a.sessionId)) return null;
    return a.sessionId;
  }

  private onContextClosed(ctx: BrowserContext): void {
    if (this.context !== ctx && this.context !== null) return; // an older generation's late event
    const wasPurpose = this.closingOnPurpose;
    const wasMyChrome = this.myChrome;
    // WHY (Destin, 2026-10-13): closing the shown window means "hide it", not
    // "stop the browser" — the pages come back, hidden, in the panel.
    const personClosedWindow = !wasPurpose && !wasMyChrome && this.windowShown;
    this.context = null;
    this.connected = null;
    this.stopAllWatchers();
    const recent = Date.now() - 3000;
    for (const [id, e] of this.sessions) {
      if (e.pages.length) e.lastUrls = e.pages.map((p) => p.url()).filter(isReopenable);
      else if (!wasPurpose) {
        const lost = e.justClosed.filter((c) => c.at >= recent).map((c) => c.url);
        if (lost.length) e.lastUrls = lost;
      }
      e.justClosed = [];
      e.pages = [];
      e.active = null;
      this.clearSessionIdle(e);
      if (personClosedWindow) continue; // pages and cards carry on, hidden (reopenHidden)
      if (!wasPurpose && e.lastUrls.length) {
        e.notes.push(wasMyChrome
          ? 'Chrome was closed or disconnected, so the browser stopped.'
          : 'The browser window was closed (or the browser stopped unexpectedly), so the browser stopped.');
      }
      if (!wasPurpose) this.settlePrompt(id, 'cancelled');
    }
    this.run = 'stopped';
    this.clearBrowserIdle();
    this.emitAll();
    if (personClosedWindow) void this.reopenHidden();
  }

  /** After the person closed the window: record hidden as their choice, then
   *  reopen every conversation's pages in the hidden browser. */
  private async reopenHidden(): Promise<void> {
    this.windowOverride = null;
    try {
      await this.opts.onWindowClosedByPerson?.();
      const anyOpen = [...this.sessions.values()].some((e) => e.lastUrls.length);
      if (!anyOpen) return;
      await this.ensureContext();
      await this.reopenAll('The person closed the browser window, so the browser went back to working hidden. Pages were reopened at the same addresses; take a new outline before acting — earlier element refs no longer work.');
    } catch (err) {
      this.log('WARN', 'Browser: could not reopen hidden after the window closed', { error: firstLine(err) });
    }
  }

  /** Reopen each conversation's remembered addresses in the live browser. */
  private async reopenAll(note: string): Promise<void> {
    const reopen = new Map<string, string[]>();
    for (const [id, e] of this.sessions) { reopen.set(id, e.lastUrls); e.lastUrls = []; }
    for (const [id, urls] of reopen) {
      const e = this.entry(id);
      // The note goes in before the pages load: a call made meanwhile must
      // already know its refs went stale.
      if (urls.length) e.notes.push(note);
      for (const u of urls) {
        try {
          const p = await this.newPage(id);
          await p.goto(u, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined);
        } catch (err) {
          this.log('WARN', 'Browser: could not reopen a tab after a restart', { error: firstLine(err) });
        }
      }
      this.emitState(id);
    }
  }

  /** Close the browser for everyone. Each conversation's addresses are kept so a
   *  restart can reopen them and a later call can say what was open. */
  async stop(): Promise<void> {
    if (this.starting) await this.starting.catch(() => undefined);
    const ctx = this.context;
    if (!ctx) {
      // Retry after a failed start: clear the error so the next call starts
      // afresh and the panel stops showing it (code review F6).
      if (this.run === 'error') { this.run = 'stopped'; this.lastError = null; this.emitAll(); }
      return;
    }
    this.closingOnPurpose = true;
    for (const e of this.sessions.values()) {
      if (e.pages.length) e.lastUrls = e.pages.map((p) => p.url()).filter(isReopenable);
    }
    try {
      if (this.connected) {
        // My Chrome: close only OUR tabs, then disconnect. Never close the person's browser.
        for (const e of this.sessions.values()) for (const p of [...e.pages]) await p.close().catch(() => undefined);
        await this.connected.close().catch(() => undefined);
      } else {
        await ctx.close().catch(() => undefined);
      }
    } finally {
      this.onContextClosed(ctx);
    }
  }

  /** Restart in whatever mode the settings (or the hand-off override) now say,
   *  reopening every conversation's tabs. Waits up to RESTART_DRAIN_MS for
   *  in-flight calls so a restart doesn't pull a page out from under one. */
  async restart(): Promise<void> {
    if (!this.context && !this.starting) return;
    const deadline = Date.now() + RESTART_DRAIN_MS;
    while (this.anyBusyExceptPrompting() && Date.now() < deadline) await delay(100);
    await this.stop();
    await this.ensureContext();
    await this.reopenAll('The browser restarted (the window was shown or hidden). Pages were reopened at the same addresses; take a new outline before acting — earlier element refs no longer work.');
  }

  /** A call waiting on the person (a prompt) doesn't block a restart — the
   *  restart is usually what the person asked for from that very card. */
  private anyBusyExceptPrompting(): boolean {
    for (const e of this.sessions.values()) if (e.busy && !e.prompt) return true;
    return false;
  }

  /** Hand-off "Open window to sign in": run shown until the person is done. */
  async setWindowOverride(shown: boolean | null): Promise<void> {
    if (this.windowOverride === shown) return;
    this.windowOverride = shown;
    const cfg = await this.opts.getLaunchConfig();
    if (cfg.myChrome || !this.context) return;
    const want = shown ?? cfg.showWindow;
    if (want !== this.windowShown) await this.restart();
  }

  hasWindowOverride(): boolean { return this.windowOverride !== null; }

  private endWindowOverride(): void {
    if (this.windowOverride === null) return;
    void this.setWindowOverride(null).catch((err) => this.log('WARN', 'Browser: could not hide the sign-in window', { error: firstLine(err) }));
  }

  /** While true, nothing may start the browser (clearing sign-ins deletes its folder). */
  private startsBlocked = false;

  /** Run `fn` with the browser stopped and unable to start (code review F14). */
  async withStartsBlocked<T>(fn: () => Promise<T>): Promise<T> {
    this.startsBlocked = true;
    try {
      await this.stop();
      return await fn();
    } finally { this.startsBlocked = false; }
  }

  // ── tabs ─────────────────────────────────────────────────────────────────

  /** Open a new tab owned by `sessionId` and make it active. */
  async newPage(sessionId: string): Promise<Page> {
    const ctx = await this.ensureContext();
    const page = await ctx.newPage();
    this.adopt(sessionId, page);
    if (this.connected && this.opts.guardPage) await this.opts.guardPage(sessionId, page);
    for (const b of this.blankToClose) { this.blankToClose.delete(b); void b.close().catch(() => undefined); }
    return page;
  }

  private adopt(sessionId: string, page: Page): void {
    if (this.owner.has(page)) return;
    const e = this.entry(sessionId);
    this.owner.set(page, sessionId);
    e.pages.push(page);
    e.active = page;
    e.used = true;
    this.clearBrowserIdle();
    page.on('close', () => this.onPageClosed(sessionId, page));
    page.on('dialog', (d) => {
      const kind = d.type();
      const msg = d.message().slice(0, 300);
      // WHY: an unanswered dialog freezes the page for every later action.
      // Alerts are acknowledged; confirm/prompt are DECLINED (the safe answer to
      // "Are you sure you want to delete…?") and reported.
      if (kind === 'alert' || kind === 'beforeunload') void d.accept().catch(() => undefined);
      else void d.dismiss().catch(() => undefined);
      e.notes.push(kind === 'alert' ? `The page showed a message: "${msg}"` : `The page asked "${msg}" — it was answered No (Cancel).`);
    });
    page.on('download', (dl) => { void this.saveDownload(sessionId, dl); });
    page.on('crash', () => { e.notes.push('A tab crashed. Reopen the page to continue.'); });
    // The panel's address and title follow the page as it moves, whoever moved
    // it (the person browses there too now).
    // Loading and Back/Forward follow the page too, so the panel's buttons can
    // say Stop while it loads and grey out Back with nowhere to go.
    page.on('framenavigated', (f) => {
      if (f !== page.mainFrame()) return;
      setNav(page, { loading: true });
      this.emitState(sessionId);
      // An in-page move (a site changing its address without loading) fires
      // this with no load after it: an already-complete page isn't loading.
      void page.evaluate(() => document.readyState).then(async (rs) => {
        if (rs !== 'complete') return;
        setNav(page, { loading: false });
        await refreshHistory(page);
        this.emitState(sessionId);
      }).catch(() => undefined);
    });
    page.on('domcontentloaded', () => { void Promise.all([refreshTitles([page]), refreshHistory(page)]).then(() => this.emitState(sessionId)); });
    page.on('load', () => { setNav(page, { loading: false }); void refreshHistory(page).then(() => this.emitState(sessionId)); });
    this.fitToPanel(e, page);
    this.emitState(sessionId);
    this.retargetWatcher(sessionId);
  }

  // ── the panel: its size, and the person browsing ─────────────────────────

  /** The Browser panel's picture area changed. A hidden browser lays the
   *  conversation's pages out to that size, so the page fits the panel (a
   *  narrow panel gets a site's narrow layout) instead of a shrunken laptop
   *  page. A shown window or My Chrome keeps its own size. */
  setViewSize(sessionId: string, width: number, height: number): void {
    const e = this.entry(sessionId);
    const w = Math.round(Math.max(1, width));
    const h = Math.round(Math.max(1, height));
    // Ignore jitter: a few pixels would relayout the page for nothing.
    if (e.viewSize && Math.abs(e.viewSize.width - w) < 8 && Math.abs(e.viewSize.height - h) < 8) return;
    const autoBefore = this.zoomOf(e);
    e.viewSize = { width: w, height: h };
    for (const p of e.pages) this.fitToPanel(e, p);
    // The default zoom follows the panel's width — the panel's % must too.
    if (this.zoomOf(e) !== autoBefore) this.emitState(sessionId);
  }

  /** The conversation's page zoom (0.25–1): the person's or the assistant's
   *  pick, else the default — whatever shows a desktop-width page in the panel.
   *  Without a panel the page is laptop-sized already, so the default is 100%. */
  private zoomOf(e: SessionEntry): number {
    if (e.zoom !== null) return e.zoom;
    return e.viewSize ? Math.max(ZOOM_MIN, Math.min(1, e.viewSize.width / AUTO_PAGE_WIDTH)) : 1;
  }

  /** Can this browser's pages be zoomed? Only a hidden one: a shown window or
   *  My Chrome keeps its own size, which the person controls there. */
  canZoom(): boolean { return !this.windowShown && !this.myChrome; }

  /** Set the conversation's page zoom — from the panel's − / + or the assistant
   *  (BrowserNavigate `zoom`). null returns to the default. WHY one setting for
   *  both (Destin, 2026-10-15): they look at the same page, so a zoom the
   *  assistant picks must show in the panel's % and the reverse. */
  setZoom(sessionId: string, zoom: number | null): number {
    const e = this.entry(sessionId);
    e.zoom = zoom === null || !Number.isFinite(zoom) ? null : Math.max(ZOOM_MIN, Math.min(1, zoom));
    for (const p of e.pages) this.fitToPanel(e, p);
    this.emitState(sessionId);
    return this.zoomOf(e);
  }

  /** Lay a page out at the panel's area divided by the zoom: zoomed out, the
   *  page is wider than the panel and its picture is shrunk to fit, so sites
   *  keep their desktop layouts (Destin, 2026-10-15). No panel yet: the
   *  laptop-sized page, likewise divided. */
  private fitToPanel(e: SessionEntry, page: Page): void {
    if (!this.canZoom()) return;
    const area = e.viewSize ?? BACKGROUND_VIEWPORT;
    const z = this.zoomOf(e);
    const size = {
      width: Math.round(Math.min(VIEW_MAX_W, Math.max(VIEW_MIN, area.width / z))),
      height: Math.round(Math.min(VIEW_MAX_H, Math.max(VIEW_MIN, area.height / z))),
    };
    void page.setViewportSize(size).catch(() => undefined);
  }

  /** The person typed an address (or words to search for) in the panel. Opens
   *  it in the conversation's current tab, or a new one. Returns quickly: the
   *  page keeps loading while the picture shows it. The assistant's permission
   *  cards don't apply — this is the person, not the assistant. */
  async personOpen(sessionId: string, url: string): Promise<void> {
    const page = await this.activePage(sessionId, true);
    if (!page) return;
    this.markUsed(sessionId);
    this.addNote(sessionId, `The person opened ${url} themselves in this conversation's browser.`);
    this.lastActor = { sessionId, at: Date.now() };
    setNav(page, { loading: true });
    this.emitState(sessionId);
    await page.goto(url, { waitUntil: 'commit', timeout: 20_000 });
  }

  async personNav(sessionId: string, nav: 'back' | 'forward' | 'reload' | 'stop'): Promise<void> {
    const page = await this.activePage(sessionId, false);
    if (!page) return;
    this.lastActor = { sessionId, at: Date.now() };
    if (nav === 'stop') {
      await page.evaluate(() => window.stop()).catch(() => undefined);
      setNav(page, { loading: false });
      this.emitState(sessionId);
      return;
    }
    const opts = { waitUntil: 'commit' as const, timeout: 20_000 };
    if (nav === 'back') await page.goBack(opts);
    else if (nav === 'forward') await page.goForward(opts);
    else await page.reload(opts);
  }

  /** The panel's tab strip: a new empty tab, switching tabs, or closing one.
   *  The assistant hears about it with its next result, as with addresses. */
  async personTab(sessionId: string, action: 'new' | 'select' | 'close', index?: number): Promise<void> {
    this.markUsed(sessionId);
    if (action === 'new') {
      await this.newPage(sessionId);
      this.addNote(sessionId, 'The person opened a new tab (now the active tab).');
      return;
    }
    if (index === undefined) throw new BrowserUnavailableError('Which tab?');
    if (action === 'select') {
      this.selectTab(sessionId, index);
      this.addNote(sessionId, `The person switched to tab ${index}.`);
      return;
    }
    const url = this.entry(sessionId).pages[index]?.url() ?? '';
    await this.closeTab(sessionId, index);
    this.addNote(sessionId, `The person closed tab ${index}${url ? ` (${url})` : ''}. Tab numbers after it moved down by one.`);
  }

  /** A click, scroll or key from the panel's picture, in the order sent. */
  personInput(sessionId: string, ev: BrowserInputEvent): void {
    const e = this.sessions.get(sessionId);
    const page = e?.active;
    if (!e || !page || page.isClosed()) return;
    if (ev.type !== 'wheel' && !(ev.type === 'mouse' && ev.action === 'move')) this.lastActor = { sessionId, at: Date.now() };
    this.watchers.get(sessionId)?.goFast(PERSON_FAST_MS);
    // WHY merge scroll steps (measured 2026-10-13, dev app): a touchpad sends
    // a step every screen refresh, the browser takes ~35 ms per step, so steps
    // queued and a 1 s scroll took 6 s to finish showing. A step that arrives
    // while another is still waiting joins it — never more than one waits.
    if (ev.type === 'wheel') {
      const waiting = e.wheelPending;
      if (waiting) { waiting.x = ev.x; waiting.y = ev.y; waiting.dx += ev.dx; waiting.dy += ev.dy; return; }
      const w = { ...ev };
      e.wheelPending = w;
      e.inputChain = e.inputChain.then(() => {
        if (e.wheelPending === w) e.wheelPending = null;
        return runPersonInput(page, w);
      }).catch(() => undefined);
      return;
    }
    // WHY merge drag steps too: a mouse reports a move every screen refresh;
    // only where the pointer is NOW matters to a highlight, so one waits at most.
    if (ev.type === 'mouse' && ev.action === 'move') {
      const waiting = e.movePending;
      if (waiting) { waiting.x = ev.x; waiting.y = ev.y; return; }
      const m = { x: ev.x, y: ev.y };
      e.movePending = m;
      e.inputChain = e.inputChain.then(() => {
        if (e.movePending === m) e.movePending = null;
        return page.mouse.move(m.x, m.y);
      }).catch(() => undefined);
      return;
    }
    // A click or key keeps its place: later scroll or drag steps queue after it.
    e.wheelPending = null;
    e.movePending = null;
    e.inputChain = e.inputChain.then(() => runPersonInput(page, ev)).catch(() => undefined);
  }

  /** The text the person highlighted on the current tab, for Copy. Waits for
   *  their clicks and drags already sent, so it reads the finished highlight. */
  async personSelection(sessionId: string): Promise<string> {
    const e = this.sessions.get(sessionId);
    const page = e?.active;
    if (!e || !page || page.isClosed()) return '';
    await e.inputChain;
    // WHY read a text box's own selection: the page's selection is empty while
    // the highlight is inside an input or textarea. Frames: the focused one.
    const text = await page.evaluate(() => {
      const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
      if (active && (active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && /^(text|search|url|email|tel|number)?$/i.test(active.type)))) {
        const { selectionStart: a, selectionEnd: b } = active;
        if (a != null && b != null && b > a) return active.value.slice(a, b);
      }
      return String(window.getSelection() ?? '');
    }).catch(() => '');
    return text.slice(0, 200_000);
  }

  /** A page the browser opened by itself (popup / target=_blank) joins its opener's conversation. */
  private adoptPopup(page: Page): void {
    void (async () => {
      if (this.owner.has(page)) return;
      const opener = await page.opener().catch(() => null);
      const sid = opener ? this.owner.get(opener) : undefined;
      if (sid) {
        this.adopt(sid, page);
        if (this.connected && this.opts.guardPage) void this.opts.guardPage(sid, page);
        this.entry(sid).notes.push(`A new tab opened (now the active tab): ${page.url() || 'loading…'}`);
      } else if (this.connected) {
        // My Chrome: the person's own new tabs are theirs; never adopt them.
      }
    })();
  }

  private onPageClosed(sessionId: string, page: Page): void {
    const e = this.sessions.get(sessionId);
    if (!e) return;
    if (!this.closingOnPurpose && !this.closingPages.has(page) && isReopenable(page.url())) {
      e.justClosed = [...e.justClosed.slice(-9), { url: page.url(), at: Date.now() }];
    }
    e.pages = e.pages.filter((p) => p !== page);
    if (e.active === page) e.active = e.pages[e.pages.length - 1] ?? null;
    if (!e.pages.length) this.clearSessionIdle(e);
    this.emitState(sessionId);
    this.retargetWatcher(sessionId);
    this.armBrowserIdle();
  }

  /** The conversation's active tab, opening one when `create` and none exists. */
  async activePage(sessionId: string, create: boolean): Promise<Page | null> {
    const e = this.entry(sessionId);
    if (e.active && !e.active.isClosed()) return e.active;
    if (!create) return null;
    return this.newPage(sessionId);
  }

  pages(sessionId: string): Page[] { return this.sessions.get(sessionId)?.pages ?? []; }

  selectTab(sessionId: string, index: number): Page {
    const e = this.entry(sessionId);
    const p = e.pages[index];
    if (!p) throw new BrowserUnavailableError(`There is no tab ${index}. This conversation has ${e.pages.length} tab(s).`);
    e.active = p;
    void p.bringToFront().catch(() => undefined);
    this.emitState(sessionId);
    this.retargetWatcher(sessionId);
    return p;
  }

  async closeTab(sessionId: string, index: number): Promise<void> {
    const p = this.entry(sessionId).pages[index];
    if (!p) throw new BrowserUnavailableError(`There is no tab ${index}.`);
    this.closingPages.add(p);
    await p.close().catch(() => undefined);
  }

  /** Close every tab this conversation owns (it ended, Stop for this chat, or idle). */
  async closeSession(sessionId: string, forget = false, keepNotes = false): Promise<void> {
    const e = this.sessions.get(sessionId);
    if (e) {
      this.settlePrompt(sessionId, 'cancelled');
      this.clearSessionIdle(e);
      for (const p of [...e.pages]) { this.closingPages.add(p); await p.close().catch(() => undefined); }
      e.lastUrls = [];
      if (!keepNotes) e.notes = [];
    }
    this.stopWatcher(sessionId);
    if (forget) this.sessions.delete(sessionId);
    else if (e) this.emitState(sessionId);
    this.armBrowserIdle();
  }

  /** Notes collected since the last tool result. Includes the stale-refs note
   *  when the browser restarted since this conversation's last outline. */
  takeNotes(sessionId: string): string[] {
    const e = this.sessions.get(sessionId);
    if (!e || !e.notes.length) return [];
    const n = e.notes;
    e.notes = [];
    return n;
  }

  /** Addresses this conversation had open before the browser closed. */
  lastUrls(sessionId: string): string[] { return this.sessions.get(sessionId)?.lastUrls ?? []; }

  /** Queue a note for the conversation's next tool result. */
  addNote(sessionId: string, note: string): void { this.entry(sessionId).notes.push(note); }

  /** The conversation has used the browser (the header button appears). */
  markUsed(sessionId: string): void {
    const e = this.entry(sessionId);
    if (!e.used) { e.used = true; this.emitState(sessionId); }
  }

  // ── downloads, screenshots ───────────────────────────────────────────────

  private async saveDownload(sessionId: string, dl: import('playwright-core').Download): Promise<void> {
    const e = this.entry(sessionId);
    try {
      const name = sanitizeFileName(dl.suggestedFilename() || 'download');
      const dir = path.join(this.opts.rootDir, 'downloads', safeId(sessionId));
      const target = await uniquePath(dir, name);
      await dl.saveAs(target);
      await this.capDownloads(dir);
      const program = /\.(exe|msi|bat|cmd|com|scr|ps1|vbs|js|jar|app|dmg|pkg|sh|run|appimage|deb|rpm)$/i.test(name);
      e.notes.push(`Downloaded a file to ${target}${program ? ' — this is a program; do not open or run it, and warn the person before handing it over' : ''}. Hand it to the person with the file-sharing tool if they want it.`);
    } catch (err) {
      e.notes.push(`A download didn't finish: ${firstLine(err)}`);
    }
  }

  async screenshotPath(sessionId: string): Promise<string> {
    const dir = path.join(this.opts.rootDir, 'shots');
    await fs.promises.mkdir(dir, { recursive: true });
    this.shotSeq++;
    return path.join(dir, `${safeId(sessionId)}-${Date.now()}-${this.shotSeq}.jpg`);
  }

  /** Delete screenshots and downloads older than `maxAgeMs` (screenshots can
   *  show signed-in pages; a page can download on its own — code review F12). */
  async pruneOld(maxAgeMs: number): Promise<void> {
    const cutoff = Date.now() - maxAgeMs;
    const sweep = async (dir: string): Promise<void> => {
      let names: fs.Dirent[];
      try { names = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const d of names) {
        const p = path.join(dir, d.name);
        if (d.isDirectory()) { await sweep(p); continue; }
        try { if ((await fs.promises.stat(p)).mtimeMs < cutoff) await fs.promises.rm(p, { force: true }); } catch { /* raced */ }
      }
    };
    await sweep(path.join(this.opts.rootDir, 'shots'));
    await sweep(path.join(this.opts.rootDir, 'downloads'));
  }

  /** At most MAX_DOWNLOADS files per conversation; the oldest go first. */
  private async capDownloads(dir: string): Promise<void> {
    try {
      const files = await Promise.all((await fs.promises.readdir(dir)).map(async (n) => ({ p: path.join(dir, n), t: (await fs.promises.stat(path.join(dir, n))).mtimeMs })));
      files.sort((a, b) => a.t - b.t);
      for (const f of files.slice(0, Math.max(0, files.length - MAX_DOWNLOADS))) await fs.promises.rm(f.p, { force: true });
    } catch { /* best effort */ }
  }

  // ── prompts: the person decides ──────────────────────────────────────────

  /** Show a card and wait for the person. Resolves 'timeout' after `timeoutMs`
   *  (the card is withdrawn), 'cancelled' on abort / tabs closed / browser
   *  stopped / a newer prompt. A 'handoff' prompt is NOT withdrawn on timeout:
   *  it stays up so a later call can keep waiting (`waitForOpenPrompt`). */
  ask(sessionId: string, p: Omit<BrowserPrompt, 'id'>, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<PromptAnswer | 'cancelled' | 'timeout'> {
    const e = this.entry(sessionId);
    this.settlePrompt(sessionId, 'cancelled');
    const prompt: BrowserPrompt = { ...p, id: `p${++promptSeq}` };
    e.prompt = prompt;
    this.emitState(sessionId);
    this.emit('prompt', { sessionId, prompt });
    return this.waitOnPrompt(sessionId, prompt, opts);
  }

  /** Keep waiting on a hand-off that is still showing. */
  waitForOpenPrompt(sessionId: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<PromptAnswer | 'cancelled' | 'timeout'> | null {
    const e = this.sessions.get(sessionId);
    if (!e?.prompt || e.prompt.kind !== 'handoff') return null;
    return this.waitOnPrompt(sessionId, e.prompt, opts);
  }

  openPrompt(sessionId: string): BrowserPrompt | null { return this.sessions.get(sessionId)?.prompt ?? null; }

  private waitOnPrompt(sessionId: string, prompt: BrowserPrompt, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<PromptAnswer | 'cancelled' | 'timeout'> {
    const e = this.entry(sessionId);
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      let done = false;
      const finish = (a: PromptAnswer | 'cancelled' | 'timeout', withdraw: boolean) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        if (e.promptResolve === resolver) e.promptResolve = null;
        if (withdraw && e.prompt?.id === prompt.id) {
          e.prompt = null;
          this.emitState(sessionId);
        }
        // A sign-in window shown just for this hand-off goes back to how the
        // person set it whenever the hand-off ends — done, can't, or withdrawn
        // (code review F5). Not on 'timeout': the card is still up.
        if (prompt.kind === 'handoff' && a !== 'timeout') this.endWindowOverride();
        resolve(a);
      };
      const resolver = (a: PromptAnswer | 'cancelled' | 'timeout') => finish(a, true);
      const onAbort = () => finish('cancelled', prompt.kind !== 'handoff');
      if (opts.signal?.aborted) { onAbort(); return; }
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => finish('timeout', prompt.kind !== 'handoff'), opts.timeoutMs);
      timer.unref?.();
      e.promptResolve = resolver;
    });
  }

  /** The person's answer from the card. Ignores a stale id. A hand-off answered
   *  while no call is waiting still closes (the next call learns it). */
  answerPrompt(sessionId: string, id: string, answer: PromptAnswer): boolean {
    const e = this.sessions.get(sessionId);
    if (!e?.prompt || e.prompt.id !== id) return false;
    // Only the answers a card offers count for it — a stray 'done' must never
    // read as permission on a final-step card (code review F8).
    if (!ANSWERS_BY_KIND[e.prompt.kind].includes(answer)) return false;
    if (e.promptResolve) {
      e.promptResolve(answer);
    } else {
      if (e.prompt.kind === 'handoff') {
        e.notes.push(answer === 'done' ? 'The person said they are done.' : 'The person said they can\'t do this step.');
        this.endWindowOverride();
      }
      e.prompt = null;
      this.emitState(sessionId);
    }
    return true;
  }

  private settlePrompt(sessionId: string, answer: 'cancelled'): void {
    const e = this.sessions.get(sessionId);
    if (!e) return;
    if (e.promptResolve) e.promptResolve(answer);
    else if (e.prompt) { e.prompt = null; this.emitState(sessionId); }
  }

  // ── live picture ─────────────────────────────────────────────────────────

  /** Start streaming the conversation's active tab. Hidden means idle: the screen
   *  calls unwatch when the panel closes, and nothing streams without a watcher. */
  watch(sessionId: string): void {
    if (this.watchers.has(sessionId)) return;
    const view = new LiveView(sessionId, (f) => this.emit('frame', f), (msg, err) => this.log('WARN', msg, { error: firstLine(err) }));
    this.watchers.set(sessionId, view);
    const p = this.sessions.get(sessionId)?.active ?? null;
    if (p && this.context) void view.attach(this.context, p);
  }

  unwatch(sessionId: string): void { this.stopWatcher(sessionId); }

  ackFrame(sessionId: string): void { this.watchers.get(sessionId)?.ack(); }

  private stopWatcher(sessionId: string): void {
    const v = this.watchers.get(sessionId);
    if (!v) return;
    this.watchers.delete(sessionId);
    void v.detach();
  }

  private stopAllWatchers(): void {
    for (const v of this.watchers.values()) void v.detach();
  }

  private retargetWatcher(sessionId: string): void {
    const v = this.watchers.get(sessionId);
    if (!v) return;
    const p = this.sessions.get(sessionId)?.active ?? null;
    if (!p || !this.context) { void v.detach(); return; }
    void v.attach(this.context, p);
  }

  /** App quit / host shutdown: close the browser. */
  async dispose(): Promise<void> {
    this.clearBrowserIdle();
    for (const e of this.sessions.values()) this.clearSessionIdle(e);
    await this.stop().catch(() => undefined);
  }
}

/** One conversation's screencast. CDP sends the next frame only after an ack;
 *  we ack only after the screen drew the previous frame AND the gap passed — a
 *  busy screen slows the stream instead of queueing pictures. */
class LiveView {
  private cdp: CDPSession | null = null;
  private page: Page | null = null;
  private pendingAck: number | null = null;
  private screenReady = true;
  private lastSent = 0;
  private gapTimer: NodeJS.Timeout | null = null;
  private generation = 0;
  private latest: { data: string; w: number; h: number; sx: number; sy: number } | null = null;
  /** Until this time, frames are acked with no gap (the person is using the page). */
  private fastUntil = 0;

  constructor(
    private readonly sessionId: string,
    private readonly send: (f: FrameEvent) => void,
    private readonly warn: (msg: string, err: unknown) => void,
  ) {}

  async attach(ctx: BrowserContext, page: Page): Promise<void> {
    if (this.page === page && this.cdp) return;
    await this.detach();
    const gen = ++this.generation;
    try {
      const cdp = await ctx.newCDPSession(page);
      if (gen !== this.generation) { void cdp.detach().catch(() => undefined); return; }
      this.cdp = cdp;
      this.page = page;
      cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number; scrollOffsetX?: number; scrollOffsetY?: number } }) => {
        this.pendingAck = f.sessionId;
        const l = { data: f.data, w: f.metadata.deviceWidth, h: f.metadata.deviceHeight, sx: f.metadata.scrollOffsetX ?? 0, sy: f.metadata.scrollOffsetY ?? 0 };
        if (this.screenReady) this.flush(l);
        else this.latest = l;
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: PICTURE_MAX, maxHeight: PICTURE_MAX, everyNthFrame: 1 });
    } catch (err) {
      this.warn('Browser: the live picture could not start', err);
    }
  }

  private flush(l: { data: string; w: number; h: number; sx: number; sy: number }): void {
    this.screenReady = false;
    this.lastSent = Date.now();
    this.send({ sessionId: this.sessionId, data: l.data, width: l.w, height: l.h, scrollX: l.sx, scrollY: l.sy });
  }

  /** The person is using the page: drop the gap now, and for `ms` more. */
  goFast(ms: number): void {
    this.fastUntil = Date.now() + ms;
    // A frame already waiting out the gap is released at once.
    if (this.gapTimer) { clearTimeout(this.gapTimer); this.gapTimer = null; this.sendAck(); }
  }

  private sendAck(): void {
    const id = this.pendingAck;
    this.pendingAck = null;
    if (id !== null && this.cdp) void this.cdp.send('Page.screencastFrameAck', { sessionId: id }).catch(() => undefined);
  }

  ack(): void {
    this.screenReady = true;
    if (this.latest) {
      const l = this.latest; this.latest = null;
      this.flush(l);
      return;
    }
    if (this.gapTimer) return;
    if (Date.now() < this.fastUntil) { this.sendAck(); return; }
    const wait = Math.max(0, MIN_FRAME_GAP_MS - (Date.now() - this.lastSent));
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null;
      this.sendAck();
    }, wait);
    this.gapTimer.unref?.();
  }

  async detach(): Promise<void> {
    this.generation++;
    if (this.gapTimer) { clearTimeout(this.gapTimer); this.gapTimer = null; }
    const cdp = this.cdp;
    this.cdp = null;
    this.page = null;
    this.pendingAck = null;
    this.latest = null;
    this.screenReady = true;
    if (cdp) {
      await cdp.send('Page.stopScreencast').catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    }
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

async function runPersonInput(page: Page, ev: BrowserInputEvent): Promise<void> {
  switch (ev.type) {
    case 'click':
      await page.mouse.move(ev.x, ev.y);
      // One down/up carrying the count, like a real double-click — not two clicks.
      await page.mouse.down({ button: ev.button, clickCount: ev.clickCount });
      await page.mouse.up({ button: ev.button, clickCount: ev.clickCount });
      return;
    case 'wheel':
      await page.mouse.move(ev.x, ev.y);
      await page.mouse.wheel(ev.dx, ev.dy);
      return;
    case 'mouse':
      await page.mouse.move(ev.x, ev.y);
      if (ev.action === 'down') await page.mouse.down({ clickCount: ev.clickCount });
      else if (ev.action === 'up') await page.mouse.up({ clickCount: ev.clickCount });
      return;
    case 'key': await page.keyboard.press(ev.key); return;
    case 'text': await page.keyboard.insertText(ev.text); return;
  }
}

/** A crashed app can leave the profile locked ("SingletonLock" → "<host>-<pid>").
 *  If that pid is gone the lock is stale and Chrome would refuse to start, so
 *  it is removed. A LIVE pid is left alone — start then fails with a specific
 *  message (startFailureMessage) rather than us killing something. */
export async function clearStaleProfileLock(profileDir: string, platform: NodeJS.Platform, info: (m: string, d?: Record<string, unknown>) => void): Promise<void> {
  if (platform === 'win32') return;
  let target: string;
  try { target = await fs.promises.readlink(path.join(profileDir, 'SingletonLock')); } catch { return; }
  const pid = Number(target.split('-').pop());
  if (!Number.isFinite(pid) || pid <= 0) return;
  try { process.kill(pid, 0); return; } catch { /* not running */ }
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    await fs.promises.rm(path.join(profileDir, f), { force: true }).catch(() => undefined);
  }
  info('Browser: removed a stale profile lock', { pid });
}

function startFailureMessage(err: unknown): string {
  const m = firstLine(err);
  if (/ProcessSingleton|profile.*in use|SingletonLock/i.test(m)) {
    return 'The browser couldn\'t start because another YouCoded window is already using it. Close the other YouCoded and try again.';
  }
  return `The browser couldn't start: ${m}`;
}

export function firstLine(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  // Playwright errors append a call log after the first line; the first line is the cause.
  return m.split('\n')[0].replace(/^[\w.]+: /, '').slice(0, 300);
}

const titleCache = new WeakMap<Page, string>();

/** Per tab: loading, and whether Back / Forward can go anywhere. */
const navInfo = new WeakMap<Page, { loading: boolean; back: boolean; forward: boolean }>();
function setNav(p: Page, patch: Partial<{ loading: boolean; back: boolean; forward: boolean }>): void {
  navInfo.set(p, { loading: false, back: false, forward: false, ...navInfo.get(p), ...patch });
}
/** Ask the page whether its history goes back/forward (the Navigation API;
 *  older pages fall back to "anything in history" for Back). */
async function refreshHistory(p: Page): Promise<void> {
  const h = await p.evaluate(() => {
    const n = (window as unknown as { navigation?: { canGoBack: boolean; canGoForward: boolean } }).navigation;
    return n ? { back: n.canGoBack, forward: n.canGoForward } : { back: history.length > 1, forward: false };
  }).catch(() => null);
  if (h) setNav(p, h);
}

function tabTitle(p: Page): string { return titleCache.get(p) ?? hostOf(p.url()); }

/** Refresh cached titles for a conversation's tabs (after each call). */
export async function refreshTitles(pages: Page[]): Promise<void> {
  await Promise.all(pages.map(async (p) => {
    try { titleCache.set(p, (await p.title()) || hostOf(p.url())); } catch { /* closed */ }
  }));
}

export function hostOf(url: string): string {
  try { return new URL(url).host || url; } catch { return url; }
}

function isReopenable(url: string): boolean { return /^https?:\/\//i.test(url); }

function safeId(id: string): string { return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80); }

export function sanitizeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').slice(0, 180);
  return cleaned || 'download';
}

async function uniquePath(dir: string, name: string): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true });
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const candidate = path.join(dir, i === 0 ? name : `${base} (${i})${ext}`);
    try { await fs.promises.access(candidate); } catch { return candidate; }
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

function delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
