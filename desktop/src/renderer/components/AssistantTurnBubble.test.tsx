// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ChatProvider } from '../state/chat-context';
import AssistantTurnBubble from './AssistantTurnBubble';
import type { AssistantTurn } from '../state/chat-types';
import type { ToolCallState, ToolGroupState } from '../../shared/types';

// Helpers for synthesizing minimal test fixtures. The reducer is untouched
// in this task — these objects bypass it entirely and feed AssistantTurnBubble
// directly to verify the view-layer Skill reorder.

function skillTool(id: string, skill: string): ToolCallState {
  return {
    toolUseId: id,
    toolName: 'Skill',
    input: { skill },
    status: 'complete',
    response: `Launching skill: ${skill}`,
  };
}

function bashTool(id: string, command: string): ToolCallState {
  return {
    toolUseId: id,
    toolName: 'Bash',
    input: { command },
    status: 'complete',
  };
}

function makeTurn(opts: { id?: string; groupIds: string[] }): AssistantTurn {
  return {
    id: opts.id ?? 'turn_test',
    segments: opts.groupIds.map((groupId) => ({
      type: 'tool-group' as const,
      groupId,
    })),
    timestamp: 0,
    stopReason: null,
    model: null,
    usage: null,
    anthropicRequestId: null,
  };
}

function renderTurn(opts: {
  turn: AssistantTurn;
  toolGroups: Map<string, ToolGroupState>;
  toolCalls: Map<string, ToolCallState>;
}) {
  return render(
    <ChatProvider>
      <AssistantTurnBubble
        turn={opts.turn}
        toolGroups={opts.toolGroups}
        toolCalls={opts.toolCalls}
        sessionId="test"
        showTimestamps={false}
      />
    </ChatProvider>
  );
}

describe('AssistantTurnBubble — Skill extraction', () => {
  beforeEach(() => cleanup());

  it('renders Skills after non-Skill tools within the turn', () => {
    // Skill listed FIRST in toolIds; expect it to render LAST.
    const turn = makeTurn({ groupIds: ['g1'] });
    const toolGroups = new Map<string, ToolGroupState>([
      ['g1', { id: 'g1', toolIds: ['s1', 'b1'] }],
    ]);
    const toolCalls = new Map<string, ToolCallState>([
      ['s1', skillTool('s1', 'superpowers:brainstorming')],
      ['b1', bashTool('b1', 'git status')],
    ]);

    const { container } = renderTurn({ turn, toolGroups, toolCalls });

    const html = container.innerHTML;
    const bashIdx = html.indexOf('git status');
    // Skill label is "Invoked skill: <bare-name>" — namespace is stripped.
    const skillIdx = html.indexOf('Invoked skill: brainstorming');
    expect(bashIdx).toBeGreaterThanOrEqual(0);
    expect(skillIdx).toBeGreaterThanOrEqual(0);
    expect(skillIdx).toBeGreaterThan(bashIdx);
  });

  it('renders only the Skill trailing row when turn has no non-Skill tools', () => {
    const turn = makeTurn({ groupIds: ['g1'] });
    const toolGroups = new Map<string, ToolGroupState>([
      ['g1', { id: 'g1', toolIds: ['s1'] }],
    ]);
    const toolCalls = new Map<string, ToolCallState>([
      ['s1', skillTool('s1', 'superpowers:brainstorming')],
    ]);

    const { container } = renderTurn({ turn, toolGroups, toolCalls });
    expect(container.innerHTML).toContain('Invoked skill: brainstorming');
  });

  it('stacks multiple Skills in invocation order at the end', () => {
    const turn = makeTurn({ groupIds: ['g1'] });
    const toolGroups = new Map<string, ToolGroupState>([
      // Order: Skill, Bash, Skill — final render: Bash, Skill1, Skill2
      ['g1', { id: 'g1', toolIds: ['s1', 'b1', 's2'] }],
    ]);
    const toolCalls = new Map<string, ToolCallState>([
      ['s1', skillTool('s1', 'superpowers:one')],
      ['b1', bashTool('b1', 'ls -la /tmp')],
      ['s2', skillTool('s2', 'superpowers:two')],
    ]);

    const { container } = renderTurn({ turn, toolGroups, toolCalls });
    const html = container.innerHTML;
    // Full label phrasing makes the bare suffix unambiguous in the HTML.
    const oneIdx = html.indexOf('Invoked skill: one');
    const twoIdx = html.indexOf('Invoked skill: two');
    // 'ls -la /tmp' is distinctive — won't false-match on 'TooLs' etc.
    const bashIdx = html.indexOf('ls -la /tmp');
    expect(bashIdx).toBeGreaterThanOrEqual(0);
    expect(oneIdx).toBeGreaterThanOrEqual(0);
    expect(twoIdx).toBeGreaterThanOrEqual(0);
    expect(bashIdx).toBeLessThan(oneIdx);
    expect(oneIdx).toBeLessThan(twoIdx);
  });
});
