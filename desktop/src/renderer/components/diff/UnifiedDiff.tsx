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
// - Long diffs cap at DIFF_PREVIEW_LINES rows with an Expand button.
import React, { useMemo, useState } from 'react';
import { diffLines as jsdiffLines } from 'diff';
import type { StructuredPatchHunk } from '../../../shared/types';
import { useExpandAllToggle, getInitialExpanded } from '../../hooks/useExpandAllToggle';

const DIFF_ROW_PX = 20;
const DIFF_PREVIEW_LINES = 15;

// Unified-diff row: del = removed line (old side only), add = inserted line
// (new side only), ctx = unchanged (shown on both sides, dimmed). Line numbers
// reflect the line's real position within the compared strings (or, via
// structuredPatch hunks, absolute file positions).
export type DiffRow =
  | { kind: 'ctx'; oldN: number; newN: number; text: string }
  | { kind: 'del'; oldN: number; text: string }
  | { kind: 'add'; newN: number; text: string };

/** jsdiff-based replacement for the old hand-rolled LCS fallback. Line numbers
 * are relative to the two strings (1-indexed), matching the previous shape. */
export function diffRowsFromStrings(oldStr: string, newStr: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldN = 1;
  let newN = 1;
  // Normalize a missing EOF newline: jsdiff tokenizes lines WITH their
  // terminator, so 'a' vs 'a\nb' would report line 1 as changed ('a' ≠ 'a\n').
  // The previous LCS split on '\n' and never saw the difference — keep that
  // (an EOF-newline-only change is noise at this row granularity).
  const oldNorm = oldStr.length > 0 && !oldStr.endsWith('\n') ? oldStr + '\n' : oldStr;
  const newNorm = newStr.length > 0 && !newStr.endsWith('\n') ? newStr + '\n' : newStr;
  for (const change of jsdiffLines(oldNorm, newNorm)) {
    const lines = change.value.split('\n');
    // jsdiff keeps the trailing newline in `value`, which split() turns into a
    // phantom empty final line — drop it (a REAL trailing empty line inside a
    // change is preserved because only the terminator-produced one is last).
    if (lines[lines.length - 1] === '') lines.pop();
    for (const text of lines) {
      if (change.added) rows.push({ kind: 'add', newN: newN++, text });
      else if (change.removed) rows.push({ kind: 'del', oldN: oldN++, text });
      else rows.push({ kind: 'ctx', oldN: oldN++, newN: newN++, text });
    }
  }
  return rows;
}

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
   *  timeline caps each diff at 45vh), the internal 15-line preview cap and its
   *  "Expand" button are redundant — they stack a second scrollbar inside the
   *  host's and the "Expand" click barely moves anything. `fill` renders every
   *  row at full height and drops the button so the HOST is the sole scroll
   *  surface for the diff text. */
  fill?: boolean;
}) {
  // Prefer Claude Code's pre-computed hunks (absolute file line numbers).
  // Fall back to a jsdiff line diff when no structured result exists yet.
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
    const fallback = diffRowsFromStrings(oldStr, newStr);
    return {
      rows: fallback,
      hunkBoundaries: new Set<number>(),
      maxLineNum: Math.max(oldStr.split('\n').length, newStr.split('\n').length),
    };
  }, [oldStr, newStr, structuredPatch]);

  const total = rows.length;
  const [open, setOpen] = useState(() => getInitialExpanded());
  useExpandAllToggle(() => setOpen(true), () => setOpen(false));
  // `fill` hands height control to the host wrapper: no internal cap, no button.
  const overflow = !fill && total > DIFF_PREVIEW_LINES;
  const containerStyle = open || !overflow
    ? undefined
    : { maxHeight: `${DIFF_PREVIEW_LINES * DIFF_ROW_PX}px` };

  const gutterWidth = Math.max(2, String(maxLineNum).length);
  const gutterCh = `calc(${gutterWidth}ch + 0.75rem)`;

  return (
    <>
      <div
        className="text-xs font-mono rounded-sm border border-edge overflow-auto"
        style={containerStyle}
      >
        {rows.map((row, idx) => {
          const showSeparator = hunkBoundaries.has(idx);
          const lineNum = row.kind === 'del' ? String(row.oldN) : String(row.newN);
          const rowClass =
            row.kind === 'del'
              ? 'bg-red-400/10 border-l-[3px] border-red-500'
              : row.kind === 'add'
                ? 'bg-green-400/10 border-l-[3px] border-green-400'
                : 'border-l-[3px] border-transparent';
          const glyph = row.kind === 'del' ? '−' : row.kind === 'add' ? '+' : ' ';
          const glyphClass =
            row.kind === 'del'
              ? 'text-red-400 font-bold'
              : row.kind === 'add'
                ? 'text-green-400 font-bold'
                : 'text-fg-muted';
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
      </div>
      {overflow && (
        <button
          onClick={() => setOpen(o => !o)}
          className="mt-1 text-3xs text-fg-muted tracking-wider uppercase hover:text-fg-2"
        >
          {open ? 'Collapse' : `Expand (${total} lines)`}
        </button>
      )}
    </>
  );
}
