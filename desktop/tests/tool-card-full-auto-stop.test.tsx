// @vitest-environment jsdom
/**
 * Pins the full-auto safety-stop footer (ToolCard.tsx; spec 2026-08-12, M5 2b).
 *
 * Condition, exactly: permissionMode === 'full-auto' && denyListed. Everything
 * else — ask/auto-edit modes, CC asks with no mode, external asks, budget
 * gates — keeps the generic row, and the suites for those pin it from their
 * side. The footer re-labels the SAME decisions (allow once / deny / open the
 * consequence confirm); it must never change what is sent.
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

afterEach(cleanup);

const stopTool = (over: Partial<ToolCallState> = {}): ToolCallState => ({
  id: 'tool-1',
  toolName: 'Bash',
  input: { command: 'git push origin master' },
  status: 'awaiting-approval',
  requestId: 'native-abc123',
  denyListed: true,
  permissionMode: 'full-auto',
  ...over,
} as ToolCallState);

const renderCard = (tool: ToolCallState) =>
  render(<ChatProvider><ToolCard tool={tool} sessionId="s1" /></ChatProvider>);

describe('full-auto safety stop', () => {
  it('renders Run it / Skip it / Always Allow with the per-family copy', () => {
    renderCard(stopTool());
    expect(screen.getByRole('button', { name: 'Run it' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skip it' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Always Allow' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^yes$/i })).toBeNull();
    expect(screen.getByText('Stopped before pushing code')).toBeTruthy();
    expect(
      screen.getByText('Full auto still stops here — this changes your published code.'),
    ).toBeTruthy();
  });

  it('keeps the generic row for ask-mode + denyListed', () => {
    renderCard(stopTool({ permissionMode: 'ask' }));
    expect(screen.getByRole('button', { name: /^yes$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Always Allow' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run it' })).toBeNull();
  });

  it('keeps the generic row when permissionMode is absent (CC asks and old remote peers)', () => {
    renderCard(stopTool({ permissionMode: undefined }));
    expect(screen.getByRole('button', { name: /^yes$/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run it' })).toBeNull();
  });

  it('Run it sends a plain allow; Skip it sends a deny — labels change, decisions do not', async () => {
    renderCard(stopTool());
    fireEvent.click(screen.getByRole('button', { name: 'Run it' }));
    await waitFor(() => expect(respondToPermission).toHaveBeenCalledTimes(1));
    expect(respondToPermission.mock.calls[0][1]).toEqual({ decision: { behavior: 'allow' } });

    cleanup();
    respondToPermission.mockClear();
    renderCard(stopTool());
    fireEvent.click(screen.getByRole('button', { name: 'Skip it' }));
    await waitFor(() => expect(respondToPermission).toHaveBeenCalledTimes(1));
    expect(respondToPermission.mock.calls[0][1]).toEqual({ decision: { behavior: 'deny' } });
  });

  it('Always Allow opens the shared consequence confirm — new copy, command echoed, nothing sent yet', () => {
    renderCard(stopTool());
    fireEvent.click(screen.getByRole('button', { name: 'Always Allow' }));
    expect(respondToPermission).not.toHaveBeenCalled();
    // M5 2c: the heading names what is actually granted. This command's only
    // option is the branch grant, so "this exact command" would be false —
    // approving it also covers `git push -u origin master`.
    expect(screen.getByText(/Always allow pushing to master/)).toBeTruthy();
    expect(screen.getByText('git push origin master')).toBeTruthy();
    expect(screen.getByText(/deleting or force-pushing the branch/)).toBeTruthy();
    expect(
      screen.getByText("This can delete files or change published code, and you won't be asked again in this project."),
    ).toBeTruthy();
  });

  it('falls back to the generic header when the command is unclassifiable', () => {
    // Deny-listed per the engine but not matching any family copy row — the
    // footer must degrade honestly rather than invent a consequence.
    renderCard(stopTool({ input: {} }));
    expect(screen.getByText('Stopped before a risky command')).toBeTruthy();
    expect(screen.getByText('Full auto still stops here.')).toBeTruthy();
  });
});

// The removal-target floor (harness rm-target.ts) forces a stop no saved grant
// can skip, so the band must not offer a grant it could never honour.
describe('full-auto stop for a removal the floor always asks about', () => {
  it('shows Run it / Skip it and no Always Allow', () => {
    renderCard(stopTool({ input: { command: 'rm -rf ~' }, noAlwaysAllow: true }));
    expect(screen.getByRole('button', { name: 'Run it' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skip it' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Always Allow' })).toBeNull();
    expect(screen.getByText('Stopped before deleting files')).toBeTruthy();
  });

  it('the generic row hides Always allow for the same ask outside Full auto', () => {
    renderCard(stopTool({ input: { command: 'rm -rf ~' }, noAlwaysAllow: true, permissionMode: 'ask' }));
    expect(screen.getByRole('button', { name: /^yes$/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /always/i })).toBeNull();
  });
});
