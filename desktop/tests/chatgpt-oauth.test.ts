// chatgpt-oauth — the pure half of Sign in with ChatGPT. Pins design §8's row
// for tests/chatgpt-oauth.test.ts: the PKCE maths, the authorize URL, the token
// bodies, claim decoding, the usage and manifest parsers AGAINST THE PHASE 0
// FIXTURES (real bodies, secrets stripped), the 429 → limit-sentence mapping,
// and — load-bearing for the card's exact wording — that the three thrown
// errors own no statusCode/status/code and reach describeProviderError intact.
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  CHATGPT_CLIENT_ID, CHATGPT_AUTHORIZE_URL, CHATGPT_REDIRECT_URI, CHATGPT_SCOPE,
  CHATGPT_CODEX_BASE_URL, CHATGPT_USAGE_URL, CHATGPT_ACCOUNTS_CHECK_URL, chatGptModelsUrl,
  CHATGPT_SIGN_IN_REQUIRED_MESSAGE, CHATGPT_SIGN_IN_EXPIRED_MESSAGE,
  generatePkce, generateState, buildAuthorizeUrl, exchangeBody, refreshBody, tokenExpiresAt,
  decodeJwtClaims, accountFromTokens,
  parseUsageBody, parseUsageHeaders, toChatGptUsage, windowLabel, epochToMs,
  parseModelsManifest,
  classifyErrorBody, limitError, expiredError, blockedError,
  type ParsedUsage,
} from '../src/main/providers/chatgpt-oauth';
import { chatGptLimitMessage, isChatGptLimitMessage, CHATGPT_UPGRADE_URL } from '../src/shared/chatgpt-types';
import { formatDayLong } from '../src/shared/time-format';
import { describeProviderError } from '../src/main/harness/harness-session';

const FIXTURES = path.join(__dirname, 'fixtures', 'chatgpt');
const fixture = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

// A fixed "now" so every reset-after computation is deterministic.
const NOW = Date.parse('2026-09-05T12:00:00.000Z');

// Deterministic randomness: byte i = i. The PKCE test recomputes the S256
// challenge with node's crypto from the verifier this produces.
const countingBytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => i & 0xff);

// A hand-built JWT with fixture-like claims. NEVER a real token: the signature
// is junk and the parser does not check it.
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.c2ln`;
}

describe('chatgpt-oauth: constants and the sign-in round trip', () => {
  it('carries the verified constants', () => {
    expect(CHATGPT_CLIENT_ID).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(CHATGPT_REDIRECT_URI).toBe('http://localhost:1455/auth/callback');
    expect(CHATGPT_SCOPE).toBe('openid profile email offline_access');
    expect(CHATGPT_CODEX_BASE_URL).toBe('https://chatgpt.com/backend-api/codex');
    expect(CHATGPT_USAGE_URL).toBe('https://chatgpt.com/backend-api/wham/usage');
    expect(CHATGPT_ACCOUNTS_CHECK_URL).toBe('https://chatgpt.com/backend-api/wham/accounts/check');
    expect(chatGptModelsUrl('1.2.4')).toBe('https://chatgpt.com/backend-api/codex/models?client_version=1.2.4');
    expect(chatGptModelsUrl('1.0.0 beta/2')).toBe('https://chatgpt.com/backend-api/codex/models?client_version=1.0.0%20beta%2F2');
    expect(CHATGPT_SIGN_IN_REQUIRED_MESSAGE).toBe('Sign in with ChatGPT in Settings → Model Providers to use this model.');
  });

  it('PKCE: the challenge is base64url(S256(verifier)), no padding, verifier in the RFC length range', () => {
    const { verifier, challenge } = generatePkce(countingBytes);
    expect(verifier).toBe(Buffer.from(countingBytes(32)).toString('base64url'));
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(challenge).not.toMatch(/[+/=]/);
    expect(generateState(countingBytes)).toBe('000102030405060708090a0b0c0d0e0f');
  });

  it('the authorize URL carries client id, scope, redirect, state, challenge and method', () => {
    const { challenge } = generatePkce(countingBytes);
    const url = new URL(buildAuthorizeUrl({ state: 'abc123', challenge }));
    expect(url.origin + url.pathname).toBe(CHATGPT_AUTHORIZE_URL);
    const p = url.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe(CHATGPT_CLIENT_ID);
    expect(p.get('redirect_uri')).toBe(CHATGPT_REDIRECT_URI);
    expect(p.get('scope')).toBe(CHATGPT_SCOPE);
    expect(p.get('state')).toBe('abc123');
    expect(p.get('code_challenge')).toBe(challenge);
    expect(p.get('code_challenge_method')).toBe('S256');
    // The two flags the Phase 0 sign-in went through with.
    expect(p.get('id_token_add_organizations')).toBe('true');
    expect(p.get('codex_cli_simplified_flow')).toBe('true');
  });

  it('exchange and refresh bodies are form-encoded with the right grant', () => {
    const ex = new URLSearchParams(exchangeBody({ code: 'the code', verifier: 'v_1-2' }));
    expect(Object.fromEntries(ex)).toEqual({
      grant_type: 'authorization_code', client_id: CHATGPT_CLIENT_ID, code: 'the code',
      code_verifier: 'v_1-2', redirect_uri: CHATGPT_REDIRECT_URI,
    });
    const rf = new URLSearchParams(refreshBody({ refreshToken: 'rt-xyz' }));
    expect(Object.fromEntries(rf)).toEqual({ grant_type: 'refresh_token', client_id: CHATGPT_CLIENT_ID, refresh_token: 'rt-xyz' });
  });

  it('tokenExpiresAt converts seconds to an absolute ms deadline, and an unusable value means "already expired"', () => {
    expect(tokenExpiresAt(864000, NOW)).toBe(NOW + 864000 * 1000);
    expect(tokenExpiresAt('3600', NOW)).toBe(NOW + 3600 * 1000);
    expect(tokenExpiresAt(undefined, NOW)).toBe(NOW);
    expect(tokenExpiresAt(-5, NOW)).toBe(NOW);
  });
});

describe('chatgpt-oauth: claims', () => {
  const access = jwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-0000', chatgpt_plan_type: 'free', chatgpt_user_id: 'user-x' },
    'https://api.openai.com/profile': { email: 'user@example.com', email_verified: true },
    exp: 1791189231,
  });
  const id = jwt({ email: 'id@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-0000', chatgpt_plan_type: 'free' } });

  it('decodes a base64url payload and tolerates junk', () => {
    expect(decodeJwtClaims(access)?.exp).toBe(1791189231);
    // Standard base64 alphabet with padding decodes too.
    const std = `h.${Buffer.from('{"a":"+/"}').toString('base64')}.s`;
    expect(decodeJwtClaims(std)).toEqual({ a: '+/' });
    expect(decodeJwtClaims('not.a.jwt')).toBeNull();
    expect(decodeJwtClaims('two.parts')).toBeNull();
    expect(decodeJwtClaims(undefined)).toBeNull();
    expect(decodeJwtClaims(`h.${Buffer.from('[1]').toString('base64url')}.s`)).toBeNull();
  });

  it('reads account id + plan from the auth claim and the email from the access token profile', () => {
    expect(accountFromTokens({ accessToken: access, idToken: id })).toEqual({ accountId: 'acct-0000', plan: 'free', email: 'user@example.com' });
    // The id token is only needed when the access token has no profile email.
    const noProfile = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-0000', chatgpt_plan_type: 'plus' } });
    expect(accountFromTokens({ accessToken: noProfile, idToken: id })).toEqual({ accountId: 'acct-0000', plan: 'plus', email: 'id@example.com' });
    expect(accountFromTokens({ accessToken: noProfile })).toEqual({ accountId: 'acct-0000', plan: 'plus', email: '' });
    // No account id anywhere → no account (nothing could be addressed).
    expect(accountFromTokens({ accessToken: jwt({ sub: 'x' }), idToken: jwt({ email: 'e@x' }) })).toBeNull();
  });
});

describe('chatgpt-oauth: usage', () => {
  it('parseUsageBody against usage.free.json: one 30-day window, plan free, reset_at seconds → ISO', () => {
    const parsed = parseUsageBody(fixture('usage.free.json'), NOW)!;
    expect(parsed.plan).toBe('free');
    expect(parsed.limitReached).toBe(false);
    expect(parsed.windows).toEqual([
      { minutes: 43200, usedPercent: 0, resetsAt: new Date(1791189231 * 1000).toISOString() },
    ]);
    expect(parseUsageBody({ hello: 1 }, NOW)).toBeNull();
    expect(parseUsageBody('nope', NOW)).toBeNull();
  });

  it('parseUsageBody on a Plus-shaped body: 5-hour primary + 7-day secondary, reset_after_seconds from now', () => {
    const plus = {
      plan_type: 'plus',
      rate_limit: {
        limit_reached: true,
        primary_window: { used_percent: 87.5, limit_window_seconds: 18000, reset_after_seconds: 1200 },
        secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: 1757505600 },
      },
    };
    const parsed = parseUsageBody(plus, NOW)!;
    expect(parsed.plan).toBe('plus');
    expect(parsed.limitReached).toBe(true);
    expect(parsed.windows).toEqual([
      { minutes: 300, usedPercent: 87.5, resetsAt: new Date(NOW + 1200 * 1000).toISOString() },
      { minutes: 10080, usedPercent: 40, resetsAt: new Date(1757505600 * 1000).toISOString() },
    ]);
  });

  it('parseUsageHeaders against responses-headers.free.json: primary only, secondary absent (0 minutes, empty reset)', () => {
    const { headers } = fixture('responses-headers.free.json') as { headers: Record<string, string> };
    const get = (name: string) => headers[name.toLowerCase()] ?? null;
    const parsed = parseUsageHeaders(get, NOW)!;
    expect(parsed.plan).toBe('free');
    expect(parsed.windows).toEqual([
      { minutes: 43200, usedPercent: 0, resetsAt: new Date(1791189238 * 1000).toISOString() },
    ]);
    // A reply with no window headers at all is not a usage reply.
    expect(parseUsageHeaders(() => null, NOW)).toBeNull();
    // Plus-shaped headers: both windows, reset-after when reset-at is empty.
    const plus: Record<string, string> = {
      'x-codex-plan-type': 'plus',
      'x-codex-primary-used-percent': '12', 'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': '', 'x-codex-primary-reset-after-seconds': '600',
      'x-codex-secondary-used-percent': '3.5', 'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-at': '1757505600', 'x-codex-secondary-reset-after-seconds': '0',
    };
    expect(parseUsageHeaders((n) => plus[n] ?? null, NOW)).toEqual({
      plan: 'plus',
      windows: [
        { minutes: 300, usedPercent: 12, resetsAt: new Date(NOW + 600 * 1000).toISOString() },
        { minutes: 10080, usedPercent: 3.5, resetsAt: new Date(1757505600 * 1000).toISOString() },
      ],
    });
  });

  it('toChatGptUsage files windows by length: 300 → five_hour, 10080 → seven_day, else other', () => {
    const parsed: ParsedUsage = {
      windows: [
        { minutes: 300, usedPercent: 10, resetsAt: 'A' },
        { minutes: 10080, usedPercent: 20, resetsAt: 'B' },
        { minutes: 43200, usedPercent: 0, resetsAt: 'C' },
      ],
    };
    expect(toChatGptUsage(parsed)).toEqual({
      five_hour: { utilization: 10, resets_at: 'A' },
      seven_day: { utilization: 20, resets_at: 'B' },
      other: [{ minutes: 43200, utilization: 0, resets_at: 'C' }],
    });
    // Keys exist only for windows that do — the free plan gets ONLY `other`.
    const free = toChatGptUsage(parseUsageBody(fixture('usage.free.json'), NOW)!);
    expect(Object.keys(free)).toEqual(['other']);
    expect(toChatGptUsage({ windows: [] })).toEqual({});
  });

  it('epochToMs tells seconds from milliseconds by size', () => {
    expect(epochToMs(1791189231)).toBe(1791189231000);
    expect(epochToMs('1791189231')).toBe(1791189231000);
    expect(epochToMs(1791189231000)).toBe(1791189231000);
    expect(epochToMs('')).toBeNull();
    expect(epochToMs(0)).toBeNull();
    expect(epochToMs(null)).toBeNull();
  });

  it('windowLabel: 5-hour, weekly, else days', () => {
    expect(windowLabel(300)).toBe('5-hour');
    expect(windowLabel(10080)).toBe('weekly');
    expect(windowLabel(43200)).toBe('30-day');
    expect(windowLabel(1440)).toBe('1-day');
    expect(windowLabel(2880)).toBe('2-day');
    // Sub-day windows read in hours, never as "1-day".
    expect(windowLabel(60)).toBe('1-hour');
    expect(windowLabel(90)).toBe('2-hour');
  });
});

describe('chatgpt-oauth: the model list', () => {
  it('parseModelsManifest against models.json: listed rows only, by priority, no pricing key', () => {
    const rows = parseModelsManifest(fixture('models.json'));
    expect(rows.map((r) => r.id)).toEqual(['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-mini']);
    for (const r of rows) {
      expect(r.providerId).toBe('chatgpt');
      expect(r.supportsTools).toBe(true);
      expect(r.supportsReasoning).toBe(true);
      expect(r.supportsVision).toBe(true);
      expect(r.contextLength).toBe(272000);
      expect('pricing' in r).toBe(false);
    }
    expect(rows[0].label).toBe('GPT-5.6-Terra');
    expect(rows[3].label).toBe('GPT-5.4-Mini');
  });

  it('falls back to a title-cased slug, leaves vision undefined when the row does not say, and survives junk', () => {
    const rows = parseModelsManifest({
      models: [
        { slug: 'zz-last', visibility: 'list', priority: 9 },
        { slug: 'b-first', visibility: 'list', priority: 1, supported_reasoning_levels: [], input_modalities: ['text'] },
        { slug: 'hidden', visibility: 'hide', priority: 0 },
        { visibility: 'list', priority: 0 },
        'garbage',
      ],
    });
    expect(rows.map((r) => r.id)).toEqual(['b-first', 'zz-last']);
    expect(rows[0]).toEqual({ id: 'b-first', providerId: 'chatgpt', label: 'B First', supportsTools: true, supportsReasoning: false, supportsVision: false });
    expect(rows[1].supportsVision).toBeUndefined();
    expect(rows[1].contextLength).toBeUndefined();
    expect(parseModelsManifest(null)).toEqual([]);
    expect(parseModelsManifest({ models: 'x' })).toEqual([]);
  });
});

describe('chatgpt-oauth: the limit sentence (words deck W-1, answer a)', () => {
  // Local-time dates, so the weekday/clock the sentence renders are the same
  // in any timezone the suite runs in. 2026-09-08 is a Tuesday.
  const tue = new Date(2026, 8, 8, 18, 43).toISOString();
  const oct3 = new Date(2026, 9, 3, 18, 43).toISOString();

  it('the 5-hour sentence is byte-identical to the approved wording, on every locale', () => {
    // The formatter is hand-rolled (shared/time-format.ts), so the computer's
    // locale cannot turn "6:43pm" into "18:43" — a UK/EU/JP machine used to
    // get the 24-hour form from toLocaleTimeString while the chip said 6:43pm.
    // Prove it by making the locale-following call return the wrong thing.
    const spy = vi.spyOn(Date.prototype, 'toLocaleTimeString').mockReturnValue('18:43');
    try {
      expect(chatGptLimitMessage('5-hour', tue)).toBe("You have reached ChatGPT's 5-hour session limit (Resets @ 6:43pm).");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    // And the locale call is gone from the source, not just unreached.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'chatgpt-types.ts'), 'utf8');
    expect(src).not.toMatch(/toLocale(Time|Date)?String/);
    expect(src).toMatch(/from '\.\/time-format'/);
    // The chip formats with the same function, so the two cannot drift.
    const bar = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'components', 'StatusBar.tsx'), 'utf8');
    // Any import list is fine as long as formatTime12 comes from the shared module —
    // the chip may pull more helpers from it later (it already does), and pinning the
    // exact list broke the moment the plan-window work widened it.
    expect(bar).toMatch(/import \{[^}]*\bformatTime12\b[^}]*\} from '\.\.\/\.\.\/shared\/time-format'/);
    expect(bar).not.toMatch(/function formatTime12/);
  });

  // The Upgrade plan button deep-links to OpenAI's own upgrade page — the URL
  // the Codex CLI's limit error names ("Upgrade to Pro
  // (https://chatgpt.com/explore/pro)"). Pinned so the button and the fix it
  // offers can never drift onto a guessed destination.
  it('the plan-limit card upgrade URL is OpenAI\'s explore/pro page', () => {
    expect(CHATGPT_UPGRADE_URL).toBe('https://chatgpt.com/explore/pro');
  });

  // The day is spelled out in full so the card and the 7-day chip beside it read
  // the SAME way. The W-1 deck offered "Tue" on the claim that the chip already
  // said "Tue"; it never has. Destin picked the long form on 2026-09-05, which
  // leaves the chip every existing Claude subscriber sees completely untouched.
  it('the weekly sentence names the day in full, like the 7-day chip; longer windows name month and day', () => {
    expect(chatGptLimitMessage('weekly', tue)).toBe("You have reached ChatGPT's weekly session limit (Resets Tuesday @ 6:43pm).");
    expect(chatGptLimitMessage('30-day', oct3)).toBe("You have reached ChatGPT's 30-day session limit (Resets Oct 3 @ 6:43pm).");
    // The card and the chip must not drift apart again.
    expect(chatGptLimitMessage('weekly', tue)).toContain(formatDayLong(new Date(tue)));
    // An unparsable reset never produces "Resets Tuesday @ later".
    expect(chatGptLimitMessage('weekly', '')).toBe("You have reached ChatGPT's weekly session limit (Resets @ later).");
    for (const label of ['5-hour', 'weekly', '30-day']) expect(isChatGptLimitMessage(chatGptLimitMessage(label, tue))).toBe(true);
  });
});

describe('chatgpt-oauth: classifyErrorBody', () => {
  // pi's shape for a plan limit.
  const limitBody = (resets_at: number | undefined) => ({
    error: { code: 'usage_limit_reached', message: 'You have hit your usage limit.', plan_type: 'plus', ...(resets_at !== undefined ? { resets_at } : {}) },
  });

  it('429 usage_limit_reached with resets_at in epoch ms under 5h away → the 5-hour sentence', () => {
    const resetMs = NOW + 2 * 3600 * 1000;
    const out = classifyErrorBody({ status: 429, body: limitBody(resetMs), now: NOW });
    const iso = new Date(resetMs).toISOString();
    expect(out).toEqual({ kind: 'limit', windowLabel: '5-hour', resetsAt: iso, message: chatGptLimitMessage('5-hour', iso) });
  });

  it('resets_at in epoch SECONDS is normalised too, and the body may be a JSON string', () => {
    const resetS = Math.floor((NOW + 3 * 3600 * 1000) / 1000);
    const out = classifyErrorBody({ status: 429, body: JSON.stringify(limitBody(resetS)), now: NOW });
    expect(out.kind).toBe('limit');
    if (out.kind === 'limit') expect(out.resetsAt).toBe(new Date(resetS * 1000).toISOString());
  });

  it('a reset that matches a snapshot window names THAT window — a free plan gets its 30-day sentence', () => {
    const resetMs = NOW + 20 * 24 * 3600 * 1000;
    const snapshot: ParsedUsage = { plan: 'free', windows: [{ minutes: 43200, usedPercent: 100, resetsAt: new Date(resetMs + 30_000).toISOString() }] };
    const out = classifyErrorBody({ status: 429, body: limitBody(resetMs), lastUsage: snapshot, now: NOW });
    const iso = new Date(resetMs).toISOString();
    expect(out).toEqual({ kind: 'limit', windowLabel: '30-day', windowMinutes: 43200, resetsAt: iso, message: chatGptLimitMessage('30-day', iso) });
  });

  it('a bare limit body with no reset anywhere names the snapshot\'s MOST-USED window, not its longest', () => {
    // Plus, 5-hour bar full, weekly half-used: the 5-hour window is the one that ran out.
    const snapshot: ParsedUsage = {
      plan: 'plus',
      windows: [
        { minutes: 300, usedPercent: 100, resetsAt: new Date(NOW + 2 * 3600_000).toISOString() },
        { minutes: 10080, usedPercent: 50, resetsAt: new Date(NOW + 4 * 24 * 3600_000).toISOString() },
      ],
    };
    expect(classifyErrorBody({ status: 429, body: limitBody(undefined), lastUsage: snapshot, now: NOW })).toEqual({
      kind: 'limit', windowLabel: '5-hour', windowMinutes: 300,
      resetsAt: snapshot.windows[0].resetsAt, message: chatGptLimitMessage('5-hour', snapshot.windows[0].resetsAt),
    });
    // A tie in usage goes to the longer window.
    const tied: ParsedUsage = { windows: snapshot.windows.map((w) => ({ ...w, usedPercent: 100 })) };
    expect(classifyErrorBody({ status: 429, body: limitBody(undefined), lastUsage: tied, now: NOW })).toMatchObject({ windowLabel: 'weekly', windowMinutes: 10080 });
  });

  it('a reset more than 5h away with no snapshot → weekly; with a snapshot → its most-used window', () => {
    const resetMs = NOW + 3 * 24 * 3600 * 1000;
    const iso = new Date(resetMs).toISOString();
    expect(classifyErrorBody({ status: 429, body: limitBody(resetMs), now: NOW })).toMatchObject({ kind: 'limit', windowLabel: 'weekly', resetsAt: iso });
    const snapshot: ParsedUsage = {
      windows: [
        { minutes: 300, usedPercent: 1, resetsAt: new Date(NOW + 3600_000).toISOString() },
        { minutes: 10080, usedPercent: 99, resetsAt: new Date(NOW + 5 * 24 * 3600_000).toISOString() },
      ],
    };
    // No reset in the body, no retry-after: the snapshot's most-used window (99 % weekly) supplies label AND reset.
    expect(classifyErrorBody({ status: 429, body: limitBody(undefined), lastUsage: snapshot, now: NOW })).toEqual({
      kind: 'limit', windowLabel: 'weekly', windowMinutes: 10080,
      resetsAt: snapshot.windows[1].resetsAt, message: chatGptLimitMessage('weekly', snapshot.windows[1].resetsAt),
    });
  });

  it('falls back to the retry-after header, then to "later"', () => {
    const headers = (n: string) => (n === 'retry-after' ? '1800' : null);
    const out = classifyErrorBody({ status: 429, body: limitBody(undefined), headers, now: NOW });
    expect(out).toMatchObject({ kind: 'limit', windowLabel: '5-hour', resetsAt: new Date(NOW + 1800_000).toISOString() });
    const bare = classifyErrorBody({ status: 429, body: limitBody(undefined), now: NOW });
    expect(bare).toEqual({ kind: 'limit', windowLabel: 'weekly', resetsAt: '', message: "You have reached ChatGPT's weekly session limit (Resets @ later)." });
  });

  it('usage_not_included counts as a limit; a burst 429 does not', () => {
    expect(classifyErrorBody({ status: 429, body: { error: { code: 'usage_not_included', message: 'x' } }, now: NOW }).kind).toBe('limit');
    expect(classifyErrorBody({ status: 429, body: { error: { code: 'rate_limit_exceeded', message: 'Too many requests, slow down.' } }, now: NOW })).toEqual({ kind: 'other' });
    expect(classifyErrorBody({ status: 429, body: 'Too Many Requests', now: NOW })).toEqual({ kind: 'other' });
  });

  it('401 → expired; 403 → blocked with OpenAI\'s text verbatim; anything else → other', () => {
    expect(classifyErrorBody({ status: 401, body: { error: { message: 'Unauthorized' } }, now: NOW })).toEqual({ kind: 'expired' });
    expect(classifyErrorBody({ status: 403, body: { error: { message: 'Your workspace admin has disabled Codex.' } }, now: NOW }))
      .toEqual({ kind: 'blocked', reason: 'Your workspace admin has disabled Codex.' });
    expect(classifyErrorBody({ status: 403, body: { detail: 'Plan does not include Codex.' }, now: NOW }))
      .toEqual({ kind: 'blocked', reason: 'Plan does not include Codex.' });
    expect(classifyErrorBody({ status: 403, body: '  Forbidden by policy \n', now: NOW })).toEqual({ kind: 'blocked', reason: 'Forbidden by policy' });
    const GENERAL = "OpenAI refused this account's requests (HTTP 403).";
    expect(classifyErrorBody({ status: 403, body: '', now: NOW })).toEqual({ kind: 'blocked', reason: GENERAL });
    // A 403 does not always come from OpenAI. A proxy or Cloudflare answers with a
    // whole HTML page, and this reason is shown on the card AND saved to the account
    // file — so markup and novel-length bodies fall back to the general line instead
    // of being rendered verbatim. OpenAI's own JSON always wins over both.
    const CLOUDFLARE = '<!DOCTYPE html><html><head><title>403 Forbidden</title></head><body>…</body></html>';
    expect(classifyErrorBody({ status: 403, body: CLOUDFLARE, now: NOW })).toEqual({ kind: 'blocked', reason: GENERAL });
    expect(classifyErrorBody({ status: 403, body: 'x'.repeat(301), now: NOW })).toEqual({ kind: 'blocked', reason: GENERAL });
    expect(classifyErrorBody({ status: 403, body: JSON.stringify({ detail: 'Plan does not include Codex.', extra: '<b>' }), now: NOW }))
      .toEqual({ kind: 'blocked', reason: 'Plan does not include Codex.' });
    expect(classifyErrorBody({ status: 400, body: { detail: 'Stream must be set to true' }, now: NOW })).toEqual({ kind: 'other' });
    expect(classifyErrorBody({ status: 500, body: 'oops', now: NOW })).toEqual({ kind: 'other' });
  });
});

describe('chatgpt-oauth: the three thrown errors reach the user byte for byte', () => {
  const iso = new Date(2026, 8, 8, 18, 43).toISOString();
  const cases: Array<[string, Error, string]> = [
    ['limit', limitError(chatGptLimitMessage('weekly', iso)), chatGptLimitMessage('weekly', iso)],
    ['expired', expiredError(), CHATGPT_SIGN_IN_EXPIRED_MESSAGE],
    ['blocked', blockedError('Your workspace admin has disabled Codex.'), 'Your workspace admin has disabled Codex.'],
  ];

  it.each(cases)('%s: owns no statusCode/status/code, and describeProviderError returns the message unchanged', (_name, err, message) => {
    // Both retry layers key on these; a 429 here would be retried three times
    // and then suffixed "(provider error 429)" — breaking the card's wording.
    for (const key of ['statusCode', 'status', 'code']) expect(Object.prototype.hasOwnProperty.call(err, key)).toBe(false);
    expect((err as unknown as Record<string, unknown>).statusCode).toBeUndefined();
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(message);
    expect(describeProviderError(err)).toBe(message);
  });

  it('the expired sentence is the approved one', () => {
    expect(CHATGPT_SIGN_IN_EXPIRED_MESSAGE).toBe('Your ChatGPT sign-in has expired — sign in again in Settings → Model Providers.');
  });
});
