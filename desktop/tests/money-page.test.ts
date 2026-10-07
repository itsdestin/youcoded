// The Money page (dev/workbench/fixtures/money/money-page.html), run in jsdom with a fake `window.youcoded`.
// The same file is the page a person installs, so these pin what it does with real Plaid answers.
// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HTML = readFileSync(fileURLToPath(new URL('../src/renderer/dev/workbench/fixtures/money/money-page.html', import.meta.url)), 'utf8');

// WHY a dynamic import by name: jsdom ships without type declarations in this install, and the page only needs its
// constructor. Loaded once, before the first test (its cold import is the slow part).
const JSDOM_MODULE = 'jsdom';
let JSDOM: new (html: string, opts: object) => { window: Window & typeof globalThis };
beforeAll(async () => { ({ JSDOM } = (await import(JSDOM_MODULE)) as { JSDOM: typeof JSDOM }); });

type Plaid = (req: { op: string; itemId?: string; live?: boolean }) => Promise<unknown>;
function open(data: unknown, plaid?: Plaid) {
  const saved: any[] = [];
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w: any) {
      w.HTMLElement.prototype.scrollIntoView = () => {};
      w.youcoded = {
        data: JSON.parse(JSON.stringify(data)),
        save: (d: unknown) => saved.push(JSON.parse(JSON.stringify(d))),
        onData: () => {}, onRefresh: () => {},
        ...(plaid ? { plaid } : {}),
      };
    },
  });
  const d = dom.window.document;
  const text = () => d.getElementById('root')!.textContent ?? '';
  const click = (sel: string) => (d.querySelector(sel) as HTMLElement).click();
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { d, saved, text, click, settle, last: () => saved[saved.length - 1] };
}

const TODAY = '2026-10-06';
const bankAnswer = {
  ok: true, op: 'accounts', items: [
    { itemId: 'item-1', ok: true, institution: { id: 'ins_1', name: 'Chase', color: '#117aca', url: 'https://www.chase.com' }, accounts: [
      { id: 'a1', name: 'Total Checking', mask: '1234', type: 'depository', subtype: 'checking', kind: 'checking', balance: 1500 },
      { id: 'a2', name: 'Freedom', type: 'credit', subtype: 'credit card', kind: 'credit', balance: 400, limit: 1000,
        liability: { apr: 24.99, minimumPayment: 35, nextDue: '2026-10-20', lastPaymentDate: '2026-09-18', lastPaymentAmount: 35 } },
    ] },
    { itemId: 'item-2', ok: false, institution: { id: 'ins_2', name: 'Synchrony' }, accounts: [],
      error: { code: 'ITEM_LOGIN_REQUIRED', message: 'Sign in again.', reconnect: true } },
  ],
};

describe('the Money page', () => {
  it('reads live balances on open and folds them into its saved accounts, keeping hand-entered ones', async () => {
    const asked: unknown[] = [];
    const p = open({ demoToday: TODAY, accounts: [{ id: 'm1', source: 'manual', kind: 'loan', institution: 'Earnest', name: 'Loan', balance: 20000, updatedAt: `${TODAY}T10:00:00Z` }] },
      async (req) => { asked.push(req); return bankAnswer; });
    await p.settle();
    // Live balances first, then new purchases since the page's bookmark (none yet).
    expect(asked).toEqual([{ op: 'accounts', live: true }, { op: 'transactions', cursors: {} }]);
    const data = p.last();
    expect(data.accounts.map((a: any) => a.id).sort()).toEqual(['m1', 'plaid:a1', 'plaid:a2']);
    expect(data.accounts.find((a: any) => a.id === 'plaid:a2')).toMatchObject({ itemId: 'item-1', kind: 'credit', limit: 1000, apr: 24.99, payment: { amount: 35, due: '2026-10-20' } });
    // Net worth = 1500 − 400 − 20000, in accounting brackets with the dollar sign outside.
    expect(p.text()).toContain('$(18,900)');
    expect(data.history).toEqual([{ d: expect.any(String), v: -18900 }]);
    expect(data.banks['item-2']).toMatchObject({ ok: false, error: { reconnect: true } });
    expect(p.text()).toContain('Reconnect Synchrony');
  });

  it('ignores a due date months in the past instead of calling it years late', async () => {
    const stale = { ok: true, op: 'accounts', items: [{ itemId: 'i', ok: true, institution: { id: '', name: 'Bank' }, accounts: [
      { id: 's', name: 'Student', type: 'loan', kind: 'loan', balance: 1000, liability: { minimumPayment: 25, nextDue: '2019-05-28' } },
    ] }] };
    const p = open({ demoToday: TODAY }, async () => stale);
    await p.settle();
    expect(p.last().accounts[0].payment).toBeNull();
    expect(p.text()).not.toContain('days late');
  });

  it('a bank that needs signing in again keeps its last numbers rather than dropping them from the totals', async () => {
    const prior = { demoToday: TODAY, banks: { 'item-2': { name: 'Synchrony', ok: true } }, accounts: [
      { id: 'plaid:s1', itemId: 'item-2', source: 'plaid', kind: 'credit', institution: 'Synchrony', name: 'Store card', balance: 820, limit: 1000, updatedAt: '2026-10-01T12:00:00Z' },
    ] };
    const p = open(prior, async () => bankAnswer);
    await p.settle();
    expect(p.last().accounts.some((a: any) => a.id === 'plaid:s1')).toBe(true);
  });

  it('with no banks connected any more, drops accounts that came from a bank and keeps the ones entered by hand', async () => {
    const prior = { demoToday: TODAY, banks: { old: { name: 'Practice', ok: true } }, accounts: [
      { id: 'plaid:x', itemId: 'old', source: 'plaid', kind: 'checking', institution: 'Practice', name: 'Fake', balance: 1, updatedAt: `${TODAY}T10:00:00Z` },
      { id: 'm1', source: 'manual', kind: 'loan', institution: 'Earnest', name: 'Loan', balance: 5, updatedAt: `${TODAY}T10:00:00Z` },
    ] };
    const p = open(prior, async () => ({ ok: true, op: 'accounts', items: [] }));
    await p.settle();
    expect(p.last().accounts.map((a: any) => a.id)).toEqual(['m1']);
    expect(p.last().banks).toEqual({});
  });

  it('a payment typed onto a bank-connected auto loan survives every refresh, and its name is not doubled', async () => {
    const answer = { ok: true, op: 'accounts', items: [{ itemId: 'wf', ok: true, institution: { id: '', name: 'Wells Fargo' }, accounts: [
      { id: 'auto', name: 'AUTO LOAN ...8709', mask: '8709', type: 'loan', subtype: 'auto', kind: 'loan', balance: 14876 },
    ] }] };
    const p = open({ demoToday: TODAY }, async () => answer);
    await p.settle();
    expect(p.last().accounts[0].name).toBe('AUTO LOAN ...8709');
    p.click('[data-open="plaid:auto"]');
    expect(p.text()).toContain('No due date yet');
    p.click('[data-pay="plaid:auto"]');
    (p.d.getElementById('pay-amt') as HTMLInputElement).value = '412';
    (p.d.getElementById('pay-due') as HTMLInputElement).value = '2026-10-18';
    (p.d.getElementById('pay-apr') as HTMLInputElement).value = '6.49';
    p.click('[data-pay-save="plaid:auto"]');
    p.click('#check');
    await p.settle();
    expect(p.last().accounts[0]).toMatchObject({ apr: 6.49, payment: { amount: 412, due: '2026-10-18', manual: true } });
    expect(p.text()).toContain('Wells Fargo AUTO LOAN ...8709');
  });

  it('a bank connected twice is counted once: the dead connection\'s copies give way to the working one', async () => {
    const prior = { demoToday: TODAY, banks: { old: { name: 'Capital One', ok: true } }, accounts: [
      { id: 'plaid:o1', itemId: 'old', source: 'plaid', kind: 'credit', institution: 'Capital One', name: 'Quicksilver ··3863', balance: 100, updatedAt: `${TODAY}T10:00:00Z` },
    ] };
    const answer = { ok: true, op: 'accounts', items: [
      { itemId: 'old', ok: false, institution: { id: '', name: 'Capital One' }, accounts: [], error: { code: 'NO_ACCOUNTS', message: 'x', reconnect: false } },
      { itemId: 'new', ok: true, institution: { id: '', name: 'Capital One' }, accounts: [{ id: 'n1', name: 'Quicksilver', mask: '3863', type: 'credit', kind: 'credit', balance: 120 }] },
    ] };
    const p = open(prior, async () => answer);
    await p.settle();
    expect(p.last().accounts.map((a: any) => a.id)).toEqual(['plaid:n1']);
    expect(p.text()).toContain('no longer reaches any accounts');
  });

  it('asks the app to reconnect a bank, then checks again', async () => {
    const asked: any[] = [];
    const p = open({ demoToday: TODAY }, async (req) => { asked.push(req); return req.op === 'reconnect' ? { ok: true, op: 'reconnect', items: [] } : bankAnswer; });
    await p.settle();
    p.click('[data-reconnect="item-2"]');
    await p.settle(); await p.settle();
    expect(asked.map((r) => r.op)).toEqual(['accounts', 'transactions', 'reconnect', 'accounts', 'transactions']);
  });

  it('while a bank sign-in is open, Cancel stops it and a late answer is ignored', async () => {
    let finish: (v: unknown) => void = () => {};
    const asked: any[] = [];
    const p = open({ demoToday: TODAY, accounts: [{ id: 'm1', source: 'manual', kind: 'checking', institution: 'X', name: 'Y', balance: 1, updatedAt: `${TODAY}T10:00:00Z` }] },
      (req) => { asked.push(req); if (req.op === 'connect') return new Promise((r) => { finish = r; }); return Promise.resolve({ ok: true, op: req.op, items: [] }); });
    await p.settle();
    p.click('#add'); p.click('[data-add="bank"]');
    expect(p.text()).toContain('Finish signing in to your bank');
    p.click('[data-cancel-link]');
    expect(asked.at(-1)).toEqual({ op: 'cancel' });
    expect(p.text()).not.toContain('Finish signing in to your bank');
    finish({ ok: false, op: 'connect', code: 'CANCELLED', message: 'Connecting was stopped.' });
    await p.settle();
    expect(p.d.querySelector('[role="alert"]')).toBeNull();
  });

  it('remembers the browser chosen for bank sign-ins and asks for it', async () => {
    const asked: any[] = [];
    const p = open({ demoToday: TODAY, accounts: [{ id: 'm1', source: 'manual', kind: 'checking', institution: 'X', name: 'Y', balance: 1, updatedAt: `${TODAY}T10:00:00Z` }] },
      (req) => { asked.push(req); return req.op === 'connect' ? new Promise(() => {}) : Promise.resolve({ ok: true, op: req.op, items: [] }); });
    await p.settle();
    p.click('#add'); p.click('[data-browser="firefox"]');
    expect(p.last().settings.browser).toBe('firefox');
    p.click('[data-add="bank"]');
    expect(asked.at(-1)).toEqual({ op: 'connect', browser: 'firefox' });
  });

  it('with no Plaid keys yet, shows the welcome card and no warning', async () => {
    const p = open({}, async () => ({ ok: false, op: 'accounts', code: 'NO_KEYS', message: 'No keys' }));
    await p.settle();
    expect(p.text()).toContain('Connect a bank');
    expect(p.d.querySelector('[role="alert"]')).toBeNull();
  });

  it('adds an account by hand and updates its balance', async () => {
    const p = open({ demoToday: TODAY });
    p.click('#add');
    p.click('[data-add="hand"]');
    (p.d.getElementById('f-institution') as HTMLInputElement).value = 'Earnest';
    (p.d.getElementById('f-name') as HTMLInputElement).value = 'Student loan';
    (p.d.getElementById('f-balance') as HTMLInputElement).value = '22,410';
    p.click('[data-form-save]');
    const id = p.last().accounts[0].id;
    expect(p.last().accounts[0]).toMatchObject({ source: 'manual', kind: 'loan', institution: 'Earnest', balance: 22410 });
    // Update lives inside the opened card now (round 3: trimmed cards).
    p.click(`[data-open="${id}"]`);
    p.click(`[data-edit="${id}"]`);
    (p.d.getElementById('edit-val') as HTMLInputElement).value = '22,100';
    p.click('[data-save]');
    expect(p.last().accounts[0].balance).toBe(22100);
  });

  it('a card opens in place with its details and actions, and closes again', () => {
    const p = open({ demoToday: TODAY, accounts: [{ id: 'm1', source: 'manual', kind: 'credit', institution: 'Synchrony', name: 'Store card', balance: 300, updatedAt: `${TODAY}T10:00:00Z` }] });
    p.click('[data-open="m1"]');
    expect(p.d.querySelector('[data-open="m1"]')!.getAttribute('aria-expanded')).toBe('true');
    expect(p.text()).toContain('Set limit');
    p.click('[data-limit="m1"]');
    (p.d.getElementById('limit-val') as HTMLInputElement).value = '1,000';
    p.click('[data-limit-save="m1"]');
    expect(p.last().accounts[0].limit).toBe(1000);
    expect(p.text()).toContain('30% used');
    // Opened again, it works out what the card does not say: the room left before 30%.
    p.click('[data-open="m1"]'); p.click('[data-open="m1"]');
    expect(p.text()).toContain('you can spend before this card passes 30% of its limit');
    p.click('[data-open="m1"]');
    expect(p.d.querySelector('[data-open="m1"]')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('an opened loan says when it is paid off and what $50 more a month would change', () => {
    const p = open({ demoToday: TODAY, accounts: [{ id: 'l', source: 'manual', kind: 'loan', institution: 'Earnest', name: 'Loan', balance: 10000, apr: 6, updatedAt: `${TODAY}T10:00:00Z`, payment: { amount: 200, due: '2026-10-15' } }] });
    p.click('[data-open="l"]');
    // 10,000 at 6% and $200/month clears in 58 months; $250/month in 45.
    expect(p.text()).toContain('(4 years 10 months)');
    expect(p.text()).toContain('1 year 1 month sooner');
  });

  it('bills sort by due date (late first) by default, or by amount', () => {
    const p = open({ demoToday: TODAY, bills: [
      { id: 'a', provider: 'A', name: 'Small soon', amount: 10, due: '2026-10-08' },
      { id: 'b', provider: 'B', name: 'Big later', amount: 500, due: '2026-11-01' },
      { id: 'c', provider: 'C', name: 'Late', amount: 50, due: '2026-10-01' },
    ] });
    const order = () => [...p.d.querySelectorAll('.bill .name')].map((e) => e.firstChild!.textContent);
    expect(order()).toEqual(['Late', 'Small soon', 'Big later']);
    p.click('[data-bill-sort="amount"]');
    expect(order()).toEqual(['Big later', 'Late', 'Small soon']);
  });

  const tx = (id: string, date: string, amount: number, name: string, category = 'ENTERTAINMENT', detail = 'ENTERTAINMENT_TV_AND_MOVIES') =>
    ({ id, account: 'chk', date, amount, name, category, detail });
  const withPurchases = (added: unknown[]) => async (req: { op: string }) => req.op === 'transactions'
    ? { ok: true, op: 'transactions', items: [{ itemId: 'b', ok: true, institution: { id: '', name: 'Bank' }, accounts: [], transactions: { added, modified: [], removed: [], cursor: 'cur1' } }] }
    : { ok: true, op: 'accounts', items: [{ itemId: 'b', ok: true, institution: { id: '', name: 'Bank' }, accounts: [{ id: 'chk', name: 'Checking', type: 'depository', subtype: 'checking', kind: 'checking', balance: 1000 }] }] };

  it('keeps purchases with their bookmark, and finds a repeating payment to offer as a bill', async () => {
    const p = open({ demoToday: TODAY }, withPurchases([
      tx('n1', '2026-08-03', 15.49, 'Netflix'), tx('n2', '2026-09-03', 15.49, 'Netflix'),
      tx('g1', '2026-09-20', 52.1, 'Safeway', 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES'),
      tx('x1', '2026-09-21', 500, 'Transfer to savings', 'TRANSFER_OUT', 'TRANSFER_OUT_SAVINGS'),
    ]));
    await p.settle(); await p.settle();
    expect(p.last().txCursor).toEqual({ b: 'cur1' });
    expect(p.last().tx).toHaveLength(4);
    expect(p.text()).toContain('Found 1 repeating payment');
    p.click('[data-add-found="netflix"]');
    expect(p.last().bills[0]).toMatchObject({ name: 'Netflix', amount: 15.49, due: '2026-10-03', category: 'Subscriptions', match: ['netflix'] });
    expect(p.text()).not.toContain('Found 1 repeating payment');
  });

  it('a linked payment near a bill\'s due date marks it paid and moves it to next month', async () => {
    const p = open({ demoToday: TODAY, bills: [{ id: 'b1', provider: 'Netflix', name: 'Netflix', amount: 15.49, due: '2026-10-03', monthly: true, category: 'Subscriptions' }] },
      withPurchases([tx('n3', '2026-10-03', 17.99, 'NETFLIX.COM 866-579')]));
    await p.settle(); await p.settle();
    // The bill named Netflix linked itself to "NETFLIX.COM 866-579", took the new price, and moved on.
    expect(p.last().bills[0]).toMatchObject({ match: ['netflix'], lastPaid: '2026-10-03', due: '2026-11-03', amount: 17.99 });
  });

  it('spending leaves out transfers, and the chart can switch to it', async () => {
    const p = open({ demoToday: TODAY }, withPurchases([
      tx('g1', '2026-10-02', 40, 'Safeway', 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES'),
      tx('x1', '2026-10-02', 500, 'Transfer', 'TRANSFER_OUT', 'TRANSFER_OUT_SAVINGS'),
    ]));
    await p.settle(); await p.settle();
    p.click('[data-mode="spend"]');
    expect(p.text()).toContain('Spent this month$40');
    expect(p.d.querySelectorAll('#chart rect').length).toBeGreaterThan(0);
    expect(p.text()).toContain('Food & dining');
  });

  it('a pay-later plan is added by its payments and counts down when one is made', () => {
    const p = open({ demoToday: TODAY });
    p.click('#add'); p.click('[data-add="hand"]');
    const kind = p.d.getElementById('f-kind') as HTMLSelectElement;
    kind.value = 'bnpl'; kind.dispatchEvent(new p.d.defaultView!.Event('change'));
    (p.d.getElementById('f-institution') as HTMLInputElement).value = 'Affirm';
    (p.d.getElementById('f-name') as HTMLInputElement).value = 'Laptop';
    (p.d.getElementById('f-payment') as HTMLInputElement).value = '86.25';
    (p.d.getElementById('f-left') as HTMLInputElement).value = '4';
    (p.d.getElementById('f-due') as HTMLInputElement).value = '2026-10-10';
    p.click('[data-form-save]');
    const a = p.last().accounts[0];
    expect(a).toMatchObject({ kind: 'bnpl', balance: 345, left: 4, payment: { amount: 86.25, due: '2026-10-10', every: '2weeks' } });
    p.click(`[data-open="${a.id}"]`);
    p.click(`[data-paid="${a.id}"]`);
    expect(p.last().accounts[0]).toMatchObject({ left: 3, balance: 258.75, payment: { due: '2026-10-24' } });
  });

  it('a bill offers look-alike payments to link, and they can be unlinked', async () => {
    const p = open({ demoToday: TODAY, bills: [{ id: 'b1', provider: 'Spotify', name: 'Spotify', amount: 11.99, due: '2026-10-20', category: 'Subscriptions' }] },
      withPurchases([tx('s1', '2026-09-20', 11.99, 'Spotify USA'), tx('s2', '2026-08-20', 11.99, 'Spotify P1A2B3')]));
    await p.settle(); await p.settle();
    // "Spotify P1A2B3" reads as plain "spotify", so the bill linked that one itself; "Spotify USA" is offered.
    expect(p.last().bills[0].match).toEqual(['spotify']);
    p.click('[data-open="bill:b1"]');
    expect(p.text()).toContain('Might be this bill');
    p.click('[data-link-key="spotify usa"]');
    expect(p.last().bills[0].match).toEqual(['spotify', 'spotify usa']);
    p.click('[data-unlink-key="spotify usa"]');
    expect(p.last().bills[0].match).toEqual(['spotify']);
  });

  it('marking a monthly bill paid moves it to next month', () => {
    const p = open({ demoToday: TODAY, bills: [{ id: 'b1', provider: 'Visible', name: 'Visible', amount: 25, due: '2026-10-07' }] });
    p.click('[data-paid="b1"]');
    expect(p.last().bills[0]).toMatchObject({ due: '2026-11-07', lastPaid: TODAY, paidLog: [TODAY] });
  });

  it('warns a week before a late payment reaches the credit report', () => {
    const p = open({ demoToday: TODAY, accounts: [{ id: 'm1', source: 'manual', kind: 'credit', institution: 'Synchrony', name: 'Store card', balance: 100, updatedAt: `${TODAY}T10:00:00Z`, payment: { amount: 40, due: '2026-09-12' } }] });
    expect(p.text()).toContain('24 days late · on your credit report in 6 days');
  });
});
