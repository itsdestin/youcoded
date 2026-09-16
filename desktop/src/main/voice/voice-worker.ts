// The speech worker — a separate little program that does nothing but listen.
//
// WHY IT IS A SEPARATE PROGRAM AT ALL. Turning a stretch of sound into words is
// one long, uninterruptible calculation: measured on this machine, hearing 12
// seconds of speech takes about 280 milliseconds of solid work. If that happened
// inside the app itself, everything else in the app — the chat, the buttons, the
// terminal — would freeze for that long, over and over, the whole time the
// microphone is open. So Electron forks this file into its own process
// (`utilityProcess`), the app hands it sound down a pipe, and it hands words
// back. The app stays smooth no matter how hard this file is working.
//
// HOW IT IS STARTED. The parent (voice-service.ts) forks this file and passes
// the app's data folder as the first argument, because a forked process cannot
// ask Electron where that folder is. Everything on disk is then resolved by
// voice-pin.ts — this file builds no paths of its own, by design, so there is
// exactly one place that knows the layout.
//
// THE ONE IDEA THAT EXPLAINS THE REST — "re-hearing". The speech engine we chose
// (Parakeet) has no way to be fed sound a bit at a time and asked "what's new?".
// It only answers the question "what does this whole recording say?". So to show
// words while somebody is still talking, we re-ask it the same question every
// couple of hundred milliseconds, each time with a slightly longer recording.
// Every answer replaces the last one. That is why the words on screen can shuffle
// and re-punctuate themselves as you speak, and it is the reason for the grey
// text rule: see `splitAtLastSentenceEnd` in shared/voice-types.ts, which is THE
// implementation of that rule and is imported here rather than repeated.
//
// Design: docs/active/specs/2026-09-05-voice-prompting-technical-design.md
//         → "Main — src/main/voice/" → voice-worker.ts.
import * as path from 'path';
import { createRequire } from 'module';
import { splitAtLastSentenceEnd } from '../../shared/voice-types';
import { addonPath, wrapperEntryPath, modelDir, MODEL_FILES } from './voice-pin';

// ---------------------------------------------------------------------------
// The numbers, all in one place
// ---------------------------------------------------------------------------

/** Everything here assumes 16,000 sound measurements per second, mono — what the
 *  microphone worklet in the renderer produces and what Parakeet was trained on. */
export const VOICE_SAMPLE_RATE = 16_000;

/** One "frame" is a tenth of a second of sound. Loudness is measured per frame,
 *  and every timing decision below counts frames rather than samples, so the
 *  arithmetic stays readable. */
export const FRAME_SAMPLES = VOICE_SAMPLE_RATE / 10;

/** Below this loudness we call a frame silence.
 *
 *  The scale is 0 (digital silence) to 1 (as loud as the format can record), and
 *  0.01 is roughly "a quiet room with a laptop fan". It is deliberately generous:
 *  the only two things this number decides are WHERE to break a long dictation
 *  and WHEN a sentence has ended, and being a little too eager on either is
 *  invisible to the user, while being too strict means never breaking at all. The
 *  microphone's own two-second silence stop lives in the service, not here. */
export const SPEECH_RMS_FLOOR = 0.01;

/** A stretch of speech is never closed off before it is this long, so ordinary
 *  pauses between words do not chop a sentence into fragments. */
export const COMMIT_MIN_SECONDS = 5;

/** …and once it IS that long, this much quiet ends it. Eight tenths of a second
 *  is longer than the gap between words and shorter than a thinking pause. */
export const COMMIT_PAUSE_SECONDS = 0.8;

/** Somebody talking without pausing cannot be re-heard forever: every pass costs
 *  the WHOLE stretch, so a 60-second monologue would cost more than a second per
 *  pass and the words would visibly lag behind the voice. At this length we break
 *  it ourselves — but at the quietest moment we can find, not exactly here. */
export const HARD_CUT_SECONDS = 15;

/** The breathing room between one pass finishing and the next starting. It is a
 *  gap AFTER completion, never a repeating alarm clock — see `scheduleNextPass`. */
export const PASS_GAP_MS = 200;

/** How long a pass over `n` seconds of sound is expected to take, in
 *  milliseconds, on the machine this was measured on.
 *
 *  WHY THIS EXISTS: the parent service needs a number it can hold the worker to.
 *  A worker that crashes is easy to notice; a worker that quietly wedges — the
 *  engine needs 1.14 GB of memory, and a laptop that is short of it will swap
 *  rather than fail — is not, and the symptom is a microphone stuck on
 *  "Finishing…" forever with no error. So this worker announces the length of
 *  every pass before it starts it, the service turns that length into an
 *  expected cost with this function, and a pass that overruns that by a wide
 *  multiple is treated as a dead worker.
 *
 *  Measured 2026-09-05 at 4 threads, real model, real audio: 1s → 44 ms,
 *  6s → 155 ms, 12s → 282 ms, 24s → 563 ms. Between measured points we
 *  interpolate; past the last one we continue at the last measured slope. */
const MEASURED_PASS_COST: ReadonlyArray<readonly [seconds: number, ms: number]> = [
  [1, 44], [6, 155], [12, 282], [24, 563],
];

export function expectedPassMs(segmentSeconds: number): number {
  const table = MEASURED_PASS_COST;
  if (segmentSeconds <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i += 1) {
    const [x0, y0] = table[i - 1];
    const [x1, y1] = table[i];
    if (segmentSeconds <= x1) {
      return y0 + ((segmentSeconds - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  // Longer than anything measured: keep going at the last known rate rather than
  // pretending the curve flattens. (It should never happen — HARD_CUT_SECONDS is
  // 15 — but a number that silently under-estimates would be a false alarm.)
  const [xa, ya] = table[table.length - 2];
  const [xb, yb] = table[table.length - 1];
  return yb + (segmentSeconds - xb) * ((yb - ya) / (xb - xa));
}

// ---------------------------------------------------------------------------
// The messages this worker understands and speaks
// ---------------------------------------------------------------------------

/** Sent to the worker by voice-service.ts. */
export type VoiceWorkerInbound =
  /** Open the microphone session. Sound may arrive before the engine has finished
   *  loading; it is kept and folded into the first pass. */
  | { type: 'start' }
  /** One slice of microphone sound, as raw 16-bit samples. */
  | { type: 'audio'; chunk: ArrayBuffer }
  /** Close the microphone: one last pass, then exactly one `final`. */
  | { type: 'stop' }
  /** Throw everything away and say nothing at all. */
  | { type: 'cancel' };

/** Sent back to voice-service.ts. */
export type VoiceWorkerOutbound =
  /** The engine finished loading and is now hearing whatever was queued. */
  | { type: 'ready' }
  /** Something went wrong. `message` is the engine's or the operating system's
   *  OWN words, forwarded untouched — never a guess (docs/error-message-standards.md).
   *  `stage` says which half failed, because they mean different things to the
   *  user: `load` is "the engine will not start on this computer" (a download to
   *  re-do, a system library to install), while `pass` is "the engine started but
   *  choked on this piece of sound". */
  | { type: 'error'; stage: 'load' | 'pass'; message: string }
  /** "I am starting to re-hear a stretch this many seconds long." THIS is the
   *  acknowledgement the service turns into a deadline (see `expectedPassMs`). */
  | { type: 'pass-begin'; segmentSeconds: number }
  /** "…and that pass took this long." */
  | { type: 'pass-end'; segmentSeconds: number; ms: number }
  /** Live words. `committed` renders solid, `tail` renders grey. */
  | { type: 'partial'; committed: string; tail: string }
  /** The whole utterance. Exactly one of these follows every `stop`. */
  | { type: 'final'; text: string };

// ---------------------------------------------------------------------------
// Small pure helpers — the pieces the tests can check on their own
// ---------------------------------------------------------------------------

/** Turn the renderer's raw 16-bit sound into the -1..1 numbers the engine wants. */
export function int16ToFloat32(chunk: ArrayBuffer): Float32Array {
  const ints = new Int16Array(chunk);
  const out = new Float32Array(ints.length);
  for (let i = 0; i < ints.length; i += 1) out[i] = ints[i] / 32768;
  return out;
}

/** Loudness of one stretch of sound: the "root mean square", which is just the
 *  usual way of averaging a wave that swings equally above and below zero. */
export function rmsOf(samples: Float32Array, from: number, count: number): number {
  let sum = 0;
  const end = Math.min(from + count, samples.length);
  const n = Math.max(1, end - from);
  for (let i = from; i < end; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / n);
}

/** How many seconds of quiet are sitting at the END of the loudness readings. */
export function trailingSilenceSeconds(frames: readonly number[]): number {
  let quiet = 0;
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    if (frames[i] >= SPEECH_RMS_FLOOR) break;
    quiet += 1;
  }
  return quiet / 10;
}

/** Has anybody actually spoken yet? (A microphone that has only ever heard a fan
 *  must not "commit a sentence" made of nothing.) */
export function heardSpeech(frames: readonly number[]): boolean {
  return frames.some((f) => f >= SPEECH_RMS_FLOOR);
}

/** Should this stretch be closed off because the speaker paused? */
export function shouldCommitOnPause(segmentSeconds: number, frames: readonly number[]): boolean {
  if (segmentSeconds <= COMMIT_MIN_SECONDS) return false;
  if (!heardSpeech(frames)) return false;
  return trailingSilenceSeconds(frames) >= COMMIT_PAUSE_SECONDS;
}

/** Where to break a stretch that has gone on too long without a pause.
 *
 *  WHY NOT SIMPLY AT 15 SECONDS: 15 seconds is very likely to land in the middle
 *  of a word, and a word cut in half is heard as two wrong words — the user sees
 *  gibberish appear in solid black text. So we look at the last second of sound,
 *  which we have already measured the loudness of anyway, pick the quietest tenth
 *  of a second in it, and break there. In real speech that is a gap between
 *  words, so the break is invisible. If somebody really has not drawn breath for
 *  a second, we still break at the quietest point available, which is the best
 *  guess anyone can make.
 *
 *  Returns a number of samples: everything before it is closed off. */
export function hardCutSamples(frames: readonly number[], totalSamples: number): number {
  const lookback = Math.min(10, frames.length); // the last second, in frames
  if (lookback === 0) return totalSamples;
  const first = frames.length - lookback;
  let quietest = first;
  for (let i = first; i < frames.length; i += 1) {
    if (frames[i] < frames[quietest]) quietest = i;
  }
  // Break at the END of the quietest tenth of a second, so the silence itself
  // belongs to the stretch being closed and the next stretch opens on speech.
  return Math.min(totalSamples, (quietest + 1) * FRAME_SAMPLES);
}

/** Glue finished stretches back into one piece of text with single spaces. */
export function joinSegments(parts: readonly string[]): string {
  return parts.map((p) => p.trim()).filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Loading the engine
// ---------------------------------------------------------------------------

/** The two objects we need out of sherpa-onnx. Typed loosely on purpose: the
 *  package is not an npm dependency of this app (it is downloaded at runtime into
 *  the user's data folder), so there are no type definitions to import, and a
 *  hand-written interface would be a second, quieter claim about an API we do not
 *  control. */
export interface SherpaModule {
  OfflineRecognizer: {
    createAsync(config: unknown): Promise<{
      createStream(): unknown;
      decodeAsync(stream: unknown): Promise<void>;
      getResult(stream: unknown): { text: string };
    }>;
  };
}

/** Load the downloaded speech engine, by absolute path.
 *
 *  TWO REQUIRES, IN THIS ORDER, AND THAT IS THE WHOLE POINT OF THIS FUNCTION.
 *  The engine is two files sitting side by side: a native library
 *  (`sherpa-onnx.node`, real compiled machine code) and a small JavaScript
 *  wrapper around it. If we only loaded the wrapper, the wrapper's own loader
 *  would catch a native-library failure, throw the real reason away, and print
 *  advice about an environment variable that has nothing to do with how we
 *  install it — so the user would be told to fix something that is not broken.
 *  Loading the native library ourselves FIRST means whatever the operating system
 *  actually said (a missing system library, a wrong architecture, a truncated
 *  download) reaches the user untouched.
 *
 *  Both paths come from voice-pin.ts. Nothing here builds a path.
 *
 *  `requireModule` is injectable only so the tests can exercise the failure
 *  handling without shipping a real 20 MB native library into the test suite. */
export function loadSherpa(
  userDataPath: string,
  requireModule?: (absolutePath: string) => unknown,
): SherpaModule {
  const addon = addonPath(userDataPath);
  const wrapper = wrapperEntryPath(userDataPath);
  // Resolve from the addon's own directory. We only ever pass absolute paths, so
  // the base is irrelevant to resolution — but it must be a real file path,
  // because this file is compiled to CommonJS in production and loaded by a
  // module runner in tests, and those two disagree about what `require` is.
  const req = requireModule ?? createRequire(addon);

  try {
    req(addon);
  } catch (err) {
    // Verbatim. docs/error-message-standards.md: specific and accurate, or
    // general and non-committal — never a hardcoded guess at the cause.
    throw new Error(
      `The speech engine could not be loaded from ${addon}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    return req(wrapper) as SherpaModule;
  } catch (err) {
    throw new Error(
      `The speech engine loaded but its JavaScript half could not be read from ${wrapper}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The recogniser, reduced to the one thing this worker asks of it. */
export interface RecognizerLike {
  /** Hear this stretch of sound from the beginning and return what it says. */
  decode(samples: Float32Array): Promise<string>;
}

/** Build the real recogniser. Async because construction takes about a second,
 *  and the worker must keep accepting sound from the microphone while it waits. */
export async function createRecognizer(userDataPath: string, sherpa: SherpaModule): Promise<RecognizerLike> {
  const models = modelDir(userDataPath);
  const recognizer = await sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: VOICE_SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      // The filenames come from the pin, not from here. voice-pin.ts already
      // names them as what the archive must contain; spelling them twice means a
      // re-pinned model passes every test and then fails at load.
      transducer: {
        encoder: path.join(models, MODEL_FILES.encoder),
        decoder: path.join(models, MODEL_FILES.decoder),
        joiner: path.join(models, MODEL_FILES.joiner),
      },
      tokens: path.join(models, MODEL_FILES.tokens),
      numThreads: 4,
      modelType: 'nemo_transducer',
      debug: 0,
    },
  });
  return {
    async decode(samples: Float32Array): Promise<string> {
      const stream = recognizer.createStream() as {
        acceptWaveform(w: { samples: Float32Array; sampleRate: number }): void;
      };
      stream.acceptWaveform({ samples, sampleRate: VOICE_SAMPLE_RATE });
      await recognizer.decodeAsync(stream);
      return recognizer.getResult(stream).text.trim();
    },
  };
}

// ---------------------------------------------------------------------------
// The re-hear loop
// ---------------------------------------------------------------------------

export interface VoiceWorkerDeps {
  /** Builds the recogniser on first `start`. */
  create: () => Promise<RecognizerLike>;
  /** Sends a message back to the app. */
  send: (message: VoiceWorkerOutbound) => void;
  /** Runs something after a delay. Injected so a test can prove that the ONLY
   *  delay this worker ever asks for is the gap after a completed pass. */
  schedule?: (fn: () => void, ms: number) => void;
  /** The clock, for measuring how long a pass took. */
  now?: () => number;
}

/**
 * Holds the open stretch of sound and drives the re-hear loop.
 *
 * The vocabulary, once:
 *   - a **stretch** (the code says "segment") is the sound since the last time we
 *     decided a sentence had finished;
 *   - **committed** text is every finished stretch, joined — it renders solid;
 *   - the **tail** is whatever has come since the last full stop inside the open
 *     stretch — it renders grey, because the engine may still rewrite it.
 */
export class VoiceWorkerCore {
  private readonly deps: Required<VoiceWorkerDeps>;

  /** The open stretch of sound, and how much of the buffer is really in use. */
  private buffer = new Float32Array(VOICE_SAMPLE_RATE * 20);
  private length = 0;

  /** Loudness of each completed tenth of a second of the open stretch. */
  private frames: number[] = [];
  /** Samples of the tenth-of-a-second currently being filled. */
  private pending: number[] = [];

  /** Finished stretches, in order. */
  private segments: string[] = [];

  private recognizer: RecognizerLike | null = null;
  private loading = false;
  private listening = false;
  private stopping = false;
  private passRunning = false;
  private passScheduled = false;

  /** Bumped by `start` and `cancel`. A pass that finishes after its generation
   *  has moved on says nothing — that is how `cancel` manages to emit nothing at
   *  all even when the engine was mid-sentence. */
  private generation = 0;

  constructor(deps: VoiceWorkerDeps) {
    this.deps = {
      create: deps.create,
      send: deps.send,
      schedule: deps.schedule ?? ((fn, ms) => { setTimeout(fn, ms); }),
      now: deps.now ?? (() => Date.now()),
    };
  }

  handle(message: VoiceWorkerInbound): void {
    switch (message.type) {
      case 'start': this.start(); break;
      case 'audio': this.audio(int16ToFloat32(message.chunk)); break;
      case 'stop': this.stop(); break;
      case 'cancel': this.cancel(); break;
    }
  }

  start(): void {
    this.generation += 1;
    this.reset();
    this.listening = true;
    this.stopping = false;

    if (this.recognizer || this.loading) {
      // Already have (or are building) an engine — sound simply starts piling up.
      this.maybeRunPass();
      return;
    }
    this.loading = true;
    this.deps.create().then(
      (recognizer) => {
        this.loading = false;
        // Fix (whole-branch review F7, and worse than it was filed as): this used
        // to check the generation and hand back without ever assigning, which
        // threw away a minute of loading whenever the user tapped the mic and
        // changed their mind. The real damage was the tap AFTER that one: it saw
        // `loading` still true, returned early to wait for this callback — and
        // this callback, holding the older generation, returned without building
        // anything. Nothing was left to finish the load, so the second dictation
        // sat there until the sixty-second load deadline gave up on it.
        //
        // The engine belongs to no particular turn, so it is kept unconditionally.
        // What the generation decided is only whether anyone is still waiting.
        this.recognizer = recognizer;
        // `ready` goes out whatever happened while we waited: it is what stops
        // the host's sixty-second load clock, which is armed once per worker and
        // not once per turn. Staying quiet here would get a perfectly healthy
        // engine killed a minute later for "not finishing loading".
        this.deps.send({ type: 'ready' });
        if (!this.listening) return; // stopped or cancelled meanwhile — engine kept, nothing to decode
        // Whatever the user said during that first second is already in the
        // buffer and goes into the very first pass. Nothing is dropped.
        this.maybeRunPass();
      },
      (err: unknown) => {
        this.loading = false;
        // Reported unconditionally, for the same reason: the host throws a
        // failed engine away when it hears this, and swallows the message itself
        // if the turn it belonged to is already over. Staying silent left the
        // next tap hanging on a load that had already failed.
        this.deps.send({
          type: 'error',
          stage: 'load',
          message: err instanceof Error ? err.message : String(err),
        });
      },
    );
  }

  /** One slice of microphone sound. */
  audio(samples: Float32Array): void {
    if (!this.listening) return; // stopped or cancelled: the microphone is closed
    this.append(samples);
    this.maybeRunPass();
  }

  stop(): void {
    if (!this.listening && !this.stopping) return;
    this.listening = false;
    this.stopping = true;
    // If a pass is running we cannot start another — the final pass happens the
    // moment that one lands (see `onPassComplete`).
    if (!this.passRunning) this.runFinalPass();
  }

  cancel(): void {
    // Everything goes, and nothing is said. The generation bump is what silences
    // a pass that is already in flight.
    this.generation += 1;
    this.listening = false;
    this.stopping = false;
    this.passScheduled = false;
    this.reset();
  }

  // -- internals ------------------------------------------------------------

  private reset(): void {
    this.length = 0;
    this.frames = [];
    this.pending = [];
    this.segments = [];
  }

  private append(samples: Float32Array): void {
    if (this.length + samples.length > this.buffer.length) {
      const grown = new Float32Array(Math.max(this.buffer.length * 2, this.length + samples.length));
      grown.set(this.buffer.subarray(0, this.length));
      this.buffer = grown;
    }
    this.buffer.set(samples, this.length);
    this.length += samples.length;

    // Roll the loudness readings forward a tenth of a second at a time. The
    // renderer sends roughly that much per message, but nothing here depends on
    // it: a slice of any size lands in the right frames.
    for (let i = 0; i < samples.length; i += 1) {
      this.pending.push(samples[i]);
      if (this.pending.length === FRAME_SAMPLES) {
        const frame = Float32Array.from(this.pending);
        this.frames.push(rmsOf(frame, 0, frame.length));
        this.pending = [];
      }
    }
  }

  /** Throw away the first `count` samples of the open stretch — used when a
   *  stretch is closed off and the leftover sound starts the next one. */
  private dropSamples(count: number): void {
    const keep = Math.max(0, this.length - count);
    this.buffer.copyWithin(0, count, this.length);
    this.length = keep;
    const droppedFrames = Math.floor(count / FRAME_SAMPLES);
    this.frames = this.frames.slice(droppedFrames);
    // And throw away the part-filled frame. WHY it matters: frame k is only at
    // buffer sample k * FRAME_SAMPLES while the two stay in step. Leaving these
    // samples behind put every later frame boundary out by however much of a
    // frame the closed stretch ended mid-way through — so the hard cut landed a
    // tenth of a second late, INSIDE the next word, which is precisely the
    // "a word cut in half is heard as two wrong words" this cut exists to avoid.
    // Measured 2026-09-05: 14.7 s instead of 14.6 s after a non-aligned commit.
    this.pending = [];
  }

  private get openSeconds(): number {
    return this.length / VOICE_SAMPLE_RATE;
  }

  /** Start a pass, if one can start right now. */
  private maybeRunPass(): void {
    if (this.passRunning || this.passScheduled) return;
    if (!this.recognizer) return;          // still loading — the sound waits
    if (!this.listening && !this.stopping) return;
    if (this.length === 0) return;
    if (this.stopping) { this.runFinalPass(); return; }
    this.runPass();
  }

  /** Decide how much of the open stretch this pass should hear, and whether the
   *  stretch is being closed off. */
  private planPass(): { samples: number; closes: boolean } {
    if (shouldCommitOnPause(this.openSeconds, this.frames)) {
      // The speaker stopped. The whole stretch, silence and all, becomes one
      // finished sentence.
      return { samples: this.length, closes: true };
    }
    if (this.openSeconds >= HARD_CUT_SECONDS) {
      return { samples: hardCutSamples(this.frames, this.length), closes: true };
    }
    return { samples: this.length, closes: false };
  }

  private runPass(): void {
    const plan = this.planPass();
    const generation = this.generation;
    const segmentSeconds = plan.samples / VOICE_SAMPLE_RATE;
    // The sound this pass hears is copied out now, so that sound still arriving
    // down the pipe cannot change what the engine is looking at mid-pass.
    const audio = this.buffer.slice(0, plan.samples);

    this.passRunning = true;
    // The acknowledgement the service holds us to. Sent BEFORE the work starts,
    // because its whole purpose is to bound work that may never finish.
    this.deps.send({ type: 'pass-begin', segmentSeconds });
    const started = this.deps.now();

    this.recognizer!.decode(audio).then(
      (text) => this.onPassComplete(generation, plan, segmentSeconds, started, text, null),
      (err: unknown) => this.onPassComplete(generation, plan, segmentSeconds, started, '', err),
    );
  }

  private onPassComplete(
    generation: number,
    plan: { samples: number; closes: boolean },
    segmentSeconds: number,
    started: number,
    text: string,
    err: unknown,
  ): void {
    this.passRunning = false;
    // Cancelled, or a new session started while this pass was in flight: say
    // nothing whatsoever. This is `cancel`'s "emit nothing" promise.
    if (generation !== this.generation) return;

    this.deps.send({ type: 'pass-end', segmentSeconds, ms: this.deps.now() - started });

    if (err) {
      // A pass that throws is the service's problem to turn into one terminal
      // error — the worker reports the engine's own words.
      this.deps.send({
        type: 'error',
        stage: 'pass',
        message: err instanceof Error ? err.message : String(err),
      });
      // AND it really does stop the loop now. Without this the next `audio`
      // message walked straight back into a pass that throws again, so a
      // permanently broken engine sent one error per chunk for as long as the
      // microphone stayed open — the comment above used to claim otherwise.
      this.listening = false;
      // A `stop` was already waiting on this pass. `stop()` declines to run the
      // final pass while one is in flight, so returning here parked the worker
      // forever: the composer sat on "Finishing…" and every sentence the user had
      // already watched turn black died with the session, because emitFinal is the
      // only thing that reads them. The service is owed exactly one terminal event
      // — answer with the words we have. Found reviewing T4, 2026-09-05.
      if (this.stopping) this.emitFinal();
      return;
    }

    if (plan.closes) {
      // This stretch is finished: its words move into the solid text for good,
      // and the sound that arrived after the break starts the next stretch.
      this.segments.push(text.trim());
      this.dropSamples(plan.samples);
      this.deps.send({ type: 'partial', committed: joinSegments(this.segments), tail: '' });
    } else {
      // THE grey/solid rule, and the only implementation of it — imported, never
      // re-written here (shared/voice-types.ts).
      const split = splitAtLastSentenceEnd(text);
      this.deps.send({
        type: 'partial',
        committed: joinSegments([...this.segments, split.committed]),
        tail: split.tail,
      });
    }

    this.scheduleNextPass();
  }

  /** WHY THIS IS NOT A TIMER. If passes were started by a repeating clock, then
   *  on a slow machine — or simply on a long sentence, where a pass costs half a
   *  second — the alarms would arrive faster than the work finishes and pile up
   *  on top of each other until the worker drowned. Chaining instead means there
   *  is never more than one pass in flight, on any machine, and the loop
   *  naturally slows down exactly as much as the machine needs it to. */
  private scheduleNextPass(): void {
    if (this.stopping) { this.runFinalPass(); return; }
    if (!this.listening) return;
    this.passScheduled = true;
    const generation = this.generation;
    this.deps.schedule(() => {
      this.passScheduled = false;
      if (generation !== this.generation) return;
      this.maybeRunPass();
    }, PASS_GAP_MS);
  }

  /** The last pass, after `stop`: hear whatever is left, then say the whole thing
   *  once. Exactly one `final` per `stop` — never zero (the box would listen
   *  forever) and never two (the words would be pasted twice). */
  private runFinalPass(): void {
    this.stopping = false;
    if (!this.recognizer || this.length === 0) {
      this.emitFinal();
      return;
    }
    const generation = this.generation;
    const samples = this.length;
    const segmentSeconds = samples / VOICE_SAMPLE_RATE;
    const audio = this.buffer.slice(0, samples);
    this.passRunning = true;
    this.deps.send({ type: 'pass-begin', segmentSeconds });
    const started = this.deps.now();

    this.recognizer.decode(audio).then(
      (text) => {
        this.passRunning = false;
        if (generation !== this.generation) return;
        this.deps.send({ type: 'pass-end', segmentSeconds, ms: this.deps.now() - started });
        this.segments.push(text.trim());
        this.emitFinal();
      },
      (err: unknown) => {
        this.passRunning = false;
        if (generation !== this.generation) return;
        this.deps.send({ type: 'pass-end', segmentSeconds, ms: this.deps.now() - started });
        // Even a failed last pass still answers: the service is owed exactly one
        // terminal event, and the words heard before the failure are real.
        this.deps.send({
          type: 'error',
          stage: 'pass',
          message: err instanceof Error ? err.message : String(err),
        });
        this.emitFinal();
      },
    );
  }

  private emitFinal(): void {
    const text = joinSegments(this.segments);
    this.generation += 1; // nothing from the closed session may speak again
    this.listening = false;
    this.stopping = false;
    this.passScheduled = false;
    this.reset();
    this.deps.send({ type: 'final', text });
  }
}

// ---------------------------------------------------------------------------
// The process itself
// ---------------------------------------------------------------------------

/** Wire a core up to Electron's parent-process pipe. Exported (rather than run at
 *  the bottom of this file unconditionally) so that importing this module in a
 *  test does not try to talk to a parent that is not there. */
export function runWorker(userDataPath: string, port: {
  on(event: 'message', cb: (e: { data: VoiceWorkerInbound }) => void): void;
  postMessage(message: VoiceWorkerOutbound): void;
}): VoiceWorkerCore {
  const core = new VoiceWorkerCore({
    create: async () => createRecognizer(userDataPath, loadSherpa(userDataPath)),
    send: (message) => port.postMessage(message),
  });
  port.on('message', (e) => core.handle(e.data));
  return core;
}

// Electron's utilityProcess gives the forked file a `parentPort`. Nothing else
// does, which is exactly the test for "am I really running as the worker?".
const parentPort = (process as unknown as { parentPort?: Parameters<typeof runWorker>[1] }).parentPort;
if (parentPort) {
  // The app's data folder, handed down as the first argument because a forked
  // process cannot ask Electron for it.
  runWorker(process.argv[2], parentPort);
}
