// @vitest-environment jsdom
// Perf pin: re-rendering a tool card must not re-split its whole output. Output boxes (Bash),
// Grep and Glob cards used to split/filter the full response on every render though they draw a
// slice; the split now happens once per response.
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ToolBody from '../src/renderer/components/tool-views/ToolBody';
import { ChatProvider } from '../src/renderer/state/chat-context';
import type { ToolCallState } from '../src/shared/types';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const tool = (toolName: string, input: Record<string, unknown>, response: string): ToolCallState =>
  ({ id: 't', toolUseId: 'toolu_1', toolName, input, status: 'complete', response } as ToolCallState);

// Counts String.prototype.split('\n') calls whose receiver is exactly `big`.
function countBigSplits(big: string) {
  const real = String.prototype.split;
  let n = 0;
  vi.spyOn(String.prototype, 'split').mockImplementation(function (this: string, ...args: any[]) {
    if (args[0] === '\n' && String(this).length === big.length) n++;
    return (real as any).apply(this, args);
  });
  return () => n;
}

describe('tool cards do not re-split a big response per render', () => {
  const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join('\n');

  it.each([
    ['Bash', { command: 'x' }, lines(5000, (i) => `output line ${i}`)],
    ['Glob', { pattern: '**/*.ts' }, lines(5000, (i) => `/repo/src/file${i}.ts`)],
    ['Grep', { pattern: 'x', output_mode: 'content' }, lines(5000, (i) => `/repo/src/f${i % 50}.ts:${i}:const x = ${i}`)],
  ])('%s: one split however many times it re-renders', (name, input, response) => {
    const splits = countBigSplits(response);
    const t = tool(name, input, response);
    const ui = () => <ChatProvider><ToolBody tool={t} sessionId="s1" /></ChatProvider>;
    const { rerender } = render(ui());
    const afterFirst = splits();
    for (let i = 0; i < 5; i++) rerender(ui());
    expect(splits()).toBe(afterFirst);
    if (name === 'Bash') {
      // Toggling Show more / Show less re-renders the block too.
      fireEvent.click(screen.getByText(/Show \d+ more lines/));
      fireEvent.click(screen.getByText('Show less'));
      expect(splits()).toBe(afterFirst);
    }
  });
});
