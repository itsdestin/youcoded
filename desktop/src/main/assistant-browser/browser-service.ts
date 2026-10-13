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
//   `generation` so the next result can say element refs went stale.
// - Asks to the person (site permission, final step, sign-in hand-off, …) are
//   PROMPTS owned here, drawn as a card by the screen, answered over IPC. One
//   prompt per conversation at a time.
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type { Browser, BrowserContext, CDPSession, Page, chromium as ChromiumType } from 'playwright-core';
import type { FoundBrowser } from '../../shared/browser-types';
import { normalUserAgent, readBrowserVersion } from './browser-version';

export const SESSION_IDLE_MS = 30 * 60_000;
export const BROWSER_IDLE_MS = 5 * 60_000;
/** Bounded wait for in-flight calls before a restart proceeds anyway. */
const RESTART_DRAIN_MS = 10_000;
/** A hidden browser renders a common laptop-sized page so sites serve desktop layouts. */
export const BACKGROUND_VIEWPORT = { width: 1280, height: 800 } as const;
/** Picture rate cap; each frame also waits for the screen's ack. */
const MIN_FRAME_GAP_MS = 100;

import type { BrowserFrame, BrowserPrompt, BrowserRunState, BrowserSessionState, PromptAnswer } from '../../shared/browser-types';
export type { BrowserPrompt, BrowserSessionState, PromptAnswer, PromptKind, BrowserRunState, BrowserTabInfo } from '../../shared/browser-types';
export type FrameEvent = BrowserFrame;

export interface LaunchConfig {
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
  /** Test seams. */
  sessionIdleMs?: number;
  browserIdleMs?: number;
  forceHeadless?: boolean;
}

/** A refusal the tools turn into a plain error result (not a crash). */
export class BrowserUnavailableError extends Error {
  constructor(message: string, readonly code: 'no-browser' | 'start-failed' | 'my-chrome' | 'other' = 'other') { super(message); }
}

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
  lastCall: number;
  idleTimer: NodeJS.Timeout | null;
  /** The browser generation the conversation's last outline came from. */
  seenGeneration: number;
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
  private shotSeq = 0;
  /** Bumped by every (re)start: element refs from an older generation are stale. */
  generation = 0;
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
      e = { pages: [], active: null, used: false, busy: 0, prompt: null, promptResolve: null, notes: [], lastUrls: [], queue: Promise.resolve(), lastCall: 0, idleTimer: null, seenGeneration: 0 };
      this.sessions.set(sessionId, e);
    }
    return e;
  }

  state(sessionId: string): BrowserSessionState {
    const e = this.sessions.get(sessionId);
    const tabs = e ? e.pages.map((p, index) => ({ index, title: tabTitle(p), url: p.url(), active: p === e.active })) : [];
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
      e.lastCall = Date.now();
      this.clearSessionIdle(e);
      if (e.busy === 1) this.emitState(sessionId);
      return await fn();
    } finally {
      e.busy--;
      e.lastCall = Date.now();
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
      this.context = ctx;
      this.generation++;
      this.run = 'running';
      this.closingOnPurpose = false;
      ctx.on('page', (p) => this.adoptPopup(p));
      if (this.connected) this.connected.on('disconnected', () => this.onContextClosed(ctx));
      else ctx.on('close', () => this.onContextClosed(ctx));
      this.armBrowserIdle();
      this.emitAll();
      return ctx;
    } catch (err) {
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
    const ctx = await this.opts.chromium.launchPersistentContext(profileDir, {
      executablePath: browser.executablePath,
      headless,
      // A shown window follows its own size; a hidden one renders a laptop-sized page.
      viewport: headless ? BACKGROUND_VIEWPORT : null,
      userAgent,
      acceptDownloads: true,
      timeout: 60_000,
      // WHY drop --enable-automation: it sets navigator.webdriver and makes many
      // sites refuse ordinary visits. This avoids sites that reject automation
      // flags outright; it does not defeat real bot checks (spec §2, honest).
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check', '--hide-crash-restore-bubble'],
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
    if (!ctx) throw new BrowserUnavailableError('Chrome is connected but has no open window. Open a Chrome window and try again.', 'my-chrome');
    this.windowShown = true;
    this.myChrome = true;
    this.browserLabel = 'My Chrome';
    return ctx;
  }

  private onContextClosed(ctx: BrowserContext): void {
    if (this.context !== ctx && this.context !== null) return; // an older generation's late event
    const wasPurpose = this.closingOnPurpose;
    const wasMyChrome = this.myChrome;
    this.context = null;
    this.connected = null;
    this.stopAllWatchers();
    for (const [id, e] of this.sessions) {
      if (e.pages.length) e.lastUrls = e.pages.map((p) => p.url()).filter(isReopenable);
      e.pages = [];
      e.active = null;
      this.clearSessionIdle(e);
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
  }

  /** Close the browser for everyone. Each conversation's addresses are kept so a
   *  restart can reopen them and a later call can say what was open. */
  async stop(): Promise<void> {
    if (this.starting) await this.starting.catch(() => undefined);
    const ctx = this.context;
    if (!ctx) return;
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
    const reopen = new Map<string, string[]>();
    await this.stop();
    for (const [id, e] of this.sessions) { reopen.set(id, e.lastUrls); e.lastUrls = []; }
    await this.ensureContext();
    for (const [id, urls] of reopen) {
      const e = this.entry(id);
      for (const u of urls) {
        try {
          const p = await this.newPage(id);
          await p.goto(u, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined);
        } catch (err) {
          this.log('WARN', 'Browser: could not reopen a tab after a restart', { error: firstLine(err) });
        }
      }
      if (urls.length) e.notes.push('The browser restarted (the window was shown or hidden). Pages were reopened at the same addresses; take a new outline before acting — earlier element refs no longer work.');
      this.emitState(id);
    }
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

  // ── tabs ─────────────────────────────────────────────────────────────────

  /** Open a new tab owned by `sessionId` and make it active. */
  async newPage(sessionId: string): Promise<Page> {
    const ctx = await this.ensureContext();
    const page = await ctx.newPage();
    this.adopt(sessionId, page);
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
    // browser-host.ts installs the navigation guard (browser-tool-runners.ts) here.
    this.emit('page-adopted', sessionId, page);
    this.emitState(sessionId);
    this.retargetWatcher(sessionId);
  }

  /** A page the browser opened by itself (popup / target=_blank) joins its opener's conversation. */
  private adoptPopup(page: Page): void {
    void (async () => {
      if (this.owner.has(page)) return;
      const opener = await page.opener().catch(() => null);
      const sid = opener ? this.owner.get(opener) : undefined;
      if (sid) {
        this.adopt(sid, page);
        this.entry(sid).notes.push(`A new tab opened (now the active tab): ${page.url() || 'loading…'}`);
      } else if (this.connected) {
        // My Chrome: the person's own new tabs are theirs; never adopt them.
      }
    })();
  }

  private onPageClosed(sessionId: string, page: Page): void {
    const e = this.sessions.get(sessionId);
    if (!e) return;
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
    await p.close().catch(() => undefined);
  }

  /** Close every tab this conversation owns (it ended, Stop for this chat, or idle). */
  async closeSession(sessionId: string, forget = false, keepNotes = false): Promise<void> {
    const e = this.sessions.get(sessionId);
    if (e) {
      this.settlePrompt(sessionId, 'cancelled');
      this.clearSessionIdle(e);
      for (const p of [...e.pages]) await p.close().catch(() => undefined);
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

  /** Delete screenshots older than `maxAgeMs` (they can show signed-in pages). */
  async pruneShots(maxAgeMs: number): Promise<void> {
    const dir = path.join(this.opts.rootDir, 'shots');
    let names: string[];
    try { names = await fs.promises.readdir(dir); } catch { return; }
    const cutoff = Date.now() - maxAgeMs;
    for (const n of names) {
      const p = path.join(dir, n);
      try { if ((await fs.promises.stat(p)).mtimeMs < cutoff) await fs.promises.rm(p, { force: true }); } catch { /* raced */ }
    }
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
    if (e.promptResolve) {
      e.promptResolve(answer);
    } else {
      if (e.prompt.kind === 'handoff') e.notes.push(answer === 'done' ? 'The person said they are done.' : 'The person said they can\'t do this step.');
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
  private latest: { data: string; w: number; h: number } | null = null;

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
      cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
        this.pendingAck = f.sessionId;
        if (this.screenReady) this.flush(f.data, f.metadata.deviceWidth, f.metadata.deviceHeight);
        else this.latest = { data: f.data, w: f.metadata.deviceWidth, h: f.metadata.deviceHeight };
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 });
    } catch (err) {
      this.warn('Browser: the live picture could not start', err);
    }
  }

  private flush(data: string, w: number, h: number): void {
    this.screenReady = false;
    this.lastSent = Date.now();
    this.send({ sessionId: this.sessionId, data, width: w, height: h });
  }

  ack(): void {
    this.screenReady = true;
    if (this.latest) {
      const l = this.latest; this.latest = null;
      this.flush(l.data, l.w, l.h);
      return;
    }
    if (this.gapTimer) return;
    const wait = Math.max(0, MIN_FRAME_GAP_MS - (Date.now() - this.lastSent));
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null;
      const id = this.pendingAck;
      this.pendingAck = null;
      if (id !== null && this.cdp) void this.cdp.send('Page.screencastFrameAck', { sessionId: id }).catch(() => undefined);
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
    return 'The browser couldn\'t start because its saved data is in use by another copy of YouCoded. Close the other copy and try again.';
  }
  return `The browser couldn't start: ${m}`;
}

export function firstLine(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  // Playwright errors append a call log after the first line; the first line is the cause.
  return m.split('\n')[0].replace(/^[\w.]+: /, '').slice(0, 300);
}

const titleCache = new WeakMap<Page, string>();

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
