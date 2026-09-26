// @vitest-environment jsdom
/**
 * Pins the nested SpecialistAskBlock's copy: the external-ask explainer, and
 * (since 2026-09-16, when a helper's ask stopped timing out) the absence of
 * any "waited 5 minutes, then carried on" line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { SpecialistAskBlock } from '../src/renderer/components/specialists/SpecialistAskBlock';
import { ChatProvider } from '../src/renderer/state/chat-context';
import type { SubagentSegment } from '../src/shared/types';

type ToolSegment = Extract<SubagentSegment, { type: 'tool' }>;

beforeEach(() => {
  (window as any).claude = {
    session: { respondToPermission: vi.fn().mockResolvedValue(true) },
    remote: { broadcastAction: vi.fn() },
  };
});

afterEach(cleanup);

function segment(over: Partial<ToolSegment> = {}): ToolSegment {
  return {
    type: 'tool',
    id: 'seg-1',
    toolUseId: 'tu-1',
    toolName: 'Bash',
    input: { command: 'echo hi' },
    status: 'awaiting-approval',
    requestId: 'native-req-1',
    ...over,
  };
}

function renderBlock(segOver: Partial<ToolSegment>) {
  return render(
    <ChatProvider>
      <SpecialistAskBlock segment={segment(segOver)} sessionId="s1" specialistName="Wren" />
    </ChatProvider>,
  );
}

describe('SpecialistAskBlock — copy', () => {
  it('an open ask shows no waited/carried-on line — the helper is simply waiting', () => {
    const { container } = renderBlock({});
    expect(container.textContent).not.toMatch(/waited|carried on|follow-up/i);
    expect(screen.queryByTestId('nested-ask-held')).toBeNull();
  });

  it('names the specialist and why Full Auto stopped a risky command in the nested card', () => {
    renderBlock({ input: { command: 'git push origin main' }, denyListed: true, permissionMode: 'full-auto' });
    expect(screen.getByText('Stopped before pushing code')).toBeTruthy();
    expect(screen.getByText(/specialist Wren requested this command/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Allow outside edits for this session' })).toBeNull();
  });

  it('external (outside-the-folder) ask says the helper has to ask every time — and offers no Always Allow', () => {
    renderBlock({ external: true });
    expect(screen.getByText(/outside the project folder/i).textContent).toBe(
      'This is outside the project folder, so Wren has to ask every time.',
    );
    // Destin's 2026-08-26/27 copy review dropped the "no “Always allow”" clause
    // from the sentence, so this assertion is now the only thing pinning the
    // fact it described: the button is absent, not merely unmentioned.
    expect(screen.queryByRole('button', { name: /always allow/i })).toBeNull();
  });
});
