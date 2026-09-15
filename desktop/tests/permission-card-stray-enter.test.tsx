// @vitest-environment jsdom
/**
 * Pins that a stray Enter can never answer a card the user isn't looking at,
 * and can never save an Always-allow rule.
 *
 * The bug (2026-09-14): every open session's ChatView stays mounted, and each
 * waiting card listens for keys on `window`. The composer idle-blurs after
 * 0.75s, after which InputBar's own window listener sends on Enter — and every
 * card in every hidden chat ALSO took that Enter, on a default button of
 * Always Allow. Bash asks opened the confirm by themselves; other asks saved a
 * rule outright.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import ToolCard from '../src/renderer/components/ToolCard';
import PromptCard from '../src/renderer/components/PromptCard';
import { ChatProvider } from '../src/renderer/state/chat-context';
import { CardKeysLiveContext } from '../src/renderer/state/card-keys-context';
import type { ToolCallState } from '../src/shared/types';
import type { InteractivePrompt } from '../src/renderer/state/chat-types';

const respondToPermission = vi.fn().mockResolvedValue(true);

beforeEach(() => {
  respondToPermission.mockClear();
  (window as any).claude = { session: { respondToPermission }, remote: { broadcastAction: vi.fn() } };
});
afterEach(cleanup);

const nativeAsk = (over: Partial<ToolCallState>): ToolCallState => ({
  id: 'tool-1',
  status: 'awaiting-approval',
  requestId: 'native-abc123',
  ...over,
} as ToolCallState);

// The command from the reported screenshot — it yields two grant widths, so
// Always Allow routes through the confirm.
const bashAsk = () => nativeAsk({
  toolName: 'Bash',
  input: { command: 'python3 scripts/ui-review/review-cards.py serve docs/x.json --no-build --port 4791 --timeout 180' },
});
// No grant options and not deny-listed — Always Allow responds with no confirm.
const writeAsk = () => nativeAsk({ toolName: 'Write', input: { file_path: '/tmp/x.txt', content: 'hi' } });

function mount(tool: ToolCallState, onScreen: boolean) {
  return render(
    <ChatProvider>
      <CardKeysLiveContext.Provider value={onScreen}>
        <ToolCard sessionId="s1" tool={tool} />
      </CardKeysLiveContext.Provider>
    </ChatProvider>,
  );
}

const pressEnterOnBody = () => fireEvent.keyDown(document.body, { key: 'Enter' });

describe('a permission card in a chat that is not on screen', () => {
  it('ignores Enter — no confirm opens on a Bash ask', () => {
    mount(bashAsk(), false);
    pressEnterOnBody();
    expect(screen.queryByText(/Always allow this/)).toBeNull();
    expect(respondToPermission).not.toHaveBeenCalled();
  });

  it('ignores Enter — nothing is sent for a non-Bash ask', async () => {
    mount(writeAsk(), false);
    pressEnterOnBody();
    // Give a wrongly-fired async respond the chance to land before asserting none did.
    await new Promise((r) => queueMicrotask(() => r(undefined)));
    expect(respondToPermission).not.toHaveBeenCalled();
  });
});

describe('a permission card in the chat on screen', () => {
  it('ignores an Enter the composer already handled', () => {
    // Stands in for InputBar: it sends on Enter and marks the event handled.
    const composer = (e: KeyboardEvent) => { if (e.key === 'Enter') e.preventDefault(); };
    window.addEventListener('keydown', composer);
    try {
      mount(writeAsk(), true);
      pressEnterOnBody();
    } finally {
      window.removeEventListener('keydown', composer);
    }
    expect(respondToPermission).not.toHaveBeenCalled();
  });

  it('answers an unhandled Enter with a one-time Yes, never Always Allow', async () => {
    mount(writeAsk(), true);
    pressEnterOnBody();
    await waitFor(() => expect(respondToPermission).toHaveBeenCalledTimes(1));
    const [, decision] = respondToPermission.mock.calls[0];
    expect(decision).toEqual({ decision: { behavior: 'allow' } });
    expect(decision).not.toHaveProperty('updatedPermissions');
  });

  it('still reaches Always Allow deliberately: one arrow press, then Enter', () => {
    mount(bashAsk(), true);
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    pressEnterOnBody();
    expect(screen.queryByText(/Always allow this/)).not.toBeNull();
  });
});

describe('a Claude Code prompt card', () => {
  const prompt = (): InteractivePrompt => ({
    promptId: 'p1',
    title: 'Pick one',
    description: '',
    buttons: [{ label: 'First', input: '1' }, { label: 'Second', input: '2' }],
  } as InteractivePrompt);

  function mountPrompt(onScreen: boolean) {
    const onSelect = vi.fn();
    render(
      <CardKeysLiveContext.Provider value={onScreen}>
        <PromptCard prompt={prompt()} sessionId="s1" onSelect={onSelect} />
      </CardKeysLiveContext.Provider>,
    );
    return onSelect;
  }

  it('in a hidden chat, ignores Enter and number keys', () => {
    const onSelect = mountPrompt(false);
    pressEnterOnBody();
    fireEvent.keyDown(document.body, { key: '2' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('in the chat on screen, still answers Enter', () => {
    const onSelect = mountPrompt(true);
    pressEnterOnBody();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
