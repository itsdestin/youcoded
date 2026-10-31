// @vitest-environment jsdom
/**
 * Ask first, websites (2026-10-31): the permission card for a native WebFetch asks
 * "Visit <site>?", folds the site the same way the engine does, and keeps the generic
 * Yes / Always allow / No answers unchanged (what is SENT is what every other card sends).
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

const fetchAsk = (over: Partial<ToolCallState> = {}): ToolCallState => ({
  id: 'tool-1', toolName: 'WebFetch', input: { url: 'https://www.Example.com/docs/page' },
  status: 'awaiting-approval', requestId: 'native-web1', permissionMode: 'ask', ...over,
} as ToolCallState);
const renderCard = (tool: ToolCallState) =>
  // WHY: ToolCard reads the folder from the store by sessionId; it has no sessionCwd prop.
  render(<ChatProvider><ToolCard tool={tool} sessionId="s1" /></ChatProvider>);

describe('website ask card', () => {
  it('names the site plainly and says what each answer covers', () => {
    renderCard(fetchAsk());
    expect(screen.getByText('Visit example.com?')).toBeTruthy();
    const note = screen.getByText((_, el) => el?.tagName === 'P' && /^Yes lets the assistant visit example\.com for the rest of this chat\. Always allow remembers example\.com/.test(el.textContent ?? ''));
    expect(note).toBeTruthy();
  });

  it('sends the same plain answers as every other native card', async () => {
    renderCard(fetchAsk());
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(respondToPermission).toHaveBeenCalledWith('native-web1', { decision: { behavior: 'allow' } }));
  });

  it('Always allow sends a selector only (the app, not the card, builds the site rule)', async () => {
    renderCard(fetchAsk());
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }));
    await waitFor(() => expect(respondToPermission).toHaveBeenCalledTimes(1));
    const sent = respondToPermission.mock.calls[0][1];
    expect(sent.decision).toEqual({ behavior: 'allow' });
    expect(JSON.stringify(sent)).not.toContain('example.com');
  });

  it('leaves Claude Code asks and other tools alone', () => {
    renderCard(fetchAsk({ requestId: 'cc-123', permissionSuggestions: ['x'] } as any));
    expect(screen.queryByText(/^Visit /)).toBeNull();
    cleanup();
    renderCard(fetchAsk({ toolName: 'Bash', input: { command: 'ls' } }));
    expect(screen.queryByText(/^Visit /)).toBeNull();
  });
});
