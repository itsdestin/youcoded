// desktop/tests/dev-url-prefill.test.ts
import { describe, it, expect } from 'vitest';
import { buildPrefillUrl } from '../src/main/dev-tools';

describe('buildPrefillUrl', () => {
  it('builds a URL with title, body, and label', () => {
    const url = buildPrefillUrl({
      title: 'My title',
      body: 'My body',
      label: 'bug',
    });
    expect(url.startsWith('https://github.com/itsdestin/youcoded/issues/new?')).toBe(true);
    expect(url).toContain('title=My+title'); // encodeURIComponent uses %20, but URLSearchParams uses +
    expect(url).toMatch(/body=My(\+|%20)body/);
    expect(url).toContain('labels=bug');
  });

  it('encodes special chars in the body', () => {
    const url = buildPrefillUrl({
      title: 'Crash & burn',
      body: 'Line 1\nLine 2 "quoted" & ampersand',
      label: 'enhancement',
    });
    expect(url).toContain('labels=enhancement');
    // Decode and verify round-trip.
    const params = new URL(url).searchParams;
    expect(params.get('title')).toBe('Crash & burn');
    expect(params.get('body')).toBe('Line 1\nLine 2 "quoted" & ampersand');
  });

  it('stays under the 8KB URL cap by hard-capping the description', () => {
    const huge = 'x'.repeat(20_000);
    const url = buildPrefillUrl({ title: 'T', body: huge, label: 'bug' });
    expect(url.length).toBeLessThan(8000);
    // The body should have been truncated with a marker.
    expect(decodeURIComponent(new URL(url).searchParams.get('body') || '')).toContain('[truncated]');
  });

  it('respects the URL cap even when the title is huge', () => {
    const hugeTitle = 'x'.repeat(10_000);
    const url = buildPrefillUrl({ title: hugeTitle, body: 'short body', label: 'bug' });
    expect(url.length).toBeLessThan(8000);
    expect(decodeURIComponent(new URL(url).searchParams.get('title') || '')).toMatch(/^x{200}…$/);
  });
});
