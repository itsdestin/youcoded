import path from 'node:path';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createThemeFonts, currentThemeFontLinks, isAllowedFontUrl, rewriteFontCss } from '../../src/main/office/theme-fonts';
import { createSessions } from '../../src/main/office/office-sessions';
import { officeRequestHandler } from '../../src/main/office/office-protocol';
import { editorFontLinks } from '../../src/renderer/components/office/office-theme';

// Pins the theme-font route (design §3): the editor stays offline behind its CSP, and main —
// which has network — fetches the theme's web font from Google's two font hosts only, then
// serves it from the document's own office://<token> origin.

const CSS_URL = 'https://fonts.googleapis.com/css2?family=Nunito:wght@400;600&display=swap';
const FILE_URL = 'https://fonts.gstatic.com/s/nunito/v26/XRXV3I6Li01BKofINeaB.woff2';
const GOOGLE_CSS = `/* latin */
@font-face {
  font-family: 'Nunito';
  src: url(${FILE_URL}) format('woff2');
}
@font-face {
  font-family: 'Nunito';
  src: url("https://fonts.gstatic.com/s/nunito/v26/other.woff2") format('woff2');
}`;

/** The current theme links exactly CSS_URL. */
const themeFontLinks = async () => [CSS_URL];

describe('isAllowedFontUrl', () => {
  it('accepts Google\'s stylesheet endpoint and its font-file host', () => {
    expect(isAllowedFontUrl(CSS_URL)).toBe(true);
    expect(isAllowedFontUrl(FILE_URL)).toBe(true);
  });

  it('refuses plain http, other hosts and other Google paths', () => {
    expect(isAllowedFontUrl(CSS_URL.replace('https:', 'http:'))).toBe(false);
    expect(isAllowedFontUrl('https://example.com/css2?family=Nunito')).toBe(false);
    expect(isAllowedFontUrl('https://fonts.googleapis.com/css?family=Nunito')).toBe(false);
    expect(isAllowedFontUrl('https://evil.fonts.gstatic.com/s/x.woff2')).toBe(false);
    expect(isAllowedFontUrl('not a url')).toBe(false);
  });

  it('refuses a look-alike host that only starts with a Google font host', () => {
    expect(isAllowedFontUrl('https://fonts.googleapis.com.evil.com/css2?family=Nunito')).toBe(false);
    expect(isAllowedFontUrl('https://fonts.gstatic.com.evil.com/s/x.woff2')).toBe(false);
  });

  it('refuses a userinfo trick that names Google before the real host', () => {
    expect(isAllowedFontUrl('https://fonts.googleapis.com@evil.com/css2?family=Nunito')).toBe(false);
    expect(isAllowedFontUrl('https://user:pw@fonts.googleapis.com/css2?family=Nunito')).toBe(false);
  });

  it('refuses a non-default port', () => {
    expect(isAllowedFontUrl('https://fonts.gstatic.com:8443/s/x.woff2')).toBe(false);
  });
});

describe('rewriteFontCss', () => {
  it('points every font-file url at the office font route on the same origin', () => {
    const out = rewriteFontCss(GOOGLE_CSS);
    expect(out).toContain(`url("/yc-fonts/file?u=${encodeURIComponent(FILE_URL)}")`);
    expect(out).toContain(`url("/yc-fonts/file?u=${encodeURIComponent('https://fonts.gstatic.com/s/nunito/v26/other.woff2')}")`);
    expect(out).not.toMatch(/url\(\s*["']?https:/);
  });

  it('blanks a url to any other host instead of passing it through', () => {
    const out = rewriteFontCss("@font-face{src:url(https://evil.com/x.woff2)} @import url('https://evil.com/a.css');");
    expect(out).not.toContain('evil.com');
  });
});

describe('createThemeFonts', () => {
  let cacheDir: string;
  beforeEach(async () => { cacheDir = await mkdtemp(path.join(tmpdir(), 'office-font-cache-')); });
  afterEach(async () => { await rm(cacheDir, { recursive: true, force: true, maxRetries: 3 }); });

  const okFetch = () => vi.fn(async (url: string) => {
    if (url.startsWith('https://fonts.googleapis.com/')) return new Response(GOOGLE_CSS, { headers: { 'content-type': 'text/css' } });
    return new Response(new Uint8Array([7, 7, 7]), { headers: { 'content-type': 'font/woff2' } });
  });

  it('fetches a stylesheet once, then serves it from the cache without the network', async () => {
    const fetch = okFetch();
    const fonts = createThemeFonts({ cacheDir, fetch, themeFontLinks });
    const first = await fonts.fetchFontCss(CSS_URL);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(first).toContain('/yc-fonts/file?u=');

    const offline = vi.fn(async () => { throw new Error('offline'); });
    const again = createThemeFonts({ cacheDir, fetch: offline, themeFontLinks });
    expect(await again.fetchFontCss(CSS_URL)).toBe(first);
    expect(offline).not.toHaveBeenCalled();
  });

  it('serves a cached font file without a network call', async () => {
    const online = createThemeFonts({ cacheDir, fetch: okFetch(), themeFontLinks });
    await online.fetchFontCss(CSS_URL);
    await online.fetchFontFile(FILE_URL);
    const offline = vi.fn(async () => { throw new Error('offline'); });
    const fonts = createThemeFonts({ cacheDir, fetch: offline, themeFontLinks });
    await fonts.fetchFontCss(CSS_URL); // the editor always reads the stylesheet first
    const file = await fonts.fetchFontFile(FILE_URL);
    expect(offline).not.toHaveBeenCalled();
    expect(file && Array.from(file.data)).toEqual([7, 7, 7]);
    expect(file?.type).toBe('font/woff2');
  });

  it('refuses a valid Google stylesheet that the current theme does not link', async () => {
    const fetch = okFetch();
    const fonts = createThemeFonts({ cacheDir, fetch, themeFontLinks });
    expect(await fonts.fetchFontCss('https://fonts.googleapis.com/css2?family=Secret+Document+Text')).toBeNull();
    expect(await fonts.fetchFontCss('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600&display=swap&x=1')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a font file the theme stylesheet never pointed at', async () => {
    const fetch = okFetch();
    const fonts = createThemeFonts({ cacheDir, fetch, themeFontLinks });
    expect(await fonts.fetchFontFile(FILE_URL)).toBeNull(); // before any stylesheet
    await fonts.fetchFontCss(CSS_URL);
    expect(await fonts.fetchFontFile('https://fonts.gstatic.com/s/anything/else.woff2')).toBeNull();
    expect(await fonts.fetchFontFile(FILE_URL)).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2); // the stylesheet and the one referenced file
  });

  it('never fetches a url outside the two Google font hosts', async () => {
    const fetch = okFetch();
    const fonts = createThemeFonts({ cacheDir, fetch, themeFontLinks });
    expect(await fonts.fetchFontCss('https://fonts.googleapis.com.evil.com/css2?family=X')).toBeNull();
    expect(await fonts.fetchFontFile('https://evil.com/x.woff2')).toBeNull();
    expect(await fonts.fetchFontCss(FILE_URL)).toBeNull(); // a font file is not a stylesheet
    expect(await fonts.fetchFontFile(CSS_URL)).toBeNull(); // nor the other way round
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses to follow a redirect, so the host check cannot be bypassed', async () => {
    const fetch = okFetch();
    await createThemeFonts({ cacheDir, fetch, themeFontLinks }).fetchFontCss(CSS_URL);
    expect((fetch.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: 'error' });
  });

  it('caches nothing when Google answers with an error', async () => {
    const fetch = vi.fn(async () => new Response('nope', { status: 500 }));
    const fonts = createThemeFonts({ cacheDir, fetch, themeFontLinks });
    expect(await fonts.fetchFontCss(CSS_URL)).toBeNull();
    expect(await readdir(cacheDir)).toEqual([]);
  });

  it('stops reading a body past the size cap even without a content-length', async () => {
    let pulled = 0;
    let signal: AbortSignal | undefined;
    // 40 MB in 1 MB chunks: bounded, so a reader that ignores the cap still ends (and fails).
    const endless = () => new ReadableStream<Uint8Array>({
      pull(c) { pulled++; if (pulled > 40) c.close(); else c.enqueue(new Uint8Array(1024 * 1024)); },
    });
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('googleapis')) return new Response(GOOGLE_CSS);
      signal = init?.signal ?? undefined;
      return new Response(endless()); // no content-length header
    });
    const fonts = createThemeFonts({ cacheDir, fetch, themeFontLinks });
    await fonts.fetchFontCss(CSS_URL);
    // WHY not toBeNull(): on failure vitest would print a 40 MB array.
    expect((await fonts.fetchFontFile(FILE_URL)) === null).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(pulled).toBeLessThanOrEqual(13); // 10 MB cap in 1 MB chunks, plus the stream's read-ahead
  });
});

describe('currentThemeFontLinks', () => {
  let claude: string;
  beforeEach(async () => { claude = await mkdtemp(path.join(tmpdir(), 'office-theme-links-')); });
  afterEach(async () => { await rm(claude, { recursive: true, force: true, maxRetries: 3 }); });

  const theme = async (slug: string, font: unknown) => {
    await mkdir(path.join(claude, 'wecoded-themes', slug), { recursive: true });
    await writeFile(path.join(claude, 'wecoded-themes', slug, 'manifest.json'), JSON.stringify({ font }));
  };

  it('names the applied theme\'s web font and the live preview theme\'s', async () => {
    await writeFile(path.join(claude, 'youcoded-appearance.json'), JSON.stringify({ theme: 'meadow-mist' }));
    await theme('meadow-mist', { 'google-font-url': CSS_URL });
    await theme('other', { 'google-font-url': 'https://fonts.googleapis.com/css2?family=Other' });
    await theme('_preview', { 'google-font-url': 'https://fonts.googleapis.com/css2?family=Preview' });
    expect(await currentThemeFontLinks(claude)).toEqual([CSS_URL, 'https://fonts.googleapis.com/css2?family=Preview']);
  });

  it('names nothing for a built-in theme, a bad slug, or a non-Google font url', async () => {
    await writeFile(path.join(claude, 'youcoded-appearance.json'), JSON.stringify({ theme: 'midnight' }));
    expect(await currentThemeFontLinks(claude)).toEqual([]);
    await writeFile(path.join(claude, 'youcoded-appearance.json'), JSON.stringify({ theme: '../escape' }));
    expect(await currentThemeFontLinks(claude)).toEqual([]);
    await writeFile(path.join(claude, 'youcoded-appearance.json'), JSON.stringify({ theme: 'evil' }));
    await theme('evil', { 'google-font-url': 'https://evil.com/css2?family=X' });
    expect(await currentThemeFontLinks(claude)).toEqual([]);
  });
});

describe('office://<token>/yc-fonts route', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'office-fonts-route-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3 }); });

  it('serves the rewritten stylesheet and the font file from the document\'s own origin', async () => {
    const sessions = createSessions(path.join(root, 'sessions-tmp'));
    const fetch = vi.fn(async (url: string) => url.includes('googleapis')
      ? new Response(GOOGLE_CSS)
      : new Response(new Uint8Array([1, 2])));
    const handler = officeRequestHandler({ root, sessions, fonts: createThemeFonts({ cacheDir: path.join(root, 'cache'), fetch, themeFontLinks }) });
    const s = await sessions.open('/docs/a.docx', 1);

    const css = await handler(new Request(`office://${s.token}/yc-fonts/css?u=${encodeURIComponent(CSS_URL)}`));
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toBe('text/css');
    expect(css.headers.get('Content-Security-Policy')).toBeTruthy();
    expect(await css.text()).toContain('/yc-fonts/file?u=');

    const file = await handler(new Request(`office://${s.token}/yc-fonts/file?u=${encodeURIComponent(FILE_URL)}`));
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('font/woff2');
  });

  it('answers 404 for a disallowed font url or an unknown document', async () => {
    const sessions = createSessions(path.join(root, 'sessions-tmp'));
    const fetch = vi.fn(async () => new Response('x'));
    const handler = officeRequestHandler({ root, sessions, fonts: createThemeFonts({ cacheDir: path.join(root, 'cache'), fetch, themeFontLinks }) });
    const s = await sessions.open('/docs/a.docx', 1);
    const bad = await handler(new Request(`office://${s.token}/yc-fonts/css?u=${encodeURIComponent('https://evil.com/css2')}`));
    expect(bad.status).toBe(404);
    const unknown = await handler(new Request(`office://00000000000000000000000000000000/yc-fonts/css?u=${encodeURIComponent(CSS_URL)}`));
    expect(unknown.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('editorFontLinks', () => {
  it('maps each Google stylesheet to the editor origin\'s font route', () => {
    expect(editorFontLinks([CSS_URL], 'office://abc')).toEqual([
      `office://abc/yc-fonts/css?u=${encodeURIComponent(CSS_URL)}`,
    ]);
  });

  it('drops a link the font route would refuse anyway', () => {
    expect(editorFontLinks(['https://fonts.googleapis.com/css?family=X', 'https://evil.com/css2'], 'office://abc')).toEqual([]);
  });
});
