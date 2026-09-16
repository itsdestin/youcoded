// The silence stop: two quiet seconds AFTER you have spoken close the mic.
//
// Why the "after you have spoken" half matters more than it looks. If quiet
// alone closed the microphone, tapping the mic and then thinking for three
// seconds before starting would shut it in your face — and the deck answer
// (Q-3) is that the mic stays open until you stop TALKING, not until the room
// goes quiet. So a session that has heard nothing yet is never closed by
// silence, however long it lasts.
//
// The loudness is measured once, in the audio worklet in the browser layer, and
// travels to the main process as the second argument of `sendAudio(chunk, rms)`.
// This file drives that same path: 100 ms slices, ten a second, exactly as the
// worklet produces them.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  VoiceService, SPEECH_RMS_FLOOR, SILENCE_STOP_MS,
  type VoiceServiceToWorker, type VoiceWorkerHandle, type VoiceWorkerToService,
} from '../src/main/voice/voice-service';

const INSTALLED = {
  voiceRoot: '/fake/voice',
  addonPath: '/fake/voice/runtime/package/sherpa-onnx.node',
  wrapperEntryPath: '/fake/voice/runtime/package/sherpa-onnx.js',
  modelDir: '/fake/voice/model/parakeet',
};

/** Loud enough to count as talking, and quiet enough to count as the room. */
const TALKING = SPEECH_RMS_FLOOR * 5;
const ROOM = SPEECH_RMS_FLOOR / 10;
/** One 100 ms slice of 16 kHz mono Int16 audio = 1,600 samples = 3,200 bytes. */
const SLICE = 3_200;

class FakeWorker implements VoiceWorkerHandle {
  sent: VoiceServiceToWorker[] = [];
  private msgCb: ((m: VoiceWorkerToService) => void) | null = null;
  send(msg: VoiceServiceToWorker): void { this.sent.push(msg); }
  kill(): void {}
  onMessage(cb: (m: VoiceWorkerToService) => void): void { this.msgCb = cb; }
  onExit(): void {}
  onStderr(): void {}
  say(m: VoiceWorkerToService): void { this.msgCb?.(m); }
  stopped(): boolean { return this.sent.some((m) => m.type === 'stop'); }
}

function harness() {
  const worker = new FakeWorker();
  const service = new VoiceService({
    assets: { installed: () => INSTALLED, install: async () => INSTALLED },
    spawnWorker: () => worker,
    deliver: () => {},
    isWindowAlive: () => true,
    onWindowGone: () => () => {},
    platform: 'linux',
    arch: 'x64',
  });
  /** Feed `ms` worth of 100 ms slices at one loudness, moving the clock with
   *  them exactly as real audio would. */
  const feed = (rms: number, ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 100) {
      service.pushAudio(1, new ArrayBuffer(SLICE), rms);
      vi.advanceTimersByTime(100);
    }
  };
  return { service, worker, feed };
}

describe('voice-service: the silence stop', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('never closes the mic before you have said anything', async () => {
    const h = harness();
    await h.service.start(1);
    h.worker.say({ type: 'ready' });

    // Ten seconds of an empty room — five times the silence window.
    h.feed(ROOM, 10_000);

    expect(h.worker.stopped()).toBe(false);
  });

  it('closes the mic two seconds after you stop talking, and not before', async () => {
    const h = harness();
    await h.service.start(1);
    h.worker.say({ type: 'ready' });

    h.feed(TALKING, 1_000);
    // Just short of the window: still listening, because a person pausing for a
    // word and a person who has finished look identical until this much time
    // has passed.
    h.feed(ROOM, SILENCE_STOP_MS - 200);
    expect(h.worker.stopped()).toBe(false);

    h.feed(ROOM, 300);
    expect(h.worker.stopped()).toBe(true);
  });

  it('a loud burst resets the clock — a pause mid-sentence does not end it', async () => {
    const h = harness();
    await h.service.start(1);
    h.worker.say({ type: 'ready' });

    h.feed(TALKING, 500);
    h.feed(ROOM, 1_500);            // a long "...er..." pause
    expect(h.worker.stopped()).toBe(false);

    h.feed(TALKING, 200);           // you carry on: the clock goes back to zero
    h.feed(ROOM, 1_500);            // 1.5 s is no longer enough
    expect(h.worker.stopped()).toBe(false);

    h.feed(ROOM, 700);              // now it is
    expect(h.worker.stopped()).toBe(true);
  });

  it('sends only one stop, however much silence follows', async () => {
    const h = harness();
    await h.service.start(1);
    h.worker.say({ type: 'ready' });

    h.feed(TALKING, 500);
    h.feed(ROOM, 5_000);

    expect(h.worker.sent.filter((m) => m.type === 'stop')).toHaveLength(1);
    // ...and the mic really is shut: no audio is forwarded after the stop.
    const stopAt = h.worker.sent.findIndex((m) => m.type === 'stop');
    expect(h.worker.sent.slice(stopAt).some((m) => m.type === 'audio')).toBe(false);
  });
});

describe('the numbers the contract promises', () => {
  // Guard for whole-branch review F11. Every test here was written AGAINST the
  // constants, so changing "two quiet seconds" to ten kept them all green and
  // nothing but a human on a review deck would ever have noticed. A promise made
  // to Destin as a number gets a test that names the number.
  it('closes the mic after two quiet seconds (R3)', () => {
    expect(SILENCE_STOP_MS).toBe(2_000);
  });

  it('treats sound below 0.02 as room noise rather than speech', () => {
    // Raise this and quiet speakers stop being heard at all; lower it and a fan
    // keeps the microphone open until the user notices.
    expect(SPEECH_RMS_FLOOR).toBe(0.02);
  });
});
