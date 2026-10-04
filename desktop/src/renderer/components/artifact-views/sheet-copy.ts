// sheet-copy — what Ctrl+C puts on the clipboard for a selected rectangle of a spreadsheet viewer.
//
// WHY (review fix 2, 2026-10-04): the windowed grid draws only the visible cells, so the browser's own copy of a
// selection would silently return just those (about 1% of a select-all in a 2,000 x 100 sheet). Copy is built
// from the sheet's DATA instead. Format = what the old fully drawn table gave for the same selection: the shown
// text of each cell, tab between cells, newline between rows (no trailing newline). One deliberate difference:
// a cell hidden under a merged cell yields an empty field, so the columns still line up when pasted (the old DOM
// copy simply had fewer fields in that row).

export interface CopyModel {
  /** Rows / columns that hold data; the blank padding the viewers draw past them is not copied. */
  usedRows: number;
  usedCols: number;
  /** The shown text of a cell, 0-based. */
  text: (r: number, c: number) => string;
}

export function rangeToTsv(
  model: CopyModel, isCovered: (r: number, c: number) => boolean,
  r0: number, c0: number, r1: number, c1: number,
): string {
  const lastR = Math.min(r1, model.usedRows - 1), lastC = Math.min(c1, model.usedCols - 1);
  if (r0 > lastR || c0 > lastC) return '';
  const lines: string[] = [];
  for (let r = r0; r <= lastR; r++) {
    const fields: string[] = [];
    for (let c = c0; c <= lastC; c++) fields.push(isCovered(r, c) ? '' : model.text(r, c));
    lines.push(fields.join('\t'));
  }
  return lines.join('\n');
}
