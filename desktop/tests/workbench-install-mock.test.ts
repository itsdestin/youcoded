import { describe, it, expect, beforeEach } from 'vitest';
import { installMock } from '../src/renderer/dev/workbench/install-mock';

describe('installMock', () => {
  beforeEach(() => { delete (globalThis as any).window; (globalThis as any).window = {}; });

  // platform.ts writes <html data-platform> synchronously at
  // module-graph head, keyed off `window.claude` — which the workbench installs
  // LATER, so the attribute never lands and every
  // `html[data-platform="electron"]` rule in globals.css silently does nothing.
  // That made terminal view render without its bottom frame strip and look
  // exactly like a bug the app had already fixed (PR #196). Measured via CDP:
  // without this, --bottom-chrome-total computes calc(0px + 0px) and
  // --terminal-bottom-inset is unset; with it, both resolve to 10px.
  it('declares the electron platform so platform-gated CSS applies', () => {
    const el: any = { dataset: {} };
    (globalThis as any).document = { documentElement: el };

    installMock();

    expect((window as any).__PLATFORM__).toBe('electron');
    expect(el.dataset.platform).toBe('electron');
    delete (globalThis as any).document;
  });

  it('does not overwrite a platform something else already decided', () => {
    const el: any = { dataset: { platform: 'android' } };
    (globalThis as any).document = { documentElement: el };
    (window as any).__PLATFORM__ = 'android';

    installMock();

    expect((window as any).__PLATFORM__).toBe('android');
    expect(el.dataset.platform).toBe('android');
    delete (globalThis as any).document;
  });

  it('installs a claude bridge when none exists', () => {
    installMock();
    expect((window as any).claude).toBeTruthy();
  });

  // The load-bearing safety property: it must never shadow a real preload
  // bridge or a live remote shim.
  it('refuses to install over an existing bridge', () => {
    const real = { session: {} };
    (window as any).claude = real;
    installMock();
    expect((window as any).claude).toBe(real);
  });
});
