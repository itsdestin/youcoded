// Finds the things inside a rendered assistant message that a user expects to
// be able to CLICK: web URLs and file paths. Pure string work, no React, so the
// rules are unit-testable on their own (markdown-linkify.test.ts).
//
// WHY this exists separately from remark-gfm's autolinking: gfm only linkifies
// bare URLs in prose. Claude very often writes a URL inside backticks
// (`http://127.0.0.1:8931/`) or inside a fenced block, and those arrived as
// dead text — the exact complaint this module answers.
import { detectFilepaths } from '../hooks/useInlineFilepathDetector';

export interface LinkToken {
  kind: 'url' | 'path';
  /** The exact source text matched — what stays visible to the reader. */
  text: string;
  /** What a click acts on: the href for a url, the path for a path. */
  value: string;
  start: number;
  end: number;
}

// Deliberately permissive on the URL body and strict afterwards (trimTrailing):
// a URL can legally contain almost anything, so the reliable way to find its END
// is to grab too much and then peel off punctuation that belongs to the sentence.
// Excluded outright: whitespace, quotes, angle brackets and the markdown-ish
// delimiters that can never appear unescaped in a URL we want to open.
// The lookbehind stops mid-word matches (`nothttps://x`) without rejecting the
// common wrappers — (, [, {, ", ', ` and = all pass.
const URL_RE = /(?<![A-Za-z0-9])https?:\/\/[^\s<>"'`\\^{}|[\]]+/g;

function countChar(s: string, c: string): number {
  let n = 0;
  for (const ch of s) if (ch === c) n++;
  return n;
}

/**
 * Peel sentence punctuation off the end of a greedy URL match.
 * "see https://example.com/docs." → the period is the sentence's, not the URL's.
 * A closing paren is kept only when the URL opened one itself, so both
 * "(see https://example.com)" and "https://en.wikipedia.org/wiki/Foo_(bar)" work.
 */
function trimTrailing(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url[url.length - 1];
    if (last === undefined) break;
    if ('.,;:!?'.includes(last)) { url = url.slice(0, -1); continue; }
    if (last === ')' && countChar(url, '(') < countChar(url, ')')) { url = url.slice(0, -1); continue; }
    break;
  }
  return url;
}

/** Web URLs in a run of plain text. */
export function detectUrls(text: string): LinkToken[] {
  const out: LinkToken[] = [];
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text))) {
    const url = trimTrailing(m[0]);
    // "http://" with nothing after it is not a link, it is prose about links.
    const schemeEnd = url.indexOf('//') + 2;
    if (url.length <= schemeEnd) continue;
    out.push({ kind: 'url', text: url, value: url, start: m.index, end: m.index + url.length });
  }
  return out;
}

/**
 * Every clickable token in a run of text, left to right, never overlapping.
 * URLs win ties: the `/docs/plan.md` tail of a URL is part of the URL, not a
 * file on this machine.
 */
export function detectLinkTokens(
  text: string,
  opts: { filepaths: boolean },
): LinkToken[] {
  // Fast path: no slash, no match — provable, not a heuristic. URL_RE requires
  // `https?://`, and EVERY alternative in PATH_RE's opening group ends in
  // [\\/] (drive letter, ~/, ./, /, or segment/). So text containing neither
  // "/" nor "\" cannot produce either kind of token.
  //
  // WHY it is worth a branch: this runs once per TEXT NODE, and syntax
  // highlighting shreds a code block into one text node per token. The perf
  // rig's 394 KB fixture goes from 7,056 nodes to 108,576 once highlighted
  // (measured 2026-09-10), and the overwhelming majority of those are things
  // like `const`, `=` and a space — two regex scans each, all of them certain
  // to fail. Guarded by markdown-linkify.test.ts ("no slash means no token").
  if (!text.includes('/') && !text.includes('\\')) return [];

  const urls = detectUrls(text);
  if (!opts.filepaths) return urls;
  const paths: LinkToken[] = detectFilepaths(text)
    .filter((p) => !urls.some((u) => p.start < u.end && u.start < p.end))
    .map((p) => ({
      kind: 'path' as const,
      text: text.slice(p.start, p.end),
      value: p.path,
      start: p.start,
      end: p.end,
    }));
  return [...urls, ...paths].sort((a, b) => a.start - b.start);
}
