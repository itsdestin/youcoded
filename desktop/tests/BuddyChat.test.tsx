// @vitest-environment jsdom
/**
 * The buddy's chat window: the main window's cards drawn for its small window (one question at a time), and a chat that
 * is NOT rebuilt every time it opens.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import ToolCard from '../src/renderer/components/ToolCard';
import { ChatProvider } from '../src/renderer/state/chat-context';
import { CompactSurfaceContext } from '../src/renderer/state/compact-surface-context';
import type { ToolCallState } from '../src/shared/types';

// BuddyChat itself is the main window's whole chat; this file only needs to know whether it is mounted again.
const mounts = vi.hoisted(() => ({ count: 0, opened: [] as number[] }));
vi.mock('../src/renderer/components/buddy/BuddyChat', () => ({
  BuddyChat: ({ opened }: { opened?: number }) => {
    React.useEffect(() => { mounts.count++; }, []);
    mounts.opened.push(opened ?? 0);
    return <div data-testid="chat" />;
  },
}));
import { BuddyChatApp } from '../src/renderer/components/buddy/BuddyChatApp';

let respond: ReturnType<typeof vi.fn>;
let chatState: ((s: { visible: boolean; mascot?: 'above' | 'below' }) => void) | null;
beforeEach(() => {
  mounts.count = 0;
  mounts.opened = [];
  chatState = null;
  respond = vi.fn().mockResolvedValue(true);
  (window as any).claude = {
    session: { respondToPermission: respond },
    remote: { broadcastAction: vi.fn() },
    buddy: { onChatState: (cb: typeof chatState) => { chatState = cb; return () => {}; } },
  };
});
afterEach(cleanup);

const twoQuestions = (): ToolCallState => ({
  toolUseId: 'tool-q',
  toolName: 'AskUserQuestion',
  input: { questions: [
    { question: 'What color for the walls?', header: 'Walls', multiSelect: false, options: [{ label: 'Blue', description: 'Calm' }, { label: 'Red' }] },
    { question: 'What color for the trim?', header: 'Trim', multiSelect: false, options: [{ label: 'Green' }, { label: 'Yellow' }] },
  ] },
  status: 'awaiting-approval',
  requestId: 'native-q1',
} as ToolCallState);

const renderCompact = (tool: ToolCallState) => render(
  <ChatProvider>
    <CompactSurfaceContext.Provider value={{ tools: 'summary' }}>
      <ToolCard tool={tool} sessionId="s1" />
    </CompactSurfaceContext.Provider>
  </ChatProvider>,
);

describe('the question card in the buddy', () => {
  it('shows one question at a time, as chips, with the note box hidden until asked for', () => {
    renderCompact(twoQuestions());
    expect(screen.getByText('What color for the walls?')).toBeTruthy();
    expect(screen.queryByText('What color for the trim?')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: '+ Note' })).toBeTruthy();
    expect(screen.queryByText('Calm')).toBeNull(); // the explanation is the chip's hover hint, not a line of its own
  });

  it('moves to the next question when one answer is picked, and sends both answers on Submit', async () => {
    vi.useFakeTimers();
    try {
      renderCompact(twoQuestions());
      fireEvent.click(screen.getByRole('button', { name: 'Blue' }));
      act(() => { vi.advanceTimersByTime(200); });
      expect(screen.getByText('What color for the trim?')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Green' }));
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond.mock.calls[0][1].decision.updatedInput.orderedAnswers).toEqual([{ answer: 'Blue' }, { answer: 'Green' }]);
  });

  it('the main window keeps its full card: every question at once, each with its note box', () => {
    render(<ChatProvider><ToolCard tool={twoQuestions()} sessionId="s1" /></ChatProvider>);
    expect(screen.getByText('What color for the trim?')).toBeTruthy();
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
  });
});

describe('opening the buddy chat', () => {
  it('replays the entrance without rebuilding the chat, so the conversation is not filled again on every open', () => {
    render(<BuddyChatApp />);
    expect(mounts.count).toBe(1);
    act(() => { chatState!({ visible: false }); });
    act(() => { chatState!({ visible: true, mascot: 'below' }); });
    act(() => { chatState!({ visible: false }); });
    act(() => { chatState!({ visible: true, mascot: 'above' }); });
    expect(mounts.count).toBe(1);
    expect(document.querySelector('.buddy-chat-panel')!.getAttribute('data-mascot')).toBe('above');
  });

  it('counts each open — so its menus start closed — but not the size button\'s fade and grow', () => {
    render(<BuddyChatApp />);
    act(() => { chatState!({ visible: true, mascot: 'below' }); });
    const afterOpen = mounts.opened.at(-1)!;
    act(() => { chatState!({ visible: true, resize: 'out' } as any); });
    act(() => { chatState!({ visible: true, resize: 'in', mascot: 'below' } as any); });
    expect(mounts.opened.at(-1)).toBe(afterOpen);
    expect(document.querySelector('.buddy-chat-panel')!.className).not.toContain('buddy-chat-enter');
    act(() => { chatState!({ visible: false }); });
    act(() => { chatState!({ visible: true, mascot: 'below' }); });
    expect(mounts.opened.at(-1)).toBe(afterOpen + 1);
  });
});

describe('the chat panel between animations', () => {
  // WHY (Destin, 2026-10-30: "a bit odd/jittery"): the frame between one animation and the next had no class at all, so
  // it drew the whole panel at full size before the entrance hid it again — a flash at the start of every open and every
  // size change. Every phase now carries a class, and the one between animations ('pre') is invisible.
  it('never shows the panel without an animation class when it reopens or resizes', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    const { container } = render(<BuddyChatApp />);
    const panel = () => container.querySelector('.buddy-chat-panel')!;
    act(() => { chatState!({ visible: false }); });
    act(() => { chatState!({ visible: true, mascot: 'below' }); });
    expect(panel().className).toContain('buddy-chat-pre');
    act(() => { (chatState as any)({ visible: true, resize: 'out' }); });
    act(() => { (chatState as any)({ visible: true, resize: 'in' }); });
    expect(panel().className).toContain('buddy-chat-pre');
    raf.mockRestore();
  });
});

describe('message times in the buddy (contract R25)', () => {
  // WHY a source pin: a 2026-10-26 refactor of buddy.css dropped this rule by accident and every message showed its time
  // again; jsdom applies no stylesheet, so only the rule's text can be checked here.
  const css = readFileSync(join(__dirname, '../src/renderer/styles/buddy.css'), 'utf8');
  it('folds every time away, shows it on a half-second rest, and keeps the newest one', () => {
    expect(css).toMatch(/html\[data-mode="buddy-chat"\] \.timeline-entry \.bubble-timestamp \{[^}]*max-height: 0/);
    expect(css).toMatch(/\.timeline-entry:hover \.bubble-timestamp \{[^}]*opacity 120ms ease 600ms/);
    expect(css).toMatch(/\.timeline-entry:nth-last-child\(1 of \.timeline-entry\) \.bubble-timestamp \{[^}]*opacity: 1/);
  });
  it('the pre phase is invisible', () => {
    expect(css).toMatch(/\.buddy-chat-pre \{ opacity: 0; \}/);
  });
});
