// The re-hear loop — what the speech worker does while somebody is talking.
//
// What this file defends, in plain words:
//   1. THE GREY TEXT RULE HAS ONE IMPLEMENTATION. The worker imports it from the
//      shared file; it does not keep a second copy that could drift.
//   2. A stretch of speech is only closed off after a real pause, and only once
//      it is long enough to be worth closing.
//   3. When somebody talks on and on without pausing, the worker breaks the
//      stretch at the quietest moment it can find — between words — instead of
//      at a fixed stopwatch time that would land mid-word.
//   4. Solid text accumulates. Finished sentences are never dropped and never
//      repeated as the next sentence is being heard.
//   5. Only ONE pass ever runs at a time, and the next one is chained to the last
//      one FINISHING — never fired by a repeating clock, which on a slow machine
//      would pile passes on top of each other until the worker drowned.
//   6. Stopping says the whole utterance exactly once. Cancelling says nothing.
//
// And the case none of the above could catch on its own: ONE test is driven by
// REAL RECORDED ENGINE OUTPUT (tests/fixtures/parakeet-rehear-ladder.json). A
// hand-written fake recogniser always improves tidily — each answer extends the
// last — so it can never reproduce the thing this whole rule exists to contain:
// the real engine going back and rewriting words it has already said.
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { splitAtLastSentenceEnd } from '../src/shared/voice-types';
import {
  VoiceWorkerCore,
  type RecognizerLike,
  type VoiceWorkerOutbound,
  VOICE_SAMPLE_RATE,
  FRAME_SAMPLES,
  SPEECH_RMS_FLOOR,
  PASS_GAP_MS,
  HARD_CUT_SECONDS,
  expectedPassMs,
  hardCutSamples,
  shouldCommitOnPause,
  trailingSilenceSeconds,
  joinSegments,
  int16ToFloat32,
} from '../src/main/voice/voice-worker';

const LADDER = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'parakeet-rehear-ladder.json'), 'utf8'),
) as { passes: Array<{ seconds: number; text: string }> };

// --- little helpers --------------------------------------------------------

/** `seconds` of sound at a steady loudness. A constant amplitude has exactly
 *  that amplitude as its RMS, so "loud" and "quiet" here are unambiguous. */
function sound(seconds: number, amplitude: number): Float32Array {
  const a = new Float32Array(Math.round(seconds * VOICE_SAMPLE_RATE));
  a.fill(amplitude);
  return a;
}
const LOUD = 0.2;
const QUIET = SPEECH_RMS_FLOOR / 10;

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** Let every already-resolved promise run. */
const flush = () => new Promise((r) => { setImmediate(r); });

/** A stand-in recogniser whose answer is chosen by how much sound it was given,
 *  plus a hard guarantee that it is never asked two questions at once. */
function makeHarness(answer: (seconds: number, call: number) => string) {
  const sent: VoiceWorkerOutbound[] = [];
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  const decodeLengths: number[] = [];
  let inFlight = false;
  let overlapped = false;
  let calls = 0;

  const recognizer: RecognizerLike = {
    async decode(samples) {
      if (inFlight) overlapped = true;
      inFlight = true;
      decodeLengths.push(samples.length / VOICE_SAMPLE_RATE);
      const text = answer(samples.length / VOICE_SAMPLE_RATE, calls);
      calls += 1;
      await Promise.resolve();
      inFlight = false;
      return text;
    },
  };

  let clock = 0;
  const core = new VoiceWorkerCore({
    create: async () => recognizer,
    send: (m) => { sent.push(m); },
    schedule: (fn, ms) => { scheduled.push({ fn, ms }); },
    now: () => { clock += 10; return clock; },
  });

  return {
    core,
    sent,
    scheduled,
    decodeLengths,
    /** True if the loop ever asked the engine two questions at the same time. */
    overlapped: () => overlapped,
    /** Run the one pending "next pass" callback, if there is one. */
    runScheduled() {
      const next = scheduled.shift();
      if (next) next.fn();
    },
    partials: () => sent.flatMap((m) => (m.type === 'partial' ? [{ committed: m.committed, tail: m.tail }] : [])),
    finals: () => sent.flatMap((m) => (m.type === 'final' ? [{ text: m.text }] : [])),
    passBegins: () => sent.flatMap((m) => (m.type === 'pass-begin' ? [m.segmentSeconds] : [])),
  };
}

async function ready(h: ReturnType<typeof makeHarness>) {
  h.core.start();
  await flush();
}

// ---------------------------------------------------------------------------

describe('the grey/solid rule has exactly one implementation', () => {
  it('the worker imports the shared helper and keeps no copy of the rule', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'main', 'voice', 'voice-worker.ts'),
      'utf8',
    );
    expect(source).toContain("import { splitAtLastSentenceEnd } from '../../shared/voice-types'");
    // A second implementation would have to look for sentence marks itself. If
    // this ever fails, the fix is to delete the copy, not to loosen the check:
    // two implementations of one promise is how the composer and the phone came
    // to disagree about what is grey.
    expect(source).not.toMatch(/===\s*'[.?!]'/);
  });
});

describe('when a stretch of speech is closed off', () => {
  it('is never closed before five seconds, however long the pause', () => {
    const frames = new Array(39).fill(LOUD);
    frames.push(...new Array(10).fill(QUIET)); // a full second of quiet
    expect(shouldCommitOnPause(4.9, frames)).toBe(false);
    // …and the boundary itself: "past five seconds", not "five seconds".
    expect(shouldCommitOnPause(5, [...new Array(40).fill(LOUD), ...new Array(10).fill(QUIET)])).toBe(false);
  });

  it('is closed once past five seconds and the speaker has paused for 0.8 s', () => {
    const frames = [...new Array(52).fill(LOUD), ...new Array(8).fill(QUIET)];
    expect(trailingSilenceSeconds(frames)).toBeCloseTo(0.8);
    expect(shouldCommitOnPause(6, frames)).toBe(true);
  });

  it('is not closed by a shorter pause — an ordinary gap between words', () => {
    const frames = [...new Array(53).fill(LOUD), ...new Array(7).fill(QUIET)];
    expect(shouldCommitOnPause(6, frames)).toBe(false);
  });

  it('is never closed when nobody has spoken at all (a room, a fan)', () => {
    expect(shouldCommitOnPause(9, new Array(90).fill(QUIET))).toBe(false);
  });
});

describe('breaking a long stretch that has no pause in it', () => {
  it('breaks at the quietest tenth of a second in the last second, not at the stopwatch', () => {
    const frames = new Array(150).fill(LOUD);
    frames[145] = QUIET; // the one gap between words
    const total = 150 * FRAME_SAMPLES;
    const cut = hardCutSamples(frames, total);
    expect(cut).toBe(146 * FRAME_SAMPLES);
    expect(cut).toBeLessThan(total); // i.e. NOT simply "everything so far"
  });

  it('never breaks on a loud frame while any quiet one is available', () => {
    const frames = new Array(150).fill(LOUD);
    frames[143] = SPEECH_RMS_FLOOR / 2;
    const cutFrame = hardCutSamples(frames, 150 * FRAME_SAMPLES) / FRAME_SAMPLES - 1;
    expect(frames[cutFrame]).toBeLessThan(SPEECH_RMS_FLOOR);
  });

  it('still breaks somewhere when the whole last second is loud', () => {
    const frames = new Array(150).fill(LOUD);
    frames[147] = LOUD / 2; // merely quieter, still above the floor
    expect(hardCutSamples(frames, 150 * FRAME_SAMPLES)).toBe(148 * FRAME_SAMPLES);
  });
});

describe('the cost the worker promises the app', () => {
  it('reproduces the four measured points', () => {
    expect(expectedPassMs(1)).toBeCloseTo(44);
    expect(expectedPassMs(6)).toBeCloseTo(155);
    expect(expectedPassMs(12)).toBeCloseTo(282);
    expect(expectedPassMs(24)).toBeCloseTo(563);
  });

  it('grows with the length of the stretch, so a longer sentence gets more time', () => {
    expect(expectedPassMs(9)).toBeGreaterThan(expectedPassMs(3));
    expect(expectedPassMs(30)).toBeGreaterThan(expectedPassMs(24));
  });
});

describe('sound that arrives before the engine has finished loading', () => {
  it('waits and goes into the very first pass instead of being dropped', async () => {
    const sent: VoiceWorkerOutbound[] = [];
    const decodeLengths: number[] = [];
    let release: (r: RecognizerLike) => void = () => {};
    const core = new VoiceWorkerCore({
      create: () => new Promise<RecognizerLike>((r) => { release = r; }),
      send: (m) => { sent.push(m); },
      schedule: () => {},
    });

    core.start();
    core.audio(sound(1, LOUD));
    core.audio(sound(1, LOUD));
    await flush();
    expect(decodeLengths).toEqual([]); // nothing heard yet — the engine is loading

    release({
      async decode(samples) { decodeLengths.push(samples.length / VOICE_SAMPLE_RATE); return 'two seconds'; },
    });
    await flush();
    await flush();

    expect(sent.some((m) => m.type === 'ready')).toBe(true);
    expect(decodeLengths).toEqual([2]); // both seconds, in one pass
  });
});

describe('changing your mind while the engine is still loading', () => {
  // Guards whole-branch review F7. Loading the speech model takes about a minute
  // the first time. Tapping the mic and immediately tapping it off used to throw
  // that whole minute away — and, worse, left the NEXT tap waiting on a load that
  // nothing would ever finish, so it sat there until the sixty-second give-up
  // clock. From the user's side: dictation simply did not start the second time.
  it('keeps the loaded engine and lets the next tap use it', async () => {
    const sent: VoiceWorkerOutbound[] = [];
    const decodeLengths: number[] = [];
    let release: (r: RecognizerLike) => void = () => {};
    let creates = 0;
    const core = new VoiceWorkerCore({
      create: () => { creates += 1; return new Promise<RecognizerLike>((r) => { release = r; }); },
      send: (m) => { sent.push(m); },
      schedule: () => {},
    });

    // Tap on, tap straight back off — before the engine is anywhere near ready.
    core.start();
    core.stop();
    await flush();

    // The engine finishes loading with nobody waiting for it.
    release({
      async decode(samples) { decodeLengths.push(samples.length / VOICE_SAMPLE_RATE); return 'heard'; },
    });
    await flush();

    // The host is told the engine is up even though nobody is waiting — that
    // message is what stops its sixty-second load clock.
    expect(sent.filter((m) => m.type === 'ready').length).toBe(1);

    // Tap on again. This must work, and must not pay for another load.
    core.start();
    core.audio(sound(1, LOUD));
    await flush();
    await flush();

    expect(creates).toBe(1);              // the minute was not spent twice
    expect(decodeLengths).toEqual([1]);   // and the second turn actually hears something
  });

  it('reports a load that failed to whoever is waiting now', async () => {
    const sent: VoiceWorkerOutbound[] = [];
    let reject: (e: Error) => void = () => {};
    const core = new VoiceWorkerCore({
      create: () => new Promise<RecognizerLike>((_r, j) => { reject = j; }),
      send: (m) => { sent.push(m); },
      schedule: () => {},
    });

    core.start();
    core.stop();
    await flush();
    core.start();                       // second tap, still waiting on the same load
    reject(new Error('sherpa-onnx.node: file too short'));
    await flush();

    const err = sent.find((m) => m.type === 'error');
    expect(err).toBeDefined();
    // The real reason, not a guess — and it reaches the person who is waiting.
    expect(JSON.stringify(err)).toContain('file too short');
  });
});

describe('the loop itself', () => {
  it('never runs two passes at once, however fast sound arrives', async () => {
    const h = makeHarness(() => 'words');
    await ready(h);
    for (let i = 0; i < 20; i += 1) h.core.audio(sound(0.1, LOUD));
    await flush();
    expect(h.overlapped()).toBe(false);
    expect(h.decodeLengths.length).toBe(1);
  });

  it('asks for the next pass only when the last one has finished, and only for the 200 ms gap', async () => {
    const h = makeHarness(() => 'words');
    await ready(h);
    h.core.audio(sound(1, LOUD));
    expect(h.scheduled.length).toBe(0); // nothing is queued while the pass runs
    await flush();
    expect(h.scheduled.map((s) => s.ms)).toEqual([PASS_GAP_MS]);

    h.runScheduled();
    await flush();
    expect(h.scheduled.map((s) => s.ms)).toEqual([PASS_GAP_MS]);
    // One delay asked for per completed pass — never a repeating alarm.
    expect(h.decodeLengths.length).toBe(2);
  });

  it('accepts raw 16-bit sound from the microphone', async () => {
    const h = makeHarness(() => 'words');
    await ready(h);
    const ints = new Int16Array(VOICE_SAMPLE_RATE);
    ints.fill(6553); // ≈ 0.2 once scaled
    expect(int16ToFloat32(ints.buffer)[0]).toBeCloseTo(0.2, 2);
    h.core.handle({ type: 'audio', chunk: ints.buffer });
    await flush();
    expect(h.decodeLengths).toEqual([1]);
  });

  it('announces the length of every pass before starting it', async () => {
    const h = makeHarness(() => 'words');
    await ready(h);
    h.core.audio(sound(2, LOUD));
    expect(h.passBegins()).toEqual([2]);
    await flush();
    expect(h.sent.some((m) => m.type === 'pass-end' && m.segmentSeconds === 2)).toBe(true);
  });
});

describe('solid text accumulates across sentences', () => {
  it('keeps a finished sentence and adds the next one behind it', async () => {
    const h = makeHarness((seconds, call) => (call === 0 ? 'Hello there.' : 'next words'));
    await ready(h);

    // Six seconds of speech, then a pause long enough to end the sentence.
    h.core.audio(concat(sound(6, LOUD), sound(0.9, QUIET)));
    await flush();
    expect(h.partials()[0]).toEqual({ committed: 'Hello there.', tail: '' });

    // Now more speech: the finished sentence stays solid, the new words are grey.
    h.runScheduled();
    h.core.audio(sound(2, LOUD));
    await flush();
    expect(h.partials()[1]).toEqual({ committed: 'Hello there.', tail: 'next words' });
    // …and the closed sentence's sound is gone, so it is never re-heard.
    expect(h.decodeLengths[1]).toBe(2);
  });

  it('keeps EVERY finished sentence, not just the most recent one', async () => {
    // Two sentences have to be finished before this can fail — with only one, a
    // worker that threw the old sentence away would look identical. (It did look
    // identical: the first version of the test above passed against exactly that
    // bug, which is why this one exists.)
    // The fourth answer is the last pass after `stop`, which re-hears the open
    // stretch one final time — and, as the real engine does, finishes the
    // sentence off with a full stop it had not written yet.
    const said = ['First.', 'Second.', 'third bit', 'third bit, finished.'];
    const h = makeHarness((seconds, call) => said[call] ?? '');
    await ready(h);

    h.core.audio(concat(sound(6, LOUD), sound(0.9, QUIET)));
    await flush();
    h.runScheduled();
    h.core.audio(concat(sound(6, LOUD), sound(0.9, QUIET)));
    await flush();
    h.runScheduled();
    h.core.audio(sound(2, LOUD));
    await flush();

    expect(h.partials()).toEqual([
      { committed: 'First.', tail: '' },
      { committed: 'First. Second.', tail: '' },
      { committed: 'First. Second.', tail: 'third bit' },
    ]);

    h.core.stop();
    await flush();
    expect(h.finals()).toEqual([{ text: 'First. Second. third bit, finished.' }]);
  });

  it('breaks a fifteen-second monologue at a gap between words', async () => {
    const h = makeHarness(() => 'a very long sentence without a pause in it');
    await ready(h);
    // 15 s of unbroken speech with one gap 0.5 s from the end.
    const long = concat(sound(14.5, LOUD), sound(0.1, QUIET), sound(0.4, LOUD));
    h.core.audio(long);
    const begin = h.passBegins()[0];
    expect(begin).toBeLessThan(HARD_CUT_SECONDS); // not the stopwatch
    expect(begin).toBeCloseTo(14.6, 5);           // the quiet gap
    await flush();
    expect(h.partials()[0].tail).toBe('');
    // The 0.4 s after the gap is still open, and starts the next sentence.
    h.runScheduled();
    await flush();
    expect(h.decodeLengths[1]).toBeCloseTo(0.4, 5);
  });
});

describe('stopping and cancelling', () => {
  it('stop says the whole utterance exactly once', async () => {
    const h = makeHarness((seconds, call) => (call === 0 ? 'First sentence.' : 'and the rest'));
    await ready(h);
    h.core.audio(concat(sound(6, LOUD), sound(0.9, QUIET)));
    await flush();
    h.runScheduled();
    h.core.audio(sound(2, LOUD));
    await flush();

    h.core.stop();
    await flush();
    expect(h.finals()).toEqual([{ text: 'First sentence. and the rest' }]);
  });

  it('stop still answers once when nothing at all was heard', async () => {
    const h = makeHarness(() => '');
    await ready(h);
    h.core.stop();
    await flush();
    expect(h.finals()).toEqual([{ text: '' }]);
  });

  it('cancel says nothing at all, even mid-sentence', async () => {
    const h = makeHarness(() => 'half a sentence');
    await ready(h);
    h.core.audio(sound(2, LOUD));
    h.core.cancel();
    await flush();
    h.runScheduled();
    await flush();
    expect(h.finals()).toEqual([]);
    expect(h.partials()).toEqual([]);
  });
});

describe('when the engine itself fails', () => {
  it('reports the engine\'s own words and says which half failed', async () => {
    const sent: VoiceWorkerOutbound[] = [];
    const core = new VoiceWorkerCore({
      create: async () => ({ decode: async () => { throw new Error('onnxruntime ran out of memory'); } }),
      send: (m) => { sent.push(m); },
      schedule: () => {},
    });
    core.start();
    await flush();
    core.audio(sound(1, LOUD));
    await flush();
    // Verbatim, and labelled as the pass rather than the load — the two mean
    // different things to somebody trying to fix it.
    expect(sent).toContainEqual({ type: 'error', stage: 'pass', message: 'onnxruntime ran out of memory' });
  });

  // WHY: `stop()` declines to run the final pass while one is already in flight,
  // so a pass that threw at that exact moment used to park the worker forever —
  // the composer sat on "Finishing…" and every sentence the user had already
  // watched turn black died with the session. Found reviewing T4, 2026-09-05.
  it('a stop waiting on a pass that fails still returns the words already settled', async () => {
    let fail = false;
    const said = ['The first sentence.', 'more words'];
    const h = makeHarness((seconds, call) => {
      if (fail) throw new Error('onnxruntime ran out of memory');
      return said[call] ?? '';
    });
    await ready(h);

    // One good pass closes a sentence, so there is something to lose.
    h.core.audio(concat(sound(6, LOUD), sound(0.9, QUIET)));
    await flush();
    h.runScheduled();
    expect(h.partials()[0]).toEqual({ committed: 'The first sentence.', tail: '' });

    // Now the engine breaks while a pass is in flight and the user taps Stop.
    fail = true;
    h.core.audio(sound(2, LOUD));
    const inFlight = flush();
    h.core.stop();
    await inFlight;
    await flush();

    const finals = h.sent.filter((m) => m.type === 'final');
    expect(finals).toHaveLength(1);
    expect((finals[0] as { text: string }).text).toContain('The first sentence.');
  });

  // WHY: the comment said a throwing pass stops the loop; it did not, so the next
  // chunk of audio walked back into a pass that threw again — one error per chunk
  // for as long as the microphone stayed open.
  it('a broken engine reports once, not once per chunk of sound', async () => {
    const h = makeHarness(() => { throw new Error('engine is gone'); });
    await ready(h);
    h.core.audio(sound(1, LOUD));
    await flush();
    h.core.audio(sound(1, LOUD));
    await flush();
    h.core.audio(sound(1, LOUD));
    await flush();
    expect(h.sent.filter((m) => m.type === 'error')).toHaveLength(1);
  });

  it('reports a failure to start the engine as a LOAD failure, in its own words', async () => {
    const sent: VoiceWorkerOutbound[] = [];
    const core = new VoiceWorkerCore({
      create: async () => { throw new Error('/home/x/voice/runtime/package/sherpa-onnx.node: file too short'); },
      send: (m) => { sent.push(m); },
      schedule: () => {},
    });
    core.start();
    await flush();
    expect(sent).toEqual([{
      type: 'error',
      stage: 'load',
      message: '/home/x/voice/runtime/package/sherpa-onnx.node: file too short',
    }]);
  });
});

// ---------------------------------------------------------------------------
// The real engine
// ---------------------------------------------------------------------------

describe('a REAL recorded Parakeet ladder', () => {
  it('is real: it contains the rewriting a scripted fake can never produce', () => {
    const texts = LADDER.passes.map((p) => p.text);
    // Pass 2 → pass 3: the engine goes back and puts a comma three words behind
    // where it had already got to, and changes a word it had already said.
    expect(texts[1]).toBe('And so my fellow American');
    expect(texts[2]).toBe('And so, my fellow Americans.');
    expect(texts[2].startsWith(texts[1])).toBe(false);

    // And at least one pass RETRACTS a full stop it had already written, which is
    // the case that decides whether "solid text never changes" is even sayable.
    const retracts = texts.some((t, i) =>
      i > 0
      && splitAtLastSentenceEnd(texts[i - 1]).committed.length > 0
      && splitAtLastSentenceEnd(t).committed.length < splitAtLastSentenceEnd(texts[i - 1]).committed.length);
    expect(retracts).toBe(true);
  });

  it('splits every recorded pass exactly as the composer will render it', () => {
    // This is the pin. Each row is what the user would actually see at that
    // second: the solid half, then the grey half. Read it and you have read the
    // feature. Note seconds 4 and 10: the solid text SHRINKS, because the engine
    // took back a full stop. That is measured behaviour, not a bug in the split —
    // see voice-types.ts, which refuses to promise otherwise.
    const expected: Array<[number, string, string]> = [
      [1, '', 'And so'],
      [2, '', 'And so my fellow American'],
      [3, 'And so, my fellow Americans.', ''],
      [4, '', 'And so, my fellow Americans ask'],
      [5, '', 'And so, my fellow Americans, ask not'],
      [6, '', 'And so, my fellow Americans, ask not what your'],
      [7, 'And so, my fellow Americans, ask not what your country can do for you.', ''],
      [8, 'And so, my fellow Americans, ask not what your country can do for you.', ''],
      [9, 'And so, my fellow Americans, ask not what your country can do for you. Ask what you can do.', ''],
      [10, 'And so, my fellow Americans, ask not what your country can do for you.', 'Ask what you can do for your'],
      [11, 'And so, my fellow Americans, ask not what your country can do for you. Ask what you can do for your country.', ''],
    ];
    const actual = LADDER.passes.map((p) => {
      const s = splitAtLastSentenceEnd(p.text);
      return [p.seconds, s.committed, s.tail];
    });
    expect(actual).toEqual(expected);
  });

  it('runs through the worker and finishes with the whole utterance', async () => {
    const byLength = new Map(LADDER.passes.map((p) => [p.seconds, p.text]));
    const h = makeHarness((seconds) => byLength.get(Math.round(seconds)) ?? '');
    await ready(h);

    for (let n = 1; n <= LADDER.passes.length; n += 1) {
      h.core.audio(sound(1, LOUD));
      h.runScheduled();
      await flush();
    }

    const seen = h.partials();
    expect(seen.length).toBe(LADDER.passes.length);
    expect(seen[seen.length - 1]).toEqual({
      committed: LADDER.passes[LADDER.passes.length - 1].text,
      tail: '',
    });

    h.core.stop();
    await flush();
    expect(h.finals()).toEqual([{ text: LADDER.passes[LADDER.passes.length - 1].text }]);
  });

  it('shows why a fixed two-word grey tail was not enough', () => {
    // The rule this feature ALMOST shipped was "the newest two words are grey".
    // Against the same recording it leaks a rewrite into solid black text, which
    // is what forced the rule to become "everything since your last full stop".
    const twoWordTail = (t: string) => t.trim().split(/\s+/).slice(0, -2).join(' ');
    const texts = LADDER.passes.map((p) => p.text);
    const leaks = texts.some((t, i) => i > 0 && !t.startsWith(twoWordTail(texts[i - 1])));
    expect(leaks).toBe(true);
  });
});

describe('joining finished sentences', () => {
  it('uses single spaces and ignores empty stretches', () => {
    expect(joinSegments(['One.', '', '  Two.  ', 'Three.'])).toBe('One. Two. Three.');
  });
});
