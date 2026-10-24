// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRecoveryDraft, flushRecoveryDrafts, readRecoveryDraft, storedAt, writeRecoveryDraft } from '../src/renderer/state/draft-recovery';

beforeEach(() => { sessionStorage.clear(); vi.useFakeTimers(); });
afterEach(() => { flushRecoveryDrafts(); sessionStorage.clear(); vi.useRealTimers(); });

describe('draft recovery', () => {
  it('keeps text, attachment paths and original file token through a page reload', () => {
    const draft = { text: 'not sent', attachments: ['/project/a.png'], mtimeMs: 42 };
    writeRecoveryDraft('composer:s1', draft);
    flushRecoveryDrafts();
    expect(readRecoveryDraft('composer:s1')).toEqual(draft);
    expect(sessionStorage.length).toBeGreaterThan(0);
  });

  it('preserves an empty file edit rather than treating it as an empty composer', () => {
    writeRecoveryDraft('file:cleared-text', { text: '', mtimeMs: 42 });
    flushRecoveryDrafts();
    expect(readRecoveryDraft('file:cleared-text')).toEqual({ text: '', mtimeMs: 42 });
  });

  it('clearing a submitted draft cancels its pending write', async () => {
    writeRecoveryDraft('composer:s1', { text: 'already sent' });
    clearRecoveryDraft('composer:s1');
    await vi.advanceTimersByTimeAsync(500);
    expect(readRecoveryDraft('composer:s1')).toBeNull();
  });

  it('expires abandoned drafts without changing other browser state', () => {
    sessionStorage.setItem('unrelated', 'keep');
    writeRecoveryDraft('file:one', { text: 'old edit', mtimeMs: 42 });
    flushRecoveryDrafts();
    vi.advanceTimersByTime(8 * 24 * 60 * 60 * 1000);
    expect(readRecoveryDraft('file:one')).toBeNull();
    expect(sessionStorage.getItem('unrelated')).toBe('keep');
  });
});

describe('flush does not re-parse the other stored drafts', () => {
  it('reads each other draft\'s age without JSON.parse of its text, and evicts the same way', () => {
    // Three big stored drafts from "other" sessions.
    for (const k of ['a', 'b', 'c']) {
      writeRecoveryDraft(`composer:${k}`, { text: k.repeat(200_000) });
      flushRecoveryDrafts();
      vi.advanceTimersByTime(1000);
    }
    const parse = vi.spyOn(JSON, 'parse');
    writeRecoveryDraft('composer:new', { text: 'typing' });
    flushRecoveryDrafts();
    // No parse may be handed a megabyte-class string (the old flush parsed all three).
    const big = parse.mock.calls.filter(([s]) => typeof s === 'string' && s.length > 100_000);
    parse.mockRestore();
    expect(big).toHaveLength(0);
    expect(readRecoveryDraft('composer:a')?.text.length).toBe(200_000);
  });

  it('storedAt agrees with JSON.parse on our records and falls back on anything else', () => {
    const ours = JSON.stringify({ v: 1, at: 1234567890123, draft: { text: 'x', attachments: [] } });
    expect(storedAt(ours)).toBe(JSON.parse(ours).at);
    expect(storedAt('{"at":5,"v":1}')).toBe(5); // other key order: full parse
    expect(storedAt('{"v":1}')).toBe(0);        // no stamp
    expect(storedAt('{"v":1,"at":99,"draft":')).toBe(0); // truncated: malformed sorts first
    expect(storedAt('not json')).toBe(0);
    expect(storedAt('')).toBe(0);
  });
});
