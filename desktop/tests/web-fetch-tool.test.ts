import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { WebFetchTool, __setWebFetchTestHooks, looksJsRendered, resolveFragment, stripToText } from '../src/main/harness/tools/web-fetch';
import { truncateOutput, composeNotice } from '../src/main/harness/tools/truncate';

// Budgets measure CPU time, never wall clock: a quadratic path (backtracking regex, Readability on a hostile DOM) is pure CPU burn,
// and wall time includes time descheduled behind other test workers (that once failed a healthy ~200ms case at 1,339ms).
const cpuMs = (): number => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

const ctx = () => ({ sessionId: 's', cwd: 'C:\\proj', signal: new AbortController().signal, readRegistry: new Map(), todos: [] as any[] });
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

// Real pages: vitest-config.html is the false-negative page (its docs arrive via client-side JS); asyncio.html is server-rendered at a near-identical ratio, so a threshold tweak can't fix one and break the other.
const fixture = (n: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'web', n), 'utf8');

// Stub the page and execute.
const fetchWith = async (body: string, url = 'https://example.com/deep') => {
  __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => html(body) });
  return WebFetchTool.execute({ url } as any, ctx());
};

// Same, for a prepared Response (a Response body is single-use, so one is served once).
const fetchResponse = async (res: Response, url: string) => {
  __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => res });
  return WebFetchTool.execute({ url } as any, ctx());
};

// Reset hooks so a stubbed fetch can't bleed into the next test.
afterEach(() => __setWebFetchTestHooks({}));

describe('WebFetch redirects and the Ask-first website question', () => {
  const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
  it('a redirect to a different website is refused and names that site (so it gets its own question)', async () => {
    const fetchImpl = vi.fn(async (u: string) => (u.includes('a.example') ? redirect('https://b.example/x') : html('hi')));
    __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: fetchImpl as any });
    const r = await WebFetchTool.execute({ url: 'https://a.example/' } as any, ctx());
    expect(r.isError).toBe(true);
    expect(r.text).toContain('b.example');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('a redirect within the same website (www folded, same host) still works', async () => {
    const fetchImpl = vi.fn(async (u: string) => (u === 'https://a.example/' ? redirect('https://www.a.example/y') : html('<html><body><p>done</p></body></html>')));
    __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: fetchImpl as any });
    const r = await WebFetchTool.execute({ url: 'https://a.example/' } as any, ctx());
    expect(r.isError).toBeFalsy();
  });
});

describe('WebFetch', () => {
  it('refuses experiment web fetches before DNS or HTTP without changing tool metadata', async () => {
    const metadata = { name: WebFetchTool.name, description: WebFetchTool.description };
    const lookup = vi.fn(publicLookup);
    const fetchImpl = vi.fn(async () => html('synthetic'));
    __setWebFetchTestHooks({ lookup, fetchImpl });
    vi.stubEnv('YOUCODED_LUNA_EXPERIMENT', '1');
    try {
      const r = await WebFetchTool.execute({ url: 'https://example.invalid/' } as any, ctx());
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/experiment.*network/i);
      expect(lookup).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect({ name: WebFetchTool.name, description: WebFetchTool.description }).toEqual(metadata);
    } finally { vi.unstubAllEnvs(); }
  });
  it('settles a user Stop during pending DNS without dispatching HTTP', async () => {
    const controller = new AbortController();
    let entered!: () => void;
    let release!: (value: Awaited<ReturnType<typeof publicLookup>>) => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const dns = new Promise<Awaited<ReturnType<typeof publicLookup>>>(resolve => { release = resolve; });
    const fetchMock = vi.fn(async () => html('not reached'));
    __setWebFetchTestHooks({ lookup: () => { entered(); return dns; }, fetchImpl: fetchMock });
    const work = WebFetchTool.execute({ url: 'https://pending.example/' } as any, { ...ctx(), signal: controller.signal });
    try {
      await started;
      controller.abort();
      await new Promise<void>(resolve => setImmediate(resolve));
      const result = await Promise.race([work, Promise.resolve(null)]);
      expect(result).toMatchObject({ isError: true });
      expect(result?.text).toMatch(/canceled/i);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { release(await publicLookup()); await work; }
  });
  it('extracts an article to markdown', async () => {
    __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => html(
      '<html><head><title>Docs</title></head><body><nav>junk nav</nav><article><h1>API Guide</h1><p>' + 'Real content. '.repeat(40) + '</p></article></body></html>',
    ) });
    const r = await WebFetchTool.execute({ url: 'https://example.com/docs' } as any, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('API Guide');
    expect(r.text).not.toContain('junk nav');       // Readability stripped chrome
    expect(r.text).toContain('Source: https://example.com/docs'); // D-6: the header is the source URL only
  });
  it('passes plain text / json through', async () => {
    const r = await fetchResponse(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }), 'https://example.com/api');
    expect(r.text).toContain('"ok":true');
  });
  it('refuses binaries honestly', async () => {
    const r = await fetchResponse(new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200, headers: { 'content-type': 'application/pdf' } }), 'https://example.com/f.pdf');
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/application\/pdf/);
  });
  it('surfaces HTTP errors with the status', async () => {
    const r = await fetchResponse(new Response('nope', { status: 404 }), 'https://example.com/missing');
    expect(r.isError).toBe(true);
    expect(r.text).toContain('404');
  });
  it('blocks private targets via the net-guard (integration)', async () => {
    __setWebFetchTestHooks({ lookup: async () => [{ address: '10.0.0.5', family: 4 }], fetchImpl: async () => html('x') });
    const r = await WebFetchTool.execute({ url: 'https://internal.corp/secrets' } as any, ctx());
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/private|internal/i);
  });
  // WHY: ask-first-per-website means the permission subject is the site, not the full address.
  it('permissionSubject is the site, not the full url', () => {
    expect(WebFetchTool.permissionSubject({ url: 'https://a.b/c' } as any)).toBe('a.b');
  });

  // ---- DoS complexity guard: a hostile page must DEGRADE to plain text, never reach Readability, and cost little CPU ----

  // Runs a page through WebFetch and reports the CPU it cost.
  const timed = async (payload: string, name: string) => {
    const t0 = cpuMs();
    const r = await fetchWith(payload, `https://example.com/${name}`);
    return { r, elapsed: cpuMs() - t0 };
  };
  const expectDegraded = async (payload: string, name: string, budgetMs = 1000) => {
    const parseSpy = vi.spyOn(Readability.prototype, 'parse');
    try {
      const { r, elapsed } = await timed(payload, name);
      expect(r.isError).toBeFalsy();
      expect(r.text).toMatch(/too large or deeply nested/);
      expect(r.text).toContain('simplified extraction');
      expect(parseSpy).not.toHaveBeenCalled(); // the guard fires before parse; the spy is the real proof
      expect(elapsed).toBeLessThan(budgetMs);
      return r;
    } finally { parseSpy.mockRestore(); }
  };
  const div = (n: number) => '<div>'.repeat(n);
  const BODY_DIVS = 14_895;

  // Pre-fix CPU cost in ms is beside each case. Most are bypasses of the old hand-rolled depth scan: the guard now reads
  // depth off the REAL linkedom/htmlparser2 tree, so any shape the real parser treats as nesting must be counted.
  const HOSTILE: Array<[name: string, payload: string, budgetMs: number]> = [
    ['5000-deep nesting (Readability is ~quadratic: tens of seconds)', `<html><body>${div(5000)}x${'</div>'.repeat(5000)}</body></html>`, 1000],
    ['a high tag count (20,000 table rows: breadth, not depth)', `<html><body><table>${'<tr><td>x</td></tr>'.repeat(20000)}</table></body></html>`, 1000],
    ['200,000 unterminated "<" (old fallback regex: 12,194)', '<html><body>' + '<'.repeat(200_000), 1000],
    // 'İ'.toLowerCase() is two UTF-16 units: a lowercased copy would skip past the nest that follows the comment (old: let it through)
    ['a comment whose lowercase fold changes length, hiding a 1000-deep nest', `<html><body><!--${'İ'.repeat(200_000)}-->${div(1000)}x${'</div>'.repeat(1000)}</body></html>`, 1000],
    ['</script > (whitespace before >) hiding 14,900 divs (old: 12,149)', '<script>x</script >' + div(14_900), 1000],
    ['<!--> (abrupt empty comment) hiding 14,900 divs (old: 13,656)', '<!-->' + div(14_900), 1000],
    ['<!---> (three-dash abrupt comment)', '<!--->' + div(200), 1000],
    ['an exactly closed <script> then 6,000 divs', '<script>x</script>' + div(6000), 1000],
    ['an exactly closed comment then 6,000 divs', '<!-- a real comment -->' + div(6000), 1000],
    // <script/> stays OPEN on the real stack, then <body> closes it, so the divs are real top-level content (old: 5,518)
    // WHY 2500: a full run at load ~38 measured 1,410ms here; the regression cost 5,518 and the fixed path ~3.
    ['<script/><body> escape hatch', `<html><head></head><script/><body>${div(BODY_DIVS)}</body></html>`, 2500],
    ['<style/><body> escape hatch', `<html><head></head><style/><body>${div(BODY_DIVS)}</body></html>`, 1000],
    // htmlparser2 ignores the self-closing slash on non-void HTML elements, so these nest 700 deep (old: 2,812)
    ['700 self-closing <div/> elements', `<html><body>${'<div/>'.repeat(700)}x</body></html>`, 1000],
    // htmlparser2 ignores an unmatched close tag, so the real DOM nests N deep (old: up to 108,338)
    ...['</span>', '</p>', '</br>'].map((closer) =>
      [`${closer} after every <div> never closes anything`, ('<div>' + closer).repeat(5002), 1000] as [string, string, number]),
    // HTML integration points flip back to ordinary self-closing rules inside svg/math (old: 7,748)
    ...[['foreignObject', '<svg><foreignObject>'], ['desc', '<svg><desc>'], ['mtext', '<math><mtext>']].map(([label, prefix]) =>
      [`<div/> x800 inside ${label}`, prefix + '<div/>'.repeat(800), 1000] as [string, string, number]),
    // every htmlparser2 tag-name terminator after </script closes it: space, tab, LF, FF, CR
    ...[' ', '\t', '\n', '\f', '\r'].map((t) =>
      [`</script${JSON.stringify(t).slice(1, -1) || t}> closes the script`, `<script>x</script${t}>${div(200)}`, 1000] as [string, string, number]),
  ];
  it.each(HOSTILE)('degrades %s', async (_name, payload, budget) => {
    await expectDegraded(payload, 'hostile', budget);
  });

  it('falls back to plain text instead of refusing when the page is too complex, keeping the content', async () => {
    const r = await expectDegraded(`<html><body>${div(200)}THE CONTENT${'</div>'.repeat(200)}</body></html>`, 'complex');
    expect(r.text).toContain('THE CONTENT'); // past MAX_DEPTH 150; the old code hard-failed and left the model nothing
  });

  // The guard's own scans must also stay linear: no '>' anywhere in ~5MB means a lazy-quantifier regex retries at every character.
  it.each([
    ['~5MB of unterminated "<a" tags just under MAX_TAGS (old guard regex: 9,965)', ('<a ' + 'x'.repeat(340)).repeat(14_999)],
    ['5MB of bare "<"', '<'.repeat(5 * 1024 * 1024)],
  ])('stays fast and never throws on %s', async (_name, adversarial) => {
    const { r, elapsed } = await timed(adversarial, 'adversarial');
    expect(typeof r.text).toBe('string');
    expect(elapsed).toBeLessThan(1000);
  });

  // Pages that must NOT be rejected: Readability runs and the article comes through.
  const extractsNormally = async (page: string, name: string, mustContain: string) => {
    const parseSpy = vi.spyOn(Readability.prototype, 'parse');
    try {
      const r = await fetchWith(page, `https://example.com/${name}`);
      expect(r.isError).toBeFalsy();
      expect(r.text).not.toMatch(/too large or deeply nested/);
      expect(r.text).toContain(mustContain);
      expect(parseSpy).toHaveBeenCalled(); // positive control: a change that stopped invoking Readability would fail here
      return r;
    } finally { parseSpy.mockRestore(); }
  };
  const para = 'Real content that is long enough to be extractable. '.repeat(30);

  it('lets a normal article through the guard (depth/tags well under caps)', async () => {
    await extractsNormally('<html><head><title>Docs</title></head><body><header><nav>' + '<a href="#">home</a>'.repeat(10)
      + '</nav></header><main><article><h1>API Guide</h1>' + '<section><p>Real content that is long enough to be extractable. </p></section>'.repeat(30)
      + `</article></main></body></html>`, 'normal', 'API Guide');
  });

  it('does not falsely reject ordinary inline SVG icons or a 120-shape sprite (self-closing is honoured only in svg/math)', async () => {
    await extractsNormally('<html><body><article><h1>Title</h1><p>' + 'Real content. '.repeat(40) + '</p>'
      + '<svg viewBox="0 0 24 24"><path d="M1 2"/><circle cx="1" cy="2" r="3"/><path d="M3 4"/></svg></article></body></html>', 'svg-icon', 'Title');
    await extractsNormally('<html><body><svg style="display:none">' + '<path d="M1 2"/>'.repeat(120) + '</svg>'
      + '<article><h1>Title</h1><p>' + 'Real content. '.repeat(40) + '</p></article></body></html>', 'svg-sprite', 'Title');
  });

  it('returns a clean isError (never an uncaught throw) on malformed HTML', async () => {
    const r = await fetchWith('<html><body><p>< < </ ></</body', 'https://example.com/malformed');
    expect(typeof r.text).toBe('string'); // either extracts or errors cleanly; awaiting proves no uncaught throw
  });

  it('sniffs a no-content-type response and extracts it as HTML', async () => {
    // Bytes, not a string: a string body makes Response add content-type: text/plain and defeats the case.
    const bareBody = new TextEncoder().encode(
      '<!doctype html><html><head><title>Bare</title></head><body><article><h1>Bare Server</h1><p>' + 'Real content. '.repeat(40) + '</p></article></body></html>',
    );
    const r = await fetchResponse(new Response(bareBody, { status: 200 }), 'https://example.com/bare');
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('Bare Server');
  });

  // The real parser (not a hand scan) decides what is script text: "</scripts" and "</script/>" do NOT close a script.
  it.each([
    ['a near-miss "</scripts" inside a script body', '<html><head><script>var s = "</scripts are neat";</script></head><body><article><h1>API Guide</h1><p>'
      + 'Real content. '.repeat(40) + '</p></article></body></html>', 'API Guide', 'are neat'],
    ['"</script/>" (slash is not a terminator inside a script)', '<html><body><script>var a = 1; //</script/> not real markup</script><article><h1>Real</h1><p>'
      + 'Real content. '.repeat(40) + '</p></article></body></html>', 'Real', 'not real markup'],
  ])('does not let %s end the script early', async (_name, page, visible, leaked) => {
    const r = await fetchWith(page, 'https://example.com/script-close');
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain(visible);
    expect(r.text).not.toContain(leaked); // script source must not leak into the article
  });

  it('discloses the fallback char cap when the too-complex page exceeds it', async () => {
    // WHY: the 200KB scan cap has a KNOWN total (the HTML received), so bounds.total must be that number, not null or fabricated.
    const adversarial = '<html><body>' + '<'.repeat(200_000);
    const r = await fetchWith(adversarial, 'https://example.com/adversarial-cap');
    expect(r.isError).toBeFalsy();
    expect(r.bounds).toEqual({
      shown: 200_000,
      total: adversarial.length,
      unit: 'chars',
      moreHint: 'fetch a more specific URL, or a narrower section of the page',
    });
    expect(r.text).toMatch(new RegExp(`showing 200000 of ${adversarial.length} chars`));
    expect(r.text).not.toContain('first 200KB'); // the retired hand-rolled wording
    expect(r.text).not.toContain('[output truncated: showing'); // the bare no-advice fallback
  });

  it('reports the 5MB network cap as separate prose when it fires alongside the 200KB fallback cap', async () => {
    // WHY: the too-complex fallback once skipped the "[body truncated at 5MB]" disclosure; only one `bounds` can ride a result, and the tighter 200KB cap wins, so the 5MB fact stays plain prose.
    // Body: over 5MB (so the network cap cuts it) and still tripping the tag-count guard after truncation.
    const oversized = '<html><body>' + '<div>x</div>'.repeat(500_000); // ~6MB
    const r = await fetchWith(oversized, 'https://example.com/huge');
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('simplified extraction');
    // sanity: readBodyCapped really did cut it down from the ~6MB source
    expect(r.text.length).toBeLessThan(oversized.length);
    expect(r.bounds).toMatchObject({ shown: 200_000, total: 5 * 1024 * 1024, unit: 'chars' });
    expect(r.text).toContain('cut off at the 5MB fetch cap'); // the 5MB fact, still disclosed
    expect(r.text).not.toContain('[body truncated at 5MB]'); // the retired hand-rolled wording
    expect(r.text).not.toContain('[output truncated: showing'); // the bare no-advice fallback
  });

  it('declares the 5MB body cap via bounds with an unknown total', async () => {
    // WHY total: null — the server never said how much more. WHY unit 'chars': once the 30,000-char cap also fires, composeNotice folds both bounds on one line and a mislabel read "30007 of N chars, and 5242880 BYTES".
    // The notice is derived via the same truncateOutput/composeNotice calls so no number is hardcoded.
    const oversized = 'a'.repeat(6 * 1024 * 1024); // > MAX_BODY_BYTES (5MB)
    const r = await fetchResponse(new Response(oversized, { status: 200, headers: { 'content-type': 'text/plain' } }), 'https://example.com/huge.txt');
    expect(r.isError).toBeFalsy();
    const moreHint = 'fetch a more specific URL, or a narrower section of the page';
    expect(r.bounds).toEqual({ shown: 5 * 1024 * 1024, total: null, unit: 'chars', moreHint });
    const rawText = `Source: https://example.com/huge.txt\n\n${'a'.repeat(5 * 1024 * 1024)}`;
    const t = truncateOutput(rawText, { maxChars: 30_000 });
    const notice = composeNotice(r.bounds, t.truncated ? { shown: t.text.length, total: t.totalChars } : null, undefined);
    // WebFetch output is framed as untrusted content; the notice stays outside the tag.
    expect(r.text).toBe(`<untrusted-content source="WebFetch">\n${t.text}\n</untrusted-content>` + notice);
    // total: null renders as "more may exist — exact total unknown", never "N of at least N" or a fabricated count.
    expect(r.text).toMatch(/5242880 chars \(more may exist — exact total unknown\)/);
    expect(r.text).not.toMatch(/5242880 bytes/); // the retired, unit-mismatched wording
    expect(r.text).not.toMatch(/at least 5242880/); // the retired tautological wording
    expect(r.text).toContain('fetch a more specific URL'); // real, tool-specific widening advice
    expect(r.text).not.toContain('[body truncated at 5MB]'); // the retired hand-rolled wording
    expect(r.text).not.toContain('[output truncated: showing'); // the bare no-advice fallback
  });

  it('does not claim two different units for the same text on a large non-HTML body (CJK unit mismatch)', async () => {
    // WHY: for ASCII the byte cap and raw.length coincide. 2,000,000 x '你' (3 bytes) is 6,000,000 bytes, so the 5MB cut lands
    // mid-character and decodes to 1,747,627 UTF-16 units; the old notice claimed 5242880 BYTES beside 30,007 CHARS of the same text.
    const CJK = '你'; // 3 bytes in UTF-8 ('你')
    const oversized = CJK.repeat(2_000_000); // exactly 6,000,000 bytes
    expect(Buffer.byteLength(oversized, 'utf8')).toBe(6_000_000); // sanity: the premise this test rests on
    const r = await fetchResponse(new Response(oversized, { status: 200, headers: { 'content-type': 'text/plain' } }), 'https://example.com/huge-cjk.txt');
    expect(r.isError).toBeFalsy();
    // Computed independently of web-fetch.ts (plain Buffer slice+decode) so this does not just echo the source.
    const decodedRaw = Buffer.from(oversized, 'utf8').subarray(0, 5 * 1024 * 1024).toString('utf8');
    expect(decodedRaw.length).toBe(1_747_627); // pins the premise's own numbers
    expect(r.bounds).toEqual({
      shown: decodedRaw.length,
      total: null,
      unit: 'chars',
      moreHint: 'fetch a more specific URL, or a narrower section of the page',
    });
    // Exactly one unit ("chars") may appear in the notice.
    const noticeLine = r.text.slice(r.text.lastIndexOf('\n['));
    const unitMentions = noticeLine.match(/\d[\d,]* (chars|bytes)/g) ?? [];
    expect(unitMentions.length).toBeGreaterThan(0);
    expect(unitMentions.every((m) => m.endsWith('chars'))).toBe(true); // never "bytes" alongside "chars"
    expect(r.text).not.toMatch(/5242880 bytes/); // the retired, overstated, wrong-unit claim
  });

  it('does not overstate what was shown when a >5MB HTML body extracts to a short article ', async () => {
    // WHY: a 6MB page whose real article is one short paragraph (padding inside an HTML comment, inert to the guard and Readability).
    // `bounds` once claimed shown = the 5MB cap, telling the model it had seen everything.
    const filler = 'x'.repeat(6_000_000);
    const page = `<html><head><title>Padded</title></head><body><article><h1>Article</h1><p>Short real article.</p></article><!--${filler}--></body></html>`;
    const r = await fetchWith(page, 'https://example.com/padded-article');
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('Short real article.');
    expect(r.bounds).toBeTruthy();
    // sanity: the network fetch really did truncate at 5MB
    expect(r.bounds!.total).toBeNull();
    expect(r.bounds!.unit).toBe('chars');
    // `shown` must describe the ACTUAL returned text, never the 5MB network cap.
    expect(r.bounds!.shown).toBeLessThan(10_000);
    expect(r.text).not.toMatch(/5242880 of (at least )?5242880/);
    expect(r.text).not.toMatch(/showing 5242880/);
    expect(r.text).toContain('cut off at the 5MB fetch cap');
  });

  // 'İ'.toLowerCase() grows by a UTF-16 unit, so a lowercased copy indexed with the original's offsets shifts every later check.
  // stripToText and withoutScriptAndStyle each carried that bug.

  it('does not leak script source or drop visible text on an İ-prefixed too-complex fallback ', () => {
    // The 79 'x's put the shifted offset exactly on an unrelated later '<p>', which was misread as a script open and dropped the rest.
    const withIota = 'İ'.repeat(100) + '<script>JUNK</script>' + 'x'.repeat(79) + '<p>DROPME_TEXT_HERE!</p>TAIL_OK';
    const t = stripToText(withIota);
    expect(t).toContain('DROPME_TEXT_HERE');
    expect(t).not.toContain('JUNK');
    // Control with 'q' (no expansion on lowercasing) isolates the aliasing as the defect.
    const withQ = 'q'.repeat(100) + '<script>JUNK</script>' + 'x'.repeat(79) + '<p>DROPME_TEXT_HERE!</p>TAIL_OK';
    const control = stripToText(withQ);
    expect(control).toContain('DROPME_TEXT_HERE');
    expect(control).not.toContain('JUNK');
  });

  it('does not leak script source or drop visible text on an İ-prefixed too-complex fallback, end-to-end through execute()', async () => {
    // Same payload through the real too-complex branch (200 trailing nested divs).
    const body = '<html><body>'
      + 'İ'.repeat(100) + '<script>JUNK</script>' + 'x'.repeat(79) + '<p>DROPME_TEXT_HERE!</p>TAIL_OK'
      + '<div>'.repeat(200) + 'y' + '</div>'.repeat(200)
      + '</body></html>';
    const r = await fetchWith(body, 'https://example.com/iota-fallback');
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('simplified extraction'); // confirms this went through the guard path
    expect(r.text).toContain('DROPME_TEXT_HERE');
    expect(r.text).not.toContain('JUNK');
  });

  it('does not let a leading İ turn off the JS-rendered disclosure on a real Next.js-shaped page', () => {
    // WHY: a 60-'İ' prefix (any Turkish page) once pushed vitest-config.html's measured ratio from 7.18% to 30.5%, past the 10% floor,
    // silently turning the JS-rendered disclosure off.
    const html = fixture('vitest-config.html');
    expect(looksJsRendered(html)).toBe(true); // baseline, no İ
    expect(looksJsRendered('İ'.repeat(60) + html)).toBe(true); // must stay true
  });

  it('falls back to whole-body markdown when Readability finds no article', async () => {
    // No readable article: Readability returns null and we must still return something structured.
    __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => html(
      '<html><head><title>Dashboard</title></head><body><div><a href="/one">One</a><a href="/two">Two</a></div></body></html>',
    ) });
    const r = await WebFetchTool.execute({ url: 'https://example.com/dash' } as any, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('One');
    expect(r.text).toContain('Two');
  });

  // An empty body must read differently for: a genuinely short page, a JS shell, and an unclear cause — and never assert
  // a cause (e.g. "requires JavaScript") the code has not established.

  it('says plainly when a page is genuinely short (little content anywhere, not a fetch problem)', async () => {
    const r = await fetchWith('<html><body><h1>Hi</h1></body></html>', 'https://example.com/tiny-page');
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/short|mostly-empty/i);
    expect(r.text).not.toMatch(/JavaScript-rendered/i);
    expect(r.text).not.toMatch(/isn't clear why|is not clear why/i);
  });

  it('names the JS-rendered cause and gives a concrete next step when extraction is empty AND the JS-render heuristic fires', async () => {
    // Empty #__next root + __NEXT_DATA__ marker + enough markup to push density under 10%, with NO body content: needs a concrete next step.
    const filler = '<div class="pad-0123456789012345678901234567890123456789"></div>'.repeat(250);
    const page = '<html><head><title>App Shell</title></head><body>' + filler
      + '<div id="__next"></div>'
      + '<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify({ x: 'y'.repeat(500) }) + '</script>'
      + '</body></html>';
    const r = await fetchWith(page, 'https://example.com/js-shell-empty');
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/JavaScript-rendered/i);
    expect(r.text).toMatch(/WebSearch/); // concrete next step, house style
    expect(r.text).not.toMatch(/short|mostly-empty/i);
    expect(r.text).not.toMatch(/isn't clear why|is not clear why/i);
  });

  it('admits the cause is unclear when extraction is empty, the page had real text elsewhere, and the JS-render heuristic did NOT fire', async () => {
    // Long <title> (counted by the density check, never fed to Readability) + empty <body>, no JS markers: the honest answer
    // is "not clear why", NEVER "requires JavaScript" (the DeepSeek/IntelliJ shape).
    const longTitle = 'word '.repeat(150); // 750 raw chars, well past the substantial-text floor
    const page = `<html><head><title>${longTitle}</title></head><body></body></html>`;
    const r = await fetchWith(page, 'https://example.com/unexplained-empty');
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/isn't clear why|is not clear why/i);
    expect(r.text).not.toMatch(/JavaScript-rendered/i);
    expect(r.text).not.toMatch(/genuinely short|mostly-empty/i);
    expect(r.text).toMatch(/WebSearch/); // still gets a concrete next step, house style
  });

  it('does not disturb the existing JS-render disclosure when extraction is NOT thin (regression floor)', async () => {
    // A non-thin extraction through a JS-flagged page keeps the original "a section may be missing" wording.
    const r = await fetchWith(fixture('vitest-config.html'), 'https://example.com/vitest-config-full');
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/JavaScript-rendered/i);
    expect(r.text).toContain('If a section you expected is absent, it is likely rendered client-side.');
  });
});

describe('looksJsRendered', () => {
  it('flags the VitePress page whose content never reaches an HTTP client', () => {
    // 98KB of HTML, 5.2KB of text, __VP_HASH_MAP__ marker alone (its #app is not empty); a model asked about `include` concluded it was undocumented.
    expect(looksJsRendered(fixture('vitest-config.html'))).toBe(true);
  });

  it('does NOT flag a server-rendered docs page of similar shape', () => {
    // Same tool, same extraction ratio (69% vs 70%) — the discriminator has to be
    // text density plus framework markers, not coverage.
    expect(looksJsRendered(fixture('asyncio.html'))).toBe(false);
  });

  it('does not flag a small plain page', () => {
    expect(looksJsRendered('<html><body><h1>Hi</h1><p>Some words here.</p></body></html>')).toBe(false);
  });

  it('does not flag an SSR page whose density only looks low because of a hydration blob', () => {
    // WHY: a Next.js __NEXT_DATA__ blob in the denominator once deflated density to 7.31% (flagged) vs 89.29% when script bytes are excluded.
    const prose = '<article><h1>Guide</h1>'
      + '<p>Real server-rendered paragraph content that is complete and present. </p>'.repeat(60)
      + '</article>';
    const blob = 'x'.repeat(52_000);
    const ssrPage = `<html><body><div id="__next">${prose}</div>`
      + `<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":"${blob}"}}</script>`
      + '</body></html>';
    expect(looksJsRendered(ssrPage)).toBe(false);
  });
});

describe('resolveFragment', () => {
  const html = fixture('vitest-config.html');

  it('reports a fragment the served HTML never contained', () => {
    // id="include" appears nowhere in the served HTML: the case that gave a confident false negative.
    expect(resolveFragment(html, '## Config Options\n\ntext', 'include').kind).toBe('absent');
  });

  it('reports a fragment present in the HTML but missing from the extraction', () => {
    expect(resolveFragment(html, '# Nothing relevant here', 'config-options').kind).toBe('dropped');
  });

  it('returns the section when the fragment survived extraction', () => {
    // VitePress headings carry a trailing anchor link, so matching must go through the href, not a slug of the heading text.
    const md = '## Intro\n\nfirst\n\n## Config Options [​](#config-options)\n\nthe body\n\n## After\n\nlast';
    const r = resolveFragment(html, md, 'config-options');
    expect(r.kind).toBe('found');
    if (r.kind === 'found') {
      expect(r.section).toContain('the body');
      expect(r.section).not.toContain('last');
      expect(r.exactCase).toBe(true);
    }
  });

  // Anchor forms the scan must see: single-quoted, unquoted, legacy <a name>, and UPPERCASE attribute names
  // (linkedom does not lowercase attribute names, so `[id]` never matched <h2 ID=...>). A miss reported a fabricated "no such anchor".
  it.each([
    ['a single-quoted id', "<h2 id='alpha'>Alpha</h2>", 'alpha'],
    ['an unquoted id', '<h2 id=beta>Beta</h2>', 'beta'],
    ['a legacy <a name="...">', '<a name="gamma"></a><h2>Gamma</h2>', 'gamma'],
    ['an uppercase ID attribute name', '<h2 ID="upattr">Section Title</h2>', 'upattr'],
    ['an uppercase NAME attribute name on a legacy anchor', '<a NAME="legacyU"></a><h2>Legacy</h2>', 'legacyU'],
    // The old tag walker took the first `>` as the tag's end, losing every attribute after a `>` inside a quoted value.
    ['an id past a ">" inside another attribute value', '<a title="a>b" id="realid"></a>', 'realid'],
    ['an id past a ">" in an onclick handler', '<div onclick="if(a>b)f()" id="clickid"></div>', 'clickid'],
  ])('finds %s', (_name, body, id) => {
    expect(resolveFragment(`<html><body>${body}</body></html>`, '# irrelevant', id).kind).not.toBe('absent');
  });

  // Each of these once produced a fabricated anchor that flipped a correct `absent` into a false `dropped`.
  it.each([
    ['data-id=', '<div data-id="ghost">text</div>', 'ghost'],
    ['id= inside another attribute value (href query string)', '<a href="/page?id=42">link</a>', '42'],
    ['id= assigned inside a <script> body', '<script>el.id = "jsassigned"; var s = "id=leaked";</script>', 'jsassigned'],
    ['id= inside an HTML comment', '<!-- id="commented" --><p>text</p>', 'commented'],
    // textarea/title/xmp are raw-text elements: tag-shaped text inside is never a child element (any page echoing user markup)
    ['an id inside a <textarea> (raw text)', '<textarea><a id="tafake"></textarea>', 'tafake'],
  ])('does not treat %s as a real anchor id', (_name, body, id) => {
    expect(resolveFragment(`<html><body>${body}</body></html>`, '# Nothing relevant', id).kind).toBe('absent');
  });

  it('matches an id exactly by case, and falls back to a case-insensitive match reported as such (HTML ids are case-sensitive)', () => {
    const exact = resolveFragment('<html><body><h2 id="Foo">Foo</h2><h2 id="foo">also foo</h2></body></html>', '## Foo', 'Foo');
    expect(exact).toMatchObject({ kind: 'found', exactCase: true });
    const folded = resolveFragment('<html><body><h2 id="Foo">Foo</h2></body></html>', '## Foo', 'foo');
    expect(folded).toMatchObject({ kind: 'found', exactCase: false });
  });

  // `absent` is a categorical claim, so it must say when the body was cut off at the 5MB cap.
  it.each([[false], [true]])('reports bodyTruncated: %s on an absent fragment', (cut) => {
    expect(resolveFragment('<html><body>no anchors here</body></html>', '', 'missing', cut)).toEqual({ kind: 'absent', bodyTruncated: cut });
  });

  it('resolves quickly against thousands of <a> tags with no name= (floor for the old quadratic ANCHOR_NAME_RE: 9,810ms)', () => {
    const body = '<html><body>' + ('<a href="#">' + 'x'.repeat(660) + '</a>').repeat(7000) + '</body></html>';
    const t0 = cpuMs();
    const r = resolveFragment(body, '# nothing relevant', 'section');
    const elapsed = cpuMs() - t0;
    expect(r.kind).toBe('absent');
    expect(elapsed).toBeLessThan(1000);
  });

  // Fragment resolution queries the same linkedom document WebFetch builds, not a hand scan of raw HTML.
  it('finds an id on a <script> element\'s own opening tag (check-dark-mode lives on <script id=...>), in the unit and the pipeline', async () => {
    expect(resolveFragment(html, '# irrelevant heading', 'check-dark-mode').kind).not.toBe('absent');
    // The honest verdict is "dropped", never "contains no anchor named". (fetchWith, because `html` is shadowed by the fixture here.)
    const r = await fetchWith(html, 'https://example.com/config#check-dark-mode');
    expect(r.isError).toBeFalsy();
    expect(r.text).not.toMatch(/contains no anchor named/);
  });

  it('every id in the fixture\'s parsed DOM resolves through resolveFragment (12 ids; counts alone prove nothing)', () => {
    const { document } = parseHTML(html);
    const ids = new Set<string>();
    for (const el of document.querySelectorAll('[id]')) {
      const id = el.getAttribute('id');
      if (id) ids.add(id);
    }
    expect(ids.size).toBe(12);
    for (const id of ids) expect(resolveFragment(html, '# irrelevant heading', id).kind).not.toBe('absent');
  });
});
