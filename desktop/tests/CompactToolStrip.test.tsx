// @vitest-environment jsdom
// CompactToolStrip — the buddy floater's compact tool row. Bug (Destin,
// real-machine dogfood): while the admin password card waited, the buddy
// strip's row for that command read no differently than a running one —
// nothing said the session needed input. PASSWORD_REQUEST now flips the
// tool's status to 'awaiting-approval' (chat-reducer.ts), the same status a
// permission ask already uses; this pins that the strip's own passwordAsk
// branch keys off that status (not the old 'running') and that the strip
// treats a pending password ask as something the collapse toggle can't hide.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ChatProvider } from '../src/renderer/state/chat-context';
import { CompactToolStrip } from '../src/renderer/components/buddy/CompactToolStrip';
import type { ToolCallState } from '../src/shared/types';

afterEach(cleanup);

function makeTool(overrides: Partial<ToolCallState>): ToolCallState {
  return {
    toolUseId: 'bash-1',
    toolName: 'Bash',
    input: { command: 'sudo apt update' },
    status: 'running',
    ...overrides,
  };
}

describe('CompactToolStrip — a pending password ask reads as needing input, not as running', () => {
  it('shows "Enter your password in YouCoded", not the running dot alone, once status is awaiting-approval', () => {
    const tool = makeTool({
      status: 'awaiting-approval',
      passwordAsk: { requestId: 'req-1', command: 'sudo apt update' },
    });
    render(
      <ChatProvider>
        <CompactToolStrip tools={[tool]} sessionId="s1" />
      </ChatProvider>,
    );
    expect(screen.getByText('Enter your password in YouCoded')).toBeInTheDocument();
    // Never the permission Allow/Deny row — a password ask has no requestId
    // of its own on the tool (see needsUserAnswer/askIdOf, specialist-cards.ts).
    expect(screen.queryByText('✓ Allow')).not.toBeInTheDocument();
  });

  it('disables the collapse toggle while the password ask is pending, same as a permission ask', () => {
    const tool = makeTool({
      status: 'awaiting-approval',
      passwordAsk: { requestId: 'req-1', command: 'sudo apt update' },
    });
    render(
      <ChatProvider>
        <CompactToolStrip tools={[tool]} sessionId="s1" />
      </ChatProvider>,
    );
    const toggle = screen.getByText(/tool used/);
    expect(toggle).toBeDisabled();
  });

  it('a merely running command (no ask yet) shows neither the password nor the approval row', () => {
    const tool = makeTool({ status: 'running' });
    render(
      <ChatProvider>
        <CompactToolStrip tools={[tool]} sessionId="s1" />
      </ChatProvider>,
    );
    expect(screen.queryByText('Enter your password in YouCoded')).not.toBeInTheDocument();
    expect(screen.queryByText('✓ Allow')).not.toBeInTheDocument();
  });
});
