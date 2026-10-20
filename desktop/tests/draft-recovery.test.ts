// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRecoveryDraft, flushRecoveryDrafts, readRecoveryDraft, writeRecoveryDraft } from '../src/renderer/state/draft-recovery';

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
