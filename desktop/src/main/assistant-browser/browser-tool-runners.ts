// What each Browser tool DOES — runs inside the Browser's worker process
// (browser-host.ts), the same code for native and Claude Code sessions.
//
// This file is also the Browser's ONE permission engine (design review 1 #1):
// the session kinds' own permission systems pre-approve every Browser tool, and
// every ask here is the app's own card, drawn from the conversation's state.
// The rules (spec §1 "Asking first"):
// - opening/reading pages never asks;
// - clicking/typing/choosing on a site asks once per site per chat
//   (Allow for this chat / Always allow <site> / Not now); My Chrome never
//   offers Always and asks on every new site it navigates to;
// - final steps (buy, send, delete, submit, … — by wording AND by form
//   structure) ask every time;
// - home-network addresses ask per host:port per chat; metadata never opens;
// - a declined or unanswered ask blocks the identical action for 2 minutes.
// This is friction for a well-meaning assistant reading hostile pages, not a
// sandbox — the result text and tool descriptions say the same.
import * as fs from 'fs';
import type { Locator, Page } from 'playwright-core';
import { type BrowserToolArgs } from './browser-tool-specs';
import { validateBrowserRequest } from './browser-tool-validation';
import { BrowserService, BrowserUnavailableError, BrowserCallLifecycleError, firstLine, hostOf, refreshTitles, type PromptAnswer } from './browser-service';
import type { BrowserSettings } from './browser-settings';
import type { BrowserInstaller } from './browser-installer';
import { classifyUrl, hostPortKey, personAddress, type LookupFn } from './browser-net';
import { wrapUntrusted } from '../harness/tools/untrusted';

/** One call's whole budget, queue wait included — under Claude Code's 120 s
 *  auto-background (design review 2 #2; cc-dependencies.md). */
export const CALL_DEADLINE_MS = 100_000;
/** How long one call waits on a card before returning "still waiting"/"no answer". */
const ASK_WAIT_MS = 90_000;
const ACTION_TIMEOUT_MS = 10_000;
const NAV_TIMEOUT_MS = 30_000;
const OUTLINE_CHARS = 24_000;
const REFUSAL_MEMORY_MS = 2 * 60_000;
const FULL_PAGE_MAX_PX = 6000;

export interface RunnerEnv {
  service: BrowserService;
  settings: BrowserSettings;
  installer: BrowserInstaller;
  policy: BrowserPolicy;
}

export interface RunCtx {
  sessionId: string;
  signal: AbortSignal;
  /** The model can look at pictures (native profile; always true for Claude Code). */
  vision: boolean;
  /** Absolute ms timestamp; defaults to now + CALL_DEADLINE_MS. */
  deadline?: number;
  /** Shared receipt survives prompt delivery ending before underlying work settles. */
  receipt?: { stage: string; page?: Page };
}

export interface RunResult { text: string; isError?: boolean; imagePath?: string }

// ── policy state ─────────────────────────────────────────────────────────────

export class BrowserPolicy {
  /** Per chat: hosts the person allowed clicking/typing on. */
  private readonly siteGrants = new Map<string, Set<string>>();
  /** Per chat: host:port approvals for home-network addresses. */
  private readonly localGrants = new Map<string, Set<string>>();
  /** Per chat (My Chrome): hosts the person allowed opening. */
  private readonly navGrants = new Map<string, Set<string>>();
  private readonly refused = new Map<string, number>();

  constructor(readonly lookup?: LookupFn) {}

  private set(map: Map<string, Set<string>>, sid: string): Set<string> {
    let s = map.get(sid);
    if (!s) { s = new Set(); map.set(sid, s); }
    return s;
  }

  siteGranted(sid: string, host: string): boolean { return this.siteGrants.get(sid)?.has(host) ?? false; }
  grantSite(sid: string, host: string): void { this.set(this.siteGrants, sid).add(host); }
  localGranted(sid: string, key: string): boolean { return this.localGrants.get(sid)?.has(key) ?? false; }
  grantLocal(sid: string, key: string): void { this.set(this.localGrants, sid).add(key); }
  navGranted(sid: string, host: string): boolean { return this.navGrants.get(sid)?.has(host) ?? false; }
  grantNav(sid: string, host: string): void { this.set(this.navGrants, sid).add(host); }

  refuse(key: string): void { this.refused.set(key, Date.now() + REFUSAL_MEMORY_MS); }
  isRefused(key: string): boolean {
    const until = this.refused.get(key);
    if (!until) return false;
    if (Date.now() > until) { this.refused.delete(key); return false; }
    return true;
  }

  forget(sid: string): void {
    this.siteGrants.delete(sid); this.localGrants.delete(sid); this.navGrants.delete(sid);
    for (const k of [...this.refused.keys()]) if (k.startsWith(`${sid}|`)) this.refused.delete(k);
  }
}

// ── final-step detection ─────────────────────────────────────────────────────

const FINAL_WORDS = /\b(buy|purchase|pay|payment|place (?:your |my )?order|order now|complete (?:order|purchase)|checkout|check out|confirm|send|post|publish|tweet|delete|remove|erase|destroy|transfer|withdraw|donate|subscribe|unsubscribe|sign ?up|register|book(?: now)?|reserve|submit|apply|close (?:my |your )?account|cancel (?:my |your )?(?:subscription|account|order|membership))\b/i;
const FINAL_PATHS = /(checkout|payment|\/pay(?:\b|\/)|purchase|\/orders?\/(?:new|place|confirm)|confirm|delete|remove|unsubscribe|transfer|withdraw)/i;

export interface ElementInfo {
  tag: string; type: string; role: string; name: string; href: string;
  isSubmit: boolean; inForm: boolean; formSearch: boolean; formAction: string; submitLabel: string;
  frameUrl: string; isPassword: boolean;
}

/** Is this action a "final step" that must ask every time? Exported for tests. */
export function isFinalStep(action: string, info: ElementInfo | null, submitAfterType: boolean): boolean {
  if (!info) return false;
  const formSubmits = info.inForm && !info.formSearch && (FINAL_WORDS.test(info.submitLabel) || FINAL_PATHS.test(info.formAction));
  if (action === 'click' || action === 'double_click') {
    if (FINAL_WORDS.test(info.name)) return true;
    if (info.href && FINAL_PATHS.test(safePath(info.href))) return true;
    if (info.isSubmit && formSubmits) return true;
    return false;
  }
  if (action === 'type') return submitAfterType && formSubmits;
  if (action === 'press_key') return formSubmits; // caller only asks for Enter
  return false;
}

function safePath(href: string): string {
  try { const u = new URL(href); return u.pathname + u.search; } catch { return href; }
}

/** Facts about the live element — read from the page, never from the model's words. */
async function elementInfo(target: { kind: 'page'; page: Page } | { kind: 'locator'; locator: Locator }, timeout: number): Promise<ElementInfo> {
  const fn = (el: Element | null): ElementInfo => {
    const e = (el ?? document.activeElement ?? document.body) as HTMLElement & { value?: string; type?: string };
    const tag = e.tagName.toLowerCase();
    const type = (e.getAttribute('type') || '').toLowerCase();
    const form = e.closest('form');
    // BOTH the accessible label and the visible text: a page can show "Buy now"
    // under aria-label="Next", and the final-step check must see the words a
    // person sees as well as the ones a screen reader hears (code review F11).
    const aria = (e.getAttribute('aria-label') || '').trim();
    const visible = ((e.innerText || '').trim() || (typeof e.value === 'string' ? e.value : '') || e.getAttribute('title') || e.getAttribute('placeholder') || '').trim();
    const label = (aria && visible && aria !== visible ? `${aria} — ${visible}` : aria || visible).replace(/\s+/g, ' ').slice(0, 120);
    const a = e.closest('a');
    const isSubmit = (tag === 'button' && (type === '' || type === 'submit') && !!form) || (tag === 'input' && (type === 'submit' || type === 'image'));
    const formSearch = !!form && (form.getAttribute('role') === 'search' || !!form.querySelector('input[type="search"]') || /search/i.test(form.getAttribute('action') || ''));
    const submitLabel = form
      ? Array.from(form.querySelectorAll('button[type="submit"],button:not([type]),input[type="submit"]'))
        .map((b) => ((b as HTMLElement).innerText || (b as HTMLInputElement).value || b.getAttribute('aria-label') || '').trim()).join(' | ').slice(0, 200)
      : '';
    return {
      tag, type, role: e.getAttribute('role') || tag, name: label, href: a ? a.href : '',
      isSubmit, inForm: !!form, formSearch, formAction: form ? (form.getAttribute('action') || '') : '', submitLabel,
      frameUrl: location.href, isPassword: type === 'password',
    };
  };
  if (target.kind === 'page') {
    // No ref (press_key): describe whatever has focus.
    return target.page.evaluate(fn, null);
  }
  return target.locator.evaluate(fn, undefined, { timeout });
}

// ── helpers ──────────────────────────────────────────────────────────────────

function remaining(ctx: RunCtx): number { return (ctx.deadline ?? Date.now() + CALL_DEADLINE_MS) - Date.now(); }

function err(text: string): RunResult { return { text, isError: true }; }

function checkpoint(ctx: RunCtx): void {
  if (remaining(ctx) <= 0) throw new BrowserCallLifecycleError('deadline', true);
  if (ctx.signal.aborted) throw new BrowserCallLifecycleError('cancelled', true);
}

function receipt(ctx: RunCtx, stage: string, page?: Page): void {
  if (ctx.receipt) { ctx.receipt.stage = stage; if (page) ctx.receipt.page = page; }
}

function receiptText(env: RunnerEnv, ctx: RunCtx): string {
  const r = ctx.receipt;
  let where = '';
  try {
    const tab = env.service.state(ctx.sessionId).tabs.find((t) => t.active);
    if (tab) where = ` Current tab ${tab.index} · ${tab.url}`;
    else if (r?.page) where = ` Last observed page · ${r.page.url()}`;
  } catch { /* tab or browser no longer available */ }
  return `${r?.stage ?? 'Operation not attempted.'}${where}`;
}

const OUTLINE_CACHE_CHARS = 120_000;
interface OutlineCache { outline?: string; cut?: boolean; generation: number; active?: boolean }
// WHY: weak page ownership cannot retain closed sessions. A main-frame navigation
// invalidates even same-URL reloads; human DOM edits deliberately preserve historical parts.
const outlines = new WeakMap<Page, OutlineCache>();
function outlineCache(page: Page): OutlineCache {
  let cache = outlines.get(page);
  if (!cache) {
    cache = { generation: 0 }; outlines.set(page, cache);
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) invalidate(page);
    });
  }
  return cache;
}
function invalidate(page: Page): void {
  const cache = outlineCache(page); cache.outline = undefined; cache.cut = false; cache.generation++;
}
const observedServices = new WeakSet<BrowserService>();
function observeTabChanges(service: BrowserService): void {
  if (observedServices.has(service)) return;
  observedServices.add(service);
  // WHY: panel tab changes must invalidate continuation too, without retaining session IDs.
  service.on('state', (state: ReturnType<BrowserService['state']>) => {
    service.pages(state.sessionId).forEach((page, index) => {
      const cache = outlines.get(page); if (!cache) return;
      const active = state.tabs[index]?.active ?? false;
      if (cache.active !== undefined && cache.active !== active) invalidate(page);
      cache.active = active;
    });
  });
}

const CHALLENGE = /(captcha|verify (?:that )?you(?:'| a)re (?:a )?human|are you a robot|unusual traffic|just a moment\.\.\.|press (?:and|&) hold|checking your browser|security check)/i;
const SIGN_IN = /textbox "[^"]*password[^"]*"/i;

/** The standard result: where we are + notes + the outline (bounded), all
 *  inside the untrusted frame because titles, notes and outline are page text. */
async function pageReport(env: RunnerEnv, ctx: RunCtx, page: Page, opts: { lead?: string; from?: number } = {}): Promise<RunResult> {
  const sid = ctx.sessionId;
  const pages = env.service.pages(sid);
  await refreshTitles(pages);
  let title = '';
  try { title = await page.title(); } catch { /* closed */ }
  const cache = outlineCache(page);
  if (cache.active === undefined) cache.active = env.service.state(sid).tabs[pages.indexOf(page)]?.active ?? false;
  const from = opts.from ?? 0;
  if (from > 0 && cache.outline === undefined) return err(wrapUntrusted('browser', 'No cached snapshot for this page/document. Take BrowserSnapshot with from=0.'));
  if (from === 0) {
    checkpoint(ctx);
    // Drop the previous snapshot before reading: a failed refresh must not revive old refs.
    cache.outline = undefined;
    const generation = cache.generation;
    try {
      const source = await page.ariaSnapshot({ mode: 'ai', timeout: Math.max(1, Math.min(15_000, remaining(ctx))) });
      checkpoint(ctx);
      if (generation !== cache.generation) return err('The page/document changed while reading its outline. Take a fresh BrowserSnapshot.');
      cache.outline = source.slice(0, OUTLINE_CACHE_CHARS);
      cache.cut = source.length > OUTLINE_CACHE_CHARS;
    } catch (e) {
      if (e instanceof BrowserCallLifecycleError) throw e;
      return err(wrapUntrusted('browser', `${opts.lead ?? ''}\nTab ${pages.indexOf(page)} · ${page.url()}\nThe page outline couldn't be read: ${firstLine(e)}`));
    }
  }
  const outline = cache.outline!;
  if (from > outline.length) return err(`Offset ${from} is out of range for the cached snapshot (${outline.length} characters). Use from=0 for a fresh snapshot.`);
  const slice = outline.slice(from, from + OUTLINE_CHARS);
  const end = from + slice.length;
  const lines: string[] = [];
  if (opts.lead) lines.push(opts.lead);
  const idx = pages.indexOf(page);
  lines.push(`Tab ${idx >= 0 ? idx : '?'} of ${pages.length} · ${title ? `"${title}" · ` : ''}${page.url()}`);
  const notes = env.service.takeNotes(sid);
  if (notes.length) lines.push('Notes:', ...notes.map((n) => `- ${n}`));
  if (CHALLENGE.test(title) || CHALLENGE.test(slice.slice(0, 3000))) {
    lines.push('- This page looks like a human check (captcha). Don\'t try to solve it — ask the user with BrowserAskUser.');
  } else if (SIGN_IN.test(slice)) {
    lines.push('- This page asks for a sign-in. Don\'t type a password the user didn\'t give you for this — ask them to sign in with BrowserAskUser.');
  }
  lines.push(from > 0 ? `Continuation of cached snapshot (from character ${from}; historical text, not a fresh reading of the current page):` : 'Page outline:', slice || (from > 0 ? '(End of cached snapshot.)' : '(empty page)'));
  if (cache.cut) lines.push(`[Source cut at ${OUTLINE_CACHE_CHARS} cached characters; the rest is unavailable in this snapshot.]`);
  if (end < outline.length) {
    lines.push(`[The outline continues: showed characters ${from}–${end} of ${outline.length}. Call BrowserSnapshot with from=${end} for the next part.]`);
  }
  return { text: wrapUntrusted('browser', lines.join('\n')) };
}

/** The conversation's page, starting the browser (or offering a download) as needed. */
async function getPage(env: RunnerEnv, ctx: RunCtx, create: boolean): Promise<Page | RunResult> {
  try {
    checkpoint(ctx);
    const p = await env.service.activePage(ctx.sessionId, create);
    checkpoint(ctx);
    if (p && ctx.receipt) ctx.receipt.page = p;
    if (!p) {
      const last = env.service.lastUrls(ctx.sessionId);
      return err(last.length
        ? `No tab is open in this conversation (the browser closed; the last page was ${last[last.length - 1]}). Open it again with BrowserNavigate.`
        : 'No tab is open in this conversation. Open a page with BrowserNavigate first.');
    }
    return p;
  } catch (e) {
    if (e instanceof BrowserCallLifecycleError) throw e;
    if (e instanceof BrowserUnavailableError && e.code === 'no-browser') return offerDownload(env, ctx);
    return err(e instanceof BrowserUnavailableError ? e.message : `The browser couldn't start: ${firstLine(e)}`);
  }
}

async function offerDownload(env: RunnerEnv, ctx: RunCtx): Promise<RunResult> {
  const st = env.installer.current;
  if (st.phase === 'downloading') return err(`The browser is still downloading (${st.percent}%). Wait a minute, then try again.`);
  const wait = Math.min(ASK_WAIT_MS, remaining(ctx) - 3000);
  if (wait <= 0) return err('No browser was found on this computer. Try again in a moment to offer the user a download.');
  const answer = await env.service.ask(ctx.sessionId, {
    kind: 'no-browser',
    message: 'YouCoded can download a browser for the assistant (about 150 MB, kept inside YouCoded).',
  }, { timeoutMs: wait, signal: ctx.signal });
  checkpoint(ctx);
  if (answer === 'download') {
    env.installer.start();
    return err('The browser is downloading now (about 150 MB). The user can see the progress. Try again in a minute or two.');
  }
  if (answer === 'timeout') return err('No browser is installed and the user didn\'t answer the download offer. Ask them in chat.');
  if (answer === 'cancelled') return err('The request was withdrawn.');
  return err('No browser is installed and the user chose not to download one. Use WebFetch for simple pages instead.');
}

function blockedByUser(env: RunnerEnv, ctx: RunCtx): RunResult | null {
  const p = env.service.openPrompt(ctx.sessionId);
  if (p?.kind === 'handoff') {
    return err('The user is doing a step in the browser right now (your BrowserAskUser request is still showing). Call BrowserAskUser again with the same message to wait for them. Snapshot, Screenshot, Wait and tab list remain available; BrowserTabs close/close_all or Stop can end the handoff.');
  }
  return null;
}

function mapActionError(e: unknown, ref: string | undefined): string {
  const m = firstLine(e);
  if (/ref|not found|Unable to|resolved to 0|No node/i.test(m) && ref) {
    return `Element ${ref} isn't on the page anymore (the page changed or the outline is old). Take a new BrowserSnapshot.`;
  }
  if (/Timeout/i.test(m)) return `The page didn't respond within ${ACTION_TIMEOUT_MS / 1000} seconds (the element may be hidden, covered or disabled). Take a new outline or a screenshot to see why. (${m})`;
  if (/Target (page|closed)|has been closed|browser has been closed/i.test(m)) return 'The browser restarted or the tab closed during this step. Take a new outline and try again.';
  return `That didn't work: ${m}`;
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 400));
}

/** Answer → result wording shared by every ask, so declined and unanswered read differently (review 2 #3). */
function askOutcome(answer: PromptAnswer | 'cancelled' | 'timeout', what: string): RunResult | null {
  // `what` can carry page text (a button's label), so these go in the untrusted
  // frame too (code review F9).
  const framed = (t: string) => err(wrapUntrusted('browser', t));
  if (answer === 'timeout') return framed(`The user didn't answer the request to ${what}. It was NOT done. Don't retry it — ask them in chat. (The Browser's questions show only in the app on the computer, so they may be away from it or using a phone.)`);
  if (answer === 'cancelled') return framed(`The request to ${what} was withdrawn (the browser stopped or the tabs closed). It was NOT done.`);
  if (answer === 'no') return framed(`The user declined: they don't want you to ${what}. It was NOT done. Don't retry it.`);
  return null;
}

// ── the tools ────────────────────────────────────────────────────────────────

function applyZoom(env: RunnerEnv, sid: string, value: BrowserToolArgs<'BrowserZoom'>['zoom']): number | RunResult {
  if (!env.service.canZoom()) return err('Zoom only works in the assistant\'s hidden browser — a shown window or the user\'s own Chrome keeps its own size.');
  return Math.round(env.service.setZoom(sid, value === 'auto' ? null : value / 100) * 100);
}

async function zoom(env: RunnerEnv, ctx: RunCtx, a: BrowserToolArgs<'BrowserZoom'>): Promise<RunResult> {
  const blocked = blockedByUser(env, ctx); if (blocked) return blocked;
  const page = await getPage(env, ctx, false); if (!('goto' in page)) return page;
  checkpoint(ctx); invalidate(page);
  receipt(ctx, 'Zoom attempted; outcome uncertain.', page);
  const pct = applyZoom(env, ctx.sessionId, a.zoom); if (typeof pct !== 'number') return pct;
  receipt(ctx, `Zoom set to ${pct}%.`, page);
  await page.waitForTimeout(300).catch(() => undefined);
  return pageReport(env, ctx, page, { lead: `Zoom is now ${pct}%${a.zoom === 'auto' ? ' (the default)' : ''}.` });
}

async function history(env: RunnerEnv, ctx: RunCtx, a: BrowserToolArgs<'BrowserHistory'>): Promise<RunResult> {
  const blocked = blockedByUser(env, ctx); if (blocked) return blocked;
  const page = await getPage(env, ctx, false); if (!('goto' in page)) return page;
  checkpoint(ctx); invalidate(page);
  receipt(ctx, `History ${a.direction} attempted; outcome uncertain.`, page);
  const budget = Math.max(1, Math.min(NAV_TIMEOUT_MS, remaining(ctx)));
  try {
    const r = a.direction === 'back' ? await page.goBack({ timeout: budget, waitUntil: 'domcontentloaded' }) : await page.goForward({ timeout: budget, waitUntil: 'domcontentloaded' });
    const failed = !!r && r.status() >= 400;
    const result = await pageReport(env, ctx, page, { lead: failed ? `Navigation http_error: HTTP ${r!.status()}.` : r ? 'Navigation opened.' : `There was no page to go ${a.direction} to.` });
    return { ...result, isError: result.isError || failed };
  } catch (e) {
    if (e instanceof BrowserCallLifecycleError) throw e;
    const result = await pageReport(env, ctx, page, { lead: `Navigation ${/Timeout/i.test(firstLine(e)) ? 'loading' : /ERR_BLOCKED_BY_CLIENT/.test(firstLine(e)) ? 'blocked' : 'failed'} after waiting up to ${budget / 1000} seconds: ${firstLine(e)}` });
    return { ...result, isError: true };
  }
}

async function navigate(env: RunnerEnv, ctx: RunCtx, a: BrowserToolArgs<'BrowserNavigate'>, legacyZoom?: BrowserToolArgs<'BrowserZoom'>['zoom']): Promise<RunResult> {
  const sid = ctx.sessionId;
  const blocked = blockedByUser(env, ctx); if (blocked) return blocked;
  // WHY: preflight has validated the URL and every legacy field before zoom can mutate state.
  const url = a.url;
  const host = hostOf(url).toLowerCase();
  const cls = await classifyUrl(url, env.policy.lookup);
  checkpoint(ctx);
  if (cls === 'never') return err(`${host} is a special network address (cloud-metadata or link-local) that the browser never opens.`);
  if (cls === 'private') {
    const key = hostPortKey(url);
    if (!env.policy.localGranted(sid, key)) {
      const refKey = `${sid}|local|${key}`;
      if (env.policy.isRefused(refKey)) return err(`The user already declined opening ${key} a moment ago. Don't retry — ask them in chat.`);
      const answer = await env.service.ask(sid, {
        kind: 'local', host: key,
        message: `The assistant wants to open a page on this computer or your home network (${key}).`,
      }, { timeoutMs: Math.min(ASK_WAIT_MS, remaining(ctx) - 3000), signal: ctx.signal });
      checkpoint(ctx);
      const out = askOutcome(answer, `open ${key}`);
      if (out) { if (answer !== 'cancelled') env.policy.refuse(refKey); return out; }
      env.policy.grantLocal(sid, key);
    }
  }
  const prefs = await env.settings.read();
  checkpoint(ctx);
  if (prefs.useMyChrome && cls === 'public' && !env.policy.navGranted(sid, host)) {
    // My Chrome carries the person's real sign-ins: every new site asks (spec §1).
    const refKey = `${sid}|nav|${host}`;
    if (env.policy.isRefused(refKey)) return err(`The user already declined opening ${host} in their Chrome a moment ago. Don't retry.`);
    const answer = await env.service.ask(sid, {
      kind: 'site', host, allowAlways: false,
      message: `The assistant wants to open ${host} in your Chrome, where you're signed in.`,
    }, { timeoutMs: Math.min(ASK_WAIT_MS, remaining(ctx) - 3000), signal: ctx.signal });
    checkpoint(ctx);
    const out = askOutcome(answer, `open ${host} in their Chrome`);
    if (out) { if (answer !== 'cancelled') env.policy.refuse(refKey); return out; }
    env.policy.grantNav(sid, host);
    env.policy.grantSite(sid, host);
  }
  let page: Page;
  try {
    const existing = a.newTab ? null : await env.service.activePage(sid, false);
    checkpoint(ctx);
    if (!existing) receipt(ctx, 'Tab creation attempted; navigation not attempted.');
    page = existing ?? await env.service.newPage(sid, () => checkpoint(ctx));
    if (ctx.receipt) ctx.receipt.page = page;
    checkpoint(ctx);
  } catch (e) {
    if (e instanceof BrowserCallLifecycleError) throw e;
    if (e instanceof BrowserUnavailableError && e.code === 'no-browser') return offerDownload(env, ctx);
    return err(e instanceof BrowserUnavailableError ? e.message : `The browser couldn't start: ${firstLine(e)}`);
  }
  checkpoint(ctx); invalidate(page);
  if (legacyZoom !== undefined) {
    receipt(ctx, 'Zoom attempted; navigation not attempted.', page);
    const pct = applyZoom(env, sid, legacyZoom); if (typeof pct !== 'number') return pct;
    checkpoint(ctx);
  }
  let lead = 'Navigation opened.';
  let failed = false;
  const budget = Math.max(1, Math.min(NAV_TIMEOUT_MS, remaining(ctx) - 15_000));
  receipt(ctx, 'Navigation attempted; outcome uncertain.', page);
  try {
    const resp = await page.goto(url, { timeout: budget, waitUntil: 'domcontentloaded' });
    if (resp && resp.status() >= 400) { lead = `Navigation http_error: HTTP ${resp.status()}.`; failed = true; }
  } catch (e) {
    const m = firstLine(e);
    failed = true;
    if (/ERR_BLOCKED_BY_CLIENT/.test(m)) lead = 'Navigation blocked: the browser stopped this page from opening (see Notes).';
    else if (/Timeout/i.test(m)) lead = `Navigation loading: did not finish within this call's ${budget / 1000}-second navigation budget; this is what has arrived so far.`;
    else lead = `Navigation failed opening ${url}: ${m}`;
  }
  receipt(ctx, lead, page);
  checkpoint(ctx);
  const result = await pageReport(env, ctx, page, { lead });
  return { ...result, isError: result.isError || failed };
}

async function snapshot(env: RunnerEnv, ctx: RunCtx, a: BrowserToolArgs<'BrowserSnapshot'>): Promise<RunResult> {
  const page = await getPage(env, ctx, false); if (!('goto' in page)) return page;
  return pageReport(env, ctx, page, { from: a.from });
}

async function act(env: RunnerEnv, ctx: RunCtx, a: BrowserToolArgs<'BrowserAct'>): Promise<RunResult> {
  const sid = ctx.sessionId;
  const blocked = blockedByUser(env, ctx); if (blocked) return blocked;
  const page = await getPage(env, ctx, false); if (!('goto' in page)) return page;

  const locator = a.ref ? page.getByRef(a.ref) : null;
  let info: ElementInfo | null = null;
  try {
    // A ref from an older outline resolves to nothing at once; say so instead
    // of waiting out the action timeout.
    if (locator && (await locator.count()) === 0) return err(wrapUntrusted('browser', mapActionError(new Error('ref not found'), a.ref)));
    info = await elementInfo(locator ? { kind: 'locator', locator } : { kind: 'page', page }, 5000);
  } catch (e) {
    return err(wrapUntrusted('browser', mapActionError(e, a.ref)));
  }
  const host = hostOf(page.url()).toLowerCase();
  const frameHost = info?.frameUrl ? hostOf(info.frameUrl).toLowerCase() : host;
  const where = frameHost && frameHost !== host ? `${host} (in a part of the page from ${frameHost})` : host;
  const label = info?.name ? `"${info.name.slice(0, 80)}"` : (a.element ? `"${a.element.slice(0, 80)}"` : 'an element');
  const verb = a.action === 'type' ? `type into ${label}` : a.action === 'select' ? `choose in ${label}` : a.action === 'press_key' ? `press ${a.key}` : a.action === 'hover' ? `hover over ${label}` : a.action === 'double_click' ? `double-click ${label}` : `click ${label}`;

  let askedFinal = false;
  if (a.action !== 'hover') {
    const enter = a.action === 'press_key' && /^(Enter|NumpadEnter)$/i.test(a.key ?? '');
    const final = (a.action !== 'press_key' || enter) && isFinalStep(a.action, info, !!a.submit);
    askedFinal = final;
    const refKey = `${sid}|act|${host}|${a.action}|${info?.name ?? a.ref}`;
    if (env.policy.isRefused(refKey)) return err(`The user already declined or didn't answer this exact step a moment ago. Don't retry — ask them in chat.`);
    const prefs = await env.settings.read();
    checkpoint(ctx);
    if (final) {
      const answer = await env.service.ask(sid, {
        kind: 'final', host,
        message: `The assistant wants to ${verb} on ${where}.`,
      }, { timeoutMs: Math.min(ASK_WAIT_MS, remaining(ctx) - 3000), signal: ctx.signal });
      checkpoint(ctx);
      const out = askOutcome(answer, `${verb} on ${host}`);
      if (out) { if (answer !== 'cancelled') env.policy.refuse(refKey); return out; }
      env.policy.grantSite(sid, host); // allowing a final step implies the site
    } else if (!env.policy.siteGranted(sid, host) && !(prefs.alwaysAllowedSites.includes(host) && !prefs.useMyChrome)) {
      const answer = await env.service.ask(sid, {
        kind: 'site', host, allowAlways: !prefs.useMyChrome,
        message: prefs.useMyChrome
          ? `Let the assistant click and type on ${where} in your Chrome, where you're signed in?`
          : `Let the assistant click and type on ${where}?`,
      }, { timeoutMs: Math.min(ASK_WAIT_MS, remaining(ctx) - 3000), signal: ctx.signal });
      checkpoint(ctx);
      const out = askOutcome(answer, `click and type on ${host}`);
      if (out) { if (answer !== 'cancelled') env.policy.refuse(refKey); return out; }
      env.policy.grantSite(sid, host);
      if (answer === 'allow_always' && !prefs.useMyChrome) await env.settings.allowSite(host);
    }
  }
  // Re-check where we are right before acting (review 1 #13): a redirect or a
  // script may have moved the page while the person was deciding.
  if (hostOf(page.url()).toLowerCase() !== host) {
    return err(`The page moved to ${hostOf(page.url())} while waiting, so nothing was done. Take a new outline.`);
  }
  // …and the element itself: a step that became a final step while the person
  // was answering (the page changed its words) is not done (code review F11).
  if (a.action !== 'hover' && !askedFinal) {
    try {
      const again = await elementInfo(locator ? { kind: 'locator', locator } : { kind: 'page', page }, 3000);
      const enterNow = a.action === 'press_key' && /^(Enter|NumpadEnter)$/i.test(a.key ?? '');
      if ((a.action !== 'press_key' || enterNow) && isFinalStep(a.action, again, !!a.submit)) {
        return err(wrapUntrusted('browser', `The element changed to "${again.name.slice(0, 80)}" while waiting — that now looks like a final step, so nothing was done. Take a new outline and try again.`));
      }
    } catch (e) { return err(wrapUntrusted('browser', mapActionError(e, a.ref))); }
  }
  checkpoint(ctx);
  const handoff = blockedByUser(env, ctx); if (handoff) return handoff;
  const t = Math.max(1, Math.min(ACTION_TIMEOUT_MS, remaining(ctx)));
  invalidate(page);
  receipt(ctx, a.action === 'type' ? 'Text fill attempted; outcome uncertain; Enter not attempted.' : `Action attempted (${verb}); outcome uncertain.`, page);
  try {
    switch (a.action) {
      case 'click': await locator!.click({ timeout: t }); break;
      case 'double_click': await locator!.dblclick({ timeout: t }); break;
      case 'hover': await locator!.hover({ timeout: t }); break;
      case 'type':
        await locator!.fill(a.text!, { timeout: t });
        receipt(ctx, 'Text filled; Enter not attempted.', page);
        // WHY: fill may settle after cancellation/deadline; Enter is a separate mutation.
        checkpoint(ctx);
        if (a.submit) {
          const blocked = blockedByUser(env, ctx); if (blocked) return err(wrapUntrusted('browser', `${receiptText(env, ctx)}\n${blocked.text}`));
          receipt(ctx, 'Text filled; Enter attempted; submission outcome uncertain.', page);
          await locator!.press('Enter', { timeout: Math.max(1, Math.min(t, remaining(ctx))) });
        }
        break;
      case 'select': await locator!.selectOption(a.values!, { timeout: t }); break;
      case 'press_key':
        if (locator) await locator.press(a.key!, { timeout: t });
        else await page.keyboard.press(a.key!);
        break;
    }
  } catch (e) {
    if (e instanceof BrowserCallLifecycleError) throw e;
    return err(wrapUntrusted('browser', `${receiptText(env, ctx)}\n${firstLine(e)}\nCheck the current page before deciding what to do next; do not blindly repeat this action. Cancellation does not reverse dispatched events.`));
  }
  receipt(ctx, a.action === 'type' ? `Text filled; Enter ${a.submit ? 'dispatched (submission not verified)' : 'not attempted'}.` : `Action dispatched (${verb}); resulting effect not verified.`, page);
  checkpoint(ctx);
  await settle(page);
  const now = await env.service.activePage(sid, false) ?? page;
  const typed = a.action === 'type' ? (info?.isPassword ? ' (hidden text)' : '') : '';
  return pageReport(env, ctx, now, { lead: `Dispatched: ${verb}${typed}. ${ctx.receipt?.stage ?? ''}` });
}

async function screenshot(env: RunnerEnv, ctx: RunCtx, a: BrowserToolArgs<'BrowserScreenshot'>): Promise<RunResult> {
  const page = await getPage(env, ctx, false); if (!('goto' in page)) return page;
  if (!ctx.vision) {
    const r = await pageReport(env, ctx, page, { lead: 'This model can\'t view pictures, so here is the page outline instead.' });
    return r;
  }
  try {
    let clipNote = '';
    let clip: { x: number; y: number; width: number; height: number } | undefined;
    if (a.fullPage) {
      const dims = await page.evaluate(() => ({ w: document.documentElement.clientWidth, h: document.documentElement.scrollHeight }));
      if (dims.h > FULL_PAGE_MAX_PX) {
        clip = { x: 0, y: 0, width: dims.w, height: FULL_PAGE_MAX_PX };
        clipNote = ` The page is ${dims.h}px tall; the picture shows the top ${FULL_PAGE_MAX_PX}px.`;
      }
    }
    const buf = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: !!a.fullPage, clip, scale: 'css', timeout: 15_000 });
    const file = await env.service.screenshotPath(ctx.sessionId);
    await fs.promises.writeFile(file, buf);
    let title = '';
    try { title = await page.title(); } catch { /* closed */ }
    const notes = env.service.takeNotes(ctx.sessionId);
    const text = wrapUntrusted('browser', [`Screenshot of ${title ? `"${title}" · ` : ''}${page.url()}.${clipNote}`, ...notes.map((n) => `- ${n}`)].join('\n'));
    return { text, imagePath: file };
  } catch (e) {
    return err(`The screenshot didn't work: ${firstLine(e)}`);
  }
}

async function tabs(env: RunnerEnv, ctx: RunCtx, a: BrowserToolArgs<'BrowserTabs'>): Promise<RunResult> {
  const sid = ctx.sessionId;
  const list = async (lead?: string): Promise<RunResult> => {
    const pages = env.service.pages(sid);
    await refreshTitles(pages);
    const st = env.service.state(sid);
    if (!st.tabs.length) return { text: `${lead ? lead + '\n' : ''}This conversation has no browser tabs open.` };
    const lines = st.tabs.map((t) => `${t.index}${t.active ? ' (current)' : ''} · ${t.title} · ${t.url}`);
    return { text: wrapUntrusted('browser', [lead, ...lines].filter(Boolean).join('\n')) };
  };
  try {
    if (a.action !== 'list') {
      if (a.action === 'select') { const blocked = blockedByUser(env, ctx); if (blocked) return blocked; }
      checkpoint(ctx);
      for (const p of env.service.pages(sid)) invalidate(p);
      receipt(ctx, `Tab ${a.action} attempted; outcome uncertain.`);
    }
    switch (a.action) {
      case 'list': return list();
      case 'select': {
        if (a.index === undefined) return err('BrowserTabs select needs `index`.');
        const p = env.service.selectTab(sid, a.index);
        return pageReport(env, ctx, p, { lead: `Switched to tab ${a.index}.` });
      }
      case 'close': {
        if (a.index === undefined) return err('BrowserTabs close needs `index`.');
        await env.service.closeTab(sid, a.index);
        // WHY: closing the last tab is also an escape from a pending human step.
        if (!env.service.pages(sid).length) { checkpoint(ctx); await env.service.closeSession(sid); }
        return list(`Closed tab ${a.index}.`);
      }
      case 'close_all':
        // Each close is a separate mutation; cancellation cannot undo prior closes.
        for (const page of [...env.service.pages(sid)].reverse()) {
          checkpoint(ctx);
          const index = env.service.pages(sid).indexOf(page);
          if (index >= 0) await env.service.closeTab(sid, index);
        }
        checkpoint(ctx);
        if (env.service.pages(sid).length) return err('Some tabs remain open; closing them could not be confirmed. List tabs to inspect the current state.');
        await env.service.closeSession(sid);
        return { text: 'Closed all of this conversation\'s browser tabs.' };
    }
  } catch (e) {
    if (e instanceof BrowserCallLifecycleError) throw e;
    return err(e instanceof BrowserUnavailableError ? e.message : firstLine(e));
  }
}

async function waitFor(env: RunnerEnv, ctx: RunCtx, a: BrowserToolArgs<'BrowserWait'>): Promise<RunResult> {
  const page = await getPage(env, ctx, false); if (!('goto' in page)) return page;
  checkpoint(ctx);
  // WHY: zero means infinite in Playwright. Visibility filtering precedes first(),
  // so hidden duplicates cannot satisfy disappearance or mask an appearance.
  const cap = Math.max(1, Math.min(30_000, remaining(ctx) - 15_000));
  let lead = '';
  let failed = false;
  try {
    if (a.text !== undefined || a.textGone !== undefined) {
      const text = a.text ?? a.textGone!;
      const visible = page.getByText(text).filter({ visible: true }).first();
      await visible.waitFor({ state: a.text !== undefined ? 'visible' : 'hidden', timeout: cap });
      lead = a.text !== undefined ? `Condition met: "${text.slice(0, 80)}" has a visible match.` : `Condition met: "${text.slice(0, 80)}" has no visible matches.`;
    } else {
      const ms = Math.min(cap, (a.seconds ?? 2) * 1000);
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); ctx.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, ms);
        ctx.signal.addEventListener('abort', done, { once: true });
        if (ctx.signal.aborted) done();
      });
      lead = `Waited ${ms / 1000} seconds.`;
    }
    checkpoint(ctx);
  } catch (e) {
    if (e instanceof BrowserCallLifecycleError) throw e;
    failed = true;
    lead = /Timeout/i.test(firstLine(e))
      ? `Condition timeout within ${cap / 1000} seconds: ${a.text !== undefined ? 'no visible match appeared for' : 'visible matches remain for'} "${(a.text ?? a.textGone ?? '').slice(0, 80)}". This does not prove an earlier action failed; do not blindly repeat it.`
      : `Waiting failed: ${firstLine(e)}`;
  }
  const result = await pageReport(env, ctx, page, { lead });
  return { ...result, isError: result.isError || failed };
}

async function askUser(env: RunnerEnv, ctx: RunCtx, a: BrowserToolArgs<'BrowserAskUser'>): Promise<RunResult> {
  const sid = ctx.sessionId;
  const wait = Math.min(ASK_WAIT_MS, remaining(ctx) - 3000);
  checkpoint(ctx);
  const open = env.service.openPrompt(sid);
  if (open?.kind === 'handoff' && open.message !== a.message) return err('A different BrowserAskUser message is still pending. Repeat exactly the pending message to wait; use BrowserTabs close/close_all or Stop to withdraw it before making a different request.');
  const completed = env.service.consumeCompletedHandoff(sid, a.message);
  const answer = completed?.answer ?? await (open?.kind === 'handoff'
    ? env.service.waitForOpenPrompt(sid, { timeoutMs: wait, signal: ctx.signal })!
    : env.service.ask(sid, { kind: 'handoff', message: a.message }, { timeoutMs: wait, signal: ctx.signal }));
  checkpoint(ctx);
  env.service.markUsed(sid);
  // (A window shown just for this hand-off is hidden again by the service
  // whenever the hand-off ends — browser-service.ts endWindowOverride.)
  if (answer === 'done') {
    const page = await env.service.activePage(sid, false);
    if (!page) return { text: 'The user says they\'re done. No tab is open now.' };
    return pageReport(env, ctx, page, { lead: 'The user says they\'re done. Here is the page now.' });
  }
  if (answer === 'cant') return err('The user says they can\'t do this step. Ask them in chat how they\'d like to continue.');
  if (answer === 'timeout') return { text: 'Still waiting for the user — your request is still showing to them. Call BrowserAskUser again with the same message to keep waiting, or say something in chat.' };
  return err('The request was withdrawn (the browser stopped or the conversation\'s tabs closed).');
}

// ── navigation guard ─────────────────────────────────────────────────────────

/** May a page or embedded page (iframe) load this address? Home-network
 *  addresses need this conversation's approval (asked by BrowserNavigate);
 *  metadata/link-local never. A tab no conversation owns yet gets no private
 *  address at all. Requests a page's scripts and images make are not covered
 *  (stated in the spec): only documents, which carry readable page text. */
export async function navigationVerdict(env: RunnerEnv, sessionId: string | null, url: string): Promise<'allow' | 'block'> {
  if (!/^https?:/i.test(url)) {
    // WHY an allow-list (2026-10-30 audit B4): this used to wave EVERY non-web address through "because it has no network
    // address" — which also let file: (the person's own files), data:, view-source: and browser-internal pages load in a tab.
    // Only what a normal page needs stays: an empty page, a page's own embedded document, a blob it made itself, and
    // Chromium's error page. (The model and the address box already refuse these; this is the second wall.)
    if (/^(about:blank|about:srcdoc|blob:|chrome-error:)/i.test(url.trim())) return 'allow';
    if (sessionId) env.service.addNote(sessionId, 'The browser stopped the page (or a part of it) from loading a local or special address (file:, data: or a browser-internal page). Only web addresses are opened.');
    return 'block';
  }
  const cls = await classifyUrl(url, env.policy.lookup);
  if (cls === 'public') return 'allow';
  const key = hostPortKey(url);
  if (cls === 'private' && sessionId && env.policy.localGranted(sessionId, key)) return 'allow';
  if (sessionId) {
    env.service.addNote(sessionId, cls === 'never'
      ? `The browser stopped the page (or a part of it) from loading ${key}, a special network address that is never opened.`
      : `The browser stopped the page (or a part of it) from loading ${key}, an address on this computer or the home network. To open it, use BrowserNavigate with that address — the user will be asked.`);
  }
  return 'block';
}

/** My Chrome only: the same check for one of the assistant's tabs, through CDP
 *  Fetch on Document requests (main page AND iframes). A browser-wide route
 *  would also intercept the person's own tabs. Awaited before the tab loads. */
export async function installNavigationGuard(env: RunnerEnv, sessionId: string, page: Page): Promise<void> {
  try {
    const cdp = await page.context().newCDPSession(page);
    cdp.on('Fetch.requestPaused', (ev: { requestId: string; request: { url: string } }) => {
      void (async () => {
        const verdict = await navigationVerdict(env, sessionId, ev.request.url).catch(() => 'block' as const);
        if (verdict === 'allow') await cdp.send('Fetch.continueRequest', { requestId: ev.requestId }).catch(() => undefined);
        else await cdp.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'BlockedByClient' }).catch(() => undefined);
      })();
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
  } catch {
    // The tab closed before the guard attached — nothing to guard.
  }
}

// ── the person browsing from the panel ───────────────────────────────────────

/** Open what the person typed in the panel's address box. Their own choice of
 *  address, so a home-network address needs no card (it is granted for this
 *  chat, for the assistant too — the person put it there); a never-openable
 *  one is still refused. */
export async function openForPerson(env: RunnerEnv, sessionId: string, typed: string): Promise<{ ok: boolean; error?: string }> {
  const url = personAddress(typed);
  if (!url) return { ok: false, error: 'That address can\'t be opened here. Use a web address starting with http or https.' };
  const cls = await classifyUrl(url, env.policy.lookup).catch(() => 'public' as const);
  if (cls === 'never') return { ok: false, error: 'That address is a special network address the browser never opens.' };
  if (cls === 'private') env.policy.grantLocal(sessionId, hostPortKey(url));
  try {
    await env.service.personOpen(sessionId, url);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof BrowserUnavailableError ? err.message : `Couldn't open that page: ${firstLine(err)}` };
  }
}

// ── entry point ──────────────────────────────────────────────────────────────

/** Validate and run one Browser tool for one conversation. Never throws. */
export async function runBrowserTool(env: RunnerEnv, name: string, rawArgs: unknown, ctx: RunCtx): Promise<RunResult> {
  const validated = validateBrowserRequest(name, rawArgs);
  if ('error' in validated) return err(validated.error);
  const op = validated.operation;
  observeTabChanges(env.service);
  const deadline = ctx.deadline ?? Date.now() + CALL_DEADLINE_MS;
  const expiry = new AbortController();
  const timer = setTimeout(() => expiry.abort(), Math.max(0, deadline - Date.now()));
  const c: RunCtx = { ...ctx, deadline, signal: AbortSignal.any([ctx.signal, expiry.signal]), receipt: { stage: 'Operation not attempted.' } };
  try {
    return await env.service.withSession(ctx.sessionId, async () => {
      checkpoint(c);
      env.service.markUsed(ctx.sessionId);
      const dispatch = async (): Promise<RunResult> => {
        switch (op.name) {
          case 'BrowserNavigate': return navigate(env, c, op.args, validated.legacyZoom);
          case 'BrowserHistory': return history(env, c, op.args);
          case 'BrowserZoom': return zoom(env, c, op.args);
          case 'BrowserSnapshot': return snapshot(env, c, op.args);
          case 'BrowserAct': return act(env, c, op.args);
          case 'BrowserScreenshot': return screenshot(env, c, op.args);
          case 'BrowserTabs': return tabs(env, c, op.args);
          case 'BrowserWait': return waitFor(env, c, op.args);
          case 'BrowserAskUser': return askUser(env, c, op.args);
        }
      };
      const result = await dispatch();
      if (result.isError && !result.text.includes(c.receipt!.stage)) return { ...result, text: `${result.text}\n${wrapUntrusted('browser', receiptText(env, c))}` };
      return result;
    }, { signal: ctx.signal, deadline: c.deadline });
  } catch (e) {
    if (e instanceof BrowserCallLifecycleError) return err(wrapUntrusted('browser', `${e.message}\n${receiptText(env, c)}\nCancellation does not reverse already-dispatched events.`));
    return err(wrapUntrusted('browser', `The browser tool failed: ${firstLine(e)}\n${receiptText(env, c)}`));
  } finally { clearTimeout(timer); }
}
