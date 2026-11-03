// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ChatProvider } from '../state/chat-context';
import AssistantTurnBubble, { splitIntoBubbles } from './AssistantTurnBubble';
import type { AssistantTurn, AssistantTurnSegment } from '../state/chat-types';
import type { ToolCallState, ToolGroupState } from '../../shared/types';

// WHY a render-counting MarkdownContent probe: the real markdown pipeline is what the memo comparator exists
// to avoid re-running on every streaming frame, so counting its renders is the direct observable of that invariant.
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

// Fixtures bypass the reducer and feed AssistantTurnBubble directly.
const skillTool = (id: string, skill: string): ToolCallState =>
  ({ toolUseId: id, toolName: 'Skill', input: { skill }, status: 'complete', response: `Launching skill: ${skill}` });
const bashTool = (id: string, command: string): ToolCallState =>
  ({ toolUseId: id, toolName: 'Bash', input: { command }, status: 'complete' });

const makeSegmentTurn = (segments: AssistantTurnSegment[], id = 'turn_split_test'): AssistantTurn =>
  ({ id, segments, timestamp: 0, stopReason: null, model: null, usage: null, anthropicRequestId: null });

// Segments matching the real AssistantTurnSegment union (chat-types.ts).
const seg = {
  text: (messageId: string, content: string): AssistantTurnSegment => ({ type: 'text', content, messageId }),
  reasoning: (messageId: string, content: string): AssistantTurnSegment => ({ type: 'reasoning', content, messageId }),
  toolGroup: (groupId: string): AssistantTurnSegment => ({ type: 'tool-group', groupId }),
};

/** One tool group `g1` holding `calls` (in order), inside a turn (optionally led by a text segment). */
function oneGroup(calls: ToolCallState[], opts: { id?: string; text?: string } = {}) {
  const id = opts.id ?? 'turn_test';
  const segments: AssistantTurnSegment[] = [
    ...(opts.text ? [seg.text(`${id}-msg`, opts.text)] : []),
    seg.toolGroup('g1'),
  ];
  return {
    turn: makeSegmentTurn(segments, id),
    toolGroups: new Map<string, ToolGroupState>([['g1', { id: 'g1', toolIds: calls.map((c) => c.toolUseId) }]]),
    toolCalls: new Map<string, ToolCallState>(calls.map((c) => [c.toolUseId, c])),
  };
}

type BubbleProps = ReturnType<typeof oneGroup>;
const bubble = (p: BubbleProps) => (
  <ChatProvider>
    <AssistantTurnBubble turn={p.turn} toolGroups={p.toolGroups} toolCalls={p.toolCalls} sessionId="test" showTimestamps={false} />
  </ChatProvider>
);
const renderTurn = (p: BubbleProps) => render(bubble(p));

describe('AssistantTurnBubble — Skill extraction', () => {
  beforeEach(() => cleanup());

  it('renders Skills after non-Skill tools within the turn', () => {
    // Skill listed FIRST in toolIds; expect it to render LAST.
    const { container } = renderTurn(oneGroup([skillTool('s1', 'superpowers:brainstorming'), bashTool('b1', 'git status')]));
    const html = container.innerHTML;
    const bashIdx = html.indexOf('git status');
    const skillIdx = html.indexOf('Invoked skill: brainstorming'); // the namespace is stripped
    expect(bashIdx).toBeGreaterThanOrEqual(0);
    expect(skillIdx).toBeGreaterThanOrEqual(0);
    expect(skillIdx).toBeGreaterThan(bashIdx);
  });

  it('renders only the Skill trailing row when turn has no non-Skill tools', () => {
    const { container } = renderTurn(oneGroup([skillTool('s1', 'superpowers:brainstorming')]));
    expect(container.innerHTML).toContain('Invoked skill: brainstorming');
  });

  it('stacks multiple Skills into ONE card, in invocation order, at the end', () => {
    // Two or more skills in a turn read as a single "Invoked 2 skills: one and two" card, still after every other tool.
    const { container } = renderTurn(oneGroup([skillTool('s1', 'superpowers:one'), bashTool('b1', 'ls -la /tmp'), skillTool('s2', 'superpowers:two')]));
    const html = container.innerHTML;
    const stackedIdx = html.indexOf('Invoked 2 skills: one and two');
    const bashIdx = html.indexOf('ls -la /tmp');
    expect(bashIdx).toBeGreaterThanOrEqual(0);
    expect(stackedIdx).toBeGreaterThanOrEqual(0);
    expect(bashIdx).toBeLessThan(stackedIdx);
    expect(html).not.toContain('Invoked skill: one');
    expect(html).not.toContain('Invoked skill: two');
  });
});

describe('CollapsedToolGroup — stopped specialists', () => {
  beforeEach(() => cleanup());

  it('shows a stopped icon rather than a spinner after a specialist stops', () => {
    const task: ToolCallState = {
      toolUseId: 'task-1', toolName: 'Task', input: { description: 'inspect the issue' }, status: 'running',
      specialistRun: {
        childId: 'child-1', parentToolCallId: 'task-1', agentType: 'explorer', title: 'Quinn',
        background: true, status: 'interrupted', startedAt: 1000, endedAt: 2000,
      },
    };
    const { container } = renderTurn(oneGroup([task, bashTool('bash-1', 'git status')]));
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

  /** Mounts, then re-renders with `change(initial)`; returns the markdown render counts before and after. */
  function remount(initial: BubbleProps, change: (p: BubbleProps) => BubbleProps) {
    const { rerender } = renderTurn(initial);
    const before = mdRenders.length;
    expect(before).toBeGreaterThan(0);
    rerender(bubble(change(initial)));
    return { before, after: mdRenders.length };
  }

  it('does NOT re-render when an unrelated tool changes in the shared Maps', () => {
    // The reducer hands every turn fresh toolCalls/toolGroups Map references whenever ANY tool updates; the
    // comparator must see THIS turn's own entries are unchanged and skip the markdown re-parse.
    const { before, after } = remount(oneGroup([bashTool('b1', 'git status')], { id: 'turn_a', text: 'hello world' }), (p) => {
      const toolGroups = new Map(p.toolGroups).set('g2', { id: 'g2', toolIds: ['b2'] });
      const toolCalls = new Map(p.toolCalls).set('b2', bashTool('b2', 'npm test'));
      return { ...p, toolGroups, toolCalls };
    });
    expect(after).toBe(before);
  });

  it('DOES re-render when its own tool entry changes', () => {
    // Guards against over-blocking: b1 running -> complete (new object, new Map) must let the re-render through.
    const { before, after } = remount(
      oneGroup([{ ...bashTool('b1', 'git status'), status: 'running' }], { id: 'turn_b', text: 'hello world' }),
      (p) => ({ ...p, toolCalls: new Map(p.toolCalls).set('b1', { ...bashTool('b1', 'git status'), response: 'ok' }) }),
    );
    expect(after).toBeGreaterThan(before);
  });

  it('DOES re-render when the turn object itself changes', () => {
    // The comparator keys on `turn` by reference: a new turn object (a streamed text delta) must always re-render.
    const { before, after } = remount(oneGroup([bashTool('b1', 'git status')], { id: 'turn_c', text: 'hello' }), (p) => ({
      ...p, turn: { ...p.turn, segments: [seg.text('turn_c-msg', 'hello world'), p.turn.segments[1]] },
    }));
    expect(after).toBeGreaterThan(before);
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
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(/closed/i);
  });

  it('says nothing for a normal completion', () => {
    // Without this, a footer that renders unconditionally passes the test above.
    const { container } = renderTurn({
      turn: turnWithStopReason('end_turn'),
      toolGroups: new Map(),
      toolCalls: new Map(),
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('renders the empty-response copy for stopReason empty_response', () => {
    // Empty-step recovery (spec 2026-08-21): the harness already retried once
    // silently — this footer is the honest end after a SECOND contentless step.
    const { container } = renderTurn({
      turn: turnWithStopReason('empty_response'),
      toolGroups: new Map(),
      toolCalls: new Map(),
    });
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(/empty response/i);
  });

  it('end_turn never renders the empty-response copy', () => {
    const { container } = renderTurn({
      turn: turnWithStopReason('end_turn'),
      toolGroups: new Map(),
      toolCalls: new Map(),
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
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
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(/empty response/i);
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
