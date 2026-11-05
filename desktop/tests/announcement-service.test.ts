import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __test } from '../src/main/announcement-service';

const { parseAnnouncement } = __test;

describe('parseAnnouncement', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 20, 12, 0, 0)); // 2026-04-20 local
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for empty input', () => {
    expect(parseAnnouncement('')).toBeNull();
  });

  it('returns null for comment-only input', () => {
    expect(parseAnnouncement('# comment one\n# comment two')).toBeNull();
  });

  it('returns null for whitespace-only input', () => {
    expect(parseAnnouncement('\n   \n\t\n')).toBeNull();
  });

  it('parses a plain line with no prefix', () => {
    expect(parseAnnouncement('Hello world')).toEqual({ message: 'Hello world' });
  });

  it('parses a dated line with future expiry', () => {
    expect(parseAnnouncement('2026-06-15: New skill drop')).toEqual({
      message: 'New skill drop',
      expires: '2026-06-15',
    });
  });

  it('parses a dated line with today as expiry (same-day visible)', () => {
    expect(parseAnnouncement('2026-04-20: Happens today')).toEqual({
      message: 'Happens today',
      expires: '2026-04-20',
    });
  });

  it('drops a dated line with past expiry (fetch-time filter)', () => {
    expect(parseAnnouncement('2026-04-19: Already expired')).toBeNull();
  });

  it('skips comments and blank lines before matching the first real line', () => {
    const input = [
      '# this is a comment',
      '',
      '   ',
      '2026-12-01: Actual announcement',
    ].join('\n');
    expect(parseAnnouncement(input)).toEqual({
      message: 'Actual announcement',
      expires: '2026-12-01',
    });
  });

  it('uses only the first valid line', () => {
    const input = [
      '2026-06-01: First',
      '2026-07-01: Second (ignored)',
    ].join('\n');
    expect(parseAnnouncement(input)).toEqual({
      message: 'First',
      expires: '2026-06-01',
    });
  });
});

// Security audit SC-8: remote announcement text must never carry terminal escapes.
import { sanitizeAnnouncementText, MAX_ANNOUNCEMENT_LENGTH } from '../src/shared/announcement';

describe('announcement text is safe to print to a terminal', () => {
  it('strips ANSI colour, OSC title/link/clipboard sequences and other control characters', () => {
    const evil = 'Update \u001b[31mnow\u001b[0m \u001b]0;fake title\u0007\u001b]52;c;Zm9v\u0007\u001b]8;;http://e\u001b\\click\u001b]8;;\u001b\\ \u009b31m end\u0000\u0008';
    const out = sanitizeAnnouncementText(evil);
    expect(out).toBe('Update now click end');
    expect(/[\u0000-\u001f\u007f-\u009f]/.test(out)).toBe(false);
  });
  it('keeps ordinary text, emoji and non-English words', () => {
    expect(sanitizeAnnouncementText('Nueva versión 🎉 está lista!')).toBe('Nueva versión 🎉 está lista!');
  });
  it('removes text-direction overrides and caps the length', () => {
    expect(sanitizeAnnouncementText('a‮b')).toBe('a b');
    expect(sanitizeAnnouncementText('x'.repeat(5000)).length).toBe(MAX_ANNOUNCEMENT_LENGTH);
  });
  it('parseAnnouncement sanitizes both dated and undated lines, and drops lines that are only escapes', () => {
    expect(__test.parseAnnouncement('\u001b]0;t\u0007Hello')).toEqual({ message: 'Hello' });
    expect(__test.parseAnnouncement('\u001b[31m\u001b[0m')).toBeNull();
  });
});
