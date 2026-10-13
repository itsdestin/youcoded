// The speech service behind voice typing (the voice:* channels are table entries in main/ipc/voice.ts), plus the audio it
// streams and the events it gets back. Structurally a sibling of
// arcade-handlers.ts / social-handlers.ts: one module, one start function
// called from main.ts.
//
// WHY the microphone permission prompt lives in main (ipc/voice.ts) and not in the renderer: on
// macOS, Chromium does not raise the system prompt for us — an Electron app that
// touches the microphone without having asked is KILLED by the operating
// system, with no dialog and no error the user can read. So `voice:start` asks
// first, waits for the answer, and only then lets the microphone open.
import { app, utilityProcess, webContents } from 'electron';
import { voiceVocabularyAssetPath } from './voice-recognizer-vocabulary';
import type { VoiceEvent } from '../../shared/voice-types';
import { VoiceAssets } from './voice-assets';
import { VoiceVocabularyStore } from './voice-vocabulary';
import {
  VoiceService, voiceWorkerPath,
  type VoiceWorkerHandle, type VoiceWorkerToService,
} from './voice-service';

const EVENT_CHANNEL = 'voice:event';

let service: VoiceService | null = null;
let vocabulary: VoiceVocabularyStore | null = null;
export function getVoiceVocabularyStore(): VoiceVocabularyStore {
  if (!vocabulary) throw new Error('Voice vocabulary is not ready.');
  return vocabulary;
}

/** The running speech service, for the voice:* table entries (main/ipc/voice.ts); null before main starts it. */
export function getVoiceService(): VoiceService | null { return service; }

/** Start the speech engine's own program.
 *
 *  `utilityProcess` (not `child_process.fork`) because it runs Electron's own
 *  Node, which is what the speech add-on was built against, and because Electron
 *  ties its lifetime to the app's. `stdio: 'pipe'` is not decoration: the last
 *  line the engine prints is the only true thing we have to show the user if we
 *  ever have to close it. */
function spawnVoiceWorker(userDataPath: string, vocabulary: readonly string[] = []): VoiceWorkerHandle {
  // WHY: the fork has no Electron app API and native BPE reads need a real file
  // outside asar. Resolve from the app directory in dev, resources in packages.
  const asset = voiceVocabularyAssetPath(app.getAppPath(), app.isPackaged ? process.resourcesPath : undefined);
  const child = utilityProcess.fork(voiceWorkerPath(), [userDataPath, asset], {
    serviceName: 'youcoded-voice',
    stdio: 'pipe',
  });
  // WHY: 2000 long phrases exceed Windows' argv limit. Structured-clone sends
  // the immutable snapshot once, ordered before start, without a temporary file.
  const snapshot = Object.freeze([...vocabulary]);
  let configured = false;
  return {
    send: (msg) => {
      // Register lifecycle callbacks before this first send can throw; the
      // service then still owns (and can close) a fork whose pipe fails.
      if (!configured && snapshot.length) child.postMessage({ type: 'vocabulary', phrases: snapshot });
      configured = true;
      child.postMessage(msg);
    },
    kill: () => { child.kill(); },
    onMessage: (cb) => { child.on('message', (m: VoiceWorkerToService) => cb(m)); },
    onExit: (cb) => { child.on('exit', (code: number) => cb(code)); },
    onStderr: (cb) => {
      child.stderr?.on('data', (d: Buffer | string) => {
        for (const line of String(d).split('\n')) cb(line);
      });
    },
  };
}

/** Start the speech service for the composer's microphone. Called once from main.ts.
 *  WHY (2026-10-01 one-core R3-8): the seven voice:* channels are table entries (main/ipc/voice.ts) that reach this instance
 *  through getVoiceService(); nothing is registered with Electron here any more, so only the engine is replaced on a reload. */
export function startVoice(userDataPath: string): void {
  // Fix (whole-branch review F9): let go of the engine the previous start owned. Without this the dev reload this function
  // must survive leaked a live 1.14 GB utilityProcess every time — the module-level `service` below was simply overwritten,
  // leaving nothing able to reach the old one.
  service?.shutdown();

  // WHY: preferences share the install's profile, not the cloud/sync spaces.
  vocabulary = new VoiceVocabularyStore(userDataPath);
  const assets = new VoiceAssets(userDataPath);
  const instance = new VoiceService({
    assets,
    spawnWorker: (phrases) => spawnVoiceWorker(userDataPath, phrases),
    deliver: (id: number, event: VoiceEvent) => {
      const wc = webContents.fromId(id);
      if (wc && !wc.isDestroyed()) wc.send(EVENT_CHANNEL, event);
    },
    isWindowAlive: (id: number) => {
      const wc = webContents.fromId(id);
      return !!wc && !wc.isDestroyed();
    },
    onWindowGone: (id: number, cb: () => void) => {
      const wc = webContents.fromId(id);
      if (!wc) { cb(); return () => {}; }
      wc.once('destroyed', cb);
      return () => { wc.removeListener('destroyed', cb); };
    },
  });
  service = instance;
}

/** Quit. Kills the speech engine's program so it cannot outlive the app —
 *  a 1.14 GB process left behind after "Quit" is the kind of thing a person
 *  finds days later in their Task Manager. */
export function shutdownVoiceHandlers(): void {
  service?.shutdown();
  service = null;
}
