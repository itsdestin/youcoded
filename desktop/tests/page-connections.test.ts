// The sentences a person approves are the permission model's whole surface,
// so the wording rules decided on the Phase 2 questions decks are pinned here.
import { describe, expect, it } from 'vitest';
import { combinedRisk, describeConnection, needsApproval, splitAddress } from '../src/renderer/components/pages/page-connections';
import type { PageConnection, PageSummary } from '../src/shared/pages-types';

const ALL: PageConnection[] = [
  { id: 'a', kind: 'youcoded' },
  { id: 'b', kind: 'key', service: 'OpenWeather', address: 'api.openweathermap.org', access: 'lookup' },
  { id: 'c', kind: 'key', service: 'Todoist', address: 'api.todoist.com', access: 'full' },
  { id: 'd', kind: 'public', address: 'hnrss.org' },
  { id: 'e', kind: 'github', access: 'lookup' },
  { id: 'f', kind: 'github', access: 'full' },
  { id: 'g', kind: 'open' },
];
const sentence = (c: PageConnection) => { const w = describeConnection(c); return `${w.what} ${w.limit}`; };

describe('page connection wording', () => {
  it('never promises read-only, safe or revoked for any connection', () => {
    for (const c of ALL) expect(sentence(c)).not.toMatch(/read-only|\bsafe\b|revoke/i);
  });

  it('says a look-up connection cannot send changes, and a full one does not', () => {
    for (const c of ALL) {
      const lookup = c.kind === 'youcoded' || ((c.kind === 'key' || c.kind === 'github') && c.access === 'lookup');
      if (lookup) expect(sentence(c)).toContain('Cannot change anything there. The page decides what it sends to this address.');
      else expect(sentence(c)).not.toContain('Cannot change anything there.');
    }
  });

  it('names the exact address a key is used with', () => {
    expect(sentence(ALL[1])).toContain('api.openweathermap.org');
    expect(sentence(ALL[2])).toContain('api.todoist.com');
  });

  it('is blunt about the whole internet', () => {
    expect(sentence(ALL[6])).toBe('Reach any website. Anything shown in this page, or typed into it, could be sent anywhere.');
  });
});

describe('reading an address', () => {
  it('names the site that actually receives the request, not the one it reads like', () => {
    // The whole reason this exists: a legal hostname can wear another company's
    // name (design review 1, finding 6).
    expect(splitAddress('api.openweathermap.org.evil.example')).toEqual({ prefix: 'api.openweathermap.org.', site: 'evil.example' });
    expect(splitAddress('api.openweathermap.org')).toEqual({ prefix: 'api.', site: 'openweathermap.org' });
  });

  it('emphasises the whole address when there is nothing in front of it', () => {
    expect(splitAddress('hnrss.org')).toEqual({ prefix: '', site: 'hnrss.org' });
    expect(splitAddress('bbc.co.uk')).toEqual({ prefix: '', site: 'bbc.co.uk' });
  });

  it('counts a registry ending as part of the site', () => {
    expect(splitAddress('api.bbc.co.uk')).toEqual({ prefix: 'api.', site: 'bbc.co.uk' });
    expect(splitAddress('a.b.example.com.au')).toEqual({ prefix: 'a.b.', site: 'example.com.au' });
  });
});

describe('a YouCoded connection that may change things', () => {
  it('names each place and says the rest of the account is out of reach', () => {
    const w = describeConnection({ id: 'y', kind: 'youcoded', writePaths: ['/admin/analytics/website-campaigns'] });
    expect(`${w.what} ${w.limit}`).toBe("Look things up on YouCoded's own service using your YouCoded sign-in, and make changes at /admin/analytics/website-campaigns. Nothing else on your account can be changed.");
  });
});

describe('needsApproval', () => {
  const page = (connections?: PageSummary['connections']) => ({ connections }) as PageSummary;
  it('is false for a page that reaches nothing', () => {
    expect(needsApproval(page())).toBe(false);
    expect(needsApproval(page([]))).toBe(false);
    expect(needsApproval(null)).toBe(false);
  });
  it('is true while any one line is waiting', () => {
    expect(needsApproval(page([{ id: 'a', kind: 'youcoded', approved: true }, { id: 'd', kind: 'public', address: 'hnrss.org', approved: false }]))).toBe(true);
    expect(needsApproval(page([{ id: 'a', kind: 'youcoded', approved: true }]))).toBe(false);
  });
});

// The one "Together, this page could send…" line (pages-finish deck 1, Q-combined).
// It appears for ANY pair of reads-something-private + can-send-elsewhere, and never
// for a service reading and sending to itself.

const calendar: PageConnection = { id: 'icloud', kind: 'key', service: 'iCloud Calendar', address: 'caldav.icloud.com', access: 'full' };
const weather: PageConnection = { id: 'w', kind: 'public', address: 'api.open-meteo.com' };
const todoist: PageConnection = { id: 't', kind: 'key', service: 'Todoist', address: 'api.todoist.com', access: 'full' };
const chats: PageConnection = { id: 'c', kind: 'chats', access: 'lookup', scope: { all: true } };
const program: PageConnection = { id: 'p', kind: 'program', file: 'work-items.mjs' };
const session: PageConnection = { id: 's', kind: 'session' };

describe('combinedRisk', () => {
  it('names what a keyed service reads and the other site it could reach', () => {
    expect(combinedRisk([calendar, weather])).toBe('Together, this page could send what it reads from iCloud Calendar to open-meteo.com.');
  });

  it('counts a program as a way out to anywhere', () => {
    expect(combinedRisk([chats, program, session])).toBe('Together, this page could send your chat list anywhere, using work-items.mjs.');
  });

  it('is silent for a service that reads and sends only to itself', () => {
    expect(combinedRisk([todoist])).toBeNull();
  });

  it('is silent when nothing private is read, and when there is no way out', () => {
    expect(combinedRisk([weather])).toBeNull();
    // Starting a conversation is not a way out: the person sees and sends it.
    expect(combinedRisk([chats, session])).toBeNull();
  });
});

describe('the combined line and remembered websites', () => {
  it('counts a site the page opens without asking as a way out', () => {
    expect(combinedRisk([todoist], ['news.example.com'])).toBe('Together, this page could send what it reads from Todoist to news.example.com (opened in your browser).');
    expect(combinedRisk([todoist], [])).toBeNull();
  });
});
