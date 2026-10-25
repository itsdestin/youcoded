// When a page's link opens at once, asks "Open this website?" first, or is refused
// (shared/page-open-rule.ts; pages-finish deck 1 Q-popups, design review 1 finding 4).
import { describe, expect, it } from 'vitest';
import { decidePageOpen } from '../src/shared/page-open-rule';
import type { PageConnectionStatus } from '../src/shared/pages-types';

const feed: PageConnectionStatus = { id: 'f', kind: 'public', address: 'hnrss.org', approved: true };
const waiting: PageConnectionStatus = { id: 'w', kind: 'public', address: 'waiting.example', approved: false };
const open: PageConnectionStatus = { id: 'o', kind: 'open', approved: true };
const device: PageConnectionStatus = { id: 'd', kind: 'device', service: 'HA', address: '192.168.1.5:8123', access: 'full', needsKey: true, approved: true };

describe('opening a website for a page', () => {
  const cases: Array<[string, unknown, PageConnectionStatus[], string[], string]> = [
    ['a site the page already reaches', 'https://hnrss.org/newest', [feed], [], 'open'],
    ['a remembered site', 'https://News.Example.com./a?b=1', [], ['news.example.com'], 'open'],
    ['a site nobody chose', 'https://elsewhere.example/', [feed], [], 'ask'],
    ['a site whose line is still waiting', 'https://waiting.example/', [waiting], [], 'ask'],
    ['any site on a whole-internet page', 'https://anything.example/', [open], [], 'ask'],
    ['a home device address', 'http://192.168.1.5:8123/', [device], [], 'ask'],
    ['an email address', 'mailto:someone@example.com?body=hi', [feed], ['example.com'], 'ask'],
    ['a javascript address', 'javascript:alert(1)', [feed], [], 'refuse'],
    ['a file address', 'file:///etc/passwd', [], [], 'refuse'],
    ['an address hiding a user name', 'https://hnrss.org@evil.example/', [feed], [], 'refuse'],
    ['something that is not an address', 42, [], [], 'refuse'],
    ['an address that is far too long', `https://hnrss.org/${'a'.repeat(2100)}`, [feed], [], 'refuse'],
  ];
  for (const [name, url, connections, sites, action] of cases) {
    it(`${action}s ${name}`, () => {
      expect(decidePageOpen(url, connections, sites).action).toBe(action);
    });
  }

  it('offers no site to remember for an email', () => {
    expect(decidePageOpen('mailto:a@example.com', [], [])).toMatchObject({ action: 'ask', site: null });
  });
});
