// @vitest-environment jsdom
// Pins how long file-read and command-output boxes in an opened tool card draw:
// a read box shows a real 15-line slice when collapsed and, expanded, a
// height-capped scroller that fills 200 lines at a time — never the whole file.
// An expanded command-output / written-file block is height-capped too, so a
// long output no longer pushes the chat down by its full length.
import React from 'react';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import ToolBody from '../src/renderer/components/tool-views/ToolBody';
import { ChatProvider } from '../src/renderer/state/chat-context';
import type { ToolCallState } from '../src/shared/types';
import { installFiringIntersectionObserver } from './helpers/firing-intersection-observer';

afterEach(cleanup);

const tool = (toolName: string, input: Record<string, unknown>, response: string): ToolCallState => ({
  id: 'tool-1',
  toolUseId: 'toolu_1',
  toolName,
  input,
  status: 'complete',
  response,
} as ToolCallState);

// `cat -n` shaped Read response, the format parseCatN reads.
const catN = (n: number) =>
  Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(6)}\tline ${i + 1}`).join('\n');

const renderBody = (t: ToolCallState) =>
  render(<ChatProvider><ToolBody tool={t} sessionId="s1" /></ChatProvider>).container;

// data-testid, not `.font-mono.bg-panel`: CollapsibleBlock's <pre> also
// carries both classes, so that selector could pick up the wrong box the
// moment a test renders both (review round 1, 2026-09-18).
const readBox = (c: HTMLElement) => c.querySelector('[data-testid="read-box"]') as HTMLElement;
const readRows = (c: HTMLElement) => readBox(c).querySelectorAll(':scope > div.flex').length;

describe('Read box draws a slice collapsed and scrolls in chunks expanded', () => {
  let io: ReturnType<typeof installFiringIntersectionObserver>;
  beforeEach(() => { io = installFiringIntersectionObserver(); });
  afterEach(() => io.restore());

  it('collapsed draws 15 lines; expanded fills a capped scroller 200 at a time; Show less drops back', () => {
    const c = renderBody(tool('Read', { file_path: '/a/big.ts' }, catN(5000)));
    expect(readRows(c)).toBe(15);
    expect(readBox(c).className).not.toContain('max-h-[45vh]');
    fireEvent.click(screen.getByText('Show 4985 more lines'));
    expect(readRows(c)).toBe(200);
    expect(readBox(c).className).toContain('max-h-[45vh]');
    act(() => io.fireAll());
    expect(readRows(c)).toBe(400);
    fireEvent.click(screen.getByText('Show less'));
    expect(readRows(c)).toBe(15);
    // Re-opening starts from one chunk again: the revealed rows were released.
    fireEvent.click(screen.getByText('Show 4985 more lines'));
    expect(readRows(c)).toBe(200);
  });

  it('a short read draws every line with no button and no sentinel', () => {
    const c = renderBody(tool('Read', { file_path: '/a/small.ts' }, catN(10)));
    expect(readRows(c)).toBe(10);
    expect(screen.queryByText(/more lines/)).toBeNull();
    expect(c.querySelector('[data-reveal-sentinel]')).toBeNull();
  });
});

describe('command output block', () => {
  it('expanded carries the same height cap as the file boxes', () => {
    const output = Array.from({ length: 5000 }, (_, i) => `out ${i}`).join('\n');
    const c = renderBody(tool('Bash', { command: 'seq 5000' }, output));
    // The output <pre> — not the command's own <pre> above it.
    const pre = () => [...c.querySelectorAll('pre')].find((p) => p.textContent!.startsWith('out 0'))!;
    expect(pre().className).not.toContain('max-h-[45vh]');
    fireEvent.click(screen.getByText(/^Show \d+ more lines$/));
    expect(pre().className).toContain('max-h-[45vh]');
  });
});
