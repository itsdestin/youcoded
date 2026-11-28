// A model that MTP drafting stops from loading is loaded once more without it (review deck 2 Q-4).
import { describe, it, expect, vi } from 'vitest';
import { MtpFallback } from '../src/main/engine/mtp-fallback';

function make(hasMtp = true) {
  const deps = {
    hasMtp: vi.fn(() => hasMtp),
    reloadWithoutMtp: vi.fn(async () => {}),
    remember: vi.fn(async () => {}),
    restore: vi.fn(async () => {}),
  };
  return { deps, fb: new MtpFallback(deps) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('MtpFallback', () => {
  it('takes over the first failed load of an MTP model and retries without MTP', () => {
    const { deps, fb } = make();
    expect(fb.onLoadResult('m', false, true)).toBe(true);
    expect(deps.reloadWithoutMtp).toHaveBeenCalledWith('m');
    expect(fb.excluded('m')).toBe(true);
  });
  it('remembers when the retry loads, and reports that result normally', async () => {
    const { deps, fb } = make();
    fb.onLoadResult('m', false, true);
    await tick();
    expect(fb.onLoadResult('m', true, true)).toBe(false);
    expect(fb.excluded('m')).toBe(true);   // until the memory is written
    await tick();
    expect(deps.remember).toHaveBeenCalledWith('m');
    expect(fb.excluded('m')).toBe(false);
    expect(deps.restore).not.toHaveBeenCalled();
  });
  it('puts MTP back and reports the failure when the retry fails too', async () => {
    const { deps, fb } = make();
    fb.onLoadResult('m', false, true);
    await tick();
    expect(fb.onLoadResult('m', false, true)).toBe(false);
    await tick();
    expect(deps.restore).toHaveBeenCalledWith('m');
    expect(deps.remember).not.toHaveBeenCalled();
    expect(fb.excluded('m')).toBe(false);
  });
  it('leaves alone: a successful load, a model without MTP, an engine that could not be reached', () => {
    expect(make().fb.onLoadResult('m', true, true)).toBe(false);
    expect(make(false).fb.onLoadResult('m', false, true)).toBe(false);
    const unreachable = make();
    expect(unreachable.fb.onLoadResult('m', false, false)).toBe(false);
    expect(unreachable.deps.reloadWithoutMtp).not.toHaveBeenCalled();
  });
  it('puts MTP back and reports the held-back failure when the retry could not even be started', async () => {
    const { deps, fb } = make();
    const report = vi.fn();
    deps.reloadWithoutMtp.mockRejectedValueOnce(new Error('engine gone'));
    expect(fb.onLoadResult('m', false, true, report)).toBe(true);
    await tick();
    expect(fb.excluded('m')).toBe(false);
    expect(deps.restore).toHaveBeenCalledWith('m');
    expect(report).toHaveBeenCalledTimes(1);
  });
  it('a second failure from an overlapping older load does not end the retry', async () => {
    const { deps, fb } = make();
    expect(fb.onLoadResult('m', false, true)).toBe(true);    // first failure: retry begins
    expect(fb.onLoadResult('m', false, true)).toBe(true);    // the other load's failure: swallowed too
    expect(deps.reloadWithoutMtp).toHaveBeenCalledTimes(1);
    await tick();
    expect(fb.onLoadResult('m', true, true)).toBe(false);    // the retry itself loads
    await tick();
    expect(deps.remember).toHaveBeenCalledWith('m');
    expect(deps.restore).not.toHaveBeenCalled();
  });
});
