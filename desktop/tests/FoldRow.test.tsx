// @vitest-environment jsdom
// The shared fold-out row opens INSIDE its own box.
//
// WHY (Destin, submit-ticket-1#ST-3: "an expandable card should always contain expanded
// content within itself, not open a new separate card below"; every fold, submit-ticket-2
// #ST2-Q1): the opened content used to be a sibling under the boxed row, so it read as loose
// text or a second card — About's Privacy and Licenses, Performance, Backup & sync's Sync log
// and the status bar's Theme cycle all showed it.
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FoldRow } from '../src/renderer/components/ui';

describe('FoldRow', () => {
  it('shows its content inside the same box as its header row', () => {
    render(<FoldRow title="Sync log"><p>line one</p></FoldRow>);
    const header = screen.getByRole('button', { name: 'Sync log' });
    fireEvent.click(header);
    const box = header.parentElement!;
    expect(box.contains(screen.getByText('line one'))).toBe(true);
  });
});
