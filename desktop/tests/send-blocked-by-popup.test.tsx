// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
// A chat message must never be typed into a Claude Code pop-up (one-core R6-4 fix). Found 2026-10-01 in a dev instance: after a typed /model, Claude Code
// shows "Switch model?" (a confirmation no hook reports); "hi" was typed into it, its Enter answered "Yes", and the chat showed a sent bubble and
// "Simmering" forever while Claude Code never received the message. origin/master refuses such a send; the one-core branch had lost that gate.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// The real "Switch model?" screen, as Claude Code 2.1.287 draws it (message box gone, a rule and the pop-up body in its place).
const POPUP = [
  '> /model haiku',
  '  ⎿  Set model to Haiku 4.5',
  '',
  '─'.repeat(60),
  '  Switch model?',
  '  Your next response will be slower and use more tokens',
  '  ❯ 1. Yes, switch to Haiku 4.5',
  '    2. No, go back',
].join('\n');
const BOX = ['─'.repeat(60), '❯ ', '─'.repeat(60), '  Haiku 4.5 | Context: 9%'].join('\n');

let screenText: string | null = POPUP;
vi.mock('../src/renderer/hooks/terminal-registry', async (orig) => ({
  ...(await orig<typeof import('../src/renderer/hooks/terminal-registry')>()),
  getVisibleScreenText: () => screenText,
}));

import { screenInputBlock } from '../src/renderer/state/pty-input-gate';
import { setScreenInputBlock, clearScreenInputBlocks } from '../src/renderer/state/screen-input-store';
import InputBar from '../src/renderer/components/InputBar';
import { ChatProvider } from '../src/renderer/state/chat-context';
import { REMOTE_SCREEN_CAPABILITIES } from '../src/shared/capabilities';
import { SkillProvider } from '../src/renderer/state/skill-context';

describe('screenInputBlock on a host that has the computer record (a window, a phone)', () => {
  it('asks the published reading of the computer, never its own terminal', () => {
    (window as any).claude = { capabilities: { ...REMOTE_SCREEN_CAPABILITIES, sessionRecord: true } };
    try {
      clearScreenInputBlocks();
      screenText = POPUP; expect(screenInputBlock('s')).toBeNull();   // the local terminal says pop-up, but the computer has said nothing: no second opinion
      setScreenInputBlock('s', { kind: 'popup', heading: 'Switch model?' });
      screenText = BOX; expect(screenInputBlock('s')).toEqual({ kind: 'popup', heading: 'Switch model?' });
      setScreenInputBlock('s', null); expect(screenInputBlock('s')).toBeNull();
    } finally { delete (window as any).claude; clearScreenInputBlocks(); }
  });
});

describe('screenInputBlock on the Android own runtime (no record: reads its own terminal)', () => {
  it('reports a pop-up that holds the keyboard, and nothing when the message box is live or the screen is unreadable', () => {
    screenText = POPUP; expect(screenInputBlock('s')).not.toBeNull();
    screenText = BOX; expect(screenInputBlock('s')).toBeNull();
    screenText = null; expect(screenInputBlock('s')).toBeNull();
  });
});

describe('InputBar while Claude Code shows a pop-up', () => {
  const sendInput = vi.fn();
  const mount = (onToast?: (m: string) => void) => {
    (global as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    (window as any).claude = {
      session: { sendInput },
      skills: { list: vi.fn().mockResolvedValue([]), getFavorites: vi.fn().mockResolvedValue([]), getChips: vi.fn().mockResolvedValue([]), getCuratedDefaults: vi.fn().mockResolvedValue([]) },
    };
    render(<ChatProvider><SkillProvider><InputBar sessionId="sess-1" provider="claude" onToast={onToast} /></SkillProvider></ChatProvider>);
    return screen.getByPlaceholderText('Message your assistant...') as HTMLTextAreaElement;
  };
  beforeEach(() => { sendInput.mockClear(); });
  afterEach(() => { cleanup(); });

  it('refuses the send (nothing reaches the terminal, the draft stays) and says where to look', () => {
    screenText = POPUP;
    const onToast = vi.fn();
    const box = mount(onToast);
    fireEvent.change(box, { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(sendInput).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledWith('Claude Code is waiting on something — answer it first.');
    expect(box.value).toBe('hi');
  });
  it('sends normally when the message box is live', async () => {
    screenText = BOX;
    const box = mount();
    fireEvent.change(box, { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(sendInput).toHaveBeenCalledWith('sess-1', 'hi\r', undefined, expect.any(String)));
  });
});
