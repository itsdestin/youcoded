// Voice prompting — the contract every surface of `window.claude.voice` agrees on
// (desktop preload, remote-shim, Android SessionService, and the workbench fake).
//
// Decided on the 2026-09-05 questions deck (docs/active/design/2026-09-05-voice-prompting/):
// words appear while you talk (Q-2), the mic is tap-to-start with a silence
// stop (Q-3), the text waits in the box (Q-4), the first tap offers the one-time
// download (Q-5), Android uses the phone's own recogniser (Q-6). The engine is
// Parakeet TDT 0.6B v3 through sherpa-onnx (Destin, after the bench:
// docs/active/investigations/2026-09-05-local-speech-engines.md).

/** Whether the mic can listen right now, and if not, what stands in the way. */
export type VoiceReadiness =
  | { state: 'ready'; engine: string }
  /** The speech model is not on this computer yet.
   *
   *  `sizeMb` is the real number the download side knows — the size of the
   *  archive it is about to fetch. **The first-run card does not print it.**
   *  The reopen deck (V-10) settled that copy as a literal sentence (now
   *  "about 650 MB"), because a number that shifts by a few MB every time the engine
   *  pin moves reads as a precision nobody asked for, and because the card is
   *  read once, before anything has been measured. The field stays because the
   *  downloader genuinely has the number (progress is derived from it) — it is
   *  an intended field, not dead weight, which is also what stops `knip` from
   *  reporting it. If a surface wants to tell the user how big the download is,
   *  it prints the sentence; it must not print this number, or the card and the
   *  fake will say two different things. */
  | { state: 'needs-download'; engine: string; sizeMb: number }
  | { state: 'downloading'; engine: string; sizeMb: number; percent: number }
  /** Downloaded, now being unpacked into place — roughly the last minute before
   *  `ready`. This is a real card state, not just a type member: without it the
   *  progress card would vanish for the whole unpack and the app would look
   *  finished (or stuck) while it is still working. No percentage exists here,
   *  because unpacking reports no progress worth believing — the card shows a
   *  moving, unmeasured bar. Android never produces this state. */
  | { state: 'unpacking'; engine: string }
  /** A SPECIFIC reason (no microphone, permission denied, unsupported platform) —
   *  never a guess, per docs/error-message-standards.md. */
  | { state: 'unavailable'; reason: string };

/** Pushed by the host while the mic is open (and for readiness changes at any time).
 *
 *  **The event contract, in two sentences.** `cancel` emits nothing at all — no
 *  `final`, no `error` — because cancelling means the words are thrown away and
 *  whatever the user had typed stays untouched. `stop` emits exactly one
 *  `final`, never zero and never two, even when nothing was heard (the text is
 *  then the empty string) — that one event is what returns the composer to idle,
 *  so a missing one leaves the box listening forever and a second one would
 *  paste the utterance twice. */
export type VoiceEvent =
  | { type: 'readiness'; readiness: VoiceReadiness }
  /** Microphone loudness 0..1, several times a second — drives the little meter. */
  | { type: 'level'; value: number }
  /** Live words, split by `splitAtLastSentenceEnd` below: `committed` is
   *  everything up to and including the last sentence-ending mark, `tail` is
   *  what has come since (rendered grey in the composer).
   *
   *  `committed` is NOT "will not change again" — that claim was here until
   *  2026-09-05 and it is false of this engine. Parakeet re-hears the whole open
   *  segment on every pass and can rewrite any of it, including words it has
   *  already said. What IS true: only a *completed sentence* is treated as
   *  settled, and once a segment is committed and a new one starts, the older
   *  text no longer moves. Grey means "still being reconsidered". */
  | { type: 'partial'; committed: string; tail: string }
  /** The mic closed (tap, silence, or stop) and this is the whole utterance. */
  | { type: 'final'; text: string }
  /** "Still working on it" — pushed while a speech pass is running.
   *
   *  The renderer's watchdog arms when these STOP arriving, not on a fixed
   *  deadline from `start`: one pass over a long utterance legitimately takes
   *  seconds, so a plain timer either fires on healthy speech or is set so long
   *  it never protects anyone. No payload — the fact that it arrived is the
   *  whole message. */
  | { type: 'heartbeat' }
  | { type: 'error'; message: string };

/** What the user is told when the computer itself refuses the microphone.
 *
 *  WHY it lives HERE and not beside either user: main throws it (macOS, when the
 *  system prompt is declined) and the renderer compares against it to decide which
 *  card to show. It used to be a constant in main and a hand-typed copy in the
 *  renderer, with a comment claiming the two "cannot drift" and nothing whatsoever
 *  making that true. One copy, imported twice. */
export const MIC_REFUSED_SENTENCE =
  "Microphone access was refused by your computer. Allow it for YouCoded in your system's privacy settings, then check again.";

export interface VoiceBridge {
  status: () => Promise<VoiceReadiness>;
  /** Fetch the speech model; progress arrives as `readiness` events. */
  download: () => Promise<void>;
  start: () => Promise<void>;
  /** Close the mic and deliver `final`. */
  stop: () => Promise<void>;
  /** Close the mic and discard everything heard. */
  cancel: () => Promise<void>;
  /** One 100 ms slice of microphone audio, DESKTOP ONLY.
   *
   *  `chunk` is the raw Int16 samples the audio worklet produced (16 kHz, mono),
   *  and `rms` is that same slice's loudness, computed in the worklet and sent
   *  in the same message so nothing has to be measured twice. The loudness
   *  travels all the way to main because main owns the silence stop — two
   *  seconds below the floor after speech closes the mic. The worker does NOT
   *  reuse this number for its hard cut: it needs per-frame energy inside the
   *  slice (the quietest 100 ms frame in the last second), which one figure per
   *  slice cannot carry, so it recomputes energy itself from the samples.
   *
   *  **Optional on purpose.** Android omits it (the phone's own recogniser owns
   *  the microphone) and so does the remote browser shim, so every caller tests
   *  `typeof bridge.sendAudio === 'function'` rather than assuming it. */
  sendAudio?: (chunk: ArrayBuffer, rms: number) => void;
  /** What the operating system says about microphone permission, DESKTOP ONLY.
   *
   *  Answers on macOS and on Windows (whose global privacy switch otherwise
   *  looks exactly like "this computer has no microphone"). **Optional for the
   *  same reason as `sendAudio`**: on Android the Activity's permission launcher
   *  owns this question and `status()` is authoritative, so the renderer
   *  composes readiness only where this member is present. */
  micAccess?: () => Promise<'granted' | 'denied' | 'not-determined' | 'unknown'>;
  onEvent: (cb: (e: VoiceEvent) => void) => () => void;
}

/** THE grey/solid rule — one implementation, imported by everything that needs it
 *  (the worker's pass result, the workbench fake). Android re-implements it in
 *  Kotlin against the same table of examples, because a phone's recogniser hands
 *  over whole strings and never calls into this file.
 *
 *  The rule: everything up to and including the LAST sentence-ending mark
 *  (`.`, `?`, `!`) is `committed` and renders solid; whatever follows it is
 *  `tail` and renders grey, because this engine may still rewrite it.
 *
 *  - No mark anywhere → everything is `tail` (nothing is settled yet).
 *  - A mark at the very end → everything is `committed`, `tail` is empty.
 *  - Whitespace around the cut is trimmed off both halves; the composer inserts
 *    the single separating space itself when it joins them back together.
 *
 *  **Abbreviations and decimals are deliberately NOT special-cased.** "Dr." and
 *  "$2.30" split like any other full stop. That is on purpose: we split on the
 *  punctuation the ENGINE wrote, and a list of exceptions would be a second,
 *  quieter model of English that disagrees with the first one — at worst a word
 *  or two turns solid a moment early, which is invisible next to the words that
 *  are still arriving.
 *
 *  One consequence of the trim: if the engine writes no space after a mark
 *  ("today.Then"), what you see while talking is normalised to "today. Then", and
 *  the finished text can shift by that one character when it lands. Cosmetic, and
 *  better than showing a run-on with no space. */
export function splitAtLastSentenceEnd(text: string): { committed: string; tail: string } {
  let cut = -1;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === '.' || ch === '?' || ch === '!') { cut = i; break; }
  }
  if (cut < 0) return { committed: '', tail: text.trim() };
  return { committed: text.slice(0, cut + 1).trim(), tail: text.slice(cut + 1).trim() };
}
