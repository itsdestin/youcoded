// @vitest-environment jsdom
import React from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

// Pins the fix for "when docked on the side, the mascot sometimes glitches out
// and I can see both the docked pose and the notification pose overlapping"
// (Destin 2026-09-11). Attention (the notification pose) and the dock (pushed
// separately by main) are two inputs, and main can leave the dock at 'peeking'
// while attention is on — the notification broadcast lands before main's
// pop-out, and a buddy dragged onto an edge while something already needs you
// never gets popped out at all. The pose used to let attention win while the
// edge grip (sink, lean, mittens) let the dock win, so both drew at once.

const state = vi.hoisted(() => ({ attention: false }));
vi.mock('../src/renderer/state/theme-context', () => ({
  useTheme: () => ({ theme: 'light', activeTheme: null, reducedEffects: false }),
}));
vi.mock('../src/renderer/hooks/useThemeMascot', () => ({ useThemeMascot: () => null }));
vi.mock('../src/renderer/hooks/useAnyAttentionNeeded', () => ({ useAnyAttentionNeeded: () => state.attention }));
import { BuddyMascot } from '../src/renderer/components/buddy/BuddyMascot';

// jsdom has no layout, so getBBox is missing and PeekHands would never draw its
// mittens — which would make "no mittens" pass for the wrong reason. A fake box
// lets the grip render exactly as it does in the app.
const realGetBBox = (SVGElement.prototype as unknown as { getBBox?: unknown }).getBBox;
beforeAll(() => {
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox =
    () => ({ x: 0, y: 0, width: 4, height: 4 }) as DOMRect;
});
afterAll(() => {
  (SVGElement.prototype as unknown as { getBBox?: unknown }).getBBox = realGetBBox;
});
afterEach(() => { cleanup(); state.attention = false; });

const drive = (edge: string) => ({
  dock: { mode: 'peeking' as const, edge }, onDragMove: vi.fn(), onDragEnd: vi.fn(), onTap: vi.fn(),
});
const sink = (c: HTMLElement) => c.querySelector<HTMLElement>('.mascot-sink')!;
// The edge-pinned grip mittens are the only aria-hidden children of the wrapper.
const mittens = (c: HTMLElement) => c.querySelectorAll('.mascot-wrap > [aria-hidden="true"]');

describe('a docked buddy that needs attention', () => {
  it('drops the side grip entirely instead of drawing it under the notification pose', async () => {
    const overlayDrive = drive('right');
    const view = render(<BuddyMascot overlayDrive={overlayDrive} />);
    // Control: the test can see the grip when nothing needs attention.
    await vi.waitFor(() => expect(mittens(view.container)).toHaveLength(2));
    expect(sink(view.container).dataset.dockMode).toBe('peeking');

    state.attention = true;
    view.rerender(<BuddyMascot overlayDrive={overlayDrive} />);
    expect(sink(view.container).dataset.dockMode).not.toBe('peeking');
    expect(mittens(view.container)).toHaveLength(0);

    // Attention clears while main still says peeking — he tucks back in.
    state.attention = false;
    view.rerender(<BuddyMascot overlayDrive={overlayDrive} />);
    expect(sink(view.container).dataset.dockMode).toBe('peeking');
    await vi.waitFor(() => expect(mittens(view.container)).toHaveLength(2));
  });

  it('comes out of a top or bottom edge too', () => {
    state.attention = true;
    const view = render(<BuddyMascot overlayDrive={drive('bottom')} />);
    expect(sink(view.container).dataset.dockMode).not.toBe('peeking');
  });

  it('does not play the hover swing-out while he is already out for attention', () => {
    state.attention = true;
    const view = render(<BuddyMascot overlayDrive={drive('left')} />);
    fireEvent.pointerEnter(view.container.querySelector('.mascot-wrap')!);
    expect(sink(view.container).dataset.swing).toBe('');
  });
});
