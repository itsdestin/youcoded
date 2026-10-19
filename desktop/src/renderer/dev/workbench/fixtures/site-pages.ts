// Public demo copies of the installed pages, not alternate page implementations.
import type { PageDocument, PageFetchResult } from '../../../../shared/pages-types';
import { seedPages } from './pages';

const DISPLAY_NAMES: Record<string, string> = {
  'Capital One': 'Demo Community Bank', 'American Express': 'Demo Credit Union',
  Robinhood: 'Demo Investments', Synchrony: 'Demo Retail Bank', 'Wells Fargo': 'Demo Auto Finance',
  Earnest: 'Demo Education Finance', MOHELA: 'Demo Student Loans', Affirm: 'Demo Payment Plan',
  '360 Checking': 'Everyday checking', 'Rewards Checking': 'Household checking',
  Quicksilver: 'Everyday card', 'Blue Cash Everyday': 'Household card', 'Robinhood Gold Card': 'Rewards card',
  Visible: 'Demo Mobile', 'Liberty Mutual': 'Demo Insurance', 'SRP Electric': 'Demo Electric',
};
function financeCopy(value: unknown): unknown {
  if (typeof value === 'string') {
    for (const [from, to] of Object.entries(DISPLAY_NAMES)) value = (value as string).split(from).join(to);
    return value;
  }
  if (Array.isArray(value)) return value.map(financeCopy);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, financeCopy(v)]));
  return value;
}

export function seedSitePages(): PageDocument[] {
  // WHY: never mutate MONEY_PAGE or the house's shared seed; screenshot and internal
  // review scenarios must retain their original labels and approval states.
  const pages = structuredClone(seedPages());
  const home = pages.find((p) => p.id === 'page-home')!;
  const money = pages.find((p) => p.id === 'page-money')!;
  return [
    { ...home, pinned: true, description: 'A fictional household with simulated lights, media and climate controls.',
      connections: home.connections?.map((c) => c.kind === 'device' ? { ...c, address: 'home.demo.invalid:8123', keyPage: 'http://home.demo.invalid:8123/profile', approved: true, savedKey: true, videoProfile: undefined } : c) },
    { ...money, name: 'Finance', description: 'Fictional demo accounts and synthetic transactions. Changes reset when you reload.', data: { ...(financeCopy(money.data) as Record<string, unknown>), demoTitle: 'Finance' } },
  ];
}

/** Transform only response copies, including JSON nested inside socket envelopes. */
export function siteHomeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    try { if (/^[\[{]/.test(value)) return JSON.stringify(siteHomeValue(JSON.parse(value))); } catch { /* plain display text */ }
    return value.replace(/Destin's Room/g, 'Study').replace(/Destin's Bathroom/g, 'Bathroom')
      .replace(/Destin's Samsung TV/g, 'Study TV').replace(/Grandma's Room/g, 'Guest Bedroom')
      .replace(/Destin's /g, 'Study ').replace(/Grandma's /g, 'Guest ').replace(/Destin/g, 'Demo resident');
  }
  // WHY: the public demo has no cameras at all, even simulated recordings. Filter
  // both template arrays and the keyed entity dictionaries used by live updates.
  if (Array.isArray(value)) return value.filter((v) => !(v && typeof v === 'object' && /^camera\./.test(String(v.id ?? v.entity_id ?? '')))).map(siteHomeValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('camera.')).map(([key, v]) => [key, siteHomeValue(v)]));
  return value;
}
export function siteHomeAnswer(answer: PageFetchResult): PageFetchResult {
  return siteHomeValue(answer) as PageFetchResult;
}
