// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ChatProvider } from '../state/chat-context';
import ToolCard from './ToolCard';
import type { ToolCallState } from '../../shared/types';

function makeTool(overrides: Partial<ToolCallState>): ToolCallState {
  return {
    toolUseId: 'toolu_test',
    toolName: 'Bash',
    input: {},
    status: 'complete',
    ...overrides,
  };
}

describe('ToolCard — Skill compact variant', () => {
  beforeEach(() => {
    cleanup();
  });

  it('renders Skill without an expand chevron', () => {
    const tool = makeTool({
      toolName: 'Skill',
      input: { skill: 'superpowers:brainstorming' },
      response: 'Launching skill: superpowers:brainstorming',
    });
    render(
      <ChatProvider>
        <ToolCard tool={tool} />
      </ChatProvider>
    );
    expect(screen.queryByTestId('tool-card-chevron')).toBeNull();
  });

  it('renders Skill without a tool body', () => {
    const tool = makeTool({
      toolName: 'Skill',
      input: { skill: 'superpowers:brainstorming' },
      response: 'Launching skill: superpowers:brainstorming',
    });
    render(
      <ChatProvider>
        <ToolCard tool={tool} />
      </ChatProvider>
    );
    expect(screen.queryByTestId('tool-card-body')).toBeNull();
    // Header label uses the new "Invoked skill: <bare-name>" format (namespace stripped).
    expect(screen.getByText(/Invoked skill: brainstorming/)).toBeInTheDocument();
  });

  it('renders non-Skill tool with the chevron present', () => {
    const tool = makeTool({ toolName: 'Bash', input: { command: 'ls' } });
    render(
      <ChatProvider>
        <ToolCard tool={tool} />
      </ChatProvider>
    );
    expect(screen.queryByTestId('tool-card-chevron')).not.toBeNull();
  });
});
