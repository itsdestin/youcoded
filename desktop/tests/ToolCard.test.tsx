// @vitest-environment jsdom
// ToolCard — the permission and question cards a waiting tool shows in the chat:
// what an unconfirmed answer leaves on screen, which cards a stray Enter may answer,
// and the deny-listed Always-allow confirm. Each section keeps its own window.claude
// fake and hooks.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import ToolCard from '../src/renderer/components/ToolCard';
import PromptCard from '../src/renderer/components/PromptCard';
import { CompactToolStrip } from '../src/renderer/components/buddy/CompactToolStrip';
import { ChatProvider } from '../src/renderer/state/chat-context';
import { CardKeysLiveContext } from '../src/renderer/state/card-keys-context';
import type { ToolCallState } from '../src/shared/types';
import type { InteractivePrompt } from '../src/renderer/state/chat-types';

/**
 * An approval answer that got no reply is not an "expired" request.
 *
 * The approval card (PermissionButtons),
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
describe('an answer with no reply', () => {
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
    it('a second Submit clears the "couldn\'t confirm" line while it is in flight (code review F8)', async () => {
      respond.mockRejectedValueOnce(TIMEOUT).mockReturnValueOnce(new Promise(() => {}));
      renderCard(questionAsk());
      fireEvent.click(screen.getByRole('button', { name: /^Blue/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
      expect(await screen.findByText(/couldn.t confirm/i)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
      await waitFor(() => expect(screen.queryByText(/couldn.t confirm/i)).toBeNull());
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
});

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
describe('a stray Enter', () => {
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
});

/**
 * Pins the deny-listed "Always allow" consequence confirm (ToolCard.tsx).
 *
 * Two things here are easy to regress silently and expensive when they do:
 *  1. "Nevermind, allow once" must SEND a plain allow. It replaced a Cancel
 *     button that merely closed the confirm, so a careless revert turns a
 *     one-click answer back into a dead end.
 *  2. The confirm must not promise a Settings undo. There is no UI to remove a
 *     remembered rule (PermissionStore exposes only rulesFor/remember), so that
 *     claim was inaccurate on the highest-stakes prompt in the app.
 */
describe('Always-allow on a deny-listed tool', () => {
  const respondToPermission = vi.fn().mockResolvedValue(true);

  beforeEach(() => {
    respondToPermission.mockClear();
    (window as any).claude = { session: { respondToPermission }, remote: { broadcastAction: vi.fn() } };
  });

  // This suite mounts the same card repeatedly; auto-cleanup isn't configured
  // globally, so unmount explicitly or queries match prior tests' leftover DOM.
  afterEach(cleanup);

  const denyListedTool = (): ToolCallState => ({
    id: 'tool-1',
    toolName: 'Bash',
    input: { command: 'git worktree remove ../wt-grep && git branch -D fix/grep' },
    status: 'awaiting-approval',
    requestId: 'native-abc123',
    denyListed: true,
    // WHY the double cast: the fixture carries `id`, not ToolCallState's `toolUseId`,
    // exactly as it did while this section's file was excluded from type-checking;
    // the same cast the other sections' fixtures use keeps the card's input unchanged.
  } as unknown as ToolCallState);

  // Open the confirm the way a user does — the confirm has no standalone entry.
  function renderConfirm() {
    const utils = render(<ChatProvider><ToolCard tool={denyListedTool()} sessionId="s1" /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Always Allow' }));
    return utils;
  }

  describe('deny-listed always-allow confirm', () => {
    it('gates Always Allow behind the confirm instead of responding immediately', () => {
      render(<ChatProvider><ToolCard tool={denyListedTool()} sessionId="s1" /></ChatProvider>);
      fireEvent.click(screen.getByRole('button', { name: 'Always Allow' }));
      expect(respondToPermission).not.toHaveBeenCalled();
      expect(screen.getByText(/Always allow this exact command/)).toBeTruthy();
    });

    it('states the project-scoped consequence (copy shared with the full-auto stop)', () => {
      renderConfirm();
      expect(
        screen.getByText("This can delete files or change published code, and you won't be asked again in this project."),
      ).toBeTruthy();
    });

    it('echoes the exact command the remembered rule will store', () => {
      renderConfirm();
      // harness-session.ts persists input.command verbatim as the rule pattern;
      // showing anything else would misstate the grant.
      expect(screen.getByText('git worktree remove ../wt-grep && git branch -D fix/grep')).toBeTruthy();
    });

    it('"Nevermind, allow once" sends a plain allow and remembers nothing', async () => {
      renderConfirm();
      fireEvent.click(screen.getByRole('button', { name: 'Nevermind, allow once' }));
      await waitFor(() => expect(respondToPermission).toHaveBeenCalledTimes(1));
      const [, decision] = respondToPermission.mock.calls[0];
      expect(decision).toEqual({ decision: { behavior: 'allow' } });
      // No updatedPermissions key at all — that array is what the broker reads as
      // "always" (permission-broker.ts), so its absence is the whole point.
      expect(decision).not.toHaveProperty('updatedPermissions');
    });

    it('"Always allow" sends the native always marker', async () => {
      renderConfirm();
      fireEvent.click(screen.getByRole('button', { name: 'Always allow' }));
      await waitFor(() => expect(respondToPermission).toHaveBeenCalledTimes(1));
      const [, decision] = respondToPermission.mock.calls[0];
      expect(decision.decision).toEqual({ behavior: 'allow' });
      expect(decision.updatedPermissions).toEqual(['native:always-allow']);
    });

    it('does not claim the grant can be undone in Settings', () => {
      renderConfirm();
      expect(screen.queryByText(/Settings/i)).toBeNull();
    });
  });
});
