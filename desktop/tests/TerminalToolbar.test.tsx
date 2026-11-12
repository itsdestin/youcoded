// @vitest-environment jsdom
// The touch terminal's key row must be able to ANSWER a Claude Code menu:
// Enter confirms (second review F2); Left/Right move between choices side by side (Destin, 2026-11-05).
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TerminalToolbar from '../src/renderer/components/TerminalToolbar';

describe('TerminalToolbar', () => {
  it('has Enter, Left and Right keys that type exactly those keys into the session', () => {
    const sendInput = vi.fn();
    (window as any).claude = { session: { sendInput } };
    render(<TerminalToolbar sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Left' }));
    fireEvent.click(screen.getByRole('button', { name: 'Right' }));
    expect(sendInput.mock.calls).toEqual([['s1', '\r'], ['s1', '\x1b[D'], ['s1', '\x1b[C']]);
  });
});

describe('TerminalScrollButtons', () => {
  // The up/down pair lines up over the send button in every frame style: it sits in from the right of the box it
  // floats in by the message box's right gap plus the box's own inner padding, never a fixed 8px (which put it on
  // the framed style's border line).
  it('sits in from the right by the message box gap plus its padding', async () => {
    (window as any).claude = { session: { sendInput: vi.fn() } };
    const { TerminalScrollButtons } = await import('../src/renderer/components/TerminalToolbar');
    const RO = (globalThis as any).ResizeObserver;
    (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
    const rect = (right: number) => ({ right, left: 0, top: 0, bottom: 0, width: right, height: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
    try {
      const host = document.createElement('div');
      host.getBoundingClientRect = () => rect(390);
      document.body.appendChild(host);
      const bar = document.createElement('div');
      bar.className = 'input-bar-container';
      const form = document.createElement('form');
      form.style.paddingRight = '8px';
      form.getBoundingClientRect = () => rect(380);
      bar.appendChild(form);
      document.body.appendChild(bar);
      Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get() { return host; } });
      const first = render(<TerminalScrollButtons sessionId="s1" />, { container: host });
      const pair = screen.getByRole('button', { name: 'Scroll up' }).parentElement!;
      expect(pair.style.right).toBe('18px');   // 390 − 380 = 10px gap, + 8px padding
      // Reopening terminal view rebuilds the pair. It starts where it was last measured, never back at the 8px
      // fallback for a frame (the left/right jitter on a quick chat/terminal switch). Shown with nothing to measure.
      first.unmount();
      bar.remove();
      render(<TerminalScrollButtons sessionId="s1" />);
      expect(screen.getByRole('button', { name: 'Scroll up' }).parentElement!.style.right).toBe('18px');
    } finally {
      (globalThis as any).ResizeObserver = RO;
      if (offsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParent);
      document.body.innerHTML = '';
    }
  });
});

describe('the Ctrl key', () => {
  // It used to light up and do nothing. Held, the next letter typed into the message box goes to the program as
  // Ctrl+letter (Ctrl+C is \x03) instead of into the box, and Ctrl lets go by itself.
  it('turns the next typed letter into Ctrl+letter, once', async () => {
    const sendInput = vi.fn();
    (window as any).claude = { session: { sendInput } };
    const { default: Toolbar, consumeCtrlLetter } = await import('../src/renderer/components/TerminalToolbar');
    render(<Toolbar sessionId="s1" />);
    const ctrl = screen.getByRole('button', { name: 'Ctrl' });
    fireEvent.click(ctrl);
    expect(ctrl.getAttribute('aria-pressed')).toBe('true');
    let kept = false;
    React.act(() => { kept = consumeCtrlLetter('s1', 'ab', 'abc'); });
    expect(kept).toBe(true);
    expect(sendInput.mock.calls).toEqual([['s1', '\x03']]);
    expect(ctrl.getAttribute('aria-pressed')).toBe('false');
    expect(consumeCtrlLetter('s1', 'ab', 'abd')).toBe(false);   // let go: the next letter types normally
    expect(sendInput).toHaveBeenCalledTimes(1);
  });
});
