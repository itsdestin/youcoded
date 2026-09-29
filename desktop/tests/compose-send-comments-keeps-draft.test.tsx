// @vitest-environment jsdom
/**
 * "Ask your assistant" (Comments mode) must never throw away a half-typed
 * message. 2026-09-28 PR review: its listener REPLACED the box's text with the
 * comments chip and sent at once, so a draft the user was typing vanished.
 * Now a waiting draft gets the chip added and nothing is sent (sending would
 * also send the unfinished words); an empty box still sends in one click.
 */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { ChatProvider } from '../src/renderer/state/chat-context';
import { SkillProvider } from '../src/renderer/state/skill-context';
import InputBar from '../src/renderer/components/InputBar';
import { genRefId, type ComposeRef } from '../src/renderer/components/context-menu/compose-ref';

class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }

function mountComposer(send: ReturnType<typeof vi.fn>) {
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
  render(
    <ChatProvider>
      <SkillProvider>
        <InputBar sessionId="sess-1" provider="native" />
      </SkillProvider>
    </ChatProvider>,
  );
  return screen.getByPlaceholderText('Message your assistant...') as HTMLTextAreaElement;
}

function askAboutComments() {
  const refs: ComposeRef[] = [{ id: genRefId(), kind: 'doc', path: 'notes.md', fileName: 'notes.md', commentId: 'c1', commentIds: ['c1'], label: '2 comments · notes.md' }];
  window.dispatchEvent(new CustomEvent('youcoded:compose-send-comments', { detail: { lead: 'Please work through', refs } }));
}

async function nextFrames() {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('Ask your assistant with a draft in the message box', () => {
  beforeEach(() => { (global as any).ResizeObserver = NoopResizeObserver; });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); delete (window as any).claude; });

  it('keeps the half-typed words, adds the comments chip, and sends nothing', async () => {
    const send = vi.fn().mockResolvedValue({ status: 'accepted' });
    const box = mountComposer(send);
    fireEvent.change(box, { target: { value: 'also rename the header' } });

    act(() => askAboutComments());
    await nextFrames();

    expect(box.value.startsWith('also rename the header')).toBe(true);
    expect(box.value.length).toBeGreaterThan('also rename the header'.length);
    expect(send).not.toHaveBeenCalled();
  });

  it('with an empty box, still sends in one click', async () => {
    const send = vi.fn().mockResolvedValue({ status: 'accepted' });
    mountComposer(send);

    act(() => askAboutComments());
    await nextFrames();

    expect(send).toHaveBeenCalledTimes(1);
  });
});
