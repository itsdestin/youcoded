// The sentences a person approves are the permission model's whole surface,
// so the wording rules decided on the Phase 2 questions decks are pinned here.
import { describe, expect, it } from 'vitest';
import { describeConnection, needsApproval, splitAddress } from '../src/renderer/components/pages/page-connections';
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
