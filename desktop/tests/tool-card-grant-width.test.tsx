// @vitest-environment jsdom
/**
 * The Always-allow WIDTH choice on a native Bash ask (M5 2c).
 *
 * Shape settled in compare round 1 (candidate B): the card keeps exactly one
 * "Always allow" button and never changes shape; the choice — and the sentence
 * saying what the grant will not cover — live in the confirm behind it. Copy
 * settled in round 2 (candidate C).
 *
 * The card sends a SELECTOR, never a pattern: the session re-derives the rule,
 * because remembered rules outrank the destructive deny-list and a renderer that
 * could name its own pattern could grant itself anything.
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

const askTool = (command: string, over: Partial<ToolCallState> = {}): ToolCallState => ({
  id: 'tool-1',
  toolName: 'Bash',
  input: { command },
  status: 'awaiting-approval',
  requestId: 'native-abc123',   // the 'native-' prefix IS the native discriminator
  denyListed: false,
  ...over,
} as ToolCallState);

function renderAsk(command: string, over: Partial<ToolCallState> = {}) {
  return render(<ChatProvider><ToolCard tool={askTool(command, over)} sessionId="s1" /></ChatProvider>);
}
const alwaysAllowButton = () => screen.queryByRole('button', { name: 'Always allow' });
const openConfirm = () => fireEvent.click(screen.getByRole('button', { name: 'Always allow' }));
const commit = () => fireEvent.click(screen.getByRole('button', { name: 'Always allow' }));

describe('grant width — what the card sends', () => {
  it('sends grantScope "exact" when the narrow option is chosen (the default)', async () => {
    renderAsk('npm run build');
    openConfirm();
    commit();
    await waitFor(() => expect(respondToPermission).toHaveBeenCalledTimes(1));
    expect(respondToPermission.mock.calls[0][1]).toMatchObject({ grantScope: 'exact' });
  });

  it('sends grantScope "wide" when the wider option is picked', async () => {
    renderAsk('npm run build');
    openConfirm();
    fireEvent.click(screen.getByText('Any npm run command'));
    commit();
    await waitFor(() => expect(respondToPermission).toHaveBeenCalledTimes(1));
    expect(respondToPermission.mock.calls[0][1]).toMatchObject({ grantScope: 'wide' });
  });

  it('sends "wide" with no chooser at all when the named grant is the only option', async () => {
    // A push offers one option — its exact rung would say the same thing.
    renderAsk('git push origin feat/x', { denyListed: true });
    openConfirm();
    expect(screen.queryByRole('radio')).toBeNull();
    commit();
    await waitFor(() => expect(respondToPermission).toHaveBeenCalledTimes(1));
    expect(respondToPermission.mock.calls[0][1]).toMatchObject({ grantScope: 'wide' });
  });

  it('never sends a pattern — only the selector and the native marker', async () => {
    renderAsk('git push origin feat/x', { denyListed: true });
    openConfirm();
    commit();
    await waitFor(() => expect(respondToPermission).toHaveBeenCalledTimes(1));
    const [, decision] = respondToPermission.mock.calls[0];
    expect(JSON.stringify(decision)).not.toContain('git push*');
  });
});

describe('grant width — what the card shows', () => {
  it('names the grant in the heading when the only option is a named one', () => {
    renderAsk('git push origin feat/x', { denyListed: true });
    openConfirm();
    // NOT "this exact command" — that sentence is false for a branch grant.
    expect(screen.getByText(/Always allow pushing to feat\/x/)).toBeTruthy();
    expect(screen.queryByText(/exact command/)).toBeNull();
  });

  it('asks a neutral question when there are two options to choose between', () => {
    renderAsk('npm run build');
    openConfirm();
    expect(screen.getByText(/^Always allow this\??$/)).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('states what a named grant will NOT cover', () => {
    renderAsk('git push origin feat/x', { denyListed: true });
    openConfirm();
    expect(screen.getByText(/deleting or force-pushing the branch/)).toBeTruthy();
  });

  it('states what an ordinary grant will not cover', () => {
    renderAsk('npm run build');
    openConfirm();
    expect(screen.getByText(/chained onto another one/)).toBeTruthy();
  });

  it('does not warn about deleting files on a command that is not deny-listed', () => {
    // The shipped consequence line is gated on denyListed. Showing "may delete
    // files or change published code" over `npm run build` would be a misleading
    // error message in a different costume.
    renderAsk('npm run build');
    openConfirm();
    expect(screen.queryByText(/may delete files/)).toBeNull();
  });

  it('still warns on a deny-listed command', () => {
    renderAsk('rm -rf build', { denyListed: true });
    openConfirm();
    expect(screen.getByText(/can delete files/)).toBeTruthy();
  });
});

describe('grant width — when nothing may be granted', () => {
  it('offers no Always allow at all, and says why', () => {
    renderAsk('git push', { denyListed: true });
    expect(alwaysAllowButton()).toBeNull();
    expect(screen.getByText(/whichever branch is checked out/)).toBeTruthy();
    // Yes/No still work — the ask is answerable, just not memorable.
    expect(screen.getByRole('button', { name: 'Yes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'No' })).toBeTruthy();
  });

  it('keeps the button for a command that merely cannot be widened', () => {
    renderAsk('rm -rf build', { denyListed: true });
    expect(alwaysAllowButton()).toBeTruthy();
  });
});

describe('grant width — surfaces that must not change', () => {
  it('a CC-path ask sends no grantScope and shows no chooser', async () => {
    render(
      <ChatProvider>
        <ToolCard
          tool={{
            id: 't', toolName: 'Bash', input: { command: 'npm run build' },
            status: 'awaiting-approval', requestId: 'hook-1',
            permissionSuggestions: ['Bash(npm run build:*)'],
          } as ToolCallState}
          sessionId="s1"
        />
      </ChatProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }));
    await waitFor(() => expect(respondToPermission).toHaveBeenCalledTimes(1));
    expect(respondToPermission.mock.calls[0][1]).not.toHaveProperty('grantScope');
  });

  it('a native NON-Bash ask is untouched — no options, no note, button intact', () => {
    render(
      <ChatProvider>
        <ToolCard
          tool={{
            id: 't', toolName: 'Write', input: { file_path: 'src/a.ts', content: 'x' },
            status: 'awaiting-approval', requestId: 'native-1', denyListed: false,
          } as ToolCallState}
          sessionId="s1"
        />
      </ChatProvider>,
    );
    expect(alwaysAllowButton()).toBeTruthy();
    expect(screen.queryByText(/whichever branch/)).toBeNull();
  });
});
