import { describe, it, expect } from 'vitest';
import {
  decideFirstPage,
  FIRST_PAGE_ATTEMPTS,
  FIRST_PAGE_UNRESOLVED_ATTEMPTS,
} from '../src/renderer/state/first-page-retry';
import type { TranscriptPageResult } from '../src/shared/types';

const page = (p: Partial<TranscriptPageResult>): TranscriptPageResult =>
  ({ events: [], cursor: null, hasMore: false, ...p });

const realPage = page({ events: [{} as any], cursor: { path: 'p', offset: 9, sizeAtRead: 90 }, hasMore: true });
const beginning = page({ events: [{} as any] });
const ambiguousEmpty = page({});
const unresolved = page({ unresolved: true });

describe('first-page retry decision', () => {
  it('accepts a real page immediately', () => {
    expect(decideFirstPage(realPage, 0)).toBe('accept');
  });

  it('accepts a short conversation that starts at its first message', () => {
    expect(decideFirstPage(beginning, 0)).toBe('accept');
  });

  it('retries an ambiguous empty page, then accepts it as a genuinely empty session', () => {
    expect(decideFirstPage(ambiguousEmpty, 0)).toBe('retry');
    expect(decideFirstPage(ambiguousEmpty, FIRST_PAGE_ATTEMPTS - 1)).toBe('accept');
  });

  it('retries an unresolved page for longer than an ambiguous one — main SAID it has not found the file', () => {
    expect(FIRST_PAGE_UNRESOLVED_ATTEMPTS).toBeGreaterThan(FIRST_PAGE_ATTEMPTS);
    expect(decideFirstPage(unresolved, FIRST_PAGE_ATTEMPTS - 1)).toBe('retry');
  });

  it('gives up on an unresolved page WITHOUT recording it as the end of the history', () => {
    // 'accept' would write hasMore:false + a null cursor into the reducer, which
    // is the state that removes the scroll-up sentinel for good.
    expect(decideFirstPage(unresolved, FIRST_PAGE_UNRESOLVED_ATTEMPTS - 1)).toBe('give-up');
  });

  it('is bounded — a transcript that never resolves stops being asked for', () => {
    expect(decideFirstPage(unresolved, 999)).toBe('give-up');
  });
});
