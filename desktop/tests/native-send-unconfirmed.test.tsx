// @vitest-environment jsdom
/**
 * A send nobody answered is not "could not be sent".
 *
 * Error inventory 2026-09-10, false message 5. InputBar's native send toasted "The message
 * could not be sent — no response from the session host." whenever the invoke REJECTED
 * or came back with no ack. Over remote access that rejection is the 30-second timeout,
 * and remote-shim.ts documents exactly that request as "Sent, no reply, timed out: it MAY
 * have run" — so the message could already be in the conversation, while the refilled
 * draft invited sending it a second time.
 *
 * The draft is still kept (words are never thrown away); what changes is the sentence.
 * A host that ANSWERED "failed" — with a reason the app has no sentence for — is a
 * confirmed failure and says only that, without guessing "no response".
 */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ChatProvider } from '../src/renderer/state/chat-context';
import { SkillProvider } from '../src/renderer/state/skill-context';
import InputBar from '../src/renderer/components/InputBar';

class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }

function stub(send: ReturnType<typeof vi.fn>) {
  (window as any).claude = {
    native: { supported: true, send },
    session: { sendInput: vi.fn() },
    skills: {
      list: vi.fn().mockResolvedValue([]),
      getFavorites: vi.fn().mockResolvedValue([]),
      getChips: vi.fn().mockResolvedValue([]),
      getCuratedDefaults: vi.fn().mockResolvedValue([]),
    },
  };
}

function sendHello(onToast: (msg: string) => void) {
  render(
    <ChatProvider>
      <SkillProvider>
        <InputBar sessionId="sess-1" provider="native" onToast={onToast} />
      </SkillProvider>
    </ChatProvider>,
  );
  const box = screen.getByPlaceholderText('Message your assistant...') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: 'hello world' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  return box;
}

describe('InputBar native send — an unanswered send is not reported as unsent', () => {
  beforeEach(() => { (global as any).ResizeObserver = NoopResizeObserver; });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); delete (window as any).claude; });

  it('a send that got no answer says it could not confirm, and keeps the draft', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stub(vi.fn().mockRejectedValue(new Error('Request native:send timed out')));
    const onToast = vi.fn();
    const box = sendHello(onToast);

    await waitFor(() => expect(onToast).toHaveBeenCalledWith(expect.stringMatching(/couldn.t confirm/i)));
    expect(onToast).not.toHaveBeenCalledWith(expect.stringMatching(/could not be sent/i));
    await waitFor(() => expect(box.value).toBe('hello world'));
  });

  it('an ack that came back empty is treated the same way', async () => {
    stub(vi.fn().mockResolvedValue(undefined));
    const onToast = vi.fn();
    sendHello(onToast);

    await waitFor(() => expect(onToast).toHaveBeenCalledWith(expect.stringMatching(/couldn.t confirm/i)));
    expect(onToast).not.toHaveBeenCalledWith(expect.stringMatching(/no response from the session host/i));
  });

  it('a failure the host confirmed, for a reason without its own sentence, says only that', async () => {
    stub(vi.fn().mockResolvedValue({ status: 'failed', reason: 'some-reason-added-later' }));
    const onToast = vi.fn();
    sendHello(onToast);

    await waitFor(() => expect(onToast).toHaveBeenCalledWith('The message could not be sent.'));
  });
});
