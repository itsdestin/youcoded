// @vitest-environment jsdom
// Voice prompting — the composer's hook (T6).
//
// What these pin, in plain terms:
//  - On a COMPUTER, what the hardware says beats what the model folder says: a
//    downloaded speech model is worth nothing if the microphone is unplugged or
//    the operating system refused it.
//  - On a PHONE none of that happens. The phone's own recogniser owns the
//    microphone, so the hook must not go looking for one — and must never show
//    the phone the desktop's words about "your computer".
//  - A refused microphone is a "check again" card, not the "voice stopped" error
//    card. Those are two different screens with two different buttons.
//  - The give-up clock is restarted by the host's "still working" pings, so a
//    long sentence is never cut off — and if the words turn up after we gave up,
//    they still land in the box.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MIC_REFUSED_SENTENCE } from '../src/shared/voice-types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderHook, act } from '@testing-library/react';
import type { VoiceEvent, VoiceReadiness } from '../src/shared/voice-types';

// Only the microphone-opening half is faked. `probe()` runs for real against a
// stubbed device list below, so the "is there a microphone" logic is under test
// rather than mocked away.
const cap = vi.hoisted(() => ({ open: vi.fn(), closes: 0 }));
vi.mock('../src/renderer/voice-capture', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/voice-capture')>();
  return { ...actual, open: (...args: unknown[]) => cap.open(...args) };
});

import { useVoiceInput } from '../src/renderer/hooks/useVoiceInput';

const READY: VoiceReadiness = { state: 'ready', engine: 'Parakeet' };
const REFUSED = "Microphone access was refused by your computer. Allow it for YouCoded in your system's privacy settings, then check again.";
const NO_DEVICE = 'No microphone was found on this computer.';

type Access = 'granted' | 'denied' | 'not-determined' | 'unknown';

function installBridge(opts: { desktop: boolean; status?: VoiceReadiness; access?: Access; startRejects?: Error }) {
  const handlers = new Set<(e: VoiceEvent) => void>();
  const bridge: Record<string, unknown> = {
    status: vi.fn(async () => opts.status ?? READY),
    download: vi.fn(async () => {}),
    start: vi.fn(async () => { if (opts.startRejects) throw opts.startRejects; }),
    stop: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    onEvent: (cb: (e: VoiceEvent) => void) => { handlers.add(cb); return () => { handlers.delete(cb); }; },
  };
  if (opts.desktop) {
    bridge.sendAudio = vi.fn();
    bridge.micAccess = vi.fn(async () => opts.access ?? 'granted');
  }
  (window as unknown as { claude: unknown }).claude = { voice: bridge };
  return { bridge, emit: (e: VoiceEvent) => { handlers.forEach((h) => h(e)); } };
}

function stubDevices(kinds: string[]) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { enumerateDevices: async () => kinds.map((kind, i) => ({ kind, deviceId: `d${i}`, label: '', groupId: 'g' })) },
  });
}

function mount() {
  const onPartial = vi.fn();
  const onFinal = vi.fn();
  const hook = renderHook(() => useVoiceInput({ onPartial, onFinal }));
  return { ...hook, onPartial, onFinal };
}

/** Let the hook's mount-time status() and probe() promises settle. */
async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  cap.open.mockReset();
  cap.closes = 0;
  cap.open.mockImplementation(async () => ({ close: () => { cap.closes += 1; }, finish: async () => { cap.closes += 1; } }));
  stubDevices(['audioinput', 'audiooutput']);
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { claude?: unknown }).claude;
});

describe('useVoiceInput — readiness composition (desktop only)', () => {
  it('a refused microphone beats a downloaded model, in the exact words', async () => {
    installBridge({ desktop: true, status: READY, access: 'denied' });
    const { result } = mount();
    await settle();
    expect(result.current.readiness).toEqual({ state: 'unavailable', reason: REFUSED });
    // It is a CARD state, not the error card — nothing was thrown.
    expect(result.current.error).toBeNull();
  });

  it('no audio input device, permission not refused → "No microphone was found on this computer."', async () => {
    stubDevices(['audiooutput', 'videoinput']);
    installBridge({ desktop: true, status: READY, access: 'not-determined' });
    const { result } = mount();
    await settle();
    expect(result.current.readiness).toEqual({ state: 'unavailable', reason: NO_DEVICE });
  });

  it('a working microphone lets the host answer stand', async () => {
    installBridge({ desktop: true, status: { state: 'needs-download', engine: 'Parakeet', sizeMb: 639 }, access: 'granted' });
    const { result } = mount();
    await settle();
    expect(result.current.readiness).toEqual({ state: 'needs-download', engine: 'Parakeet', sizeMb: 639 });
  });

  it('ANDROID: nothing is composed — the host has the only say', async () => {
    // A phone with no `sendAudio`/`micAccess`, and (as in a WebView) no device
    // list at all. It must still report the recogniser's own "ready".
    stubDevices([]);
    installBridge({ desktop: false, status: READY });
    const { result } = mount();
    await settle();
    expect(result.current.readiness).toEqual(READY);
    expect(result.current.supported).toBe(true);
  });
});

describe('useVoiceInput — who opens the microphone', () => {
  it('ANDROID: start() is the bridge call alone and opens no microphone', async () => {
    installBridge({ desktop: false });
    const { result } = mount();
    await settle();
    await act(async () => { await result.current.start(); });
    expect(cap.open).not.toHaveBeenCalled();
    expect((window as any).claude.voice.start).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('listening');
  });

  it('DESKTOP: start() opens the microphone and only then says "Listening"', async () => {
    installBridge({ desktop: true });
    const { result } = mount();
    await settle();
    await act(async () => { await result.current.start(); });
    expect(cap.open).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('listening');
  });

  it('the WORKBENCH is not a desktop for this purpose — its fake offers both members and still opens no microphone', async () => {
    // The design-review tab would otherwise raise a real Chrome permission
    // prompt over the mock-up, and report "no microphone" in the headless rig.
    window.history.replaceState({}, '', '/?mode=workbench');
    installBridge({ desktop: true, access: 'denied' });
    const { result } = mount();
    await settle();
    // No composition either: the fake's scripted readiness is what is reviewed.
    expect(result.current.readiness).toEqual(READY);
    await act(async () => { await result.current.start(); });
    expect(cap.open).not.toHaveBeenCalled();
  });

  it('a refusal at start time is the "check again" card, never the error card', async () => {
    installBridge({ desktop: true });
    const denied = new Error('Permission denied');
    denied.name = 'NotAllowedError';
    cap.open.mockRejectedValueOnce(denied);
    const { result } = mount();
    await settle();
    await act(async () => { await result.current.start(); });
    expect(result.current.readiness).toEqual({ state: 'unavailable', reason: REFUSED });
    expect(result.current.error).toBeNull();
    // The strip never flashed, and the host was told to forget the start.
    expect(result.current.phase).toBe('idle');
    expect((window as any).claude.voice.cancel).toHaveBeenCalledTimes(1);
  });

  it('an unplugged microphone at start time says so, and any other failure names the real error', async () => {
    installBridge({ desktop: true });
    const none = new Error('Requested device not found');
    none.name = 'NotFoundError';
    cap.open.mockRejectedValueOnce(none);
    const { result } = mount();
    await settle();
    await act(async () => { await result.current.start(); });
    expect(result.current.readiness).toEqual({ state: 'unavailable', reason: NO_DEVICE });

    const weird = new Error('Could not start audio source');
    weird.name = 'NotReadableError';
    cap.open.mockRejectedValueOnce(weird);
    await act(async () => { await result.current.start(); });
    const r = result.current.readiness as { state: string; reason: string };
    expect(r.state).toBe('unavailable');
    expect(r.reason).toContain('Voice could not open a microphone.');
    expect(r.reason).toContain('NotReadableError: Could not start audio source');
  });

  it('the loudness of each slice goes to the host AND drives the meter here', async () => {
    installBridge({ desktop: true });
    let feed: ((chunk: ArrayBuffer, rms: number) => void) | undefined;
    cap.open.mockImplementationOnce(async (cb: (c: ArrayBuffer, r: number) => void) => {
      feed = cb;
      return { close: () => { cap.closes += 1; }, finish: async () => { cap.closes += 1; } };
    });
    const { result } = mount();
    await settle();
    await act(async () => { await result.current.start(); });
    const chunk = new ArrayBuffer(3200);
    act(() => { feed!(chunk, 0.05); });
    expect((window as any).claude.voice.sendAudio).toHaveBeenCalledWith(chunk, 0.05);
    // The ring moved without any round trip to the host.
    expect(result.current.level).toBeGreaterThan(0);
  });
});

describe('the last thing you said', () => {
  // Destin, 2026-09-05: "the last bit of whatever I said doesn't get
  // transcribed when I let go of spacebar". Three things were being thrown
  // away at the moment the mic closed — the worklet's part-filled bucket, any
  // slice already posted but not yet handled, and whatever was still inside the
  // browser's own microphone pipeline — and all three are the END of a sentence.
  it('drains the microphone before telling the host to stop', async () => {
    const { bridge } = installBridge({ desktop: true });
    const order: string[] = [];
    let releaseDrain!: () => void;
    const drained = new Promise<void>((r) => { releaseDrain = r; });
    cap.open.mockImplementation(async () => ({
      close: () => { order.push('close'); },
      finish: async () => { order.push('finish-start'); await drained; order.push('finish-done'); },
    }));
    bridge.stop = vi.fn(async () => { order.push('host-stop'); });

    const h = mount();
    await settle();
    await act(async () => { await h.result.current.start(); });
    expect(h.result.current.phase).toBe('listening');

    let stopping!: Promise<void>;
    await act(async () => { stopping = h.result.current.stop(); await Promise.resolve(); });

    // The strip already says Finishing — the drain is invisible.
    expect(h.result.current.phase).toBe('finishing');
    // And the host has NOT been told to stop yet: it would decode without the
    // last words if it had been.
    expect(order).toEqual(['finish-start']);

    await act(async () => { releaseDrain(); await stopping; });
    expect(order).toEqual(['finish-start', 'finish-done', 'host-stop']);
  });

  it('cancelling does not wait — nothing is being kept', async () => {
    installBridge({ desktop: true });
    const order: string[] = [];
    cap.open.mockImplementation(async () => ({
      close: () => { order.push('close'); },
      finish: async () => { order.push('finish'); },
    }));
    const h = mount();
    await settle();
    await act(async () => { await h.result.current.start(); });
    await act(async () => { await h.result.current.cancel(); });
    // The blunt close, not the drain: a cancelled turn keeps no words at all.
    expect(order).toEqual(['close']);
  });
});

describe('letting go before the microphone is even open', () => {
  // Guard for review finding F1. The hold-to-talk key-up used to land on a
  // `stop()` that handed straight back — the phase still said "idle", because
  // `start()` only says "listening" once the host call and the microphone have
  // both come back. On macOS the host call sits on the system permission
  // dialog, so that window is as long as the user takes to answer it. The mic
  // then opened with nobody holding the key, and in a quiet room nothing shut
  // it: the two-second silence stop only arms after speech is heard.
  //
  // Every earlier hold test used a `start` that resolved instantly, so the
  // window they were meant to cover never existed. This one holds the door open.
  it('never opens the microphone when the key comes up mid-start', async () => {
    const { bridge } = installBridge({ desktop: true });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    bridge.start = vi.fn(async () => { await held; });

    const h = mount();
    await settle();

    // Key down: the start goes in flight and parks on the host call.
    let started!: Promise<void>;
    await act(async () => { started = h.result.current.start(); await Promise.resolve(); });
    expect(h.result.current.phase).toBe('idle');

    // Key up, while the host has still not answered.
    await act(async () => { await h.result.current.stop(); });

    // Now the host answers. Nothing may open.
    await act(async () => { release(); await started; });

    expect(cap.open).not.toHaveBeenCalled();
    expect(bridge.cancel).toHaveBeenCalled();
    expect(h.result.current.phase).toBe('idle');
  });

  it('closes the microphone when the key comes up while it is opening', async () => {
    const { bridge } = installBridge({ desktop: true });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    // This time the host answers at once and the MICROPHONE is what is slow.
    cap.open.mockImplementation(async () => { await held; return { close: () => { cap.closes += 1; }, finish: async () => { cap.closes += 1; } }; });

    const h = mount();
    await settle();
    let started!: Promise<void>;
    await act(async () => { started = h.result.current.start(); await Promise.resolve(); });
    await act(async () => { await h.result.current.stop(); });
    await act(async () => { release(); await started; });

    expect(cap.closes).toBe(1);
    expect(bridge.cancel).toHaveBeenCalled();
    expect(h.result.current.phase).toBe('idle');
  });
});

describe('useVoiceInput — the give-up clock', () => {
  it('is restarted by every "still working" ping, and only fires when they stop', async () => {
    vi.useFakeTimers();
    const { emit } = installBridge({ desktop: true });
    const { result } = mount();
    await settle();
    await act(async () => { await result.current.start(); });

    // A long sentence: pings keep arriving well past the 12-second window.
    for (let i = 0; i < 5; i += 1) {
      act(() => { vi.advanceTimersByTime(10_000); });
      act(() => { emit({ type: 'heartbeat' }); });
    }
    expect(result.current.error).toBeNull();
    expect(result.current.phase).toBe('listening');

    // The pings stop.
    act(() => { vi.advanceTimersByTime(13_000); });
    expect(result.current.error).toContain('Voice stopped responding');
    expect(result.current.phase).toBe('idle');
    // The microphone was let go, not left open behind an error.
    expect(cap.closes).toBe(1);
  });

  // WHY: this clock used to start at `start()`, before anything could possibly have
  // answered — which made it a LOAD timer, and at twelve seconds it was five times
  // shorter than the minute the host allows to load the speech model. The first
  // dictation after an idle unload, on a healthy machine, ended in "Voice stopped
  // responding". Found reviewing T6, 2026-09-05.
  it('does not fire while the engine is still loading, before it has answered once', async () => {
    vi.useFakeTimers();
    installBridge({ desktop: true });
    const { result } = mount();
    await settle();
    await act(async () => { await result.current.start(); });
    // Far past the clock, but nothing has answered yet, so nothing has gone quiet.
    act(() => { vi.advanceTimersByTime(45_000); });
    expect(result.current.error).toBeNull();
    expect(result.current.phase).toBe('listening');
  });

  // WHY: without this the host keeps the session and refuses the NEXT tap with
  // "already listening in this window" — about a window where nothing is listening
  // — so one give-up used to break the mic until the app restarted.
  it('tells the host it gave up, so the next tap is not refused', async () => {
    vi.useFakeTimers();
    const { emit, bridge } = installBridge({ desktop: true });
    const { result } = mount();
    await settle();
    await act(async () => { await result.current.start(); });
    act(() => { emit({ type: 'heartbeat' }); });
    act(() => { vi.advanceTimersByTime(13_000); });
    expect(result.current.error).toContain('Voice stopped responding');
    expect(bridge.cancel).toHaveBeenCalled();
  });

  // WHY: the host goes on heartbeating through a session this side has abandoned.
  // An armed clock with nobody listening put an error card on screen out of
  // nowhere, every twelve seconds, forever.
  it('a heartbeat while nothing is listening arms nothing', async () => {
    vi.useFakeTimers();
    const { emit } = installBridge({ desktop: true });
    const { result } = mount();
    await settle();
    act(() => { emit({ type: 'heartbeat' }); });
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(result.current.error).toBeNull();
    expect(result.current.phase).toBe('idle');
  });

  it('words that arrive after we gave up still land in the box', async () => {
    vi.useFakeTimers();
    const { emit } = installBridge({ desktop: true });
    const { result, onFinal } = mount();
    await settle();
    await act(async () => { await result.current.start(); });
    // One sign of life first: the clock measures "went quiet AFTER answering".
    act(() => { emit({ type: 'heartbeat' }); });
    act(() => { vi.advanceTimersByTime(13_000); });
    expect(result.current.error).toContain('Voice stopped responding');

    act(() => { emit({ type: 'final', text: 'the late sentence' }); });
    expect(onFinal).toHaveBeenCalledWith('the late sentence');
    // And the error it contradicts is gone.
    expect(result.current.error).toBeNull();
  });

  it('ANDROID has no such clock — a phone sends no pings and a silent pause is not a failure', async () => {
    vi.useFakeTimers();
    installBridge({ desktop: false });
    const { result } = mount();
    await settle();
    await act(async () => { await result.current.start(); });
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(result.current.error).toBeNull();
    expect(result.current.phase).toBe('listening');
  });
});

describe('useVoiceInput — events while the mic is closed', () => {
  it('a stray partial, final or level after the mic closed changes nothing', async () => {
    const { emit } = installBridge({ desktop: true });
    const { result, onPartial, onFinal } = mount();
    await settle();
    act(() => {
      emit({ type: 'partial', committed: 'ghost.', tail: 'words' });
      emit({ type: 'final', text: 'ghost words' });
      emit({ type: 'level', value: 0.9 });
    });
    expect(onPartial).not.toHaveBeenCalled();
    expect(onFinal).not.toHaveBeenCalled();
    expect(result.current.level).toBe(0);
    expect(result.current.phase).toBe('idle');
  });
});

// A SOURCE guard, because no runtime test in this suite can see the bug it stops.
// Under vitest `import.meta.env.DEV` is always true, so `isWorkbenchMode()` behaves
// exactly like the safe predicate here and every runtime assertion passes either
// way. The bug only exists in the built landing-page bundle, where Vite folds the
// dev-only predicate to `false` and the microphone gate disappears — the marketing
// page would have asked visitors for their microphone. Found by reading that
// bundle, 2026-09-05. This is the cheapest thing that fails if someone swaps the
// predicate back.
// WHY both cases: the flow the contract row describes is first tap → the system's
// own prompt → decline, and that landed on the "voice stopped" card whose only
// button is OK, so the Check again button appeared only on some later look. And
// Electron wraps everything a main handler throws, so the careful sentence reached
// the user with "Error invoking remote method 'voice:start': Error: " bolted on.
// Found reviewing T5, 2026-09-05.
describe('a refusal from the operating system', () => {
  it('opens the check-again card, not the voice-stopped card', async () => {
    const { bridge } = installBridge({ desktop: true });
    (bridge.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error(`Error invoking remote method 'voice:start': Error: ${MIC_REFUSED_SENTENCE}`),
    );
    const { result } = mount();
    await settle();
    await act(async () => { await result.current.start(); });
    expect(result.current.error).toBeNull();
    expect(result.current.readiness).toEqual({ state: 'unavailable', reason: MIC_REFUSED_SENTENCE });
  });

  it('never shows Electron\'s wrapper text to the user', async () => {
    const { bridge } = installBridge({ desktop: true });
    (bridge.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Error invoking remote method 'voice:start': Error: the engine fell over"),
    );
    const { result } = mount();
    await settle();
    await act(async () => { await result.current.start(); });
    expect(result.current.error).toBe('the engine fell over');
  });
});

describe('the microphone gate uses the predicate that survives a production build', () => {
  it('useVoiceInput gates on isWorkbenchDocument, never isWorkbenchMode', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'renderer', 'hooks', 'useVoiceInput.ts'), 'utf8');
    expect(src).toContain('isWorkbenchDocument');
    // `isWorkbenchMode` is dev-only by design and is compiled out of the site build.
    expect(src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')).not.toContain('isWorkbenchMode');
  });

  it('isWorkbenchDocument checks VITE_WORKBENCH, which is what the site build sets', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'renderer', 'workbench-mode.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export function isWorkbenchDocument'));
    expect(fn.slice(0, fn.indexOf('}'))).toContain('VITE_WORKBENCH');
  });
});
