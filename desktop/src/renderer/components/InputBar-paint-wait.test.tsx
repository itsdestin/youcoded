// @vitest-environment jsdom
// The composer must not write a chat message into a screen that has not painted yet (2026-10-05 review of the
// reload-repaint fix): the unpainted screen may be a hook-less pop-up mid-draw.
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

const screenText = vi.hoisted(() => ({ value: '' as string | null }));
vi.mock('../hooks/terminal-registry', async (orig) => ({ ...(await orig<any>()), getVisibleScreenText: () => screenText.value }));

import { ChatProvider } from '../state/chat-context';
import { SkillProvider } from '../state/skill-context';
import InputBar from './InputBar';

class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
const RULE = '─'.repeat(60);
const BOX = ['history', RULE, '❯ ', RULE, '  ⏵⏵ auto mode on'].join('\n');
const POPUP = ['history', RULE, '  Select model', '  ❯ 1. Default', '    2. Opus', '  Esc to cancel'].join('\n');

describe('InputBar waits for a painted screen before writing', () => {
  const sendInput = vi.fn(); const requestRepaint = vi.fn();
  const setup = (id = 's1') => {
    const view = render(<ChatProvider><SkillProvider><InputBar sessionId={id} provider="claude" onToast={vi.fn()} /></SkillProvider></ChatProvider>);
    const input = screen.getByPlaceholderText('Message your assistant...') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'hello there' } });
    return { input, view, button: screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement };
  };
  const wrote = () => sendInput.mock.calls.filter((c) => String(c[1]).includes('hello'));
  beforeEach(() => {
    (global as any).ResizeObserver = NoopResizeObserver;
    vi.useFakeTimers();
    sendInput.mockReset(); requestRepaint.mockReset();
    (window as any).claude = {
      session: { sendInput, requestRepaint },
      skills: { list: vi.fn().mockResolvedValue([]), getFavorites: vi.fn().mockResolvedValue([]), getChips: vi.fn().mockResolvedValue([]), getCuratedDefaults: vi.fn().mockResolvedValue([]) },
    };
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('a rule-less 2-row prompt: nothing is written during the wait; at the deadline it sends once and reports it', async () => {
    screenText.value = '  Do you trust this folder?\n  ❯ 1. Yes';
    const { input, button } = setup();
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(requestRepaint).toHaveBeenCalled();
    expect(button.disabled).toBe(true);                         // dimmed while waiting
    expect(input.value).toBe('hello there');                    // draft kept
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(wrote()).toHaveLength(0);                            // still nothing before the deadline
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });  // a second Enter cannot double-send
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(wrote()).toHaveLength(1);
    expect(requestRepaint).toHaveBeenCalledWith('s1', 'gate-deadline');
  });

  it('fragment then the full frame: sends when the message box appears, not before', async () => {
    screenText.value = ' '.repeat(79) + 'Checking for updates';
    const { input } = setup();
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(wrote()).toHaveLength(0);
    screenText.value = BOX;
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(wrote()).toHaveLength(1);
    expect(requestRepaint).not.toHaveBeenCalledWith('s1', 'gate-deadline');
  });

  it('a pop-up that finishes drawing is never written into; the draft stays', async () => {
    screenText.value = RULE.slice(0, 4);
    const { input } = setup();
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    screenText.value = POPUP;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(wrote()).toHaveLength(0);
    expect(input.value).toBe('hello there');
  });

  it('switching away (unmount) cancels the wait: nothing is ever written', async () => {
    screenText.value = 'x';
    const { input, view } = setup();
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    view.unmount();
    screenText.value = BOX;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(wrote()).toHaveLength(0);
  });
});
