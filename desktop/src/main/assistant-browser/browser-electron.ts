// The app's one BrowserClient, wired to a real Electron utilityProcess.
// Desktop only. Nothing forks until the first browser tool call, panel watch or
// Settings → Browser open — an install that never browses never runs the worker.
import * as path from 'path';
import { app, screen, utilityProcess } from 'electron';
import { BrowserClient, browserModeOf, type WorkerHandle } from './browser-client';
import { log } from '../logger';

let client: BrowserClient | null = null;

/** userData/assistant-browser — profile, settings, shots, downloads, browsers. */
function browserRootDir(): string {
  return path.join(app.getPath('userData'), 'assistant-browser');
}

/** The densest screen's pixel ratio, 1–2: the hidden browser draws its picture
 *  at it, so the panel is as sharp as the screen (more than 2 only costs). */
function pictureRatio(): number {
  try {
    const most = Math.max(1, ...screen.getAllDisplays().map((d) => d.scaleFactor || 1));
    return Math.min(2, Math.round(most * 4) / 4);
  } catch { return 2; }
}

export function getBrowserClient(): BrowserClient {
  if (client) return client;
  client = new BrowserClient({
    modeOf: browserModeOf,
    log: (level, msg, data) => log(level, 'Browser', msg, data),
    fork: (): WorkerHandle => {
      const child = utilityProcess.fork(path.join(__dirname, 'browser-host.js'), [browserRootDir(), String(pictureRatio())], {
        serviceName: 'youcoded-browser',
        // WHY 'pipe': the worker's last words are the only explanation of a
        // crash; they go to the app log (design review 2 #7).
        stdio: 'pipe',
      });
      const toLog = (level: 'INFO' | 'WARN') => (d: Buffer | string) => {
        for (const line of String(d).split('\n')) if (line.trim()) log(level, 'Browser', line.slice(0, 500));
      };
      child.stdout?.on('data', toLog('INFO'));
      child.stderr?.on('data', toLog('WARN'));
      return {
        postMessage: (m) => child.postMessage(m),
        on: ((event: 'message' | 'exit', cb: (arg: never) => void) => { child.on(event as 'message', cb as (m: unknown) => void); }) as WorkerHandle['on'],
        kill: () => { child.kill(); },
      };
    },
  });
  return client;
}

/** True once something has used the browser this run (quit only waits then). */
export function browserClientIfCreated(): BrowserClient | null { return client; }
