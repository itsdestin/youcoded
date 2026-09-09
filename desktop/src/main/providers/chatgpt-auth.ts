/**
 * Sign in with ChatGPT — the account (main process).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * One object owns everything about the signed-in ChatGPT account: the state
 * machine the Settings card and the first-run wizard read, the browser round
 * trip that signs the user in, the encrypted token pair and its renewal, the
 * plan-usage and model-list caches, and the `fetch` that puts the credential
 * on every request the model layer sends. `chatgpt-oauth.ts` holds the pure
 * maths and parsers; this file is the part with state, a port, a timer and a
 * keychain — every one of those injected so the tests drive it with no
 * network, no browser and no real 1455.
 *
 * Design: docs/active/specs/2026-09-05-chatgpt-signin-backend-design.md
 * (workspace repo) §2 data on disk, §3 the state machine, §4.1/4.3–4.6 the
 * request path. Tests: tests/chatgpt-auth.test.ts (every clause of §8's row).
 *
 * WHAT IS ON DISK (all in Electron's userData — never in ~/.youcoded, which
 * syncs across devices and could not decrypt the blob elsewhere anyway)
 *   native-secrets.json   one ref → safeStorage-encrypted JSON
 *                         { access_token, refresh_token, id_token, expires_at }
 *   chatgpt-account.json  { v, secretRef, accountId, email, plan, blocked?,
 *                           usage?, models? } — read-modified-written ONLY by
 *                         `mutate()` below, under the same lock cas-write uses
 *
 * TOKEN HYGIENE (load-bearing, same rule as github-auth.ts)
 * ---------------------------------------------------------
 * A token exists in this file only to be (a) decrypted from the store, (b) put
 * in an `authorization` header or a refresh body, or (c) encrypted back into
 * the store. It is never logged, never interpolated into an Error, never
 * written to any other file. Every catch below rethrows the original error or
 * a sentence built from a status code / OpenAI's own description — never from
 * a token. Grep this file for `access_token` / `refresh_token` before changing
 * an error or log line.
 */

import { currentChatGptRequest } from './chatgpt-request-diagnostics';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { randomBytes as nodeRandomBytes } from 'crypto';
import { safeStorage } from 'electron';
import type { CatalogModel } from '../../shared/provider-types';
import type { ChatGptAccountStatus, ChatGptUsage, ChatGptUsageWindow } from '../../shared/chatgpt-types';
import { mutateFileUnderLock } from '../artifacts/cas-write';
import type { SecretsStore } from './secrets-store';
import {
  CHATGPT_SIGN_IN_REQUIRED_MESSAGE,
  CHATGPT_TOKEN_URL,
  CHATGPT_USAGE_URL,
  FIVE_HOUR_MINUTES,
  SEVEN_DAY_MINUTES,
  accountFromTokens,
  blockedError,
  buildAuthorizeUrl,
  chatGptModelsUrl,
  classifyErrorBody,
  exchangeBody,
  expiredError,
  generatePkce,
  generateState,
  limitError,
  parseModelsManifest,
  parseUsageBody,
  parseUsageHeaders,
  refreshBody,
  toChatGptUsage,
  tokenExpiresAt,
  type ClassifiedError,
  type ParsedUsage,
  type RandomBytesFn,
} from './chatgpt-oauth';

// ---------------------------------------------------------------------------
// Constants and the sentences the user can see
// ---------------------------------------------------------------------------

export const CHATGPT_ACCOUNT_FILE = 'chatgpt-account.json';
/** Fixed by the redirect URI registered for the Codex client id (§3). */
export const CHATGPT_CALLBACK_PORT = 1455;
export const CHATGPT_CALLBACK_HOST = '127.0.0.1';
export const CHATGPT_CALLBACK_PATH = '/auth/callback';

/** The card's default (it has Cancel); the wizard passes 5 minutes (§9.1). */
export const DEFAULT_SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
/** How long the timed-out listener keeps answering its fixed page (§3). */
export const LINGER_MS = 60 * 1000;
/** Renew the access token when fewer than this remain (§3 accessToken). */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** The usage poll (§4.4): every five minutes while signed in … */
export const USAGE_POLL_MS = 5 * 60 * 1000;
/** … and at most once a minute when replies keep arriving. */
export const USAGE_DEBOUNCE_MS = 60 * 1000;
/** The model list is refreshed at most hourly (§4.3) … */
export const MODELS_MAX_AGE_MS = 60 * 60 * 1000;
/** … and a FAILED refresh is not retried for five minutes, so a dead network
 *  does not turn every `models()` call into another attempt. */
export const MODELS_RETRY_MS = 5 * 60 * 1000;
/** Hard cap on the code exchange and the token refresh: without it a stalled
 *  TLS connection would leave the card on "waiting" until the round's own
 *  timer, and a stalled refresh would hang a turn with no message at all. */
const TOKEN_REQUEST_TIMEOUT_MS = 30 * 1000;
/** Mirrors SecretsStore.mutate: five attempts of up to ~3 s each. */
const LOCK_MAX_RETRIES = 5;

export const CHATGPT_PORT_IN_USE_MESSAGE =
  'Port 1455 is already in use on this computer, so YouCoded cannot receive the sign-in. ' +
  'Close the other program using it (often the Codex CLI) and try again.';
/** SecretsStore's own sentence, verbatim (its `assertAvailable` is private).
 *  Pinned equal to what `SecretsStore.set` throws in tests/chatgpt-auth.test.ts,
 *  so the two cannot drift apart unnoticed. */
export const CHATGPT_KEYCHAIN_UNAVAILABLE_MESSAGE =
  'Secure key storage is not available on this system, so YouCoded cannot save API keys. (Your OS keychain/libsecret is required.)';
export const CHATGPT_LOCK_HELD_MESSAGE =
  "Could not update the ChatGPT sign-in — another YouCoded process is holding the account file's lock. Try again in a moment.";

/** The three fixed pages the browser tab can land on. Fixed text on purpose:
 *  the callback's query string is attacker-influenced (any local page can
 *  open http://localhost:1455/...), so nothing from it is ever echoed. */
export const CALLBACK_PAGE_DONE = 'You can close this tab and return to YouCoded.';
export const CALLBACK_PAGE_FAILED = 'Sign-in did not complete. You can close this tab and try again in YouCoded.';
export const CALLBACK_PAGE_TIMED_OUT = 'This sign-in timed out — go back to YouCoded and try again.';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** chatgpt-account.json (§2). `plan` is OpenAI's own string, overwritten by
 *  every usage poll that reports one. `usage` and `models` are caches so the
 *  card, the chips and the picker draw instantly on launch and offline. */
export interface ChatGptAccountFile {
  v: 1;
  secretRef: string;
  accountId: string;
  email: string;
  plan: string;
  blocked?: { reason: string; at: string };
  usage?: ChatGptUsage & { at: string };
  models?: { rows: CatalogModel[]; at: string };
}

/** What the secrets store holds under `secretRef`, as JSON. */
interface TokenBlob {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  /** ms epoch. */
  expires_at: number;
}

export type SignInOutcome = 'signed-in' | 'cancelled' | 'timed-out' | { error: string };

/** The slice of `http.IncomingMessage` / `http.ServerResponse` the callback
 *  handler touches, so a test may hand in a fake server as well as a real one. */
export interface CallbackRequest { method?: string; url?: string }
export interface CallbackResponse {
  writeHead(status: number, headers: Record<string, string>): unknown;
  end(body?: string): unknown;
}
export type CallbackHandler = (req: CallbackRequest, res: CallbackResponse) => void;

/** The slice of `http.Server` this module drives. */
export interface CallbackServerLike {
  close(cb?: (err?: Error) => void): unknown;
  closeAllConnections(): void;
  address(): { port: number } | string | null;
}

/** Binds a listener; resolves once it is listening, rejects with the bind
 *  error (`code: 'EADDRINUSE'` when the port is taken). Injected so a test
 *  can bind an ephemeral port instead of the real 1455. */
export type ListenFn = (port: number, host: string, handler: CallbackHandler) => Promise<CallbackServerLike>;

export interface TimerHandle { unref?: () => unknown }
export interface TimerFns {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(t: TimerHandle): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(t: TimerHandle): void;
}

export type LogFn = (level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void;

export interface ChatGptAuthDeps {
  userDataDir: string;
  secrets: SecretsStore;
  /** Sent as `client_version` on the models manifest (Phase 0, P0-3). */
  appVersion: string;
  /** `shell.openExternal` in production. */
  openExternal: (url: string) => Promise<void>;
  /** WHY this exists: the kill switch (YOUCODED_CHATGPT=0) must leave the
   *  feature genuinely inert, and the launch-time setup check still needs this
   *  object to READ the account file. Without a gate here the constructor would
   *  keep polling OpenAI every five minutes with a switched-off feature — and
   *  because that poll refreshes the token, a rejection would run clearAccount()
   *  and DELETE the user's saved sign-in. The switch is meant to be a fast
   *  revert, never a sign-out (review T4 F1). Defaults to on. */
  pollUsage?: boolean;
  fetch?: typeof fetch;
  listen?: ListenFn;
  isEncryptionAvailable?: () => boolean;
  now?: () => number;
  timers?: TimerFns;
  randomBytes?: RandomBytesFn;
  log?: LogFn;
}

// ---------------------------------------------------------------------------
// Default (real) adapters
// ---------------------------------------------------------------------------

const defaultListen = (port: number, host: string, handler: CallbackHandler, log: LogFn): Promise<CallbackServerLike> =>
  new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => handler(req, res));
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      // A post-bind 'error' is not seen in practice, but an unhandled one
      // would take the main process down with every open session.
      server.on('error', (err) => log('error', 'sign-in listener error', { reason: errorMessage(err) }));
      resolve(server);
    });
  });

const defaultTimers: TimerFns = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (t) => clearInterval(t as NodeJS.Timeout),
};

const defaultLog: LogFn = (level, message, meta) => {
  const line = `[chatgpt-auth] ${message}`;
  if (level === 'error') console.error(line, meta ?? '');
  else if (level === 'warn') console.warn(line, meta ?? '');
  else console.log(line, meta ?? '');
};

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function htmlPage(text: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>YouCoded</title>` +
    `<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#222;background:#fafafa}p{font-size:18px;max-width:32em;text-align:center;padding:0 1em}</style>` +
    `</head><body><p>${escapeHtml(text)}</p></body></html>`;
}

/** Every response the listener sends closes its connection — a keep-alive
 *  socket left open by the browser would otherwise hold port 1455 into the
 *  next sign-in (§3). */
function reply(res: CallbackResponse, status: number, text: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'close',
  });
  res.end(htmlPage(text));
}

function errorCode(e: unknown): string | undefined {
  return e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string'
    ? (e as { code: string }).code
    : undefined;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** The account file, or null for anything that is not one. A file that
 *  cannot name its secret cannot be signed in, so it reads as absent — the
 *  next callback rewrites it whole. */
function parseAccountFile(raw: string | null): ChatGptAccountFile | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (typeof parsed.secretRef !== 'string' || !parsed.secretRef) return null;
    if (typeof parsed.accountId !== 'string' || !parsed.accountId) return null;
    return parsed as unknown as ChatGptAccountFile;
  } catch {
    return null;
  }
}

function parseTokenBlob(raw: string | null): TokenBlob | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed.access_token !== 'string' || !parsed.access_token) return null;
    return {
      access_token: parsed.access_token,
      refresh_token: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : '',
      ...(typeof parsed.id_token === 'string' ? { id_token: parsed.id_token } : {}),
      expires_at: typeof parsed.expires_at === 'number' && Number.isFinite(parsed.expires_at) ? parsed.expires_at : 0,
    };
  } catch {
    return null;
  }
}

/** A window survives pruning unless its reset is a real time that has
 *  passed — byte for byte the rule in renderer/state/usage-snapshot.ts's
 *  `pruneExpiredUsage`, so main and the renderer cannot disagree about a bar. */
function windowIsLive(w: ChatGptUsageWindow | undefined, now: number): w is ChatGptUsageWindow {
  if (!w || w.utilization == null) return false;
  const t = w.resets_at ? Date.parse(w.resets_at) : NaN;
  return !(Number.isFinite(t) && t <= now);
}

/** The cache as the shape `classifyErrorBody` names windows from. */
function parsedFromCache(usage: ChatGptUsage | undefined): ParsedUsage | null {
  if (!usage) return null;
  const windows: ParsedUsage['windows'] = [];
  if (usage.five_hour) windows.push({ minutes: FIVE_HOUR_MINUTES, usedPercent: usage.five_hour.utilization, resetsAt: usage.five_hour.resets_at });
  if (usage.seven_day) windows.push({ minutes: SEVEN_DAY_MINUTES, usedPercent: usage.seven_day.utilization, resetsAt: usage.seven_day.resets_at });
  for (const w of usage.other ?? []) windows.push({ minutes: w.minutes, usedPercent: w.utilization, resetsAt: w.resets_at });
  return windows.length ? { windows } : null;
}

/** Which window a limit classification is about, in minutes — the matched
 *  snapshot window when there was one, else read back out of the label. */
function limitWindowMinutes(c: Extract<ClassifiedError, { kind: 'limit' }>): number | null {
  if (c.windowMinutes !== undefined) return c.windowMinutes;
  if (c.windowLabel === '5-hour') return FIVE_HOUR_MINUTES;
  if (c.windowLabel === 'weekly') return SEVEN_DAY_MINUTES;
  const days = /^(\d+)-day$/.exec(c.windowLabel);
  return days ? Number(days[1]) * 1440 : null;
}

// ---------------------------------------------------------------------------
// The in-flight sign-in round
// ---------------------------------------------------------------------------

interface SignInRound {
  state: string;
  verifier: string;
  url: string;
  server: CallbackServerLike;
  timer: TimerHandle | null;
  /** The generation this round belongs to; the callback's write no-ops when
   *  `generation` has moved past it (cancel or sign-out during the exchange). */
  generation: number;
  /** Set while the code exchange is on the wire: `status()` stays `waiting`
   *  and the round timer defers to the exchange's own result (§3). */
  exchanging: boolean;
  /** Set by the round timer. The same server keeps answering for LINGER_MS
   *  with the fixed timed-out page; nothing it receives can change state. */
  timedOut: boolean;
  waiters: Array<(o: SignInOutcome) => void>;
}

// ---------------------------------------------------------------------------
// ChatGptAuth
// ---------------------------------------------------------------------------

export class ChatGptAuth {
  private readonly file: string;
  private readonly secrets: SecretsStore;
  private readonly appVersion: string;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly realFetch: typeof fetch;
  private readonly listen: ListenFn;
  private readonly isEncryptionAvailable: () => boolean;
  private readonly now: () => number;
  private readonly timers: TimerFns;
  private readonly randomBytes: RandomBytesFn;
  private readonly log: LogFn;

  /** In-memory mirror of chatgpt-account.json. userData is per instance, so
   *  nothing else writes the file; `mutate()` keeps this equal to disk. */
  private account: ChatGptAccountFile | null;
  /** Bumped by a NEW sign-in round, cancel and sign-out (§3). Every
   *  asynchronous write-back captures it first and no-ops when it moved. */
  private generation = 0;
  private round: SignInRound | null = null;
  /** A signIn() between its first await and the bind (F1): a second call in
   *  that window must join this one, not bind the same port and throw the
   *  "Codex CLI" sentence at the user while discarding the live round. */
  private starting: Promise<boolean> | null = null;
  /** The code exchange on the wire, so dispose() can wait for it (F2). */
  private exchangeInFlight: Promise<void> | null = null;
  /** The timed-out round's server while it answers its fixed page, and the
   *  timer that finally closes it. A fresh signIn() closes it before binding. */
  private lingering: { server: CallbackServerLike; timer: TimerHandle } | null = null;
  private lastOutcome: SignInOutcome | null = null;
  /** The single in-flight refresh (§3): concurrent steps share one request. */
  private refreshing: Promise<TokenBlob> | null = null;
  /** Serialises `mutate()` calls in this process, so the three writers never
   *  contend for the on-disk lock with each other — only with a crash's leftover. */
  private writeChain: Promise<unknown> = Promise.resolve();
  private pollTimer: TimerHandle | null = null;
  private debounceTimer: TimerHandle | null = null;
  private lastUsagePollAt = Number.NEGATIVE_INFINITY;
  private modelsRefresh: Promise<void> | null = null;
  private lastModelsAttemptAt = 0;
  /** False under the kill switch: no background traffic, no token refresh. */
  private readonly pollUsage: boolean;
  private disposed = false;

  constructor(deps: ChatGptAuthDeps) {
    this.file = path.join(deps.userDataDir, CHATGPT_ACCOUNT_FILE);
    this.secrets = deps.secrets;
    this.appVersion = deps.appVersion;
    this.openExternal = deps.openExternal;
    this.realFetch = deps.fetch ?? ((input, init) => fetch(input, init));
    this.listen = deps.listen ?? ((port, host, handler) => defaultListen(port, host, handler, this.log));
    this.isEncryptionAvailable = deps.isEncryptionAvailable ?? (() => safeStorage.isEncryptionAvailable());
    this.now = deps.now ?? (() => Date.now());
    this.timers = deps.timers ?? defaultTimers;
    this.randomBytes = deps.randomBytes ?? ((n) => nodeRandomBytes(n));
    this.log = deps.log ?? defaultLog;

    this.pollUsage = deps.pollUsage ?? true;

    this.account = this.readAccountSync();
    // §4.4: the poll starts with the process when an account is already
    // signed in, and the first poll runs at once (through the debounce, which
    // has nothing to wait for yet) so the bars are today's within seconds of
    // launch rather than in five minutes. Not under the kill switch: see
    // `pollUsage` above.
    if (this.pollUsage && this.isSignedIn()) {
      this.startPoll();
      this.schedulePollSoon();
    }
  }

  // ----- reads --------------------------------------------------------------

  /** Sync and cheap on purpose: the card polls this every second while
   *  waiting. It never decrypts — presence of the secret is enough (§3). */
  status(): ChatGptAccountStatus {
    // The phase flag is checked BEFORE the file so the card never flashes
    // "Not signed in" during the code exchange.
    if (this.round && !this.round.timedOut) return { state: 'waiting' };
    const a = this.account;
    if (!a || !this.secrets.has(a.secretRef)) return { state: 'signed-out' };
    if (a.blocked) return { state: 'blocked', email: a.email, reason: a.blocked.reason };
    return { state: 'signed-in', email: a.email, plan: a.plan, usage: this.usageForStatus() };
  }

  /** File present + secret present + not blocked. No decrypt. */
  isSignedIn(): boolean {
    const a = this.account;
    return !!a && !a.blocked && this.secrets.has(a.secretRef);
  }

  /** For the registry: throws the sentence the card renders when the model
   *  cannot be used — signed out, or OpenAI's own refusal when blocked. */
  signedInAccount(): { accountId: string; email: string; plan: string; authGeneration: number } {
    const a = this.account;
    if (!a || !this.secrets.has(a.secretRef)) throw new Error(CHATGPT_SIGN_IN_REQUIRED_MESSAGE);
    if (a.blocked) throw blockedError(a.blocked.reason);
    return { accountId: a.accountId, email: a.email, plan: a.plan, authGeneration: this.generation };
  }

  /** The cached windows with any whose reset has passed dropped — including
   *  the `other` list (the free plan's 30-day window lives there). Pure over
   *  the cache; null when nothing live remains. */
  usageForStatus(): ChatGptUsage | null {
    const u = this.account?.usage;
    if (!u) return null;
    const now = this.now();
    const out: ChatGptUsage = {};
    if (windowIsLive(u.five_hour, now)) out.five_hour = u.five_hour;
    if (windowIsLive(u.seven_day, now)) out.seven_day = u.seven_day;
    const other = (u.other ?? []).filter((w) => windowIsLive(w, now));
    if (other.length) out.other = other;
    return Object.keys(out).length ? out : null;
  }

  // ----- the sign-in round --------------------------------------------------

  /** Opens the browser and returns true as soon as it is asked to — not when
   *  the sign-in finishes (poll `status()` or await `waitForSignIn()`).
   *  Throws only for the two verified causes the card renders verbatim: the
   *  keychain is unavailable, or another PROGRAM holds port 1455. */
  async signIn(opts?: { timeoutMs?: number }): Promise<boolean> {
    // Already waiting: same round, same state, same timer — just re-open the
    // browser in case the user closed the tab (§3).
    if (this.round && !this.round.timedOut) {
      await this.openExternal(this.round.url);
      return true;
    }
    // A round is between its first await and its bind (a double-tap on the
    // button): join it. The first call opens the browser; a second open here
    // would be a second tab for the same round.
    if (this.starting) return this.starting;
    const p = this.startRound(opts).finally(() => { if (this.starting === p) this.starting = null; });
    this.starting = p;
    return p;
  }

  private async startRound(opts?: { timeoutMs?: number }): Promise<boolean> {
    // (1) Pre-flight the keychain BEFORE any browser opens: a store that
    // throws after the exchange would waste the user's whole sign-in.
    if (!this.isEncryptionAvailable()) throw new Error(CHATGPT_KEYCHAIN_UNAVAILABLE_MESSAGE);

    const { verifier, challenge } = generatePkce(this.randomBytes);
    const state = generateState(this.randomBytes);

    // (2) A timed-out round's server may still be up answering its page;
    // close it first so the EADDRINUSE sentence is only ever true of another
    // process (§3, pinned).
    await this.closeLingering();

    const round: SignInRound = {
      state, verifier, url: '', server: null as unknown as CallbackServerLike,
      timer: null, generation: 0, exchanging: false, timedOut: false, waiters: [],
    };
    try {
      round.server = await this.listen(CHATGPT_CALLBACK_PORT, CHATGPT_CALLBACK_HOST, (req, res) => this.onCallback(round, req, res));
    } catch (e) {
      if (errorCode(e) === 'EADDRINUSE') throw new Error(CHATGPT_PORT_IN_USE_MESSAGE);
      throw e;
    }

    // The generation moves only once the round is real: a bind that threw
    // must not discard a token refresh in flight for a still-signed-in account.
    this.generation += 1;
    round.generation = this.generation;
    this.lastOutcome = null;

    // (3) The URL, the browser, the phase flag, the timer.
    round.url = buildAuthorizeUrl({ state, challenge });
    this.round = round;
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_SIGN_IN_TIMEOUT_MS;
    round.timer = this.unref(this.timers.setTimeout(() => this.onRoundTimeout(round), timeoutMs));
    try {
      await this.openExternal(round.url);
    } catch (e) {
      // No browser, no sign-in: tear the round down and let the caller show
      // the real reason (it is Electron's own message, not a token).
      await this.finishRound(round, { error: `Could not open the browser: ${errorMessage(e)}` });
      throw e;
    }
    return true;
  }

  /** Resolved by the callback, `cancelSignIn()`, `signOut()` or the timer.
   *  With no round in flight it answers the last round's outcome. */
  waitForSignIn(): Promise<SignInOutcome> {
    if (this.round && !this.round.timedOut) {
      return new Promise((resolve) => this.round!.waiters.push(resolve));
    }
    return Promise.resolve(this.lastOutcome ?? (this.isSignedIn() ? 'signed-in' : 'cancelled'));
  }

  async cancelSignIn(): Promise<boolean> {
    const round = this.round;
    if (!round || round.timedOut) return true;
    this.generation += 1;
    await this.finishRound(round, 'cancelled');
    return true;
  }

  /** Never contacts OpenAI (no revoke endpoint is documented). Order is
   *  load-bearing: the SECRET goes first, then the file — an orphaned
   *  ciphertext blob would be unreachable forever, an orphaned account row is
   *  just re-deletable (§2, the same order ProviderRegistry.remove uses). */
  async signOut(): Promise<boolean> {
    this.generation += 1;
    if (this.round && !this.round.timedOut) await this.finishRound(this.round, 'cancelled');
    await this.closeLingering();
    await this.clearAccount();
    return true;
  }

  /** The four callback branches, in the order §3 fixes, and nothing else. */
  private onCallback(round: SignInRound, req: CallbackRequest, res: CallbackResponse): void {
    // The timed-out listener answers EVERY request with its fixed page; the
    // state is already signed-out and a late callback is ignored.
    if (round.timedOut) { reply(res, 200, CALLBACK_PAGE_TIMED_OUT); return; }

    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${CHATGPT_CALLBACK_HOST}`);
    } catch {
      reply(res, 404, CALLBACK_PAGE_FAILED);
      return;
    }
    // 1. Not GET /auth/callback → 404, no state change.
    if ((req.method ?? 'GET').toUpperCase() !== 'GET' || url.pathname !== CHATGPT_CALLBACK_PATH) {
      reply(res, 404, CALLBACK_PAGE_FAILED);
      return;
    }
    // 2. State missing or not ours → 400, no state change. A local page must
    //    not be able to cancel a waiting sign-in without knowing `state`.
    if (url.searchParams.get('state') !== round.state || this.round !== round) {
      reply(res, 400, CALLBACK_PAGE_FAILED);
      return;
    }
    // 3. OpenAI reported an error. Its `error_description` goes to the log
    //    and to waitForSignIn's { error } — never into the HTML.
    const err = url.searchParams.get('error');
    if (err) {
      const description = url.searchParams.get('error_description') || err;
      this.log('warn', 'sign-in callback carried an error', { error: err, description });
      reply(res, 200, CALLBACK_PAGE_FAILED);
      void this.finishRound(round, { error: description });
      return;
    }
    // 4. A code → exchange it. Second-arrival guard: one exchange per round.
    const code = url.searchParams.get('code');
    if (!code || round.exchanging) {
      reply(res, 400, CALLBACK_PAGE_FAILED);
      return;
    }
    round.exchanging = true;
    const p = this.exchange(round, code, res).finally(() => { if (this.exchangeInFlight === p) this.exchangeInFlight = null; });
    this.exchangeInFlight = p;
  }

  private async exchange(round: SignInRound, code: string, res: CallbackResponse): Promise<void> {
    const fail = async (page: string, outcome: SignInOutcome) => {
      reply(res, 200, page);
      await this.finishRound(round, outcome);
    };
    let tokens: { access_token: string; refresh_token: string; id_token?: string; expires_at: number };
    try {
      const r = await this.realFetch(CHATGPT_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: exchangeBody({ code, verifier: round.verifier }),
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });
      const json: unknown = await r.json().catch(() => null);
      if (!r.ok || !isRecord(json) || typeof json.access_token !== 'string') {
        // OpenAI's `error_description` is a sentence about the code, never a
        // token; it goes to the wizard and the log, not the page.
        const detail = isRecord(json) && typeof json.error_description === 'string' ? json.error_description : `HTTP ${r.status}`;
        this.log('warn', 'code exchange refused', { status: r.status, detail });
        await fail(CALLBACK_PAGE_FAILED, { error: `OpenAI did not accept the sign-in code (${detail}).` });
        return;
      }
      tokens = {
        access_token: json.access_token,
        refresh_token: typeof json.refresh_token === 'string' ? json.refresh_token : '',
        ...(typeof json.id_token === 'string' ? { id_token: json.id_token } : {}),
        expires_at: tokenExpiresAt(json.expires_in, this.now()),
      };
    } catch (e) {
      this.log('warn', 'code exchange failed', { reason: errorMessage(e) });
      await fail(CALLBACK_PAGE_FAILED, { error: `Could not reach OpenAI to finish the sign-in: ${errorMessage(e)}` });
      return;
    }

    // Cancelled or signed out while the exchange was on the wire: the fresh
    // pair is discarded — nothing is written, no account file appears.
    if (round.generation !== this.generation) {
      this.log('info', 'sign-in cancelled during the code exchange; tokens discarded');
      reply(res, 200, CALLBACK_PAGE_FAILED);
      return;
    }

    const claims = accountFromTokens({ accessToken: tokens.access_token, idToken: tokens.id_token });
    if (!claims) {
      this.log('warn', 'token carried no chatgpt_account_id; sign-in not recorded');
      await fail(CALLBACK_PAGE_FAILED, { error: 'OpenAI signed you in but reported no ChatGPT account for this login.' });
      return;
    }

    let secretRef: string;
    // A re-sign-in (IPC only; the card offers Sign out instead) or a sign-in
    // from `blocked` replaces an account that is still there. The new pair
    // gets a FRESH ref, the file is switched to it, and only then is the old
    // ref deleted — so a cancel that lands mid-write puts the user back where
    // they started, not signed out, and no ciphertext is orphaned either way.
    const previousRef = this.account?.secretRef;
    try {
      secretRef = await this.secrets.set(JSON.stringify(tokens));
      const written = await this.mutate((cur) => {
        // A cancel that landed while the secret was being written wins; the
        // secret is removed again below so nothing survives it.
        if (round.generation !== this.generation) return null;
        return {
          v: 1, secretRef, accountId: claims.accountId, email: claims.email,
          // Keep the plan the last poll reported if the claim has none.
          plan: claims.plan || cur?.plan || '',
          ...(cur?.usage ? { usage: cur.usage } : {}),
          ...(cur?.models ? { models: cur.models } : {}),
        };
      });
      if (round.generation !== this.generation || !written || written.secretRef !== secretRef) {
        await this.secrets.delete(secretRef).catch(() => undefined);
        this.log('info', 'sign-in cancelled while the account was being saved; tokens discarded');
        reply(res, 200, CALLBACK_PAGE_FAILED);
        return;
      }
    } catch (e) {
      // The keychain vanished mid-flow (the pre-flight makes this rare). The
      // store's message is ours, not OpenAI's — safe on the page.
      const msg = `YouCoded could not save the sign-in: ${errorMessage(e)}`;
      this.log('error', 'could not save the sign-in', { reason: errorMessage(e) });
      await fail(msg, { error: msg });
      return;
    }

    if (previousRef && previousRef !== secretRef) {
      await this.secrets.delete(previousRef).catch((e) => this.log('warn', 'could not remove the previous sign-in\'s secret', { reason: errorMessage(e) }));
    }
    reply(res, 200, CALLBACK_PAGE_DONE);
    await this.finishRound(round, 'signed-in');
    this.startPoll();
    // Kick both caches so the bars and the picker are filled by the card's
    // next 1-second poll. Fire-and-forget; both swallow their own failures.
    // The models backoff is cleared first: this sign-in's kick must run even
    // if an attempt failed minutes ago (F3).
    this.lastModelsAttemptAt = 0;
    void this.refreshUsage();
    void this.refreshModels();
  }

  private onRoundTimeout(round: SignInRound): void {
    if (this.round !== round || round.timedOut) return; // stale timer: no-op
    // The browser step is done and the exchange is on the wire (capped at
    // TOKEN_REQUEST_TIMEOUT_MS): its own result ends the round either way.
    if (round.exchanging) return;
    round.timedOut = true;
    round.timer = null;
    this.round = null;
    this.lastOutcome = 'timed-out';
    // The listener stays up for a minute answering the fixed page (§3), so a
    // user who finishes just after the deadline sees a sentence, not a
    // connection error. Hand it to `lingering`; a fresh signIn closes it.
    this.lingering = {
      server: round.server,
      timer: this.unref(this.timers.setTimeout(() => { void this.closeLingering(); }, LINGER_MS)),
    };
    const waiters = round.waiters.splice(0);
    for (const w of waiters) w('timed-out');
  }

  /** The four terminal transitions except timeout: close the listener,
   *  clear the timer, drop the phase flag, wake the waiters. */
  private async finishRound(round: SignInRound, outcome: SignInOutcome): Promise<void> {
    if (round.timer) { this.timers.clearTimeout(round.timer); round.timer = null; }
    if (this.round === round) this.round = null;
    this.lastOutcome = outcome;
    const waiters = round.waiters.splice(0);
    for (const w of waiters) w(outcome);
    await this.closeServer(round.server);
  }

  private closeServer(server: CallbackServerLike): Promise<void> {
    return new Promise((resolve) => {
      try { server.closeAllConnections(); } catch { /* already closed */ }
      try { server.close(() => resolve()); } catch { resolve(); }
    });
  }

  private async closeLingering(): Promise<void> {
    const l = this.lingering;
    if (!l) return;
    this.lingering = null;
    this.timers.clearTimeout(l.timer);
    await this.closeServer(l.server);
  }

  // ----- tokens ---------------------------------------------------------------

  /** A live access token, renewed under one in-flight promise when fewer
   *  than REFRESH_MARGIN_MS remain. Throws the sign-in-required sentence when
   *  signed out, the expired sentence when OpenAI refuses the renewal (the
   *  account is signed out first), and the real reason for anything else. */
  async accessToken(): Promise<string> {
    const blob = await this.readTokens();
    if (blob.expires_at - this.now() > REFRESH_MARGIN_MS) return blob.access_token;
    return (await this.refresh(blob)).access_token;
  }

  private async readTokens(): Promise<TokenBlob> {
    const a = this.account;
    if (!a) throw new Error(CHATGPT_SIGN_IN_REQUIRED_MESSAGE);
    const blob = parseTokenBlob(await this.secrets.get(a.secretRef));
    if (!blob) throw new Error(CHATGPT_SIGN_IN_REQUIRED_MESSAGE);
    return blob;
  }

  /** After a 401: the token we sent may already have been replaced by a
   *  refresh another step finished — use that one; otherwise refresh. */
  private async tokenAfter401(used: string): Promise<string> {
    const blob = await this.readTokens();
    if (blob.access_token !== used) return blob.access_token;
    return (await this.refresh(blob)).access_token;
  }

  private refresh(current: TokenBlob): Promise<TokenBlob> {
    if (this.refreshing) return this.refreshing;
    const p = this.doRefresh(current).finally(() => { if (this.refreshing === p) this.refreshing = null; });
    this.refreshing = p;
    return p;
  }

  private async doRefresh(current: TokenBlob): Promise<TokenBlob> {
    const generation = this.generation;
    const account = this.account;
    if (!account) throw new Error(CHATGPT_SIGN_IN_REQUIRED_MESSAGE);
    let r: Response;
    try {
      r = await this.realFetch(CHATGPT_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: refreshBody({ refreshToken: current.refresh_token }),
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      // Network: the caller's request fails with that reason; the account is
      // left as it was (§3). The original error carries no token.
      this.log('warn', 'token refresh could not reach OpenAI', { reason: errorMessage(e) });
      throw e;
    }
    if (r.status === 400 || r.status === 401) {
      // OpenAI will not renew this pair: the sign-in is over. Delete the
      // secret (generation-checked) and tell the caller in the approved words.
      this.log('warn', 'token refresh refused; signing out', { status: r.status });
      if (generation === this.generation) await this.clearAccount();
      throw expiredError();
    }
    const json: unknown = await r.json().catch(() => null);
    if (!r.ok || !isRecord(json) || typeof json.access_token !== 'string') {
      const detail = isRecord(json) && typeof json.error_description === 'string' ? json.error_description : `HTTP ${r.status}`;
      this.log('warn', 'token refresh failed', { status: r.status, detail });
      throw new Error(`ChatGPT could not renew the sign-in (${detail}). Try again in a moment.`);
    }
    const next: TokenBlob = {
      access_token: json.access_token,
      refresh_token: typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : current.refresh_token,
      ...((typeof json.id_token === 'string' ? json.id_token : current.id_token) ? { id_token: typeof json.id_token === 'string' ? json.id_token : current.id_token } : {}),
      expires_at: tokenExpiresAt(json.expires_in, this.now()),
    };
    // A sign-out that landed while the refresh was on the wire sticks: the
    // fresh pair is discarded, not written back (§3, the generation counter).
    if (generation !== this.generation || this.account?.secretRef !== account.secretRef) {
      throw new Error(CHATGPT_SIGN_IN_REQUIRED_MESSAGE);
    }
    await this.secrets.set(JSON.stringify(next), account.secretRef);
    // The renewed token's claims may name a new plan or email; keep the file
    // honest without a poll. One write, only when something changed.
    const claims = accountFromTokens({ accessToken: next.access_token, idToken: next.id_token });
    if (claims && (claims.email !== account.email || (claims.plan && claims.plan !== account.plan) || claims.accountId !== account.accountId)) {
      await this.mutate((cur) => {
        if (!cur || generation !== this.generation) return null;
        return { ...cur, accountId: claims.accountId, email: claims.email || cur.email, plan: claims.plan || cur.plan };
      });
    }
    return next;
  }

  /** Secret first, then the file (§2); the poll stops with the account. */
  private async clearAccount(): Promise<void> {
    this.stopPoll();
    // A fresh sign-in is a fresh start: a network blip before sign-out must
    // not leave the next account's picker empty for five minutes (F3).
    this.lastModelsAttemptAt = 0;
    const a = this.account;
    if (a) await this.secrets.delete(a.secretRef);
    await this.mutate(() => null, { remove: true });
    this.account = null;
  }

  // ----- the credential-owning fetch (§4.1, §4.5, §4.6) ----------------------

  /** A `fetch` that REPLACES the authorization header on every request with
   *  the live bearer. The SDK freezes its placeholder key into a lower-cased
   *  `authorization` at construction; `Headers.set` overwrites that one key,
   *  where adding `Authorization` would make undici merge the two into
   *  "Bearer chatgpt, Bearer <real>" and 401 every request. */
  fetch(expected?: { accountId: string; authGeneration: number }): typeof fetch {
    return (input, init) => this.authedFetch(input, init, expected);
  }

  private async liveCredentials(): Promise<{ token: string; accountId: string; authGeneration: number }> {
    // WHY: model construction and token lookup are separated by async work. Pair
    // the bearer with the account generation observed on both sides so a switch
    // can never combine the old frozen account header with a new account's token.
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = this.signedInAccount();
      const token = await this.accessToken();
      const after = this.signedInAccount();
      if (before.accountId === after.accountId && before.authGeneration === after.authGeneration) {
        return { token, accountId: after.accountId, authGeneration: after.authGeneration };
      }
    }
    throw new Error('The ChatGPT account changed while preparing this request. Try again.');
  }

  private async authedFetch(input: RequestInfo | URL, init?: RequestInit,
                            expected?: { accountId: string; authGeneration: number }): Promise<Response> {
    const context = currentChatGptRequest();
    let parent: string | undefined;
    // The SDK always calls fetch(url, init) with a string body, so the 401
    // re-send below reuses `init.body` verbatim. A `Request` input with a
    // stream body could not be re-sent; none reaches this wrapper today.
    const send = async (credentials: { token: string; accountId: string; authGeneration: number }) => {
      const live = this.signedInAccount();
      if (live.accountId !== credentials.accountId || live.authGeneration !== credentials.authGeneration
        || (expected && (live.accountId !== expected.accountId || live.authGeneration !== expected.authGeneration))) {
        throw new Error('The ChatGPT account changed while preparing this request. Try again.');
      }
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set('authorization', `Bearer ${credentials.token}`);
      headers.set('chatgpt-account-id', credentials.accountId);
      // WHY: only actual sends count, including the wrapper's invisible 401 resend.
      // Credentials never cross the observer boundary; the outgoing body is untouched.
      const attempt = context?.diagnostics?.dispatch(context, init?.body, parent ?? null);
      if (context) context.attemptId = attempt;
      parent = attempt;
      try {
        const response = await this.realFetch(input, { ...init, headers });
        if (!response.ok) context?.diagnostics?.finish(attempt, 'failed');
        return response;
      } catch (error) {
        context?.diagnostics?.finish(attempt, init?.signal?.aborted ? 'aborted' : 'failed');
        throw error;
      }
    };
    const first = await this.liveCredentials();
    let res = await send(first);
    if (res.status === 401) {
      // Refresh once and re-send the SAME body with the new bearer; a second
      // 401 means the sign-in is over. Keep the refresh scoped to the same
      // account generation that received the 401.
      const secondToken = await this.tokenAfter401(first.token);
      const secondAccount = this.signedInAccount();
      if (secondAccount.accountId !== first.accountId || secondAccount.authGeneration !== first.authGeneration
        || (expected && (secondAccount.accountId !== expected.accountId || secondAccount.authGeneration !== expected.authGeneration))) {
        throw new Error('The ChatGPT account changed while preparing this request. Try again.');
      }
      res = await send({ ...first, token: secondToken });
      if (res.status === 401) {
        this.log('warn', 'request refused twice with 401; signing out');
        await this.clearAccount();
        throw expiredError();
      }
    }
    // Every reply's x-codex-* headers are the freshest number right after the
    // step that spent them — free, so read them before anything else.
    await this.noteUsageHeaders(res);

    if (res.status === 403 || res.status === 429) {
      // Classify on a CLONE: the SDK's own error handler still has to read
      // the body of a 429 that is not a plan limit (§4.5, pinned).
      const text = await res.clone().text().catch(() => '');
      const c = classifyErrorBody({
        status: res.status,
        body: text,
        headers: (n) => res.headers.get(n),
        lastUsage: parsedFromCache(this.account?.usage),
        now: this.now(),
      });
      if (c.kind === 'limit') {
        await this.markWindowExhausted(c);
        throw limitError(c.message);
      }
      if (c.kind === 'blocked') {
        await this.markBlocked(c.reason);
        throw blockedError(c.reason);
      }
    }
    return res;
  }

  // ----- usage (§4.4) ---------------------------------------------------------

  /** GET /wham/usage → the cache and `plan`. Silent on failure (logged):
   *  the bars keep the last snapshot and the account is never transitioned
   *  by the poll — that happens only on a turn. */
  async refreshUsage(): Promise<void> {
    if (this.disposed || !this.isSignedIn()) return;
    this.lastUsagePollAt = this.now();
    try {
      const acct = this.signedInAccount();
      const token = await this.accessToken();
      const r = await this.realFetch(CHATGPT_USAGE_URL, {
        headers: { authorization: `Bearer ${token}`, 'chatgpt-account-id': acct.accountId, accept: 'application/json' },
      });
      if (!r.ok) {
        this.log('warn', 'usage poll refused', { status: r.status });
        return;
      }
      const parsed = parseUsageBody(await r.json(), this.now());
      if (!parsed) {
        this.log('warn', 'usage poll returned an unrecognised body');
        return;
      }
      await this.storeUsage(parsed);
    } catch (e) {
      this.log('warn', 'usage poll failed', { reason: errorMessage(e) });
    }
  }

  private async noteUsageHeaders(res: Response): Promise<void> {
    const parsed = parseUsageHeaders((n) => res.headers.get(n), this.now());
    if (parsed) await this.storeUsage(parsed);
    // A reply arrived: the poll runs again soon, at most once a minute.
    this.schedulePollSoon();
  }

  /** Whichever leg arrives later wins the whole snapshot; `plan` follows
   *  whatever the reply said it is. */
  private async storeUsage(parsed: ParsedUsage): Promise<void> {
    const generation = this.generation;
    await this.mutate((cur) => {
      if (!cur || generation !== this.generation) return null;
      const usage = { ...toChatGptUsage(parsed), at: new Date(this.now()).toISOString() };
      return { ...cur, usage, ...(parsed.plan ? { plan: parsed.plan } : {}) };
    });
  }

  /** §4.5: the limit card and the bars must agree, so the exhausted window
   *  is set to 100 % at the reset OpenAI reported. */
  private async markWindowExhausted(c: Extract<ClassifiedError, { kind: 'limit' }>): Promise<void> {
    const minutes = limitWindowMinutes(c);
    if (minutes === null) return;
    const generation = this.generation;
    await this.mutate((cur) => {
      if (!cur || generation !== this.generation) return null;
      const usage: ChatGptUsage & { at: string } = { ...(cur.usage ?? {}), at: new Date(this.now()).toISOString() };
      const key = minutes === FIVE_HOUR_MINUTES ? 'five_hour' : minutes === SEVEN_DAY_MINUTES ? 'seven_day' : null;
      const existing = key ? usage[key] : (usage.other ?? []).find((w) => w.minutes === minutes);
      const resets_at = c.resetsAt || existing?.resets_at;
      // No reset time anywhere → no bar: a window with no reset would never
      // prune, and last night's 100 % would show forever.
      if (!resets_at) return null;
      const window: ChatGptUsageWindow = { utilization: 100, resets_at };
      if (key) usage[key] = window;
      else usage.other = [...(usage.other ?? []).filter((w) => w.minutes !== minutes), { ...window, minutes }];
      return { ...cur, usage };
    });
  }

  private async markBlocked(reason: string): Promise<void> {
    // A blocked account would 403 every five minutes forever (§4.4).
    this.stopPoll();
    const generation = this.generation;
    await this.mutate((cur) => {
      if (!cur || generation !== this.generation) return null;
      return { ...cur, blocked: { reason, at: new Date(this.now()).toISOString() } };
    });
  }

  private startPoll(): void {
    // The gate lives HERE as well as in the constructor: the sign-in callback
    // and the first-run arm both start the poll, so a single constructor check
    // would not make the kill switch airtight (review T4 F1/F3).
    if (!this.pollUsage || this.pollTimer || this.disposed) return;
    // Through the debounce, so an interval tick seconds after a reply-driven
    // poll waits for the minute instead of spending a second request.
    this.pollTimer = this.unref(this.timers.setInterval(() => this.schedulePollSoon(), USAGE_POLL_MS));
  }

  private stopPoll(): void {
    if (this.pollTimer) { this.timers.clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.debounceTimer) { this.timers.clearTimeout(this.debounceTimer); this.debounceTimer = null; }
  }

  /** The per-reply trigger, debounced: a ten-step turn costs one poll. */
  private schedulePollSoon(): void {
    if (!this.pollUsage) return;   // kill switch: no background traffic at all
    if (this.debounceTimer || this.disposed || !this.isSignedIn()) return;
    const wait = Math.max(0, USAGE_DEBOUNCE_MS - (this.now() - this.lastUsagePollAt));
    this.debounceTimer = this.unref(this.timers.setTimeout(() => {
      this.debounceTimer = null;
      void this.refreshUsage();
    }, wait));
  }

  // ----- models (§4.3) -------------------------------------------------------

  /** Cache-first and NEVER awaits the network: `modelCatalog.get()` runs in
   *  front of sessions on every provider, so a stale stamp kicks a background
   *  refresh and the cached rows are returned now. */
  models(): Promise<CatalogModel[]> {
    const cached = this.account?.models;
    const rows = cached?.rows ?? [];
    const at = cached ? Date.parse(cached.at) : NaN;
    const stale = !Number.isFinite(at) || this.now() - at >= MODELS_MAX_AGE_MS;
    if (stale && this.isSignedIn()) void this.refreshModels();
    return Promise.resolve(rows);
  }

  /** GET /codex/models with the app's own version. 401/403 are SILENT here —
   *  the cached rows stand, and the account transitions happen only on a
   *  turn (§4.3). One in flight at a time; a failure waits MODELS_RETRY_MS. */
  refreshModels(): Promise<void> {
    if (this.modelsRefresh) return this.modelsRefresh;
    if (this.disposed || !this.isSignedIn()) return Promise.resolve();
    if (this.now() - this.lastModelsAttemptAt < MODELS_RETRY_MS) return Promise.resolve();
    this.lastModelsAttemptAt = this.now();
    const p = this.doRefreshModels().finally(() => { if (this.modelsRefresh === p) this.modelsRefresh = null; });
    this.modelsRefresh = p;
    return p;
  }

  private async doRefreshModels(): Promise<void> {
    try {
      const acct = this.signedInAccount();
      const token = await this.accessToken();
      const r = await this.realFetch(chatGptModelsUrl(this.appVersion), {
        headers: { authorization: `Bearer ${token}`, 'chatgpt-account-id': acct.accountId, accept: 'application/json' },
      });
      if (!r.ok) {
        this.log('warn', 'models manifest refused; keeping the cached rows', { status: r.status });
        return;
      }
      const rows = parseModelsManifest(await r.json());
      const generation = this.generation;
      await this.mutate((cur) => {
        if (!cur || generation !== this.generation) return null;
        return { ...cur, models: { rows, at: new Date(this.now()).toISOString() } };
      });
    } catch (e) {
      this.log('warn', 'models refresh failed; keeping the cached rows', { reason: errorMessage(e) });
    }
  }

  // ----- the file -------------------------------------------------------------

  private readAccountSync(): ChatGptAccountFile | null {
    let raw: string | null = null;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (errorCode(e) !== 'ENOENT') this.log('warn', 'could not read the account file', { reason: errorMessage(e) });
      return null;
    }
    const parsed = parseAccountFile(raw);
    if (!parsed) this.log('warn', 'account file is not readable as an account; treating as signed out');
    return parsed;
  }

  /**
   * THE one place chatgpt-account.json is read-modified-written, inside
   * cas-write's mkdir lock, with SecretsStore's retry-then-THROW: the lock
   * primitive returns `false` when it cannot be taken, and a `false` treated
   * as success is exactly the torn-file class §2 exists to prevent — the
   * user would read as signed out for no reason. `fn` returning null skips
   * the write; `{ remove: true }` deletes the file instead (sign-out).
   * Calls are serialised in-process so the refresh, the poll and the models
   * writer never queue up on the on-disk lock against each other.
   */
  private mutate(
    fn: (cur: ChatGptAccountFile | null) => ChatGptAccountFile | null,
    opts?: { remove?: boolean },
  ): Promise<ChatGptAccountFile | null> {
    const run = async (): Promise<ChatGptAccountFile | null> => {
      // After dispose the userData dir may already be gone (tests) or the app
      // is quitting; the lock primitive would mkdir the directory back into
      // existence for a write nobody will read.
      if (this.disposed) return this.account;
      if (opts?.remove) {
        await fs.promises.rm(this.file, { force: true });
        this.account = null;
        return null;
      }
      let result: ChatGptAccountFile | null = this.account;
      for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
        const ok = await mutateFileUnderLock(this.file, (onDisk) => {
          const cur = parseAccountFile(onDisk);
          const next = fn(cur);
          result = next ?? cur;
          return next === null ? null : JSON.stringify(next, null, 2);
        });
        if (ok) {
          this.account = result;
          return result;
        }
      }
      throw new Error(CHATGPT_LOCK_HELD_MESSAGE);
    };
    const p = this.writeChain.then(run, run);
    this.writeChain = p.then(() => undefined, () => undefined);
    return p;
  }

  // ----- lifecycle --------------------------------------------------------------

  /** For app quit and tests: every timer cleared, every listener closed, and
   *  every write in flight allowed to land — a poll's read-modify-write cut
   *  off half-way is exactly the torn file §2 exists to prevent. A round in
   *  flight resolves its waiters `cancelled`. Nothing writes after this. */
  async dispose(): Promise<void> {
    // The bump comes first: an exchange or a refresh on the wire then takes
    // its discard path, so the secrets store is never written after this.
    this.generation += 1;
    this.disposed = true;
    this.stopPoll();
    if (this.round) await this.finishRound(this.round, 'cancelled');
    await this.closeLingering();
    await Promise.allSettled([this.writeChain, this.refreshing, this.modelsRefresh, this.exchangeInFlight, this.starting]);
    await this.writeChain;
  }

  /** Timers must never keep the process — or a test worker — alive (§4.4). */
  private unref<T extends TimerHandle>(t: T): T {
    if (typeof t.unref === 'function') t.unref();
    return t;
  }
}
