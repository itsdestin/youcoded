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

// A rename box that closes when it loses focus must still be open, and focused, when Paste runs.
it('a menu over a text box leaves the box focused, through opening and pressing an item', () => {
  const box = document.createElement('input');
  const onBlur = vi.fn();
  box.addEventListener('blur', onBlur);
  document.body.appendChild(box);
  box.focus();
  const paste = { type: 'item' as const, id: 'paste', label: 'Paste', icon: 'paste', run: vi.fn() };
  const { getByRole } = render(<ContextMenu x={10} y={10} entries={[paste] as any} anchor={box} onClose={() => {}} />);
  expect(document.activeElement).toBe(box);
  const item = getByRole('menuitem');
  const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
  item.dispatchEvent(down);
  expect(down.defaultPrevented).toBe(true);
  item.click();
  expect(paste.run).toHaveBeenCalled();
  expect(onBlur).not.toHaveBeenCalled();
});

it('a menu over chat text takes focus itself, for arrow-key navigation', () => {
  const { cell } = layout();
  const { getByRole } = render(<ContextMenu x={10} y={10} entries={entries as any} anchor={cell} onClose={() => {}} />);
  expect(document.activeElement).toBe(getByRole('menu'));
});

it('typing in the text box closes its menu; keys elsewhere leave a chat-text menu alone', () => {
  const box = document.createElement('input');
  document.body.appendChild(box);
  box.focus();
  const onClose = vi.fn();
  render(<ContextMenu x={10} y={10} entries={entries as any} anchor={box} onClose={onClose} />);
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  expect(onClose).toHaveBeenCalled();
  cleanup();
  const { cell } = layout();
  const onChatClose = vi.fn();
  render(<ContextMenu x={10} y={10} entries={entries as any} anchor={cell} onClose={onChatClose} />);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
  expect(onChatClose).not.toHaveBeenCalled();
});
