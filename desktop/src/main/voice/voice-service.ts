// Voice prompting, second half: the state machine the composer mirrors.
//
// WHAT THIS FILE IS FOR, in plain words. When you tap the microphone, three
// separate things have to agree with each other: the little strip above the box
// that says "Listening", a speech engine running in its own program, and the
// microphone itself. This file is the referee. It is the only place that knows
// whether the mic is open, whose window opened it, and whether the engine is
// still answering.
//
// THE ONE PROMISE IT KEEPS: **exactly one ending per start.** Every tap of the
// mic finishes in precisely one of two ways — one `final` event carrying your
// words, or one `error` event saying what went wrong — and never in zero
// (which leaves the box listening forever with the send button disabled) and
// never in two (which pastes your sentence in twice). `cancel` is the deliberate
// third case: it ends the session and emits NOTHING, because cancelling means
// the words are thrown away.
//
// The seven ways a session can end, all funnelled through `emitTerminal`:
//   1. you stop it            -> the engine's last pass -> one `final`
//   2. you cancel it          -> nothing at all
//   3. the engine crashes     -> one `error` (its exit code + its last words)
//   4. the engine won't load  -> one `error` (the loader's own message)
//   5. a pass throws          -> one `error` (the engine's own message)
//   6. your window is closed  -> the session ends, nothing is sent (no window)
//   7. the engine WEDGES      -> one `error`, after a deadline we can defend
//
// Number 7 is the one that has been lost twice. A "still working" heartbeat
// cannot catch it, because the heartbeat is pushed from THIS file's own belief
// that a pass is running — a speech engine that swaps to disk and stops
// answering never exits, never throws, and never stops the heartbeat, so the mic
// sits disabled forever. So the engine ACKNOWLEDGES each pass with the length of
// audio it is about to chew on, and we hold it to a deadline derived from the
// measured cost of that much audio. See PASS_* below.
import { MIC_REFUSED_SENTENCE } from '../../shared/voice-types';
export { MIC_REFUSED_SENTENCE };
import { expectedPassMs } from './voice-worker';
import * as path from 'path';
import type { VoiceEvent, VoiceReadiness } from '../../shared/voice-types';
import type { InstalledVoiceAssets, VoiceAssetProgress } from './voice-assets';
import type { VoiceWorkerInbound, VoiceWorkerOutbound } from './voice-worker';
import {
  VOICE_ENGINE_LABEL, pickRuntime, unsupportedReason, totalDownloadBytes,
} from './voice-pin';

// ── The message protocol with voice-worker.ts ────────────────────────────────
// ONE OWNER, not two copies. The shapes live in voice-worker.ts (the process
// that speaks them) and are imported here as TYPES ONLY, which the compiler
// erases — so this file never actually loads the speech engine's module, but a
// change to either side that the other does not follow becomes a build error
// instead of a microphone that silently does nothing.
//
// In words, the conversation is: the worker is forked with the app's data
// folder as its only argument and finds the engine itself. We say `start`, then
// `audio` ten times a second, then `stop` (one last pass, then exactly one
// `final`) or `cancel` (nothing at all). It says `ready` when the engine is
// loaded, `pass-begin` with the LENGTH OF AUDIO it is about to re-hear — the
// number the wedged-engine deadline below is derived from — then `pass-end`,
// then `partial` with the live words, and `error` with its own words verbatim.

/** What the service says to the worker. */
export type VoiceServiceToWorker = VoiceWorkerInbound;
/** What the worker says back. */
export type VoiceWorkerToService = VoiceWorkerOutbound;

/** The worker as this file needs to see it. A real one is an Electron
 *  `utilityProcess`; the tests hand in a fake, which is the only way to
 *  exercise "the engine wedged" without shipping a wedged engine. */
export interface VoiceWorkerHandle {
  send(msg: VoiceServiceToWorker): void;
  kill(): void;
  onMessage(cb: (m: VoiceWorkerToService) => void): void;
  onExit(cb: (code: number | null) => void): void;
  /** Every line the worker printed to stderr. We keep only the last one, to
   *  quote it verbatim if we have to kill the worker. */
  onStderr(cb: (line: string) => void): void;
}

/** The slice of `VoiceAssets` this file uses. Narrow on purpose: the tests
 *  supply four lines instead of a real downloader. */
export interface VoiceAssetsApi {
  installed(): InstalledVoiceAssets | null;
  install(onProgress: (p: VoiceAssetProgress) => void): Promise<InstalledVoiceAssets>;
}

export interface VoiceServiceDeps {
  /** Push one event to one window. Never broadcast: the mic belongs to the
   *  window that opened it, and a second window must not see its words. */
  deliver(webContentsId: number, event: VoiceEvent): void;
  /** Is that window still there? A closed window is not an error, so we simply
   *  stop talking to it. */
  isWindowAlive(webContentsId: number): boolean;
  /** Call `cb` if that window goes away; returns an unsubscribe. */
  onWindowGone(webContentsId: number, cb: () => void): () => void;
  /** Start the speech engine's own program. */
  spawnWorker(): VoiceWorkerHandle;
  assets: VoiceAssetsApi;
  /** Overridable only so a test can pretend to be on macOS/Windows-on-ARM. */
  platform?: NodeJS.Platform | string;
  arch?: string;
}

// ── The numbers, and where they come from ────────────────────────────────────

/** Loudness (0..1) at or above which we call it speech. Below it, the room. */
export const SPEECH_RMS_FLOOR = 0.02;
/** Quiet for this long AFTER you have spoken closes the mic. Deck answer Q-3. */
export const SILENCE_STOP_MS = 2_000;

// How long ONE pass over `seconds` of audio should take. IMPORTED, not
// re-derived: the worker owns this curve because the worker is what was measured,
// and this file used to carry a second straight-line version of it that disagreed
// by five times at one second of audio. Two numbers for one fact is how a deadline
// ends up defending something nobody measured. Found reviewing T4, 2026-09-05.
/** How much slower than the bench a real laptop is allowed to be before we call
 *  the engine wedged. Twenty times is deliberately enormous: this deadline
 *  exists to catch an engine that has stopped answering AT ALL (swapped to
 *  disk, deadlocked), not to police a slow computer. */
const PASS_SLOWNESS_ALLOWANCE = 20;
/** ...and never shorter than this, so a tiny pass on a busy machine is safe. */
const PASS_DEADLINE_FLOOR_MS = 8_000;
/** Loading the recogniser measured ~0.9 s here and is slower on a weak laptop;
 *  a minute is "it is never coming". */
const LOAD_DEADLINE_MS = 60_000;
/** After you tap Stop, your words have to come back. */
const STOP_DEADLINE_MS = 20_000;
/** "Still working on it", while a pass runs. The renderer's watchdog arms when
 *  these STOP arriving, so they must be frequent enough to be missed quickly. */
const HEARTBEAT_MS = 500;
/** One loaded recogniser is 1.14 GB of memory. Ten idle minutes and it goes. */
const IDLE_UNLOAD_MS = 10 * 60 * 1000;

/** WHY this sentence is a constant: it is the exact wording Destin approved on
 *  the V-8 deck, and it appears in two places (here, when macOS refuses, and in
 *  the renderer, when the browser layer refuses). Two copies that drift would
 *  show the user two different explanations of the same refusal. */

/** The deadline for one pass over `seconds` of audio. Exported so the test can
 *  assert against the same number the service uses rather than a copy of it. */
export function passDeadlineMs(seconds: number): number {
  return Math.max(PASS_DEADLINE_FLOOR_MS, expectedPassMs(seconds) * PASS_SLOWNESS_ALLOWANCE);
}

interface Session {
  webContentsId: number;
  /** True once this session's single ending has been used up — by an emitted
   *  `final`/`error`, or by a `cancel`, which uses it up and emits nothing. */
  terminated: boolean;
  /** Set after Stop: the mic is shut and we are waiting for the last words. */
  finishing: boolean;
  /** The silence stop only arms AFTER the user has actually said something,
   *  so a mic opened in a quiet room does not close itself instantly. */
  speechHeard: boolean;
  lastLoudAt: number;
  unwatchWindow: () => void;
}

export class VoiceService {
  private session: Session | null = null;
  private worker: VoiceWorkerHandle | null = null;
  /** The last non-empty line the worker printed. Quoted verbatim when we have
   *  to report a crash or a kill — it is the only true thing we have. */
  private lastStderr: string | null = null;

  private loadTimer: ReturnType<typeof setTimeout> | null = null;
  private passTimer: ReturnType<typeof setTimeout> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  /** In-flight download, so pressing Download twice does not start two. */
  private downloading: Promise<void> | null = null;
  /** What the card should say while a download is running. `status()` returns
   *  it so a window that opens mid-download sees the bar, not the offer. */
  private downloadState: VoiceReadiness | null = null;

  constructor(private deps: VoiceServiceDeps) {}

  private get platform(): NodeJS.Platform | string { return this.deps.platform ?? process.platform; }
  private get arch(): string { return this.deps.arch ?? process.arch; }

  // ── What the composer asks ────────────────────────────────────────────────

  /** Can the mic listen right now, and if not, what stands in the way? */
  status(): VoiceReadiness {
    const unsupported = unsupportedReason(this.platform, this.arch);
    // Windows-on-ARM has no published speech runtime at all. Say that, rather
    // than offering a download that could never succeed.
    if (unsupported) return { state: 'unavailable', reason: unsupported };
    if (this.downloadState) return this.downloadState;
    if (this.deps.assets.installed()) return { state: 'ready', engine: VOICE_ENGINE_LABEL };
    return { state: 'needs-download', engine: VOICE_ENGINE_LABEL, sizeMb: this.downloadSizeMb() };
  }

  /** Fetch the engine. Progress reaches the card as `readiness` events; a
   *  failure comes back as a rejected promise carrying the REAL reason, which
   *  is what the card's Retry branch prints. Two calls share one download. */
  download(webContentsId: number): Promise<void> {
    if (this.downloading) return this.downloading;
    const run = (async () => {
      try {
        await this.deps.assets.install((p) => {
          const readiness = this.readinessForProgress(p);
          if (!readiness) return;
          // `downloading`/`unpacking` are held so a second window asking
          // status() mid-download sees the same bar. `ready` clears it.
          this.downloadState = readiness.state === 'ready' ? null : readiness;
          this.push(webContentsId, { type: 'readiness', readiness });
        });
      } catch (e) {
        // The card goes back to its offer, and the reason travels on the
        // rejection instead — verbatim, never a guess about the network.
        this.downloadState = null;
        this.push(webContentsId, { type: 'readiness', readiness: this.status() });
        throw e;
      } finally {
        this.downloading = null;
      }
    })();
    this.downloading = run;
    return run;
  }

  /** Open the mic for one window. Refuses, with a real reason, when the engine
   *  is not installed or when another window is already listening. */
  async start(webContentsId: number): Promise<void> {
    if (this.session) {
      // WHY refuse rather than steal: two windows sharing one microphone would
      // put half of your sentence in the wrong text box.
      const sameWindow = this.session.webContentsId === webContentsId;
      throw new Error(sameWindow
        ? 'Voice typing is already listening in this window.'
        : 'Voice typing is already listening in another YouCoded window. Stop it there first.');
    }
    const unsupported = unsupportedReason(this.platform, this.arch);
    if (unsupported) throw new Error(unsupported);

    if (!this.deps.assets.installed()) {
      throw new Error('The speech engine has not been downloaded to this computer yet.');
    }

    this.clearIdleUnload();
    this.ensureWorker();

    const now = Date.now();
    this.session = {
      webContentsId,
      terminated: false,
      finishing: false,
      speechHeard: false,
      lastLoudAt: now,
      // A window that closes mid-sentence must not leave a microphone open and
      // a 1.14 GB recogniser resident.
      unwatchWindow: this.deps.onWindowGone(webContentsId, () => this.onWindowGone(webContentsId)),
    };
    this.worker?.send({ type: 'start' });
  }

  /** Close the mic and deliver exactly one `final`. */
  stop(): void {
    const s = this.session;
    if (!s || s.terminated || s.finishing) return;
    s.finishing = true;
    if (!this.worker) {
      // No engine at all: the contract still owes the composer one `final`, or
      // the box would listen forever. Empty text is the honest answer.
      this.emitTerminal({ type: 'final', text: '' });
      return;
    }
    this.worker.send({ type: 'stop' });
    this.armStopDeadline();
  }

  /** Close the mic and throw everything away. Emits nothing, by contract. */
  cancel(): void {
    const s = this.session;
    if (!s) return;
    // Uses up the session's one ending WITHOUT sending anything, which is what
    // makes a later worker `exit` or a late `final` silent instead of a second
    // ending.
    s.terminated = true;
    this.worker?.send({ type: 'cancel' });
    this.endSession();
  }

  /** One 100 ms slice of microphone audio, plus the loudness the worklet
   *  already measured for it. The loudness is why this number travels all the
   *  way to the main process: the two-second silence stop lives here. */
  pushAudio(webContentsId: number, chunk: ArrayBuffer, rms: number): void {
    const s = this.session;
    if (!s || s.terminated || s.finishing) return;
    // Audio from a window that does not own the session is dropped rather than
    // mixed in — otherwise a stale worklet in a second window would put its
    // room noise into your sentence.
    if (s.webContentsId !== webContentsId) return;

    this.worker?.send({ type: 'audio', chunk });

    const now = Date.now();
    if (rms >= SPEECH_RMS_FLOOR) {
      s.speechHeard = true;
      s.lastLoudAt = now;
      return;
    }
    // WHY the check rides on arriving audio instead of a timer: slices arrive
    // every 100 ms while the mic is open, so this is checked ten times a
    // second for free — and if they STOP arriving the mic is already gone,
    // which is the renderer's watchdog's problem, not a silence.
    if (s.speechHeard && now - s.lastLoudAt >= SILENCE_STOP_MS) this.stop();
  }

  /** Quit. Kills the engine's program so it cannot outlive the app. */
  shutdown(): void {
    this.cancel();
    this.unloadWorker();
    this.clearIdleUnload();
  }

  // ── The worker ────────────────────────────────────────────────────────────

  private ensureWorker(): void {
    if (this.worker) return;
    const w = this.deps.spawnWorker();
    this.worker = w;
    this.lastStderr = null;
    // Every callback checks that the worker which spoke is still OUR worker.
    // WHY: a killed engine's `exit` can arrive after the user has tapped the mic
    // again. Without this check the dead worker's exit ended the NEW session with
    // "the speech engine closed unexpectedly" — an invented cause for a process we
    // killed on purpose — and set `this.worker = null` while the new engine was
    // alive, orphaning it: stop and cancel then reached nothing and the next tap
    // spawned a THIRD 1.14 GB engine. The stderr line matters for the same reason:
    // a dead worker could otherwise put its last words in a live one's error.
    // Found reviewing T5, 2026-09-05.
    w.onMessage((m) => { if (this.worker === w) this.onWorkerMessage(m); });
    w.onExit((code) => { if (this.worker === w) this.onWorkerExit(code); });
    w.onStderr((line) => {
      if (this.worker !== w) return;
      const trimmed = line.trim();
      if (trimmed) this.lastStderr = trimmed;
    });
    // Nothing is sent to load the engine: the worker is forked with the app's
    // data folder and finds the engine there itself, which keeps the on-disk
    // layout owned by one file (voice-pin.ts) instead of travelling in messages.
    this.loadTimer = setTimeout(() => {
      this.killWedged('the speech engine did not finish loading within 60 seconds');
    }, LOAD_DEADLINE_MS);
  }

  private onWorkerMessage(m: VoiceWorkerToService): void {
    switch (m.type) {
      case 'ready':
        // The recogniser exists; the load clock stops. Queued audio is already
        // draining inside the worker, so there is nothing else to do here.
        this.clearTimer('load');
        return;
      case 'pass-begin':
        this.beginPass(m.segmentSeconds);
        return;
      case 'pass-end':
        // The engine answered within its budget. Stop the clock and stop saying
        // "still working" — the composer's own watchdog arms on that silence.
        this.endPass();
        return;
      case 'partial':
        if (this.session && !this.session.terminated) {
          this.push(this.session.webContentsId, {
            type: 'partial', committed: m.committed, tail: m.tail,
          });
        }
        return;
      case 'final':
        this.endPass();
        this.clearTimer('stop');
        this.emitTerminal({ type: 'final', text: m.text });
        return;
      case 'error':
        this.endPass();
        this.clearTimer('load');
        this.clearTimer('stop');
        this.emitTerminal({ type: 'error', message: m.message });
        // WHY only a LOAD failure throws the engine away: an engine that never
        // started will not start on the next tap either, and keeping it around
        // would make the second attempt fail silently instead of loudly. An
        // engine that choked on one stretch of sound is still a working engine,
        // and reloading it would cost the user a gigabyte of work for nothing.
        if (m.stage === 'load') this.unloadWorker();
        return;
    }
  }

  private onWorkerExit(code: number | null): void {
    this.clearTimer('load');
    this.clearTimer('stop');
    this.endPass();
    this.worker = null;
    // Say what actually happened. The exit code and the engine's own last line
    // are the only two facts we have, so those are the only two we print.
    const parts = [`Voice stopped: the speech engine closed unexpectedly (exit code ${code ?? 'unknown'}).`];
    if (this.lastStderr) parts.push(`Its last message was: ${this.lastStderr}`);
    this.emitTerminal({ type: 'error', message: parts.join(' ') });
  }

  /** The engine acknowledged a pass. Start saying "still working", and start
   *  the clock it now has to beat. */
  private beginPass(seconds: number): void {
    this.endPass();
    const deadline = passDeadlineMs(seconds);
    this.pushHeartbeat();
    this.heartbeatTimer = setInterval(() => this.pushHeartbeat(), HEARTBEAT_MS);
    this.passTimer = setTimeout(() => {
      this.killWedged(
        `the speech engine did not answer for ${Math.round(deadline / 1000)} seconds`,
      );
    }, deadline);
  }

  private endPass(): void {
    this.clearTimer('pass');
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private pushHeartbeat(): void {
    const s = this.session;
    if (!s || s.terminated) return;
    this.push(s.webContentsId, { type: 'heartbeat' });
  }

  /** The engine stopped answering. Kill it and report the truth: what we were
   *  waiting for, and the last thing it said. No invented cause. */
  private killWedged(whatHappened: string): void {
    const stderr = this.lastStderr;
    this.endPass();
    this.clearTimer('load');
    this.clearTimer('stop');
    // Kill BEFORE emitting. What actually makes the following exit silent is that
    // `unloadWorker` drops our reference to the worker first, so the exit callback's
    // "is this still our worker?" check fails and it returns. (The old comment
    // credited the ordering alone, which was not true of the mechanism: `terminated`
    // is only set inside emitTerminal, so a synchronous exit would have won the race
    // and replaced this specific, true sentence with a generic one.)
    this.unloadWorker();
    const parts = [`Voice stopped: ${whatHappened} and was closed.`];
    if (stderr) parts.push(`Its last message was: ${stderr}`);
    this.emitTerminal({ type: 'error', message: parts.join(' ') });
  }

  private unloadWorker(): void {
    const w = this.worker;
    this.worker = null;
    this.endPass();
    this.clearTimer('load');
    this.clearTimer('stop');
    try { w?.kill(); } catch { /* already gone */ }
  }

  // ── Session bookkeeping ───────────────────────────────────────────────────

  /** THE choke point. Every ending goes through here, and "exactly one" is held
   *  by TWO things, deliberately: `endSession()` releases the session below (so
   *  anything the engine says afterwards has nowhere to land), and the
   *  `terminated` flag covers the sliver of time between delivering the event
   *  and releasing the session — if delivering it ever calls back into this
   *  service, that re-entry finds the ending already spent. */
  private emitTerminal(event: VoiceEvent): void {
    const s = this.session;
    if (!s || s.terminated) return;
    s.terminated = true;
    this.push(s.webContentsId, event);
    this.endSession();
  }

  private endSession(): void {
    const s = this.session;
    if (!s) return;
    try { s.unwatchWindow(); } catch { /* window already gone */ }
    this.session = null;
    this.endPass();
    this.clearTimer('load');
    this.clearTimer('stop');
    this.armIdleUnload();
  }

  private onWindowGone(webContentsId: number): void {
    if (!this.session || this.session.webContentsId !== webContentsId) return;
    // A closed window cannot be told anything, so this is a cancel: the session
    // ends, nothing is emitted, and the engine's memory goes back immediately
    // rather than in ten minutes.
    this.cancel();
    this.unloadWorker();
  }

  private push(webContentsId: number, event: VoiceEvent): void {
    if (!this.deps.isWindowAlive(webContentsId)) return;
    this.deps.deliver(webContentsId, event);
  }

  // ── Timers ────────────────────────────────────────────────────────────────

  private armStopDeadline(): void {
    this.clearTimer('stop');
    this.stopTimer = setTimeout(() => {
      this.killWedged('the speech engine did not return your words within 20 seconds');
    }, STOP_DEADLINE_MS);
  }

  private armIdleUnload(): void {
    this.clearIdleUnload();
    if (!this.worker) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.session) this.unloadWorker();
    }, IDLE_UNLOAD_MS);
  }

  private clearIdleUnload(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  private clearTimer(which: 'load' | 'pass' | 'stop'): void {
    if (which === 'load' && this.loadTimer) { clearTimeout(this.loadTimer); this.loadTimer = null; }
    if (which === 'pass' && this.passTimer) { clearTimeout(this.passTimer); this.passTimer = null; }
    if (which === 'stop' && this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null; }
  }

  // ── Download progress -> what the card shows ──────────────────────────────

  /** THIS FILE OWNS the translation from the downloader's own progress shape
   *  into the five readiness states the card renders. The downloader knows
   *  bytes; the card knows sentences; nobody else translates between them. */
  private readinessForProgress(p: VoiceAssetProgress): VoiceReadiness | null {
    switch (p.phase) {
      case 'downloading':
        return {
          state: 'downloading', engine: VOICE_ENGINE_LABEL,
          sizeMb: this.downloadSizeMb(), percent: p.percent,
        };
      case 'unpacking':
        return { state: 'unpacking', engine: VOICE_ENGINE_LABEL };
      case 'ready':
        return { state: 'ready', engine: VOICE_ENGINE_LABEL };
      case 'error':
        // Handled on the rejection instead, so the card gets the real sentence
        // next to a Retry rather than a dead-end `unavailable`.
        return null;
    }
  }

  private downloadSizeMb(): number {
    const runtime = pickRuntime(this.platform, this.arch);
    if (!runtime) return 0;
    return Math.round(totalDownloadBytes(runtime) / 1_000_000);
  }
}

/** Where the compiled worker sits next to this file, in dev and in a packaged
 *  app alike (`tsc` puts both in `dist/main/voice/`). Exported so the handler
 *  module can fork it without knowing the layout. */
export function voiceWorkerPath(): string {
  return path.join(__dirname, 'voice-worker.js');
}
