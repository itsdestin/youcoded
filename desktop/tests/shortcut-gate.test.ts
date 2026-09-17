// The full-screen shortcut gate (utils/shortcut-gate.ts): while a page is
// open the chat's window-level shortcuts must not fire; Escape, zoom and
// typing into a field still pass.
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { setGlobalShortcutsBlocked, shortcutGateHandler } from '../src/renderer/utils/shortcut-gate';

function fire(init: KeyboardEventInit & { target?: Element }) {
  const target = init.target ?? document.body;
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  let reached = false;
  // A "chat shortcut" registered AFTER the gate on the same target, like
  // App.tsx's handlers are (the gate registers at module load).
  const later = () => { reached = true; };
  window.addEventListener('keydown', later, true);
  target.dispatchEvent(e);
  window.removeEventListener('keydown', later, true);
  return reached;
}

describe('shortcut gate', () => {
  beforeEach(() => setGlobalShortcutsBlocked(false));

  it('is registered on the window at import, ahead of later listeners', () => {
    setGlobalShortcutsBlocked(true);
    expect(fire({ key: ' ', shiftKey: true })).toBe(false);
    setGlobalShortcutsBlocked(false);
    expect(fire({ key: ' ', shiftKey: true })).toBe(true);
  });

  it('lets Escape, zoom and typing through', () => {
    setGlobalShortcutsBlocked(true);
    expect(fire({ key: 'Escape' })).toBe(true);
    expect(fire({ key: '=', ctrlKey: true })).toBe(true);
    expect(fire({ key: '0', metaKey: true })).toBe(true);
    const input = document.createElement('input');
    document.body.appendChild(input);
    expect(fire({ key: 'Tab', shiftKey: true, target: input })).toBe(true);
    input.remove();
  });

  it('never cancels the browser default', () => {
    setGlobalShortcutsBlocked(true);
    const e = new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, cancelable: true });
    shortcutGateHandler(e);
    expect(e.defaultPrevented).toBe(false);
  });
});
