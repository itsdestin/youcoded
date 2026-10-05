// Review fix 1 (2026-10-04): the windowed grid must never put a value under the wrong column letter.
// These tests lay the planned pieces out the way an HTML table does (cells go in the first free slot; a tall or
// wide cell reserves its slots) and check every drawn cell lands in its own column, with no overlap.
import { describe, it, expect } from 'vitest';
import {
  ROW_H, expandForMerges, indexMerges, planGrid, prefixSums, type GridPiece, type MergeBox,
} from '../src/renderer/components/artifact-views/sheet-window';

const ROWS = 2000, COLS = 100;
const rowOffsets = prefixSums(new Array(ROWS).fill(ROW_H));

/** HTML table placement. Returns, per drawn row, the real column of each cell, or throws on an overlap. */
function layOut(pieces: GridPiece[], colCount: number) {
  const taken = new Map<number, Set<number>>(); // table row index -> occupied slots
  const placed: Array<{ r: number; c: number; actual: number; colSpan: number; rowSpan: number }> = [];
  let tr = 0;
  for (const p of pieces) {
    const occ = taken.get(tr) ?? taken.set(tr, new Set()).get(tr)!;
    if (p.kind === 'gap') {
      // a blank spacer row is one cell across the whole table
      for (let s = 0; s < colCount; s++) expect(occ.has(s), `spacer row ${tr} collides with a tall cell above`).toBe(false);
      tr++; continue;
    }
    let cursor = 0;
    for (const it of p.items) {
      while (occ.has(cursor)) cursor++;
      const span = it.kind === 'gap' ? it.span : it.colSpan;
      const rs = it.kind === 'gap' ? 1 : it.rowSpan;
      for (let k = 0; k < rs; k++) {
        const o = taken.get(tr + k) ?? taken.set(tr + k, new Set()).get(tr + k)!;
        for (let s = cursor; s < cursor + span; s++) { expect(o.has(s), `overlap at table row ${tr + k}, slot ${s}`).toBe(false); o.add(s); }
      }
      if (it.kind === 'cell') placed.push({ r: p.r, c: it.c, actual: cursor, colSpan: it.colSpan, rowSpan: it.rowSpan });
      cursor += span;
    }
    expect(cursor, `row ${p.r} does not fill the table width`).toBeLessThanOrEqual(colCount);
    tr++;
  }
  return placed;
}

const plan = (win: { r0: number; r1: number; c0: number; c1: number }, merges: MergeBox[], pins: Array<[number, number]>) => {
  const w = expandForMerges(win, merges);
  return planGrid({ win: w, rowCount: ROWS, colCount: COLS, rowOffsets, merges, mergeIndex: indexMerges(merges), pins });
};
const expectAligned = (pieces: GridPiece[]) => {
  for (const cell of layOut(pieces, COLS)) expect(cell.actual, `cell r${cell.r} c${cell.c} landed in column ${cell.actual}`).toBe(cell.c);
};

describe('every drawn cell lands in its own column', () => {
  it('a pinned row below a tall merge whose top row is not drawn', () => {
    const merges: MergeBox[] = [{ r0: 1000, c0: 5, r1: 1004, c1: 6 }];
    expectAligned(plan({ r0: 0, r1: 49, c0: 0, c1: 11 }, merges, [[1003, 8]]));
  });
  it('a horizontal merge starting left of the window, in a pinned row', () => {
    const merges: MergeBox[] = [{ r0: 1200, c0: 1, r1: 1200, c1: 8 }];
    expectAligned(plan({ r0: 0, r1: 49, c0: 4, c1: 15 }, merges, [[1200, 20]]));
  });
  it('a pinned row that holds a merge master', () => {
    const merges: MergeBox[] = [{ r0: 700, c0: 2, r1: 703, c1: 4 }];
    expectAligned(plan({ r0: 0, r1: 49, c0: 0, c1: 11 }, merges, [[700, 2]]));
  });
  it('a merge covering the whole sheet does not force drawing everything, and nothing shifts', () => {
    const merges: MergeBox[] = [{ r0: 0, c0: 0, r1: ROWS - 1, c1: COLS - 1 }];
    const pieces = plan({ r0: 900, r1: 950, c0: 10, c1: 20 }, merges, []);
    const drawnRows = pieces.filter((p) => p.kind === 'row').length;
    expect(drawnRows).toBeLessThan(100);
    expectAligned(pieces);
    expectAligned(plan({ r0: 0, r1: 49, c0: 0, c1: 11 }, merges, []));
  });
  it('ordinary merges inside the window still span', () => {
    const merges: MergeBox[] = [{ r0: 5, c0: 2, r1: 7, c1: 4 }];
    const placed = layOut(plan({ r0: 0, r1: 49, c0: 0, c1: 11 }, merges, []), COLS);
    const m = placed.find((p) => p.r === 5 && p.c === 2)!;
    expect([m.colSpan, m.rowSpan]).toEqual([3, 3]);
    expectAligned(plan({ r0: 0, r1: 49, c0: 0, c1: 11 }, merges, []));
  });
});
