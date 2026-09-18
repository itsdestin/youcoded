// @vitest-environment jsdom
// subagent-view.test.tsx
// Tests for the SubagentTimeline component — verifies it renders text segments
// as prose, tool segments with tool name visible, and respects render order.
// ToolBody is mocked because it depends on ChatStateContext and xterm internals
// that aren't available in jsdom.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Mock ToolBody so it doesn't pull in ChatStateContext / xterm / electron.
vi.mock('../src/renderer/components/tool-views/ToolBody', () => ({
  default: ({ tool }: { tool: { toolName: string } }) => (
    <div data-testid="tool-body">{tool.toolName}</div>
  ),
}));

// Mock MarkdownContent to avoid remark/rehype heavy imports in jsdom.
vi.mock('../src/renderer/components/MarkdownContent', () => ({
  default: ({ content }: { content: string }) => <span>{content}</span>,
}));

// Wraps the real friendlyToolDisplay in a spy so tests can count how many
// times a ROW actually re-rendered (SubagentToolRow calls it once per render)
// — proves the Task 10 memo skips an untouched sibling on an expand click.
vi.mock('../src/renderer/components/ToolCard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/components/ToolCard')>();
  return { ...actual, friendlyToolDisplay: vi.fn(actual.friendlyToolDisplay) };
});

import { SubagentTimeline } from '../src/renderer/components/tool-views/SubagentTimeline';
import { friendlyToolDisplay } from '../src/renderer/components/ToolCard';
import type { SubagentSegment } from '../src/shared/types';

beforeEach(() => {
  vi.mocked(friendlyToolDisplay).mockClear();
});

describe('SubagentTimeline', () => {
  it('renders nothing for empty segments', () => {
    const { container } = render(<SubagentTimeline segments={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a text segment as prose', () => {
    const segments: SubagentSegment[] = [
      { type: 'text', id: 't1', content: 'I will check the Android side.' },
    ];
    render(<SubagentTimeline segments={segments} />);
    // getByText throws if not found — presence is the assertion
    expect(screen.getByText(/Android side/)).toBeTruthy();
  });

  it('renders a tool segment with tool name visible', () => {
    const segments: SubagentSegment[] = [
      {
        type: 'tool', id: 't1', toolUseId: 'toolu_X', toolName: 'Read',
        input: { file_path: '/a' }, status: 'running',
      },
    ];
    render(<SubagentTimeline segments={segments} />);
    // getAllByText because the tool name appears in both the header label and the ToolBody mock
    expect(screen.getAllByText(/Read/).length).toBeGreaterThan(0);
  });

  it('renders multiple segments in order', () => {
    const segments: SubagentSegment[] = [
      { type: 'text', id: 't1', content: 'First thought' },
      { type: 'tool', id: 't2', toolUseId: 'toolu_X', toolName: 'Read', input: {}, status: 'complete', response: 'done' },
      { type: 'text', id: 't3', content: 'Second thought' },
    ];
    const { container } = render(<SubagentTimeline segments={segments} />);
    expect(container.textContent).toMatch(/First thought[\s\S]*Read[\s\S]*Second thought/);
  });

  it('shows running-vs-complete status via distinct icons', () => {
    const runningSegments: SubagentSegment[] = [
      { type: 'tool', id: 't1', toolUseId: 'toolu_X', toolName: 'Bash',
        input: { command: 'ls' }, status: 'running' },
    ];
    const { rerender, container } = render(<SubagentTimeline segments={runningSegments} />);
    // Running state uses BrailleSpinner (unicode char, no status SVG).
    // CheckIcon / FailIcon both render an outer <circle cx="12" cy="12"> —
    // ChevronIcon (also present) has no circle, so we distinguish by that.
    const statusSvgs = (c: HTMLElement) =>
      Array.from(c.querySelectorAll('svg')).filter(s => s.querySelector('circle'));
    expect(statusSvgs(container).length).toBe(0);

    const doneSegments: SubagentSegment[] = [
      { type: 'tool', id: 't1', toolUseId: 'toolu_X', toolName: 'Bash',
        input: { command: 'ls' }, status: 'complete', response: 'ok' },
    ];
    rerender(<SubagentTimeline segments={doneSegments} />);
    expect(statusSvgs(container).length).toBe(1);
  });
});

describe('SubagentTimeline — row memo (Task 10)', () => {
  it('expanding one row does not re-render its untouched sibling', () => {
    const segments: SubagentSegment[] = [
      { type: 'tool', id: 't1', toolUseId: 'toolu_1', toolName: 'Read', input: { file_path: '/a' }, status: 'complete', response: 'ok' },
      { type: 'tool', id: 't2', toolUseId: 'toolu_2', toolName: 'Bash', input: { command: 'ls' }, status: 'complete', response: 'ok' },
    ];
    render(<SubagentTimeline segments={segments} />);
    // Initial render: each row calls friendlyToolDisplay exactly once.
    expect(vi.mocked(friendlyToolDisplay).mock.calls.map(([tool]) => (tool as any).toolName))
      .toEqual(['Read', 'Bash']);

    fireEvent.click(screen.getByRole('button', { name: /Read/ }));

    // Read's row re-rendered (its own `expanded` changed); Bash's row did
    // NOT — the memo skipped it because segment/id/toggle/separatorAbove/
    // sessionId/specialistName/suppressAsk were all unchanged for it.
    expect(vi.mocked(friendlyToolDisplay).mock.calls.map(([tool]) => (tool as any).toolName))
      .toEqual(['Read', 'Bash', 'Read']);
  });
});
