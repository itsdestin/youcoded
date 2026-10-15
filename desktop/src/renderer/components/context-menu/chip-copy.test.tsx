// @vitest-environment jsdom
// A file chip in a message shows only the file name; every copy route must put
// the FULL PATH on the clipboard instead. Chips come from the real
// MarkdownContent, so a chip that stops carrying its path fails here.
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import MarkdownContent from '../MarkdownContent';
import { installChipCopy } from './chip-copy';
import { buildContextMenu } from './build-menu';

const PATH = '/home/destin/proj/notes/plan.md';

function mountMessage(md: string) {
  const { container } = render(
    <div className="chat-scroll"><div className="assistant-bubble"><MarkdownContent content={md} sessionId="s1" /></div></div>,
  );
  const chip = container.querySelector<HTMLElement>('button[data-file-path]');
  const prose = container.querySelector<HTMLElement>('p')!;
  return { container, chip, prose };
}

function select(startNode: Node, startOffset: number, endNode: Node, endOffset: number) {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return range;
}

/** Fires a copy event the way Ctrl+C does; returns what was written, if anything. */
function pressCopy(): { prevented: boolean; data: Record<string, string> } {
  const data: Record<string, string> = {};
  const e = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(e, 'clipboardData', { value: { setData: (t: string, v: string) => { data[t] = v; } } });
  document.dispatchEvent(e);
  return { prevented: e.defaultPrevented, data };
}

let uninstall: (() => void) | null = null;
afterEach(() => {
  uninstall?.();
  uninstall = null;
  window.getSelection()?.removeAllRanges();
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
});

describe('Ctrl+C over a file chip', () => {
  it('copies a sentence with the chip written as its full path', () => {
    uninstall = installChipCopy();
    const { prose } = mountMessage(`open ${PATH} now`);
    select(prose.firstChild!, 0, prose.lastChild!, prose.lastChild!.textContent!.length);
    const { prevented, data } = pressCopy();
    expect(prevented).toBe(true);
    expect(data['text/plain']).toBe(`open ${PATH} now`);
    expect(data['text/html']).toContain(PATH);
    expect(data['text/html']).not.toContain('<button');
  });

  it('copies the full path when only part of the chip name is highlighted', () => {
    uninstall = installChipCopy();
    const { chip } = mountMessage(`open ${PATH} now`);
    const name = chip!.querySelector('span')!.firstChild!;
    select(name, 1, name, 4);
    expect(pressCopy().data['text/plain']).toBe(PATH);
  });

  it('puts the original selection back after reading it', () => {
    uninstall = installChipCopy();
    const { prose } = mountMessage(`open ${PATH} now`);
    const range = select(prose.firstChild!, 0, prose.lastChild!, 2);
    pressCopy();
    const now = window.getSelection()!.getRangeAt(0);
    expect([now.startContainer, now.startOffset, now.endContainer, now.endOffset])
      .toEqual([range.startContainer, range.startOffset, range.endContainer, range.endOffset]);
  });

  it('leaves a selection without a chip to the browser', () => {
    uninstall = installChipCopy();
    const { prose } = mountMessage('just words here');
    select(prose.firstChild!, 0, prose.firstChild!, 4);
    expect(pressCopy()).toEqual({ prevented: false, data: {} });
  });

  it('copies a path inside a code block as written (no chip there)', () => {
    uninstall = installChipCopy();
    const { container } = mountMessage('```\ncat notes/plan.md\n```');
    const code = container.querySelector('pre code')!;
    select(code, 0, code, code.childNodes.length);
    expect(pressCopy().prevented).toBe(false);
  });
});

describe('right-click Copy over a file chip', () => {
  async function runCopy(target: HTMLElement): Promise<string> {
    const writeText = vi.fn(async (_t: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const copy = buildContextMenu(target)?.find((e) => e.type === 'item' && e.id === 'copy');
    if (copy?.type === 'item') copy.run();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    return writeText.mock.calls[0][0];
  }

  it('copies a highlighted sentence with the full path', async () => {
    const { prose } = mountMessage(`open ${PATH} now`);
    select(prose.firstChild!, 0, prose.lastChild!, prose.lastChild!.textContent!.length);
    expect(await runCopy(prose)).toBe(`open ${PATH} now`);
  });

  it('copies a whole message (nothing highlighted) with the full path', async () => {
    const { prose } = mountMessage(`open ${PATH} now`);
    expect(await runCopy(prose)).toBe(`open ${PATH} now`);
  });
});
