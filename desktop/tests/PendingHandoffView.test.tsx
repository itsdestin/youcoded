// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PendingHandoffView from '../src/renderer/components/PendingHandoffView';
import type { PendingTab } from '../src/renderer/state/pending-handoff';

vi.mock('../src/renderer/components/SessionPreviewPane', () => ({
  default: ({ title }: { title: string }) => <div data-testid="saved-preview">{title}</div>,
}));
vi.mock('../src/renderer/components/SessionDrawer', () => ({
  SessionDrawer: ({ sessionId }: { sessionId: string }) => <aside data-testid="session-drawer">{sessionId}</aside>,
}));
vi.mock('../src/renderer/hooks/useActiveProject', () => ({ useActiveProject: () => null }));
const tab: PendingTab = { tabId: 'pending-handoff:one', conversationId: 'conversation', provider: 'claude',
  projectSlug: 'project', cwd: '/project', name: 'Saved conversation', phase: 'waiting' };
afterEach(cleanup);

describe('pending handoff chat frame', () => {
  it('uses the existing right slot when the drawer is open, preserving chat-column notice width', () => {
    const { container } = render(<PendingHandoffView tab={tab} visible onRetry={vi.fn()} onContinue={vi.fn()}
      drawerOpen expanded gamePane={null} />);
    expect(container.querySelector('.framed-shell.drawer-open.drawer-expanded')).not.toBeNull();
    expect(container.querySelector('.chat-pane .handoff-freshness-toast')).not.toBeNull();
    expect(screen.getByTestId('session-drawer').textContent).toBe(tab.tabId);
    expect(container.querySelector('.frame-divider + .drawer-pane')).not.toBeNull();
    expect(screen.getByTestId('saved-preview').textContent).toBe('Saved conversation');
  });

  it('keeps the game in the same right slot instead of duplicating the artifact drawer', () => {
    const { container } = render(<PendingHandoffView tab={tab} visible onRetry={vi.fn()} onContinue={vi.fn()}
      drawerOpen expanded gamePane={<div data-testid="game">Game</div>} />);
    expect(screen.getByTestId('game')).toBeTruthy();
    expect(screen.queryByTestId('session-drawer')).toBeNull();
    expect(container.querySelector('.framed-shell.drawer-expanded')).toBeNull();
    expect(container.querySelector('.drawer-pane.game-pane')).not.toBeNull();
  });

  it('shows an actionable failure, never the approved incomplete notice for terminal errors', () => {
    const retry = vi.fn();
    const { container } = render(<PendingHandoffView tab={{ ...tab, phase: 'failed' }} visible onRetry={retry} onContinue={vi.fn()}
      drawerOpen={false} expanded={false} gamePane={null} />);
    expect(screen.queryByText('This conversation may have newer messages on your other computer.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.queryByText('This conversation may have newer messages on your other computer.')).toBeNull();
  });
});
