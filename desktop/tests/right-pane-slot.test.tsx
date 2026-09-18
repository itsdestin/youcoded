// @vitest-environment jsdom
// Destin, 2026-09-18: "i want the animation to smoothly handle open/close and
// switching between differently sized game/file panels" — all motion
// "interruptible and smooth ... aware of performance".
//
// The table (what is shown / reserved) is state/right-pane-motion.test.ts. This
// file is the VIEW: what it animates, from where, and what it reports back. jsdom
// has no Web Animations, so `animate` is a recording stub; each case below is a
// defect the first cuts of this feature actually had or the repo has shipped.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, renderHook } from '@testing-library/react';
import { RightPaneSlot } from '../src/renderer/components/RightPaneSlot';
import { ArtifactProvider, useArtifact } from '../src/renderer/state/ArtifactContext';
import { useRightPaneMotion, PANE_MOTION_SAFETY_MS } from '../src/renderer/hooks/use-right-pane-motion';
import type { PaneMotion } from '../src/renderer/state/right-pane-motion';

interface Call { frames: Array<{ clipPath: string; opacity: number }>; opts: KeyframeAnimationOptions; anim: { onfinish: null | (() => void); cancel: ReturnType<typeof vi.fn> } }
let calls: Call[];
let widths: { pane: number; content: number };

beforeEach(() => {
  calls = [];
  widths = { pane: 480, content: 480 };
  document.documentElement.removeAttribute('data-reduced-effects');
  (HTMLElement.prototype as any).animate = function (frames: any, opts: any) {
    const anim = { onfinish: null as null | (() => void), cancel: vi.fn() };
    calls.push({ frames, opts, anim });
    return anim;
  };
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) { return this.classList.contains('drawer-pane') ? widths.pane : this.classList.contains('right-pane-content') ? widths.content : 0; },
  });
});
afterEach(() => { delete (HTMLElement.prototype as any).animate; delete (HTMLElement.prototype as any).offsetWidth; });

const REST: PaneMotion = { shown: 'drawer', closing: false, from: null, opening: false };
const artifact = (open: boolean, file: string | null) => ({
  state: { drawerOpenBySession: { s1: open }, drawerExpanded: false, activeArtifactBySession: { s1: file } } as any,
  dispatch: vi.fn(),
});
function mount(motion: PaneMotion, ctx = artifact(true, 'notes.md')) {
  const onExited = vi.fn(); const onSettled = vi.fn();
  const ui = (m: PaneMotion, c = ctx) => (
    <ArtifactProvider value={c}>
      <RightPaneSlot pane={{ motion: m, onExited, onSettled }} sessionId="s1" gamePane={<div data-testid="game" />}
        renderDrawer={() => <ShowsFile />} />
    </ArtifactProvider>
  );
  const r = render(ui(motion));
  return { ...r, onExited, onSettled, set: (m: PaneMotion, c = ctx) => r.rerender(ui(m, c)) };
}
/** Reads the context the way SessionDrawer does, so the freeze is observable. */
function ShowsFile() {
  const { state } = useArtifact();
  return <div data-testid="file">{String((state as any).activeArtifactBySession.s1)}</div>;
}
const insetOf = (f: { clipPath: string }) => Number(/inset\(0px 0px 0px (-?[\d.]+)px/.exec(f.clipPath)![1]);

describe('what it animates', () => {
  it('an OPEN glides the edge in from fully covered, and reports back when done', () => {
    const { onSettled } = mount({ ...REST, opening: true });
    expect(calls).toHaveLength(1);
    expect(insetOf(calls[0].frames[0])).toBe(480);
    expect(calls[0].frames[0].opacity).toBe(0);
    expect(insetOf(calls[0].frames[1])).toBe(0);
    act(() => calls[0].anim.onfinish?.());
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('a pane that is merely RE-CREATED (tab switch, view toggle) does not animate at all', () => {
    // The first cut keyed the arrival on the pane element, which is re-created on
    // every session switch: an already-open panel wiped in again each time.
    mount(REST);
    expect(calls).toHaveLength(0);
  });

  it('only ever clip-path and opacity — never a transform, never a width', () => {
    // transform: the paint bug shipped twice on Windows Electron (overflow-hidden
    // pane, .layer-surface children). width: re-wraps the transcript per frame.
    mount({ ...REST, opening: true });
    for (const f of calls[0].frames) expect(Object.keys(f).sort()).toEqual(['clipPath', 'opacity']);
  });
});

describe('closing', () => {
  it('glides out, HOLDS there, goes inert, and only then reports exited', () => {
    const v = mount(REST);
    v.set({ ...REST, closing: true }, artifact(false, null));
    expect(insetOf(calls[0].frames[1])).toBe(480);
    expect(calls[0].frames[1].opacity).toBe(0);
    // fill forwards: with none, the pane would flash back whole for the frame
    // between the glide ending and the table unmounting it.
    expect(calls[0].opts.fill).toBe('forwards');
    expect(v.container.querySelector('.drawer-pane')!.hasAttribute('inert')).toBe(true);
    expect(v.onExited).not.toHaveBeenCalled();
    act(() => calls[0].anim.onfinish?.());
    expect(v.onExited).toHaveBeenCalledTimes(1);
  });

  it('keeps showing the file it had: closing wipes the real state in the same action', () => {
    const v = mount(REST, artifact(true, 'notes.md'));
    expect(v.getByTestId('file').textContent).toBe('notes.md');
    v.set({ ...REST, closing: true }, artifact(false, null));   // what DRAWER_CLOSED leaves behind
    expect(v.getByTestId('file').textContent).toBe('notes.md');
  });

  it('does not REMOUNT the drawer as it starts to leave', () => {
    // Wrapping it in the frozen provider only while closing changes the tree's
    // shape on that frame and resets the drawer's scroll and editor.
    const v = mount(REST);
    const before = v.getByTestId('file');
    v.set({ ...REST, closing: true }, artifact(false, null));
    expect(v.getByTestId('file')).toBe(before);
  });
});

describe('interruptible', () => {
  it('a reopen mid-close starts FROM WHERE THE PANE IS, not from the beginning', () => {
    const v = mount(REST);
    v.set({ ...REST, closing: true }, artifact(false, null));
    // Mid-glide: what the browser would report for the running animation.
    const pane = v.container.querySelector<HTMLElement>('.drawer-pane')!;
    pane.style.clipPath = 'inset(0px 0px 0px 200px round 8px)';
    pane.style.opacity = '0.6';
    v.set(REST, artifact(true, 'notes.md'));
    expect(calls).toHaveLength(2);
    expect(calls[0].anim.cancel).toHaveBeenCalled();
    expect(insetOf(calls[1].frames[0])).toBe(200);
    expect(calls[1].frames[0].opacity).toBeCloseTo(0.6);
    expect(insetOf(calls[1].frames[1])).toBe(0);
  });

  it('a cancelled glide never reports: its late onfinish is ignored', () => {
    const v = mount(REST);
    v.set({ ...REST, closing: true }, artifact(false, null));
    const stale = calls[0].anim;
    v.set(REST, artifact(true, 'notes.md'));
    act(() => stale.onfinish?.());
    expect(v.onExited).not.toHaveBeenCalled();
  });
});

describe('switching between the two differently sized panes', () => {
  it('to the NARROWER pane: the room is still the wide one, so the edge glides in and holds', () => {
    const v = mount(REST);
    widths = { pane: 480, content: 420 };            // reserved max(), content at its own width
    v.set({ shown: 'game', closing: false, from: 'drawer', opening: false });
    expect(insetOf(calls[0].frames[0])).toBe(0);
    expect(insetOf(calls[0].frames[1])).toBe(60);
    expect(calls[0].opts.fill).toBe('forwards');
    act(() => calls[0].anim.onfinish?.());
    expect(v.onSettled).toHaveBeenCalledTimes(1);
    // The table releases the room: the hold is dropped WITHOUT another glide.
    widths = { pane: 420, content: 420 };
    v.set({ shown: 'game', closing: false, from: null, opening: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].anim.cancel).toHaveBeenCalled();
  });

  it('to the WIDER pane: the room is already wide, so the edge starts where the old pane ended', () => {
    widths = { pane: 420, content: 420 };
    const v = mount({ ...REST, shown: 'game' });
    widths = { pane: 480, content: 480 };
    v.set({ shown: 'drawer', closing: false, from: 'game', opening: false });
    expect(insetOf(calls[0].frames[0])).toBe(60);
    expect(insetOf(calls[0].frames[1])).toBe(0);
  });

  it('lays the narrower pane out at ITS width while the room is wider — never wide-then-snap', () => {
    const v = mount(REST);
    v.set({ shown: 'game', closing: false, from: 'drawer', opening: false });
    const content = v.container.querySelector<HTMLElement>('.right-pane-content')!;
    expect(content.style.width).toContain('--game-pane-width');
    v.set({ shown: 'game', closing: false, from: null, opening: false });
    expect(v.container.querySelector<HTMLElement>('.right-pane-content')!.style.width).toBe('');   // plain box at rest
  });
});

describe('Reduce Visual Effects', () => {
  it('nothing animates and every step reports at once, so no room is left reserved', () => {
    document.documentElement.setAttribute('data-reduced-effects', '');
    const v = mount(REST);
    v.set({ ...REST, closing: true }, artifact(false, null));
    expect(calls).toHaveLength(0);
    expect(v.onExited).toHaveBeenCalledTimes(1);
  });
});

describe('useRightPaneMotion', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('follows the wanted pane in the SAME render — never one frame of "open" with its contents gone', () => {
    const seen: PaneMotion[] = [];
    const { rerender } = renderHook(({ w }) => { const p = useRightPaneMotion(w); seen.push(p.motion); return p; }, { initialProps: { w: 'drawer' as 'drawer' | null } });
    seen.length = 0;
    rerender({ w: null });
    // Every motion this render pass COMMITTED with already says closing.
    expect(seen[seen.length - 1].closing).toBe(true);
    expect(seen.filter((m) => m.shown === 'drawer' && !m.closing)).toHaveLength(1);   // the discarded pass only
  });

  it('a pane open at mount is shown but not "opening": nothing opened, nothing glides', () => {
    const { result } = renderHook(() => useRightPaneMotion('game'));
    expect(result.current.motion).toEqual({ shown: 'game', closing: false, from: null, opening: false });
  });

  it('finishes a close ITSELF when no view reports back — Android terminal view mounts no slot', () => {
    const { result, rerender } = renderHook(({ w }) => useRightPaneMotion(w), { initialProps: { w: 'drawer' as 'drawer' | null } });
    rerender({ w: null });
    expect(result.current.motion.shown).toBe('drawer');
    act(() => { vi.advanceTimersByTime(PANE_MOTION_SAFETY_MS); });
    expect(result.current.motion.shown).toBe(null);
  });
});
