// @vitest-environment jsdom
// The microphone noticing that it has stopped (2026-09-30).
//
// What these pin, in plain terms: a microphone that goes away by itself — the
// device unplugged, or sound simply no longer arriving — used to leave the
// composer saying "Listening" with a flat meter forever. Now `open()` reports it
// exactly once, after closing the microphone. A quiet room is NOT a stopped
// microphone (quiet slices still arrive), and a microphone WE closed is never
// reported as lost.
//
// jsdom has no audio at all, so the browser's audio pieces are small fakes here:
// only what voice-capture.ts touches.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { open } from '../src/renderer/voice-capture';

class FakeTrack extends EventTarget { stop = vi.fn(); }
let track: FakeTrack;
let node: { port: { onmessage: ((e: MessageEvent) => void) | null; postMessage: () => void }; connect: () => void; disconnect: () => void };

/** One slice from the worklet, as the real one posts it. */
function slice(rms = 0.001) {
  node.port.onmessage?.({ data: { chunk: new ArrayBuffer(3200), rms } } as MessageEvent);
}

beforeEach(() => {
  vi.useFakeTimers();
  track = new FakeTrack();
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }),
    },
  });
  const g = globalThis as Record<string, unknown>;
  g.AudioContext = class {
    state = 'running';
    destination = {};
    audioWorklet = { addModule: async () => {} };
    createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} }; }
    createGain() { return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} }; }
    close() { return Promise.resolve(); }
  };
  g.AudioWorkletNode = class {
    port = { onmessage: null, postMessage: () => {} };
    connect() {}
    disconnect() {}
    constructor() { node = this as unknown as typeof node; }
  };
  URL.createObjectURL = () => 'blob:fake';
  URL.revokeObjectURL = () => {};
});

afterEach(() => { vi.useRealTimers(); });

describe('voice-capture — a microphone that stops by itself', () => {
  it('reports a microphone the system ended, once, after closing it', async () => {
    const onLost = vi.fn();
    await open(() => {}, onLost);
    track.dispatchEvent(new Event('ended'));
    track.dispatchEvent(new Event('ended'));
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalled(); // closed: the recording light is off
  });

  it('reports a microphone that stops sending sound, after four seconds', async () => {
    const onLost = vi.fn();
    await open(() => {}, onLost);
    slice();
    vi.advanceTimersByTime(3_000);
    expect(onLost).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_500);
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it('a quiet room is not a stopped microphone', async () => {
    const onLost = vi.fn();
    await open(() => {}, onLost);
    for (let i = 0; i < 100; i += 1) { slice(0.0001); vi.advanceTimersByTime(100); } // ten quiet seconds
    expect(onLost).not.toHaveBeenCalled();
  });

  it('a microphone we closed is never reported as lost', async () => {
    const onLost = vi.fn();
    const cap = await open(() => {}, onLost);
    cap.close();
    track.dispatchEvent(new Event('ended'));
    vi.advanceTimersByTime(10_000);
    expect(onLost).not.toHaveBeenCalled();
  });
});
