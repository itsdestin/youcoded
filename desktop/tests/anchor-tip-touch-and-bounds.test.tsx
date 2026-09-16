// @vitest-environment jsdom
// anchor-tip-touch-and-bounds.test.tsx — the two acceptance failures a fresh
// grader found by running the real app against the signed contract (T24).
//
// R20 "hover OR TAP opens the small table". Tapping never opened it: after a
// touch the browser replays the whole mouse sequence, and the trailing
// `mouseleave` shut the bubble in the same frame it opened. Polled every 60 ms
// for 1.5 s after a real tap, it was never once on screen. Destin drives this
// machine by touchscreen and has no mouse, so the breakdown was unreachable.
//
// R21 "the size breakdown stays inside the dialog". It was clamped to the
// WINDOW, not to the Model Providers panel, so a bubble opened from a row low
// in the list hung 51 px below the panel, over the page behind it.
//
// WHY THESE GUARDS ARE SHAPED LIKE THIS. jsdom has no layout, so every number
// below comes from a stubbed getBoundingClientRect — which means the guard can
// only prove the ARITHMETIC in AnchorTip.measure(), not what a browser paints.
// Both rows were therefore ALSO verified in the real Electron app; this file is
// what stops them regressing silently.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { AnchorTip } from '../src/renderer/components/ui/AnchorTip';

afterEach(() => { cleanup(); document.body.innerHTML = ''; });

const BUBBLE = 'What this needs';

function tip(extra: React.ComponentProps<typeof AnchorTip>['placement'] = 'bottom') {
  return (
    <AnchorTip label="What 5.7 GB is made of" title={BUBBLE} trigger="hover" placement={extra} align="start" anchor={<span>5.7 GB</span>}>
      <p>Model file</p>
    </AnchorTip>
  );
}

const trigger = () => screen.getByLabelText('What 5.7 GB is made of');
const bubbleOpen = () => screen.queryByText(BUBBLE) !== null;

describe('R20 — a tap opens the breakdown', () => {
  it('a finger tap opens it, and the phantom mouse events a touchscreen replays do NOT close it', () => {
    render(tip());
    expect(bubbleOpen()).toBe(false);

    // The real Chromium sequence after a tap, in order, as captured by the
    // grader on the running app.
    fireEvent.pointerDown(trigger(), { pointerType: 'touch' });
    fireEvent.pointerUp(trigger(), { pointerType: 'touch' });
    fireEvent.pointerLeave(trigger(), { pointerType: 'touch' });
    fireEvent.mouseOver(trigger());
    fireEvent.mouseEnter(trigger());
    fireEvent.focus(trigger());
    fireEvent.click(trigger());
    fireEvent.mouseOut(trigger());
    fireEvent.mouseLeave(trigger());

    expect(bubbleOpen(), 'the bubble is still open after the replayed mouse events').toBe(true);
  });

  it('a second tap on the same number closes it again', () => {
    render(tip());
    fireEvent.pointerDown(trigger(), { pointerType: 'touch' });
    fireEvent.focus(trigger());
    expect(bubbleOpen()).toBe(true);
    // Already focused, so no second focus event follows — the flip is the only
    // thing that acts.
    fireEvent.pointerDown(trigger(), { pointerType: 'touch' });
    expect(bubbleOpen()).toBe(false);
  });

  it('tapping somewhere else closes it', () => {
    render(<div><span data-testid="elsewhere">elsewhere</span>{tip()}</div>);
    fireEvent.pointerDown(trigger(), { pointerType: 'touch' });
    fireEvent.focus(trigger());
    expect(bubbleOpen()).toBe(true);
    fireEvent.pointerDown(screen.getByTestId('elsewhere'), { pointerType: 'touch' });
    expect(bubbleOpen()).toBe(false);
  });

  it('a real mouse still opens it on hover and closes it on the way out', () => {
    render(tip());
    fireEvent.pointerEnter(trigger(), { pointerType: 'mouse' });
    expect(bubbleOpen(), 'mouse hover opens').toBe(true);
    fireEvent.pointerLeave(trigger(), { pointerType: 'mouse' });
    expect(bubbleOpen(), 'mouse leaving closes').toBe(false);
  });

  it('the keyboard still opens it on focus and closes it on blur', () => {
    render(tip());
    fireEvent.focus(trigger());
    expect(bubbleOpen(), 'focus opens').toBe(true);
    fireEvent.blur(trigger());
    expect(bubbleOpen(), 'blur closes').toBe(false);
  });
});

// ── R21 ──────────────────────────────────────────────────────────────────────

/** Stubs layout: jsdom reports 0 for every rect, so the boundary and the
 *  trigger have to be told where they are. Anything not named lands at 0,0 with
 *  no size, which is what the real panel measurement falls back to. */
function withLayout(rects: Array<[Element, Partial<DOMRect>]>, panelSize: { width: number; height: number }) {
  const map = new Map(rects);
  Element.prototype.getBoundingClientRect = function () {
    const hit = map.get(this);
    if (hit) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, ...hit } as DOMRect;
    // The portalled bubble: only its SIZE is read, never its position.
    if (this instanceof HTMLElement && this.getAttribute('role') === 'tooltip') {
      return { left: 0, top: 0, right: panelSize.width, bottom: panelSize.height, ...panelSize, x: 0, y: 0 } as DOMRect;
    }
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 } as DOMRect;
  };
}

const realRect = Element.prototype.getBoundingClientRect;
afterEach(() => { Element.prototype.getBoundingClientRect = realRect; });

/** The grader's measurement, to the pixel: the Model Providers panel (420 px
 *  wide, centred in a 1440x900 window, so 510–930 across and 206–794 down) with
 *  a size number on a row near its bottom, at x 654.7. */
function lowRowInAPanel() {
  const view = render(
    <div role="dialog" data-testid="panel">
      <div>{tip()}</div>
    </div>,
  );
  const panel = screen.getByTestId('panel');
  withLayout(
    [
      [panel, { left: 510, right: 930, top: 206, bottom: 794, width: 420, height: 588 }],
      [screen.getByLabelText('What 5.7 GB is made of'), { left: 654.7, right: 700, top: 690, bottom: 704.1, width: 45.3, height: 14.1 }],
    ],
    { width: 256, height: 135 },
  );
  return view;
}

function bubbleBox() {
  const el = document.querySelector('[role="tooltip"]') as HTMLElement;
  expect(el, 'the bubble is on screen').toBeTruthy();
  return { top: parseFloat(el.style.top), left: parseFloat(el.style.left) };
}

describe('R21 — the breakdown stays inside the dialog', () => {
  it('a row low in the panel opens the bubble ABOVE the number rather than hanging out of the panel', () => {
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
    lowRowInAPanel();
    fireEvent.pointerEnter(screen.getByLabelText('What 5.7 GB is made of'), { pointerType: 'mouse' });
    const box = bubbleBox();
    // 135 px of bubble under a number whose row ends at 704 would reach 845 —
    // 51 px past the panel's own bottom edge, which is the bug.
    expect(box.top + 135, 'bottom edge stays inside the panel').toBeLessThanOrEqual(794);
    expect(box.top, 'top edge stays inside the panel').toBeGreaterThanOrEqual(206);
  });

  it('a row with room below still opens DOWNWARDS, lined up with the number', () => {
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
    render(
      <div role="dialog" data-testid="panel">
        <div>{tip()}</div>
      </div>,
    );
    withLayout(
      [
        [screen.getByTestId('panel'), { left: 510, right: 930, top: 206, bottom: 794, width: 420, height: 588 }],
        [screen.getByLabelText('What 5.7 GB is made of'), { left: 654.7, right: 700, top: 300, bottom: 314, width: 45.3, height: 14 }],
      ],
      { width: 256, height: 135 },
    );
    fireEvent.pointerEnter(screen.getByLabelText('What 5.7 GB is made of'), { pointerType: 'mouse' });
    const box = bubbleBox();
    expect(box.top, 'opens below the number').toBe(320);
    expect(box.left, 'lined up with the number’s left edge').toBe(654.7);
  });

  it('a number near the panel’s right edge is pulled back inside it, not just inside the window', () => {
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
    render(
      <div role="dialog" data-testid="panel">
        <div>{tip()}</div>
      </div>,
    );
    withLayout(
      [
        [screen.getByTestId('panel'), { left: 510, right: 930, top: 206, bottom: 794, width: 420, height: 588 }],
        [screen.getByLabelText('What 5.7 GB is made of'), { left: 800, right: 845, top: 300, bottom: 314, width: 45, height: 14 }],
      ],
      { width: 256, height: 135 },
    );
    fireEvent.pointerEnter(screen.getByLabelText('What 5.7 GB is made of'), { pointerType: 'mouse' });
    const box = bubbleBox();
    // 800 + 256 = 1056, well past the panel's right edge at 930 — but still
    // comfortably inside the 1440 px window, which is why the old window-only
    // clamp never fired.
    expect(box.left + 256, 'right edge stays inside the panel').toBeLessThanOrEqual(930);
  });

  it('outside a dialog the window is still the boundary', () => {
    Object.defineProperty(window, 'innerHeight', { value: 400, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
    render(<div>{tip()}</div>);
    withLayout(
      [[screen.getByLabelText('What 5.7 GB is made of'), { left: 100, right: 145, top: 330, bottom: 344, width: 45, height: 14 }]],
      { width: 256, height: 135 },
    );
    fireEvent.pointerEnter(screen.getByLabelText('What 5.7 GB is made of'), { pointerType: 'mouse' });
    const box = bubbleBox();
    expect(box.top + 135, 'bottom edge stays inside the window').toBeLessThanOrEqual(400);
  });
});
