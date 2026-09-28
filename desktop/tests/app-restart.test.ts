// A restart goes through the ordinary quit: the Office gate saves (or asks) first, and the app
// starts again only once the quit is certain — Review cancels it, Close anyway restarts.
import { describe, expect, it, vi } from 'vitest';
import { gatedQuit, requestRestart } from '../src/main/app-restart';

function deps(go: boolean) {
  let proceed!: () => void;
  const d = {
    gate: vi.fn(async (onProceed: () => void) => { proceed = onProceed; return go; }),
    relaunch: vi.fn(),
    shutdown: vi.fn(async () => {}),
    quit: vi.fn(),
  };
  return { d, proceed: () => proceed() };
}

describe('restart and quit', () => {
  it('a restart quits through the gate, then relaunches and tears down', async () => {
    const quit = vi.fn();
    requestRestart(quit);
    expect(quit).toHaveBeenCalledTimes(1); // app.quit(), never app.exit()
    const { d } = deps(true);
    await gatedQuit(d);
    expect(d.gate).toHaveBeenCalled();
    expect(d.relaunch).toHaveBeenCalledTimes(1);
    expect(d.shutdown).toHaveBeenCalled();
    expect(d.quit).toHaveBeenCalled();
  });

  it('a restart held by an unsaved document relaunches only on Close anyway', async () => {
    requestRestart(() => {});
    const held = deps(false);
    await gatedQuit(held.d);
    expect(held.d.relaunch).not.toHaveBeenCalled();
    expect(held.d.shutdown).not.toHaveBeenCalled();
    held.proceed(); // Close anyway
    expect(held.d.relaunch).toHaveBeenCalledTimes(1);
    expect(held.d.quit).toHaveBeenCalledTimes(1);
  });

  it('after Review cancelled a restart, a later ordinary quit does not restart the app', async () => {
    requestRestart(() => {});
    await gatedQuit(deps(false).d); // Review: nothing else happens
    const later = deps(true);
    await gatedQuit(later.d);
    expect(later.d.relaunch).not.toHaveBeenCalled();
  });

  it('an ordinary quit never relaunches', async () => {
    const { d } = deps(true);
    await gatedQuit(d);
    expect(d.relaunch).not.toHaveBeenCalled();
    expect(d.quit).toHaveBeenCalled();
  });
});
