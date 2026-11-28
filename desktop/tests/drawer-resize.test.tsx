// @vitest-environment jsdom
// The skills drawer's handle (useDrawerResize): opens at 70%, click toggles full height,
// a drag far down closes it, and every open starts at the default again — Destin's
// "should always reset to the original position after close/open, no memory of last
// position" (ui-labels-batch#LB-3). Since 2026-11-02 the drawer is always laid out at full height and SLIDES
// (useDrawerResize.ts — why), so the height it shows is its full height minus how far it is slid down.
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { useDrawerResize } from '../src/renderer/hooks/useDrawerResize';

function Drawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const r = useDrawerResize(open, onClose);
  return (
    <div ref={r.drawerRef} data-testid="drawer" style={r.style} data-hidden={r.hiddenPx}>
      <div data-testid="handle" {...r.handleProps} />
    </div>
  );
}

const FULL = () => window.innerHeight - 48;
const DEFAULT = () => Math.round(window.innerHeight * 0.7);
/** The part on screen: full height minus the slide. */
function shown(drawer: HTMLElement): number {
  const shift = Number(/translateY\((-?[\d.]+)px\)/.exec(drawer.style.transform)?.[1]);
  return parseFloat(drawer.style.height) - shift;
}

function setup(open = true) {
  const onClose = vi.fn();
  const utils = render(<Drawer open={open} onClose={onClose} />);
  const drawer = utils.getByTestId('drawer');
  const handle = utils.getByTestId('handle');
  handle.setPointerCapture = () => {};
  handle.hasPointerCapture = () => false;
  return { ...utils, drawer, handle, onClose };
}

describe('useDrawerResize', () => {
  it('opens at 70% of the window, laid out at full height', () => {
    const { drawer } = setup();
    expect(drawer.style.height).toBe(`${FULL()}px`);
    expect(shown(drawer)).toBe(DEFAULT());
    // The list inside is padded by what is below the screen, so it ends on screen.
    expect(Number(drawer.dataset.hidden)).toBe(FULL() - DEFAULT());
  });

  it('closed, it sits below the screen', () => {
    const { drawer } = setup(false);
    expect(drawer.style.transform).toBe('translateY(100%)');
  });

  it('a click on the handle goes to full height, and a second click comes back', () => {
    const { drawer, handle } = setup();
    fireEvent.pointerDown(handle, { clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 300, pointerId: 1 });
    expect(shown(drawer)).toBe(FULL());
    fireEvent.pointerDown(handle, { clientY: 60, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 60, pointerId: 1 });
    expect(shown(drawer)).toBe(DEFAULT());
  });

  it('dragging moves it without changing its height, and dragging far down closes it', () => {
    const { drawer, handle, onClose } = setup();
    const start = DEFAULT();
    fireEvent.pointerDown(handle, { clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 400, pointerId: 1 });
    // The pinned behaviour: a drag never changes the drawer's height (a height change redrew every card).
    expect(drawer.style.height).toBe(`${FULL()}px`);
    expect(shown(drawer)).toBe(start - 100);
    expect(drawer.style.transitionDuration).toBe('0s'); // follows the finger at once
    fireEvent.pointerUp(handle, { clientY: 400, pointerId: 1 });
    expect(drawer.style.height).toBe(`${FULL()}px`);
    expect(shown(drawer)).toBe(start - 100);
    expect(drawer.style.transitionDuration).toBe('');
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(handle, { clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 1200, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 1200, pointerId: 1 });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('reopening forgets the last height', () => {
    const { drawer, handle, rerender, onClose } = setup();
    fireEvent.pointerDown(handle, { clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 300, pointerId: 1 });
    expect(shown(drawer)).not.toBe(DEFAULT());
    act(() => { rerender(<Drawer open={false} onClose={onClose} />); });
    act(() => { rerender(<Drawer open onClose={onClose} />); });
    expect(shown(drawer)).toBe(DEFAULT());
  });

  // Final review F43: a touch the system takes away mid-drag (pointercancel) used to run the drop.
  it('a cancelled drag neither closes the drawer nor toggles full height', () => {
    const { drawer, handle, onClose } = setup();
    fireEvent.pointerDown(handle, { clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 400 + DEFAULT() - 50, pointerId: 1 }); // 50px shown: below the 160px minimum
    fireEvent.pointerCancel(handle, { clientY: 400 + DEFAULT() - 50, pointerId: 1 });
    expect(onClose).not.toHaveBeenCalled();
    expect(shown(drawer)).toBe(160); // never left below its minimum
    fireEvent.pointerDown(handle, { clientY: 300, pointerId: 1 });
    fireEvent.pointerCancel(handle, { clientY: 300, pointerId: 1 }); // a press, cancelled: not a click
    expect(shown(drawer)).toBe(160);
  });

  it('closing forgets the height at once, not only on the next open', () => {
    const { drawer, handle, rerender, onClose } = setup();
    fireEvent.pointerDown(handle, { clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 300, pointerId: 1 });
    act(() => { rerender(<Drawer open={false} onClose={onClose} />); });
    act(() => { rerender(<Drawer open onClose={onClose} />); });
    expect(shown(drawer)).toBe(DEFAULT());
  });
});
