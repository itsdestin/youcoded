// @vitest-environment jsdom
// The skills drawer's handle (useDrawerResize): opens at 70%, click toggles full height,
// a drag far down closes it, and every open starts at the default again — Destin's
// "should always reset to the original position after close/open, no memory of last
// position" (ui-labels-batch#LB-3).
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { useDrawerResize } from '../src/renderer/hooks/useDrawerResize';

function Drawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const r = useDrawerResize(open, onClose);
  return (
    <div ref={r.drawerRef} data-testid="drawer" style={{ height: r.height }}>
      <div data-testid="handle" {...r.handleProps} />
    </div>
  );
}

// jsdom has no layout and no pointer capture; give the drawer the height its style says.
function setup(open = true) {
  const onClose = vi.fn();
  const utils = render(<Drawer open={open} onClose={onClose} />);
  const drawer = utils.getByTestId('drawer');
  const handle = utils.getByTestId('handle');
  // A '70vh' default reads as 700px here; a set height reads as itself.
  drawer.getBoundingClientRect = () => ({ height: drawer.style.height.endsWith('px') ? parseFloat(drawer.style.height) : 700 } as DOMRect);
  handle.setPointerCapture = () => {};
  handle.hasPointerCapture = () => false;
  return { ...utils, drawer, handle, onClose };
}

describe('useDrawerResize', () => {
  it('opens at 70% of the window', () => {
    const { drawer } = setup();
    expect(drawer.style.height).toBe('70vh');
  });

  it('a click on the handle goes to full height, and a second click comes back', () => {
    const { drawer, handle } = setup();
    fireEvent.pointerDown(handle, { clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 300, pointerId: 1 });
    expect(drawer.style.height).toBe(`${window.innerHeight - 48}px`);
    fireEvent.pointerDown(handle, { clientY: 60, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 60, pointerId: 1 });
    expect(drawer.style.height).toBe('70vh');
  });

  it('dragging moves it, and dragging far down closes it', () => {
    const { drawer, handle, onClose } = setup();
    fireEvent.pointerDown(handle, { clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 400, pointerId: 1 });
    expect(drawer.style.height).toBe('600px');
    fireEvent.pointerUp(handle, { clientY: 400, pointerId: 1 });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(handle, { clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 900, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 900, pointerId: 1 });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('reopening forgets the last height', () => {
    const { drawer, handle, rerender, onClose } = setup();
    fireEvent.pointerDown(handle, { clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 300, pointerId: 1 });
    expect(drawer.style.height).not.toBe('70vh');
    act(() => { rerender(<Drawer open={false} onClose={onClose} />); });
    act(() => { rerender(<Drawer open onClose={onClose} />); });
    expect(drawer.style.height).toBe('70vh');
  });

  // Final review F43: a touch the system takes away mid-drag (pointercancel) used to run the drop.
  it('a cancelled drag neither closes the drawer nor toggles full height', () => {
    const { drawer, handle, onClose } = setup();
    fireEvent.pointerDown(handle, { clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 1050, pointerId: 1 }); // 50px tall: below the 160px minimum
    fireEvent.pointerCancel(handle, { clientY: 1050, pointerId: 1 });
    expect(onClose).not.toHaveBeenCalled();
    expect(drawer.style.height).toBe('160px'); // never left below its minimum
    fireEvent.pointerDown(handle, { clientY: 300, pointerId: 1 });
    fireEvent.pointerCancel(handle, { clientY: 300, pointerId: 1 }); // a press, cancelled: not a click
    expect(drawer.style.height).toBe('160px');
  });

  it('closing forgets the height at once, not only on the next open', () => {
    const { drawer, handle, rerender, onClose } = setup();
    fireEvent.pointerDown(handle, { clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 300, pointerId: 1 });
    act(() => { rerender(<Drawer open={false} onClose={onClose} />); });
    expect(drawer.style.height).toBe('70vh');
  });
});
