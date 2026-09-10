// @vitest-environment jsdom
// The strip above a conversation. It is the ONLY way into the panel (review-5
// Q-1 chose "never" for opening by itself), so how pressable it is matters more
// here than on a control with a second route to the same place.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SessionContextBanner } from '../src/renderer/components/SessionContextBanner';
import type { SessionContext } from '../src/shared/types';

afterEach(cleanup);

const fits: SessionContext = {
  projectInstructions: { path: '/w/CLAUDE.md', truncated: false },
  skills: [{ id: 'a', label: 'a' }], tools: ['Read'], droppedMcpServers: [],
};

describe('the whole row opens the panel', () => {
  // Destin, 2026-09-10: "i want the whole row thing to be a clickable button
  // that opens the popup." Before this, only the small Details control was
  // pressable — on a touchscreen, most of the strip did nothing.
  it('pressing the sentence opens it, not just the corner', () => {
    const onOpen = vi.fn();
    render(<SessionContextBanner context={fits} onOpen={onOpen} />);
    fireEvent.click(screen.getByText(/Started with/));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('is ONE control, not a control inside a control', () => {
    // A <button> may not contain another interactive element: browsers disagree
    // about what a nested one does, and a screen reader announces two things
    // where there is one. So "Details" wears the look and gives up the
    // mechanism — if anyone makes it a real <Button> again, this fails.
    render(<SessionContextBanner context={fits} onOpen={vi.fn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('reaches the panel from the keyboard', () => {
    const onOpen = vi.fn();
    render(<SessionContextBanner context={fits} onOpen={onOpen} />);
    const row = screen.getByRole('button');
    row.focus();
    expect(row).toHaveFocus();
    fireEvent.click(row);   // what Enter/Space dispatch on a real <button>
    expect(onOpen).toHaveBeenCalled();
  });

  it('goes amber and says so when something was left out', () => {
    const cut: SessionContext = { ...fits, skillsOffered: false, skills: [{ id: 'a', label: 'a' }] };
    render(<SessionContextBanner context={cut} onOpen={vi.fn()} />);
    expect(screen.getByText(/were left out/)).toBeInTheDocument();
    expect(screen.getByRole('button').className).toContain('border-amber-500/40');
  });
});
