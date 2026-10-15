// @vitest-environment jsdom
// Review F4 (Destin picked "preview", 2026-10-14): the new-conversation window a
// page opens shows the page's whole message, read-only, ABOVE the project /
// model / permission choices, so it is read before Create Session. And when the
// chat opens, the caret sits at the START of that message, so a long one shows
// its beginning rather than its tail. Normal new-session windows are unchanged.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, renderHook, waitFor } from '@testing-library/react';

// The form itself (folder, model, toggle) is pinned elsewhere; a stub keeps this
// test about what the dialog adds around it.
vi.mock('../src/renderer/components/buddy/BuddyNewSessionForm', () => ({
  BuddyNewSessionForm: () => <div data-testid="new-session-form">form</div>,
}));

import { PageCreateDialog, usePageCreate } from '../src/renderer/components/pages/PageCreateDialog';
import InputBar from '../src/renderer/components/InputBar';
import { ChatProvider } from '../src/renderer/state/chat-context';
import { SkillProvider } from '../src/renderer/state/skill-context';

class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }

const LONG = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of the weekly briefing.`).join('\n');

beforeEach(() => {
  (globalThis as any).ResizeObserver = NoopResizeObserver;
  (window as any).claude = {
    native: { supported: true, send: vi.fn().mockResolvedValue({ status: 'sent' }) },
    session: { sendInput: vi.fn() },
    skills: {
      list: vi.fn().mockResolvedValue([]), getFavorites: vi.fn().mockResolvedValue([]),
      getChips: vi.fn().mockResolvedValue([]), getCuratedDefaults: vi.fn().mockResolvedValue([]),
    },
  };
});
afterEach(cleanup);

function openFromPage(prompt: string) {
  const { result } = renderHook(() => usePageCreate());
  act(() => { result.current[2]({ prompt, cwd: undefined, pageName: 'Frontier Lab' }); });
  return result.current[0]!;
}

describe('the message preview in a page-opened window', () => {
  it('shows the whole message, read-only, before the project and model choices', () => {
    const request = openFromPage(LONG);
    render(<PageCreateDialog request={request} onCreated={() => {}} onCancel={() => {}} onManageProjects={() => {}} />);
    const preview = screen.getByRole('region', { name: 'Message from Frontier Lab' });
    expect(preview.textContent).toBe(LONG);
    // Read-only: it is text to read, not a second box to type in.
    expect(preview.querySelector('textarea, input, [contenteditable="true"]')).toBeNull();
    // Reachable by keyboard so a long message can be scrolled without a mouse.
    expect(preview).toHaveAttribute('tabindex', '0');
    expect(screen.getByText(/waits in the message box until you press Enter/)).toBeInTheDocument();
    const form = screen.getByTestId('new-session-form');
    expect(preview.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is not shown in an ordinary Create a page window', () => {
    render(<PageCreateDialog request={{ title: 'Create a page', initialInput: '/page-builder ' }}
      onCreated={() => {}} onCancel={() => {}} onManageProjects={() => {}} />);
    expect(screen.getByTestId('new-session-form')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /Message from/ })).toBeNull();
    expect(screen.queryByText(/waits in the message box/)).toBeNull();
  });
});

describe('where the caret lands when the chat opens', () => {
  const composer = () => screen.getByPlaceholderText('Message your assistant...') as HTMLTextAreaElement;
  const mount = (sessionId: string, initialInput: string) => render(
    <ChatProvider><SkillProvider><InputBar sessionId={sessionId} provider="native" initialInput={initialInput} /></SkillProvider></ChatProvider>);

  it('puts it at the start of a message a page wrote', async () => {
    const prompt = `${LONG}\n(caret test)`;
    openFromPage(prompt);
    mount('page-started', prompt);
    await waitFor(() => expect(composer().value).toBe(prompt));
    await waitFor(() => expect(composer().selectionStart).toBe(0));
    expect(composer().selectionEnd).toBe(0);
  });

  it('keeps it at the end for any other waiting text', async () => {
    mount('ordinary', '/page-builder ');
    await waitFor(() => expect(composer().selectionStart).toBe('/page-builder '.length));
  });
});
