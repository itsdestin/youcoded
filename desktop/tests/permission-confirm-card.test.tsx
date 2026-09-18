// @vitest-environment jsdom
/**
 * Pins the deny-listed "Always allow" consequence confirm (ToolCard.tsx).
 *
 * Two things here are easy to regress silently and expensive when they do:
 *  1. "Nevermind, allow once" must SEND a plain allow. It replaced a Cancel
 *     button that merely closed the confirm, so a careless revert turns a
 *     one-click answer back into a dead end.
 *  2. The confirm must not promise a Settings undo. There is no UI to remove a
 *     remembered rule (PermissionStore exposes only rulesFor/remember), so that
 *     claim was inaccurate on the highest-stakes prompt in the app.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import ToolCard from '../src/renderer/components/ToolCard';
import { ChatProvider } from '../src/renderer/state/chat-context';
import type { ToolCallState } from '../src/shared/types';

const respondToPermission = vi.fn().mockResolvedValue(true);

beforeEach(() => {
  respondToPermission.mockClear();
  (window as any).claude = { session: { respondToPermission }, remote: { broadcastAction: vi.fn() } };
});

// This suite mounts the same card repeatedly; auto-cleanup isn't configured
// globally, so unmount explicitly or queries match prior tests' leftover DOM.
afterEach(cleanup);

const denyListedTool = (): ToolCallState => ({
  id: 'tool-1',
  toolName: 'Bash',
  input: { command: 'git worktree remove ../wt-grep && git branch -D fix/grep' },
  status: 'awaiting-approval',
  requestId: 'native-abc123',
  denyListed: true,
} as ToolCallState);

// Open the confirm the way a user does — the confirm has no standalone entry.
function renderConfirm() {
  const utils = render(<ChatProvider><ToolCard tool={denyListedTool()} sessionId="s1" /></ChatProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Always Allow' }));
  return utils;
}

describe('deny-listed always-allow confirm', () => {
  it('gates Always Allow behind the confirm instead of responding immediately', () => {
    render(<ChatProvider><ToolCard tool={denyListedTool()} sessionId="s1" /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Always Allow' }));
    expect(respondToPermission).not.toHaveBeenCalled();
    expect(screen.getByText(/Always allow this exact command/)).toBeTruthy();
  });

  it('states the project-scoped consequence (copy shared with the full-auto stop)', () => {
    renderConfirm();
    expect(
      screen.getByText("This can delete files or change published code, and you won't be asked again in this project."),
    ).toBeTruthy();
  });

  it('echoes the exact command the remembered rule will store', () => {
    renderConfirm();
    // harness-session.ts persists input.command verbatim as the rule pattern;
    // showing anything else would misstate the grant.
    expect(screen.getByText('git worktree remove ../wt-grep && git branch -D fix/grep')).toBeTruthy();
  });

  it('"Nevermind, allow once" sends a plain allow and remembers nothing', async () => {
    renderConfirm();
    fireEvent.click(screen.getByRole('button', { name: 'Nevermind, allow once' }));
    await waitFor(() => expect(respondToPermission).toHaveBeenCalledTimes(1));
    const [, decision] = respondToPermission.mock.calls[0];
    expect(decision).toEqual({ decision: { behavior: 'allow' } });
    // No updatedPermissions key at all — that array is what the broker reads as
    // "always" (permission-broker.ts), so its absence is the whole point.
    expect(decision).not.toHaveProperty('updatedPermissions');
  });

  it('"Always allow" sends the native always marker', async () => {
    renderConfirm();
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }));
    await waitFor(() => expect(respondToPermission).toHaveBeenCalledTimes(1));
    const [, decision] = respondToPermission.mock.calls[0];
    expect(decision.decision).toEqual({ behavior: 'allow' });
    expect(decision.updatedPermissions).toEqual(['native:always-allow']);
  });

  it('does not claim the grant can be undone in Settings', () => {
    renderConfirm();
    expect(screen.queryByText(/Settings/i)).toBeNull();
  });
});
