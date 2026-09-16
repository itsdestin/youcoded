// The one promise voice-service.ts makes: EXACTLY ONE ENDING PER START.
//
// In plain words — every tap of the microphone finishes in precisely one of two
// ways: your words arrive (`final`), or a sentence explaining what went wrong
// arrives (`error`). Zero endings leaves the composer listening forever with a
// dead send button; two endings pastes your sentence in twice. Cancel is the
// deliberate exception: it ends the session and says nothing at all, because
// cancelling means the words are thrown away.
//
// There are seven ways a session can end and this file walks all seven, plus the
// refusal when a second window tries to open the same microphone. The seventh —
// an engine that neither crashes nor answers — is the one that was lost twice in
// design review, and it is the reason the engine has to tell us how much audio
// each pass is chewing on: without that number there is nothing to hold it to.
//
// Nothing here loads a speech engine. The worker is a fake, which is the only
// way to stage "it wedged" without shipping something that wedges.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { VoiceEvent } from '../src/shared/voice-types';
import {
  VoiceService, passDeadlineMs,
  type VoiceServiceToWorker, type VoiceWorkerHandle, type VoiceWorkerToService,
  type VoiceAssetsApi,
} from '../src/main/voice/voice-service';

/** A worker we can make behave badly on command. */
class FakeWorker implements VoiceWorkerHandle {
  sent: VoiceServiceToWorker[] = [];
  killed = 0;
  private msgCb: ((m: VoiceWorkerToService) => void) | null = null;
  private exitCb: ((code: number | null) => void) | null = null;
  private errCb: ((line: string) => void) | null = null;

  send(msg: VoiceServiceToWorker): void { this.sent.push(msg); }
  kill(): void { this.killed += 1; }
  onMessage(cb: (m: VoiceWorkerToService) => void): void { this.msgCb = cb; }
  onExit(cb: (code: number | null) => void): void { this.exitCb = cb; }
  onStderr(cb: (line: string) => void): void { this.errCb = cb; }

  // ── the levers a test pulls ──
  say(m: VoiceWorkerToService): void { this.msgCb?.(m); }
  die(code: number | null): void { this.exitCb?.(code); }
  printed(line: string): void { this.errCb?.(line); }
  types(): string[] { return this.sent.map((m) => m.type); }
}

const INSTALLED = {
  voiceRoot: '/fake/voice',
  addonPath: '/fake/voice/runtime/package/sherpa-onnx.node',
  wrapperEntryPath: '/fake/voice/runtime/package/sherpa-onnx.js',
  modelDir: '/fake/voice/model/parakeet',
};

function makeAssets(installed: boolean): VoiceAssetsApi {
  return {
    installed: () => (installed ? INSTALLED : null),
    install: async () => INSTALLED,
  };
}

interface Harness {
  service: VoiceService;
  /** The CURRENT worker (the newest one spawned). */
  worker: FakeWorker;
  /** Every event delivered, with the window it went to. */
  events: Array<{ to: number; event: VoiceEvent }>;
  /** Only the ENDINGS — this is the number the whole file is about. */
  endings: () => VoiceEvent[];
  closeWindow: (id: number) => void;
  /** Every worker spawned, oldest first — a second spawn (after the first is
   *  killed) lands here, which is what the stale-worker cases need. */
  workers: FakeWorker[];
}

function harness(opts: { installed?: boolean; alive?: number[] } = {}): Harness {
  const workers: FakeWorker[] = [];
  const events: Array<{ to: number; event: VoiceEvent }> = [];
  const alive = new Set(opts.alive ?? [1, 2]);
  const goneCallbacks = new Map<number, Set<() => void>>();

  const service = new VoiceService({
    assets: makeAssets(opts.installed ?? true),
    spawnWorker: () => { const w = new FakeWorker(); workers.push(w); return w; },
    deliver: (to, event) => { events.push({ to, event }); },
    isWindowAlive: (id) => alive.has(id),
    onWindowGone: (id, cb) => {
      const set = goneCallbacks.get(id) ?? new Set();
      set.add(cb);
      goneCallbacks.set(id, set);
      return () => { set.delete(cb); };
    },
    platform: 'linux',
    arch: 'x64',
  });

  return {
    service,
    workers,
    // The CURRENT worker: the newest spawned, so a test that replaces a dead one
    // reaches the live engine rather than the corpse.
    get worker() { return workers[workers.length - 1]; },
    events,
    endings: () => events
      .map((e) => e.event)
      .filter((e) => e.type === 'final' || e.type === 'error'),
    closeWindow: (id) => {
      alive.delete(id);
      for (const cb of goneCallbacks.get(id) ?? []) cb();
    },
  } as Harness;
}

describe('voice-service: exactly one ending per start', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('1. you stop it: one final, and a second final from the engine is ignored', async () => {
    const h = harness();
    await h.service.start(1);
    h.worker.say({ type: 'ready' });

    h.service.stop();
    expect(h.worker.types()).toContain('stop');

    h.worker.say({ type: 'pass-begin', segmentSeconds: 3 });
    h.worker.say({ type: 'final', text: 'call mum tomorrow.' });
    // A late duplicate — the exact shape that would paste the sentence twice.
    h.worker.say({ type: 'final', text: 'call mum tomorrow.' });

    expect(h.endings()).toEqual([{ type: 'final', text: 'call mum tomorrow.' }]);
    // The ending really ENDED it: the microphone is free for the next tap
    // rather than stuck reporting "already listening".
    await expect(h.service.start(1)).resolves.toBeUndefined();
  });

  it('1b. an engine that vanishes without a word still produces one ending', async () => {
    const h = harness();
    await h.service.start(1);
    // Nothing was printed and nothing was said — the composer is still owed an
    // ending, or the box would sit listening with a dead send button.
    h.worker.die(0);
    expect(h.endings()).toHaveLength(1);
    expect((h.endings()[0] as { message: string }).message).toContain('exit code 0');
  });

  it('2. you cancel it: nothing at all is sent, ever', async () => {
    const h = harness();
    await h.service.start(1);
    h.worker.say({ type: 'ready' });

    h.service.cancel();
    expect(h.worker.types()).toContain('cancel');
    // Everything the engine says afterwards is thrown away.
    h.worker.say({ type: 'final', text: 'words nobody asked to keep' });
    h.worker.say({ type: 'error', stage: 'pass', message: 'too late' });
    h.worker.die(0);

    expect(h.events).toEqual([]);
  });

  it('3. the engine crashes mid-pass: one error, with its exit code and its own last words', async () => {
    const h = harness();
    await h.service.start(1);
    h.worker.say({ type: 'ready' });
    h.worker.say({ type: 'pass-begin', segmentSeconds: 4 });
    h.worker.printed('sherpa-onnx: std::bad_alloc');
    h.worker.die(3);

    const ends = h.endings();
    expect(ends).toHaveLength(1);
    expect(ends[0].type).toBe('error');
    const message = (ends[0] as { message: string }).message;
    expect(message).toContain('exit code 3');
    // Verbatim, never a guessed cause.
    expect(message).toContain('sherpa-onnx: std::bad_alloc');
  });

  it('4. the engine will not load: one error carrying the loader\'s own sentence', async () => {
    const h = harness();
    await h.service.start(1);
    const real = "/fake/voice/runtime/package/sherpa-onnx.node: version `GLIBCXX_3.4.29' not found";
    h.worker.say({ type: 'error', stage: 'load' as const, message: real });

    expect(h.endings()).toEqual([{ type: 'error', message: real }]);
    // ...and the engine is thrown away rather than trusted for the next tap.
    expect(h.worker.killed).toBe(1);
  });

  it('5. a pass throws: one error, and the crash that follows adds nothing', async () => {
    const h = harness();
    await h.service.start(1);
    h.worker.say({ type: 'ready' });
    h.worker.say({ type: 'pass-begin', segmentSeconds: 6 });
    h.worker.say({ type: 'error', stage: 'pass', message: 'decodeAsync failed: invalid feature dim' });
    h.worker.die(1);

    expect(h.endings()).toHaveLength(1);
    expect((h.endings()[0] as { message: string }).message)
      .toBe('decodeAsync failed: invalid feature dim');
  });

  it('6. the window is closed: the session ends silently and the engine is unloaded', async () => {
    const h = harness();
    await h.service.start(1);
    h.worker.say({ type: 'ready' });
    h.worker.say({ type: 'pass-begin', segmentSeconds: 2 });

    h.closeWindow(1);

    // No ENDING is sent, because there is nobody to send it to. (The heartbeats
    // that went out while the pass was running are not endings.)
    expect(h.endings()).toEqual([]);
    expect(h.worker.types()).toContain('cancel');
    // The 1.14 GB recogniser goes back now, not in ten minutes.
    expect(h.worker.killed).toBe(1);
    // ...and the microphone is genuinely free again: a second window can start.
    await expect(h.service.start(2)).resolves.toBeUndefined();
  });

  it('7. the engine neither exits nor answers: the deadline ends it, once', async () => {
    const h = harness();
    await h.service.start(1);
    h.worker.say({ type: 'ready' });
    h.worker.printed('parakeet: decoding');
    // The engine acknowledges 12 seconds of audio... and then says nothing more.
    h.worker.say({ type: 'pass-begin', segmentSeconds: 12 });

    const deadline = passDeadlineMs(12);
    vi.advanceTimersByTime(deadline - 1);
    expect(h.endings()).toEqual([]);          // still within its budget
    vi.advanceTimersByTime(1);

    const ends = h.endings();
    expect(ends).toHaveLength(1);
    const message = (ends[0] as { message: string }).message;
    expect(message).toContain(`did not answer for ${Math.round(deadline / 1000)} seconds`);
    expect(message).toContain('parakeet: decoding');   // its own last words
    expect(h.worker.killed).toBe(1);

    // The kill produces an exit. That must NOT become a second ending.
    h.worker.die(null);
    expect(h.endings()).toHaveLength(1);
  });

  it('7b. an engine that never finishes loading is ended too', async () => {
    const h = harness();
    await h.service.start(1);
    vi.advanceTimersByTime(60_000);
    const ends = h.endings();
    expect(ends).toHaveLength(1);
    expect((ends[0] as { message: string }).message).toContain('did not finish loading');
  });

  it('7c. Stop that never comes back is ended too', async () => {
    const h = harness();
    await h.service.start(1);
    h.worker.say({ type: 'ready' });
    h.service.stop();
    vi.advanceTimersByTime(20_000);
    const ends = h.endings();
    expect(ends).toHaveLength(1);
    expect((ends[0] as { message: string }).message).toContain('did not return your words');
  });

  it('8. a second window is refused, with a reason a person can act on', async () => {
    const h = harness();
    await h.service.start(1);
    await expect(h.service.start(2)).rejects.toThrow(
      /already listening in another YouCoded window/,
    );
    // The refusal did not disturb the session that was already running.
    expect(h.endings()).toEqual([]);
    h.service.stop();
    h.worker.say({ type: 'final', text: 'still mine' });
    expect(h.endings()).toEqual([{ type: 'final', text: 'still mine' }]);
  });

  it('the heartbeat runs only while a pass is running', async () => {
    const h = harness();
    await h.service.start(1);
    h.worker.say({ type: 'ready' });

    vi.advanceTimersByTime(2_000);
    const beforeAnyPass = h.events.filter((e) => e.event.type === 'heartbeat').length;
    expect(beforeAnyPass).toBe(0);

    h.worker.say({ type: 'pass-begin', segmentSeconds: 2 });
    vi.advanceTimersByTime(1_500);
    const during = h.events.filter((e) => e.event.type === 'heartbeat').length;
    expect(during).toBeGreaterThan(1);

    h.worker.say({ type: 'pass-end', segmentSeconds: 2, ms: 90 });
    h.worker.say({ type: 'partial', committed: 'Hello.', tail: 'there' });
    vi.advanceTimersByTime(3_000);
    // Stopped when the pass ended — which is exactly what arms the composer's
    // own watchdog.
    expect(h.events.filter((e) => e.event.type === 'heartbeat').length).toBe(during);
  });

  it('live words go only to the window that opened the microphone', async () => {
    const h = harness();
    await h.service.start(2);
    h.workers[0].say({ type: 'ready' });
    h.workers[0].say({ type: 'pass-begin', segmentSeconds: 1 });
    h.workers[0].say({ type: 'pass-end', segmentSeconds: 1, ms: 45 });
    h.workers[0].say({ type: 'partial', committed: 'One.', tail: 'two' });
    expect(h.events.filter((e) => e.event.type === 'partial')).toEqual([
      { to: 2, event: { type: 'partial', committed: 'One.', tail: 'two' } },
    ]);
  });

  it('refuses to start when the speech engine is not downloaded, and says so', async () => {
    const h = harness({ installed: false });
    await expect(h.service.start(1)).rejects.toThrow(/has not been downloaded/);
    expect(h.workers).toHaveLength(0);
  });
});

// ── The wiring, which no other test can see ──────────────────────────────────
// Everything above proves the state machine behaves. None of it would run in
// the real app if main.ts never called the register function: the six channels
// would exist in preload.ts with nobody answering them, so tapping the
// microphone would hang forever and every test here would still be green. That
// is the "feature ships dead" failure, and this is the only thing that catches
// it. Source text rather than behaviour, because main.ts cannot be imported in
// a test (it builds windows at module load).
describe('voice: the wiring from main.ts', () => {
  const read = (rel: string) =>
    fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it('main.ts registers the handlers and kills the engine at quit', () => {
    const main = read('src/main/main.ts');
    expect(main).toMatch(/registerVoiceHandlers\(app\.getPath\('userData'\)\)/);
    // The teardown must sit on the app's single shutdown path, which is what
    // before-quit, a last-window-close and an OS shutdown all route through.
    const shutdown = main.slice(main.indexOf('async function runShutdown'));
    expect(shutdown).toContain('shutdownVoiceHandlers()');
  });

  it('preload.ts exposes all eight members the composer calls', () => {
    const preload = read('src/main/preload.ts');
    const block = preload.slice(preload.search(/^ {2}voice: \{/m));
    const ns = block.slice(0, block.indexOf('\n  },'));
    for (const member of [
      'status', 'download', 'start', 'stop', 'cancel', 'micAccess', 'sendAudio', 'onEvent',
    ]) {
      expect(ns).toMatch(new RegExp(`^ {4}${member}\\s*[:(]`, 'm'));
    }
  });
});

// WHY this exists: a killed engine's `exit` can arrive after the user has tapped
// the mic again — and a wedged native decode loop is exactly the process that does
// not die promptly. Without an "is this still our worker?" check on the callbacks,
// the dead one ended the NEW session with "the speech engine closed unexpectedly"
// (an invented cause for a process we killed on purpose) AND set worker to null
// while the new engine was alive, orphaning it: stop and cancel then reached
// nothing and the next tap spawned a third 1.14 GB engine. Found reviewing T5,
// 2026-09-05.
describe('a dead worker cannot end a live session', () => {
  it('ignores the exit, the words and the error output of a worker we already replaced', async () => {
    const h = harness();
    await h.service.start(1);
    const first = h.worker;
    // The engine fails to load, so the service kills it and ends this session.
    first.say({ type: 'error', stage: 'load', message: 'no GLIBCXX' });
    expect(h.endings()).toHaveLength(1);

    // The user taps again straight away and gets a fresh engine.
    await h.service.start(1);
    const second = h.worker;
    expect(second).not.toBe(first);
    const endingsBefore = h.endings().length;

    // NOW the dead one finally exits, and prints its last words on the way out.
    first.printed('the dead engine had something to say');
    first.die(0);

    // The live session is untouched...
    expect(h.endings()).toHaveLength(endingsBefore);
    // ...and is still reachable, rather than orphaned behind a nulled reference.
    await h.service.stop();
    expect(second.types()).toContain('stop');
  });
});
