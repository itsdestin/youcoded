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
import { BROWSER_TOOL_SPECS, type BrowserToolName, type BrowserToolArgs } from './browser-tool-specs';
import { BrowserService, BrowserUnavailableError, firstLine, hostOf, refreshTitles, type PromptAnswer } from './browser-service';
import type { BrowserSettings } from './browser-settings';
import type { BrowserInstaller } from './browser-installer';
import { classifyUrl, hostPortKey, normaliseAddress, type LookupFn } from './browser-net';
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
    const label = (e.getAttribute('aria-label') || (e.innerText || '').trim() || (typeof e.value === 'string' ? e.value : '') || e.getAttribute('title') || e.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 120);
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
  let outline = '';
  try {
    outline = await page.ariaSnapshot({ mode: 'ai', timeout: Math.min(15_000, Math.max(2000, remaining(ctx) - 1000)) });
  } catch (e) {
    outline = `(The page outline couldn't be read: ${firstLine(e)})`;
  }
  const from = Math.min(opts.from ?? 0, outline.length);
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
  lines.push(from > 0 ? `Page outline (from character ${from}):` : 'Page outline:', slice || '(empty page)');
  if (end < outline.length) {
    lines.push(`[The outline continues: showed characters ${from}–${end} of ${outline.length}. Call BrowserSnapshot with from=${end} for the next part.]`);
  }
  return { text: wrapUntrusted('browser', lines.join('\n')) };
}

/** The conversation's page, starting the browser (or offering a download) as needed. */
async function getPage(env: RunnerEnv, ctx: RunCtx, create: boolean): Promise<Page | RunResult> {
  try {
    const p = await env.service.activePage(ctx.sessionId, create);
    if (!p) {
      const last = env.service.lastUrls(ctx.sessionId);
      return err(last.length
        ? `No tab is open in this conversation (the browser closed; the last page was ${last[last.length - 1]}). Open it again with BrowserNavigate.`
        : 'No tab is open in this conversation. Open a page with BrowserNavigate first.');
    }
    return p;
  } catch (e) {
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
    message: 'The assistant needs a browser for this. YouCoded can download one for it (about 150 MB, kept inside YouCoded).',
  }, { timeoutMs: wait, signal: ctx.signal });
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
    return err('The user is doing a step in the browser right now (your BrowserAskUser request is still showing). Call BrowserAskUser again with the same message to wait for them.');
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
  if (answer === 'timeout') return err(`The user didn't answer the request to ${what} (they may not be at the computer). It was NOT done. Don't retry it — ask them in chat.`);
  if (answer === 'cancelled') return err(`The request to ${what} was withdrawn (the browser stopped or the tabs closed). It was NOT done.`);
  if (answer === 'no') return err(`The user declined: they don't want you to ${what}. It was NOT done. Don't retry it.`);
  return null;
}

// ── the tools ────────────────────────────────────────────────────────────────

async function navigate(env: RunnerEnv, ctx: RunCtx, a: BrowserToolArgs<'BrowserNavigate'>): Promise<RunResult> {
  const sid = ctx.sessionId;
  const blocked = blockedByUser(env, ctx); if (blocked) return blocked;
  if (!a.url && !a.go) return err('Give BrowserNavigate a url, or go: "back"/"forward".');
  if (a.go) {
    const page = await getPage(env, ctx, false); if (!('goto' in page)) return page;
    try {
      const r = a.go === 'back' ? await page.goBack({ timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' }) : await page.goForward({ timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
      return pageReport(env, ctx, page, { lead: r ? undefined : `There was no page to go ${a.go} to.` });
    } catch (e) { return err(mapActionError(e, undefined)); }
  }
  let url: string;
  try { url = normaliseAddress(a.url!); } catch (e) { return err((e as Error).message); }
  const host = hostOf(url).toLowerCase();
  const cls = await classifyUrl(url, env.policy.lookup);
  if (cls === 'never') return err(`${host} is a special network address (cloud-metadata or link-local) that the browser never opens.`);
  if (cls === 'private') {
    const key = hostPortKey(url);
    if (!env.policy.localGranted(sid, key)) {
      const refKey = `${sid}|local|${key}`;
      if (env.policy.isRefused(refKey)) return err(`The user already declined opening ${key} a moment ago. Don't retry — ask them in chat.`);
      const answer = await env.service.ask(sid, {
        kind: 'local', host: key,
        message: `The assistant wants to open ${key}, an address on this computer or your home network.`,
      }, { timeoutMs: Math.min(ASK_WAIT_MS, remaining(ctx) - 3000), signal: ctx.signal });
      const out = askOutcome(answer, `open ${key}`);
      if (out) { if (answer !== 'cancelled') env.policy.refuse(refKey); return out; }
      env.policy.grantLocal(sid, key);
    }
  }
  const prefs = await env.settings.read();
  if (prefs.useMyChrome && cls === 'public' && !env.policy.navGranted(sid, host)) {
    // My Chrome carries the person's real sign-ins: every new site asks (spec §1).
    const refKey = `${sid}|nav|${host}`;
    if (env.policy.isRefused(refKey)) return err(`The user already declined opening ${host} in their Chrome a moment ago. Don't retry.`);
    const answer = await env.service.ask(sid, {
      kind: 'site', host, allowAlways: false,
      message: `The assistant wants to open ${host} in your Chrome, where you're signed in.`,
    }, { timeoutMs: Math.min(ASK_WAIT_MS, remaining(ctx) - 3000), signal: ctx.signal });
    const out = askOutcome(answer, `open ${host} in their Chrome`);
    if (out) { if (answer !== 'cancelled') env.policy.refuse(refKey); return out; }
    env.policy.grantNav(sid, host);
    env.policy.grantSite(sid, host);
  }
  let page: Page;
  try {
    const existing = a.newTab ? null : await env.service.activePage(sid, false);
    page = existing ?? await env.service.newPage(sid);
  } catch (e) {
    if (e instanceof BrowserUnavailableError && e.code === 'no-browser') return offerDownload(env, ctx);
    return err(e instanceof BrowserUnavailableError ? e.message : `The browser couldn't start: ${firstLine(e)}`);
  }
  let lead: string | undefined;
  try {
    const resp = await page.goto(url, { timeout: Math.min(NAV_TIMEOUT_MS, remaining(ctx) - 15_000), waitUntil: 'domcontentloaded' });
    if (resp && resp.status() >= 400) lead = `The site answered with an error (HTTP ${resp.status()}).`;
  } catch (e) {
    const m = firstLine(e);
    if (/ERR_BLOCKED_BY_CLIENT/.test(m)) lead = 'The browser stopped this page from opening (see Notes).';
    else if (/Timeout/i.test(m)) lead = 'The page is still loading after 30 seconds; this is what has arrived so far.';
    else return err(`Couldn't open ${url}: ${m}`);
  }
  await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => undefined);
  return pageReport(env, ctx, page, { lead });
}

async function snapshot(env: RunnerEnv, ctx: RunCtx, a: BrowserToolArgs<'BrowserSnapshot'>): Promise<RunResult> {
  const page = await getPage(env, ctx, false); if (!('goto' in page)) return page;
  return pageReport(env, ctx, page, { from: a.from });
}

async function act(env: RunnerEnv, ctx: RunCtx, a: BrowserToolArgs<'BrowserAct'>): Promise<RunResult> {
  const sid = ctx.sessionId;
  const blocked = blockedByUser(env, ctx); if (blocked) return blocked;
  const page = await getPage(env, ctx, false); if (!('goto' in page)) return page;
  if (a.action !== 'press_key' && !a.ref) return err(`BrowserAct ${a.action} needs a ref from the latest outline.`);
  if (a.action === 'type' && typeof a.text !== 'string') return err('BrowserAct type needs `text`.');
  if (a.action === 'select' && !a.values?.length) return err('BrowserAct select needs `values`.');
  if (a.action === 'press_key' && !a.key) return err('BrowserAct press_key needs `key`.');

  const locator = a.ref ? page.getByRef(a.ref) : null;
  let info: ElementInfo | null = null;
  try {
    // A ref from an older outline resolves to nothing at once; say so instead
    // of waiting out the action timeout.
    if (locator && (await locator.count()) === 0) return err(mapActionError(new Error('ref not found'), a.ref));
    info = await elementInfo(locator ? { kind: 'locator', locator } : { kind: 'page', page }, 5000);
  } catch (e) {
    return err(mapActionError(e, a.ref));
  }
  const host = hostOf(page.url()).toLowerCase();
  const frameHost = info?.frameUrl ? hostOf(info.frameUrl).toLowerCase() : host;
  const where = frameHost && frameHost !== host ? `${host} (in a part of the page from ${frameHost})` : host;
  const label = info?.name ? `"${info.name.slice(0, 80)}"` : (a.element ? `"${a.element.slice(0, 80)}"` : 'an element');
  const verb = a.action === 'type' ? `type into ${label}` : a.action === 'select' ? `choose in ${label}` : a.action === 'press_key' ? `press ${a.key}` : `click ${label}`;

  if (a.action !== 'hover') {
    const enter = a.action === 'press_key' && /^(Enter|NumpadEnter)$/i.test(a.key ?? '');
    const final = (a.action !== 'press_key' || enter) && isFinalStep(a.action, info, !!a.submit);
    const refKey = `${sid}|act|${host}|${a.action}|${info?.name ?? a.ref}`;
    if (env.policy.isRefused(refKey)) return err(`The user already declined or didn't answer this exact step a moment ago. Don't retry — ask them in chat.`);
    const prefs = await env.settings.read();
    if (final) {
      const answer = await env.service.ask(sid, {
        kind: 'final', host,
        message: `The assistant wants to ${verb} on ${where}.`,
      }, { timeoutMs: Math.min(ASK_WAIT_MS, remaining(ctx) - 3000), signal: ctx.signal });
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
  const t = Math.min(ACTION_TIMEOUT_MS, Math.max(1000, remaining(ctx) - 5000));
  try {
    switch (a.action) {
      case 'click': await locator!.click({ timeout: t }); break;
      case 'double_click': await locator!.dblclick({ timeout: t }); break;
      case 'hover': await locator!.hover({ timeout: t }); break;
      case 'type':
        await locator!.fill(a.text!, { timeout: t });
        if (a.submit) await locator!.press('Enter', { timeout: t });
        break;
      case 'select': await locator!.selectOption(a.values!, { timeout: t }); break;
      case 'press_key':
        if (locator) await locator.press(a.key!, { timeout: t });
        else await page.keyboard.press(a.key!);
        break;
    }
  } catch (e) {
    return err(mapActionError(e, a.ref));
  }
  await settle(page);
  const now = await env.service.activePage(sid, false) ?? page;
  const typed = a.action === 'type' ? (info?.isPassword ? ' (hidden text)' : '') : '';
  return pageReport(env, ctx, now, { lead: `Done: ${verb}${typed}.` });
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
        return list(`Closed tab ${a.index}.`);
      }
      case 'close_all':
        await env.service.closeSession(sid);
        return { text: 'Closed all of this conversation\'s browser tabs.' };
    }
  } catch (e) {
    return err(e instanceof BrowserUnavailableError ? e.message : firstLine(e));
  }
}

async function waitFor(env: RunnerEnv, ctx: RunCtx, a: BrowserToolArgs<'BrowserWait'>): Promise<RunResult> {
  const page = await getPage(env, ctx, false); if (!('goto' in page)) return page;
  const cap = Math.max(0, Math.min(30_000, remaining(ctx) - 15_000));
  let lead = '';
  try {
    if (a.text) {
      await page.getByText(a.text).first().waitFor({ state: 'visible', timeout: cap });
      lead = `"${a.text.slice(0, 80)}" is on the page.`;
    } else if (a.textGone) {
      await page.getByText(a.textGone).first().waitFor({ state: 'hidden', timeout: cap });
      lead = `"${a.textGone.slice(0, 80)}" is gone.`;
    } else {
      const ms = Math.min(cap, (a.seconds ?? 2) * 1000);
      await new Promise<void>((r) => { const t = setTimeout(r, ms); ctx.signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
      lead = `Waited ${Math.round(ms / 1000)} seconds.`;
    }
  } catch (e) {
    lead = /Timeout/i.test(firstLine(e)) ? `Still not there after ${Math.round(cap / 1000)} seconds.` : `Waiting stopped: ${firstLine(e)}`;
  }
  return pageReport(env, ctx, page, { lead });
}

async function askUser(env: RunnerEnv, ctx: RunCtx, a: BrowserToolArgs<'BrowserAskUser'>): Promise<RunResult> {
  const sid = ctx.sessionId;
  const wait = Math.min(ASK_WAIT_MS, remaining(ctx) - 3000);
  const open = env.service.openPrompt(sid);
  const pending = open?.kind === 'handoff'
    ? env.service.waitForOpenPrompt(sid, { timeoutMs: wait, signal: ctx.signal })!
    : env.service.ask(sid, { kind: 'handoff', message: a.message.slice(0, 300) }, { timeoutMs: wait, signal: ctx.signal });
  env.service.markUsed(sid);
  const answer = await pending;
  if (answer === 'done' || answer === 'cant') {
    // A window shown just for this hand-off goes back to how the person set it.
    if (env.service.hasWindowOverride()) await env.service.setWindowOverride(null).catch(() => undefined);
  }
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

/** Stop a tab's MAIN-FRAME navigations (links, redirects, scripts) to an
 *  unapproved home-network address or a never-open address BEFORE the request
 *  is sent (design review 2 #5). CDP Fetch is enabled for Document requests
 *  only, so ordinary page resources (and the HTTP cache) are untouched.
 *  Requests a page's own scripts and images make are not covered (stated). */
export async function installNavigationGuard(env: RunnerEnv, sessionId: string, page: Page): Promise<void> {
  try {
    const cdp = await page.context().newCDPSession(page);
    const tree = await cdp.send('Page.getFrameTree') as { frameTree: { frame: { id: string } } };
    const mainId = tree.frameTree.frame.id;
    cdp.on('Fetch.requestPaused', (ev: { requestId: string; frameId: string; request: { url: string } }) => {
      void (async () => {
        const cont = () => cdp.send('Fetch.continueRequest', { requestId: ev.requestId }).catch(() => undefined);
        const url = ev.request.url;
        if (ev.frameId !== mainId || !/^https?:/i.test(url)) return cont();
        const cls = await classifyUrl(url, env.policy.lookup);
        if (cls === 'public') return cont();
        const key = hostPortKey(url);
        if (cls === 'private' && env.policy.localGranted(sessionId, key)) return cont();
        env.service.addNote(sessionId, cls === 'never'
          ? `The browser stopped the page from going to ${key}, a special network address that is never opened.`
          : `The browser stopped the page from going to ${key}, an address on this computer or the home network. To open it, use BrowserNavigate with that address — the user will be asked.`);
        await cdp.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'BlockedByClient' }).catch(() => undefined);
      })();
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
  } catch {
    // The tab closed before the guard attached — nothing to guard.
  }
}

// ── entry point ──────────────────────────────────────────────────────────────

/** Validate and run one Browser tool for one conversation. Never throws. */
export async function runBrowserTool(env: RunnerEnv, name: string, rawArgs: unknown, ctx: RunCtx): Promise<RunResult> {
  if (!(name in BROWSER_TOOL_SPECS)) return err(`Unknown browser tool: ${name}`);
  const spec = BROWSER_TOOL_SPECS[name as BrowserToolName];
  const parsed = spec.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return err(`${name}: invalid input — ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`);
  }
  const c: RunCtx = { ...ctx, deadline: ctx.deadline ?? Date.now() + CALL_DEADLINE_MS };
  try {
    return await env.service.withSession(ctx.sessionId, async () => {
      if (remaining(c) < 5000) return err('The browser was busy with an earlier step for this conversation. Try again.');
      if (ctx.signal.aborted) return err('Canceled.');
      env.service.markUsed(ctx.sessionId);
      switch (name as BrowserToolName) {
        case 'BrowserNavigate': return navigate(env, c, parsed.data as BrowserToolArgs<'BrowserNavigate'>);
        case 'BrowserSnapshot': return snapshot(env, c, parsed.data as BrowserToolArgs<'BrowserSnapshot'>);
        case 'BrowserAct': return act(env, c, parsed.data as BrowserToolArgs<'BrowserAct'>);
        case 'BrowserScreenshot': return screenshot(env, c, parsed.data as BrowserToolArgs<'BrowserScreenshot'>);
        case 'BrowserTabs': return tabs(env, c, parsed.data as BrowserToolArgs<'BrowserTabs'>);
        case 'BrowserWait': return waitFor(env, c, parsed.data as BrowserToolArgs<'BrowserWait'>);
        case 'BrowserAskUser': return askUser(env, c, parsed.data as BrowserToolArgs<'BrowserAskUser'>);
      }
    });
  } catch (e) {
    return err(`The browser tool failed: ${firstLine(e)}`);
  }
}
