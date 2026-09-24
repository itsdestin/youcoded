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
import { bashNoGrantNote } from '../src/shared/bash-grant-shapes';
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
    renderCard(stopTool({ input: { command: 'rm -rf ~' }, floorStop: 'removal' }));
    expect(screen.getByRole('button', { name: 'Run it' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skip it' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Always Allow' })).toBeNull();
    expect(screen.getByText('Stopped before deleting files')).toBeTruthy();
  });

  it('the generic row hides Always allow for the same ask outside Full auto', () => {
    renderCard(stopTool({ input: { command: 'rm -rf ~' }, floorStop: 'removal', permissionMode: 'ask' }));
    expect(screen.getByRole('button', { name: /^yes$/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /always/i })).toBeNull();
  });
});

describe('full-auto stop for a command that names a secret file', () => {
  it('names the secret-file floor and offers no Always Allow', () => {
    renderCard(stopTool({ input: { command: 'cat ~/.ssh/id_rsa' }, floorStop: 'secret-path' }));
    expect(screen.getByText('Stopped before using a secret file')).toBeTruthy();
    expect(screen.getByText('Full auto still stops here — this uses a file that holds passwords or keys.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run it' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Always Allow' })).toBeNull();
  });

  it('a command the deny-list can name keeps the deny-list wording', () => {
    renderCard(stopTool({ input: { command: 'rm ~/.ssh/old_key' }, floorStop: 'secret-path' }));
    expect(screen.getByText('Stopped before deleting files')).toBeTruthy();
  });
});

// Review F7: outside Full auto a floor's card lost "Always allow" with no word
// of why. One line now says it will always ask, and the reason.
describe('Ask-mode card forced by a floor', () => {
  // Each line claims only what the floor knows (re-review N11).
  it.each([
    ['removal', 'rm -rf ~', 'Always asks: this deletes a protected folder'],
    ['removal-if-empty', 'rm -rf "$BUILD_DIR"/', 'Always asks: this could delete a protected folder if a variable in it is empty'],
    ['removal-unknown', 'rm -rf $(pwd)', "Always asks: which folder this deletes can't be known in advance"],
    ['secret-path', 'cat ~/.ssh/id_rsa', 'Always asks: this uses a file that holds passwords or keys'],
    ['secret-maybe', 'cat .env*', 'Always asks: this could read a file that holds passwords or keys'],
  ] as const)('%s explains itself in one line', (floorStop, command, line) => {
    renderCard(stopTool({ input: { command }, floorStop, permissionMode: 'ask' }));
    expect(screen.getByText(line)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /always/i })).toBeNull();
  });

  it('an ordinary ask shows no such line', () => {
    renderCard(stopTool({ input: { command: 'npm test' }, denyListed: false, permissionMode: 'ask' }));
    expect(screen.queryByText(/^Always asks:/)).toBeNull();
  });

  // The floor's line REPLACES the shape note, so the card never gives two reasons.
  it('a floor line replaces the no-grant shape note', () => {
    const shapeNote = bashNoGrantNote('git push');
    expect(shapeNote).toBeTruthy(); // sanity: this command really has a shape note
    renderCard(stopTool({ input: { command: 'git push' }, denyListed: false, permissionMode: 'ask' }));
    expect(screen.getByText(shapeNote!)).toBeTruthy();
    cleanup();
    renderCard(stopTool({ input: { command: 'git push' }, floorStop: 'secret-path', permissionMode: 'ask' }));
    expect(screen.queryByText(shapeNote!)).toBeNull();
    expect(screen.getByText('Always asks: this uses a file that holds passwords or keys')).toBeTruthy();
  });

  it('Full auto names a "could" floor as a possibility', () => {
    renderCard(stopTool({ input: { command: 'cat .env*' }, floorStop: 'secret-maybe' }));
    expect(screen.getByText('Stopped at a possible secret file')).toBeTruthy();
    expect(screen.getByText('Full auto still stops here — this could read a file that holds passwords or keys.')).toBeTruthy();
  });
});
