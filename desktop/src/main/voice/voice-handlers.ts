// The six things the composer can ask about voice typing, plus the audio it
// streams and the events it gets back. Structurally a sibling of
// arcade-handlers.ts / social-handlers.ts: one module, one register function
// called from main.ts, one channel list pinned beside preload.ts's strings.
//
// WHY the microphone permission prompt lives HERE and not in the renderer: on
// macOS, Chromium does not raise the system prompt for us — an Electron app that
// touches the microphone without having asked is KILLED by the operating
// system, with no dialog and no error the user can read. So `voice:start` asks
// first, waits for the answer, and only then lets the microphone open.
import { ipcMain, systemPreferences, utilityProcess, webContents } from 'electron';
import type { VoiceEvent } from '../../shared/voice-types';
import { VoiceAssets } from './voice-assets';
import {
  MIC_REFUSED_SENTENCE, VoiceService, voiceWorkerPath,
  type VoiceWorkerHandle, type VoiceWorkerToService,
} from './voice-service';

// ── Channel list for the double-registration guard ───────────────────────────
// Byte-identical to the strings in preload.ts. `voice:event` is the push and has
// no handler, so it is listed separately.
const CHANNELS = [
  'voice:status',
  'voice:download',
  'voice:start',
  'voice:stop',
  'voice:cancel',
  'voice:mic-access',
] as const;

const AUDIO_CHANNEL = 'voice:audio';
const EVENT_CHANNEL = 'voice:event';

let service: VoiceService | null = null;

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

/** Wire the composer's microphone to the speech engine. Called once from
 *  main.ts, beside the other `register*Handlers`. */
export function registerVoiceHandlers(userDataPath: string): void {
  // WHY: ipcMain.handle throws on re-registration. Clearing first keeps
  // hot-reload dev sessions (scripts/run-dev.sh) from crashing on reload.
  for (const ch of CHANNELS) ipcMain.removeHandler(ch);
  ipcMain.removeAllListeners(AUDIO_CHANNEL);
  // Fix (whole-branch review F9): and let go of the engine the previous
  // registration owned. Without this the reload this function exists to survive
  // leaked a live 1.14 GB utilityProcess every time — the module-level `service`
  // below was simply overwritten, leaving nothing able to reach the old one.
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

  ipcMain.handle('voice:status', () => instance.status());
  ipcMain.handle('voice:download', (e) => instance.download(e.sender.id));

  ipcMain.handle('voice:start', async (e) => {
    // R21's "the system prompt comes first" half. On macOS this raises the
    // one-time microphone dialog and waits for the person to answer it; on
    // every other platform it is skipped, because there is no such call.
    if (process.platform === 'darwin') {
      const granted = await systemPreferences.askForMediaAccess('microphone');
      // The refusal is worded exactly once, in voice-service.ts, so this
      // sentence and the renderer's cannot drift apart.
      if (!granted) throw new Error(MIC_REFUSED_SENTENCE);
    }
    await instance.start(e.sender.id);
  });

  ipcMain.handle('voice:stop', () => { instance.stop(); });
  ipcMain.handle('voice:cancel', () => { instance.cancel(); });

  /** What the operating system says about the microphone. Meaningful on macOS
   *  AND on Windows, whose global privacy switch otherwise looks exactly like
   *  "this computer has no microphone". Linux has no such API, so the honest
   *  answer there is "unknown" and the renderer falls back to asking the
   *  browser layer for the device list. */
  ipcMain.handle('voice:mic-access', () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return 'unknown';
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status === 'granted') return 'granted';
    // 'restricted' is macOS parental controls / MDM: the person cannot grant it
    // themselves, which the user experiences as a refusal.
    if (status === 'denied' || status === 'restricted') return 'denied';
    if (status === 'not-determined') return 'not-determined';
    return 'unknown';
  });

  // Fire-and-forget: 10 slices a second while the mic is open. `ipcMain.on`,
  // not `handle`, because a reply per slice would cost more than the audio.
  ipcMain.on(AUDIO_CHANNEL, (e, chunk: ArrayBuffer, rms: number) => {
    instance.pushAudio(e.sender.id, chunk, rms);
  });
}

/** Quit. Kills the speech engine's program so it cannot outlive the app —
 *  a 1.14 GB process left behind after "Quit" is the kind of thing a person
 *  finds days later in their Task Manager. */
export function shutdownVoiceHandlers(): void {
  service?.shutdown();
  service = null;
}
