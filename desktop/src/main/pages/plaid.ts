// Plaid, on a page's behalf (finance dashboard, 2026-10-05).
//
// A Money page shows bank balances through Plaid. Plaid does not fit the
// ordinary `key` connection: it wants TWO secrets (client id + secret) in the
// JSON body of every call, and every bank the person connects adds a third —
// an access token — that must never reach the page or its saved data. So the
// page never talks to Plaid at all. It asks the app for one of four things
// (connect a bank, reconnect one, read balances, remove one) and main does the
// whole exchange here, holding every secret itself.
//
// Signing in to a bank happens in the person's own web browser through Plaid's
// Hosted Link page: a page cannot run Plaid's script (its CSP allows inline
// script only, and no frames), and we have no web server to receive a callback.
// Main opens the link, then asks Plaid every two seconds whether the session has
// finished (`/link/token/get`), which is Plaid's documented no-webhook path.
//
// What is stored where:
//   - client id + secret: the page connection's saved key (connections-store,
//     encrypted by SecretsStore), as one JSON string.
//   - each bank's access token: SecretsStore, under a ref kept in
//     <userData>/plaid-items.json beside the bank's name, logo and colour.
//     Never synced: an access token is machine-bound ciphertext, like a key.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mutateFileUnderLock } from '../artifacts/cas-write';
import type { SecretsStore } from '../providers/secrets-store';
import type {
  PlaidAccount, PlaidEnvironment, PlaidInstitution, PlaidItemSummary, PlaidRequest, PlaidResult,
} from '../../shared/pages-types';

const PLAID_ITEMS_FILE = 'plaid-items.json';
const HOSTS: Record<PlaidEnvironment, string> = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};
/** How long main waits for the person to finish signing in to a bank. Plaid's
 *  own link lasts four hours; nobody takes that long, and a forgotten browser
 *  tab should not leave a request hanging all afternoon. */
const LINK_WAIT_MS = 20 * 60_000;
const POLL_MS = 2_000;
const CALL_TIMEOUT_MS = 30_000;

export interface PlaidCredentials { clientId: string; secret: string }

/** The saved key is one JSON string holding both halves. Anything else is
 *  treated as missing, never half-used. */
export function parseCredentials(raw: string | null): PlaidCredentials | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const clientId = typeof o.clientId === 'string' ? o.clientId.trim() : '';
    const secret = typeof o.secret === 'string' ? o.secret.trim() : '';
    return clientId && secret ? { clientId, secret } : null;
  } catch { return null; }
}

/** Plaid's own error, kept to the fields that are safe and useful to show. */
class PlaidError extends Error {
  constructor(readonly code: string, message: string, readonly type = '') { super(message); }
}

/** Errors that mean "sign in to this bank again" rather than "something broke". */
// NO_ACCOUNTS is not one of them: it is what a connection says after the bank moved its accounts to a newer one
// (signing in to the same bank twice). Reconnecting would only repeat that, so the page offers Remove instead.
const RECONNECT_CODES = new Set(['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'PENDING_DISCONNECT', 'ACCESS_NOT_GRANTED']);

interface ItemRecord {
  itemId: string;
  env: PlaidEnvironment;
  secretRef: string;
  institution: PlaidInstitution;
  addedAt: string;
}
interface ItemsFile { version: 1; items: Record<string, ItemRecord> }

/** The list of connected banks. Writes go through the shared lock so a dev
 *  instance and the built app never clobber each other's file. */
export class PlaidItemsStore {
  private readonly file: string;
  constructor(userDataDir: string, readonly secrets: SecretsStore) {
    this.file = path.join(userDataDir, PLAID_ITEMS_FILE);
  }

  async list(env: PlaidEnvironment): Promise<ItemRecord[]> {
    let raw: string;
    try { raw = await fs.readFile(this.file, 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return []; throw e; }
    return Object.values(parseItems(raw).items).filter((r) => r.env === env)
      .sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  }

  async accessToken(r: ItemRecord): Promise<string | null> {
    return this.secrets.get(r.secretRef);
  }

  /** Encrypt the token FIRST, then record the pointer: a computer without a
   *  keychain refuses before anything points at a secret that is not there. */
  async add(env: PlaidEnvironment, itemId: string, accessToken: string, institution: PlaidInstitution): Promise<ItemRecord> {
    const existing = (await this.list(env)).find((r) => r.itemId === itemId);
    const secretRef = await this.secrets.set(accessToken, existing?.secretRef);
    const record: ItemRecord = { itemId, env, secretRef, institution, addedAt: existing?.addedAt ?? new Date().toISOString() };
    await this.mutate((cur) => { cur.items[itemId] = record; });
    return record;
  }

  async remove(itemId: string): Promise<void> {
    let ref: string | undefined;
    await this.mutate((cur) => { ref = cur.items[itemId]?.secretRef; delete cur.items[itemId]; });
    if (ref) await this.secrets.delete(ref).catch(() => { /* already gone */ });
  }

  private async mutate(fn: (cur: ItemsFile) => void): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const ok = await mutateFileUnderLock(this.file, (onDisk) => {
      const cur = onDisk ? parseItems(onDisk) : { version: 1 as const, items: {} };
      fn(cur);
      return JSON.stringify(cur, null, 2);
    });
    if (!ok) throw new Error('The list of connected banks is busy in another YouCoded window. Try again in a moment.');
  }
}

function parseItems(raw: string): ItemsFile {
  try {
    const o = JSON.parse(raw) as Partial<ItemsFile>;
    if (o && o.version === 1 && o.items && typeof o.items === 'object') return { version: 1, items: o.items };
  } catch { /* unreadable: start empty rather than guess */ }
  return { version: 1, items: {} };
}

export interface PlaidContext {
  env: PlaidEnvironment;
  creds: PlaidCredentials;
  items: PlaidItemsStore;
  /** Opens a URL in the person's browser (shell.openExternal in production). */
  openExternal: (url: string) => Promise<void> | void;
  fetchImpl?: typeof fetch;
  /** Test hooks: shorter waits. */
  pollMs?: number;
  linkWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Aborted when the person cancels, or starts a new sign-in over this one. */
  signal?: AbortSignal;
}

/** One Plaid call. Plaid always answers JSON; an error answer carries
 *  error_code / error_message / display_message, and we show Plaid's own words
 *  rather than inventing a cause (docs/error-message-standards.md). The
 *  secrets are put in the body here and nowhere else. */
async function plaidCall<T>(ctx: PlaidContext, endpoint: string, body: Record<string, unknown>): Promise<T> {
  const f = ctx.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  let res: Response;
  try {
    res = await f(`${HOSTS[ctx.env]}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: ctx.creds.clientId, secret: ctx.creds.secret, ...body }),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new PlaidError('NETWORK', ctrl.signal.aborted ? 'Plaid did not answer within 30 seconds.' : 'The app could not reach Plaid. Check your internet connection.');
  } finally { clearTimeout(timer); }
  let json: Record<string, unknown> = {};
  try { json = await res.json() as Record<string, unknown>; } catch { /* non-JSON answer */ }
  if (!res.ok || typeof json.error_code === 'string') {
    const code = typeof json.error_code === 'string' ? json.error_code : `HTTP_${res.status}`;
    const shown = (typeof json.display_message === 'string' && json.display_message)
      || (typeof json.error_message === 'string' && json.error_message)
      || `Plaid answered with an error (${res.status}).`;
    throw new PlaidError(code, shown, typeof json.error_type === 'string' ? json.error_type : '');
  }
  return json as T;
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Waits, but wakes the moment the sign-in is cancelled. */
function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleepReal(ms);
  return new Promise<void>((r) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal!.removeEventListener('abort', done); r(); }
    signal.addEventListener('abort', done);
  });
}

/** Create a Hosted Link session (new bank, or update mode for one that needs
 *  signing in again), open it, and wait for it to finish. Returns the public
 *  tokens of every bank added (empty for update mode or a cancelled session). */
type LinkOutcome = { publicTokens: string[]; finished: boolean; exited: boolean; cancelled?: boolean; exitError?: { code: string; message: string } };
async function runHostedLink(ctx: PlaidContext, accessToken?: string): Promise<LinkOutcome> {
  const body: Record<string, unknown> = {
    client_name: 'YouCoded',
    language: 'en',
    country_codes: ['US'],
    user: { client_user_id: 'youcoded-local-user' },
    hosted_link: {},
  };
  if (accessToken) body.access_token = accessToken;
  else {
    // WHY these products: `transactions` is what nearly every bank, card and
    // loan supports, so Link offers the widest list of institutions; it also
    // makes cached balances available. `liabilities` adds credit limits, due
    // dates and loan details wherever the bank has them, without refusing a
    // bank that has none (a checking-only bank still connects).
    body.products = ['transactions'];
    body.required_if_supported_products = ['liabilities'];
    body.optional_products = ['investments'];
    body.transactions = { days_requested: 30 };
  }
  const created = await plaidCall<{ link_token: string; hosted_link_url?: string }>(ctx, '/link/token/create', body);
  if (!created.hosted_link_url) throw new PlaidError('NO_HOSTED_LINK', 'Plaid did not return a sign-in page for this account. Hosted Link may not be enabled for your Plaid team.');
  await ctx.openExternal(created.hosted_link_url);

  const sleep = ctx.sleep ?? ((ms: number) => sleepOrAbort(ms, ctx.signal));
  const deadline = Date.now() + (ctx.linkWaitMs ?? LINK_WAIT_MS);
  // WHY a way out: closing the browser tab tells Plaid nothing, so the session never "finishes" and this loop
  // would hold the page's Connect button for the full 20 minutes (seen on the first real Amex try).
  const cancelled = (): LinkOutcome => ({ publicTokens: [], finished: false, exited: false, cancelled: true });
  while (Date.now() < deadline) {
    if (ctx.signal?.aborted) return cancelled();
    await sleep(ctx.pollMs ?? POLL_MS);
    if (ctx.signal?.aborted) return cancelled();
    const got = await plaidCall<{ link_sessions?: Array<{
      finished_at?: string | null;
      exit?: { error?: { error_code?: string; error_message?: string; display_message?: string | null } | null; metadata?: { institution?: { name?: string } | null } | null } | null;
      results?: { item_add_results?: Array<{ public_token?: string }> };
      on_success?: { public_token?: string } | null;
    }> }>(ctx, '/link/token/get', { link_token: created.link_token });
    const sessions = got.link_sessions ?? [];
    const done = sessions.find((s) => s.finished_at);
    if (!done) continue;
    const tokens = sessions.flatMap((s) => (s.results?.item_add_results ?? []).map((r) => r.public_token).filter((t): t is string => !!t));
    // Legacy field, for a team whose sessions report only on_success.
    if (!tokens.length && done.on_success?.public_token) tokens.push(done.on_success.public_token);
    // When the bank or Plaid refused, keep Plaid's own reason so the page can say it rather than a vague failure.
    const err = done.exit?.error;
    const bank = done.exit?.metadata?.institution?.name;
    const exitError = err && (err.error_code || err.display_message || err.error_message)
      ? { code: err.error_code || 'LINK_ERROR', message: `${bank ? bank + ': ' : ''}${err.display_message || err.error_message || 'the sign-in did not finish.'}` }
      : undefined;
    return { publicTokens: tokens, finished: true, exited: !!done.exit && !tokens.length, exitError };
  }
  return { publicTokens: [], finished: false, exited: false };
}

async function institutionFor(ctx: PlaidContext, institutionId: string | null | undefined, fallbackName: string): Promise<PlaidInstitution> {
  if (!institutionId) return { id: '', name: fallbackName };
  try {
    const r = await plaidCall<{ institution: { institution_id: string; name: string; logo?: string | null; primary_color?: string | null; url?: string | null } }>(
      ctx, '/institutions/get_by_id', { institution_id: institutionId, country_codes: ['US'], options: { include_optional_metadata: true } },
    );
    const i = r.institution;
    return {
      id: i.institution_id,
      name: i.name,
      // A base64 PNG. Stored as a data: address because a page may show data:
      // pictures but may not load one from the internet.
      logo: i.logo ? `data:image/png;base64,${i.logo}` : undefined,
      color: i.primary_color && /^#[0-9a-f]{6}$/i.test(i.primary_color) ? i.primary_color : undefined,
      url: i.url && /^https:\/\//i.test(i.url) ? i.url : undefined,
    };
  } catch {
    // The logo is a nicety: a bank whose details cannot be read still connects.
    return { id: institutionId, name: fallbackName };
  }
}

/** Plaid's type/subtype → the page's five groups. */
export function kindOf(type: string, subtype: string | null | undefined): PlaidAccount['kind'] {
  const s = (subtype ?? '').toLowerCase();
  if (type === 'credit') return 'credit';
  if (type === 'loan') return 'loan';
  if (type === 'investment' || type === 'brokerage') return 'investment';
  if (type === 'depository') return s === 'checking' || s === 'prepaid' || s === 'paypal' ? 'checking' : 'savings';
  return 'other';
}

interface RawAccount {
  account_id: string; name: string; official_name?: string | null; mask?: string | null;
  type: string; subtype?: string | null;
  balances: { current: number | null; available: number | null; limit: number | null; iso_currency_code?: string | null };
}
interface RawLiability {
  account_id: string; is_overdue?: boolean | null; last_payment_date?: string | null; last_payment_amount?: number | null;
  next_payment_due_date?: string | null; minimum_payment_amount?: number | null;
  aprs?: Array<{ apr_percentage: number; apr_type: string }>;
  interest_rate_percentage?: number | null;
  interest_rate?: { percentage?: number | null } | null;
}

async function accountsFor(ctx: PlaidContext, r: ItemRecord, live: boolean): Promise<PlaidItemSummary> {
  const base: PlaidItemSummary = { itemId: r.itemId, institution: r.institution, ok: true, accounts: [] };
  const token = await ctx.items.accessToken(r).catch(() => null);
  if (!token) return { ...base, ok: false, error: { code: 'NO_TOKEN', message: `This computer no longer holds the sign-in for ${r.institution.name}. Connect it again.`, reconnect: false } };
  try {
    // Live asks the bank right now (a paid call outside Plaid's free Trial);
    // otherwise Plaid's own copy, refreshed about once a day.
    const acc = await plaidCall<{ accounts: RawAccount[] }>(ctx, live ? '/accounts/balance/get' : '/accounts/get', { access_token: token });
    const liab = new Map<string, RawLiability>();
    try {
      const l = await plaidCall<{ liabilities?: { credit?: RawLiability[] | null; student?: RawLiability[] | null; mortgage?: RawLiability[] | null } }>(ctx, '/liabilities/get', { access_token: token });
      for (const x of [...(l.liabilities?.credit ?? []), ...(l.liabilities?.student ?? []), ...(l.liabilities?.mortgage ?? [])]) liab.set(x.account_id, x);
    } catch (e) {
      // A bank with no cards or loans answers PRODUCTS_NOT_SUPPORTED or
      // NO_LIABILITY_ACCOUNTS: that is not a failure of the balances.
      if (e instanceof PlaidError && RECONNECT_CODES.has(e.code)) throw e;
    }
    base.accounts = acc.accounts.map((a) => {
      const l = liab.get(a.account_id);
      const purchase = l?.aprs?.find((x) => x.apr_type === 'purchase_apr') ?? l?.aprs?.[0];
      const apr = purchase?.apr_percentage ?? l?.interest_rate_percentage ?? l?.interest_rate?.percentage ?? undefined;
      return {
        id: a.account_id,
        name: a.name,
        officialName: a.official_name ?? undefined,
        mask: a.mask ?? undefined,
        type: a.type,
        subtype: a.subtype ?? undefined,
        kind: kindOf(a.type, a.subtype),
        balance: a.balances.current ?? a.balances.available ?? 0,
        available: a.balances.available ?? undefined,
        limit: a.balances.limit ?? undefined,
        currency: a.balances.iso_currency_code ?? undefined,
        liability: l ? {
          apr: typeof apr === 'number' ? apr : undefined,
          minimumPayment: l.minimum_payment_amount ?? undefined,
          nextDue: l.next_payment_due_date ?? undefined,
          lastPaymentDate: l.last_payment_date ?? undefined,
          lastPaymentAmount: l.last_payment_amount ?? undefined,
          isOverdue: l.is_overdue ?? undefined,
        } : undefined,
      } satisfies PlaidAccount;
    });
    return base;
  } catch (e) {
    const err = e instanceof PlaidError ? e : new PlaidError('UNKNOWN', 'Plaid could not read this bank.');
    return { ...base, ok: false, error: { code: err.code, message: err.message, reconnect: RECONNECT_CODES.has(err.code) } };
  }
}

/** The four things a page may ask for. Nothing returned ever carries a
 *  client id, secret or access token. */
export async function runPlaid(ctx: PlaidContext, req: PlaidRequest): Promise<PlaidResult> {
  try {
    switch (req.op) {
      case 'status': {
        const items = await ctx.items.list(ctx.env);
        return { ok: true, op: 'status', items: items.map((r) => ({ itemId: r.itemId, institution: r.institution, ok: true, accounts: [] })) };
      }
      case 'accounts': {
        const items = await ctx.items.list(ctx.env);
        const out = await Promise.all(items.map((r) => accountsFor(ctx, r, !!req.live)));
        return { ok: true, op: 'accounts', items: out };
      }
      case 'connect': {
        const link = await runHostedLink(ctx);
        if (link.cancelled) return { ok: false, op: 'connect', code: 'CANCELLED', message: 'Connecting was stopped.' };
        if (!link.finished) return { ok: false, op: 'connect', code: 'TIMED_OUT', message: 'Signing in to the bank was not finished within 20 minutes. Try again when you are ready.' };
        if (!link.publicTokens.length) return link.exitError
          ? { ok: false, op: 'connect', code: link.exitError.code, message: link.exitError.message }
          : { ok: false, op: 'connect', code: 'CANCELLED', message: 'No bank was connected.' };
        const added: PlaidItemSummary[] = [];
        for (const pt of link.publicTokens) {
          const ex = await plaidCall<{ access_token: string; item_id: string }>(ctx, '/item/public_token/exchange', { public_token: pt });
          const item = await plaidCall<{ item: { institution_id?: string | null; institution_name?: string | null } }>(ctx, '/item/get', { access_token: ex.access_token });
          const institution = await institutionFor(ctx, item.item.institution_id, item.item.institution_name ?? 'Bank');
          await ctx.items.add(ctx.env, ex.item_id, ex.access_token, institution);
          added.push({ itemId: ex.item_id, institution, ok: true, accounts: [] });
        }
        return { ok: true, op: 'connect', items: added };
      }
      case 'reconnect': {
        const r = (await ctx.items.list(ctx.env)).find((x) => x.itemId === req.itemId);
        if (!r) return { ok: false, op: 'reconnect', code: 'NO_ITEM', message: 'That bank is not connected on this computer.' };
        const token = await ctx.items.accessToken(r);
        if (!token) return { ok: false, op: 'reconnect', code: 'NO_TOKEN', message: `This computer no longer holds the sign-in for ${r.institution.name}. Remove it and connect it again.` };
        const link = await runHostedLink(ctx, token);
        if (link.cancelled) return { ok: false, op: 'reconnect', code: 'CANCELLED', message: 'Reconnecting was stopped.' };
        if (link.exitError) return { ok: false, op: 'reconnect', code: link.exitError.code, message: link.exitError.message };
        if (!link.finished) return { ok: false, op: 'reconnect', code: 'TIMED_OUT', message: 'Signing in to the bank was not finished within 20 minutes. Try again when you are ready.' };
        return { ok: true, op: 'reconnect', items: [] };
      }
      // Handled by the pages service (it owns the in-flight sign-in); answered here only for completeness.
      case 'cancel': return { ok: true, op: 'cancel', items: [] };
      case 'remove': {
        const r = (await ctx.items.list(ctx.env)).find((x) => x.itemId === req.itemId);
        if (!r) return { ok: true, op: 'remove', items: [] };
        const token = await ctx.items.accessToken(r).catch(() => null);
        // Tell Plaid first so the bank stops sharing (and billing stops); a
        // failure there still forgets the bank locally, which is what was asked.
        if (token) await plaidCall(ctx, '/item/remove', { access_token: token }).catch(() => {});
        await ctx.items.remove(r.itemId);
        return { ok: true, op: 'remove', items: [] };
      }
    }
  } catch (e) {
    const err = e instanceof PlaidError ? e : new PlaidError('UNKNOWN', e instanceof Error && e.message ? e.message : 'Plaid could not finish this request.');
    return { ok: false, op: req.op, code: err.code, message: err.message };
  }
}

/** Opens Plaid's sign-in page in the person's browser — only an https page on
 *  plaid.com, so nothing else Plaid's answer might name is ever opened. Electron
 *  is loaded on first use, so tests that never sign in never touch it. */
export async function openPlaidLink(url: string): Promise<void> {
  if (!/^https:\/\/([a-z0-9-]+\.)*plaid\.com\//i.test(url)) throw new PlaidError('BAD_LINK', 'Plaid returned a sign-in address the app will not open.');
  const { shell } = await import('electron');
  await shell.openExternal(url);
}

/** The page sends anything; only these shapes get through. */
export function cleanPlaidRequest(raw: unknown): PlaidRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const itemId = typeof o.itemId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(o.itemId) ? o.itemId : '';
  switch (o.op) {
    case 'status': return { op: 'status' };
    case 'connect': return { op: 'connect' };
    case 'cancel': return { op: 'cancel' };
    case 'accounts': return { op: 'accounts', live: o.live === true };
    case 'reconnect': return itemId ? { op: 'reconnect', itemId } : null;
    case 'remove': return itemId ? { op: 'remove', itemId } : null;
    default: return null;
  }
}
