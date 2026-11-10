// @vitest-environment jsdom
// Pins what the page does when the on-screen keyboard opens (hooks/useVisualViewport.ts, card #213).
// WHY (2026-11-09): this code carries six separate phone fixes Destin signed off on a Galaxy Z Flip7 and had no test
// that ran it. It was written BEFORE the code was split into parts, against the unsplit code, so the split is proved
// to change nothing. Each case names the complaint it protects.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useVisualViewport } from '../src/renderer/hooks/useVisualViewport';
import { KEYBOARD_OFFSET_EVENT } from '../src/renderer/hooks/keyboard-live-lift';

type Listener = () => void;
let now = 0;
let frames: Array<() => void> = [];
let vv: { height: number; offsetTop: number; listeners: Record<string, Listener[]>; addEventListener: any; removeEventListener: any };
const root = () => document.documentElement.style;
/** Run one screen frame, `ms` later. */
const frame = (ms = 16) => { now += ms; const run = frames; frames = []; run.forEach(f => f()); };
const framesUntilQuiet = (ms = 16, max = 200) => { let n = 0; while (frames.length && n++ < max) frame(ms); };
const ime = (px: number, rest?: boolean) => (window as any).__ycImeOffset(px, rest);

beforeEach(() => {
  now = 1000; frames = [];
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (f: () => void) => { frames.push(f); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => { frames = []; });
  vv = {
    height: 800, offsetTop: 0, listeners: {},
    addEventListener(t: string, f: Listener) { (this.listeners[t] ||= []).push(f); },
    removeEventListener(t: string, f: Listener) { this.listeners[t] = (this.listeners[t] || []).filter(x => x !== f); },
  };
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  // This suite's jsdom has no storage; the remembered keyboard height needs one.
  const kept = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); }, removeItem: (k: string) => { kept.delete(k); },
  } });
  document.body.innerHTML = `
    <div class="chrome-glass" style="--bottom-chrome-total: 60px"></div>
    <div class="bottom-float"><textarea id="chat"></textarea></div>
    <div class="empty-chat-hint"></div>
    <div data-term-lift id="grid"></div>
    <div class="drawer"><input id="search"></div>`;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

const bar = () => document.querySelector<HTMLElement>('.bottom-float')!;
const focus = (id: string) => document.getElementById(id)!.focus();

describe('keyboard offset: a phone web browser (reports the keyboard a frame at a time)', () => {
  it('typing in the chat lifts the chat and tells popups, at once, with no glide', () => {
    renderHook(() => useVisualViewport());
    focus('chat');
    vv.height = 500; vv.listeners.resize.forEach(f => f());
    frame();
    expect(root().getPropertyValue('--kb-offset')).toBe('300px');
    expect(root().getPropertyValue('--vvp-offset')).toBe('300px');
    expect(bar().style.transform).toBe('');
    expect(frames.length).toBe(0);
  });

  it('typing in a drawer leaves the chat where it is ("the chat input area slides up behind it")', () => {
    renderHook(() => useVisualViewport());
    focus('search');
    vv.height = 500; vv.listeners.resize.forEach(f => f());
    frame();
    expect(root().getPropertyValue('--kb-offset')).toBe('300px');
    expect(root().getPropertyValue('--vvp-offset')).toBe('0px');
  });

  it('a computer (no keyboard reported) stays at zero', () => {
    renderHook(() => useVisualViewport());
    framesUntilQuiet();
    expect(root().getPropertyValue('--kb-offset')).toBe('0px');
    expect(root().getPropertyValue('--vvp-offset')).toBe('0px');
  });
});

describe('keyboard offset: the Android app (sends the final height once; the page glides)', () => {
  it('popups get the final height at once; the chat glides by direct moves and the page-wide value waits', () => {
    renderHook(() => useVisualViewport());
    focus('chat');
    const lifts: number[] = [];
    window.addEventListener(KEYBOARD_OFFSET_EVENT, (e: any) => lifts.push(e.detail.lift));
    ime(300);
    frame(); frame(); frame();
    expect(root().getPropertyValue('--kb-offset')).toBe('300px');
    // "it still feels jumpy/stuttery": the page-wide value is not rewritten each step.
    expect(root().getPropertyValue('--vvp-offset')).toBe('0px');
    expect(bar().style.transform).toMatch(/^translateY\(-\d+px\)$/);
    expect(document.getElementById('grid')!.style.transform).toContain('var(--term-grid-lift, 0px)');
    expect(lifts.some(l => l > 0 && l < 300)).toBe(true);
    expect(frames.length).toBe(1);   // still moving
  });

  it('the hand-over is ONE frame: final value written, direct moves removed, messages told lift 0', () => {
    renderHook(() => useVisualViewport());
    focus('chat');
    ime(300);
    let sawBoth = false;
    const lifts: number[] = [];
    window.addEventListener(KEYBOARD_OFFSET_EVENT, (e: any) => {
      lifts.push(e.detail.lift);
      // At the moment the messages are told "lift 0", everything else has already handed over.
      if (e.detail.lift === 0 && root().getPropertyValue('--vvp-offset') === '300px') sawBoth = bar().style.transform === '';
    });
    framesUntilQuiet();
    expect(sawBoth).toBe(true);
    expect(root().getPropertyValue('--vvp-offset')).toBe('300px');
    expect(bar().style.transform).toBe('');
    expect(document.querySelector<HTMLElement>('.empty-chat-hint')!.style.transform).toBe('');
    expect(document.getElementById('grid')!.style.transform).toBe('');
    expect(document.querySelector<HTMLElement>('.chrome-glass')!.style.getPropertyValue('--bottom-chrome-total')).toBe('');
    expect(lifts[lifts.length - 1]).toBe(0);
  });

  it('the glide takes the keyboard\'s 300 ms and never steps more often than every 14 ms', () => {
    renderHook(() => useVisualViewport());
    focus('chat');
    ime(300);
    const start = now;
    const seen: string[] = [];
    let n = 0;
    while (frames.length && n++ < 400) { frame(4); seen.push(bar().style.transform); }
    expect(now - start).toBeGreaterThanOrEqual(300);
    expect(now - start).toBeLessThan(360);
    // 4 ms frames for ~300 ms is ~75 frames; at most one new position per 14 ms.
    expect(new Set(seen.filter(Boolean)).size).toBeLessThanOrEqual(24);
  });

  it('the frame edge is measured once per glide, so the lift never piles onto itself', () => {
    renderHook(() => useVisualViewport());
    focus('chat');
    const spy = vi.spyOn(window, 'getComputedStyle');
    ime(300);
    framesUntilQuiet();
    const edgeReads = spy.mock.calls.filter(c => (c[0] as HTMLElement).classList?.contains('chrome-glass')).length;
    expect(edgeReads).toBe(1);
  });

  it('a keyboard that announces too tall is corrected to its resting height and remembered ("overshoots the keyboard")', () => {
    renderHook(() => useVisualViewport());
    focus('chat');
    ime(284); framesUntilQuiet();
    ime(255, true); framesUntilQuiet();
    expect(root().getPropertyValue('--vvp-offset')).toBe('255px');
    ime(0); framesUntilQuiet();
    ime(284);   // next open: aims at the real height straight away
    frame();
    expect(root().getPropertyValue('--kb-offset')).toBe('255px');
  });

  it('closing glides back down to zero', () => {
    renderHook(() => useVisualViewport());
    focus('chat');
    ime(300); framesUntilQuiet();
    ime(0); framesUntilQuiet();
    expect(root().getPropertyValue('--vvp-offset')).toBe('0px');
    expect(root().getPropertyValue('--kb-offset')).toBe('0px');
  });

  it('leaving the screen removes both values and the app\'s way in', () => {
    const h = renderHook(() => useVisualViewport());
    ime(300); framesUntilQuiet();
    h.unmount();
    expect(root().getPropertyValue('--vvp-offset')).toBe('');
    expect(root().getPropertyValue('--kb-offset')).toBe('');
    expect((window as any).__ycImeOffset).toBeUndefined();
  });
});
