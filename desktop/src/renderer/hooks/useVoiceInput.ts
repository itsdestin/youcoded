// Voice prompting — the composer's view of `window.claude.voice`.
//
// One hook owns the mic's phase (idle → listening → finishing → idle), the
// readiness the host reports (ready / needs-download / downloading / unpacking /
// unavailable), the loudness meter and the elapsed seconds. Live words are
// handed straight to the caller through `onPartial` / `onFinal` so the input
// bar can merge them into its own draft — the hook never holds text itself,
// which is what keeps "what is in the box" a single source of truth.
//
// `supported` is false when the host exposes no `voice` namespace at all
// (older desktop builds, the remote browser client — deck Q-7 keeps the mic off
// it until remote access is encrypted). The input bar then renders no mic.
//
// On a COMPUTER this hook also opens the microphone itself (voice-capture.ts)
// and works out whether the machine can listen at all. On a PHONE it does
// neither: Android's own recogniser owns the microphone, so `start()` is the
// one call to the phone and nothing here goes looking for hardware.
import { useCallback, useEffect, useRef, useState } from 'react';
import { MIC_REFUSED_SENTENCE } from '../../shared/voice-types';
import type { VoiceEvent, VoiceReadiness } from '../../shared/voice-types';
import { isWorkbenchDocument } from '../workbench-mode';
import { meterLevel, open as openCapture, probe as probeMic, type CaptureHandle } from '../voice-capture';

export type VoicePhase = 'idle' | 'listening' | 'finishing';

interface Options {
  onPartial: (committed: string, tail: string) => void;
  onFinal: (text: string) => void;
}

// The three sentences the user can be shown when the microphone will not open.
// Written out here rather than assembled from pieces, so there is exactly one
// place to read what he sees. Per docs/error-message-standards.md: each one is
// either specific and true, or general and honest about not knowing.
// Imported, not retyped: main throws this exact sentence when macOS's own prompt is
// declined, and the code below compares against it to pick the right card.
const REASON_REFUSED = MIC_REFUSED_SENTENCE;
const REASON_NO_DEVICE = 'No microphone was found on this computer.';
const REASON_GENERAL = 'Voice could not open a microphone.';

// How long the composer waits for a sign of life from the speech engine before
// it gives up. WHY it is not simply "how long a reply may take": one pass over a
// long sentence honestly takes several seconds, so a fixed deadline from the
// moment you stop talking either fires on perfectly healthy speech or is set so
// long it protects nobody. The host pushes a `heartbeat` while it is working;
// this clock is restarted by every one of them, so it only ever runs out when
// the engine has genuinely gone quiet.
const WATCHDOG_MS = 12_000;

function describe(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Electron wraps everything a main-process handler throws as
  // "Error invoking remote method 'voice:start': Error: <the real sentence>".
  // Nothing else in the app strips it, so without this the user reads our careful
  // sentence with a line of plumbing bolted to the front. Found reviewing T5,
  // 2026-09-05.
  return raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}

/** Turn a failure to open the microphone into words for the "check again" card. */
function captureFailureReadiness(err: unknown): VoiceReadiness {
  const name = err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError') return { state: 'unavailable', reason: REASON_REFUSED };
  if (name === 'NotFoundError') return { state: 'unavailable', reason: REASON_NO_DEVICE };
  // Everything else: say the general thing, and put the machine's OWN words
  // underneath it rather than guessing at a cause. A Linux box with no sound
  // daemon lands here, and the real error is the only clue anyone will get.
  return { state: 'unavailable', reason: `${REASON_GENERAL}\n${name || 'Error'}: ${describe(err)}` };
}

export function useVoiceInput({ onPartial, onFinal }: Options) {
  // Captured ONCE at mount, not read every render: the workbench's compare
  // panes mount three composers against three different fakes in one page,
  // and each must keep the bridge it was born with.
  const [bridge] = useState(() => (typeof window !== 'undefined' ? window.claude?.voice : undefined));

  // "Is this a computer whose microphone WE open?"
  //
  // Two halves, and both are needed.
  //
  // 1. The bridge offers `sendAudio`/`micAccess`. Android and the remote browser
  //    client leave both out, so their absence is how the phone says "I own the
  //    microphone, don't touch it". Without this test the phone's WebView would
  //    be asked for audio, silently refuse, and show the user a sentence about
  //    "your computer" and "system privacy settings" — advice a phone cannot act on.
  //
  // 2. It is not the UI Workbench. The workbench's fake now offers BOTH members
  //    on purpose (it stands in for the desktop), so the first test alone is
  //    true there — and a design review would open a real Chrome microphone
  //    permission prompt over the mock-up, or, in the headless screenshot rig
  //    (a machine with no microphone at all), report "No microphone was found on
  //    this computer." across every review shot. The workbench identifies itself
  //    by its URL. `isWorkbenchDocument()` — NOT `isWorkbenchMode()`, which is
  //    compiled out of a production build and would leave this gate wide open in
  //    the landing page's live demo, the one build a stranger can click.
  const [canCapture] = useState(
    () => !!bridge && typeof bridge.sendAudio === 'function' && typeof bridge.micAccess === 'function' && !isWorkbenchDocument(),
  );

  const [readiness, setReadiness] = useState<VoiceReadiness | null>(null);
  // What THIS computer's hardware says, when it disagrees with the model folder.
  // A machine with the speech model downloaded still cannot listen if the
  // microphone is unplugged or the operating system said no, so this verdict
  // wins over whatever the host reported. Null means "nothing in the way".
  const [micBlock, setMicBlock] = useState<VoiceReadiness | null>(null);
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Callbacks and phase live in refs so the single onEvent subscription below
  // never has to be torn down and re-made as the input bar re-renders.
  const cbRef = useRef({ onPartial, onFinal });
  cbRef.current = { onPartial, onFinal };
  const phaseRef = useRef<VoicePhase>('idle');
  const setPhaseBoth = useCallback((p: VoicePhase) => { phaseRef.current = p; setPhase(p); }, []);
  // A start is in flight: the microphone is opening but the strip is not up yet.
  // Blocks a second tap from opening a second microphone during that gap.
  const startingRef = useRef(false);
  // Fix (whole-branch review F1): let go of the walkie-talkie DURING that gap
  // and the mic used to open with nobody holding the key. `stop`/`cancel` both
  // hand back immediately unless the phase says the mic is up, and the phase
  // only says so at the very END of `start` — after the host call that on macOS
  // waits on the system's permission dialog. So a key-up landed on nothing, and
  // `start` then opened the microphone anyway. In a quiet room nothing closed
  // it: the two-second silence stop only arms once speech has been heard. This
  // flag is the message a release leaves behind for a start still in flight.
  const abortStartRef = useRef(false);
  const captureRef = useRef<CaptureHandle | null>(null);
  const watchdogRef = useRef<number | null>(null);
  // Set when the watchdog gave up. It is what lets a `final` that arrives LATE
  // still put the user's words in the box: the engine finished after we had
  // stopped waiting, and throwing away words we actually have would be worse
  // than the delay was.
  const watchdogFiredRef = useRef(false);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current !== null) { window.clearTimeout(watchdogRef.current); watchdogRef.current = null; }
  }, []);

  const closeCapture = useCallback(() => {
    captureRef.current?.close();
    captureRef.current = null;
  }, []);

  /** Close the microphone the way a STOP should: last words first.
   *
   *  Fix (Destin, 2026-09-05: "the last bit of whatever I said doesn't get
   *  transcribed when I let go"). `close()` stops the hardware, then nulls the
   *  message handler — which discards the worklet's part-filled bucket, every
   *  slice already posted and not yet handled, and whatever was still inside the
   *  browser's own microphone pipeline. All three are the END of the sentence,
   *  which is exactly the part that went missing. A cancel still uses the blunt
   *  close: nothing is being kept, so there is nothing to wait for. */
  const finishCapture = useCallback((): Promise<void> | null => {
    const cap = captureRef.current;
    if (!cap) return null;   // a phone: Android owns the microphone, nothing here to drain
    captureRef.current = null;
    return cap.finish();
  }, []);

  const armWatchdog = useCallback(() => {
    // Only where heartbeats exist. A phone's recogniser sends none, so arming
    // this there would end a perfectly good silent pause with an error.
    if (!canCapture) return;
    clearWatchdog();
    watchdogRef.current = window.setTimeout(() => {
      watchdogRef.current = null;
      watchdogFiredRef.current = true;
      closeCapture();
      setPhaseBoth('idle');
      setLevel(0);
      // Tell the host too. Without this it keeps the session open and refuses the
      // NEXT tap with "already listening in this window" — about a window where
      // nothing is listening — so one watchdog fire used to break the mic until
      // the app restarted. (Its own deadline may still deliver a late `final`,
      // which is why this cancels and continues rather than tearing down.)
      void bridge?.cancel().catch(() => {});
      // Specific and true: this is exactly what we observed, and nothing more.
      setError(`Voice stopped responding — nothing came back for ${Math.round(WATCHDOG_MS / 1000)} seconds. The microphone was closed.`);
    }, WATCHDOG_MS);
  }, [bridge, canCapture, clearWatchdog, closeCapture, setPhaseBoth]);

  // One place every event is handled, whether it came from the host or from our
  // own microphone. The loudness meter runs through here too — see `start()`.
  const handleEvent = useCallback((e: VoiceEvent) => {
    const idle = phaseRef.current === 'idle' && !startingRef.current;
    switch (e.type) {
      case 'readiness':
        setReadiness(e.readiness);
        break;
      case 'level':
        // Dropped while idle: a stray level after the mic closed would leave the
        // ring glowing around a microphone that is off.
        if (!idle) setLevel(e.value);
        break;
      case 'heartbeat':
        // Dropped while idle for the same reason `level` is: the host goes on
        // heartbeating through a session this side has already abandoned, and an
        // armed clock with nobody listening puts an error card on screen out of
        // nowhere, every twelve seconds, forever.
        if (idle) break;
        armWatchdog();
        break;
      case 'partial':
        if (idle) break;
        // A partial is proof of life too, not just the heartbeat.
        armWatchdog();
        cbRef.current.onPartial(e.committed, e.tail);
        break;
      case 'final':
        if (idle && !watchdogFiredRef.current) break;
        // The late case: we had already given up and shown an error. The words
        // arrived anyway, so clear the error and deliver them.
        if (watchdogFiredRef.current) { watchdogFiredRef.current = false; setError(null); }
        clearWatchdog();
        closeCapture();
        setPhaseBoth('idle');
        setLevel(0);
        cbRef.current.onFinal(e.text);
        break;
      case 'error':
        clearWatchdog();
        closeCapture();
        watchdogFiredRef.current = false;
        setPhaseBoth('idle');
        setLevel(0);
        setError(e.message);
        break;
    }
  }, [armWatchdog, clearWatchdog, closeCapture, setPhaseBoth]);

  // Ask this computer whether it can listen at all, and let that answer beat the
  // host's. Desktop only — on a phone `status()` is the whole truth.
  const probeMicBlock = useCallback(async (): Promise<VoiceReadiness | null> => {
    if (!canCapture || !bridge?.micAccess) return null;
    const { hasAudioInput, access } = await probeMic(bridge.micAccess);
    if (access === 'denied') return { state: 'unavailable', reason: REASON_REFUSED };
    if (!hasAudioInput) return { state: 'unavailable', reason: REASON_NO_DEVICE };
    return null;
  }, [bridge, canCapture]);

  useEffect(() => {
    if (!bridge) return;
    let live = true;
    bridge.status().then((r) => { if (live) setReadiness(r); }).catch((err) => { if (live) setError(describe(err)); });
    probeMicBlock().then((b) => { if (live) setMicBlock(b); }).catch(() => { /* unknown: let the host's answer stand */ });
    const off = bridge.onEvent(handleEvent);
    return () => { live = false; off(); };
  }, [bridge, handleEvent, probeMicBlock]);

  // Nothing may outlive the component: an unmounted composer with an open
  // microphone is a recording light nobody can turn off.
  useEffect(() => () => { clearWatchdog(); closeCapture(); }, [clearWatchdog, closeCapture]);

  // Elapsed time while listening — the one number that tells you the mic is
  // still open when you have paused to think.
  useEffect(() => {
    if (phase !== 'listening') { setSeconds(0); return; }
    const t0 = Date.now();
    const id = window.setInterval(() => setSeconds(Math.floor((Date.now() - t0) / 1000)), 500);
    return () => window.clearInterval(id);
  }, [phase]);

  const start = useCallback(async () => {
    if (!bridge || phaseRef.current !== 'idle' || startingRef.current) return;
    startingRef.current = true;
    abortStartRef.current = false;
    setError(null);
    watchdogFiredRef.current = false;
    try {
      try {
        // The host goes first even on a computer: on macOS `voice:start` is what
        // raises the operating system's permission prompt, and asking for audio
        // before that prompt has been answered is how a Mac kills the app instead
        // of asking.
        await bridge.start();
      } catch (err) {
        const reason = describe(err);
        // A REFUSAL is not a breakage: it belongs on the "check again" card, with
        // the button that lets the user come back after changing their settings —
        // not on the "voice stopped" card, whose only action is OK. This is the
        // flow the contract row actually describes (first tap → the system's own
        // prompt → decline), and it used to land on the wrong card entirely, so
        // the Check again button appeared only on some LATER look.
        if (reason === MIC_REFUSED_SENTENCE) {
          setMicBlock({ state: 'unavailable', reason });
          return;
        }
        setError(reason);
        return;
      }

      // Released already? Then never open the microphone at all. On a phone the
      // host call above IS the microphone, so this undoes that too.
      if (abortStartRef.current) { try { await bridge.cancel(); } catch { /* the host is already idle */ } return; }

      // On a PHONE this is where it ends: the bridge call IS the microphone.
      // Nothing here opens one, and nothing here judges whether the phone has one.
      if (canCapture) {
        try {
          captureRef.current = await openCapture((chunk, rms) => {
            // The samples and their loudness go to the main process together —
            // the "two quiet seconds closes the mic" rule is decided there, from
            // the untouched number.
            bridge.sendAudio?.(chunk, rms);
            // The meter is driven from HERE rather than waiting for the host to
            // send a level back, so the ring answers the user's voice
            // immediately instead of a round trip later.
            handleEvent({ type: 'level', value: meterLevel(rms) });
          });
        } catch (err) {
          // The microphone would not open. Undo the host's start (a cancel says
          // nothing back, by contract) and show the "check again" card — NOT the
          // "voice stopped" card, which is for a mic that worked and then died.
          try { await bridge.cancel(); } catch { /* the host is already idle */ }
          setMicBlock(captureFailureReadiness(err));
          return;
        }
      }

      // Released while the microphone itself was opening: close the one we just
      // opened rather than announcing it.
      if (abortStartRef.current) {
        closeCapture();
        try { await bridge.cancel(); } catch { /* the host is already idle */ }
        return;
      }

      // Only now: the strip says "Listening" when something is actually listening.
      setPhaseBoth('listening');
      // NOT armed here. This clock measures "the engine went quiet AFTER answering",
      // so it can only start once something has answered. Arming it at `start` made
      // it a load timer instead — and at twelve seconds it was five times shorter
      // than the minute the host allows for loading the speech model, so the first
      // dictation after an idle unload, on a perfectly healthy machine, ended in
      // "Voice stopped responding". The host's own load deadline covers a start
      // that never answers at all; this one covers a start that stops answering.
    } finally {
      startingRef.current = false;
    }
  }, [armWatchdog, bridge, canCapture, handleEvent, setPhaseBoth]);

  const stop = useCallback(async () => {
    // A release that lands mid-start leaves its mark instead of falling through
    // the guard below (review F1). There is nothing to transcribe — the mic was
    // never open — so the start unwinds as a cancel.
    if (startingRef.current) { abortStartRef.current = true; return; }
    if (!bridge || phaseRef.current !== 'listening') return;
    // The strip says "Finishing" the instant he asks — the wait below is a fifth
    // of a second and happens behind that, so nothing about it is visible except
    // the words that used to go missing now being there.
    setPhaseBoth('finishing');
    setLevel(0);
    const draining = finishCapture();
    if (draining) await draining;
    // Not armed here either, for the same reason: the last pass is variable-length
    // and the host defends its own deadline against it. If the engine is alive it
    // is heartbeating, and a heartbeat arms this.
    try { await bridge.stop(); } catch (err) { clearWatchdog(); setPhaseBoth('idle'); setError(describe(err)); }
  }, [armWatchdog, bridge, clearWatchdog, finishCapture, setPhaseBoth]);

  const cancel = useCallback(async () => {
    if (startingRef.current) { abortStartRef.current = true; return; }
    if (!bridge || phaseRef.current === 'idle') return;
    clearWatchdog();
    closeCapture();
    watchdogFiredRef.current = false;
    setPhaseBoth('idle'); setLevel(0);
    try { await bridge.cancel(); } catch (err) { setError(describe(err)); }
  }, [bridge, clearWatchdog, closeCapture, setPhaseBoth]);

  const download = useCallback(async () => {
    if (!bridge) return;
    setError(null);
    try { await bridge.download(); } catch (err) { setError(describe(err)); }
  }, [bridge]);

  const recheck = useCallback(async () => {
    if (!bridge) return;
    setError(null);
    try {
      // Both halves again: he may have plugged a microphone in, or allowed it in
      // the system settings, since the last look.
      setMicBlock(await probeMicBlock());
      setReadiness(await bridge.status());
    } catch (err) { setError(describe(err)); }
  }, [bridge, probeMicBlock]);

  const clearError = useCallback(() => setError(null), []);

  return {
    supported: !!bridge,
    // The hardware's verdict beats the model folder's: "ready" means nothing on
    // a computer whose microphone is unplugged or switched off.
    readiness: micBlock ?? readiness,
    phase, level, seconds, error, start, stop, cancel, download, recheck, clearError,
  };
}
