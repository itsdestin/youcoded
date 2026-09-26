// @vitest-environment jsdom
// The card a person sees for a Claude Code background helper (2026-09-24,
// "background agents often get immediately marked as complete"): it spins
// while the helper works, and its Report is the helper's own report — never
// Claude Code's launch receipt, which tells the model "do not mention to user".
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import ToolCard from '../src/renderer/components/ToolCard';
import { CollapsedToolGroup } from '../src/renderer/components/AssistantTurnBubble';
import { ChatProvider } from '../src/renderer/state/chat-context';
import type { ToolCallState, CcBackgroundRun } from '../src/shared/types';

afterEach(cleanup);
const RECEIPT = 'Async agent launched successfully.\nagentId: a3ecf (internal ID - do not mention to user.)';
const agent = (bg?: CcBackgroundRun): ToolCallState => ({
  id: 'x', toolUseId: 'toolu_A', toolName: 'Agent', status: 'complete',
  input: { description: 'Fetch guidance', prompt: 'go' }, response: RECEIPT, ccBackground: bg,
} as ToolCallState);
function open(t: ToolCallState) {
  (window as any).claude = { on: {} };
  const { container } = render(<ChatProvider><ToolCard tool={t} sessionId="s1" /></ChatProvider>);
  fireEvent.click(screen.getByTestId('tool-card-chevron').closest('button')!);
  return container;
}

describe('Claude Code background helper card', () => {
  it('running: spinner, no check, and the receipt is not shown as a report', () => {
    const c = open(agent({ taskId: 'a3ecf', status: 'running' }));
    // BrailleSpinner draws braille glyphs; a settled card draws an icon instead.
    const header = screen.getByTestId('tool-card-chevron').closest('button')!;
    expect(header.textContent).toMatch(/[\u2800-\u28FF]/);
    expect(c.textContent).not.toContain('Async agent launched');
    expect(c.textContent).not.toContain('Report');
  });
  it('completed: no spinner, and the Report is the helper report', () => {
    const c = open(agent({ taskId: 'a3ecf', status: 'completed', result: 'All sources fetched.' }));
    expect(screen.getByTestId('tool-card-chevron').closest('button')!.textContent).not.toMatch(/[\u2800-\u28FF]/);
    expect(c.textContent).toContain('Report');
    expect(c.textContent).toContain('All sources fetched.');
    expect(c.textContent).not.toContain('Async agent launched');
  });
  it('stopped: says so', () => {
    const c = open(agent({ taskId: 'a3ecf', status: 'stopped' }));
    expect(c.textContent?.toLowerCase()).toContain('stopped');
  });
  it('a group of parallel helpers spins while any is still working, and settles after', () => {
    (window as any).claude = { on: {} };
    const two = (st: CcBackgroundRun['status']) => [
      { ...agent({ taskId: 'a1', status: 'completed' }), id: 'x1', toolUseId: 't1' },
      { ...agent({ taskId: 'a2', status: st }), id: 'x2', toolUseId: 't2' },
    ];
    const { container, rerender } = render(<ChatProvider><CollapsedToolGroup tools={two('running')} sessionId="s1" /></ChatProvider>);
    const header = () => container.querySelector('button')!.textContent ?? '';
    expect(header()).toMatch(/[\u2800-\u28FF]/);
    rerender(<ChatProvider><CollapsedToolGroup tools={two('completed')} sessionId="s1" /></ChatProvider>);
    expect(header()).not.toMatch(/[\u2800-\u28FF]/);
  });
});
