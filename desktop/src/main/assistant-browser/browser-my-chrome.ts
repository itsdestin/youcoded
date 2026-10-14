// Finding the person's own running Chrome for "My Chrome" (Experimental).
//
// HOW (verified against Chrome's own docs, 2026-10): since Chrome 136, Chrome
// ignores --remote-debugging-port on its default profile; the sanctioned route
// is the person turning on "remote debugging" at chrome://inspect/#remote-debugging.
// Chrome then writes DevToolsActivePort (port on line 1, browser path on line 2)
// into its user-data folder, and shows its own "Allow?" question when something
// connects. We read that file — the same thing Chrome's DevTools agent tooling
// does — and never start or restart the person's Chrome ourselves.
//
// UNVERIFIED here (said in the hand-back): the real toggle on Destin's own
// Chrome. Tests run against a separately launched Chrome that writes the same
// file.
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

function chromeUserDataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (env.YOUCODED_MY_CHROME_DIR) return env.YOUCODED_MY_CHROME_DIR; // test seam
  if (platform === 'win32') return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  return path.join(os.homedir(), '.config', 'google-chrome');
}

// WHY no quoted switch label: Chrome's exact wording on that page varies by
// version and we could not verify it here; the address is the stable part.
const TURN_ON = 'In Chrome, open chrome://inspect/#remote-debugging and turn remote debugging on, then try again.';

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(1500, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** The WebSocket address of the person's Chrome, or a plain sentence saying what to do. */
export async function findMyChrome(dir: string = chromeUserDataDir()): Promise<{ wsEndpoint: string } | { error: string }> {
  let text: string;
  try {
    text = await fs.promises.readFile(path.join(dir, 'DevToolsActivePort'), 'utf8');
  } catch {
    return { error: `Chrome isn't open, or its remote-debugging switch is off. ${TURN_ON}` };
  }
  const [portLine, pathLine] = text.replace(/\r/g, '').split('\n');
  const port = Number(portLine);
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !pathLine?.startsWith('/devtools/browser/')) {
    return { error: `Chrome's connection details look unusual, so the assistant won't use them. ${TURN_ON}` };
  }
  // A stale file outlives a closed Chrome; check something is listening.
  if (!(await portOpen(port))) return { error: `Chrome isn't open (or remote debugging is off). Open Chrome and try again. ${TURN_ON}` };
  return { wsEndpoint: `ws://127.0.0.1:${port}${pathLine.trim()}` };
}
