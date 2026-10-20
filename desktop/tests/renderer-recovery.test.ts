import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { canDeliverToRenderer, markRendererReady, rendererGeneration, sendToRenderer, wireRendererRecovery } from '../src/main/renderer-recovery';

function windowFixture() {
  const wc = Object.assign(new EventEmitter(), {
    id: 81, isDestroyed: () => false, isCrashed: () => false, send: vi.fn(),
  });
  const win = Object.assign(new EventEmitter(), { webContents: wc, isDestroyed: () => false });
  const load = vi.fn(async () => {});
  const offerRecovery = vi.fn(async () => false);
  const deps = { load, offerRecovery, shuttingDown: () => false };
  wireRendererRecovery(win as never, deps);
  return { wc, win, load, offerRecovery, deps };
}

afterEach(() => { vi.useRealTimers(); });

describe('renderer recovery', () => {
  it('reloads an unexpected crash once and waits for the replacement to be ready', async () => {
    vi.useFakeTimers();
    const { wc, load } = windowFixture();
    markRendererReady(wc.id);
    wc.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(canDeliverToRenderer(wc as never)).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(load).toHaveBeenCalledTimes(1);
    wc.emit('did-finish-load');
    expect(canDeliverToRenderer(wc as never)).toBe(false);
    markRendererReady(wc.id);
    expect(canDeliverToRenderer(wc as never)).toBe(true);
    wc.emit('destroyed');
  });

  it('offers a native choice rather than looping when the restored page crashes again', async () => {
    vi.useFakeTimers();
    const { wc, load, offerRecovery } = windowFixture();
    wc.emit('render-process-gone', {}, { reason: 'crashed' });
    await vi.advanceTimersByTimeAsync(500);
    wc.emit('render-process-gone', {}, { reason: 'crashed' });
    await vi.advanceTimersByTimeAsync(500);
    expect(load).toHaveBeenCalledTimes(1);
    expect(offerRecovery).toHaveBeenCalledTimes(1);
    wc.emit('destroyed');
  });

  it('does not recover clean exits, shutdown or a closed window', async () => {
    vi.useFakeTimers();
    const { wc, win, load, deps } = windowFixture();
    wc.emit('render-process-gone', {}, { reason: 'clean-exit' });
    await vi.advanceTimersByTimeAsync(500);
    expect(load).not.toHaveBeenCalled();
    deps.shuttingDown = () => true;
    wc.emit('render-process-gone', {}, { reason: 'crashed' });
    await vi.advanceTimersByTimeAsync(500);
    expect(load).not.toHaveBeenCalled();
    deps.shuttingDown = () => false;
    wc.emit('render-process-gone', {}, { reason: 'crashed' });
    win.emit('closed');
    await vi.advanceTimersByTimeAsync(500);
    expect(load).not.toHaveBeenCalled();
    wc.emit('destroyed');
  });

  it('rejects callbacks from the previous page and contains recipient send failures', () => {
    const { wc } = windowFixture();
    markRendererReady(wc.id);
    const old = rendererGeneration(wc.id);
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    markRendererReady(wc.id);
    expect(sendToRenderer(wc as never, 'test', [], old)).toBe(false);
    wc.send.mockImplementation(() => { throw new Error('disposed frame'); });
    expect(() => sendToRenderer(wc as never, 'test', [])).not.toThrow();
    wc.emit('destroyed');
  });
});
