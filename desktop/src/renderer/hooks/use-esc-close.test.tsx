// @vitest-environment jsdom
// Fix: pin jsdom here because vitest.config.ts only auto-applies jsdom to
// tests under `tests/**/*.tsx`; this file lives under `src/**/*.test.tsx`
// and would otherwise run in the default `node` env with no `window`.
import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { EscCloseProvider, useEscClose, useEscStackEmpty } from './use-esc-close';

function pressEsc() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
}

function Overlay({ onClose }: { onClose: () => void }) {
  useEscClose(true, onClose);
  return <div />;
}

describe('useEscClose', () => {
  it('closes a single open overlay on ESC', () => {
    const onClose = vi.fn();
    render(
      <EscCloseProvider>
        <Overlay onClose={onClose} />
      </EscCloseProvider>,
    );
    pressEsc();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not fire when open is false', () => {
    const onClose = vi.fn();
    function ClosedOverlay() {
      useEscClose(false, onClose);
      return <div />;
    }
    render(
      <EscCloseProvider>
        <ClosedOverlay />
      </EscCloseProvider>,
    );
    pressEsc();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('LIFO: closes the most-recently-opened overlay first', () => {
    const onCloseA = vi.fn();
    const onCloseB = vi.fn();
    render(
      <EscCloseProvider>
        <Overlay onClose={onCloseA} />
        <Overlay onClose={onCloseB} />
      </EscCloseProvider>,
    );
    pressEsc();
    expect(onCloseB).toHaveBeenCalledTimes(1);
    expect(onCloseA).not.toHaveBeenCalled();
  });

  it('removes entry from stack on unmount', () => {
    const onClose = vi.fn();
    function Parent({ show }: { show: boolean }) {
      return (
        <EscCloseProvider>
          {show && <Overlay onClose={onClose} />}
        </EscCloseProvider>
      );
    }
    const { rerender } = render(<Parent show={true} />);
    rerender(<Parent show={false} />);
    pressEsc();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls the latest onClose identity after re-render', () => {
    const onCloseA = vi.fn();
    const onCloseB = vi.fn();
    function ChangingOverlay({ cb }: { cb: () => void }) {
      useEscClose(true, cb);
      return <div />;
    }
    const { rerender } = render(
      <EscCloseProvider>
        <ChangingOverlay cb={onCloseA} />
      </EscCloseProvider>,
    );
    rerender(
      <EscCloseProvider>
        <ChangingOverlay cb={onCloseB} />
      </EscCloseProvider>,
    );
    pressEsc();
    expect(onCloseB).toHaveBeenCalledTimes(1);
    expect(onCloseA).not.toHaveBeenCalled();
  });

  it('useEscStackEmpty reflects stack state', () => {
    let captured: boolean[] = [];
    function Probe() {
      captured.push(useEscStackEmpty());
      return null;
    }
    function Harness({ open }: { open: boolean }) {
      return (
        <EscCloseProvider>
          <Probe />
          {open && <Overlay onClose={() => {}} />}
        </EscCloseProvider>
      );
    }
    const { rerender } = render(<Harness open={false} />);
    rerender(<Harness open={true} />);
    rerender(<Harness open={false} />);
    // First render: empty. After open: not empty. After close: empty.
    expect(captured[0]).toBe(true);
    expect(captured[captured.length - 2]).toBe(false);
    expect(captured[captured.length - 1]).toBe(true);
  });

  it('calls preventDefault when it handles ESC', () => {
    const onClose = vi.fn();
    render(
      <EscCloseProvider>
        <Overlay onClose={onClose} />
      </EscCloseProvider>,
    );
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => { window.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
  });

  it('does NOT preventDefault when stack is empty', () => {
    render(<EscCloseProvider><div /></EscCloseProvider>);
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => { window.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(false);
  });
});
