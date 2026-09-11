// @vitest-environment jsdom
/**
 * An approval answer that got no reply is not an "expired" request.
 *
 * Error inventory 2026-09-10, false messages 3 and 4. The approval card (PermissionButtons),
 * the question card (AskUserQuestionCard) and the buddy's compact strip all handled a
 * REJECTED respondToPermission exactly like `delivered === false`: dispatch
 * PERMISSION_EXPIRED, which marks the tool failed with "Permission request expired —
 * socket closed before a response was sent", and broadcast that to every connected device.
 * Over remote access that rejection is the 30-second timeout, which remote-shim.ts
 * documents as a request that MAY have run — so the answer could have reached the session
 * while every screen said it had expired and offered no way to answer again.
 *
 * `delivered === false` is the host saying the request is already closed; that still
 * expires (pinned below). A rejection now keeps the card answerable and says the answer
 * could not be confirmed.
 */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import ToolCard from '../src/renderer/components/ToolCard';
import { CompactToolStrip } from '../src/renderer/components/buddy/CompactToolStrip';
import { ChatProvider } from '../src/renderer/state/chat-context';
import type { ToolCallState } from '../src/shared/types';

let respond: ReturnType<typeof vi.fn>;
let broadcast: ReturnType<typeof vi.fn>;

beforeEach(() => {
  respond = vi.fn();
  broadcast = vi.fn();
  (window as any).claude = { session: { respondToPermission: respond }, remote: { broadcastAction: broadcast } };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); delete (window as any).claude; });

const TIMEOUT = new Error('Request permission:respond timed out');
const expiredWasBroadcast = () =>
  broadcast.mock.calls.some(([action]) => action?.type === 'PERMISSION_EXPIRED');

const bashAsk = (): ToolCallState => ({
  id: 'tool-b',
  toolName: 'Bash',
  input: { command: 'ls' },
  status: 'awaiting-approval',
  requestId: 'req-1',
} as unknown as ToolCallState);

const questionAsk = (): ToolCallState => ({
  id: 'tool-q',
  toolName: 'AskUserQuestion',
  input: { questions: [{ question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Blue' }, { label: 'Red' }] }] },
  status: 'awaiting-approval',
  requestId: 'req-q',
} as unknown as ToolCallState);

const renderCard = (tool: ToolCallState) => render(<ChatProvider><ToolCard tool={tool} sessionId="s1" /></ChatProvider>);

describe('approval card — an unanswered reply keeps the request answerable', () => {
  it('a Yes that got no reply is not marked expired, and says it could not be confirmed', async () => {
    respond.mockRejectedValue(TIMEOUT);
    renderCard(bashAsk());
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));

    expect(await screen.findByText(/couldn.t confirm/i)).toBeInTheDocument();
    expect(expiredWasBroadcast()).toBe(false);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Yes' })).toBeEnabled());
  });

  it('a request the host says is already closed still expires', async () => {
    respond.mockResolvedValue(false);
    renderCard(bashAsk());
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));

    await waitFor(() => expect(expiredWasBroadcast()).toBe(true));
    expect(screen.queryByText(/couldn.t confirm/i)).toBeNull();
  });
});

describe('question card — same rule', () => {
  it('a Submit that got no reply is not marked expired, and says it could not be confirmed', async () => {
    respond.mockRejectedValue(TIMEOUT);
    renderCard(questionAsk());
    fireEvent.click(screen.getByRole('button', { name: /^Blue/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    expect(await screen.findByText(/couldn.t confirm/i)).toBeInTheDocument();
    expect(expiredWasBroadcast()).toBe(false);
  });
});

describe("buddy's compact strip — same rule", () => {
  it('an Allow that got no reply is not marked expired, and says it could not be confirmed', async () => {
    respond.mockRejectedValue(TIMEOUT);
    render(<ChatProvider><CompactToolStrip tools={[bashAsk()]} sessionId="s1" /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: '✓ Allow' }));

    expect(await screen.findByText(/couldn.t confirm/i)).toBeInTheDocument();
    expect(expiredWasBroadcast()).toBe(false);
  });
});
