// @vitest-environment jsdom
/**
 * The terminal touch box keeps what you typed when it cannot send it.
 *
 * Error inventory 2026-09-10, false message 6. In terminal-touch mode (`minimal`), Enter
 * called `session.sendInput(...)` and then `setText('')` unconditionally. Over remote
 * access, `session:input` is a user action the shim REFUSES while the connection is down
 * (remote-shim.ts MESSAGE_KIND) — so the box cleared as if the text had been sent, and the
 * words were gone. The regular composer already asks `session.canSend()` first and says
 * "Not connected — your message is still here." This Enter path skipped that check.
 */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ChatProvider } from '../src/renderer/state/chat-context';
import { SkillProvider } from '../src/renderer/state/skill-context';
import InputBar from '../src/renderer/components/InputBar';

class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }

const NOT_CONNECTED = 'Not connected — your message is still here. Send it again when you reconnect.';

function stub(canSend: boolean) {
  (window as any).claude = {
    session: { sendInput: vi.fn(), canSend: () => canSend },
    skills: {
      list: vi.fn().mockResolvedValue([]),
      getFavorites: vi.fn().mockResolvedValue([]),
      getChips: vi.fn().mockResolvedValue([]),
      getCuratedDefaults: vi.fn().mockResolvedValue([]),
    },
  };
  return (window as any).claude.session.sendInput as ReturnType<typeof vi.fn>;
}

function renderTouchBox(onToast: (msg: string) => void) {
  render(
    <ChatProvider>
      <SkillProvider>
        <InputBar sessionId="sess-1" provider="claude" minimal onToast={onToast} />
      </SkillProvider>
    </ChatProvider>,
  );
  return screen.getByRole('textbox') as HTMLTextAreaElement;
}

describe('InputBar terminal-touch Enter — nothing is lost while disconnected', () => {
  beforeEach(() => { (global as any).ResizeObserver = NoopResizeObserver; });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); delete (window as any).claude; });

  it('while disconnected, Enter sends nothing, keeps the text and says so', () => {
    const sendInput = stub(false);
    const onToast = vi.fn();
    const box = renderTouchBox(onToast);

    fireEvent.change(box, { target: { value: 'git status' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(sendInput).not.toHaveBeenCalled();
    expect(box.value).toBe('git status');
    expect(onToast).toHaveBeenCalledWith(NOT_CONNECTED);
  });

  it('while connected, Enter still sends the line and clears the box', () => {
    const sendInput = stub(true);
    const box = renderTouchBox(vi.fn());

    fireEvent.change(box, { target: { value: 'git status' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(sendInput).toHaveBeenCalledWith('sess-1', 'git status\r');
    expect(box.value).toBe('');
  });
});
