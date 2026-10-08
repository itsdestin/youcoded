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
import { CARD_LEVEL_1 } from '../src/renderer/components/ui/cardLevels';

describe('FoldRow', () => {
  it('shows its content inside the same box as its header row', () => {
    render(<FoldRow title="Sync log"><p>line one</p></FoldRow>);
    const header = screen.getByRole('button', { name: 'Sync log' });
    fireEvent.click(header);
    const box = header.parentElement!;
    expect(box.contains(screen.getByText('line one'))).toBe(true);
    for (const c of CARD_LEVEL_1.split(' ')) expect(box.className).toContain(c);
  });

  it('draws the header row without a box of its own, so the box is not doubled', () => {
    render(<FoldRow title="Sync log"><p>x</p></FoldRow>);
    expect(screen.getByRole('button', { name: 'Sync log' }).className).not.toMatch(/\bborder\b/);
  });
});

describe('FoldRow hover', () => {
  it('lets the header row fill the box and take its rounded corners, so its hover tint is not a square strip', () => {
    // Destin, submit-ticket-3#ST3-5: "the highlight/hover effect is weird there on the
    // header. not rounded or whatever."
    render(<FoldRow title="Sync log"><p>x</p></FoldRow>);
    const header = screen.getByRole('button', { name: 'Sync log' });
    expect(header.className).toMatch(/\brounded-lg\b/);
    expect(header.className).toMatch(/\bpx-3\b/);
    expect(header.parentElement!.className).not.toMatch(/\bp[xy]?-\d/);
    fireEvent.click(header);
    expect(header.className).toMatch(/\brounded-t-lg\b/);
  });
});
