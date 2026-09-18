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

  it('shows a truncation note (XlsxView wording) once columns exceed the cap', () => {
    const { getByText } = render(<CsvView {...baseProps(makeCsv(300))} />);
    expect(getByText(/showing the first 2,000 rows × 100 columns/)).toBeTruthy();
  });

  it('renders every column and no truncation note under the cap', () => {
    const { container, queryByText } = render(<CsvView {...baseProps(makeCsv(10))} />);
    const dataCols = container.querySelectorAll('colgroup col').length - 1;
    // colCount pads out to MIN_COLS (26) even when the file has fewer.
    expect(dataCols).toBe(26);
    expect(queryByText(/showing the first/)).toBeNull();
  });
});
