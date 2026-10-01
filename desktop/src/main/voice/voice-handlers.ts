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
import { utilityProcess, webContents } from 'electron';
import type { VoiceEvent } from '../../shared/voice-types';
import { VoiceAssets } from './voice-assets';
import {
  VoiceService, voiceWorkerPath,
  type VoiceWorkerHandle, type VoiceWorkerToService,
} from './voice-service';

const EVENT_CHANNEL = 'voice:event';

let service: VoiceService | null = null;

/** The running speech service, for the voice:* table entries (main/ipc/voice.ts); null before main starts it. */
export function getVoiceService(): VoiceService | null { return service; }

/** Start the speech engine's own program.
 *
 *  `utilityProcess` (not `child_process.fork`) because it runs Electron's own
 *  Node, which is what the speech add-on was built against, and because Electron
 *  ties its lifetime to the app's. `stdio: 'pipe'` is not decoration: the last
 *  line the engine prints is the only true thing we have to show the user if we
 *  ever have to close it. */
function spawnVoiceWorker(userDataPath: string): VoiceWorkerHandle {
  // The data folder is the worker's ONLY argument: a forked process cannot ask
  // Electron where the app keeps its files, and it needs it to find the speech
  // engine that was downloaded there.
  const child = utilityProcess.fork(voiceWorkerPath(), [userDataPath], {
    serviceName: 'youcoded-voice',
    stdio: 'pipe',
  });
  return {
    send: (msg) => child.postMessage(msg),
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

  const assets = new VoiceAssets(userDataPath);
  const instance = new VoiceService({
    assets,
    spawnWorker: () => spawnVoiceWorker(userDataPath),
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
