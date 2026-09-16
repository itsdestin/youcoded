// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ChatProvider } from '../state/chat-context';
import AssistantTurnBubble, { splitIntoBubbles } from './AssistantTurnBubble';
import type { AssistantTurn, AssistantTurnSegment } from '../state/chat-types';
import type { ToolCallState, ToolGroupState } from '../../shared/types';

// Mock MarkdownContent with a render-counting probe. AssistantTurnBubble renders
// one <MarkdownContent> per text bubble, so counting its renders tells us whether
// the memo comparator let a turn skip re-rendering. The real markdown pipeline
// (react-markdown + highlight.js) is the expensive thing the memo exists to avoid
// re-running on every streaming frame — counting its invocation is the most direct
// observable of the perf invariant.
vi.mock('./MarkdownContent', () => {
  const renders: string[] = [];
  const Mock = ({ content }: { content: string }) => {
    renders.push(content);
    return <div data-testid="md-probe">{content}</div>;
  };
  Mock.__renders = renders;
  return { default: Mock };
});
import MarkdownContent from './MarkdownContent';
const mdRenders = (MarkdownContent as any).__renders as string[];

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

// Fixture helpers for splitIntoBubbles — build segments matching the real
// AssistantTurnSegment union (chat-types.ts) so the pure-function tests below
// exercise the exact shapes the reducer produces.
const seg = {
  text: (messageId: string, content: string): AssistantTurnSegment => ({
    type: 'text',
    content,
    messageId,
  }),
  reasoning: (messageId: string, content: string): AssistantTurnSegment => ({
    type: 'reasoning',
    content,
    messageId,
  }),
  toolGroup: (groupId: string): AssistantTurnSegment => ({
    type: 'tool-group',
    groupId,
  }),
};

function makeSegmentTurn(segments: AssistantTurnSegment[]): AssistantTurn {
  return {
    id: 'turn_split_test',
    segments,
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

  it('stacks multiple Skills into ONE card, in invocation order, at the end', () => {
    // Destin, 2026-09-02 (bubble-grouping deck B-7): two or more skills in a
    // turn read as a single "Invoked 2 skills: one and two" card rather than
    // one card per invocation. Still after every other tool.
    const turn = makeTurn({ groupIds: ['g1'] });
    const toolGroups = new Map<string, ToolGroupState>([
      // Order: Skill, Bash, Skill — final render: Bash, then the stacked card
      ['g1', { id: 'g1', toolIds: ['s1', 'b1', 's2'] }],
    ]);
    const toolCalls = new Map<string, ToolCallState>([
      ['s1', skillTool('s1', 'superpowers:one')],
      ['b1', bashTool('b1', 'ls -la /tmp')],
      ['s2', skillTool('s2', 'superpowers:two')],
    ]);

    const { container } = renderTurn({ turn, toolGroups, toolCalls });
    const html = container.innerHTML;
    const stackedIdx = html.indexOf('Invoked 2 skills: one and two');
    // 'ls -la /tmp' is distinctive — won't false-match on 'TooLs' etc.
    const bashIdx = html.indexOf('ls -la /tmp');
    expect(bashIdx).toBeGreaterThanOrEqual(0);
    expect(stackedIdx).toBeGreaterThanOrEqual(0);
    expect(bashIdx).toBeLessThan(stackedIdx);
    // No per-invocation cards remain.
    expect(html).not.toContain('Invoked skill: one');
    expect(html).not.toContain('Invoked skill: two');
  });
});

describe('CollapsedToolGroup — stopped specialists', () => {
  beforeEach(() => cleanup());

  it('shows a stopped icon rather than a spinner after a specialist stops', () => {
    const turn = makeTurn({ groupIds: ['g1'] });
    const toolGroups = new Map<string, ToolGroupState>([
      ['g1', { id: 'g1', toolIds: ['task-1', 'bash-1'] }],
    ]);
    const toolCalls = new Map<string, ToolCallState>([
      ['task-1', {
        toolUseId: 'task-1', toolName: 'Task', input: { description: 'inspect the issue' }, status: 'running',
        specialistRun: {
          childId: 'child-1', parentToolCallId: 'task-1', agentType: 'explorer', title: 'Quinn',
          background: true, status: 'interrupted', startedAt: 1000, endedAt: 2000,
        },
      }],
      ['bash-1', bashTool('bash-1', 'git status')],
    ]);

    const { container } = renderTurn({ turn, toolGroups, toolCalls });
    // The group needs to settle even before the interrupted Task result arrives.
    expect(container.querySelector('[data-spinner]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-testid="tool-group-stopped"]')).toBeInTheDocument();
    expect(container.textContent).toContain('1 stopped');
  });
});

describe('AssistantTurnBubble — memo comparator (streaming perf)', () => {
  beforeEach(() => {
    cleanup();
    mdRenders.length = 0;
  });

  // A turn with a text segment (renders MarkdownContent) plus one tool group.
  function makeTextTurn(id: string, text: string, groupId: string): AssistantTurn {
    return {
      id,
      segments: [
        { type: 'text' as const, content: text, messageId: `${id}-msg` },
        { type: 'tool-group' as const, groupId },
      ],
      timestamp: 0,
      stopReason: null,
      model: null,
      usage: null,
      anthropicRequestId: null,
    };
  }

  it('does NOT re-render when an unrelated tool changes in the shared Maps', () => {
    // This is the core streaming-perf invariant: the reducer hands every turn a
    // fresh toolCalls/toolGroups Map reference whenever ANY tool updates. The
    // memo comparator must see that THIS turn's own tools are unchanged and skip
    // the re-render (and its markdown re-parse).
    const turn = makeTextTurn('turn_a', 'hello world', 'g1');
    const toolGroups = new Map<string, ToolGroupState>([
      ['g1', { id: 'g1', toolIds: ['b1'] }],
    ]);
    const toolCalls = new Map<string, ToolCallState>([
      ['b1', bashTool('b1', 'git status')],
    ]);

    const props = { turn, toolGroups, toolCalls, sessionId: 'test', showTimestamps: false };
    const { rerender } = render(
      <ChatProvider>
        <AssistantTurnBubble {...props} />
      </ChatProvider>
    );
    const rendersAfterMount = mdRenders.length;
    expect(rendersAfterMount).toBeGreaterThan(0);

    // Simulate a reducer dispatch for a DIFFERENT turn's tool: brand-new Map
    // references, but turn_a's own group/tool entries are referentially intact.
    const toolGroups2 = new Map(toolGroups);
    const toolCalls2 = new Map(toolCalls);
    toolGroups2.set('g2', { id: 'g2', toolIds: ['b2'] });
    toolCalls2.set('b2', bashTool('b2', 'npm test'));

    rerender(
      <ChatProvider>
        <AssistantTurnBubble {...props} toolGroups={toolGroups2} toolCalls={toolCalls2} />
      </ChatProvider>
    );

    // Memo gate held → MarkdownContent did not re-run for the unchanged turn.
    expect(mdRenders.length).toBe(rendersAfterMount);
  });

  it('DOES re-render when its own tool entry changes', () => {
    // Guard against over-blocking: if this turn's OWN tool updates (e.g. its
    // Bash result lands), the comparator must let the re-render through.
    const turn = makeTextTurn('turn_b', 'hello world', 'g1');
    const toolGroups = new Map<string, ToolGroupState>([
      ['g1', { id: 'g1', toolIds: ['b1'] }],
    ]);
    const toolCalls = new Map<string, ToolCallState>([
      ['b1', { toolUseId: 'b1', toolName: 'Bash', input: { command: 'git status' }, status: 'running' }],
    ]);

    const props = { turn, toolGroups, toolCalls, sessionId: 'test', showTimestamps: false };
    const { rerender } = render(
      <ChatProvider>
        <AssistantTurnBubble {...props} />
      </ChatProvider>
    );
    const rendersAfterMount = mdRenders.length;

    // b1 transitions running → complete (new ToolCallState object, new Map).
    const toolCalls2 = new Map(toolCalls);
    toolCalls2.set('b1', { toolUseId: 'b1', toolName: 'Bash', input: { command: 'git status' }, status: 'complete', response: 'ok' });

    rerender(
      <ChatProvider>
        <AssistantTurnBubble {...props} toolCalls={toolCalls2} />
      </ChatProvider>
    );

    expect(mdRenders.length).toBeGreaterThan(rendersAfterMount);
  });

  it('DOES re-render when the turn object itself changes', () => {
    // The comparator keys on `turn` by reference — a new turn object (e.g. the
    // reducer appended a streaming text delta) must always re-render.
    const turn = makeTextTurn('turn_c', 'hello', 'g1');
    const toolGroups = new Map<string, ToolGroupState>([
      ['g1', { id: 'g1', toolIds: ['b1'] }],
    ]);
    const toolCalls = new Map<string, ToolCallState>([
      ['b1', bashTool('b1', 'git status')],
    ]);

    const props = { turn, toolGroups, toolCalls, sessionId: 'test', showTimestamps: false };
    const { rerender } = render(
      <ChatProvider>
        <AssistantTurnBubble {...props} />
      </ChatProvider>
    );
    const rendersAfterMount = mdRenders.length;

    // New turn object with appended text (what the reducer produces per delta).
    const turn2 = { ...turn, segments: [
      { type: 'text' as const, content: 'hello world', messageId: 'turn_c-msg' },
      turn.segments[1],
    ] };
    rerender(
      <ChatProvider>
        <AssistantTurnBubble {...props} turn={turn2} />
      </ChatProvider>
    );

    expect(mdRenders.length).toBeGreaterThan(rendersAfterMount);
  });
});

describe('splitIntoBubbles — a segment type this bundle does not know', () => {
  // Reachable in NORMAL use, not corruption: the remote browser and the Android
  // WebView load a bundle that can be older than the host sending them turns.
  // The branch used to be a bare `else` that treated anything unrecognised as a
  // tool group, pushing `undefined` as a group id and drawing an empty card.
  it('renders nothing for it, and does not throw', () => {
    const turn = makeSegmentTurn([
      seg.text('t1', 'before'),
      { type: 'from-the-future', messageId: 'x' } as unknown as AssistantTurnSegment,
      seg.text('t2', 'after'),
    ]);
    const bubbles = splitIntoBubbles(turn);
    expect(bubbles.map((b) => b.text?.content)).toEqual(['before', 'after']);
    expect(bubbles.some((b) => b.toolGroupIds.includes(undefined as unknown as string))).toBe(false);
  });

  it('an unknown segment alone yields no bubbles at all', () => {
    expect(splitIntoBubbles(makeSegmentTurn([
      { type: 'from-the-future', messageId: 'x' } as unknown as AssistantTurnSegment,
    ]))).toEqual([]);
  });
});

describe('splitIntoBubbles — BUG A (tool group mis-attribution after interleaved reasoning)', () => {
  it('a tool group after interleaved reasoning starts a NEW bubble carrying that reasoning (BUG A pin)', () => {
    // Native harness shape: reasoning streams live but tool-use events are
    // batched after each step's stream, so a multi-step turn interleaves as
    // [text₁, toolGroupA, reasoning₂, toolGroupB]. toolGroupB must NOT land
    // on text₁'s bubble — it belongs to a new bubble with reasoning₂.
    const segments = [
      seg.text('t1', 'Let me look'),          // step 1 text
      seg.toolGroup('A'),                      // step 1 tool (batched after stream)
      seg.reasoning('r1', 'thinking about B'), // step 2 reasoning
      seg.toolGroup('B'),                      // step 2 tool
    ];
    const turn = makeSegmentTurn(segments);

    const bubbles = splitIntoBubbles(turn);

    expect(bubbles).toHaveLength(2);
    expect(bubbles[0].toolGroupIds).toEqual(['A']);   // B must NOT land here
    expect(bubbles[1].toolGroupIds).toEqual(['B']);
    expect(bubbles[1].reasoning?.content).toBe('thinking about B'); // reasoning attached to ITS tool's bubble, not trailing
  });

  it('a single interleave [text, reasoning, toolGroup] splits into 2 bubbles: text alone, then reasoning+tool together', () => {
    // Pins the single-step-reasoning-model shape (no batched tool group in
    // between — reasoning simply follows the text bubble before its tool).
    const segments = [
      seg.text('t1', 'Let me look'),
      seg.reasoning('r1', 'thinking'),
      seg.toolGroup('A'),
    ];
    const turn = makeSegmentTurn(segments);

    const bubbles = splitIntoBubbles(turn);

    expect(bubbles).toHaveLength(2);
    expect(bubbles[0].text?.content).toBe('Let me look');
    expect(bubbles[0].toolGroupIds).toEqual([]);
    expect(bubbles[0].reasoning).toBeUndefined();
    expect(bubbles[1].toolGroupIds).toEqual(['A']);
    expect(bubbles[1].reasoning?.content).toBe('thinking');
  });
});

describe('AssistantTurnBubble — stop reason footer', () => {
  beforeEach(() => cleanup());

  // The turn shape the reducer produces; only stopReason varies between the two
  // cases, which is what makes the pair a real discrimination test.
  function turnWithStopReason(stopReason: string | null): AssistantTurn {
    return {
      id: 'turn_dismissed',
      segments: [{ type: 'text', content: 'Which one did you want?', messageId: 'm1' }],
      timestamp: 0,
      stopReason,
      model: null,
      usage: null,
      anthropicRequestId: null,
    };
  }

  it('names a dismissed question so it cannot be mistaken for a dead session', () => {
    const { container } = renderTurn({
      turn: turnWithStopReason('question_dismissed'),
      toolGroups: new Map(),
      toolCalls: new Map(),
    });
    expect(container.textContent).toContain('Question closed — waiting for you.');
  });

  it('says nothing for a normal completion', () => {
    // Without this, a footer that renders unconditionally passes the test above.
    const { container } = renderTurn({
      turn: turnWithStopReason('end_turn'),
      toolGroups: new Map(),
      toolCalls: new Map(),
    });
    expect(container.textContent).not.toContain('Question closed');
  });

  it('renders the empty-response copy for stopReason empty_response', () => {
    // Empty-step recovery (spec 2026-08-21): the harness already retried once
    // silently — this footer is the honest end after a SECOND contentless step.
    const { container } = renderTurn({
      turn: turnWithStopReason('empty_response'),
      toolGroups: new Map(),
      toolCalls: new Map(),
    });
    expect(container.textContent).toContain('The model returned an empty response twice. Retrying may help.');
  });

  it('end_turn never renders the empty-response copy', () => {
    const { container } = renderTurn({
      turn: turnWithStopReason('end_turn'),
      toolGroups: new Map(),
      toolCalls: new Map(),
    });
    expect(container.textContent).not.toContain('empty response');
  });

  it('renders a footer-only row for an empty_response turn with no segments', () => {
    // Spec 2026-08-21 decision 4: a fully-contentless turn has zero bubbles, so
    // the per-bubble footer never fires — but this exact shape is the bug's
    // worst case and must still explain itself.
    const { container } = renderTurn({
      turn: { ...turnWithStopReason('empty_response'), segments: [] },
      toolGroups: new Map(),
      toolCalls: new Map(),
    });
    expect(container.textContent).toContain('The model returned an empty response twice. Retrying may help.');
  });

  it('the footer-only row carries the timestamp when showTimestamps is on', () => {
    // The bubble path renders a timestamp on its last bubble; the footer-only
    // row must not silently drop that trailer member — "when did it go
    // silent?" is the first question an empty_response row raises.
    const { container } = render(
      <ChatProvider>
        <AssistantTurnBubble
          turn={{ ...turnWithStopReason('empty_response'), segments: [], timestamp: Date.UTC(2026, 7, 21, 12, 0, 0) }}
          toolGroups={new Map()}
          toolCalls={new Map()}
          sessionId="test"
          showTimestamps={true}
        />
      </ChatProvider>
    );
    expect(container.querySelector('.bubble-timestamp')).not.toBeNull();
  });

  it('renders nothing for a segment-less turn with a normal stopReason', () => {
    // Pins the inert path: zero-bubble turns without an abnormal reason keep
    // rendering nothing (no ghost rows on replay edge cases).
    const { container } = renderTurn({
      turn: { ...turnWithStopReason('end_turn'), segments: [] },
      toolGroups: new Map(),
      toolCalls: new Map(),
    });
    expect(container.textContent).toBe('');
  });
});
