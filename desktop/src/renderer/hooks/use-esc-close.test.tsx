// @vitest-environment jsdom
// Fix: pin jsdom here because vitest.config.ts only auto-applies jsdom to
// tests under `tests/**/*.tsx`; this file lives under `src/**/*.test.tsx`
// and would otherwise run in the default `node` env with no `window`.
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { EscCloseProvider, useEscClose, useEscStackEmpty, useDismissTop } from './use-esc-close';

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

  it('useDismissTop pops the top of the stack and invokes its onClose', () => {
    const onClose = vi.fn();
    let dismiss: () => void = () => {};
    function Capturer() {
      dismiss = useDismissTop();
      return null;
    }
    render(
      <EscCloseProvider>
        <Capturer />
        <Overlay onClose={onClose} />
      </EscCloseProvider>,
    );
    act(() => { dismiss(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('useDismissTop is LIFO: closes the most-recently-opened overlay first', () => {
    const onCloseA = vi.fn();
    const onCloseB = vi.fn();
    let dismiss: () => void = () => {};
    function Capturer() {
      dismiss = useDismissTop();
      return null;
    }
    render(
      <EscCloseProvider>
        <Capturer />
        <Overlay onClose={onCloseA} />
        <Overlay onClose={onCloseB} />
      </EscCloseProvider>,
    );
    act(() => { dismiss(); });
    expect(onCloseB).toHaveBeenCalledTimes(1);
    expect(onCloseA).not.toHaveBeenCalled();
  });

  // A layered overlay (Resume browser: Organize sheet → expanded row → browser)
  // peels one layer per Esc and stays OPEN. Its entry must survive that press,
  // or the next Esc finds an empty stack: the browser won't close, and the
  // key falls through to the chat and interrupts the assistant.
  it('a layered overlay that peels one layer keeps its place: every Esc is consumed until it closes', () => {
    function Layered({ onClosed }: { onClosed: () => void }) {
      const [layers, setLayers] = React.useState(2);
      const [open, setOpen] = React.useState(true);
      useEscClose(open, () => {
        if (layers > 0) setLayers((n) => n - 1);
        else { setOpen(false); onClosed(); }
      });
      return <div data-layers={layers} />;
    }
    const onClosed = vi.fn();
    render(
      <EscCloseProvider>
        <Layered onClosed={onClosed} />
      </EscCloseProvider>,
    );
    const presses = [0, 1, 2].map(() => {
      const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      act(() => { window.dispatchEvent(ev); });
      return ev.defaultPrevented;
    });
    expect(presses).toEqual([true, true, true]);
    expect(onClosed).toHaveBeenCalledTimes(1);
    // Closed now: the next Esc is the chat's again.
    const after = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => { window.dispatchEvent(after); });
    expect(after.defaultPrevented).toBe(false);
  });

  it('a panel beside the chat takes one Escape while focus is elsewhere; peels only with focus inside', () => {
    let inside = false;
    const onBack = vi.fn();
    function Panel() {
      useEscClose(true, onBack, { layeredWhile: () => inside });
      return null;
    }
    render(<EscCloseProvider><Panel /></EscCloseProvider>);
    const press = () => {
      const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      act(() => { window.dispatchEvent(ev); });
      return ev.defaultPrevented;
    };
    expect([press(), press(), press()]).toEqual([true, false, false]);
    expect(onBack).toHaveBeenCalledTimes(1);
    inside = true;
    expect([press(), press()]).toEqual([true, true]);
    expect(onBack).toHaveBeenCalledTimes(3);
  });

  it('useDismissTop is a no-op when the stack is empty', () => {
    let dismiss: () => void = () => {};
    function Capturer() {
      dismiss = useDismissTop();
      return null;
    }
    render(
      <EscCloseProvider>
        <Capturer />
      </EscCloseProvider>,
    );
    expect(() => act(() => { dismiss(); })).not.toThrow();
  });
});
