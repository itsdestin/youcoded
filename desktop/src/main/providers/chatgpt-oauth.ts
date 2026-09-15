/**
 * Sign in with ChatGPT — the pure helpers (main process).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Everything about talking to OpenAI's sign-in and plan endpoints that can be
 * worked out WITHOUT touching the network, the keychain, a port or a browser
 * lives here: the constants, the PKCE maths, the request bodies, reading the
 * account out of a token, turning OpenAI's usage / model-list / error bodies
 * into the shapes the rest of the app already draws. `chatgpt-auth.ts` (the
 * stateful account) calls these; nothing here does I/O, imports Electron, or
 * keeps state, so every branch is a plain unit test against the Phase 0
 * fixtures in tests/fixtures/chatgpt/.
 *
 * Design: docs/active/specs/2026-09-05-chatgpt-signin-backend-design.md
 * (workspace repo) §3 constants, §4.3–4.6. Real shapes: the Phase 0 findings
 * (docs/active/investigations/2026-09-05-chatgpt-phase0-findings.md).
 *
 * TOKEN HYGIENE (load-bearing)
 * ----------------------------
 * Tokens come in here only to be DECODED (`decodeJwtClaims`, `accountFromTokens`)
 * or placed into a request body string. No function returns a token inside an
 * Error message, and none logs. Keep it that way — same rule as github-auth.ts.
 */

import { createHash } from 'crypto';
import type { CatalogModel } from '../../shared/provider-types';
import { chatGptLimitMessage, type ChatGptUsage } from '../../shared/chatgpt-types';

// ---------------------------------------------------------------------------
// Constants — verified against pi's source (badlogic/pi-mono) 2026-09-04/05 and
// confirmed live by the Phase 0 probe (test-engine/chatgpt-phase0.mjs).
// ---------------------------------------------------------------------------

/** The Codex CLI's public OAuth client id. There is no secret: the flow is
 *  PKCE, so the id is safe to ship in an open-source app (pi ships it too). */
export const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CHATGPT_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
export const CHATGPT_TOKEN_URL = 'https://auth.openai.com/oauth/token';
/** Registered for this client id on OpenAI's side — not ours to change, which
 *  is why the app must listen on exactly port 1455. */
export const CHATGPT_REDIRECT_URI = 'http://localhost:1455/auth/callback';
export const CHATGPT_SCOPE = 'openid profile email offline_access';

export const CHATGPT_BACKEND = 'https://chatgpt.com/backend-api';
/** The `baseURL` handed to @ai-sdk/openai's Responses model. */
export const CHATGPT_CODEX_BASE_URL = `${CHATGPT_BACKEND}/codex`;
export const CHATGPT_USAGE_URL = `${CHATGPT_BACKEND}/wham/usage`;
export const CHATGPT_ACCOUNTS_CHECK_URL = `${CHATGPT_BACKEND}/wham/accounts/check`;
/** The model manifest. Phase 0 (P0-3): rows are gated on `client_version`, and
 *  the app's OWN version lists more rows than the Codex CLI's string, so the
 *  caller passes `app.getVersion()`. */
export function chatGptModelsUrl(clientVersion: string): string {
  return `${CHATGPT_BACKEND}/codex/models?client_version=${encodeURIComponent(clientVersion)}`;
}

/** What the registry throws when a ChatGPT model is picked while signed out. */
export const CHATGPT_SIGN_IN_REQUIRED_MESSAGE =
  'Sign in with ChatGPT in Settings → Model Providers to use this model.';
/** What a turn ends with when a refresh can no longer fix a 401. */
export const CHATGPT_SIGN_IN_EXPIRED_MESSAGE =
  'Your ChatGPT sign-in has expired — sign in again in Settings → Model Providers.';

// ---------------------------------------------------------------------------
// PKCE and the authorize URL
// ---------------------------------------------------------------------------

/** Injected source of randomness (`crypto.randomBytes` in production) so a
 *  test can make the verifier deterministic and still check the maths. */
export type RandomBytesFn = (size: number) => Uint8Array;

function base64url(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString('base64url');
}

/** PKCE pair. The verifier is 32 random bytes as base64url (43 chars, inside
 *  RFC 7636's 43–128 range); the challenge is the S256 form — base64url of
 *  the SHA-256 of the verifier STRING (its ASCII bytes, not the raw random
 *  bytes), which is the one detail people get wrong and OpenAI rejects. */
export function generatePkce(randomBytes: RandomBytesFn): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** The `state` that ties the browser's callback to this sign-in round. 16
 *  random bytes as hex; the listener rejects any callback whose state differs. */
export function generateState(randomBytes: RandomBytesFn): string {
  return Buffer.from(randomBytes(16)).toString('hex');
}

/** The URL `shell.openExternal` opens. The two trailing flags are what pi and
 *  the Codex CLI send; the Phase 0 sign-in went through with them, so they
 *  stay exactly as probed rather than being trimmed on a guess. */
export function buildAuthorizeUrl(opts: { state: string; challenge: string }): string {
  const url = new URL(CHATGPT_AUTHORIZE_URL);
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: CHATGPT_CLIENT_ID,
    redirect_uri: CHATGPT_REDIRECT_URI,
    scope: CHATGPT_SCOPE,
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
    state: opts.state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Token endpoint bodies (application/x-www-form-urlencoded)
// ---------------------------------------------------------------------------

/** Body of the `POST /oauth/token` that swaps the callback's code for tokens. */
export function exchangeBody(opts: { code: string; verifier: string }): string {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CHATGPT_CLIENT_ID,
    code: opts.code,
    code_verifier: opts.verifier,
    redirect_uri: CHATGPT_REDIRECT_URI,
  }).toString();
}

/** Body of the `POST /oauth/token` that renews an expiring access token. */
export function refreshBody(opts: { refreshToken: string }): string {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CHATGPT_CLIENT_ID,
    refresh_token: opts.refreshToken,
  }).toString();
}

/** Absolute ms epoch when a token dies, from the reply's `expires_in` seconds.
 *  An unusable `expires_in` yields `now` — "already expired" — so the account
 *  refreshes at its next chance instead of trusting a number we made up. */
export function tokenExpiresAt(expiresIn: unknown, now: number): number {
  const s = Number(expiresIn);
  return Number.isFinite(s) && s > 0 ? now + s * 1000 : now;
}

// ---------------------------------------------------------------------------
// JWT claims → the account
// ---------------------------------------------------------------------------

/** The payload of a JWT as a plain object, or null for anything that is not
 *  three dot-separated base64url parts around a JSON object. Tolerant on
 *  purpose (standard base64 alphabet and padding both accepted): the signature
 *  is NOT checked — we only read what OpenAI told us about the account, over
 *  TLS, and the token's power lies in presenting it, not in reading it. */
export function decodeJwtClaims(token: string | null | undefined): Record<string, unknown> | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const claims: unknown = JSON.parse(json);
    return claims && typeof claims === 'object' && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface ChatGptAccountClaims {
  /** Sent as the `chatgpt-account-id` header on every plan request. */
  accountId: string;
  /** OpenAI's own plan string ('free', 'plus', 'pro', …); '' when absent. */
  plan: string;
  /** Shown on the card; '' when neither token carries one. */
  email: string;
}

const AUTH_CLAIM = 'https://api.openai.com/auth';
const PROFILE_CLAIM = 'https://api.openai.com/profile';

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** The account, read out of the token pair the exchange returned. Phase 0
 *  found both tokens carry the same `https://api.openai.com/auth` object, and
 *  the email is on the access token's `profile` claim as well as on the id
 *  token's top level — so the access token alone is enough, and the id token
 *  is only a fallback. Null when there is no account id at all: without it no
 *  plan request can be addressed, so the sign-in must not be recorded. */
export function accountFromTokens(tokens: { accessToken: string; idToken?: string | null }): ChatGptAccountClaims | null {
  const access = decodeJwtClaims(tokens.accessToken);
  const id = decodeJwtClaims(tokens.idToken);
  const auth = asRecord(access?.[AUTH_CLAIM]) ?? asRecord(id?.[AUTH_CLAIM]);
  const accountId = asString(auth?.chatgpt_account_id);
  if (!accountId) return null;
  const plan = asString(auth?.chatgpt_plan_type) ?? '';
  const email = asString(asRecord(access?.[PROFILE_CLAIM])?.email) ?? asString(id?.email) ?? '';
  return { accountId, plan, email };
}

// ---------------------------------------------------------------------------
// Usage — the plan's rolling windows
// ---------------------------------------------------------------------------

/** One window as OpenAI reports it, identified by its LENGTH. Phase 0 showed
 *  the free plan has a single 30-day window, so "primary = 5 hours" is not a
 *  rule we can rely on; the length is the only honest identifier. */
export interface ParsedUsageWindow {
  minutes: number;
  usedPercent: number;
  /** ISO timestamp. */
  resetsAt: string;
}

export interface ParsedUsage {
  plan?: string;
  windows: ParsedUsageWindow[];
  limitReached?: boolean;
}

/** OpenAI writes reset times as epoch SECONDS in the usage body and headers,
 *  while pi reads a 429's `resets_at` as epoch MILLISECONDS. Rather than trust
 *  either convention per field, decide by size: anything above 1e11 can only
 *  be milliseconds (1e11 seconds is the year 5138; 1e11 ms is 1973). */
export function epochToMs(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  return n > 1e11 ? Math.round(n) : Math.round(n * 1000);
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A reset as an ISO string from whichever of "at" (an epoch) or "after"
 *  (seconds from now) the reply carried; null when it carried neither. */
function resetIso(at: unknown, afterSeconds: unknown, now: number): string | null {
  const atMs = epochToMs(at);
  if (atMs !== null) return toIso(atMs);
  const after = Number(afterSeconds);
  if (typeof afterSeconds !== 'undefined' && afterSeconds !== null && afterSeconds !== '' && Number.isFinite(after) && after > 0) {
    return toIso(now + after * 1000);
  }
  return null;
}

function finiteNumber(v: unknown): number | null {
  if (v === '' || v === null || typeof v === 'undefined') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** One `primary_window` / `secondary_window` object from `GET /wham/usage`.
 *  A window with no reset time is dropped rather than given a made-up one:
 *  both the card and the renderer prune by reset time, and a bar that never
 *  expires would be last night's number forever. */
function windowFromBody(raw: unknown, now: number): ParsedUsageWindow | null {
  const w = asRecord(raw);
  if (!w) return null;
  const seconds = finiteNumber(w.limit_window_seconds);
  const used = finiteNumber(w.used_percent);
  if (seconds === null || seconds <= 0 || used === null) return null;
  const resetsAt = resetIso(w.reset_at, w.reset_after_seconds, now);
  if (!resetsAt) return null;
  return { minutes: Math.round(seconds / 60), usedPercent: used, resetsAt };
}

/** `GET /wham/usage` → the windows. Shape per the Phase 0 fixture
 *  (tests/fixtures/chatgpt/usage.free.json): `rate_limit.primary_window`,
 *  `rate_limit.secondary_window` (null on free), `plan_type`,
 *  `rate_limit.limit_reached`. Null when the body is not a usage body at all. */
export function parseUsageBody(json: unknown, now: number): ParsedUsage | null {
  const body = asRecord(json);
  const rateLimit = asRecord(body?.rate_limit);
  if (!body || !rateLimit) return null;
  const windows: ParsedUsageWindow[] = [];
  for (const key of ['primary_window', 'secondary_window'] as const) {
    const w = windowFromBody(rateLimit[key], now);
    if (w) windows.push(w);
  }
  const out: ParsedUsage = { windows };
  const plan = asString(body.plan_type);
  if (plan) out.plan = plan;
  if (typeof rateLimit.limit_reached === 'boolean') out.limitReached = rateLimit.limit_reached;
  return out;
}

/** Header reader — `(name) => value`; `Headers.prototype.get` fits directly. */
export type HeaderGetter = (name: string) => string | null | undefined;

/** One `x-codex-<primary|secondary>-*` header group. Absent when the window
 *  length is 0/empty or no reset is given — that is exactly how the free
 *  plan's reply spells "no secondary window" (fixture responses-headers.free.json). */
function windowFromHeaders(get: HeaderGetter, group: 'primary' | 'secondary', now: number): ParsedUsageWindow | null {
  const minutes = finiteNumber(get(`x-codex-${group}-window-minutes`));
  const used = finiteNumber(get(`x-codex-${group}-used-percent`));
  if (minutes === null || minutes <= 0 || used === null) return null;
  const resetsAt = resetIso(get(`x-codex-${group}-reset-at`), get(`x-codex-${group}-reset-after-seconds`), now);
  if (!resetsAt) return null;
  return { minutes: Math.round(minutes), usedPercent: used, resetsAt };
}

/** The `x-codex-*` headers every `/codex/responses` reply carries → the same
 *  shape as the poll, so whichever arrives later can simply win. Null when the
 *  reply carries no window at all (not a plan reply, or an error page). */
export function parseUsageHeaders(get: HeaderGetter, now: number): ParsedUsage | null {
  const windows: ParsedUsageWindow[] = [];
  for (const group of ['primary', 'secondary'] as const) {
    const w = windowFromHeaders(get, group, now);
    if (w) windows.push(w);
  }
  if (windows.length === 0) return null;
  const out: ParsedUsage = { windows };
  const plan = asString(get('x-codex-plan-type') ?? undefined);
  if (plan) out.plan = plan;
  return out;
}

export const FIVE_HOUR_MINUTES = 300;
export const SEVEN_DAY_MINUTES = 10080;

/** The parsed windows → the shared `ChatGptUsage` the renderer draws. Windows
 *  are filed by LENGTH: 300 min → `five_hour`, 10080 → `seven_day`, anything
 *  else → `other` (the free plan's 30-day window lands there; words deck W-2
 *  decides whether it is drawn). Keys are only present when a window is. */
export function toChatGptUsage(parsed: ParsedUsage): ChatGptUsage {
  const usage: ChatGptUsage = {};
  for (const w of parsed.windows) {
    const window = { utilization: w.usedPercent, resets_at: w.resetsAt };
    if (w.minutes === FIVE_HOUR_MINUTES) usage.five_hour = window;
    else if (w.minutes === SEVEN_DAY_MINUTES) usage.seven_day = window;
    else (usage.other ??= []).push({ ...window, minutes: w.minutes });
  }
  return usage;
}

/** The word that goes into "You have reached ChatGPT's <label> session limit".
 *  '5-hour' and 'weekly' are the two Destin approved; anything else is its
 *  length in days ('30-day' for the free plan) or, under a day, in hours
 *  ('1-hour'), rounded, so a window we have never seen still reads as a
 *  sentence instead of "1-day" for a one-hour window. */
export function windowLabel(minutes: number): string {
  if (minutes === FIVE_HOUR_MINUTES) return '5-hour';
  if (minutes === SEVEN_DAY_MINUTES) return 'weekly';
  if (minutes < 1440) return `${Math.max(1, Math.round(minutes / 60))}-hour`;
  return `${Math.round(minutes / 1440)}-day`;
}

// ---------------------------------------------------------------------------
// The model list
// ---------------------------------------------------------------------------

/** "gpt-5.5" → "Gpt 5.5": only the fallback for a manifest row with no
 *  `display_name` (every Phase 0 row had one). */
function titleCaseSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** `GET /codex/models` → catalog rows. Only `visibility: 'list'` rows, in the
 *  manifest's own `priority` order (lower first — that is the order the Codex
 *  CLI's picker shows). No `pricing` key: the plan is not billed per token,
 *  and CatalogModel's rule is that an absent price means "not published",
 *  never "$0" — a `pricing: { in: 0, out: 0 }` would make the cost chip lie. */
export function parseModelsManifest(json: unknown): CatalogModel[] {
  const rows = asRecord(json)?.models;
  if (!Array.isArray(rows)) return [];
  const listed: Array<{ row: Record<string, unknown>; priority: number; index: number }> = [];
  rows.forEach((raw, index) => {
    const row = asRecord(raw);
    if (!row || row.visibility !== 'list' || !asString(row.slug)) return;
    const priority = finiteNumber(row.priority);
    listed.push({ row, priority: priority ?? Number.POSITIVE_INFINITY, index });
  });
  // Ties keep the manifest's order (the index), so the sort is deterministic.
  listed.sort((a, b) => a.priority - b.priority || a.index - b.index);
  return listed.map(({ row }) => {
    const slug = row.slug as string;
    const levels = row.supported_reasoning_levels;
    const modalities = row.input_modalities;
    const contextLength = finiteNumber(row.context_window);
    const model: CatalogModel = {
      id: slug,
      providerId: 'chatgpt',
      label: asString(row.display_name) ?? titleCaseSlug(slug),
      supportsTools: true,
      supportsReasoning: Array.isArray(levels) && levels.length > 0,
    };
    if (contextLength !== null && contextLength > 0) model.contextLength = contextLength;
    // WHY preserve both: Codex publishes a conservative default and a separate
    // opt-in ceiling. Only the user's long-context preference may select the latter.
    const maximum = row.max_context_window;
    if (typeof maximum === 'number' && Number.isSafeInteger(maximum) && maximum > 0) {
      model.maxContextLength = maximum;
    }
    // `undefined` when the row does not say — CatalogModel's doc forbids
    // reading that as "cannot see images".
    if (Array.isArray(modalities)) model.supportsVision = modalities.includes('image');
    return model;
  });
}

// ---------------------------------------------------------------------------
// Error bodies → what the turn ends with
// ---------------------------------------------------------------------------

export type ClassifiedError =
  | {
      kind: 'limit';
      /** Exactly `chatGptLimitMessage(windowLabel, resetsAt)`. */
      message: string;
      windowLabel: string;
      /** ISO, or '' when nothing in the reply or the snapshot said when. */
      resetsAt: string;
      /** The length of the window we matched in the last snapshot, so the
       *  caller can set that bar to 100 % at the same reset time (design §4.5). */
      windowMinutes?: number;
    }
  | { kind: 'expired' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'other' };

export interface ClassifyErrorInput {
  status: number;
  /** The reply body: parsed JSON, or the raw text when it did not parse. */
  body: unknown;
  headers?: HeaderGetter;
  /** The most recent usage snapshot, used to name the exhausted window. */
  lastUsage?: ParsedUsage | null;
  now: number;
}

const LIMIT_CODE = /usage_limit_reached|usage_not_included/i;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
/** How close a snapshot window's reset must be to the reply's to count as the
 *  same window. Two polls a few seconds apart report the same reset. */
const SAME_RESET_TOLERANCE_MS = 5 * 60 * 1000;

function parseBody(body: unknown): { json: Record<string, unknown> | null; text: string } {
  if (typeof body === 'string') {
    try {
      return { json: asRecord(JSON.parse(body)), text: body.trim() };
    } catch {
      return { json: null, text: body.trim() };
    }
  }
  return { json: asRecord(body), text: '' };
}

/** `retry-after` is either seconds or an HTTP date; both → an ISO reset. */
function retryAfterIso(get: HeaderGetter | undefined, now: number): string | null {
  const raw = get?.('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return toIso(now + seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) && date > now ? toIso(date) : null;
}

function longestWindow(usage: ParsedUsage | null | undefined): ParsedUsageWindow | null {
  return usage?.windows.reduce<ParsedUsageWindow | null>((best, w) => (!best || w.minutes > best.minutes ? w : best), null) ?? null;
}
/** The window closest to exhausted (ties → the longer one). WHY not simply
 *  the longest: on Plus the longest is always the weekly window, so a 429
 *  with no reset in it would have been called "weekly" even when the 5-hour
 *  bar is the one at 100 % (T1 review, 2026-09-05). */
function mostUsedWindow(usage: ParsedUsage | null | undefined): ParsedUsageWindow | null {
  return usage?.windows.reduce<ParsedUsageWindow | null>((best, w) => {
    if (!best) return w;
    if (w.usedPercent !== best.usedPercent) return w.usedPercent > best.usedPercent ? w : best;
    return w.minutes > best.minutes ? w : best;
  }, null) ?? null;
}
function shortestWindow(usage: ParsedUsage | null | undefined): ParsedUsageWindow | null {
  return usage?.windows.reduce<ParsedUsageWindow | null>((best, w) => (!best || w.minutes < best.minutes ? w : best), null) ?? null;
}

/** Which window the 429 is about. Best evidence first:
 *  1. a snapshot window whose reset matches the reply's reset — that IS the
 *     window, whatever its length (the only rule that names a free plan's
 *     30-day window correctly);
 *  2. the body naming primary/secondary → the snapshot's shortest/longest
 *     window, or 5-hour/weekly when there is no snapshot;
 *  3. a reset under 5 hours away → 5-hour;
 *  4. the snapshot's MOST-USED window (ties → longer) — the bar that is
 *     actually full — and 'weekly' only when there is no snapshot at all. */
function chooseWindow(
  err: Record<string, unknown> | null,
  resetsAt: string,
  lastUsage: ParsedUsage | null | undefined,
  now: number,
): { label: string; minutes?: number; resetsAt: string } {
  const resetMs = Date.parse(resetsAt);
  if (Number.isFinite(resetMs) && lastUsage) {
    const match = lastUsage.windows.find((w) => Math.abs(Date.parse(w.resetsAt) - resetMs) <= SAME_RESET_TOLERANCE_MS);
    if (match) return { label: windowLabel(match.minutes), minutes: match.minutes, resetsAt };
  }
  const named = [err?.window, err?.rate_limit_type, err?.rate_limit_reached_type, err?.limit_type]
    .map((v) => (typeof v === 'string' ? v.toLowerCase() : ''))
    .find((v) => v.includes('primary') || v.includes('secondary'));
  if (named) {
    const w = named.includes('primary') ? shortestWindow(lastUsage) : longestWindow(lastUsage);
    if (w) return { label: windowLabel(w.minutes), minutes: w.minutes, resetsAt: resetsAt || w.resetsAt };
    return { label: named.includes('primary') ? '5-hour' : 'weekly', resetsAt };
  }
  if (Number.isFinite(resetMs) && resetMs - now < FIVE_HOURS_MS) return { label: '5-hour', resetsAt };
  const fullest = mostUsedWindow(lastUsage);
  if (fullest) return { label: windowLabel(fullest.minutes), minutes: fullest.minutes, resetsAt: resetsAt || fullest.resetsAt };
  return { label: 'weekly', resetsAt };
}

/** A refused `/codex/responses` (or `/wham/*`) reply → what to do with it.
 *  - 429 whose `error.code` is a plan limit (pi's shape: `{ error: { code:
 *    'usage_limit_reached', message, plan_type, resets_at } }`) → `limit` with
 *    the exact sentence the plan-limit card keys on. Any other 429 (a burst
 *    rate limit) → `other`, so the SDK keeps its own backoff and OpenAI's own
 *    message survives (pinned in provider-registry.test.ts).
 *  - 401 → `expired` (the caller refreshes once first; this is the second).
 *  - 403 → `blocked` with OpenAI's text verbatim — `error.message`, else the
 *    body's `detail`/`message`, else the raw text — never a sentence we made
 *    up (docs/error-message-standards.md). Only when the body is empty does
 *    the reason fall back to the bare status, which is at least true.
 *  Reset time for a limit: `error.resets_at` (ms or seconds, by size), else
 *  the `retry-after` header, else the matched snapshot window's own reset. */
export function classifyErrorBody(input: ClassifyErrorInput): ClassifiedError {
  const { status, now } = input;
  const { json, text } = parseBody(input.body);
  const err = asRecord(json?.error);

  if (status === 429) {
    const code = asString(err?.code) ?? asString(err?.type) ?? asString(json?.code) ?? '';
    if (!LIMIT_CODE.test(code)) return { kind: 'other' };
    const fromBody = epochToMs(err?.resets_at ?? json?.resets_at);
    const resetsAt = (fromBody !== null ? toIso(fromBody) : null) ?? retryAfterIso(input.headers, now) ?? '';
    const chosen = chooseWindow(err, resetsAt, input.lastUsage, now);
    return {
      kind: 'limit',
      message: chatGptLimitMessage(chosen.label, chosen.resetsAt),
      windowLabel: chosen.label,
      resetsAt: chosen.resetsAt,
      ...(chosen.minutes !== undefined ? { windowMinutes: chosen.minutes } : {}),
    };
  }
  if (status === 401) return { kind: 'expired' };
  if (status === 403) {
    // WHY the raw body is only used when it looks like a sentence: a 403 does not
    // always come from OpenAI. A proxy or Cloudflare in front of chatgpt.com answers
    // with a whole HTML error page, and this string is what the card shows the user
    // AND what gets saved into the account file — so an unfiltered body would put a
    // wall of markup where the reason should be, and keep it there. OpenAI's own
    // JSON fields are always preferred; anything else falls back to a general,
    // non-committal line rather than a guess at the cause.
    const fromOpenAi = asString(err?.message) ?? asString(json?.detail) ?? asString(json?.message);
    const looksLikeProse = text.length > 0 && text.length <= 300 && !/[<>]/.test(text);
    const reason = fromOpenAi ?? (looksLikeProse ? text : `OpenAI refused this account's requests (HTTP ${status}).`);
    return { kind: 'blocked', reason: reason.trim() };
  }
  return { kind: 'other' };
}

// ---------------------------------------------------------------------------
// The three errors a turn can end with
// ---------------------------------------------------------------------------

/** WHY these are PLAIN Errors with nothing but a name and a message: two retry
 *  layers key on `statusCode` / `status` / `code` — the AI SDK retries its own
 *  API errors, and the harness's `withRetry` (harness-session.ts) retries
 *  anything with `statusCode === 429` — and `describeProviderError` appends
 *  "(provider error <status>)" whenever it sees a status, which would break the
 *  card's exact wording. A plain Error has none of those, so the message the
 *  user sees is byte for byte the one built here (pinned in
 *  tests/chatgpt-oauth.test.ts). `name` is set so a log line can tell them
 *  apart; nothing reads it for control flow. */
function plainError(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

/** `message` must be the `limit` classification's message, unchanged. */
export function limitError(message: string): Error {
  return plainError('ChatGptLimitError', message);
}

export function expiredError(): Error {
  return plainError('ChatGptSignInExpiredError', CHATGPT_SIGN_IN_EXPIRED_MESSAGE);
}

/** `reason` is OpenAI's own text from `classifyErrorBody`, unchanged. */
export function blockedError(reason: string): Error {
  return plainError('ChatGptBlockedError', reason);
}
