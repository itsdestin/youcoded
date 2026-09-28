// @vitest-environment jsdom
// The touch terminal's key row must be able to ANSWER a Claude Code menu:
// Enter confirms, Space ticks a box in a multi-select (second review F2).
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TerminalToolbar from '../src/renderer/components/TerminalToolbar';

describe('TerminalToolbar', () => {
  it('has Enter and Space keys that type exactly those keys into the session', () => {
    const sendInput = vi.fn();
    (window as any).claude = { session: { sendInput } };
    render(<TerminalToolbar sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Space' }));
    expect(sendInput.mock.calls).toEqual([['s1', '\r'], ['s1', ' ']]);
  });
});
