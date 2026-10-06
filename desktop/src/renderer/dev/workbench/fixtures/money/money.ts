// Workbench fixture: the Money page (finance dashboard, design stage, 2026-10-05).
// Made-up numbers shaped like Destin's real mix of accounts — connected ones
// (what Plaid will likely reach) and typed-in ones (what it likely won't) — so
// the review can judge the layout against something realistic. Nothing here
// is real data. Decisions: docs/active/design/2026-10-05-finance-dashboard/.
import type { PageDocument } from '../../../../../shared/pages-types';

// @ts-ignore TS1343 — Vite rewrites import.meta.glob statically at build time.
const raw = import.meta.glob('./money-page.html', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const MONEY_HTML = raw['./money-page.html'];

// WHY a pinned "today": every date below is relative to it, so screenshots of
// the mockup show the same late bill and the same stale account every day.
const TODAY = '2026-10-06';
const at = (daysAgo: number, hour = 12) => {
  const d = new Date(`${TODAY}T12:00:00`);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};
const shift = (days: number) => {
  const d = new Date(`${TODAY}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

// A year of daily net worth climbing from about −$42k to today's figure, with
// small deterministic wobble (paydays, card swings) so the line looks lived-in.
function history(end: number): { d: string; v: number }[] {
  const out: { d: string; v: number }[] = [];
  const start = -42100;
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 365; i >= 1; i--) {
    const t = (365 - i) / 364;
    const wobble = (rand() - 0.5) * 900 + Math.sin(i / 14 * Math.PI) * 600;
    out.push({ d: shift(-i), v: Math.round(start + (end - start) * t + wobble * (i > 3 ? 1 : 0)) });
  }
  return out;
}

const accounts = [
  { id: 'c1-checking', kind: 'checking', name: '360 Checking', institution: 'Capital One', source: 'plaid', balance: 2418.52, updatedAt: at(0) },
  { id: 'amex-checking', kind: 'checking', name: 'Rewards Checking', institution: 'American Express', source: 'plaid', balance: 1105.2, updatedAt: at(0) },
  { id: 'rh-cash', kind: 'savings', name: 'Cash (earning interest)', institution: 'Robinhood', source: 'plaid', balance: 6240, updatedAt: at(0) },
  { id: 'rh-invest', kind: 'investment', name: 'Individual investing', institution: 'Robinhood', source: 'plaid', balance: 18932.41, updatedAt: at(0) },
  { id: 'c1-card', kind: 'credit', name: 'Quicksilver', institution: 'Capital One', source: 'plaid', balance: 1284.11, limit: 5000, updatedAt: at(0),
    payment: { amount: 35, due: shift(-4), paid: shift(-4) } },
  { id: 'amex-card', kind: 'credit', name: 'Blue Cash Everyday', institution: 'American Express', source: 'plaid', balance: 2940, limit: 8000, updatedAt: at(0),
    payment: { amount: 40, due: shift(15) } },
  { id: 'rh-gold', kind: 'credit', name: 'Robinhood Gold Card', institution: 'Robinhood', source: 'manual', balance: 3100, limit: 5000, updatedAt: at(1, 20),
    payment: { amount: 62, due: shift(9) } },
  { id: 'sync-card', kind: 'credit', name: 'Store card', institution: 'Synchrony', source: 'plaid', balance: 820, limit: 1000, updatedAt: at(4),
    payment: { amount: 40, due: shift(-24) } },
  { id: 'wf-auto', kind: 'loan', name: 'Auto loan', institution: 'Wells Fargo', source: 'plaid', balance: 14876.3, apr: 6.49, updatedAt: at(0),
    payment: { amount: 412, due: shift(12) } },
  { id: 'earnest', kind: 'loan', name: 'Consolidated student loan', institution: 'Earnest', source: 'manual', balance: 22410, apr: 5.2, updatedAt: at(12, 18),
    payment: { amount: 286, due: shift(9) } },
  { id: 'mohela', kind: 'loan', name: 'Federal student loans', institution: 'MOHELA', source: 'manual', balance: 18250, apr: 4.99, updatedAt: at(2, 19),
    payment: { amount: 198, due: shift(22) } },
  { id: 'affirm', kind: 'loan', name: 'Laptop plan', institution: 'Affirm', source: 'manual', balance: 345, note: '4 payments left', updatedAt: at(2, 19),
    payment: { amount: 86.25, due: shift(16) } },
];

const bills = [
  { id: 'visible', name: 'Visible (phone)', amount: 25, due: shift(1) },
  { id: 'liberty', name: 'Liberty Mutual (car insurance)', amount: 138, due: shift(6) },
];

const net = accounts.reduce((s, a) => s + (a.kind === 'credit' || a.kind === 'loan' ? -a.balance : a.balance), 0);

export const MONEY_PAGE: PageDocument = {
  id: 'page-money',
  name: 'Money',
  description: 'Every account, card, loan and bill in one place: net worth, limits, and what is due next.',
  icon: 'chart',
  home: { kind: 'personal' },
  pinned: true,
  updatedAt: at(0),
  htmlStamp: 1791245000000,
  html: MONEY_HTML,
  data: {
    demoToday: TODAY,
    checkedAt: at(0),
    settings: { staleDays: 3, warnPct: 30, alertPct: 80 },
    accounts,
    bills,
    history: [...history(Math.round(net)), { d: TODAY, v: Math.round(net) }],
  },
};
