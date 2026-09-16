// WebFetch (spec §3.1): guardedFetch → Readability extraction → Markdown →
// shared truncation. Input shape {url} — the existing WebFetchView renders the
// result unchanged (it markdown-renders the result string).
// DESIGN (plan decision 9): no secondary summarization model — the result IS
// the extracted markdown. D-6 (2026-08-26 tools investigation): the CC-shaped
// `prompt` parameter was DROPPED — it was only ever echoed back as a
// "Fetched for:" header, which invited the model to expect an answer that
// never came. (The renderer still tolerates `prompt` on Claude Code sessions.)
// DOM provider is linkedom (NOT domino/jsdom) — Task 1 verified readability
// 0.6.0 breaks on domino's non-iterable NodeLists.
import { z } from 'zod';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
// turndown ships no bundled types and @types/turndown isn't a dependency in this
// repo — suppress the implicit-any import here rather than add a shared
// devDependency or a new .d.ts file (plan: type accommodations stay in MY files
// only). linkedom and @mozilla/readability both ship their own types.
// Tried @ts-expect-error (the self-cleaning choice) first, but under THIS repo's
// tsconfig tsc does NOT error on the turndown import — turndown resolves to a .js
// with no adjacent .d.ts and skipLibCheck is on — so @ts-expect-error itself trips
// TS2578 "unused directive" and breaks the build. Reverted to @ts-ignore per that
// empirical outcome; it stays a defensive suppressor if the resolution ever changes.
// @ts-ignore -- no type declarations for 'turndown'
import TurndownService from 'turndown';
import { defineTool } from './registry';
import { guardedFetch, readBodyCapped, NetGuardError, type GuardedFetchOpts } from './net-guard';
import type { ToolResultPayload } from './types';

const MAX_BODY_BYTES = 5 * 1024 * 1024;

// Test seam: unit tests inject lookup/fetch; production uses the real ones.
let testHooks: Pick<GuardedFetchOpts, 'lookup' | 'fetchImpl'> = {};
export function __setWebFetchTestHooks(h: typeof testHooks): void { testHooks = h; }

const inputSchema = z.object({
  url: z.string().describe('The URL to fetch (http/https only)'),
}).strict(); // .strict(): an unknown parameter is an error the model can fix, never silently dropped (ledger D-2)

const TEXT_TYPES = /^(text\/(plain|markdown|csv|xml)|application\/(json|xml|rss\+xml|atom\+xml))/;

// --- Pre-parse complexity guard (CRITICAL: main-thread DoS defense) ----------
// htmlToMarkdown() runs parseHTML → Readability.parse() → turndown ALL
// SYNCHRONOUSLY on the Electron MAIN event loop (NativeSessionHost executes tools
// on the main loop — there is no worker offload). Readability.parse() is roughly
// QUADRATIC in DOM nesting depth, so a small but pathological page freezes EVERY
// window, all IPC, and the live session for tens of seconds. Measured on this
// machine: 150-deep divs ~0.4s, 200-deep ~1.1s, 400-deep ~4.1s, 1000-deep ~53s;
// ~15k tags ~0.6s, ~120k tags ~5s. The 5MB byte cap does NOT bound this — parse
// cost scales with DOM STRUCTURE (depth/tag-count), not byte length (a 54KB file
// can hang for seconds). And defineTool's try/catch CANNOT save us: a synchronous
// hang never throws, so nothing unwinds.
//
// REDESIGN (round 7, 2026-08-06): six prior rounds each replaced this guard's
// depth estimate with a more-faithful hand-rolled re-implementation of the
// state machine the REAL parser (linkedom → htmlparser2) runs on raw HTML —
// and each round's fix was itself later found to disagree with that real
// parser in a NEW way (a close tag the real tokenizer ignores but the old
// scan counted as a close; a self-closing tag honored only inside SVG/MathML
// foreign content; a foreign-content INTEGRATION POINT like <foreignObject>/
// <desc>/<mtext> where self-closing flips back to ordinary HTML rules mid-
// subtree). Predicting the parser had a 0-for-7 track record across those
// rounds. This round stops predicting it and asks it directly: parse the page
// with the SAME parseHTML() call the rest of this file already needs, then
// measure depth by walking the REAL tree that call built. A depth figure read
// off the tree Readability is about to traverse cannot disagree with that
// tree — the entire bypass class is retired structurally, not patched again.
//
// Verified this is affordable BEFORE building on it (measured on this
// machine, Node v26.4.0):
//   payload                                          parseHTML    Readability.parse
//   60,024B / 10,004 stray-close '<div></span>' pairs   ~90ms      18,825.6ms (never reached — domTooDeep rejects first)
//   4,820B  <svg><foreignObject> + 800 <div/>             6.5ms     never reached — domTooDeep rejects first
//   5,242,880B bare '<' (no real tags anywhere)        5,425.9ms    never reached — tagCountTooHigh rejects BEFORE parseHTML runs
//   167,450B realistic catalog page (12,272 tags, depth
//     125 — legitimately UNDER both caps, must pass)      47.8ms       225.2ms
// parseHTML is consistently the cheap half — tens to low hundreds of ms, even
// on the adversarial shapes — against Readability's seconds-to-tens-of-
// seconds on the same input. The one shape where parseHTML itself got
// expensive (5MB of bare '<', 5.4s) never reaches parseHTML at all: it is
// caught by the byte-count pre-check below, which runs BEFORE any parse is
// attempted (see tagCountTooHigh's own WHY comment for why that ordering is
// load-bearing, not incidental). Full numbers, every payload checked, and the
// commands that produced them: see the fix commit's report
// (final-fix-guard-redesign-report.md).
//
// Two-stage guard, in this order:
//   1. tagCountTooHigh(rawHtml) — O(n) over raw bytes, runs BEFORE any parse.
//      Can only OVER-count (every real tag needs a literal '<', but not every
//      '<' becomes a real tag), so it can reject breadth the parser would
//      have tolerated but can never fail to reject breadth the parser will
//      actually build — same pre-check as before this round, unchanged.
//   2. domTooDeep(document) — walks the ACTUAL parsed tree. Only reached once
//      stage 1 has already bounded the input to something parseHTML can
//      afford (see the split above).
// Thresholds are unchanged by this redesign — still far above real articles
// (which nest ~8-60 and carry a few thousand tags).
//
// CORRECTION (Minor finding, round 4, 2026-08-06 review — still true after
// this redesign): a page that PASSES the guard is NOT promised to stay under
// any particular parse time. Measured: a page of 145-deep nesting x 50
// sibling blocks (14,504 '<', max depth 147 — comfortably clearing both
// MAX_DEPTH and MAX_TAGS) took 1,617ms through execute() in the review that
// found this; a same-shaped construction re-measured 220-275ms on a different
// machine. This guard bounds Readability's WORST case (pathological
// structure), not its typical-case runtime, and clearing MAX_DEPTH/MAX_TAGS
// is not a bound on wall-clock time. Do not add a number back here that a
// reader could rely on as a promise.
const MAX_DEPTH = 150;
const MAX_TAGS = 15_000;

/** Case-insensitive indexOf for a short, fixed, ASCII-only needle (the
 *  script/style closing tags below), WITHOUT allocating a lowercased copy of
 *  the whole haystack.
 *
 *  WHY this exists (CRITICAL, 2026-08-06 round-3 review): walkTags used to
 *  build one `lower = html.toLowerCase()` up front and index it with cursors
 *  computed against `html`'s own length. That is only safe if lowercasing
 *  never changes a string's length, which is false for some codepoints —
 *  `'İ'.toLowerCase()` (U+0130) is TWO UTF-16 units ('i' + a combining dot).
 *  Payload: a comment body of 200,000 'İ' characters. `lower.length` ends up
 *  200,000 code units longer than `html.length`, so the comment-close search
 *  — done against `lower` — finds `-->` at an index that overshoots the SAME
 *  position in `html` by 200,000 characters, and `i = lower.indexOf(...) + 3`
 *  fed that overshot index straight back into the `html` cursor. A 1,000-deep
 *  `<div>` nest placed right after the comment was skipped over entirely, so
 *  the guard measured depth < 150 (safe), Readability ran on a document that
 *  was ACTUALLY 1,000 deep, and WebFetchTool.execute blocked the main loop
 *  for 8,376ms. Measured at the commit before this fix (e1eee255^): the same
 *  payload was rejected by the guard in 3ms with Readability never called —
 *  see "does not freeze on comment bodies containing surrogate-expanding
 *  lowercase folds" in web-fetch-tool.test.ts for the pinned numbers.
 *
 *  The fix removes the aliasing at the root: there is only ever ONE string
 *  (`html`) and one index space. Where a case-insensitive comparison is
 *  still needed (script/style tag names, their closing tags), it is done
 *  either by folding a small BOUNDED slice (a tag name, a handful of
 *  characters — see the `name` assignment below, whose result is used only
 *  for value comparisons, never as a source of offsets into `html`) or, for
 *  the closer search below, by folding one ASCII character at a time as the
 *  comparison runs, so no second string of a different length is ever built.
 *
 *  CORRECTION (round 4, 2026-08-06 review): the paragraph above describes
 *  walkTags, which this function was written for and which never had a
 *  second bug. walkTags itself was deleted in the round-7 redesign (the
 *  depth guard now reads the real parser's own tree instead of hand-scanning
 *  raw HTML — see tagCountTooHigh/domTooDeep above), but indexOfFold stays
 *  load-bearing: stripToText and withoutScriptAndStyle further down this
 *  file each still built their OWN `lower = html.toLowerCase()` and indexed
 *  it with `html`-cursor offsets — the identical aliasing bug, independently
 *  introduced, just not yet caught. "There is only ever ONE string" was true
 *  of walkTags but false of the file as a whole until this round: a
 *  100-character 'İ' prefix ahead of a `<script>` tag made the guard-path
 *  fallback silently drop real visible text (and leak the script's own
 *  source) in one measured case, and separately let 60 leading 'İ'
 *  characters turn off the JS-rendered-page disclosure on an otherwise
 *  ordinary Next.js-shaped shell. Both are now fixed using this exact same
 *  technique (see foldStartsWith below), so the claim is file-wide and
 *  accurate again — see stripToText's and withoutScriptAndStyle's own WHY
 *  comments for the specific measurements. */
function indexOfFold(haystack: string, needle: string, from: number): number {
  const hn = haystack.length, nn = needle.length;
  outer: for (let i = from; i + nn <= hn; i++) {
    for (let j = 0; j < nn; j++) {
      const a = haystack.charCodeAt(i + j);
      const b = needle.charCodeAt(j); // needle is always already-lowercase ASCII
      if (a === b) continue;
      const folded = a >= 65 && a <= 90 ? a + 32 : a; // fold ASCII A-Z to a-z only
      if (folded !== b) continue outer;
    }
    return i;
  }
  return -1;
}

/** Case-insensitive startsWith for a short, fixed, ASCII needle at a known
 *  position, using the exact same bounded-fold technique as indexOfFold
 *  above (and for the same reason — see its WHY comment). Exists so
 *  stripToText and withoutScriptAndStyle below never need to build a
 *  document-length lowercased copy either; see their WHY comments. */
function foldStartsWith(haystack: string, needle: string, at: number): boolean {
  const nn = needle.length;
  if (at + nn > haystack.length) return false;
  for (let j = 0; j < nn; j++) {
    const a = haystack.charCodeAt(at + j);
    const b = needle.charCodeAt(j); // needle is always already-lowercase ASCII
    if (a === b) continue;
    const folded = a >= 65 && a <= 90 ? a + 32 : a;
    if (folded !== b) return false;
  }
  return true;
}

/** Cheap O(n) rejection of a page whose raw '<' count alone already exceeds
 *  MAX_TAGS. The ONLY check that runs BEFORE parseHTML is attempted — see the
 *  file-level WHY block above for the measured split that makes this
 *  ordering load-bearing (parseHTML itself is not free on every shape: 5MB of
 *  bare '<' took 5,425.9ms inside parseHTML alone, so this must reject that
 *  shape without ever calling it).
 *
 *  Counts every '<' in the raw string — text-node '<', comments, attribute
 *  values, all of it — a deliberate over-approximation. That direction is
 *  the only one that's safe: a real element the parser goes on to build
 *  always consumed exactly one literal '<' in the source, so the parser can
 *  never produce MORE real tags than this count. This can reject breadth the
 *  parser would have tolerated, but can never fail to reject breadth the
 *  parser will actually build — unchanged from the pre-redesign version of
 *  this check, still a single literal-character scan with no backtracking
 *  risk, still O(n) regardless of content shape. */
function tagCountTooHigh(rawHtml: string): boolean {
  return (rawHtml.match(/</g) || []).length > MAX_TAGS;
}

/** True when the ACTUAL parsed DOM nests an element deeper than MAX_DEPTH —
 *  read off the same tree parseHTML() built for the rest of the pipeline
 *  (execute() passes in the one document it already parsed; this never
 *  re-parses). See the file-level WHY block above for why this replaces
 *  seven rounds of hand-rolled raw-HTML scanning: a depth figure read off
 *  the tree Readability is about to traverse cannot disagree with that tree.
 *
 *  Bonus of asking the real parser instead of predicting it: void elements
 *  (`<br>`, `<img>`, …) and self-closing-tag/foreign-content rules (SVG vs.
 *  HTML, integration points like `<foreignObject>`) no longer need ANY
 *  special-casing here — a real parser never gives a void element children,
 *  and correctly toggles self-closing behavior at foreign-content
 *  boundaries, so whatever tree it built already reflects both rules for
 *  free. Verified directly: `parseHTML('<div><br><span>x</span></div>')`
 *  gives `<br>` zero children (span is BR's sibling inside div, not its
 *  child) with no code here asking for that.
 *
 *  WHY the walk starts at `document.children`, not `document.documentElement`
 *  (found while building this redesign, 2026-08-06): malformed or unwrapped
 *  input (no `<html>` root) parses with sibling top-level nodes that are NOT
 *  descendants of documentElement in linkedom's tree — verified directly:
 *  `parseHTML('<script>x</script >' + '<div>'.repeat(20))` puts the 20 divs
 *  as a SEPARATE top-level child of `document`, sibling to the `<script>`,
 *  with `document.body` staying EMPTY. A walk rooted at documentElement (an
 *  earlier draft of this function) missed that div chain entirely — it
 *  measured depth 1 for a tree that was actually 20+ deep. `document.children`
 *  enumerates every top-level node, so nothing reachable by Readability's own
 *  document-wide passes (`_getAllNodesWithTag(doc, …)` in Readability.js
 *  walks the whole document, not just documentElement) can hide from this
 *  walk either.
 *
 *  Iterative with an explicit stack, not recursive: a document nested tens of
 *  thousands deep — exactly the shape this guard exists to catch — would
 *  blow the call stack in a recursive walk before MAX_DEPTH's own check does
 *  anything useful (verified against a 10,004-deep tree without incident).
 *  Exits the instant depth clears MAX_DEPTH rather than finishing a walk over
 *  a document it has already decided to reject. */
function domTooDeep(document: Document): boolean {
  const stack: Array<{ el: Element; depth: number }> = [];
  for (const el of Array.from(document.children) as Element[]) stack.push({ el, depth: 1 });
  while (stack.length) {
    const { el, depth } = stack.pop()!;
    if (depth > MAX_DEPTH) return true;
    for (const child of Array.from(el.children) as Element[]) stack.push({ el: child, depth: depth + 1 });
  }
  return false;
}

/** Tag-strip to readable text — the guard-path fallback that runs on EXACTLY
 *  the input tagCountTooHigh()/domTooDeep() just rejected (see execute()
 *  below), so it must not reintroduce the freeze the guard exists to
 *  prevent.
 *
 *  WHY this is a hand-written scan and not a regex (CRITICAL, 2026-08-06
 *  review): the previous implementation used /<[^>]*>/g and
 *  /<script[\s\S]*?<\/script>/gi and its comment claimed this was O(n). That
 *  claim was never measured and is false: both regexes backtrack — when a '<'
 *  or '<script' is never followed by its terminator, the engine retries the
 *  match starting at every subsequent character, each retry re-scanning to the
 *  end of the string. Measured on this machine: /<[^>]*>/g against a run of
 *  200,000 unterminated '<' characters (200KB — far under the 5MB body cap)
 *  took 12,194ms. That exact shape (many '<' with no '>') is what makes
 *  tagCountTooHigh() reject a page in the first place (it counts every '<',
 *  matched or not) — so the "safe" fallback was reopening precisely the
 *  main-thread freeze the guard exists to prevent.
 *
 *  This scan is linear BY CONSTRUCTION rather than by claim: cursor `i` only
 *  ever moves forward, and every indexOf()/startsWith() lookahead begins where
 *  the previous one finished, so the ranges scanned across the whole call
 *  never overlap — total work is bounded by one pass over `html` regardless of
 *  content shape. Concretely, an unterminated tag or script/style block is
 *  handled by jumping straight to the end of the string ONCE, never retried
 *  character-by-character. Measured on the same 200,000-char adversarial
 *  input this replaces: see "does not freeze on 200,000 unterminated '<'
 *  characters" in tests/web-fetch-tool.test.ts for the pinned number.
 *
 *  WHY there is no `lower = html.toLowerCase()` here (Important finding,
 *  round 4, 2026-08-06 review): an earlier version of this function built
 *  exactly that, then indexed it with offsets computed against `html`'s own
 *  length — the same html/lower index-aliasing bug indexOfFold's comment
 *  above documents for walkTags, independently reintroduced here. `'İ'`
 *  (U+0130) is the ONE character in Unicode whose `.toLowerCase()` grows by
 *  a UTF-16 unit ('i' + a combining dot), so a document with an 'İ' anywhere
 *  ahead of a `<script>`/`<style>` tag shifted every check after it by a
 *  constant offset. Measured, with the offset shifted by exactly 100 (a
 *  100-character 'İ' prefix): `'İ'.repeat(100) + '<script>JUNK</script>' +
 *  'x'.repeat(79) + '<p>DROPME_TEXT_HERE!</p>TAIL_OK'` returned text
 *  containing "JUNK" (the script body leaked as visible prose, because the
 *  shifted check failed to recognize the REAL `<script>` tag as one, so its
 *  body was walked as ordinary markup) and — because that same shift then
 *  made an UNRELATED later `<p>` tag land exactly on the shifted-back
 *  position of the real "<script" text and get misidentified AS a script
 *  open tag, whose "closer" search then found nothing and fell through to
 *  `n` — dropped every character from that `<p>` onward, silently deleting
 *  "DROPME_TEXT_HERE" and "TAIL_OK" both. The identical input with 'İ'
 *  replaced by 'q' (same length, no expansion) is correct on both counts.
 *  Fixed the same way as walkTags: fold only the bounded needle
 *  ("<script"/"<style"/their closers) via foldStartsWith/indexOfFold, never
 *  the whole document — see "does not leak script source or drop visible
 *  text on an İ-prefixed too-complex fallback" in web-fetch-tool.test.ts. */
export function stripToText(html: string): string {
  const n = html.length;
  const parts: string[] = [];
  let i = 0;
  let textStart = 0;
  while (i < n) {
    if (html.charCodeAt(i) !== 60 /* '<' */) { i++; continue; }
    if (i > textStart) parts.push(html.slice(textStart, i));
    const isScript = foldStartsWith(html, '<script', i);
    if (isScript || foldStartsWith(html, '<style', i)) {
      const closer = isScript ? '</script>' : '</style>';
      const closeIdx = indexOfFold(html, closer, i);
      // Not found: treat the rest of the document as inside this block and
      // stop — do NOT retry the search from i+1, which is what made the old
      // regex quadratic on input shaped like this.
      i = closeIdx === -1 ? n : closeIdx + closer.length;
    } else {
      const gt = html.indexOf('>', i);
      // Unterminated tag: drop everything after it rather than re-scanning
      // for a '>' that will never arrive.
      i = gt === -1 ? n : gt + 1;
    }
    parts.push(' ');
    textStart = i;
  }
  if (n > textStart) parts.push(html.slice(textStart, n));
  return parts.join('')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Same script/style removal as stripToText's first phase, but keeps every
 *  other byte (including other markup) instead of collapsing it to text. Used
 *  only to build a comparable denominator for looksJsRendered's density check
 *  below — see that function's WHY comment. Uses the same monotonic-cursor
 *  technique as stripToText above, for the same reason: linear regardless of
 *  content shape.
 *
 *  WHY there is no `lower = html.toLowerCase()` here either (Important
 *  finding, round 4, 2026-08-06 review): this function carried the identical
 *  html/lower index-aliasing bug as the old stripToText — see stripToText's
 *  WHY comment for the mechanism. Here the consequence was on the OTHER side
 *  of looksJsRendered's ratio: the aliasing could make this function fail to
 *  recognize a real `<script>` tag as one (same shifted-check failure), so
 *  its bytes stayed IN the returned string, inflating the density
 *  denominator and pushing the ratio down. Measured: a Next.js-shaped shell
 *  (`<div id="__next"></div>` + a `__NEXT_DATA__`-bearing `<script>`) that
 *  correctly reports `looksJsRendered === true` flipped to `false` once 60
 *  'İ' characters were placed before the `<script>` tag — meaning ordinary
 *  Turkish-language pages (İstanbul, İzmir…) could silently lose the
 *  JS-rendered disclosure, not just adversarial input. Fixed with the same
 *  foldStartsWith/indexOfFold technique as stripToText. */
function withoutScriptAndStyle(html: string): string {
  const n = html.length;
  const parts: string[] = [];
  let i = 0;
  let textStart = 0;
  while (i < n) {
    const isTag = html.charCodeAt(i) === 60 && (foldStartsWith(html, '<script', i) || foldStartsWith(html, '<style', i));
    if (!isTag) { i++; continue; }
    if (i > textStart) parts.push(html.slice(textStart, i));
    const closer = foldStartsWith(html, '<script', i) ? '</script>' : '</style>';
    const closeIdx = indexOfFold(html, closer, i);
    i = closeIdx === -1 ? n : closeIdx + closer.length;
    textStart = i;
  }
  if (n > textStart) parts.push(html.slice(textStart, n));
  return parts.join('');
}

// Cap on how much raw HTML the guard-path fallback (below) will turn into
// plain text. WHY (Important finding, 2026-08-06 review): the fallback exists
// to give the model SOMETHING useful when structured extraction was refused,
// not to render an entire document up to the 5MB body cap as plain text — a
// multi-megabyte tag-soup page would otherwise return megabytes of largely
// unreadable text. This is independent of the CRITICAL fix above (stripToText
// is linear now, so this cap is about usefulness, not runtime safety) and does
// NOT change MAX_TAGS, MAX_DEPTH, or the 5MB body cap itself.
const FALLBACK_CHAR_CAP = 200_000;

/** stripToText, bounded to FALLBACK_CHAR_CAP raw characters, for the guard
 *  (too-complex) path only. The JS-render density check below needs the FULL
 *  text and calls stripToText directly. */
function stripToTextCapped(html: string): { text: string; truncated: boolean } {
  const capped = html.length > FALLBACK_CHAR_CAP;
  return { text: stripToText(capped ? html.slice(0, FALLBACK_CHAR_CAP) : html), truncated: capped };
}

/** Builds the "too large or deeply nested" degraded-but-honest result shared
 *  by BOTH DoS guard stages in execute() below (the breadth pre-check, which
 *  never parses, and the real-DOM depth check, which does) — factored out so
 *  splitting the guard into two check points (see the file-level WHY block
 *  at the top of this file) didn't require duplicating this response shape
 *  at both call sites. `raw` is always the untouched fetched HTML, not a
 *  parsed document — neither guard stage keeps a `document` around for this:
 *  the breadth stage never builds one, and the depth stage's whole point is
 *  refusing to hand that document to any further processing. */
function tooComplexResult(header: string, hash: string, raw: string, truncated: boolean): ToolResultPayload {
  // WHY stripToTextCapped (not stripToText) here (Important finding,
  // 2026-08-06 review): this branch previously called the unbounded
  // stripToText and silently returned an entire multi-megabyte tag-soup
  // document as plain text — not a truncation-SAFETY issue (stripToText is
  // linear on any input) but a usefulness one: FALLBACK_CHAR_CAP bounds it
  // to something a model can actually read.
  const { text: fallbackText, truncated: fallbackCapped } = stripToTextCapped(raw);
  // Fix: declare the 200KB scan cap via `bounds` instead of hand-writing
  // "Showing only the first NKB..." into `text`. WHY this cap — not the 5MB
  // network cap — takes the single `bounds` slot when BOTH fire on the same
  // response (only one `bounds` can ride a ToolResultPayload): whenever
  // `truncated` (the 5MB cap) is true, `raw` decodes to well over 200,000
  // UTF-16 code units (5,242,880 bytes is at minimum ~2.6M units even in the
  // all-4-byte-codepoint worst case), so `fallbackCapped` is unconditionally
  // also true — the 200KB cap is the one that actually bounds what the
  // model reads. Its total (raw.length, the HTML actually scanned for this
  // fallback) is known exactly, unlike the 5MB cap's total. The 5MB fact is
  // not dropped: bodyCapNote below discloses it as plain prose whenever it
  // also fired — a fact, not advice, so it isn't the retired "how do I get
  // more" wording this contract removes.
  const bounds = fallbackCapped
    ? {
        shown: FALLBACK_CHAR_CAP,
        total: raw.length,
        unit: 'chars' as const,
        // Verbatim copy of WebFetchTool's own `moreHint` — see its WHY comment.
        moreHint: 'fetch a more specific URL, or a narrower section of the page',
      }
    : undefined;
  const bodyCapNote = truncated
    ? '\n\n[The response body itself was cut off at the 5MB fetch cap before this extraction ran — the live page may be larger than what was received.]'
    : '';
  // WHY this is general-and-non-committal, not "no anchor named X" (round 3
  // design change): neither guard stage runs Readability, so there is no
  // extracted markdown to check the fragment against. Per
  // docs/error-message-standards.md, a claim we cannot support (a
  // categorical "this anchor does not exist") is worse than saying plainly
  // that the check could not be done.
  const fragmentNote = hash
    ? `\n\n[This page could not be parsed for structured extraction, so whether "#${hash}" exists could not be checked.]`
    : '';
  return {
    text: `${header}\n\n[This page is too large or deeply nested for structured extraction, so this is a simplified extraction: plain text with no headings, links, or code formatting.]\n\n${fallbackText}${fragmentNote}${bodyCapNote}`,
    bounds,
  };
}

// --- JS-rendered-page disclosure (task 12) ------------------------------------
// Diagnosed 2026-08-01: WebFetch returned a clean, well-under-cap extraction of
// vitest.dev/config/ and the model confidently reported the `include` option
// "is not documented" — the content simply never arrives in the server's HTML;
// it is fetched by client-side JS after the page loads. Extraction-coverage ratio
// CANNOT be the signal (measured 70.3% on this false-negative page vs 69.1% on a
// known-good server-rendered page — indistinguishable), so detection instead
// combines a framework marker with raw text density.

/** Markers of a client-rendered app shell. */
const JS_APP_MARKERS = /__VP_HASH_MAP__|__NEXT_DATA__|__NUXT__|__remixContext|__sveltekit|window\.__INITIAL_STATE__/;
const EMPTY_ROOT = /<div id="(?:root|app|__next)"\s*>\s*<\/div>/i;
/** Visible-text-to-bytes ratio below which a page is mostly scaffolding. The
 *  denominator excludes <script>/<style> bytes — see the WHY comment on
 *  looksJsRendered below for why that matters. Re-measured on the two
 *  committed fixtures after that fix (2026-08-06): vitest-config.html (the
 *  false-negative page from the 2026-08-01 incident) 7.18%; asyncio.html
 *  (server-rendered, near-identical extraction ratio before this fix) 19.07%.
 *  Both these are what the committed test fixtures actually measure, not the
 *  5.3%/16.0% an earlier draft of this comment claimed. 10% still sits in the
 *  gap between them.
 *
 *  WHY the direction of this change matters (Minor finding, 2026-08-06
 *  re-review): excluding script/style from the denominator can only RAISE the
 *  ratio (the denominator only ever shrinks), so this change can only produce
 *  false NEGATIVES (a JS-rendered page slipping under the floor undetected),
 *  never false positives. Concretely, on vitest-config.html — the fixture
 *  that MUST stay flagged — the margin between its density and the 10% floor
 *  shrank from 4.64pp (old, raw html.length denominator: 5.36%) to 2.82pp
 *  (new: 7.18%). That margin is now the safety cushion: a real VitePress page
 *  with a larger __VP_HASH_MAP__ blob than this fixture's would push the
 *  ratio closer to 10% and could clear the floor, silently losing the
 *  JS-render disclosure. If that starts happening, raise TEXT_DENSITY_FLOOR,
 *  not the denominator logic — lowering the floor is the direction that
 *  re-admits false negatives; nothing here should ever LOWER it. */
const TEXT_DENSITY_FLOOR = 0.10;

// --- empty-extraction honesty (2026-08-10 review, Claim 9 / DeepSeek finding) --
// DeepSeek fetched a JS-heavy IntelliJ docs page and got back "Title: ..." with
// NOTHING after it — isError: false, no jsNote (JS_APP_MARKERS/EMPTY_ROOT didn't
// match that page's shell, so jsRenderDensity never fired). DeepSeek's own words:
// "I'd prefer a 'here's the first N chars, it was truncated' so I can decide
// whether to retry, rather than a blank I have to interpret as 'page is
// JS-rendered.'" An empty body is honest (nothing was fabricated) but reads as
// confidently as a real short-page result, a JS-render miss, and a genuine
// extraction bug — three different situations the model has no way to tell apart.
//
// WHY this is a SEPARATE pair of thresholds, not a widening of TEXT_DENSITY_FLOOR
// / JS_APP_MARKERS above (deliberate, per the verification doc's own
// recommendation — "a low-content-length heuristic ALONGSIDE the existing
// JS-render density check"): looksJsRendered's calibration is pinned by name
// against two committed fixtures (vitest-config.html / asyncio.html, see the
// `looksJsRendered` describe block below) — loosening its marker set or floor to
// catch more pages risks silently flipping one of those. This check instead asks
// a narrower, marker-independent question: did structured extraction (Readability
// + turndown) come back thin despite the raw page carrying real visible text
// somewhere? That's a fact measured about THIS response, not a guess about why.
/** Extraction below this many characters is treated as "near-empty" — the
 *  DeepSeek transcript's actual case was literally 0. */
const MIN_EXTRACTED_CHARS = 40;
/** Raw-page stripped-text length above which the page demonstrably carried real
 *  text somewhere (even if Readability didn't keep it) — below this, "the page
 *  itself is short" is a supported claim, not a guess. */
const SUBSTANTIAL_PAGE_CHARS = 500;

/** Core of the JS-render check, taking an already-computed stripped text so
 *  callers that need that text anyway (execute(), below) don't pay for a
 *  second stripToText() pass over the same html. */
function jsRenderDensity(html: string, strippedText: string): boolean {
  const hasMarker = JS_APP_MARKERS.test(html) || EMPTY_ROOT.test(html);
  if (!hasMarker) return false;
  const denominator = withoutScriptAndStyle(html).length;
  return strippedText.length / Math.max(denominator, 1) < TEXT_DENSITY_FLOOR;
}

/** True when the served HTML looks like an app shell whose content arrives via
 *  JavaScript. We CANNOT know what is missing — from the response's point of view
 *  nothing is — so callers must phrase the disclosure non-committally per
 *  docs/error-message-standards.md.
 *
 *  WHY the denominator excludes <script>/<style> bytes (Important finding,
 *  2026-08-06 review): stripToText already strips script/style bodies out of
 *  the NUMERATOR, but the denominator used to be the raw html.length, which
 *  still counted them — so a routine SSR hydration blob (e.g. Next.js'
 *  __NEXT_DATA__) deflated the ratio regardless of whether the visible prose
 *  was complete. A simulated SSR page with full article content plus a normal
 *  __NEXT_DATA__ blob measured 7.31% under the old (html.length) denominator —
 *  misfiring below the 10% floor on a page where nothing was missing — and
 *  89.29% under this one. See the "SSR page with a hydration blob" test. */
export function looksJsRendered(html: string): boolean {
  return jsRenderDensity(html, stripToText(html));
}

// --- URL fragment resolution (task 13, redesigned round 3 2026-08-06) ----------

// WHY this queries the parsed DOM instead of hand-scanning raw HTML a fourth
// time (design change, round 3): htmlToMarkdown already runs the page through
// linkedom's real HTML parser to build a `document` for Readability. Every
// prior round's fragment-resolution bug — the CRITICAL/IMPORTANT/MINOR
// findings this round, and the two CRITICAL regexes fixed in rounds 1–2
// (ID_ATTR_RE, ANCHOR_NAME_RE) — was a hand-rolled approximation of what a
// real parser already does correctly: attribute quoting (double/single/
// unquoted), script/style/comment/raw-text bodies, `>` inside a quoted
// attribute value. linkedom handles all of it for free, so the fix is to
// stop re-approximating and ask the parser directly.
//
// WHY the DOM lookup happens BEFORE Readability.parse() runs, not after (this
// is the one place this round's design deviates from a literal "have
// resolveFragment query the document" reading — see findAnchor below):
// Readability's own workflow doc comment says "4. Replace the current DOM
// tree with the new one" — it mutates `this._doc` in place, moving matched
// content into a new detached container and removing everything else during
// cleanup (verified by reading Readability.js: `_grabArticle` does
// `articleContent.appendChild(sibling)`, which MOVES real nodes, not clones).
// So the SAME document object queried after Readability has run may no
// longer contain an id that genuinely existed in the served page — which
// would misreport a real "the anchor exists but extraction dropped it" as a
// false "the anchor never existed" (`absent` instead of `dropped`). The fix:
// query the pristine, pre-Readability document once (findAnchor), carry
// forward only its small boolean/exactCase verdict, and combine that with
// the markdown once Readability has finished (classifyFragment). See
// WebFetchTool.execute below for the call order this requires.

/** Escapes a value for safe interpolation into a double-quoted CSS attribute
 *  selector string (`a[name="…"]` below). The fragment is attacker-controlled
 *  (it comes straight off the request URL), so a raw `"` or `\` in it must
 *  not be able to break out of the quoted value. Not a general CSS.escape
 *  substitute — sufficient because that's the only thing it needs to do. */
function escapeAttrSelectorValue(value: string): string {
  return value.replace(/[\\"]/g, '\\$&');
}

/** Resolves a URL fragment against an ALREADY-PARSED linkedom document. Exact
 *  match first (`getElementById`, `a[name="…"]`); falls back to a
 *  case-insensitive scan of every id/name VALUE in the document, same policy
 *  the hand-rolled version used (Minor finding, prior rounds: HTML `id` is
 *  case-sensitive, but real pages do sometimes get linked with the "wrong"
 *  case, so a case-insensitive hit is still reported as useful — just
 *  flagged as inexact via `exactCase`); then a final fallback that also
 *  tolerates the attribute NAME itself being written in a non-lowercase
 *  spelling (`<h2 ID="x">`, `<a NAME="x">`), which linkedom does not
 *  normalize the way a conforming HTML parser does (Important finding,
 *  round 4, 2026-08-06 — see the loop below).
 *
 *  MUST be called before the same document is handed to Readability — see
 *  the WHY block above. */
function findAnchor(document: Document, fragment: string): { exactCase: boolean } | null {
  if (document.getElementById(fragment)) return { exactCase: true };
  if (document.querySelector(`a[name="${escapeAttrSelectorValue(fragment)}"]`)) return { exactCase: true };
  const lowerFragment = fragment.toLowerCase();
  // Array.from (not a direct for-of) — linkedom's NodeListOf, reached through
  // the ambient lib.dom Document type parseHTML's return type resolves to,
  // doesn't type-check as directly iterable under this repo's tsconfig even
  // though it's iterable at runtime; Array.from sidesteps that without a cast.
  for (const el of Array.from(document.querySelectorAll('[id]'))) {
    const id = el.getAttribute('id');
    if (id && id.toLowerCase() === lowerFragment) return { exactCase: false };
  }
  for (const a of Array.from(document.querySelectorAll('a[name]'))) {
    const name = a.getAttribute('name');
    if (name && name.toLowerCase() === lowerFragment) return { exactCase: false };
  }
  // FALLBACK (Important finding, round 4, 2026-08-06): every probe above
  // relies on getElementById or the `[id]`/`a[name]` CSS selectors, all of
  // which match against the LITERAL attribute name "id"/"name". linkedom,
  // unlike a conforming HTML parser, does NOT ASCII-lowercase attribute
  // NAMES (only values pass through untouched too, but it's the name that
  // matters here): for `<h2 ID="upattr">`, `getAttributeNames()` returns
  // `["ID"]`, so `getElementById('upattr')` is null AND `[id]` matches zero
  // elements -- every probe above misses. Same for `<a NAME="legacyU">`.
  // Verified directly against linkedom: `parseHTML('<h2 ID="upattr">...')`
  // gives `document.querySelectorAll('[id]').length === 0`. Both spellings
  // are legal HTML5, and both used to work: the pre-round-3 `parseAttrs`
  // lowercased the attribute name before comparing, so this is a regression
  // this round introduced, not a pre-existing gap. Walk every element's OWN
  // attribute names case-insensitively as the last resort -- deliberately
  // placed after every cheaper selector-based probe above (and therefore
  // only paid for on a miss), since the common case is a lowercase
  // `id="..."` the fast path already resolves.
  for (const el of Array.from(document.querySelectorAll('*'))) {
    for (const attrName of el.getAttributeNames()) {
      const lowerAttrName = attrName.toLowerCase();
      const isIdAttr = lowerAttrName === 'id';
      const isAnchorNameAttr = lowerAttrName === 'name' && el.tagName?.toLowerCase() === 'a';
      if (!isIdAttr && !isAnchorNameAttr) continue;
      const value = el.getAttribute(attrName);
      if (!value) continue;
      if (value === fragment) return { exactCase: true };
      if (value.toLowerCase() === lowerFragment) return { exactCase: false };
    }
  }
  return null;
}

/** Given an already-resolved DOM anchor match (or null) and the extracted
 *  markdown, decides found / dropped / absent. Split out from findAnchor so
 *  production can query the DOM once, before Readability mutates it, and
 *  bring forward only the small `{ exactCase }` result to combine with the
 *  markdown once extraction has finished (see the WHY block above).
 *
 *  WHY matching goes through anchor hrefs and not heading text: VitePress emits
 *  `## Config Options [​](#config-options)`, so slugifying the heading text yields
 *  "config-options-config-options" and misses. The `id="..."` attributes in the raw
 *  HTML are authoritative and independent of markdown rendering.
 *
 *  `bodyTruncated` scopes the `absent` result's wording (Important finding,
 *  prior round): when the fetched body was cut off at the 5MB cap, "this
 *  anchor does not exist" is a claim about bytes that were never read, not
 *  about the page. */
function classifyFragment(
  anchor: { exactCase: boolean } | null,
  markdown: string,
  fragment: string,
  bodyTruncated: boolean,
):
  | { kind: 'found'; section: string; exactCase: boolean }
  | { kind: 'dropped'; exactCase: boolean }
  | { kind: 'absent'; bodyTruncated: boolean } {
  if (anchor === null) return { kind: 'absent', bodyTruncated };
  // Markdown heading/slug text is already case-normalized by the renderer
  // (VitePress etc. lowercase slugs regardless of source id case), so this
  // half of the match stays a lowercase comparison.
  const frag = fragment.toLowerCase();
  const lines = markdown.split('\n');
  const start = lines.findIndex(
    (l) => /^#{1,6} /.test(l) && (l.toLowerCase().includes(`(#${frag})`) || slugify(l) === frag),
  );
  if (start === -1) return { kind: 'dropped', exactCase: anchor.exactCase };
  const level = (lines[start].match(/^#+/) ?? ['#'])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6}) /);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return { kind: 'found', section: lines.slice(start, end).join('\n').trim(), exactCase: anchor.exactCase };
}

/** Test/convenience entry point matching the pre-round-3 API shape: parses
 *  `rawHtml` itself and resolves the fragment against the result. NOT used by
 *  WebFetchTool.execute in production — that path reuses the single document
 *  it's about to hand to Readability and must query it BEFORE Readability
 *  mutates it (see the WHY block above), so it calls findAnchor and
 *  classifyFragment directly instead of parsing the page a second time here.
 *  Kept as the public surface for tests and any future non-pipeline caller
 *  that just wants a straight answer for one page. */
export function resolveFragment(
  rawHtml: string,
  markdown: string,
  fragment: string,
  bodyTruncated = false,
):
  | { kind: 'found'; section: string; exactCase: boolean }
  | { kind: 'dropped'; exactCase: boolean }
  | { kind: 'absent'; bodyTruncated: boolean } {
  const { document } = parseHTML(rawHtml);
  return classifyFragment(findAnchor(document, fragment), markdown, fragment, bodyTruncated);
}

/** Heading text → slug, with any trailing anchor link removed first. */
function slugify(heading: string): string {
  return heading
    .replace(/^#+\s*/, '')
    .replace(/\[.*?\]\(#.*?\)\s*$/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Runs Readability + turndown against an ALREADY-PARSED document (the
 *  caller must have finished any DOM queries of its own first — see
 *  findAnchor's WHY block above, since this call mutates `document` in
 *  place). `rawHtml` is only the last-resort fallback source if Readability
 *  finds no article AND the mutated document somehow has no body. */
function htmlToMarkdown(document: Document, rawHtml: string): { title: string | null; markdown: string } {
  // linkedom's parsed document satisfies Readability's DOM contract at runtime,
  // but its typings don't match @mozilla/readability's `Document` param — cast
  // narrowly here rather than pull in a jsdom-shaped global Document type.
  const article = new Readability(document as unknown as Document).parse();
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  if (article?.content) return { title: article.title ?? null, markdown: turndown.turndown(article.content) };
  // Readability found no article (a dashboard, an index page…) — fall back to the
  // whole body so the model still gets SOMETHING structured, never a silent empty.
  //
  // The try/catch is load-bearing, and `?.` alone was not enough (measured
  // 2026-08-11): a SUCCESSFUL Readability parse moves nodes out and leaves
  // linkedom's `documentElement` null, and linkedom's `body` getter then THROWS
  // ("Cannot destructure property 'firstElementChild'") rather than returning
  // undefined — optional chaining does not catch a throwing getter. Today the
  // early return above means a successful parse never reaches this line, so the
  // path is unreachable; the day `article.content` comes back empty from a parse
  // that still emptied the document, the stated fallback would have become a
  // TypeError instead. Kept lazy rather than snapshotting body.innerHTML before
  // the parse: that would copy the whole body on every fetch to serve a case
  // that almost never happens.
  let body = rawHtml;
  try {
    body = document.body?.innerHTML ?? rawHtml;
  } catch {
    /* document was emptied by the parse — rawHtml is the honest source left. */
  }
  let title: string | null = null;
  try {
    title = document.title || null;
  } catch {
    /* same reason as above; a missing title is not worth failing the fetch. */
  }
  return { title, markdown: turndown.turndown(body) };
}

export const WebFetchTool = defineTool<z.infer<typeof inputSchema>>({
  name: 'WebFetch',
  untrusted: 'WebFetch',
  description:
    'Fetch a web page and return its main content as Markdown. Only public http/https URLs — private and local addresses are blocked. Large pages are truncated.',
  // Compact form for small local models (simplified presentation).
  shortDescription: 'Fetch a public web page (http/https) and return its main content as Markdown.',
  inputSchema,
  // WHY this exists as a static field AND gets copied verbatim into every
  // `bounds.moreHint` below (fix: WebFetch declares its body caps instead of
  // hand-writing them): `bounds` can only be built inside execute()'s object
  // literals, which can't reference the const this file is still constructing
  // (`WebFetchTool` isn't assigned yet at that point) — so the string is
  // duplicated by hand, same as Bash's and Read's `moreHint` fields do. This is
  // WebFetch's one genuine widening vocabulary (it has no offset/limit-style
  // parameter to page through) and also composeNotice's no-bounds fallback
  // (Task 19) for the rare defineTool pipeline-cap-only case.
  moreHint: 'fetch a more specific URL, or a narrower section of the page',
  permissionSubject: (args) => args.url,
  async execute(args, ctx) {
    let res: Response, finalUrl: string;
    try {
      ({ res, finalUrl } = await guardedFetch(args.url, { signal: ctx.signal, ...testHooks }));
    } catch (err) {
      if (err instanceof NetGuardError) return { text: `WebFetch blocked: ${err.message}`, isError: true };
      throw err; // defineTool's catch turns it into an actionable error result
    }
    if (!res.ok) {
      return { text: `WebFetch failed: ${finalUrl} answered HTTP ${res.status}${res.statusText ? ` (${res.statusText})` : ''}.`, isError: true };
    }
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    let isHtml = contentType.startsWith('text/html') || contentType.startsWith('application/xhtml');
    const isText = TEXT_TYPES.test(contentType);
    // A bare/misconfigured HTML server may omit content-type entirely. Don't refuse
    // outright: defer the decision until after we've read the body and can sniff it
    // (below). A NON-empty, non-html, non-text type IS a real binary — refuse now,
    // before downloading it.
    const noContentType = contentType.trim() === '';
    if (!isHtml && !isText && !noContentType) {
      return { text: `WebFetch can only read HTML and text content; ${finalUrl} is ${contentType || 'an unknown binary type'}.`, isError: true };
    }
    // CHARSET NOTE: readBodyCapped decodes as UTF-8 unconditionally (it lives in
    // net-guard.ts — not editable this round). A shift_jis / latin-1 page therefore
    // renders as mojibake. Accepted for a preview-grade extraction; a proper
    // charset-aware decode is deferred.
    const { text: raw, truncated } = await readBodyCapped(res, MAX_BODY_BYTES);
    // No content-type header: sniff the decoded body. Real HTML starts (after
    // optional whitespace/BOM) with a doctype or <html>. Anything else stays a
    // refusal — we couldn't determine it's readable text/html.
    if (noContentType) {
      if (/^\s*<(?:!doctype\s+html\b|html\b)/i.test(raw)) {
        isHtml = true;
      } else {
        return { text: `WebFetch can only read HTML and text content; ${finalUrl} is ${contentType || 'an unknown binary type'}.`, isError: true };
      }
    }
    const header = `Source: ${finalUrl}`;
    if (!isHtml) {
      return {
        text: `${header}\n\n${raw}`,
        // Fix: declare the 5MB cap via `bounds` instead of hand-writing
        // "[body truncated at 5MB]" into `text` — the server never told us how
        // much MORE there was past MAX_BODY_BYTES, so `total` MUST be `null`
        // (composeNotice renders that as "at least N"); inventing a total here
        // is the exact dishonesty this contract exists to remove.
        //
        // CORRECTION (round 7, 2026-08-06 review): a previous fixer argued
        // this branch was safe with `shown: MAX_BODY_BYTES, unit: 'bytes'`
        // because — unlike BLOCKER B1 below — `raw` is embedded in `text`
        // VERBATIM, with no extraction step to discard anything. True on its
        // own, but incomplete: defineTool (registry.ts) still runs `text`
        // through its OWN 30,000-CHAR pipeline cap regardless of what this
        // tool declares, and composeNotice renders BOTH bounds on one line.
        // Measured on a 6,000,000-byte CJK text/plain body (decodes to
        // 1,747,627 UTF-16 units before the 5MB byte cap trims it further):
        //   [showing 30007 of 1747664 chars, and 5242880 bytes (more may exist — exact total unknown) — …]
        // — one line claiming 5,242,880 BYTES shown in the same breath as
        // 30,007 CHARS shown, two different units both purporting to measure
        // the same `text`. Whenever `truncated` is true here, the pipeline
        // cap has ALWAYS already fired too: MAX_BODY_BYTES (5,242,880 bytes)
        // decodes to at least ~1.31M UTF-16 units even in the all-4-byte-
        // codepoint worst case — unconditionally past defineTool's 30,000-char
        // maxChars — so `shown: MAX_BODY_BYTES` overstates what's actually in
        // `text` by 50-175x every time this branch fires, not just on
        // pathological input. Fixed the same way as BLOCKER B1: `shown`
        // measures `raw.length` — what this tool itself put into `text`, in
        // the SAME unit (chars) the pipeline cap also uses — and `total`
        // stays `null` (the true page size past the network cap is still
        // genuinely unknown).
        bounds: truncated
          ? { shown: raw.length, total: null, unit: 'chars' as const, moreHint: 'fetch a more specific URL, or a narrower section of the page' }
          : undefined,
      };
    }
    // Needed by both the too-complex fallback below and the normal path —
    // compute once up front.
    const hash = (() => { try { return new URL(finalUrl).hash.replace(/^#/, ''); } catch { return ''; } })();
    // DoS guard, STAGE 1 (breadth): never let a page whose raw '<' count alone
    // already exceeds MAX_TAGS reach parseHTML at all — see tagCountTooHigh's
    // own WHY comment and the file-level WHY block above for the measured
    // parseHTML-vs-Readability split that makes this ordering load-bearing.
    // WHY this degrades instead of hard-failing (2026-08-06): the guard is
    // specifically about Readability's cost, and tag-stripping is genuinely
    // linear (see stripToText's WHY comment) and safe on any input — so we can
    // still return honest content. The old refusal left the model with nothing
    // and no way forward (2026-08-01 review, finding #1).
    if (tagCountTooHigh(raw)) {
      return tooComplexResult(header, hash, raw, truncated);
    }
    // Single parse of this page, reused for the depth check (STAGE 2 below)
    // AND — once that passes — fragment resolution + Readability extraction
    // further down. See classifyFragment's WHY block for why the fragment
    // lookup MUST happen before htmlToMarkdown hands this same `document` to
    // Readability, which mutates it in place.
    const { document } = parseHTML(raw);
    // DoS guard, STAGE 2 (depth): now that we have the REAL parsed tree,
    // reject before Readability if it nests past MAX_DEPTH. See domTooDeep's
    // own WHY comment for why this replaces every hand-rolled raw-HTML depth
    // scan that came before it.
    if (domTooDeep(document)) {
      return tooComplexResult(header, hash, raw, truncated);
    }
    const anchorMatch = hash ? findAnchor(document, hash) : null;
    const { title, markdown } = htmlToMarkdown(document, raw);
    // Minor finding (2026-08-06 review): stripToText(raw) used to be recomputed
    // separately for the density check and for the KB figure in jsNote below —
    // compute it once here and pass it into both.
    const strippedRaw = stripToText(raw);
    const jsRendered = jsRenderDensity(raw, strippedRaw);
    // Fix (2026-08-10 review, Claim 9): the three-way split described in the
    // MIN_EXTRACTED_CHARS/SUBSTANTIAL_PAGE_CHARS WHY comment above. `markdown`
    // (not `body`) is the signal — `body` may already be sliced down to one
    // #fragment section further below, which is short ON PURPOSE and not a
    // gap to disclose.
    const trimmedMarkdown = markdown.trim();
    const extractedIsThin = trimmedMarkdown.length < MIN_EXTRACTED_CHARS;
    const pageHadSubstantialText = strippedRaw.length >= SUBSTANTIAL_PAGE_CHARS;
    // Honest, non-committal disclosure: state what was observed, never guess what
    // is absent. Without this a JS-rendered docs page returns a confident preamble
    // and the model reports "the docs do not document X" (2026-08-01 review).
    // When extraction is also thin, "a section may be missing" understates it —
    // say plainly that NOTHING came back and give an actual next step (fix:
    // Claim 9 — every other tool in this harness names a concrete alternative
    // when it truncates; this is WebFetch's equivalent for a total miss).
    const jsNote = jsRendered
      ? `\n\n[This page is a JavaScript-rendered app${extractedIsThin ? ', and extraction found no readable content at all' : ''}. The server sent ${(strippedRaw.length / 1024).toFixed(1)} KB of text; content that loads in a browser is not included. ${
          extractedIsThin
            ? 'This tool cannot run that JavaScript, so there is nothing more to extract from this URL — try WebSearch for this topic, or look for an API endpoint or a server-rendered mirror of the page.'
            : 'If a section you expected is absent, it is likely rendered client-side.'
        }]`
      : '';
    // Fix (2026-08-10 review, Claim 9): the two cases jsNote's marker+density
    // heuristic can miss — confirmed against the actual DeepSeek transcript,
    // where NEITHER JS_APP_MARKERS nor EMPTY_ROOT matched the fetched page, so
    // jsNote stayed silent even though extraction came back empty. Mutually
    // exclusive with jsNote (only meaningful when the JS-render heuristic did
    // NOT already explain the gap).
    const emptyExtractionNote = jsRendered || !extractedIsThin
      ? ''
      : pageHadSubstantialText
        // The raw page measurably carried real text (title, nav, whatever) that
        // never made it into the extraction, and the JS-render heuristic didn't
        // fire — so the honest answer is "unclear", never a guessed cause.
        ? `\n\n[Extraction returned almost no content (${trimmedMarkdown.length} characters), even though the page's raw HTML carried about ${Math.round(strippedRaw.length / 1024)} KB of text overall. It isn't clear why — this page doesn't show the signs of client-rendered content this tool checks for, so don't assume that's the cause. Try WebSearch for this topic, or refetch with a specific #section if the page has one.]`
        // Both the extraction AND the raw page itself are small — genuinely
        // little was ever there to find.
        : `\n\n[This page's extracted content is short (${trimmedMarkdown.length} characters), and the page's raw HTML did not contain much more text either (${strippedRaw.length} characters total) — this looks like a genuinely short or mostly-empty page, not a fetch problem.]`;
    // A fragment on the request URL is a question about ONE section. Answer it
    // directly, and be explicit when we cannot.
    let fragmentNote = '';
    let body = markdown;
    if (hash) {
      const f = classifyFragment(anchorMatch, markdown, hash, truncated);
      if (f.kind === 'found') {
        body = f.section;
        const caseNote = f.exactCase ? '' : ' (matched case-insensitively — the served id differs in case from the fragment)';
        fragmentNote = `\n\n[Showing the "#${hash}" section only${caseNote}. Refetch without the fragment for the whole page.]`;
      } else if (f.kind === 'dropped') {
        const caseNote = f.exactCase ? '' : ' (case-insensitive match)';
        fragmentNote = `\n\n[The page has an anchor named "#${hash}"${caseNote}, but article extraction did not keep that section. The full text above is what was extracted.]`;
      } else {
        // Important finding (2026-08-06 review): this used to be a flat "the
        // HTML contains no anchor named X" regardless of whether the body was
        // truncated at the 5MB cap — a categorical claim about bytes that, when
        // truncated, were never actually read. Scope the wording to what was
        // examined.
        fragmentNote = f.bodyTruncated
          ? `\n\n[No anchor named "#${hash}" was found in the portion of this page that was fetched. The body was truncated at 5MB, so a later part of the page may still contain it.]`
          : `\n\n[The HTML served for this URL contains no anchor named "#${hash}".]`;
      }
    }
    const resultText = `${header}${title ? `\nTitle: ${title}` : ''}\n\n${body}${fragmentNote}${jsNote}${emptyExtractionNote}`;
    // Fix (BLOCKER B1, round 5, 2026-08-06 review): this used to declare
    // `bounds: { shown: MAX_BODY_BYTES, total: null, unit: 'bytes' }` whenever
    // the network fetch hit the 5MB cap — but `resultText` here is the
    // EXTRACTED MARKDOWN, not the raw fetched bytes, so that claim collapsed
    // "we fetched 5MB of HTML" into "we showed you 5MB of content". Measured
    // on a 6,000,501-byte page whose article was one short paragraph: the
    // tool returned 555 characters of markdown while `bounds` claimed
    // `shown: 5242880`, and composeNotice rendered "showing 5242880 of at
    // least 5242880 bytes" — telling the model it had seen (at minimum) the
    // whole page when 758KB was never fetched and ~5.24MB was never shown.
    // `shown` now measures what's actually in `resultText` (chars), which is
    // the honest quantity; `total` stays `null` because the true size is
    // still genuinely unknown (Readability ran on a body that was itself cut
    // short, so there is no measured "how much more" to report). The 5MB
    // network fact is real information and stays disclosed — as plain prose
    // (bodyCapNote), the same pattern the too-complex-extraction branch above
    // already uses for the identical fact, not folded back into a number
    // that overstates coverage.
    const bodyCapNote = truncated
      ? '\n\n[The response body itself was cut off at the 5MB fetch cap before extraction ran — the live page may be larger than what was extracted.]'
      : '';
    return {
      text: `${resultText}${bodyCapNote}`,
      bounds: truncated
        ? { shown: resultText.length, total: null, unit: 'chars' as const, moreHint: 'fetch a more specific URL, or a narrower section of the page' }
        : undefined,
    };
  },
});
