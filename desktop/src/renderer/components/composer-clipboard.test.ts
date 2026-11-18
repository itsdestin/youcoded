// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { isImageOnlyClipboard } from './composer-clipboard';

// A clipboard as the browser hands it to a paste event: the listed items plus getData by type.
const clip = (types: string[], data: Record<string, string> = {}) =>
  ({ items: types.map((type) => ({ type })), getData: (t: string) => data[t] ?? '' }) as unknown as DataTransfer;

describe('composer paste: picture or words', () => {
  const src = 'https://example.com/cat.png';

  it('a browser "Copy image" (picture plus an <img> snippet) is a picture', () => {
    expect(isImageOnlyClipboard(clip(['text/html', 'image/png'], { 'text/html': `<meta charset="utf-8"><img src="${src}" alt="cat">` }))).toBe(true);
  });

  it('a picture whose only text is its own address is a picture', () => {
    expect(isImageOnlyClipboard(clip(['text/plain', 'text/html', 'image/png'], { 'text/plain': src, 'text/html': `<img src="${src}">` }))).toBe(true);
  });

  it('a screenshot (picture alone) is a picture', () => {
    expect(isImageOnlyClipboard(clip(['image/png']))).toBe(true);
  });

  it('words copied with a picture (a page or spreadsheet copy) are words', () => {
    expect(isImageOnlyClipboard(clip(['text/plain', 'text/html', 'image/png'], { 'text/plain': 'Q3 total 42', 'text/html': '<table><tr><td>Q3 total</td><td>42</td></tr></table>' }))).toBe(false);
    expect(isImageOnlyClipboard(clip(['text/plain', 'image/png'], { 'text/plain': 'just words' }))).toBe(false);
  });

  it('plain words with no picture are words', () => {
    expect(isImageOnlyClipboard(clip(['text/plain'], { 'text/plain': 'hello' }))).toBe(false);
  });
});
