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
    expect(asked).toEqual([{ op: 'accounts', live: true }]);
    const data = p.last();
    expect(data.accounts.map((a: any) => a.id).sort()).toEqual(['m1', 'plaid:a1', 'plaid:a2']);
    expect(data.accounts.find((a: any) => a.id === 'plaid:a2')).toMatchObject({ itemId: 'item-1', kind: 'credit', limit: 1000, apr: 24.99, payment: { amount: 35, due: '2026-10-20' } });
    // Net worth = 1500 − 400 − 20000, written in brackets.
    expect(p.text()).toContain('($18,900)');
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

  it('asks the app to reconnect a bank, then checks again', async () => {
    const asked: any[] = [];
    const p = open({ demoToday: TODAY }, async (req) => { asked.push(req); return req.op === 'reconnect' ? { ok: true, op: 'reconnect', items: [] } : bankAnswer; });
    await p.settle();
    p.click('[data-reconnect="item-2"]');
    await p.settle(); await p.settle();
    expect(asked.map((r) => r.op)).toEqual(['accounts', 'reconnect', 'accounts']);
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
