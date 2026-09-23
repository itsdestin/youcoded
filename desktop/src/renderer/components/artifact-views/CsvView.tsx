// CsvView — spreadsheet-style grid for CSV/TSV files. Shares the theme-tinted
// "paper" visual language with XlsxView (sheet-theme.ts): column-letter + row-
// number gutters, gridlines, click-to-select, and padding out to a minimum
// grid so it reads like a sheet rather than a table floating in whitespace.
// CSV is TEXT — content arrives via the host's artifacts.get read (the same
// `content` prop MarkdownView/CodeView use); no binary IPC involved.
import { useMemo, useState, CSSProperties } from 'react';
import type { ArtifactViewProps } from './types';
import { colLetter } from './exceljs-cell';
import { detectDelimiter, parseDelimited } from './csv-parse';
import { PAPER, GUTTER_BG, GRID, GUTTER_FG, SEL, NOTE_FG, NOTE_BG, largeSheetNote } from './sheet-theme';

const MAX_ROWS = 2000;
// Safety cap — matches XlsxView (XlsxView.tsx:14-15). CSV rows have no upper
// bound on column count (a stray delimiter in one bad row inflates every
// row's max), so an agent-produced or malformed file could otherwise render
// a million-cell DOM. CsvView has no edit/save path, so clipping the display
// never loses data — the file on disk is untouched.
const MAX_COLS = 100;
const MIN_ROWS = 50;
const MIN_COLS = 26; // A … Z

export function CsvView({ path, content }: ArtifactViewProps) {
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);

  const grid = useMemo(() => {
    if (content == null) return null;
    const ext = path.split('.').pop()?.toLowerCase();
    const rows = parseDelimited(content, detectDelimiter(content, ext));
    const rowsTruncated = rows.length > MAX_ROWS;
    const usedRows = rowsTruncated ? rows.slice(0, MAX_ROWS) : rows;
    const rawCols = usedRows.reduce((m, r) => Math.max(m, r.length), 0);
    const colsTruncated = rawCols > MAX_COLS;
    const usedCols = Math.min(rawCols, MAX_COLS);
    // Clip each row too, not just colCount — a 300-column row otherwise stays
    // in memory in full even though only 100 columns ever render.
    const used = colsTruncated ? usedRows.map((r) => r.slice(0, MAX_COLS)) : usedRows;
    return {
      rows: used,
      usedCols,
      rowCount: Math.min(Math.max(used.length, MIN_ROWS), MAX_ROWS),
      colCount: Math.max(usedCols, MIN_COLS),
      truncated: rowsTruncated || colsTruncated,
      rowsTruncated,
      colsTruncated,
    };
  }, [content, path]);

  if (!grid) return <div className="flex items-center justify-center h-full text-fg-muted text-sm p-4">Loading…</div>;

  // Right-align numeric cells like a real sheet.
  const isNumeric = (v: string) => v !== '' && !Number.isNaN(Number(v));

  return (
    <div className="flex flex-col h-full" style={{ background: PAPER, color: '#1d1d1d' }}>
      <div className="flex-1 overflow-auto">
        <table style={{ borderCollapse: 'collapse', fontSize: 13, width: 'max-content' }}>
          <colgroup>
            <col style={{ width: 38 }} />
            {Array.from({ length: grid.colCount }, (_, i) => (
              <col key={i} style={{ width: 110 }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th style={gutterCornerStyle} />
              {Array.from({ length: grid.colCount }, (_, i) => (
                <th key={i} style={gutterTopStyle}>{colLetter(i + 1)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: grid.rowCount }, (_, ri) => {
              const row = grid.rows[ri];
              return (
                <tr key={ri}>
                  <th style={gutterLeftStyle}>{ri + 1}</th>
                  {Array.from({ length: grid.colCount }, (_, ci) => {
                    const value = row?.[ci] ?? '';
                    const selected = sel?.r === ri && sel?.c === ci;
                    const style: CSSProperties = {
                      border: `1px solid ${GRID}`,
                      padding: '2px 8px', height: 24, whiteSpace: 'nowrap', cursor: 'cell',
                      maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis',
                      textAlign: isNumeric(value) ? 'right' : 'left',
                      fontVariantNumeric: isNumeric(value) ? 'tabular-nums' : undefined,
                      ...(selected ? { outline: `2px solid ${SEL}`, outlineOffset: -2 } : null),
                    };
                    return (
                      <td key={ci} style={style} title={value.length > 40 ? value : undefined}
                        onClick={() => setSel({ r: ri, c: ci })}>
                        {value}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        {grid.truncated && (
          // Same wording XlsxView shows for its own row/column cap (one shared
          // function), so the two spreadsheet-style viewers read as one behavior.
          <div style={{ padding: '8px 12px', fontSize: 12, color: NOTE_FG, background: NOTE_BG }}>
            {largeSheetNote(grid.rowsTruncated, grid.colsTruncated, MAX_ROWS, MAX_COLS)}
          </div>
        )}
      </div>
    </div>
  );
}

// Sticky gutters — mirrors XlsxView's.
const gutterBase: CSSProperties = {
  background: GUTTER_BG, color: GUTTER_FG, fontWeight: 500, textAlign: 'center',
  border: `1px solid ${GRID}`, userSelect: 'none', height: 24,
};
const gutterTopStyle: CSSProperties = { ...gutterBase, position: 'sticky', top: 0, zIndex: 3 };
const gutterLeftStyle: CSSProperties = { ...gutterBase, position: 'sticky', left: 0, zIndex: 2, minWidth: 38, width: 38 };
const gutterCornerStyle: CSSProperties = { ...gutterBase, position: 'sticky', top: 0, left: 0, zIndex: 4, minWidth: 38, width: 38 };
