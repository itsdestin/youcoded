import { describe, it, expect } from 'vitest';
import { pathToFileURL } from 'url';
import { isAppPageUrl } from '../src/main/app-navigation';

const INDEX = '/opt/YouCoded/resources/app.asar/dist/renderer/index.html';
const DEV = 'http://localhost:5223';
const own = pathToFileURL(INDEX).href;

describe('isAppPageUrl — where a window may navigate (2026-09-10)', () => {
  it("allows the app's own page, with a query or a hash", () => {
    expect(isAppPageUrl(own, INDEX, DEV)).toBe(true);
    expect(isAppPageUrl(`${own}?mode=buddy`, INDEX, DEV)).toBe(true);
    expect(isAppPageUrl(`${own}#section`, INDEX, DEV)).toBe(true);
  });

  it('allows the dev server', () => {
    expect(isAppPageUrl(DEV, INDEX, DEV)).toBe(true);
    expect(isAppPageUrl(`${DEV}/`, INDEX, DEV)).toBe(true);
    expect(isAppPageUrl(`${DEV}/?mode=buddy`, INDEX, DEV)).toBe(true);
  });

  it('handles an install path with spaces in it', () => {
    const spaced = '/home/a user/YouCoded/dist/renderer/index.html';
    expect(isAppPageUrl(pathToFileURL(spaced).href, spaced, DEV)).toBe(true);
  });

  it.each([
    'file:///etc/passwd',
    'file:///opt/YouCoded/resources/app.asar/dist/renderer/other.html',
    'file:///tmp/evil/index.html',
    'https://example.com/',
    'http://localhost:52231/',
    'javascript:alert(1)',
    'not a url',
  ])('refuses %s', (url) => {
    expect(isAppPageUrl(url, INDEX, DEV)).toBe(false);
  });
});
