import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { WebFetchTool, __setWebFetchTestHooks, looksJsRendered, resolveFragment, stripToText } from '../src/main/harness/tools/web-fetch';
import { truncateOutput, composeNotice } from '../src/main/harness/tools/truncate';

// Every budget assertion in this file measures CPU TIME, not wall-clock time.
//
// WHAT THESE TESTS GUARD: each one pins that a quadratic path (a backtracking
// regex, or Readability parsing a hostile DOM) did NOT run. The pre-fix figures
// quoted beside each budget — 2,812ms up to 108,338ms — are pure CPU burn on a
// single thread, so CPU time measures exactly the thing under test.
//
// WHY IT CHANGED (2026-08-28): with `Date.now()` these read the wall clock, and
// wall time includes every millisecond this process spent DESCHEDULED while
// other test workers had the CPU. Under a parallel suite run that regularly
// pushed a ~200ms piece of work past the 1,000ms budget — observed at 1,339ms
// and 1,373ms — failing a test that had found nothing wrong. CPU time is
// unaffected by how many other workers are running, so the budget now means
// what its comments always claimed it meant, and the numbers below did not have
// to be inflated to buy headroom that would have blunted them.
const cpuMs = (): number => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};


const ctx = () => ({ sessionId: 's', cwd: 'C:\\proj', signal: new AbortController().signal, readRegistry: new Map(), todos: [] as any[] });
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

// Real-page fixtures (task 12): vitest-config.html is the false-negative page —
// its documented content arrives via client-side JS, so a reviewing model asking
// about `include` gets a confident-but-wrong "not documented" answer. asyncio.html
// is a server-rendered page of near-identical extraction ratio, pinned so a
// threshold tweak that "fixes" one can't silently break the other.
const fixture = (n: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'web', n), 'utf8');

// Shared stub-and-execute helper (task 11 brief: reuse the existing test-hooks
// pattern under one name instead of repeating the two-line stub at every call site).
const fetchWith = async (body: string, url = 'https://example.com/deep') => {
  __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => html(body) });
  return WebFetchTool.execute({ url } as any, ctx());
};

// Reset the injected hooks after every test so lookup/fetch state can't leak
// between cases (a stubbed fetch bleeding into the next test would be a silent lie).
afterEach(() => __setWebFetchTestHooks({}));

describe('WebFetch', () => {
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
    __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }) });
    const r = await WebFetchTool.execute({ url: 'https://example.com/api' } as any, ctx());
    expect(r.text).toContain('"ok":true');
  });
  it('refuses binaries honestly', async () => {
    __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200, headers: { 'content-type': 'application/pdf' } }) });
    const r = await WebFetchTool.execute({ url: 'https://example.com/f.pdf' } as any, ctx());
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/application\/pdf/);
  });
  it('surfaces HTTP errors with the status', async () => {
    __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => new Response('nope', { status: 404 }) });
    const r = await WebFetchTool.execute({ url: 'https://example.com/missing' } as any, ctx());
    expect(r.isError).toBe(true);
    expect(r.text).toContain('404');
  });
  it('blocks private targets via the net-guard (integration)', async () => {
    __setWebFetchTestHooks({ lookup: async () => [{ address: '10.0.0.5', family: 4 }], fetchImpl: async () => html('x') });
    const r = await WebFetchTool.execute({ url: 'https://internal.corp/secrets' } as any, ctx());
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/private|internal/i);
  });
  it('permissionSubject is the url', () => {
    expect(WebFetchTool.permissionSubject({ url: 'https://a.b/c' } as any)).toBe('https://a.b/c');
  });

  // --- extra edge tests (plan: "further edge tests you judge necessary") ---

  it('always emits the Source: line pointing at the final URL', async () => {
    __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => html(
      '<html><head><title>Docs</title></head><body><article><h1>API Guide</h1><p>' + 'Real content. '.repeat(40) + '</p></article></body></html>',
    ) });
    const r = await WebFetchTool.execute({ url: 'https://example.com/docs' } as any, ctx());
    expect(r.text).toContain('Source: https://example.com/docs');
  });

  // --- DoS complexity-guard tests (CRITICAL: main-thread freeze) ---

  it('degrades hostile DOM depth to plain text WITHOUT reaching Readability', async () => {
    // 5000-deep nesting would take TENS of seconds in Readability's ~quadratic
    // parse and freeze the whole app. The O(n) pre-check must reject it BEFORE
    // Readability runs (the guard fires long before parse), so this test also
    // returns fast.
    // UPDATED (task 11, 2026-08-06): the guard's outcome changed from a hard
    // refusal to a degraded success — tag-stripping is O(n) and safe, so a
    // rejected page can still return honest content instead of nothing. The
    // Readability spy is what still proves the DoS guard itself is intact.
    const parseSpy = vi.spyOn(Readability.prototype, 'parse');
    const deep = '<html><body>' + '<div>'.repeat(5000) + 'x' + '</div>'.repeat(5000) + '</body></html>';
    __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => html(deep) });
    const t0 = cpuMs();
    const r = await WebFetchTool.execute({ url: 'https://example.com/deep' } as any, ctx());
    const elapsed = cpuMs() - t0;
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/too large or deeply nested/);
    expect(r.text).toContain('simplified extraction');
    expect(parseSpy).not.toHaveBeenCalled();
    // If Readability had run, this would be many seconds; the guard keeps it tiny.
    expect(elapsed).toBeLessThan(1000);
    parseSpy.mockRestore();
  });

  it('degrades a high tag count (huge table / anchor list) WITHOUT reaching Readability', async () => {
    // ~40k tags — far past MAX_TAGS. Cost here is breadth, not depth.
    // UPDATED (task 11, 2026-08-06): see note above — refusal became a degraded
    // success; the Readability spy proves the guard still stopped the parse.
    const parseSpy = vi.spyOn(Readability.prototype, 'parse');
    const wide = '<html><body><table>' + '<tr><td>x</td></tr>'.repeat(20000) + '</table></body></html>';
    __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => html(wide) });
    const r = await WebFetchTool.execute({ url: 'https://example.com/wide' } as any, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/too large or deeply nested/);
    expect(r.text).toContain('simplified extraction');
    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();
  });

  it('lets a normal article through the guard (depth/tags well under caps)', async () => {
    // Realistic article with moderate nesting and tag count — must NOT be rejected.
    const article = '<html><head><title>Docs</title></head><body><header><nav>'
      + '<a href="#">home</a>'.repeat(10) + '</nav></header><main><article><h1>API Guide</h1>'
      + '<section><p>Real content that is long enough to be extractable. </p></section>'.repeat(30)
      + '</article></main></body></html>';
    __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => html(article) });
    const r = await WebFetchTool.execute({ url: 'https://example.com/docs' } as any, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('API Guide');
  });

  it('DOES call Readability.parse on a normal page that clears the guard (positive control)', async () => {
    // MINOR finding (2026-08-06 re-review): every other test in this describe
    // block that spies on Readability.prototype.parse asserts it was NOT
    // called (guard-path tests above). Nothing previously asserted it IS
    // called on the normal path — a change that stopped invoking Readability
    // entirely (e.g. always falling through to the plain-text path) would
    // have left all three of those tests green. This is that missing control.
    const parseSpy = vi.spyOn(Readability.prototype, 'parse');
    const article = '<html><head><title>Docs</title></head><body><article><h1>API Guide</h1><p>'
      + 'Real content that is long enough to be extractable. '.repeat(30) + '</p></article></body></html>';
    __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => html(article) });
    const r = await WebFetchTool.execute({ url: 'https://example.com/normal' } as any, ctx());
    expect(r.isError).toBeUndefined();
    expect(parseSpy).toHaveBeenCalled();
    parseSpy.mockRestore();
  });

  it('returns a clean isError (never an uncaught throw) on malformed HTML', async () => {
    // The reviewer saw `new Readability(document)` throw on some malformed input.
    // defineTool's try/catch must convert any such throw into an isError result,
    // not let it escape as an uncaught exception. Passes the depth/tag guard first.
    __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => html('<html><body><p>< < </ ></</body') });
    const r = await WebFetchTool.execute({ url: 'https://example.com/malformed' } as any, ctx());
    // Either it extracts something OR it errors cleanly — the ONLY failure mode we
    // forbid is a rejected promise / uncaught throw, and awaiting proves neither.
    expect(typeof r.text).toBe('string');
  });

  it('sniffs a no-content-type response and extracts it as HTML', async () => {
    // A bare/misconfigured server omits content-type. If the body is clearly HTML,
    // read it instead of refusing it as an "unknown binary type".
    // NOTE: a STRING body makes Response auto-add `content-type: text/plain`, which
    // would defeat the no-content-type path — encode to bytes so the header stays
    // genuinely absent (mirrors the real bare-server case).
    const bareBody = new TextEncoder().encode(
      '<!doctype html><html><head><title>Bare</title></head><body><article><h1>Bare Server</h1><p>'
        + 'Real content. '.repeat(40) + '</p></article></body></html>',
    );
    __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => new Response(bareBody, { status: 200 }) });
    const r = await WebFetchTool.execute({ url: 'https://example.com/bare' } as any, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('Bare Server');
  });

  it('falls back to plain text instead of refusing when the page is too complex', async () => {
    // 200 nested divs — past MAX_DEPTH 150, so Readability must not run. The old
    // code hard-failed here, leaving the model with nothing (Kimi K3 finding #1).
    const deep = '<div>'.repeat(200) + 'THE CONTENT' + '</div>'.repeat(200);
    const r = await fetchWith(`<html><body>${deep}</body></html>`);
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('THE CONTENT');
    expect(r.text).toContain('simplified extraction');
  });

  it('does not freeze on 200,000 unterminated "<" characters (CRITICAL DoS regression)', async () => {
    // WHY this exact shape (2026-08-06 review): tooComplexToExtract() counts
    // every '<' regardless of whether it is ever closed by a '>', so this
    // 200,012-byte body (far under the 5MB cap) trips the tag-count guard and
    // is handed to the plain-text fallback. The OLD fallback used
    // /<[^>]*>/g, which — because none of these 200,000 '<' are ever followed
    // by a '>' — retries its match at every subsequent character, each retry
    // re-scanning to the end of the string. Measured directly against that
    // regex on this exact input: 12,194ms. The fix (a hand-written, strictly
    // forward-moving scan — see stripToText's WHY comment) must complete in a
    // small fraction of that.
    const adversarial = '<html><body>' + '<'.repeat(200_000);
    const parseSpy = vi.spyOn(Readability.prototype, 'parse');
    const t0 = cpuMs();
    const r = await fetchWith(adversarial, 'https://example.com/adversarial');
    const elapsed = cpuMs() - t0;
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('simplified extraction');
    expect(parseSpy).not.toHaveBeenCalled(); // guard still stopped Readability, not just stripToText
    expect(elapsed).toBeLessThan(1000); // was 12,194ms before the fix
    parseSpy.mockRestore();
  });

  it('does not freeze when the complexity guard itself scans ~5MB of unterminated "<a" tags (CRITICAL regression, guard tagRe)', async () => {
    // WHY this exact shape (2026-08-06 re-review, finding "IMPORTANT — the
    // guard's own tagRe is quadratic"): tooComplexToExtract's OLD depth-scan
    // regex (/<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*?(\/?)>/g) is what froze here —
    // NOT stripToText, which the previous round already fixed. The tag-COUNT
    // pre-check (which just counts raw '<' characters) does not save it:
    // 14,999 is deliberately just under MAX_TAGS (15,000), so this input
    // reaches the depth scan. There is no '>' anywhere in the ~5MB document,
    // so the old lazy-quantifier regex fails at every one of the 14,999 '<a'
    // starts and retries at every subsequent character, each retry
    // re-scanning to the (nonexistent) end. Measured directly against the old
    // regex on this exact shape: 9,965ms, entirely inside
    // WebFetchTool.execute, before Readability is ever reached.
    const filler = 'x'.repeat(340); // pads to ~5MB while keeping the '<' count (14,999) under MAX_TAGS
    const adversarial = ('<a ' + filler).repeat(14_999);
    const t0 = cpuMs();
    const r = await fetchWith(adversarial, 'https://example.com/adversarial-guard');
    const elapsed = cpuMs() - t0;
    expect(typeof r.text).toBe('string'); // never an uncaught throw
    expect(elapsed).toBeLessThan(1000); // was 9,965ms before the fix
  });

  it('does not misjudge depth on a comment body whose lowercase fold changes length (CRITICAL regression, round 3)', async () => {
    // WHY this exact shape (2026-08-06 round-3 review): the guard's depth scan
    // used to build one `lower = html.toLowerCase()` copy and index it with
    // offsets computed against `html`'s own length. That is only safe if
    // lowercasing never changes length, which is false for some codepoints —
    // 'İ'.toLowerCase() (U+0130) is TWO UTF-16 units. A 200,000-char comment
    // body of 'İ' makes `lower` 200,000 units longer than `html`, so the
    // comment-close search (run against `lower`) finds '-->' at an index that
    // overshoots the SAME position in `html` by 200,000 characters — the
    // cursor skips straight over the 1,000-deep <div> nest that follows,
    // the guard measures depth < 150, and Readability runs on a document
    // that is ACTUALLY 1,000 deep. Measured directly against the OLD
    // (aliased) guard logic on this exact payload: it returned "not too
    // complex" in 5ms, i.e. it let the page through. Verified as a real
    // regression at e1eee255^ (before this file's round-1 fix): the same
    // payload was rejected by the guard in 3ms with Readability never
    // called. The fix removes the second string entirely (see indexOfFold's
    // WHY comment) so there is only ever one index space.
    const payload = '<!--' + 'İ'.repeat(200_000) + '-->' + '<div>'.repeat(1000) + 'x' + '</div>'.repeat(1000);
    const parseSpy = vi.spyOn(Readability.prototype, 'parse');
    const t0 = cpuMs();
    const r = await fetchWith(`<html><body>${payload}</body></html>`, 'https://example.com/aliasing');
    const elapsed = cpuMs() - t0;
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/too large or deeply nested/);
    expect(r.text).toContain('simplified extraction');
    expect(parseSpy).not.toHaveBeenCalled(); // guard must reject BEFORE Readability, not discover the hang inside it
    expect(elapsed).toBeLessThan(1000); // was 8,376ms before the fix (Readability ran on an actually-1000-deep doc)
    parseSpy.mockRestore();
  });

  // --- script/comment terminator bypass (BLOCKER B2, round 5, 2026-08-06) ---
  //
  // linkedom parses HTML via `htmlparser2` (verified by reading
  // node_modules/linkedom/esm/shared/parse-from-string.js). Its tokenizer
  // closes a <script>/<style> at '</name' followed by '>' or ASCII
  // whitespace — NOT only an exact '</script>' literal — and closes a
  // comment at '-->' while treating the opening '--' as already 2/3 of a
  // potential closer, so '<!-->' and '<!--->' close immediately with empty
  // content ("Allow short comments" in Tokenizer.js). The four tests below
  // pin the two exploitable mismatches (the guard believed content the real
  // parser had already closed was "still inside" a script/comment, so real
  // <div> depth right after was never counted) and the fidelity fixes that
  // came out of matching the real tokenizer exactly.

  it('rejects a </script > (whitespace-terminated) close bypass — CRITICAL, BLOCKER B2', async () => {
    // Payload and depth match the reviewer's PoC exactly: a script closed
    // with a SPACE before '>' (still a real close to linkedom/htmlparser2 —
    // its stateInSpecialTag accepts '>' or whitespace), followed by 14,900
    // unclosed <div> opens. The old walkTags searched for the literal
    // '</script>' substring, which never occurs here, so it treated
    // everything from the <script> tag to the end of the string as "still
    // inside the script" and never counted the divs toward MAX_DEPTH.
    // Measured on this machine BEFORE this fix, through
    // WebFetchTool.execute: 12,149ms (guard let the payload through,
    // Readability then blocked the main thread). Control (unwrapped divs):
    // 2ms, rejected.
    const parseSpy = vi.spyOn(Readability.prototype, 'parse');
    const payload = '<script>x</script >' + '<div>'.repeat(14_900);
    const t0 = cpuMs();
    const r = await fetchWith(payload, 'https://example.com/script-space-bypass');
    const elapsed = cpuMs() - t0;
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/too large or deeply nested/);
    expect(parseSpy).not.toHaveBeenCalled();
    expect(elapsed).toBeLessThan(1000); // was 12,149ms before the fix
    parseSpy.mockRestore();
  });

  it('rejects a <!--> (abrupt-closing comment) bypass — CRITICAL, BLOCKER B2', async () => {
    // '<!-->' is a complete, empty comment to linkedom/htmlparser2 (its
    // opening '--' doubles as the closer's own '--'). The old walkTags
    // searched for '-->' starting AFTER those two dashes, and a bare
    // '<!-->' (5 bytes total) has no room for a second, separate '-->', so
    // the "comment" was treated as never closing and all 14,900 <div> opens
    // after it were swallowed as "still inside a comment". Measured on this
    // machine BEFORE this fix: 13,656ms (control: 2ms, rejected).
    const parseSpy = vi.spyOn(Readability.prototype, 'parse');
    const payload = '<!-->' + '<div>'.repeat(14_900);
    const t0 = cpuMs();
    const r = await fetchWith(payload, 'https://example.com/comment-abrupt-bypass');
    const elapsed = cpuMs() - t0;
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/too large or deeply nested/);
    expect(parseSpy).not.toHaveBeenCalled();
    expect(elapsed).toBeLessThan(1000); // was 13,656ms before the fix
    parseSpy.mockRestore();
  });

  it('still rejects deep nesting when the script/comment closer is an EXACT, non-bypass match (regression sanity, 6,000 depth)', async () => {
    // Confirms the B2 fix did not change behavior for ordinary, exactly
    // closed wrappers — only the whitespace/abrupt-close forms were ever
    // broken. Depth 6,000 (well past MAX_DEPTH 150) via <div>s placed
    // OUTSIDE a properly closed <script> and a properly closed, non-abrupt
    // comment.
    const parseSpy = vi.spyOn(Readability.prototype, 'parse');
    const scriptVariant = '<script>x</script>' + '<div>'.repeat(6_000);
    const t0 = cpuMs();
    const r1 = await fetchWith(scriptVariant, 'https://example.com/script-matched-6000');
    const e1 = cpuMs() - t0;
    expect(r1.text).toMatch(/too large or deeply nested/);

    const commentVariant = '<!-- a real comment -->' + '<div>'.repeat(6_000);
    const t1 = cpuMs();
    const r2 = await fetchWith(commentVariant, 'https://example.com/comment-matched-6000');
    const e2 = cpuMs() - t1;
    expect(r2.text).toMatch(/too large or deeply nested/);

    expect(parseSpy).not.toHaveBeenCalled();
    expect(e1).toBeLessThan(1000);
    expect(e2).toBeLessThan(1000);
    parseSpy.mockRestore();
  });

  // --- self-closing raw-text tag bypass (round 6, 2026-08-06) ---
  //
  // htmlparser2's tokenizer resets `isSpecial = false` the instant it sees
  // the self-closing `/>` on a <script>/<style> tag (Tokenizer.js
  // stateInSelfClosingTag) — a self-closed raw-text tag never enters the
  // InSpecialTag raw-text state at all. And linkedom's Parser (htmlparser2,
  // HTML mode, not recognizeSelfClosing — verified in
  // node_modules/linkedom/esm/shared/parse-from-string.js, `{xmlMode:
  // !isHTML}`) ignores the self-closing slash on ANY non-void, non-foreign
  // element, so it stays OPEN on the real parse stack exactly like a normal
  // open tag. The two tests below pin the two ways the old walkTags/
  // tooComplexToExtract disagreed with that and the fidelity fix.

  it('rejects the <script/><body> escape-hatch bypass — CRITICAL, round 6', async () => {
    // <script/> leaves an EMPTY, still-open <script> on the parse stack (self-
    // close ignored). The following <body> tag triggers htmlparser2's
    // openImpliesClose rule (`["body", new Set(["head","link","script"])]`,
    // Parser.ts) and closes that empty script immediately — so every <div>
    // after <body> is real, un-stripped top-level content, NOT a script
    // descendant Readability's own _removeScripts would have discarded.
    // The old walkTags searched for a literal LATER '</script...' closer
    // that deliberately never appears, found none, and skipped every tag for
    // the rest of the document (real depth included) as "still inside the
    // script". Measured on this machine BEFORE this fix, through
    // WebFetchTool.execute: 5,518ms (guard let the payload through,
    // Readability ran on a genuinely ~14,895-deep document and eventually
    // threw "Maximum call stack size exceeded" — 5.5s of main-thread block
    // before that throw). Control (same divs, no script/body trick): 3ms,
    // rejected as normal.
    const parseSpy = vi.spyOn(Readability.prototype, 'parse');
    const N = 14_895;
    const payload = '<html><head></head><script/><body>' + '<div>'.repeat(N) + '</body></html>';
    const t0 = cpuMs();
    const r = await fetchWith(payload, 'https://example.com/script-selfclose-body-escape');
    const elapsed = cpuMs() - t0;
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/too large or deeply nested/);
    expect(parseSpy).not.toHaveBeenCalled();
    expect(elapsed).toBeLessThan(1000); // was 5,518ms before the fix
    parseSpy.mockRestore();

    // <style/> is subject to the identical openImpliesClose-on-<body> escape
    // (Parser.ts's rule names "script" specifically, but a self-closed
    // <style/> that never gets a real closer has the identical
    // "walkTags treats the rest of the document as hidden" failure mode via
    // the SAME findRawTextEnd call — this pins that the fix covers style
    // too, not just script).
    const parseSpy2 = vi.spyOn(Readability.prototype, 'parse');
    const stylePayload = '<html><head></head><style/><body>' + '<div>'.repeat(N) + '</body></html>';
    const t1 = cpuMs();
    const r2 = await fetchWith(stylePayload, 'https://example.com/style-selfclose-body-escape');
    const elapsed2 = cpuMs() - t1;
    expect(r2.isError).toBeFalsy();
    expect(r2.text).toMatch(/too large or deeply nested/);
    expect(parseSpy2).not.toHaveBeenCalled();
    expect(elapsed2).toBeLessThan(1000);
    parseSpy2.mockRestore();
  });

  it('rejects self-closing non-void tags that stay open per the real HTML parser (no script/style needed) — CRITICAL, round 6', async () => {
    // Broader sibling of the bug above, found while investigating it: ANY
    // self-closing non-void HTML tag (not just script/style) stays open per
    // linkedom's Parser (self-close is ignored outside SVG/MathML foreign
    // context — see Parser.ts's `onselfclosingtag`), but the old
    // tooComplexToExtract exempted EVERY selfClosed non-void tag from the
    // depth count unconditionally, treating it like a void element
    // (<br/>, <img/>). No script/style trick required — plain <div/>
    // repeated is enough. Measured on this machine BEFORE this fix, through
    // WebFetchTool.execute: '<html><body>' + '<div/>'.repeat(700) +
    // 'x</body></html>' (no raw-text tag anywhere in the page) took 2,812ms
    // (guard let it through — maxDepth stayed 0 the whole scan — Readability
    // ran on a document that was genuinely 700 elements deep). Control (same
    // divs, real '</div>' closers): 2-4ms, rejected as normal.
    const parseSpy = vi.spyOn(Readability.prototype, 'parse');
    const N = 700;
    const payload = '<html><body>' + '<div/>'.repeat(N) + 'x</body></html>';
    const t0 = cpuMs();
    const r = await fetchWith(payload, 'https://example.com/div-selfclose-nonvoid');
    const elapsed = cpuMs() - t0;
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/too large or deeply nested/);
    expect(parseSpy).not.toHaveBeenCalled();
    expect(elapsed).toBeLessThan(1000); // was 2,812ms before the fix
    parseSpy.mockRestore();
  });

  it('does not falsely reject ordinary inline SVG icons for the self-closing-tag fix above (no new false positive)', async () => {
    // The fix above only exempts a selfClosed non-void tag from the depth
    // count while inside real <svg>/<math> foreign context (where
    // htmlparser2 DOES honor self-closing) — matching Parser.ts's
    // `foreignContext` check. This proves that carve-out actually works:
    // an article with a small SVG icon (a few self-closing <path>/<circle>
    // shapes, and a larger inline sprite of 120 sibling self-closing
    // <path> elements) must still extract normally, not degrade to the
    // "too large or deeply nested" fallback.
    const parseSpy = vi.spyOn(Readability.prototype, 'parse');
    const article =
      '<html><body><article><h1>Title</h1><p>' + 'Real content. '.repeat(40) + '</p>' +
      '<svg viewBox="0 0 24 24"><path d="M1 2"/><circle cx="1" cy="2" r="3"/><path d="M3 4"/></svg>' +
      '</article></body></html>';
    const r = await fetchWith(article, 'https://example.com/svg-icon-not-rejected');
    expect(r.isError).toBeFalsy();
    expect(r.text).not.toMatch(/too large or deeply nested/);
    expect(r.text).toContain('Title');
    expect(parseSpy).toHaveBeenCalled();
    parseSpy.mockRestore();

    const parseSpy2 = vi.spyOn(Readability.prototype, 'parse');
    const shapes = '<path d="M1 2"/>'.repeat(120);
    const sprite =
      '<html><body><svg style="display:none">' + shapes + '</svg>' +
      '<article><h1>Title</h1><p>' + 'Real content. '.repeat(40) + '</p></article></body></html>';
    const r2 = await fetchWith(sprite, 'https://example.com/svg-sprite-not-rejected');
    expect(r2.isError).toBeFalsy();
    expect(r2.text).not.toMatch(/too large or deeply nested/);
    expect(r2.text).toContain('Title');
    expect(parseSpy2).toHaveBeenCalled();
    parseSpy2.mockRestore();
  });

  // --- round-7 redesign: depth now read off the REAL parsed DOM ------------
  //
  // Every hand-rolled scan from rounds 1-6 estimated depth by walking raw
  // HTML and guessing how the real parser (linkedom -> htmlparser2) would
  // nest it. The two bypasses below are what six rounds of that guessing
  // eventually missed — proof the OLD approach was unfixable, not just
  // unfixed. The redesign (tagCountTooHigh + domTooDeep in web-fetch.ts)
  // deletes the guess entirely: it parses with the SAME parseHTML() call the
  // rest of the pipeline uses and reads depth off that tree, so there is no
  // second implementation left to disagree with the first.

  it('rejects a stray unmatched close tag depth bypass for </span>, </p>, and </br> (CRITICAL, round 7)', async () => {
    // htmlparser2's Parser.onclosetag (Parser.ts) looks up the closing tag's
    // name on its OWN open-element stack via `stack.indexOf(name)` and does
    // NOTHING if it isn't found — only 'p' (implicit open+close) and the void
    // element 'br' (implicit open+close, contributes no real nesting) get
    // special-cased; every other unmatched close (</span> here) is silently
    // ignored. The OLD guard's depth scan decremented on EVERY close tag it
    // saw, matched or not, so `('<div>' + '</span>').repeat(N)` kept its
    // measured depth pinned near 1 (each <div> immediately "closed" by the
    // next </span>) while the REAL DOM nested N divs deep — the </span>s
    // never touch the real open-element stack at all.
    //
    // Measured on this machine through WebFetchTool.execute BEFORE this fix
    // (the round-6 code, i.e. the shipped code this redesign replaces):
    // 7,240 bytes -> 6,106ms; 30KB -> 13,682ms; 60,024 bytes (10,004 '<',
    // comfortably under MAX_TAGS) -> 108,338ms. Control with real '</div>'
    // closers: 1ms, rejected as normal.
    const N = 5002; // 10,004 '<' total (span/p/br child), matches the measured PoC size
    for (const closer of ['</span>', '</p>', '</br>']) {
      const parseSpy = vi.spyOn(Readability.prototype, 'parse');
      const payload = ('<div>' + closer).repeat(N);
      const t0 = cpuMs();
      const r = await fetchWith(payload, `https://example.com/stray-close-${closer.replace(/\W/g, '')}`);
      const elapsed = cpuMs() - t0;
      expect(r.isError).toBeFalsy();
      expect(r.text).toMatch(/too large or deeply nested/);
      expect(parseSpy).not.toHaveBeenCalled();
      expect(elapsed).toBeLessThan(1000); // was up to 108,338ms before this fix
      parseSpy.mockRestore();
    }
  });

  it('rejects deep nesting hidden behind SVG/MathML foreign-content integration points: <foreignObject>, <desc>, <math><mtext> (CRITICAL, round 7)', async () => {
    // The round-6 fix added a foreignDepth counter so a self-closing tag
    // (`<div/>`) is only exempted from the depth count INSIDE real <svg>/
    // <math> content — matching htmlparser2's `foreignContext` check. Its own
    // "KNOWN LIMITATION" comment flagged the gap this test closes: inside a
    // small set of "HTML integration points" (`htmlIntegrationElements` /
    // `mathMLTextIntegrationPoints` in Parser.ts — <foreignObject>, <desc>,
    // <title> under <svg>; <mi>/<mo>/<mn>/<ms>/<mtext>/<annotation-xml> under
    // <math>), htmlparser2 flips back to ORDINARY (non-foreign) self-closing
    // rules mid-subtree — so `<div/>` inside one of these stays OPEN on the
    // real stack exactly like outside any svg/math at all, but the round-6
    // counter still saw foreignDepth > 0 and exempted it, undercounting.
    // Measured on this machine through WebFetchTool.execute BEFORE this fix:
    // <svg><foreignObject> + 800 <div/> (4,820 bytes) -> 7,748ms; the <desc>
    // and <math><mtext> variants below hang the same way. Control (same
    // divs, no svg/math wrapper): rejected in a few ms.
    for (const [label, prefix] of [
      ['foreignObject', '<svg><foreignObject>'],
      ['desc', '<svg><desc>'],
      ['mtext', '<math><mtext>'],
    ] as const) {
      const parseSpy = vi.spyOn(Readability.prototype, 'parse');
      const payload = prefix + '<div/>'.repeat(800);
      const t0 = cpuMs();
      const r = await fetchWith(payload, `https://example.com/foreign-integration-${label}`);
      const elapsed = cpuMs() - t0;
      expect(r.isError).toBeFalsy();
      expect(r.text).toMatch(/too large or deeply nested/);
      expect(parseSpy).not.toHaveBeenCalled();
      expect(elapsed).toBeLessThan(1000); // was 7,748ms (foreignObject case) before this fix
      parseSpy.mockRestore();
    }
  });

  it('recognizes every htmlparser2 tag-name terminator after </script — space, tab, LF, FF, CR — not only an exact ">"', async () => {
    // htmlparser2's stateInSpecialTag terminator set is `c === '>' ||
    // isWhitespace(c)`, and isWhitespace covers space/LF/tab/FF/CR
    // (Tokenizer.js). Depth 200 is past MAX_DEPTH (150), so each of these
    // must be recognized as a real close for the guard to see the <div>s
    // that follow and reject.
    const parseSpy = vi.spyOn(Readability.prototype, 'parse');
    for (const term of [' ', '\t', '\n', '\f', '\r']) {
      const payload = `<script>x</script${term}>${'<div>'.repeat(200)}`;
      const r = await fetchWith(payload, `https://example.com/term-${term.charCodeAt(0)}`);
      expect(r.text).toMatch(/too large or deeply nested/);
    }
    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();
  });

  it('rejects deep nesting hidden behind a <!---> (three-dash abrupt comment) too', async () => {
    // htmlparser2 "allows long sequences" of dashes before the closing '>'
    // (Tokenizer.js comment on stateInCommentLike) — <!---> closes exactly
    // like <!-->, just with one extra dash.
    const parseSpy = vi.spyOn(Readability.prototype, 'parse');
    const payload = '<!--->' + '<div>'.repeat(200);
    const r = await fetchWith(payload, 'https://example.com/comment-3dash');
    expect(r.text).toMatch(/too large or deeply nested/);
    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();
  });

  it('does not let a near-miss "</scripts" inside a script body end the script early (correctness, not just DoS)', async () => {
    // This page is small (well under MAX_TAGS/MAX_DEPTH), so it never reaches
    // the guard-path fallback at all — script stripping here is REAL
    // linkedom parsing (which correctly treats "</scripts" as ordinary script
    // text, not a close: only an exact "</script" whose next char is '>' or
    // whitespace ends the element) followed by Readability's own
    // _removeScripts. Pinned as a regression floor for the round-7 redesign
    // (the guard no longer hand-scans raw HTML at all, so this proves the
    // real parser it now defers to gets this right without any help).
    const article = '<html><head><script>var s = "</scripts are neat";</script></head><body><article><h1>API Guide</h1><p>'
      + 'Real content. '.repeat(40) + '</p></article></body></html>';
    const r = await fetchWith(article, 'https://example.com/near-miss-script-close');
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('API Guide');
    expect(r.text).not.toContain('are neat'); // script source must not leak into the article
  });

  it('does not treat "/" as a </script terminator (fidelity: htmlparser2 excludes it here, unlike an ordinary tag)', async () => {
    // htmlparser2's InSpecialTag terminator check is `c === Gt ||
    // isWhitespace(c)` — no '/' branch (unlike isEndOfTagSection, used for
    // ordinary tag names, which DOES include '/'). So '</script/>' must NOT
    // close the script to linkedom (the real parser the guard now defers to
    // entirely — see the round-7 redesign); the true close a few bytes later
    // is what actually ends it, and content between the two stays (correctly)
    // treated as inert script text on both sides.
    const page = '<html><body><script>var a = 1; //</script/> not real markup</script><article><h1>Real</h1><p>'
      + 'Real content. '.repeat(40) + '</p></article></body></html>';
    const r = await fetchWith(page, 'https://example.com/slash-not-terminator');
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('Real');
    expect(r.text).not.toContain('not real markup'); // stayed inside the script on both sides of the '/>' — never counted or leaked
  });

  it('does not freeze on 5MB of bare "<" characters (guard tag-count pre-check)', async () => {
    // WHY (task requirement): the cheapest possible adversarial shape for the
    // tag-count pre-check itself — pure '<' repeated to the body cap. This
    // pins that the O(n) /</g pre-check (never the quadratic part, but worth
    // a floor test) keeps this instant even at the full 5MB cap.
    const adversarial = '<'.repeat(5 * 1024 * 1024);
    const t0 = cpuMs();
    const r = await fetchWith(adversarial, 'https://example.com/bare-lt');
    const elapsed = cpuMs() - t0;
    expect(typeof r.text).toBe('string');
    expect(elapsed).toBeLessThan(1000);
  });

  it('discloses the fallback char cap when the too-complex page exceeds it (fix: WebFetch declares its body caps)', async () => {
    // The adversarial body above (200,012 chars) is just past FALLBACK_CHAR_CAP
    // (200,000), so the guard-path fallback must say it only scanned a prefix —
    // the fallback exists to give the model something useful, not to silently
    // render an entire multi-megabyte document as plain text.
    //
    // WHY this now asserts on `bounds` (not a regex over hand-written prose):
    // the 200KB scan cap has a genuinely KNOWN total — raw.length, the HTML
    // actually received and scanned — so `bounds.total` must be that real
    // number, not `null` and not a fabricated one.
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

  it('reports the 5MB network cap as separate prose when it fires alongside the 200KB fallback cap (fix: WebFetch declares its body caps)', async () => {
    // Important finding (2026-08-06 review): every OTHER return path appends
    // "[body truncated at 5MB]" when readBodyCapped cut the body short; the
    // too-complex fallback used to skip it, so a 7MB tag-heavy page silently
    // returned a prefix with no sign 2MB+ were discarded — inside the exact
    // code path whose purpose is eliminating silent truncation.
    //
    // WHY this now expects `bounds` to report the 200KB fallback cap, NOT the
    // 5MB network cap, plus a plain-prose disclosure of the 5MB fact: only one
    // `bounds` can ride a result, and the 200KB cap is the one that actually
    // bounds what the model reads here (it's always the tighter of the two —
    // see the WHY comment on `bounds` in web-fetch.ts). The 5MB fact must still
    // be disclosed somewhere, so it stays in `text` as a plain fact rather than
    // advice.
    // Body shaped to (a) exceed 5MB so readBodyCapped truncates it, and (b)
    // still trip the tag-count guard after truncation (repeating tags keep
    // tagCount high throughout).
    const oversized = '<html><body>' + '<div>x</div>'.repeat(500_000); // ~6MB
    __setWebFetchTestHooks({
      lookup: publicLookup,
      fetchImpl: async () => html(oversized),
    });
    const r = await WebFetchTool.execute({ url: 'https://example.com/huge' } as any, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('simplified extraction');
    // sanity: readBodyCapped really did cut it down from the ~6MB source
    expect(r.text.length).toBeLessThan(oversized.length);
    expect(r.bounds).toMatchObject({ shown: 200_000, total: 5 * 1024 * 1024, unit: 'chars' });
    expect(r.text).toContain('cut off at the 5MB fetch cap'); // the 5MB fact, still disclosed
    expect(r.text).not.toContain('[body truncated at 5MB]'); // the retired hand-rolled wording
    expect(r.text).not.toContain('[output truncated: showing'); // the bare no-advice fallback
  });

  it('declares the 5MB body cap via bounds with an unknown total (fix: WebFetch declares its body caps)', async () => {
    // WHY total: null (not raw.length or any other measured number): the
    // server never said how much more there was past MAX_BODY_BYTES —
    // readBodyCapped just stops reading. Reporting a specific total here would
    // be inventing a number nobody measured, the exact dishonesty `bounds`
    // exists to prevent. Uses the non-HTML path (text/plain) so the DOM
    // extraction machinery never gets involved — this test is only about the
    // network body cap.
    //
    // WHY `unit: 'chars'` (not 'bytes') and a whole-line assertion (round 7,
    // 2026-08-06 review): this test used to assert only `unit: 'bytes'` and a
    // SUBSTRING of `r.text` — both true, but they hid a real bug. `raw` is
    // all-ASCII here, so `raw.length` (5,242,880) happens to equal
    // MAX_BODY_BYTES numerically, so the OLD `{ shown: MAX_BODY_BYTES, unit:
    // 'bytes' }` and the FIXED `{ shown: raw.length, unit: 'chars' }` render
    // the same NUMBER — the unit mislabel was invisible to a substring match
    // on this fixture alone. It is not invisible once defineTool's 30,000-char
    // pipeline cap ALSO fires (it always does here — resultText is ~5.24M
    // chars): composeNotice folds both bounds onto one line, and the old code
    // rendered "showing 30007 of <N> chars, and 5242880 BYTES" — two units on
    // one line about the same `text`. Asserting the WHOLE line (not a
    // substring) is what catches that contradiction; derived via the same
    // truncateOutput/composeNotice calls defineTool itself runs, so this
    // doesn't hardcode a number that would silently drift if either changed.
    const oversized = 'a'.repeat(6 * 1024 * 1024); // > MAX_BODY_BYTES (5MB)
    __setWebFetchTestHooks({
      lookup: publicLookup,
      fetchImpl: async () => new Response(oversized, { status: 200, headers: { 'content-type': 'text/plain' } }),
    });
    const r = await WebFetchTool.execute({ url: 'https://example.com/huge.txt' } as any, ctx());
    expect(r.isError).toBeFalsy();
    const moreHint = 'fetch a more specific URL, or a narrower section of the page';
    expect(r.bounds).toEqual({ shown: 5 * 1024 * 1024, total: null, unit: 'chars', moreHint });
    const rawText = `Source: https://example.com/huge.txt\n\n${'a'.repeat(5 * 1024 * 1024)}`;
    const t = truncateOutput(rawText, { maxChars: 30_000 });
    const notice = composeNotice(r.bounds, t.truncated ? { shown: t.text.length, total: t.totalChars } : null, undefined);
    // 2026-09-04: WebFetch output is framed as untrusted content (registry.ts);
    // the frame wraps the CAPPED text and the notice stays outside the tag.
    expect(r.text).toBe(`<untrusted-content source="WebFetch">\n${t.text}\n</untrusted-content>` + notice);
    // composeNotice (truncate.ts, fixed alongside this round's B1 blocker)
    // renders total: null as "more may exist — exact total unknown", never a
    // tautological "N of at least N" (which read as "that's everything") and
    // never a fabricated count.
    expect(r.text).toMatch(/5242880 chars \(more may exist — exact total unknown\)/);
    expect(r.text).not.toMatch(/5242880 bytes/); // the retired, unit-mismatched wording
    expect(r.text).not.toMatch(/at least 5242880/); // the retired tautological wording
    expect(r.text).toContain('fetch a more specific URL'); // real, tool-specific widening advice
    expect(r.text).not.toContain('[body truncated at 5MB]'); // the retired hand-rolled wording
    expect(r.text).not.toContain('[output truncated: showing'); // the bare no-advice fallback
  });

  it('does not claim two different units for the same text on a large non-HTML body (BLOCKER, round 7, CJK unit-mismatch regression)', async () => {
    // WHY this exact shape (round 7, 2026-08-06 review): the ASCII test above
    // can't tell `shown: MAX_BODY_BYTES, unit: 'bytes'` apart from `shown:
    // raw.length, unit: 'chars'` on its own — for all-ASCII input the two
    // numbers coincide. A body of multi-byte characters breaks that
    // coincidence: 2,000,000 repetitions of '你' (3 bytes each in UTF-8) is
    // exactly 6,000,000 bytes, so readBodyCapped's 5,242,880-byte cut lands
    // mid-character and decodes to 1,747,627 UTF-16 units — NOT 5,242,880.
    // The pre-fix code still reported `shown: 5242880 bytes`, so composeNotice
    // rendered (verified against the pre-fix code path directly):
    //   [showing 30007 of 1747664 chars, and 5242880 bytes (more may exist — exact total unknown) — …]
    // — claiming 5,242,880 BYTES shown in the same breath as 30,007 CHARS
    // shown of a 1,747,664-char total, though only 1,747,627 chars of `raw`
    // ever existed to show. The fix reports `shown: raw.length` in `chars`,
    // matching the unit truncateOutput/composeNotice already use for `total`.
    const CJK = '你'; // 3 bytes in UTF-8 ('你')
    const oversized = CJK.repeat(2_000_000); // exactly 6,000,000 bytes
    expect(Buffer.byteLength(oversized, 'utf8')).toBe(6_000_000); // sanity: the premise this test rests on
    __setWebFetchTestHooks({
      lookup: publicLookup,
      fetchImpl: async () => new Response(oversized, { status: 200, headers: { 'content-type': 'text/plain' } }),
    });
    const r = await WebFetchTool.execute({ url: 'https://example.com/huge-cjk.txt' } as any, ctx());
    expect(r.isError).toBeFalsy();
    // The actual decoded length of what readBodyCapped put into `raw` —
    // computed independently of web-fetch.ts's own logic (plain Buffer
    // slice+decode, mirroring readBodyCapped's own implementation) so this
    // isn't just re-asserting whatever the source code happens to compute.
    const decodedRaw = Buffer.from(oversized, 'utf8').subarray(0, 5 * 1024 * 1024).toString('utf8');
    expect(decodedRaw.length).toBe(1_747_627); // pins the premise's own numbers
    expect(r.bounds).toEqual({
      shown: decodedRaw.length,
      total: null,
      unit: 'chars',
      moreHint: 'fetch a more specific URL, or a narrower section of the page',
    });
    // The whole-line, unit-consistency assertion: exactly one unit ("chars")
    // appears in the notice, never two units describing the same `text`.
    const noticeLine = r.text.slice(r.text.lastIndexOf('\n['));
    const unitMentions = noticeLine.match(/\d[\d,]* (chars|bytes)/g) ?? [];
    expect(unitMentions.length).toBeGreaterThan(0);
    expect(unitMentions.every((m) => m.endsWith('chars'))).toBe(true); // never "bytes" alongside "chars"
    expect(r.text).not.toMatch(/5242880 bytes/); // the retired, overstated, wrong-unit claim
  });

  it('does not overstate what was shown when a >5MB HTML body extracts to a short article (fix: BLOCKER B1)', async () => {
    // WHY this exact shape (BLOCKER B1, round 5, 2026-08-06 review): the
    // reviewer's PoC was a 6,000,501-byte page whose real article was a
    // single short paragraph, with the rest plain-text padding. Before this
    // fix, `bounds` claimed `shown: MAX_BODY_BYTES` (5,242,880) regardless
    // of how much survived extraction, so composeNotice rendered "showing
    // 5242880 of at least 5242880 bytes" — telling the model it had seen (at
    // minimum) everything, when in fact only a few hundred characters of
    // markdown came back and hundreds of KB of the page were never even
    // fetched. The padding here is plain text (no tags), so it stays well
    // under MAX_TAGS/MAX_DEPTH and the normal Readability path runs — this
    // is about the HTML/structured-extraction branch, not the too-complex
    // guard-path fallback (which already had this right). Padding lives
    // inside an HTML comment — inert to both the depth/tag guard (a single
    // token, no nested tags) and to Readability (comments never become
    // candidate content, so it reliably still picks the real <article>
    // rather than scoring the padding as "the" content).
    const filler = 'x'.repeat(6_000_000);
    const page = `<html><head><title>Padded</title></head><body><article><h1>Article</h1><p>Short real article.</p></article><!--${filler}--></body></html>`;
    __setWebFetchTestHooks({
      lookup: publicLookup,
      fetchImpl: async () => new Response(page, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    });
    const r = await WebFetchTool.execute({ url: 'https://example.com/padded-article' } as any, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('Short real article.');
    expect(r.bounds).toBeTruthy();
    // sanity: the network fetch really did truncate at 5MB
    expect(r.bounds!.total).toBeNull();
    expect(r.bounds!.unit).toBe('chars');
    // The core B1 assertion: `shown` must describe the ACTUAL text returned
    // (a short article's worth of markdown), never the 5MB network cap.
    expect(r.bounds!.shown).toBeLessThan(10_000);
    // The rendered notice must not be able to read as "we showed you (at
    // least) everything".
    expect(r.text).not.toMatch(/5242880 of (at least )?5242880/);
    expect(r.text).not.toMatch(/showing 5242880/);
    // The 5MB network fact is real information and must still be disclosed,
    // same pattern as the too-complex-extraction branch's own note.
    expect(r.text).toContain('cut off at the 5MB fetch cap');
  });

  // --- html/lower index aliasing in stripToText (Important finding, round
  // 4, 2026-08-06 review) --- an earlier fix removed this aliasing bug from
  // walkTags but stripToText and withoutScriptAndStyle independently carried
  // the same one: each built its own `lower = html.toLowerCase()` and
  // indexed it with offsets computed against `html`'s own length. U+0130
  // ('İ') is the one character in Unicode whose `.toLowerCase()` grows by a
  // UTF-16 unit, so an 'İ' anywhere ahead of a `<script>` tag shifts every
  // later case-fold check by a constant offset.

  it('does not leak script source or drop visible text on an İ-prefixed too-complex fallback (CRITICAL-adjacent honesty regression)', () => {
    // Direct unit test of stripToText (what the guard-path fallback calls).
    // The filler length (79 'x's) is engineered so the shifted offset lands
    // an UNRELATED later '<p>' tag exactly on the shifted-back position of
    // the real "<script" text, misidentifying it as a script open tag whose
    // (nonexistent) closer search then falls through to the end of the
    // string — dropping everything from that '<p>' onward.
    const withIota = 'İ'.repeat(100) + '<script>JUNK</script>' + 'x'.repeat(79) + '<p>DROPME_TEXT_HERE!</p>TAIL_OK';
    const t = stripToText(withIota);
    expect(t).toContain('DROPME_TEXT_HERE');
    expect(t).not.toContain('JUNK');
    // Control: same shape and length, 'q' instead of 'İ' (no UTF-16 expansion
    // on lowercasing) — must already be correct, proving the defect is
    // specific to the aliasing, not the script-stripping logic in general.
    const withQ = 'q'.repeat(100) + '<script>JUNK</script>' + 'x'.repeat(79) + '<p>DROPME_TEXT_HERE!</p>TAIL_OK';
    const control = stripToText(withQ);
    expect(control).toContain('DROPME_TEXT_HERE');
    expect(control).not.toContain('JUNK');
  });

  it('does not leak script source or drop visible text on an İ-prefixed too-complex fallback, end-to-end through execute()', async () => {
    // Same payload, routed through the real too-complex branch (via enough
    // trailing nested <div>s to clear MAX_DEPTH) so this pins the guard-path
    // fallback's actual output, not just the underlying stripToText unit.
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
    // withoutScriptAndStyle carried the same aliasing bug on the OTHER side
    // of looksJsRendered's ratio: a shifted check can fail to recognize a
    // real <script> tag, so its bytes stay IN both the numerator (via
    // stripToText) and the density denominator instead of being stripped —
    // and once one script tag is missed this way, the offset it introduces
    // is silently absorbed (no further drift), but the SAME check fails for
    // every other <script> tag checked against that same fixed offset too,
    // so a page with several script tags loses stripping on effectively all
    // of them, not just one. On the committed vitest-config.html fixture
    // (real page, __VP_HASH_MAP__ + several <script> tags) this is not a
    // contrived edge case: prepending 60 'İ' characters — the sort of prefix
    // an ordinary Turkish-language page could carry (İstanbul, İzmir…) —
    // pushed the measured ratio from 7.18% (correctly flagged, matches the
    // density comment above) to 30.5% under the OLD (aliased) code, clearing
    // the 10% floor and silently turning the disclosure off. Verified this
    // is fixed: same fixture, same 60-'İ' prefix, ratio stays flagged.
    const html = fixture('vitest-config.html');
    expect(looksJsRendered(html)).toBe(true); // baseline, no İ
    expect(looksJsRendered('İ'.repeat(60) + html)).toBe(true); // must stay true
  });

  it('falls back to whole-body markdown when Readability finds no article', async () => {
    // A dashboard/index page with no readable article — Readability returns null,
    // and we must still return SOMETHING structured, never a silent empty result.
    __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => html(
      '<html><head><title>Dashboard</title></head><body><div><a href="/one">One</a><a href="/two">Two</a></div></body></html>',
    ) });
    const r = await WebFetchTool.execute({ url: 'https://example.com/dash' } as any, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('One');
    expect(r.text).toContain('Two');
  });

  // --- empty-extraction honesty (2026-08-10 review, Claim 9 / DeepSeek finding) ---
  //
  // DeepSeek fetched an IntelliJ docs URL and got back "Title: ... " followed by
  // NOTHING — isError: false, no jsNote disclosure (the existing marker+density
  // heuristic didn't fire for that page). DeepSeek's own framing: "I'd prefer a
  // 'here's the first N chars, it was truncated' so I can decide whether to retry,
  // rather than a blank I have to interpret as 'page is JS-rendered'." An empty
  // body is indistinguishable from a genuinely short page AND from a partial
  // failure — three different situations reading identically. These three tests
  // pin that they must now read differently, and that none of them ever assert a
  // cause (e.g. "requires JavaScript") the code hasn't actually established.

  it('says plainly when a page is genuinely short (little content anywhere, not a fetch problem)', async () => {
    // Trivial real page: Readability finds no article (falls back to body
    // innerHTML), and the WHOLE raw page — not just the extraction — carries
    // almost no text. This must read as "this page is just short", not as a
    // failure and not as a JS-rendering guess (there is no marker here at all).
    const r = await fetchWith('<html><body><h1>Hi</h1></body></html>', 'https://example.com/tiny-page');
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/short|mostly-empty/i);
    expect(r.text).not.toMatch(/JavaScript-rendered/i);
    expect(r.text).not.toMatch(/isn't clear why|is not clear why/i);
  });

  it('names the JS-rendered cause and gives a concrete next step when extraction is empty AND the JS-render heuristic fires', async () => {
    // Shaped like the committed JS-shell fixtures (empty #__next root + a
    // __NEXT_DATA__ marker + enough non-script markup to push density under the
    // 10% floor) but with NO real body content anywhere, so Readability (and
    // its whole-body fallback) come back empty. Unlike the plain jsNote
    // disclosure on a partial page, a THIN extraction needs an actual next
    // action, not just "a section may be missing" — the reviewers praised
    // exactly this shape of advice on every other tool in this harness.
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
    // Long <title> text (captured by the raw-text density check, but NEVER
    // fed to Readability/turndown — document.body.innerHTML excludes <head>)
    // paired with an empty <body>. Readability finds nothing, its fallback
    // (body innerHTML) is empty, so extraction is thin — but the raw page
    // plainly carried substantial text (the title), and neither JS_APP_MARKERS
    // nor EMPTY_ROOT appears anywhere, so the existing heuristic correctly
    // stays silent. This is the DeepSeek/IntelliJ shape: the honest answer is
    // "extraction came back empty and it's not clear why" — NEVER "this page
    // requires JavaScript", because nothing here established that.
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
    // vitest-config.html is the committed false-negative-page fixture: it DOES
    // trip looksJsRendered, and normal extraction through it returns a
    // non-trivial amount of markdown (real config-doc content), so this must
    // keep the ORIGINAL "a section may be missing" phrasing, not the new
    // empty-specific wording meant only for a thin extraction.
    const r = await fetchWith(fixture('vitest-config.html'), 'https://example.com/vitest-config-full');
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/JavaScript-rendered/i);
    expect(r.text).toContain('If a section you expected is absent, it is likely rendered client-side.');
  });
});

describe('looksJsRendered', () => {
  it('flags the VitePress page whose content never reaches an HTTP client', () => {
    // 98KB of HTML carrying 5.2KB of text and __VP_HASH_MAP__. Detection here
    // rests on the __VP_HASH_MAP__ marker alone: this fixture's <div id="app">
    // is NOT empty (VitePress hydrates into it, so the raw HTML has real
    // children under it), so EMPTY_ROOT does not match it — verified directly
    // against this fixture (Minor finding, 2026-08-06 review; the old version
    // of this comment claimed "an empty app root", which was never true for
    // this file). A reviewing model asked this page about `include`, got a
    // confident preamble, and concluded the docs do not document it.
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
    // Important finding (2026-08-06 review): stripToText already excludes
    // <script> bodies from the NUMERATOR, but the OLD denominator was raw
    // html.length, which still counted them — so a routine Next.js-style
    // __NEXT_DATA__ hydration blob could deflate density below the floor even
    // though every word of visible prose is present and server-rendered. This
    // simulates exactly that: full article content plus a large, normal
    // hydration blob. Measured: 7.31% under the old (buggy) denominator —
    // which WOULD have been flagged — vs 89.29% under the fixed one.
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
    // id="include" appears nowhere in the 98KB. This is the exact case that
    // produced a confident false negative in the 2026-08-01 review.
    expect(resolveFragment(html, '## Config Options\n\ntext', 'include').kind).toBe('absent');
  });

  it('reports a fragment present in the HTML but missing from the extraction', () => {
    expect(resolveFragment(html, '# Nothing relevant here', 'config-options').kind).toBe('dropped');
  });

  it('returns the section when the fragment survived extraction', () => {
    // Heading text carries a trailing anchor link in VitePress output
    // (`## Config Options [​](#config-options)`), so matching MUST go through the
    // anchor href, not a slug of the heading text. Verified 2026-08-06.
    const md = '## Intro\n\nfirst\n\n## Config Options [​](#config-options)\n\nthe body\n\n## After\n\nlast';
    const r = resolveFragment(html, md, 'config-options');
    expect(r.kind).toBe('found');
    if (r.kind === 'found') {
      expect(r.section).toContain('the body');
      expect(r.section).not.toContain('last');
      expect(r.exactCase).toBe(true);
    }
  });

  // --- broadened anchor-form scan (Important finding, 2026-08-06 review) ---
  // The old scan was /\sid="([^"]+)"/gi — double-quoted only, so single-quoted
  // id='x', unquoted id=x, and legacy <a name="x"> all missed silently, and
  // the resulting `absent` was reported to the model as a categorical "this
  // anchor does not exist". These pin the broadened scan against each form.

  it('finds a single-quoted id', () => {
    const page = "<html><body><h2 id='alpha'>Alpha</h2></body></html>";
    expect(resolveFragment(page, '## Alpha', 'alpha').kind).not.toBe('absent');
  });

  it('finds an unquoted id', () => {
    const page = '<html><body><h2 id=beta>Beta</h2></body></html>';
    expect(resolveFragment(page, '## Beta', 'beta').kind).not.toBe('absent');
  });

  it('finds a legacy <a name="..."> anchor', () => {
    const page = '<html><body><a name="gamma"></a><h2>Gamma</h2></body></html>';
    expect(resolveFragment(page, '## Gamma', 'gamma').kind).not.toBe('absent');
  });

  // --- case sensitivity (Minor finding, 2026-08-06 review) ---
  // HTML id is case-sensitive; the old code lowercased both sides
  // unconditionally, so "#Foo" could falsely resolve against id="foo".

  it('matches an id exactly by case, and does not treat different-case ids as a match by default', () => {
    const page = '<html><body><h2 id="Foo">Foo</h2><h2 id="foo">also foo</h2></body></html>';
    const r = resolveFragment(page, '## Foo', 'Foo');
    expect(r.kind).toBe('found');
    if (r.kind === 'found') expect(r.exactCase).toBe(true);
  });

  it('falls back to a case-insensitive match and reports it as such', () => {
    const page = '<html><body><h2 id="Foo">Foo</h2></body></html>';
    const r = resolveFragment(page, '## Foo', 'foo'); // requested lowercase, served id is "Foo"
    expect(r.kind).toBe('found');
    if (r.kind === 'found') expect(r.exactCase).toBe(false);
  });

  // --- uppercase/mixed-case ATTRIBUTE NAME (Important finding, round 4,
  // 2026-08-06 review) --- linkedom, unlike a conforming HTML parser, does
  // not ASCII-lowercase attribute NAMES. `getElementById`/`[id]`/`a[name]`
  // all match against the literal name "id"/"name", so `<h2 ID="x">` and
  // `<a NAME="x">` were invisible to every probe and reported a fabricated
  // "no anchor named x" for an anchor that genuinely exists. Verified
  // directly against linkedom: parsing `<h2 ID="upattr">` gives
  // `document.querySelectorAll('[id]').length === 0`.

  it('resolves an id whose ATTRIBUTE NAME is uppercase (<h2 ID="upattr">)', () => {
    const page = '<html><body><h2 ID="upattr">Section Title</h2></body></html>';
    expect(resolveFragment(page, '## Section Title', 'upattr').kind).not.toBe('absent');
  });

  it('resolves a legacy anchor whose ATTRIBUTE NAME is uppercase (<a NAME="legacyU">)', () => {
    const page = '<html><body><a NAME="legacyU"></a><h2>Legacy</h2></body></html>';
    expect(resolveFragment(page, '## Legacy', 'legacyU').kind).not.toBe('absent');
  });

  // --- truncation-aware wording (Important finding, 2026-08-06 review) ---
  // `absent` used to be a flat "this anchor does not exist" regardless of
  // whether the body was cut off at the 5MB cap — a categorical claim about
  // bytes that, when truncated, were never read.

  it('reports bodyTruncated: false when the full document was examined', () => {
    const r = resolveFragment('<html><body>no anchors here</body></html>', '', 'missing');
    expect(r).toEqual({ kind: 'absent', bodyTruncated: false });
  });

  it('reports bodyTruncated: true when the caller says the body was cut off', () => {
    const r = resolveFragment('<html><body>no anchors here</body></html>', '', 'missing', true);
    expect(r).toEqual({ kind: 'absent', bodyTruncated: true });
  });

  it('resolves quickly against thousands of <a> tags with no name= (regression floor, was ANCHOR_NAME_RE)', () => {
    // WHY this shape is still pinned (round 3): the ORIGINAL defect here was
    // ANCHOR_NAME_RE, a hand-rolled regex that retried at every <a lacking
    // name=, each retry re-scanning forward — 9,810ms on a comparable 5.14MB
    // body vs 59ms with no fragment. That regex is long gone (fragment
    // resolution is DOM-based now — see findAnchor in web-fetch.ts), but this
    // test stays as a floor: linkedom's real parse + querySelectorAll over
    // thousands of real <a> elements must ALSO stay well under a second, or a
    // future change could reintroduce a slow path here.
    const unit = '<a href="#">' + 'x'.repeat(660) + '</a>';
    const body = '<html><body>' + unit.repeat(7000) + '</body></html>';
    const t0 = cpuMs();
    const r = resolveFragment(body, '# nothing relevant', 'section');
    const elapsed = cpuMs() - t0;
    expect(r.kind).toBe('absent');
    expect(elapsed).toBeLessThan(1000); // was ~9,810ms with the old regex before the original fix
  });

  // --- DOM-based fragment resolution (design change, round 3, 2026-08-06) ---
  // Fragment resolution no longer hand-scans raw HTML at all: it queries the
  // SAME linkedom document htmlToMarkdown builds for Readability (see
  // findAnchor in web-fetch.ts). These pin the findings that motivated the
  // switch — cases where the old hand-rolled scan (walkTags + parseAttrs)
  // was demonstrably wrong, all fixed for free by asking a real parser.

  it('finds an id on a <script> element\'s own opening tag (IMPORTANT — script/style attrs were discarded)', () => {
    // On the committed vitest-config.html, id="check-dark-mode" and
    // id="check-mac-os" live on <script id="..."> elements. The old walkTags
    // `continue`d past script/style tags WITHOUT calling onTag, discarding
    // the opening tag's own attributes along with its body — so the
    // collector found only 10 of the fixture's 12 ids and WebFetch reported
    // "the HTML contains no anchor named check-dark-mode" about an id that
    // genuinely exists. linkedom parses a <script id="..."> element's
    // attributes like any other element, so this is fixed for free.
    const r = resolveFragment(html, '# irrelevant heading', 'check-dark-mode');
    expect(r.kind).not.toBe('absent');
  });

  it('the WebFetchTool pipeline no longer falsely denies an id that lives on a <script> tag', async () => {
    // End-to-end version of the case above, through the exact code path the
    // finding described: fetching vitest.dev/config/#check-dark-mode used to
    // emit a categorical "the HTML served for this URL contains no anchor
    // named check-dark-mode" — false, since the id exists (just not as a
    // markdown heading, so the honest verdict is "dropped", not "absent").
    // NOTE: uses fetchWith (module-scope `html` Response-builder), not the
    // bare `html` identifier — this describe block shadows it with the
    // fixture string above.
    const r = await fetchWith(html, 'https://example.com/config#check-dark-mode');
    expect(r.isError).toBeFalsy();
    expect(r.text).not.toMatch(/contains no anchor named/);
  });

  it('finds an id past a `>` inside a different attribute\'s quoted value (IMPORTANT — old scan truncated the tag)', () => {
    // <a title="a>b" id="realid"> and a sibling with an onclick handler
    // containing `>` both lost every attribute after the stray `>` under the
    // old hand-rolled tag walker (it took the first `>` as the tag's end,
    // full stop). Both are legal HTML5. linkedom's real parser tracks quote
    // state, so this is fixed for free.
    const page = '<html><body><a title="a>b" id="realid"></a><div onclick="if(a>b)f()" id="clickid"></div></body></html>';
    expect(resolveFragment(page, '# irrelevant', 'realid').kind).not.toBe('absent');
    expect(resolveFragment(page, '# irrelevant', 'clickid').kind).not.toBe('absent');
  });

  it('does NOT fabricate an anchor from an id inside a <textarea> (MINOR — raw-text elements)', () => {
    // <textarea>, <title>, and <xmp> are raw-text elements: their content is
    // never parsed as child elements by a real browser or by linkedom, even
    // though it's tag-shaped text. The old walkTags only special-cased
    // script/style, so `<textarea><a id="tafake"></textarea>` produced a
    // fabricated "the page has an anchor named tafake, but extraction didn't
    // keep it" for an id that was never a real element. Realistic vector:
    // any page that echoes user-submitted markup into a form field.
    const page = '<html><body><textarea><a id="tafake"></textarea></body></html>';
    expect(resolveFragment(page, '# irrelevant', 'tafake').kind).toBe('absent');
  });

  it('re-measures the id count with the collector itself, not grep (round-2 process note)', () => {
    // The round-2 report claimed collector/HTML parity by running
    // `grep -o 'id="[^"]*"' | wc -l`, which measures grep, not the collector
    // that changed. Fragment resolution's "collector" as of round 3 is
    // linkedom's own parsed DOM (the same one WebFetch queries via
    // findAnchor) — so the correct re-measurement queries THAT, and then
    // proves every id it finds actually resolves through the exported
    // resolveFragment, not just that the counts happen to match.
    const { document } = parseHTML(html);
    const ids = new Set<string>();
    for (const el of document.querySelectorAll('[id]')) {
      const id = el.getAttribute('id');
      if (id) ids.add(id);
    }
    expect(ids.size).toBe(12); // grep -o 'id="[^"]*"' tests/fixtures/web/vitest-config.html | sort -u | wc -l
    for (const id of ids) {
      expect(resolveFragment(html, '# irrelevant heading', id).kind).not.toBe('absent');
    }
  });

  // --- false-anchor scoping (Important finding, 2026-08-06 re-review) ---
  // The old \bid\s*= regex matched id= as a bare substring anywhere in the raw
  // HTML, so each of these produced a fabricated anchor that flipped a correct
  // `absent` verdict into a false `dropped` claim ("the page has an anchor
  // named X, but extraction did not keep that section"). Each must report
  // `absent`, never `dropped` — dropped means "id= was really matched but the
  // section vanished during extraction", which is not what happened here.

  it('does not treat data-id= as a real anchor id', () => {
    const page = '<html><body><div data-id="ghost">text</div></body></html>';
    expect(resolveFragment(page, '# Nothing relevant', 'ghost').kind).toBe('absent');
  });

  it('does not treat an id= inside a different attribute\'s value (href query string) as a real anchor id', () => {
    const page = '<html><body><a href="/page?id=42">link</a></body></html>';
    expect(resolveFragment(page, '# Nothing relevant', '42').kind).toBe('absent');
  });

  it('does not treat id= assigned inside a <script> body as a real anchor id', () => {
    const page = '<html><body><script>el.id = "jsassigned"; var s = "id=leaked";</script></body></html>';
    expect(resolveFragment(page, '# Nothing relevant', 'jsassigned').kind).toBe('absent');
  });

  it('does not treat id= written inside an HTML comment as a real anchor id', () => {
    const page = '<html><body><!-- id="commented" --><p>text</p></body></html>';
    expect(resolveFragment(page, '# Nothing relevant', 'commented').kind).toBe('absent');
  });
});
