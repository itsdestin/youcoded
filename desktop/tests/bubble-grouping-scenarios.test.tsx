// @vitest-environment jsdom
// Bubble grouping stress suite (2026-09-02).
//
// Born from a screenshot of a native DeepSeek session: three consecutive tool
// calls rendered as three bubbles, a bare empty bubble sat between steps, and
// "Interrupted." floated in a bubble of its own. Root cause: the model streams
// newline-only text chunks between and after tool calls, the reducer turned
// each into a text segment, and every text segment opens a bubble.
//
// Every scenario here replays an EVENT STREAM (the same actions App.tsx
// dispatches for live events) through the real reducer, renders each turn with
// the real AssistantTurnBubble, and reduces the DOM to a signature:
//   one line per bubble → tokens: R (reasoning) · T (text) · T∅ (text that
//   renders nothing) · {Tool Tool} (one tool group) · D (deliverables card) ·
//   S:Name (trailing skill row) · F:<stop reason> (footer)
// A signature makes a wrong grouping readable at a glance in the failure diff.
//
// THE RULE (Destin, 2026-09-02): a bubble shows ONE reasoning section, ONE
// message and ONE tool group, in that order. A reasoning/tool step that
// produces no visible text does not separate from the next step — its thought
// merges into the reasoning section, its tools into the group. A new bubble
// begins only after the assistant has SPOKEN: reasoning → text → [split] →
// reasoning again.
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ChatProvider } from '../src/renderer/state/chat-context';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import type { ChatState, ChatAction, AssistantTurn } from '../src/renderer/state/chat-types';

vi.mock('../src/renderer/components/MarkdownContent', () => ({
  default: ({ content }: { content: string }) => <div data-md>{content}</div>,
}));
// ToolCard pulls in the whole tool-body pipeline; a stub that names the tool is
// all the signature needs. Named exports stay real (DeliverablesCard imports one).
vi.mock('../src/renderer/components/ToolCard', async (orig) => ({
  ...(await orig<typeof import('../src/renderer/components/ToolCard')>()),
  default: ({ tool }: { tool: { toolName: string; status: string } }) => (
    <div data-tool={tool.toolName} data-status={tool.status} />
  ),
}));
vi.mock('../src/renderer/components/DeliverablesCard', async (orig) => ({
  ...(await orig<typeof import('../src/renderer/components/DeliverablesCard')>()),
  DeliverablesCard: () => <div data-deliverables />,
}));

import AssistantTurnBubble, { splitIntoBubbles } from '../src/renderer/components/AssistantTurnBubble';
import { broadcastExpandAll } from '../src/renderer/hooks/useExpandAllToggle';

(window as any).matchMedia = (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} });
(globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
afterEach(cleanup);
// Collapsed groups hide their cards; the signature needs every card visible.
broadcastExpandAll();

const S = 'stress';

// ---- event DSL -------------------------------------------------------------
// Mirrors App.tsx's per-event dispatches. `partId` present = native runtime
// (per-delta merge); absent = Claude Code's whole-block append.
type Ev =
  | ['user', string]
  | ['reason', string, string?]
  | ['text', string, string?]
  | ['prep', string, string]
  | ['tool', string, string, Record<string, unknown>?]
  | ['result', string, string?, boolean?]
  | ['ask', string, string, Record<string, unknown>]
  | ['answered', string]
  | ['interrupt']
  | ['done', string?];

let seq = 0;
function toAction(ev: Ev): ChatAction {
  const t = 1000 + seq++;
  switch (ev[0]) {
    case 'user': return { type: 'USER_PROMPT', sessionId: S, content: ev[1], timestamp: t };
    case 'reason': return { type: 'TRANSCRIPT_ASSISTANT_REASONING', sessionId: S, uuid: `u${t}`, text: ev[1], timestamp: t, partId: ev[2] };
    case 'text': return { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: S, uuid: `u${t}`, text: ev[1], timestamp: t, partId: ev[2] };
    case 'prep': return { type: 'NATIVE_TOOL_PREPARING', sessionId: S, toolCallId: ev[1], toolName: ev[2], chars: 0 };
    case 'tool': return { type: 'TRANSCRIPT_TOOL_USE', sessionId: S, uuid: `u${t}`, toolUseId: ev[1], toolName: ev[2], toolInput: ev[3] ?? {} };
    case 'result': return { type: 'TRANSCRIPT_TOOL_RESULT', sessionId: S, uuid: `u${t}`, toolUseId: ev[1], result: ev[2] ?? 'ok', isError: ev[3] ?? false };
    case 'ask': return { type: 'PERMISSION_REQUEST', sessionId: S, toolName: ev[2], input: ev[3], requestId: ev[1] };
    case 'answered': return { type: 'PERMISSION_RESPONDED', sessionId: S, requestId: ev[1] };
    case 'interrupt': return { type: 'TRANSCRIPT_INTERRUPT', sessionId: S, uuid: `u${t}`, timestamp: t, kind: 'plain' };
    case 'done': return { type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: S, uuid: `u${t}`, timestamp: t, stopReason: ev[1] ?? 'end_turn', model: null, anthropicRequestId: null, usage: null };
  }
}

function replay(events: Ev[]) {
  let state: ChatState = chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: S });
  for (const ev of events) state = chatReducer(state, toAction(ev));
  const session = state.get(S)!;
  const turns = session.timeline
    .filter((e): e is Extract<typeof e, { kind: 'assistant-turn' }> => e.kind === 'assistant-turn')
    .map((e) => session.assistantTurns.get(e.turnId)!);
  return { session, turns };
}

// ---- signature -------------------------------------------------------------
function signature(events: Ev[]): string[] {
  const { session, turns } = replay(events);
  const out: string[] = [];
  for (const turn of turns) {
    const { container, unmount } = render(
      <ChatProvider>
        <AssistantTurnBubble turn={turn} toolGroups={session.toolGroups} toolCalls={session.toolCalls} sessionId={S} showTimestamps={false} />
      </ChatProvider>,
    );
    const bubbles = [...container.querySelectorAll('.assistant-bubble')];
    for (const b of bubbles) {
      // Walk the bubble's DIRECT children in order, so the signature reads in
      // the order a user sees it (reasoning, tools, text, …).
      const tokens: string[] = [];
      for (const child of b.children) {
        if (child.matches('.mb-2') && /(Show|Hide) reasoning/.test(child.textContent ?? '')) { tokens.push('R'); continue; }
        if (child.matches('[data-md]')) { tokens.push((child.textContent ?? '').trim() ? 'T' : 'T∅'); continue; }
        // ToolGroupInline's root is `.my-0\.5`; the trailing skill row is `.mt-1.space-y-0.5`.
        if (child.matches('.my-0\\.5')) {
          const names = [...child.querySelectorAll('[data-tool]')].map((el) => el.getAttribute('data-tool'));
          tokens.push(`{${names.join(' ')}}`);
          continue;
        }
        if (child.matches('[data-deliverables]') || child.querySelector('[data-deliverables]')) { tokens.push('D'); continue; }
        if (child.matches('.mt-1.space-y-0\\.5')) {
          for (const t of child.querySelectorAll(':scope > [data-tool]')) tokens.push(`S:${t.getAttribute('data-tool')}`);
          const stacked = child.querySelector('[data-testid=stacked-skills]');
          if (stacked) tokens.push(`S:[${stacked.textContent}]`);
          continue;
        }
        if (child.matches('[role=status]')) { tokens.push(`F:${child.textContent}`); continue; }
      }
      out.push(tokens.join(' '));
    }
    // A segment-less turn with an abnormal stop renders a footer row, no shell.
    if (bubbles.length === 0) {
      const f = container.querySelector('[role=status]');
      out.push(f ? `(no bubble) F:${f.textContent}` : '(nothing)');
    }
    unmount();
  }
  return out;
}

// ---- scenarios -------------------------------------------------------------
describe('bubble grouping — native runtime (per-delta streams)', () => {
  it('the screenshot: newline-only chunks between tool calls do not split or add bubbles', () => {
    // Exact shape of the 2026-09-01 DeepSeek session: text ends in newlines,
    // a "\n" chunk lands between every tool the model composes, a lone
    // "\n\n\n" precedes the last tool, and the user stops the turn while the
    // next step has streamed only "\n".
    const sig = signature([
      ['user', 'prepare a handoff doc'],
      ['reason', 'The user wants a handoff doc…', 'reasoning-0'],
      ['text', 'The bash tool seems flaky — using file tools.\n\n', 'txt-0'],
      ['prep', 'c1', 'Glob'], ['text', '\n', 'txt-0'],
      ['prep', 'c2', 'Read'], ['text', '\n', 'txt-0'],
      ['prep', 'c3', 'Read'], ['text', '\n', 'txt-0'],
      ['tool', 'c1', 'Glob', { pattern: 'docs/*.md' }], ['tool', 'c2', 'Read'], ['tool', 'c3', 'Read'],
      ['result', 'c1'], ['result', 'c2'], ['result', 'c3'],
      ['reason', 'I have everything I need.', 'reasoning-0'],
      ['text', 'Writing the handoff doc now:\n\n\n', 'txt-0'],
      ['prep', 'c4', 'Write'], ['tool', 'c4', 'Write'], ['result', 'c4'],
      ['text', '\n\n\n', 'txt-0'],
      ['prep', 'c5', 'Grep'], ['tool', 'c5', 'Grep'], ['result', 'c5', 'Cannot search', true],
      ['text', '\n', 'txt-0'],
      ['interrupt'],
    ]);
    expect(sig).toEqual([
      'R T {Glob Read Read}',
      'R T {Write Grep} F:Interrupted.',
    ]);
  });

  it('a newline chunk before the step\'s reasoning does not open an empty bubble', () => {
    const sig = signature([
      ['user', 'go'],
      ['text', 'Checking.', 'txt-0'], ['prep', 'a', 'Read'], ['tool', 'a', 'Read'], ['result', 'a'],
      ['text', ' \n', 'txt-0'],
      ['reason', 'Now the second file.', 'reasoning-0'],
      ['text', 'Second file next.', 'txt-0'], ['prep', 'b', 'Read'], ['tool', 'b', 'Read'], ['result', 'b'],
      ['done'],
    ]);
    expect(sig).toEqual(['T {Read}', 'R T {Read}']);
  });

  it('a turn that ends on a newline chunk does not leave an empty bubble', () => {
    const sig = signature([
      ['user', 'go'],
      ['text', 'Done reading.', 'txt-0'], ['prep', 'a', 'Read'], ['tool', 'a', 'Read'], ['result', 'a'],
      ['text', '\n\n', 'txt-0'],
      ['done'],
    ]);
    expect(sig).toEqual(['T {Read}']);
  });

  it('whitespace INSIDE a paragraph still merges (paragraph breaks survive)', () => {
    const { turns } = replay([
      ['user', 'go'],
      ['text', 'Para one.', 'txt-0'], ['text', '\n\n', 'txt-0'], ['text', 'Para two.', 'txt-0'],
      ['done'],
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].segments).toEqual([
      expect.objectContaining({ type: 'text', content: 'Para one.\n\nPara two.' }),
    ]);
  });

  it('a whitespace-only reasoning chunk never opens a reasoning-only bubble', () => {
    const sig = signature([
      ['user', 'go'],
      ['text', 'Reading.', 'txt-0'], ['prep', 'a', 'Read'], ['tool', 'a', 'Read'], ['result', 'a'],
      ['reason', '\n', 'reasoning-0'],
      ['done'],
    ]);
    expect(sig).toEqual(['T {Read}']);
  });

  it('stop during reasoning: the footer sits under the reasoning bubble', () => {
    const sig = signature([
      ['user', 'go'],
      ['reason', 'Let me think about this carefully…', 'reasoning-0'],
      ['interrupt'],
    ]);
    expect(sig).toEqual(['R F:Interrupted.']);
  });

  it('stop before anything streamed: no turn, nothing rendered', () => {
    const { turns } = replay([['user', 'go'], ['interrupt']]);
    expect(turns).toHaveLength(0);
  });

  it('reasoning between tool steps starts a new bubble (each step is one bubble)', () => {
    const sig = signature([
      ['user', 'go'],
      ['reason', 'step one', 'reasoning-0'], ['text', 'First.', 'txt-0'], ['prep', 'a', 'Bash'], ['tool', 'a', 'Bash'], ['result', 'a'],
      ['reason', 'step two', 'reasoning-0'], ['prep', 'b', 'Read'], ['tool', 'b', 'Read'], ['result', 'b'],
      ['reason', 'step three', 'reasoning-0'], ['text', 'All done.', 'txt-0'],
      ['done'],
    ]);
    // Step two spoke nothing, so it stays with step three (its thought merges
    // into the reasoning section, its tool into the group); the split comes
    // only after "First." was said.
    expect(sig).toEqual(['R T {Bash}', 'R T {Read}']);
  });

  it('silent steps (reasoning + tool, no text) share one bubble until the assistant speaks', () => {
    // Destin's 2026-09-02 screenshot: three bubbles of "Show reasoning" over
    // one tool each, the last one reasoning alone with the timestamp.
    const silent: Ev[] = [
      ['user', 'sync everything'],
      ['reason', 'Sync all the repos first.', 'reasoning-0'], ['prep', 'a', 'Bash'], ['tool', 'a', 'Bash'], ['result', 'a'],
      ['reason', 'Now check the workspace itself.', 'reasoning-0'], ['prep', 'b', 'Bash'], ['tool', 'b', 'Bash'], ['result', 'b'],
      ['reason', 'Everything is in sync; nothing to report.', 'reasoning-0'],
    ];
    // One reasoning section (all three thoughts merged), one group of both tools.
    expect(signature(silent)).toEqual(['R {Bash Bash}']);
    // Then it speaks: the text joins that same bubble, between the two …
    const spoke: Ev[] = [...silent, ['text', 'All synced.', 'txt-0']];
    expect(signature(spoke)).toEqual(['R T {Bash Bash}']);
    // … and only the NEXT reasoning opens a new one.
    expect(signature([...spoke, ['reason', 'One more check.', 'reasoning-0'], ['prep', 'c', 'Read'], ['tool', 'c', 'Read'], ['result', 'c'], ['done']]))
      .toEqual(['R T {Bash Bash}', 'R {Read}']);
    // The merged reasoning section carries every thought, in order.
    const { turns } = replay(silent);
    const merged = splitIntoBubbles(turns[0])[0].reasoning!.content;
    expect(merged.indexOf('Sync all')).toBeLessThan(merged.indexOf('Now check'));
    expect(merged.indexOf('Now check')).toBeLessThan(merged.indexOf('Everything is in sync'));
  });

  it('tool cards keep the order the tools were CALLED, whatever order results arrive', () => {
    const sig = signature([
      ['user', 'go'],
      ['text', 'Looking.', 'txt-0'],
      ['prep', 'a', 'Read'], ['prep', 'b', 'Grep'], ['prep', 'c', 'Glob'],
      ['tool', 'a', 'Read'], ['tool', 'b', 'Grep'], ['tool', 'c', 'Glob'],
      ['result', 'c'], ['result', 'b'], ['result', 'a'],
      ['done'],
    ]);
    expect(sig).toEqual(['T {Read Grep Glob}']);
  });

  it('a tool that starts with no reasoning or text joins the previous bubble', () => {
    const sig = signature([
      ['user', 'go'],
      ['text', 'Looking.', 'txt-0'], ['prep', 'a', 'Glob'], ['tool', 'a', 'Glob'], ['result', 'a'],
      ['prep', 'b', 'Read'], ['tool', 'b', 'Read'], ['result', 'b'],
      ['text', 'Found it.', 'txt-0'],
      ['done'],
    ]);
    expect(sig).toEqual(['T {Glob Read}', 'T']);
  });

  it('a deliverable renders inside its bubble and never as a hollow one', () => {
    const sig = signature([
      ['user', 'go'],
      ['text', 'Here is the chart.', 'txt-0'],
      ['prep', 'a', 'SendUserFile'], ['tool', 'a', 'SendUserFile', { files: ['chart.png'] }], ['result', 'a'],
      ['text', '\n', 'txt-0'],
      ['done'],
    ]);
    expect(sig).toEqual(['T D']);
  });
});

describe('bubble grouping — hidden tools must not leave hollow bubbles', () => {
  it('a tool awaiting approval as the only content: no shell in the timeline until it is answered', () => {
    // The ask card renders pinned at the bottom of the timeline, so the bubble
    // that "holds" it has nothing to show. A local model with no reasoning
    // often opens a turn with a bare tool call.
    const pending: Ev[] = [
      ['user', 'go'],
      ['prep', 'a', 'Bash'], ['tool', 'a', 'Bash', { command: 'rm -rf build' }],
      ['ask', 'req-1', 'Bash', { command: 'rm -rf build' }],
    ];
    expect(signature(pending)).toEqual(['(nothing)']);
    // Answered → the card comes home to its bubble.
    expect(signature([...pending, ['answered', 'req-1'], ['result', 'a'], ['done']])).toEqual(['{Bash}']);
  });

  it('a skill invoked first (CC "/skill") does not leave a hollow bubble above the reply', () => {
    // Claude Code: the Skill tool_use is the first block of the turn; the
    // skill row floats to the LAST bubble, which used to leave bubble 1 empty.
    const sig = signature([
      ['user', '/ui-mockup the settings drawer'],
      ['tool', 'a', 'Skill', { skill: 'ui-mockup' }], ['result', 'a'],
      ['text', 'Using ui-mockup to build the drawer in the workbench.'],
      ['tool', 'b', 'Read'], ['result', 'b'],
      ['done'],
    ]);
    expect(sig).toEqual(['T {Read} S:Skill']);
  });

  it('two skills in one turn stack into a single card at the end', () => {
    const sig = signature([
      ['user', 'design it, then plan it'],
      ['text', 'Starting with the design pass.'],
      ['tool', 'a', 'Skill', { skill: 'superpowers:brainstorming' }], ['result', 'a'],
      ['text', 'Two questions first.'],
      ['tool', 'b', 'Read'], ['result', 'b'],
      ['text', 'Writing the plan now.'],
      ['tool', 'c', 'Skill', { skill: 'superpowers:writing-plans' }], ['result', 'c'],
      ['tool', 'd', 'Write'], ['result', 'd'],
      ['done'],
    ]);
    expect(sig).toEqual(['T', 'T {Read}', 'T {Write} S:[Invoked 2 skills: brainstorming and writing-plans]']);
  });

  it('three skills read "a, b and c"; a repeat collapses to "×2"', () => {
    const three = signature([
      ['user', 'go'],
      ['tool', 'a', 'Skill', { skill: 'audit' }], ['result', 'a'],
      ['tool', 'b', 'Skill', { skill: 'superpowers:brainstorming' }], ['result', 'b'],
      ['tool', 'c', 'Skill', { skill: 'ui-mockup' }], ['result', 'c'],
      ['text', 'Done.'], ['done'],
    ]);
    expect(three).toEqual(['T S:[Invoked 3 skills: audit, brainstorming and ui-mockup]']);
    const repeat = signature([
      ['user', 'go'],
      ['tool', 'a', 'Skill', { skill: 'audit' }], ['result', 'a'],
      ['tool', 'b', 'Skill', { skill: 'audit' }], ['result', 'b'],
      ['text', 'Done.'], ['done'],
    ]);
    expect(repeat).toEqual(['T S:[Invoked 2 skills: audit ×2]']);
  });

  it('a skill-only turn still shows its skill row', () => {
    const sig = signature([
      ['user', '/audit'],
      ['tool', 'a', 'Skill', { skill: 'audit' }], ['result', 'a'],
    ]);
    expect(sig).toEqual(['S:Skill']);
  });
});

describe('bubble grouping — Claude Code (whole-block events, no partId)', () => {
  it('several tool blocks across messages with no text between them share a bubble', () => {
    const sig = signature([
      ['user', 'fix the scroll'],
      ['text', 'Reading the view first.'],
      ['tool', 'a', 'Read'], ['result', 'a'],
      ['tool', 'b', 'Grep'], ['tool', 'c', 'Grep'], ['result', 'b'], ['result', 'c'],
      ['text', 'Found the cause.'],
      ['tool', 'd', 'Edit'], ['result', 'd'],
      ['text', 'Fixed.'],
      ['done'],
    ]);
    expect(sig).toEqual(['T {Read Grep Grep}', 'T {Edit}', 'T']);
  });

  it('an empty reply (max_tokens) renders the footer row and no shell', () => {
    const sig = signature([['user', 'go'], ['text', 'Half a thou'], ['done', 'max_tokens']]);
    expect(sig).toEqual(['T F:Response truncated — Your assistant hit the output token limit.']);
    const empty = signature([
      ['user', 'go'], ['text', 'x'], ['done'],
      // second turn: a contentless step that ended abnormally
      ['user', 'again'], ['done', 'empty_response'],
    ]);
    expect(empty[1]).toMatch(/^\(no bubble\) F:The model returned an empty response twice/);
  });
});
