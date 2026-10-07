// Plaid on a page's behalf (main/pages/plaid.ts) — finance dashboard, 2026-10-05.
// A fake Plaid answers each endpoint; nothing touches the network.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PlaidItemsStore, cleanPlaidRequest, kindOf, parseCredentials, runPlaid, type PlaidContext } from '../src/main/pages/plaid';
import { parseConnections, fingerprint, covers, savedKeyTarget } from '../src/main/pages/page-connections';
import type { SecretsStore } from '../src/main/providers/secrets-store';

function fakeSecrets() {
  const m = new Map<string, string>();
  let n = 0;
  return {
    map: m,
    async set(v: string, ref?: string) { const r = ref ?? `ref${++n}`; m.set(r, v); return r; },
    async get(r: string) { return m.has(r) ? m.get(r)! : null; },
    async delete(r: string) { m.delete(r); },
  } as unknown as SecretsStore & { map: Map<string, string> };
}

type Handler = (body: Record<string, unknown>) => unknown;
function fakePlaid(handlers: Record<string, Handler>) {
  const calls: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const endpoint = new URL(url).pathname;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ endpoint, body });
    const h = handlers[endpoint];
    const out = h ? h(body) : { error_code: 'NOT_FOUND', error_message: `no fake for ${endpoint}` };
    const isErr = !!(out as { error_code?: string }).error_code;
    return new Response(JSON.stringify(out), { status: isErr ? 400 : 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('plaid', () => {
  let dir: string;
  let secrets: ReturnType<typeof fakeSecrets>;
  let items: PlaidItemsStore;
  const opened: string[] = [];
  const ctx = (fetchImpl: typeof fetch): PlaidContext => ({
    env: 'sandbox', creds: { clientId: 'cid', secret: 'sec' }, items,
    openExternal: (u) => { opened.push(u); }, fetchImpl, pollMs: 0, sleep: async () => {},
  });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'plaid-'));
    secrets = fakeSecrets();
    items = new PlaidItemsStore(dir, secrets);
    opened.length = 0;
  });

  it('connects a bank through Hosted Link: opens Plaid, waits, exchanges, keeps the token out of the answer and the file', async () => {
    let polls = 0;
    const { calls, fetchImpl } = fakePlaid({
      '/link/token/create': () => ({ link_token: 'link-1', hosted_link_url: 'https://hosted.plaid.com/link/abc' }),
      '/link/token/get': () => (++polls < 3 ? { link_sessions: [{ finished_at: null }] }
        : { link_sessions: [{ finished_at: '2026-10-05T00:00:00Z', results: { item_add_results: [{ public_token: 'public-1' }] } }] }),
      '/item/public_token/exchange': () => ({ access_token: 'access-SECRET-1', item_id: 'item-1' }),
      '/item/get': () => ({ item: { institution_id: 'ins_1', institution_name: 'First Platypus Bank' } }),
      '/institutions/get_by_id': () => ({ institution: { institution_id: 'ins_1', name: 'First Platypus Bank', logo: 'iVBORw0KGgo=', primary_color: '#1f6feb', url: 'https://platypus.example' } }),
    });
    const r = await runPlaid(ctx(fetchImpl), { op: 'connect' });
    expect(r.ok).toBe(true);
    expect(opened).toEqual(['https://hosted.plaid.com/link/abc']);
    expect(polls).toBe(3);
    // Every call carries the keys in the body, from main.
    expect(calls.every((c) => c.body.client_id === 'cid' && c.body.secret === 'sec')).toBe(true);
    const create = calls.find((c) => c.endpoint === '/link/token/create')!.body;
    expect(create.hosted_link).toEqual({});
    expect(create.products).toEqual(['transactions']);
    if (!r.ok) return;
    expect(r.items[0].institution).toMatchObject({ name: 'First Platypus Bank', color: '#1f6feb', logo: 'data:image/png;base64,iVBORw0KGgo=' });
    // The access token never comes back to the page, and is not written in plain text.
    expect(JSON.stringify(r)).not.toContain('access-SECRET-1');
    expect(readFileSync(path.join(dir, 'plaid-items.json'), 'utf8')).not.toContain('access-SECRET-1');
    expect([...secrets.map.values()]).toContain('access-SECRET-1');
  });

  it('a session the person closes without connecting is a plain "no bank was connected"', async () => {
    const { fetchImpl } = fakePlaid({
      '/link/token/create': () => ({ link_token: 'l', hosted_link_url: 'https://hosted.plaid.com/x' }),
      '/link/token/get': () => ({ link_sessions: [{ finished_at: '2026-10-05T00:00:00Z', exit: { status: 'requires_credentials' } }] }),
    });
    const r = await runPlaid(ctx(fetchImpl), { op: 'connect' });
    expect(r).toMatchObject({ ok: false, code: 'CANCELLED' });
  });

  it('stops waiting the moment the sign-in is cancelled (a closed browser tab tells Plaid nothing)', async () => {
    const { fetchImpl } = fakePlaid({
      '/link/token/create': () => ({ link_token: 'l', hosted_link_url: 'https://hosted.plaid.com/x' }),
      '/link/token/get': () => ({ link_sessions: [{ finished_at: null }] }),
    });
    const ctrl = new AbortController();
    let polls = 0;
    const r = await runPlaid({ ...ctx(fetchImpl), signal: ctrl.signal, sleep: async () => { if (++polls === 3) ctrl.abort(); } }, { op: 'connect' });
    expect(r).toMatchObject({ ok: false, code: 'CANCELLED' });
    expect(polls).toBe(3);
  });

  it('a sign-in the bank refused comes back with Plaid\'s own reason, naming the bank', async () => {
    const { fetchImpl } = fakePlaid({
      '/link/token/create': () => ({ link_token: 'l', hosted_link_url: 'https://hosted.plaid.com/x' }),
      '/link/token/get': () => ({ link_sessions: [{ finished_at: '2026-10-05T00:00:00Z', exit: {
        error: { error_code: 'INSTITUTION_NOT_RESPONDING', display_message: 'This bank is not responding right now.' },
        metadata: { institution: { name: 'American Express' } } } }] }),
    });
    const r = await runPlaid(ctx(fetchImpl), { op: 'connect' });
    expect(r).toEqual({ ok: false, op: 'connect', code: 'INSTITUTION_NOT_RESPONDING', message: 'American Express: This bank is not responding right now.' });
  });

  it('gives up waiting after the deadline instead of hanging', async () => {
    const { fetchImpl } = fakePlaid({
      '/link/token/create': () => ({ link_token: 'l', hosted_link_url: 'https://hosted.plaid.com/x' }),
      '/link/token/get': () => ({ link_sessions: [] }),
    });
    const r = await runPlaid({ ...ctx(fetchImpl), linkWaitMs: 0 }, { op: 'connect' });
    expect(r).toMatchObject({ ok: false, code: 'TIMED_OUT' });
  });

  it('reads balances with card limits, due dates and loan rates, and maps every account to a group', async () => {
    await items.add('sandbox', 'item-1', 'access-1', { id: 'ins_1', name: 'Bank' });
    const { calls, fetchImpl } = fakePlaid({
      '/accounts/balance/get': () => ({ accounts: [
        { account_id: 'a1', name: 'Checking', type: 'depository', subtype: 'checking', balances: { current: 100, available: 90, limit: null } },
        { account_id: 'a2', name: 'Savings', type: 'depository', subtype: 'savings', balances: { current: 500, available: 500, limit: null } },
        { account_id: 'a3', name: 'Card', type: 'credit', subtype: 'credit card', balances: { current: 410, available: 590, limit: 1000 } },
        { account_id: 'a4', name: 'Student', type: 'loan', subtype: 'student', balances: { current: 9000, available: null, limit: null } },
      ] }),
      '/liabilities/get': () => ({ liabilities: {
        credit: [{ account_id: 'a3', is_overdue: false, next_payment_due_date: '2026-10-20', minimum_payment_amount: 25, last_payment_date: '2026-09-20', aprs: [{ apr_type: 'purchase_apr', apr_percentage: 24.9 }] }],
        student: [{ account_id: 'a4', interest_rate_percentage: 5.2, next_payment_due_date: '2026-10-15', minimum_payment_amount: 120 }],
      } }),
    });
    const r = await runPlaid(ctx(fetchImpl), { op: 'accounts', live: true });
    expect(calls.map((c) => c.endpoint)).toEqual(['/accounts/balance/get', '/liabilities/get']);
    expect(calls[0].body.access_token).toBe('access-1');
    if (!r.ok) throw new Error(r.message);
    const acc = r.items[0].accounts;
    expect(acc.map((a) => a.kind)).toEqual(['checking', 'savings', 'credit', 'loan']);
    expect(acc[2]).toMatchObject({ balance: 410, limit: 1000, liability: { apr: 24.9, nextDue: '2026-10-20', minimumPayment: 25 } });
    expect(acc[3].liability).toMatchObject({ apr: 5.2, nextDue: '2026-10-15' });
  });

  it('uses Plaid\'s daily copy when not asked for live balances', async () => {
    await items.add('sandbox', 'item-1', 'access-1', { id: '', name: 'Bank' });
    const { calls, fetchImpl } = fakePlaid({
      '/accounts/get': () => ({ accounts: [] }),
      '/liabilities/get': () => ({ error_code: 'PRODUCTS_NOT_SUPPORTED', error_message: 'no liabilities' }),
    });
    const r = await runPlaid(ctx(fetchImpl), { op: 'accounts' });
    expect(calls[0].endpoint).toBe('/accounts/get');
    // A bank with no cards or loans is still fine.
    expect(r.ok && r.items[0].ok).toBe(true);
  });

  it('a bank that needs signing in again says so, per bank, without failing the others', async () => {
    await items.add('sandbox', 'item-1', 'access-1', { id: '', name: 'Good Bank' });
    await items.add('sandbox', 'item-2', 'access-2', { id: '', name: 'Stale Bank' });
    const { fetchImpl } = fakePlaid({
      '/accounts/balance/get': (b) => (b.access_token === 'access-2'
        ? { error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'the login details of this item have changed', display_message: 'Sign in to Stale Bank again.' }
        : { accounts: [] }),
      '/liabilities/get': () => ({ liabilities: {} }),
    });
    const r = await runPlaid(ctx(fetchImpl), { op: 'accounts', live: true });
    if (!r.ok) throw new Error(r.message);
    expect(r.items.map((i) => i.ok)).toEqual([true, false]);
    expect(r.items[1].error).toEqual({ code: 'ITEM_LOGIN_REQUIRED', message: 'Sign in to Stale Bank again.', reconnect: true });
  });

  it('syncs purchases from the page\'s bookmark, page by page, keeping only what the page needs', async () => {
    await items.add('sandbox', 'item-1', 'access-1', { id: '', name: 'Bank' });
    const pages = [
      { added: [{ transaction_id: 't1', account_id: 'a1', date: '2026-10-01', amount: 15.49, name: 'NETFLIX.COM 866', merchant_name: 'Netflix', personal_finance_category: { primary: 'ENTERTAINMENT', detailed: 'ENTERTAINMENT_TV_AND_MOVIES' } }], modified: [], removed: [], next_cursor: 'c1', has_more: true },
      { added: [], modified: [], removed: [{ transaction_id: 't0' }], next_cursor: 'c2', has_more: false },
    ];
    const { calls, fetchImpl } = fakePlaid({ '/transactions/sync': () => pages.shift()! });
    const r = await runPlaid(ctx(fetchImpl), { op: 'transactions', cursors: { 'item-1': 'c0' } });
    expect(calls.map((c) => c.body.cursor)).toEqual(['c0', 'c1']);
    if (!r.ok) throw new Error(r.message);
    expect(r.items[0].transactions).toEqual({
      added: [{ id: 't1', account: 'a1', date: '2026-10-01', amount: 15.49, name: 'Netflix', category: 'ENTERTAINMENT', detail: 'ENTERTAINMENT_TV_AND_MOVIES' }],
      modified: [], removed: ['t0'], cursor: 'c2',
    });
  });

  it('a bank whose purchases are not ready yet is fine and keeps its bookmark', async () => {
    await items.add('sandbox', 'item-1', 'access-1', { id: '', name: 'Bank' });
    const { fetchImpl } = fakePlaid({ '/transactions/sync': () => ({ error_code: 'PRODUCT_NOT_READY', error_message: 'not yet' }) });
    const r = await runPlaid(ctx(fetchImpl), { op: 'transactions', cursors: { 'item-1': 'keep' } });
    expect(r.ok && r.items[0]).toMatchObject({ ok: true, transactions: { added: [], cursor: 'keep' } });
  });

  it('removing a bank tells Plaid and forgets its sign-in', async () => {
    await items.add('sandbox', 'item-1', 'access-1', { id: '', name: 'Bank' });
    const { calls, fetchImpl } = fakePlaid({ '/item/remove': () => ({}) });
    const r = await runPlaid(ctx(fetchImpl), { op: 'remove', itemId: 'item-1' });
    expect(r.ok).toBe(true);
    expect(calls[0]).toMatchObject({ endpoint: '/item/remove', body: { access_token: 'access-1' } });
    expect(await items.list('sandbox')).toEqual([]);
    expect(secrets.map.size).toBe(0);
  });

  it('practice and real banks are kept apart', async () => {
    await items.add('sandbox', 'item-s', 'a', { id: '', name: 'Practice' });
    await items.add('production', 'item-p', 'b', { id: '', name: 'Real' });
    expect((await items.list('sandbox')).map((r) => r.itemId)).toEqual(['item-s']);
    expect((await items.list('production')).map((r) => r.itemId)).toEqual(['item-p']);
  });

  it('accepts only the five requests, with a well-formed bank id', () => {
    expect(cleanPlaidRequest({ op: 'accounts', live: 'yes' })).toEqual({ op: 'accounts', live: false });
    expect(cleanPlaidRequest({ op: 'remove', itemId: '../../etc' })).toBeNull();
    expect(cleanPlaidRequest({ op: 'transfer' })).toBeNull();
    expect(cleanPlaidRequest(null)).toBeNull();
  });

  it('a sign-in may name its browser; anything else falls back to the default', () => {
    expect(cleanPlaidRequest({ op: 'connect', browser: 'firefox' })).toEqual({ op: 'connect', browser: 'firefox' });
    expect(cleanPlaidRequest({ op: 'connect', browser: 'rm -rf' })).toEqual({ op: 'connect', browser: 'default' });
  });

  it('reads the saved key only when both halves are there', () => {
    expect(parseCredentials('{"clientId":"a","secret":"b"}')).toEqual({ clientId: 'a', secret: 'b' });
    expect(parseCredentials('{"clientId":"a"}')).toBeNull();
    expect(parseCredentials('not json')).toBeNull();
  });

  it('maps Plaid account types to the page\'s groups', () => {
    expect(kindOf('depository', 'money market')).toBe('savings');
    expect(kindOf('depository', 'checking')).toBe('checking');
    expect(kindOf('investment', 'brokerage')).toBe('investment');
    expect(kindOf('other', null)).toBe('other');
  });
});

describe('the plaid connection in a page manifest', () => {
  it('parses one per page, keeps it apart from "any website", and never covers a fetch address', () => {
    const [c] = parseConnections([{ id: 'bank', kind: 'plaid', environment: 'sandbox' }, { id: 'bank2', kind: 'plaid', environment: 'production' }]);
    expect(c).toMatchObject({ id: 'bank', kind: 'plaid', environment: 'sandbox' });
    expect(parseConnections([{ id: 'bank', kind: 'plaid', environment: 'sandbox' }, { id: 'o', kind: 'open' }])).toEqual([]);
    expect(parseConnections([{ id: 'bank', kind: 'plaid', environment: 'staging' }])).toEqual([]);
    expect(covers(c, new URL('https://sandbox.plaid.com/accounts/get'))).toBe(false);
  });

  it('switching from practice to real banks asks again, and the key is kept per environment', () => {
    const [s] = parseConnections([{ id: 'b', kind: 'plaid', environment: 'sandbox' }]);
    const [p] = parseConnections([{ id: 'b', kind: 'plaid', environment: 'production' }]);
    expect(fingerprint(s)).not.toBe(fingerprint(p));
    expect(savedKeyTarget(s)).toEqual({ service: 'Plaid', address: 'sandbox.plaid.com' });
    expect(savedKeyTarget(p)).toEqual({ service: 'Plaid', address: 'production.plaid.com' });
  });
});
