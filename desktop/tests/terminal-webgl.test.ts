// releaseWebgl (src/renderer/components/terminal-webgl.ts) hands a hidden terminal's
// graphics context back to the browser through two private members of the INSTALLED
// @xterm/addon-webgl. jsdom has no WebGL, so the addon cannot be activated here; this
// pins the names in the package's own built code instead, so a bump that renames them
// fails here rather than quietly leaving every hidden terminal's context to garbage
// collection (and the 16-context limit back in play).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  releaseWebgl, claimWebglSlot, releaseWebglSlot, noteWebglShown, webglSlotFree, webglLayerCount,
  WEBGL_LAYER_LIMIT, type WebglHolder,
} from '../src/renderer/components/terminal-webgl';

describe('the WebGL layer pool', () => {
  const made: WebglHolder[] = [];
  const holder = (visible = false) => {
    const h: WebglHolder & { evicted: number; visible: boolean } = {
      visible, evicted: 0,
      isVisible: () => h.visible,
      evict: () => { h.evicted++; releaseWebglSlot(h); },
    };
    made.push(h);
    return h;
  };
  afterEach(() => { made.splice(0).forEach(releaseWebglSlot); });

  it('the limit is the browser\'s 16 contexts per page', () => {
    expect(WEBGL_LAYER_LIMIT).toBe(16);
  });

  it('below the limit, claiming takes nothing from anyone', () => {
    const hs = Array.from({ length: WEBGL_LAYER_LIMIT }, () => holder());
    hs.forEach(claimWebglSlot);
    expect(webglLayerCount()).toBe(WEBGL_LAYER_LIMIT);
    expect(hs.every((h: any) => h.evicted === 0)).toBe(true);
    expect(webglSlotFree()).toBe(false);
  });

  it('at the limit, the hidden holder shown least recently gives its layer back', () => {
    const hs = Array.from({ length: WEBGL_LAYER_LIMIT }, () => holder());
    hs.forEach(claimWebglSlot);
    // Show every holder in turn except #3, so #3 is the least recently shown.
    hs.forEach((h, i) => { if (i !== 3) noteWebglShown(h); });
    const next = holder(true);
    claimWebglSlot(next);
    expect((hs[3] as any).evicted).toBe(1);
    expect(hs.filter((h: any) => h.evicted).length).toBe(1);
    expect(webglLayerCount()).toBe(WEBGL_LAYER_LIMIT);
  });

  it('a visible holder is never evicted; with no hidden one the claim goes through anyway', () => {
    const hs = Array.from({ length: WEBGL_LAYER_LIMIT }, () => holder(true));
    hs.forEach(claimWebglSlot);
    claimWebglSlot(holder(true));
    expect(hs.every((h: any) => h.evicted === 0)).toBe(true);
    expect(webglLayerCount()).toBe(WEBGL_LAYER_LIMIT + 1);
  });
});

const require = createRequire(import.meta.url);

describe('releaseWebgl', () => {
  it('the installed addon still keeps its renderer and GL context under the names it reads', () => {
    const built = readFileSync(require.resolve('@xterm/addon-webgl'), 'utf8');
    expect(built).toMatch(/this\._renderer=this\._register\(new /);
    expect(built).toMatch(/this\._gl=this\._canvas\.getContext\("webgl2"/);
  });

  it('disposes the layer first, then loses its context', () => {
    const order: string[] = [];
    const addon: any = {
      dispose: vi.fn(() => order.push('dispose')),
      _renderer: { _gl: { getExtension: () => ({ loseContext: () => order.push('lose') }) } },
    };
    releaseWebgl(addon);
    expect(order).toEqual(['dispose', 'lose']);
  });

  it('a layer with no context (renamed member, never activated) is still disposed', () => {
    const addon: any = { dispose: vi.fn() };
    expect(() => releaseWebgl(addon)).not.toThrow();
    expect(addon.dispose).toHaveBeenCalledTimes(1);
  });
});
