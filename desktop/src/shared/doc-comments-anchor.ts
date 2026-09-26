// Document comments — re-anchoring after edits. T2 of the doc-comments build
// (docs/active/specs/2026-09-26-doc-comments-build-design.md §2.2): given the
// current text of a file and a comment's TextQuoteSelector, find where (if
// anywhere) that quote still lives.
//
// WHY this file has no DOM and no Node APIs: it is imported by the Electron
// main process (T8's ReadFileComments/MoveComment tools run there with no
// window), the React renderer (wiring the highlight marks onto the current
// DOM), and — per §9 — hand-copied into the dependency-free Claude Code MCP
// script, which has no module graph to import this file through at all. A
// DOM call here would silently work in the renderer and crash or no-op in
// the other two, and hand-copying would then have to leave the DOM call out,
// producing three implementations of "is this still anchored" that could
// disagree — exactly what §2.2 says this single function exists to prevent.
import type { CellSelector, TextQuoteSelector } from './doc-comments-types';

/** A resolved text-quote anchor: character offsets into the `fullText` that
 *  was searched. `end` is exclusive, matching `String.prototype.slice`. */
export interface ResolvedRange {
  start: number;
  end: number;
}

/**
 * Strips all whitespace from `text`, returning the compact string plus a
 * same-length array mapping each compact-string index back to its index in
 * the ORIGINAL `text`. Mirrors `use-quote-marks.ts`'s `findQuote` — "a
 * selection almost never respects text-node boundaries" applies just as
 * much to plain text: a selection can carry a newline a paragraph-join
 * doesn't have, or vice versa — except that helper walks DOM text nodes and
 * this one walks plain string offsets, since this file may run with no DOM
 * at all (main process, MCP script).
 */
function compact(text: string): { compact: string; toOriginal: number[] } {
  let out = '';
  const toOriginal: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue;
    out += text[i];
    toOriginal.push(i);
  }
  return { compact: out, toOriginal };
}

/**
 * Every non-overlapping occurrence of `exact` in `fullText`, whitespace
 * differences ignored on both sides (§2.2: "whitespace-collapsed compare,
 * same tolerance findQuote already has"), as `[start, end)` offsets into the
 * ORIGINAL `fullText`. Returns `[]` when `exact` (once whitespace is
 * stripped) is empty or genuinely absent — the zero-occurrences case §2.2
 * says must become `'detached'`, never a thrown error.
 */
function findAllOccurrences(fullText: string, exact: string): ResolvedRange[] {
  const needle = exact.replace(/\s+/g, '');
  if (!needle) return [];
  const { compact: hay, toOriginal } = compact(fullText);
  const results: ResolvedRange[] = [];
  let searchFrom = 0;
  for (;;) {
    const idx = hay.indexOf(needle, searchFrom);
    if (idx === -1) break;
    const start = toOriginal[idx];
    // toOriginal[idx + needle.length - 1] is the ORIGINAL index of the
    // match's last non-whitespace character; +1 makes `end` exclusive.
    const end = toOriginal[idx + needle.length - 1] + 1;
    results.push({ start, end });
    searchFrom = idx + needle.length; // non-overlapping
  }
  return results;
}

/**
 * Levenshtein edit distance — the single scoring metric §2.2/review 2 (F14)
 * specifies in place of two separately-stated fallback rules. Plain O(n·m)
 * DP with a rolling pair of rows (O(min(n,m)) space): both strings here are
 * short in practice (prefix/suffix are ~32 chars each per the selector's own
 * shape; `exact` is whatever the user selected) and this only runs during
 * the anchoring pass, never per keystroke — performance.md rule 5 (keystroke
 * -frequency state) doesn't apply because nothing calls this while the user
 * is typing.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[n];
}

/**
 * Finds where `sel` currently anchors in `fullText`, or reports that it no
 * longer does. §2.2 (review 1 F9a/F9b, unified review 2 F14):
 *
 * 1. Find every occurrence of `sel.exact` in `fullText` (whitespace-
 *    collapsed compare). Zero occurrences → `'detached'`. This is the ONLY
 *    way `'detached'` is produced — an out-of-range `sel.occurrence` is
 *    never treated as "not found" (see 3).
 * 2. Exactly one occurrence → that's the anchor. `sel.occurrence` is never
 *    consulted: a quote that moved elsewhere in the document (an edit
 *    shifted its position but left it unique) still anchors even though its
 *    CURRENT surroundings no longer resemble `sel.prefix`/`sel.suffix` —
 *    prefix/suffix only exist to disambiguate among MULTIPLE candidates
 *    (step 3), never to gate whether a unique match counts.
 * 3. Multiple occurrences: score each by the Levenshtein distance between
 *    (`sel.prefix` + `sel.exact` + `sel.suffix`) and the document text
 *    surrounding that occurrence (the same span width, clamped to the
 *    document's bounds), then take the LOWEST-distance candidate. This one
 *    metric is what review 2 (F14) uses to subsume both fallback rules the
 *    design used to state separately:
 *      - an out-of-range `sel.occurrence` (the quote's 4th match at creation
 *        time, but an edit reduced the document to 2 matches) never clamps
 *        to a fixed index — every remaining occurrence is scored and the
 *        best one wins, `sel.occurrence` playing no role at all;
 *      - a genuine tie (two candidates score identically, e.g. a duplicated
 *        block) resolves to the EARLIER document position: candidates are
 *        scored in document order and only a STRICTLY lower score replaces
 *        the current best, so the first candidate to reach a given score
 *        keeps it — a fixed, documented rule with no separate branch that
 *        could disagree with the score itself (the ill-posedness F14 fixed).
 */
export function resolveSelector(fullText: string, sel: TextQuoteSelector): ResolvedRange | 'detached' {
  const occurrences = findAllOccurrences(fullText, sel.exact);
  if (occurrences.length === 0) return 'detached';
  if (occurrences.length === 1) return occurrences[0];

  const wanted = sel.prefix + sel.exact + sel.suffix;
  let best = occurrences[0];
  let bestScore = Infinity;
  for (const occ of occurrences) {
    const windowStart = Math.max(0, occ.start - sel.prefix.length);
    const windowEnd = Math.min(fullText.length, occ.end + sel.suffix.length);
    const score = levenshtein(wanted, fullText.slice(windowStart, windowEnd));
    if (score < bestScore) {
      bestScore = score;
      best = occ;
    }
  }
  return best;
}

/**
 * The identifier a `CellSelector` names, as a plain string — the same
 * `sheet` + `cell` pairing `use-quote-marks.ts`'s `cellSelector()` turns
 * into a CSS selector, but usable without DOM access here. `\u0000` can't
 * appear in a sheet name or cell reference, so it's a safe separator that
 * never collides with a real one.
 */
export function cellSelectorKey(sel: CellSelector): string {
  return sel.sheet ? `${sel.sheet}\u0000${sel.cell}` : sel.cell;
}

/**
 * Cell selectors resolve trivially (§2.2): a cell either is or isn't in the
 * current sheet — there's no prefix/suffix drift to score the way text has.
 * "Currently in the sheet" is a DOM fact this file can't check itself (no
 * DOM), so the caller supplies it as a set of cell keys it already collected
 * (e.g. from querying `[data-sheet][data-cell]` in the rendered grid); this
 * function only owns the resulting anchored/detached decision, so the
 * renderer and any future caller don't each hand-roll that check slightly
 * differently.
 */
export function resolveCellSelector(sel: CellSelector, presentCells: ReadonlySet<string>): 'anchored' | 'detached' {
  return presentCells.has(cellSelectorKey(sel)) ? 'anchored' : 'detached';
}
