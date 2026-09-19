// @vitest-environment jsdom
// CsvView column cap — Task 10: a pathological/malformed CSV (or a stray
// delimiter in one row) can produce hundreds of columns; without a cap the
// grid renders one <td> per cell for every column, on every row. XlsxView
// already caps at 100 columns (XlsxView.tsx:14-15); CsvView should match it,
// and since CsvView has no edit/save path, clipping the DISPLAY never loses
// data on disk.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { CsvView } from '../src/renderer/components/artifact-views/CsvView';
import { largeSheetNote } from '../src/renderer/components/artifact-views/sheet-theme';
import type { ArtifactViewProps } from '../src/renderer/components/artifact-views/types';

afterEach(cleanup);

function baseProps(content: string): ArtifactViewProps {
  return {
    path: 'big.csv',
    content,
    absolutePath: '/tmp/big.csv',
    isEditable: false,
  };
}

// header + one data row, `cols` columns wide.
function makeCsv(cols: number): string {
  const header = Array.from({ length: cols }, (_, i) => `c${i + 1}`).join(',');
  const row = Array.from({ length: cols }, (_, i) => `${i + 1}`).join(',');
  return `${header}\n${row}`;
}

describe('CsvView — column cap', () => {
  it('renders at most 100 columns for a 300-column CSV', () => {
    const { container } = render(<CsvView {...baseProps(makeCsv(300))} />);
    // <colgroup> has one gutter <col> (row-number column) plus one per
    // rendered data column.
    const dataCols = container.querySelectorAll('colgroup col').length - 1;
    expect(dataCols).toBe(100);
  });

  it('a CSV too wide but short says only that columns were cut', () => {
    const csv = Array.from({ length: 10 }, (_, r) => Array.from({ length: 300 }, (_, c) => `${r}-${c}`).join(',')).join('\n');
    const { getByText } = render(<CsvView {...baseProps(csv)} />);
    const note = getByText(/Large sheet/).textContent!;
    expect(note).toContain('showing the first 100 columns.');
    expect(note).not.toMatch(/rows/);
  });

  // WHY the tall cases check the wording function, not a render: drawing even
  // 2,000 rows × 26 columns in jsdom took 30s+ on Windows CI and timed out, and
  // 2,000 × 100 took 28s on Linux. The short-and-wide render above proves the
  // viewer shows this function's words.
  it('a sheet too tall but narrow says only that rows were cut', () => {
    const note = largeSheetNote(true, false, 2000, 100);
    expect(note).toContain('showing the first 2,000 rows.');
    expect(note).not.toMatch(/columns/);
  });

  it('a sheet too tall AND too wide names both limits', () => {
    expect(largeSheetNote(true, true, 2000, 100)).toContain('showing the first 2,000 rows × 100 columns.');
  });

  it('renders every column and no truncation note under the cap', () => {
    const { container, queryByText } = render(<CsvView {...baseProps(makeCsv(10))} />);
    const dataCols = container.querySelectorAll('colgroup col').length - 1;
    // colCount pads out to MIN_COLS (26) even when the file has fewer.
    expect(dataCols).toBe(26);
    expect(queryByText(/showing the first/)).toBeNull();
  });
});
