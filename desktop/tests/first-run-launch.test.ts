// The launch decision: setup screen or app. A slow answer must never open the app on a device that still needs setup.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { decideFirstRun, FIRST_RUN_ANSWER_WAIT_MS } from '../src/renderer/state/first-run-launch';

afterEach(() => { vi.useRealTimers(); });

function later<T>() { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const p = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; }

describe('decideFirstRun', () => {
  it('a quick answer decides at once', async () => {
    const decide = vi.fn();
    decideFirstRun(async () => ({ currentStep: 'AUTHENTICATE' }), decide);
    await vi.waitFor(() => expect(decide).toHaveBeenCalledWith(true));
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('waits well past 3 seconds for a slow answer instead of guessing "finished"', async () => {
    vi.useFakeTimers();
    const decide = vi.fn(); const answer = later<{ currentStep: string }>();
    decideFirstRun(() => answer.p, decide);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(decide).not.toHaveBeenCalled();
    answer.resolve({ currentStep: 'AUTHENTICATE' });
    await vi.advanceTimersByTimeAsync(0);
    expect(decide.mock.calls).toEqual([[true]]);
  });

  it('asks again after a failed ask (a backend still starting)', async () => {
    vi.useFakeTimers();
    const decide = vi.fn();
    const getState = vi.fn().mockRejectedValueOnce(new Error('not listening')).mockResolvedValue({ currentStep: 'AUTHENTICATE' });
    decideFirstRun(getState, decide);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(getState).toHaveBeenCalledTimes(2);
    expect(decide.mock.calls).toEqual([[true]]);
  });

  it('after the wait gives up the app opens, and a late "setup needed" still sends the person to setup', async () => {
    vi.useFakeTimers();
    const decide = vi.fn(); const answer = later<{ currentStep: string }>();
    decideFirstRun(() => answer.p, decide);
    await vi.advanceTimersByTimeAsync(FIRST_RUN_ANSWER_WAIT_MS);
    expect(decide.mock.calls).toEqual([[false]]);
    answer.resolve({ currentStep: 'AUTHENTICATE' });
    await vi.advanceTimersByTimeAsync(0);
    expect(decide.mock.calls).toEqual([[false], [true]]);
  });

  it('a late "finished" changes nothing, and nothing happens after unmount', async () => {
    vi.useFakeTimers();
    const decide = vi.fn(); const a = later<{ currentStep: string }>(); const b = later<{ currentStep: string }>();
    decideFirstRun(() => a.p, decide);
    await vi.advanceTimersByTimeAsync(FIRST_RUN_ANSWER_WAIT_MS);
    a.resolve({ currentStep: 'COMPLETE' });
    await vi.advanceTimersByTimeAsync(0);
    expect(decide.mock.calls).toEqual([[false]]);
    const decide2 = vi.fn();
    const stop = decideFirstRun(() => b.p, decide2);
    stop(); b.resolve({ currentStep: 'AUTHENTICATE' });
    await vi.advanceTimersByTimeAsync(FIRST_RUN_ANSWER_WAIT_MS);
    expect(decide2).not.toHaveBeenCalled();
  });

  it('no setup channel at all opens the app', () => {
    const decide = vi.fn();
    decideFirstRun(undefined, decide);
    expect(decide.mock.calls).toEqual([[false]]);
  });
});
