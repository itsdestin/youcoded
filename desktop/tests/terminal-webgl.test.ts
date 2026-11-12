// releaseWebgl (src/renderer/components/terminal-webgl.ts) hands a hidden terminal's
// graphics context back to the browser through two private members of the INSTALLED
// @xterm/addon-webgl. jsdom has no WebGL, so the addon cannot be activated here; this
// pins the names in the package's own built code instead, so a bump that renames them
// fails here rather than quietly leaving every hidden terminal's context to garbage
// collection (and the 16-context limit back in play).
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { releaseWebgl } from '../src/renderer/components/terminal-webgl';

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
