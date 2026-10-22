// @vitest-environment jsdom
// The right-click menu stays open while something ELSE on the page scrolls
// (the chat following a streaming reply), and closes when what was
// right-clicked moves.
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ContextMenu } from '../src/renderer/components/context-menu/ContextMenu';

afterEach(cleanup);

const entries = [{ type: 'item' as const, label: 'Add comment', run: () => {} }];

function layout() {
  const chat = document.createElement('div');
  const sheet = document.createElement('div');
  const cell = document.createElement('span');
  sheet.appendChild(cell);
  document.body.append(chat, sheet);
  return { chat, sheet, cell };
}

it('stays open when an area that does not hold the right-clicked element scrolls', () => {
  const { chat, cell } = layout();
  const onClose = vi.fn();
  render(<ContextMenu x={10} y={10} entries={entries as any} anchor={cell} onClose={onClose} />);
  chat.dispatchEvent(new Event('scroll'));
  expect(onClose).not.toHaveBeenCalled();
});

it('closes when the area holding the right-clicked element scrolls', () => {
  const { sheet, cell } = layout();
  const onClose = vi.fn();
  render(<ContextMenu x={10} y={10} entries={entries as any} anchor={cell} onClose={onClose} />);
  sheet.dispatchEvent(new Event('scroll'));
  expect(onClose).toHaveBeenCalled();
});

it('closes when the page itself scrolls', () => {
  const { cell } = layout();
  const onClose = vi.fn();
  render(<ContextMenu x={10} y={10} entries={entries as any} anchor={cell} onClose={onClose} />);
  document.dispatchEvent(new Event('scroll'));
  expect(onClose).toHaveBeenCalled();
});
