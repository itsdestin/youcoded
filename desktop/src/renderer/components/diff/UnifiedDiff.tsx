// UnifiedDiff — the ONE line-diff renderer (spec 2026-07-20 §6). Extracted from
// ToolBody so the tool-card diff and the artifact-pane conflict diff render
// identically; the old-string/new-string fallback now uses jsdiff (already a
// dependency, previously imported by nothing in the renderer) instead of a
// hand-rolled O(m·n) LCS table.
//
// Design intent preserved from the ToolBody original — do not "fix" these:
// - Tinted row backgrounds + hardcoded red/green bars are deliberately
//   theme-INDEPENDENT: pastel text-red-200 washed out on high-chroma theme
//   canvases (Hello Kitty pink), so only the code text is theme-adaptive.
// - Single line-number gutter matching Claude Code's native diff convention:
//   deleted rows show the old-file number, context + added rows the new-file
//   number.
// - calc() gutter width, not bare `Nch`: Tailwind's global border-box makes a
//   plain width include the px-1.5 padding and wraps "12" into stacked digits.
// - Long diffs draw DIFF_PREVIEW_LINES rows with a "Show N more lines" button;
//   expanded they scroll in a capped box that fills FILE_BOX_CHUNK rows at a time.
import React, { useMemo, useRef, useState } from 'react';
import { canDiffInline, diffRowsFromStrings, type DiffRow } from './diff-rows';
import { useDiffJob } from './use-diff-job';
import { ErrorState, LoadingState } from '../ui/states';
export { diffRowsFromStrings } from './diff-rows';
export type { DiffRow } from './diff-rows';
import type { StructuredPatchHunk } from '../../../shared/types';
import { useExpandAllToggle, getInitialExpanded } from '../../hooks/useExpandAllToggle';
import { useChunkedReveal } from '../../hooks/use-chunked-reveal';

const DIFF_PREVIEW_LINES = 15;

// Shared base for the row box's collapsed/expanded class strings (review round
// 1, 2026-09-18) — the two variants only ever differed by the scroll cap.
const DIFF_BOX_BASE = 'text-xs font-mono';
// WHY the border lives on its own frame (2026-10-15, the one scroll fade): the expanded
// box fades its rows at a scrolled edge, and the fade is a mask — on a bordered box it
// would fade the border too. The frame keeps the border whole; only the rows fade.
const DIFF_FRAME = 'rounded-sm border border-edge overflow-hidden';

// WHY 200 and not the lists' 50 (REVEAL_CHUNK): a diff line is 3–4 DOM nodes
// where a list card is 15–25, so 200 lines cost about what 50 cards do — and a
// 50-line step would make scrolling a long file stutter for no saving.
// Shared with ToolBody's ReadView so both file boxes grow at the same pace.
export const FILE_BOX_CHUNK = 200;

// `fill` mode has no handle on the host's scroller, so it observes against the
// viewport: a null root still reveals only when the sentinel is actually
// visible (the observer honours the host's clipping), at the cost of the 400px
// early margin applying to the window rather than the host box.
const NO_ROOT: React.RefObject<HTMLElement | null> = { current: null };

/** Walk a Claude Code structuredPatch hunk into DiffRows with ABSOLUTE file
 * line numbers. Context advances both counters; '-' only old; '+' only new. */
export function rowsFromHunk(hunk: StructuredPatchHunk): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldN = hunk.oldStart;
  let newN = hunk.newStart;
  for (const raw of hunk.lines) {
    const prefix = raw.charAt(0);
    const text = raw.slice(1);
    if (prefix === '-') {
      rows.push({ kind: 'del', oldN, text });
      oldN++;
    } else if (prefix === '+') {
      rows.push({ kind: 'add', newN, text });
      newN++;
    } else {
      rows.push({ kind: 'ctx', oldN, newN, text });
      oldN++;
      newN++;
    }
  }
  return rows;
}

export function UnifiedDiff({
  oldStr,
  newStr,
  structuredPatch,
  fill,
}: {
  oldStr: string;
  newStr: string;
  structuredPatch?: StructuredPatchHunk[];
  /** When a host wraps this diff in its own scroll container (the git review
   *  timeline caps each diff at 45vh), the internal 15-line preview and its
   *  "Show more" button are redundant — they stack a second scrollbar inside
   *  the host's. `fill` drops the preview, cap and button so the HOST is the
   *  sole scroll surface; rows still arrive FILE_BOX_CHUNK at a time as the
   *  host is scrolled, rather than a whole commit's diff at once. */
  fill?: boolean;
}) {
  // Prefer precomputed hunks. Only bounded small fallback comparisons may
  // run here; large ones run off-thread even while the preview is collapsed.
  const background = !(structuredPatch && structuredPatch.length > 0) && !canDiffInline(oldStr, newStr);
  const job = useDiffJob(oldStr, newStr, background);
  const { rows, hunkBoundaries, maxLineNum } = useMemo(() => {
    if (structuredPatch && structuredPatch.length > 0) {
      const out: DiffRow[] = [];
      const boundaries = new Set<number>();
      let max = 0;
      structuredPatch.forEach((hunk, i) => {
        if (i > 0) boundaries.add(out.length);
        const hunkRows = rowsFromHunk(hunk);
        out.push(...hunkRows);
        max = Math.max(max, hunk.oldStart + hunk.oldLines, hunk.newStart + hunk.newLines);
      });
      return { rows: out, hunkBoundaries: boundaries, maxLineNum: max };
    }
    const fallback = background ? job.rows ?? [] : diffRowsFromStrings(oldStr, newStr);
    // The worker already numbered every line; don't split the large inputs
    // again on the UI thread just to size a gutter.
    let oldLines = 0;
    let newLines = 0;
    for (const row of fallback) {
      if (row.kind !== 'add') oldLines = Math.max(oldLines, row.oldN);
      if (row.kind !== 'del') newLines = Math.max(newLines, row.newN);
    }
    // Preserve the old split-based gutter width, including its trailing empty
    // line, without allocating arrays of every input line on the page.
    const max = Math.max(1, oldLines + (oldStr.endsWith('\n') ? 1 : 0), newLines + (newStr.endsWith('\n') ? 1 : 0));
    return { rows: fallback, hunkBoundaries: new Set<number>(), maxLineNum: max };
  }, [oldStr, newStr, structuredPatch, background, job.rows]);

  const total = rows.length;
  const [open, setOpen] = useState(() => getInitialExpanded());
  useExpandAllToggle(() => setOpen(true), () => setOpen(false));
  // `fill` hands height control to the host wrapper: no internal cap, no button.
  const overflow = !fill && total > DIFF_PREVIEW_LINES;
  const expanded = overflow && open;
  const boxRef = useRef<HTMLDivElement>(null);
  // WHY three states instead of one max-height box holding every row (D1,
  // Destin 2026-09-18): collapsed used to DRAW all rows and hide most behind a
  // 300px cap — a 5,000-line edit drew 5,000 rows to show 15.
  //  - collapsed: a real slice of DIFF_PREVIEW_LINES rows, nothing hidden.
  //  - expanded: a 45vh scroller (the same cap the git timeline gives a diff)
  //    filled FILE_BOX_CHUNK rows at a time as it is scrolled — never the whole
  //    file. Ctrl+O expand-all therefore costs 200 rows per box, not everything.
  //  - unloaded: "Show less" drops back to the slice (the resetKey flips, so
  //    re-expanding starts at one chunk again); a box scrolled far away in the
  //    chat is dropped whole by the chat's entry folding (use-entry-folding.ts)
  //    and remounts collapsed via getInitialExpanded(). That fold IS the
  //    off-screen unload path — do not add an observer that shrinks this window
  //    while off screen: it would fight the fold, and shrinking a window the
  //    user is scrolled inside loses their place.
  const reveal = useChunkedReveal(rows, {
    resetKey: fill ? 'fill' : expanded ? 'expanded' : 'collapsed',
    rootRef: fill ? NO_ROOT : boxRef,
    active: fill || expanded,
    chunk: FILE_BOX_CHUNK,
  });
  // Slices always start at 0, so `idx` below is the ORIGINAL row index and
  // hunkBoundaries.has(idx) stays aligned without re-indexing.
  const drawn = fill || expanded ? reveal.visible : overflow ? rows.slice(0, DIFF_PREVIEW_LINES) : rows;
  const showSentinel = (fill || expanded) && reveal.hasMore;

  if (job.loading) return <div className={DIFF_FRAME}><div className="p-2"><LoadingState what="comparison" /></div></div>;
  if (job.error) return <ErrorState message={job.error} onRetry={job.retry} />;

  const gutterWidth = Math.max(2, String(maxLineNum).length);
  const gutterCh = `calc(${gutterWidth}ch + 0.75rem)`;

  return (
    <>
      <div className={DIFF_FRAME}>
      <div
        ref={boxRef}
        // WHY one base string: collapsed/fill draw exactly what fits (a 15-row
        // slice, or a host-driven reveal) so there is nothing to scroll inside
        // THIS box — only the expanded scroller needs `overflow-auto` + the cap
        // (review round 1, 2026-09-18).
        className={expanded ? `${DIFF_BOX_BASE} scroll-mask-y overflow-auto scroll-box-cap` : DIFF_BOX_BASE}
      >
        {drawn.map((row, idx) => {
          const showSeparator = hunkBoundaries.has(idx);
          const lineNum = row.kind === 'del' ? String(row.oldN) : String(row.newN);
          const rowClass =
            row.kind === 'del'
              ? 'bg-red-400/10 border-l-[3px] border-red-500'
              : row.kind === 'add'
                ? 'bg-green-400/10 border-l-[3px] border-green-400'
                : 'border-l-[3px] border-transparent';
          const glyph = row.kind === 'del' ? '−' : row.kind === 'add' ? '+' : ' ';
          // WHY the − / + in the text colour (known deviations fixed by existing rules,
          // 2026-10-13): principle 2 and the status-colour sweep (small-fixes-3#SF3-10) keep
          // status hues out of text — words in the normal colour, the colour in a tint or a
          // bar. The row's red / green tint and left bar already say removed / added; the
          // glyphs were red and green text on top of them. The same rows draw the Edit tool
          // card's diff, so its marks change too (colour only).
          const glyphClass = row.kind === 'ctx' ? 'text-fg-muted' : 'text-fg-2 font-bold';
          const textClass = row.kind === 'ctx' ? 'text-fg-dim' : 'text-fg';
          return (
            <React.Fragment key={idx}>
              {showSeparator && (
                <div className="flex items-center text-fg-muted text-3xs border-y border-edge-dim bg-inset/40 select-none">
                  <span className="px-2 py-0.5">⋯</span>
                </div>
              )}
              <div className={`flex items-start ${rowClass}`}>
                <span
                  className="text-right px-1.5 py-0.5 text-fg-muted select-none shrink-0 whitespace-nowrap"
                  style={{ width: gutterCh }}
                >
                  {lineNum}
                </span>
                <span className={`w-4 select-none shrink-0 ${glyphClass}`}>{glyph}</span>
                <span className={`py-0.5 pr-2 whitespace-pre-wrap break-all flex-1 ${textClass}`}>{row.text || ' '}</span>
              </div>
            </React.Fragment>
          );
        })}
        {showSentinel && <div ref={reveal.sentinelRef} data-reveal-sentinel className="h-px" aria-hidden />}
      </div>
      </div>
      {overflow && (
        <button
          onClick={() => setOpen(o => !o)}
          // WHY: drop the spaced-caps eyebrow (labels batch, guide: no spaced
          // capitals). Not exempt as a "file viewer" — this is a generic
          // expand toggle shared across git review and the session-context
          // popup, not the dedicated file-content viewer.
          className="mt-1 text-xs text-fg-muted hover:text-fg-2"
        >
          {/* Wording matches CollapsibleBlock (ToolBody.tsx) so every long box in a card reads the same. */}
          {open ? 'Show less' : `Show ${total - DIFF_PREVIEW_LINES} more lines`}
        </button>
      )}
    </>
  );
}
