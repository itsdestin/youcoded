// @vitest-environment jsdom
/**
 * Pins malformed-input hardening for the EXPANDED tool card (ToolBody.tsx) and
 * the AskUserQuestion card's deep fields (ToolCard.tsx).
 *
 * Tool inputs are unknown-typed JSON from the model/provider. PR #295 fixed the
 * collapsed header (friendlyToolDisplay), but the expanded body kept the same
 * lie-casts: `input.x as string` guarded only by truthiness. An object survives
 * `(x as string) || ''` (objects are truthy), then either
 *  - a string method / basename() throws, or
 *  - React throws "Objects are not valid as a React child",
 * taking down the whole Chat pane via its ErrorBoundary. Template-literal sites
 * instead render "[object Object]".
 *
 * Exposure is on card expand, so these tests drive the real ToolCard the way
 * ToolCard.test.tsx's Always-allow section does: mount inside ChatProvider, click the
 * header to expand, and assert the body rendered without crashing or leaking
 * "[object Object]".
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import ToolCard from '../src/renderer/components/ToolCard';
import { ChatProvider } from '../src/renderer/state/chat-context';
import type { ToolCallState } from '../src/shared/types';

// This suite mounts many cards; auto-cleanup isn't configured globally, so
// clean up explicitly or queries match prior tests' leftover DOM.
afterEach(cleanup);

const tool = (toolName: string, input: Record<string, unknown>, extra: Partial<ToolCallState> = {}): ToolCallState => ({
  id: 'tool-1',
  toolUseId: 'toolu_1',
  toolName,
  input,
  status: 'complete',
  ...extra,
} as ToolCallState);

// Expand the card the way a user does — click the header button (the chevron
// testid sits inside it). Returns the rendered container for text assertions.
function renderExpanded(t: ToolCallState): HTMLElement {
  const { container } = render(<ChatProvider><ToolCard tool={t} sessionId="s1" /></ChatProvider>);
  fireEvent.click(screen.getByTestId('tool-card-chevron').closest('button')!);
  expect(screen.getByTestId('tool-card-body')).toBeTruthy();
  return container;
}

describe('ToolBody — malformed (non-string) inputs never crash or leak [object Object]', () => {
  it('Grep: object-valued pattern/glob/path neither crash basename() nor render as children', () => {
    const container = renderExpanded(tool('Grep', {
      pattern: { bad: true },   // rendered as a React child inside <code>
      glob: { bad: true },      // template-literal Chip
      path: { bad: true },      // basename() crash
    }, { response: 'src/a.ts\nsrc/b.ts' }));
    expect(container.textContent).not.toContain('[object Object]');
    // The results list still renders — malformed inputs degrade, they don't blank the card.
    expect(container.textContent).toContain('src/a.ts');
  });

  it('Glob: object-valued pattern and path neither crash nor render', () => {
    const container = renderExpanded(tool('Glob', {
      pattern: { bad: true },   // rendered as a React child inside <code>
      path: { bad: true },      // basename() crash
    }, { response: 'src/a.ts' }));
    expect(container.textContent).not.toContain('[object Object]');
    expect(container.textContent).toContain('src/a.ts');
  });

  it('Edit: object-valued file_path and old/new_string neither crash PathHeader nor the diff', () => {
    const container = renderExpanded(tool('Edit', {
      file_path: { bad: true },  // basename() crash in PathHeader
      old_string: { bad: true }, // jsdiff expects strings
      new_string: { bad: true },
    }));
    expect(container.textContent).not.toContain('[object Object]');
  });

  it('Bash: object-valued command is not rendered as a React child', () => {
    const container = renderExpanded(tool('Bash', { command: { bad: true } }));
    expect(container.textContent).not.toContain('[object Object]');
    expect(container.textContent).toContain('(no command)');
  });

  it('Read: object-valued offset/limit never reach the "lines N–M" interpolation', () => {
    const container = renderExpanded(tool('Read', {
      file_path: '/a/b.ts',
      offset: { bad: true },
      limit: { bad: true },
    }));
    expect(container.textContent).not.toContain('[object Object]');
    expect(container.textContent).not.toContain('NaN');
  });

  it('Read: a legitimate offset of 0 still renders the range chip (no falsy-zero trap)', () => {
    const container = renderExpanded(tool('Read', { file_path: '/a/b.ts', offset: 0, limit: 5 }));
    expect(container.textContent).toContain('lines 0–5');
  });

  it('WebFetch: object-valued url/prompt neither crash new URL() fallback nor render', () => {
    const container = renderExpanded(tool('WebFetch', {
      url: { bad: true },    // catch branch set domain = url → object React child
      prompt: { bad: true },
    }));
    expect(container.textContent).not.toContain('[object Object]');
  });

  it('TodoWrite: non-array todos and object-valued content/activeForm degrade instead of crashing', () => {
    const c1 = renderExpanded(tool('TodoWrite', { todos: { bad: true } })); // .map() crash
    expect(c1.textContent).toContain('No todos.');
    cleanup();
    const c2 = renderExpanded(tool('TodoWrite', {
      todos: [
        { content: { bad: true }, status: 'pending' },            // object React child
        { content: 'real item', activeForm: { bad: true }, status: 'in_progress' },
      ],
    }));
    expect(c2.textContent).not.toContain('[object Object]');
    expect(c2.textContent).toContain('real item'); // object activeForm falls back to content
  });

  it('TaskUpdate: object-valued subject/taskId are not passed through by ?? fallbacks', () => {
    // `?? task?.subject` only falls back on nullish — an object sails through
    // and crashes React child rendering.
    const container = renderExpanded(tool('TaskUpdate', {
      taskId: { bad: true },
      subject: { bad: true },
      status: 'completed',
    }));
    expect(container.textContent).not.toContain('[object Object]');
  });

  it('Agent: object-valued description/subagent_type/prompt degrade to the defaults', () => {
    const container = renderExpanded(tool('Agent', {
      description: { bad: true },
      subagent_type: { bad: true }, // Chip child
      prompt: { bad: true },        // MarkdownContent requires a string
    }));
    expect(container.textContent).not.toContain('[object Object]');
    expect(container.textContent).toContain('general-purpose');
  });
});

describe('AskUserQuestion — malformed deep fields degrade gracefully', () => {
  const askTool = (questions: unknown): ToolCallState =>
    tool('AskUserQuestion', { questions }, { status: 'awaiting-approval', requestId: 'req-1' });

  it('object-valued header/label/description on a LATER question never reach React children', () => {
    // isValidQuestions only checked questions[0].question, so deep fields could
    // crash the expanded card even when the first question was well-formed.
    const { container } = render(
      <ChatProvider>
        <ToolCard
          tool={askTool([
            { question: 'Pick one', header: 'Choice', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
            {
              question: 'Second question',
              header: { bad: true },                     // object React child
              multiSelect: false,
              options: [
                { label: { bad: true } },                // object React child
                { label: 'C', description: { bad: true } }, // object React child
              ],
            },
          ])}
          sessionId="s1"
        />
      </ChatProvider>,
    );
    expect(container.textContent).not.toContain('[object Object]');
    // The valid parts still render — malformed members degrade, they don't
    // invalidate the whole card.
    expect(screen.getByText('Pick one')).toBeTruthy();
    expect(screen.getByText('A')).toBeTruthy();
    expect(screen.getByText('Second question')).toBeTruthy();
    expect(screen.getByText('C')).toBeTruthy();
  });

  it('a wholly malformed member is dropped without invalidating the card', () => {
    const { container } = render(
      <ChatProvider>
        <ToolCard
          tool={askTool([
            { question: 'Pick one', header: 'Choice', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
            { question: { bad: true }, options: 'not-an-array' },
          ])}
          sessionId="s1"
        />
      </ChatProvider>,
    );
    expect(container.textContent).not.toContain('[object Object]');
    expect(screen.getByText('Pick one')).toBeTruthy();
    expect(screen.getByText('Submit')).toBeTruthy();
  });
});
