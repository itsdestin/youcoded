// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Freeze hunt 2026-10-22: building an AudioContext waits on the main process, and the end-of-reply
// chime built one at the moment a long reply finished (1.5-20 s freeze). The context is now built once,
// ahead of time, and reused.
const store = new Map<string, string>();
let built = 0;
let state = 'running';
const resume = vi.fn(async () => { state = 'running'; });
const suspend = vi.fn(async () => { state = 'suspended'; });
class FakeCtx {
  currentTime = 0; destination = {};
  get state() { return state; }
  constructor() { built++; }
  createGain() { return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
  createOscillator() { return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; }
  resume = resume; suspend = suspend;
  close = vi.fn();
}

beforeEach(() => { built = 0; state = 'running'; vi.resetModules(); vi.useFakeTimers(); (globalThis as any).AudioContext = FakeCtx; resume.mockClear(); suspend.mockClear(); store.clear(); vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } }); });
afterEach(() => { vi.useRealTimers(); });

describe('chime audio context', () => {
  it('prepareSounds builds the context ahead of time, so the chime builds nothing', async () => {
    const sounds = await import('../src/renderer/utils/sounds');
    sounds.prepareSounds();
    expect(built).toBe(1);
    sounds.playSound('ready');
    sounds.playSound('ready');
    expect(built).toBe(1);
  });

  it('a chime with no preparation still plays (builds on demand), and later chimes reuse it', async () => {
    const sounds = await import('../src/renderer/utils/sounds');
    sounds.playSound('ready');
    sounds.playSound('attention');
    expect(built).toBe(1);
  });

  it('wakes a sleeping context to play and puts it back to sleep after the chime', async () => {
    const sounds = await import('../src/renderer/utils/sounds');
    sounds.prepareSounds();           // built, asleep
    await vi.advanceTimersByTimeAsync(0);
    expect(state).toBe('suspended');
    sounds.playSound('ready');
    expect(resume).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1600);
    expect(suspend).toHaveBeenCalledTimes(2); // once by prepare, once after the chime
  });

  it('a muted app plays nothing and builds nothing when only a chime is asked for', async () => {
    store.set('youcoded-sound-muted', '1');
    const sounds = await import('../src/renderer/utils/sounds');
    sounds.playSound('ready');
    expect(built).toBe(0);
  });
});
