// @vitest-environment jsdom
// The cover over a starting Claude Code session: plain "Initializing" by
// default, the terminal-view hint after a wait, and — the moment Claude Code
// shows a dialog the app cannot turn into buttons — "Claude Code is asking
// something" with that dialog's own heading.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { InitializingCover, INIT_SLOW_WARNING_MS } from '../src/renderer/components/InitializingCover';
import { setUnreadableStartupDialog } from '../src/renderer/state/startup-dialog-store';

afterEach(() => { vi.useRealTimers(); setUnreadableStartupDialog('s1', null); });

const cover = (onOpenTerminal = vi.fn()) => render(
  <InitializingCover sessionId="s1" onOpenTerminal={onOpenTerminal}><p>Initializing session...</p></InitializingCover>,
);

describe('InitializingCover', () => {
  it('says Initializing, then offers the terminal view after the wait', () => {
    vi.useFakeTimers();
    cover();
    expect(screen.getByText('Initializing session...')).toBeTruthy();
    expect(screen.queryByText(/Something may be wrong/)).toBeNull();
    act(() => { vi.advanceTimersByTime(INIT_SLOW_WARNING_MS); });
    expect(screen.getByRole('button', { name: 'Check terminal view' })).toBeTruthy();
  });

  it('names an unreadable startup dialog at once, and its button opens terminal view', () => {
    const open = vi.fn();
    cover(open);
    act(() => { setUnreadableStartupDialog('s1', { heading: '2 new MCP servers found in this project' }); });
    expect(screen.getByText('Claude Code is asking something')).toBeTruthy();
    expect(screen.getByText(/2 new MCP servers found in this project/)).toBeTruthy();
    expect(screen.queryByText('Initializing session...')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Answer in terminal view' }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('goes back to Initializing when the dialog is gone', () => {
    cover();
    act(() => { setUnreadableStartupDialog('s1', { heading: 'x' }); });
    act(() => { setUnreadableStartupDialog('s1', null); });
    expect(screen.getByText('Initializing session...')).toBeTruthy();
  });
});
