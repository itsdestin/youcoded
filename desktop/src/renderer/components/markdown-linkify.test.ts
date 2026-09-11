import { describe, it, expect } from 'vitest';
import { detectUrls, detectLinkTokens } from './markdown-linkify';

describe('detectUrls', () => {
  it('finds a bare URL', () => {
    expect(detectUrls('see https://example.com now').map((t) => t.value))
      .toEqual(['https://example.com']);
  });

  it('finds a localhost URL with a port and a trailing slash', () => {
    // The exact string from the bug report: this arrived inside backticks and
    // was not clickable.
    expect(detectUrls('http://127.0.0.1:8931/').map((t) => t.value))
      .toEqual(['http://127.0.0.1:8931/']);
  });

  it('leaves sentence punctuation out of the URL', () => {
    expect(detectUrls('open https://example.com/docs.').map((t) => t.value))
      .toEqual(['https://example.com/docs']);
    expect(detectUrls('open https://example.com/a, then b').map((t) => t.value))
      .toEqual(['https://example.com/a']);
  });

  it('drops a closing paren the URL did not open', () => {
    expect(detectUrls('(see https://example.com/x)').map((t) => t.value))
      .toEqual(['https://example.com/x']);
  });

  it('keeps a closing paren the URL did open', () => {
    expect(detectUrls('https://en.wikipedia.org/wiki/Foo_(bar)').map((t) => t.value))
      .toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
  });

  it('ignores a scheme with nothing after it', () => {
    expect(detectUrls('the http:// prefix')).toEqual([]);
  });

  it('does not match mid-word', () => {
    expect(detectUrls('nothttps://example.com')).toEqual([]);
  });

  it('finds several URLs on one line with correct offsets', () => {
    const text = 'a https://one.example b http://two.example c';
    const found = detectUrls(text);
    expect(found.map((t) => t.value)).toEqual(['https://one.example', 'http://two.example']);
    for (const t of found) expect(text.slice(t.start, t.end)).toBe(t.text);
  });
});

describe('detectLinkTokens', () => {
  it('returns no file paths when filepath detection is off', () => {
    expect(detectLinkTokens('open /home/destin/plan.md', { filepaths: false })).toEqual([]);
  });

  it('finds an absolute path when filepath detection is on', () => {
    const found = detectLinkTokens('open /home/destin/plan.md', { filepaths: true });
    expect(found.map((t) => [t.kind, t.value])).toEqual([['path', '/home/destin/plan.md']]);
  });

  it('finds a ~ path', () => {
    const found = detectLinkTokens('see ~/notes/todo.md', { filepaths: true });
    expect(found.map((t) => [t.kind, t.value])).toEqual([['path', '~/notes/todo.md']]);
  });

  it('does not turn a URL tail into a file path', () => {
    // The whole point of URL-wins-ties: /docs/plan.md here belongs to the URL.
    const found = detectLinkTokens('https://example.com/docs/plan.md', { filepaths: true });
    expect(found.map((t) => t.kind)).toEqual(['url']);
  });

  it('returns mixed tokens in source order', () => {
    const text = 'get https://example.com then read /home/d/a.md';
    const found = detectLinkTokens(text, { filepaths: true });
    expect(found.map((t) => t.kind)).toEqual(['url', 'path']);
    for (const t of found) expect(text.slice(t.start, t.end)).toBe(t.text);
  });

  // GUARDS THE FAST PATH. detectLinkTokens returns early for text holding
  // neither "/" nor "\", which is only sound while every token shape requires
  // one. If a future change makes a bare `file.txt` or `www.example.com`
  // linkable, this test goes red FIRST — and the early return has to go with
  // it, or that new shape would silently never be found in ordinary prose.
  it('no slash means no token — the fast path is sound', () => {
    const slashless = [
      'file.txt', 'a.b.c.d', 'README.md', 'const x = 1; // comment',
      'http:', 'https:', 'www.example.com', 'C:', 'plain words here',
      '~', '..', 'name.with.dots', 'v1.2.3', '',
    ];
    for (const s of slashless) {
      expect(detectLinkTokens(s, { filepaths: true }), s).toEqual([]);
      expect(detectLinkTokens(s, { filepaths: false }), s).toEqual([]);
    }
  });

  it('still finds tokens when the slash is the only hint', () => {
    // The other half of the same invariant: the early return must not swallow
    // anything that DOES carry a slash.
    expect(detectLinkTokens('src/a.ts', { filepaths: true }).map((t) => t.value)).toEqual(['src/a.ts']);
    expect(detectLinkTokens('http://localhost:3000/x', { filepaths: false }).map((t) => t.kind)).toEqual(['url']);
  });
});
