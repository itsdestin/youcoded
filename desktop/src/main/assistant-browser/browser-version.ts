// The real version of the browser we are about to launch, so a background
// (headless) browser can present an ordinary Chrome user agent.
//
// WHY: headless Chrome announces itself as "HeadlessChrome/<v>" in both the
// User-Agent header and navigator.userAgent, and many sites (search engines,
// shops, banks) answer that with a captcha or a block page. Playwright can set
// a user agent for the whole context — including popups and workers — but only
// at launch, so the version must be known BEFORE launching. Reading it after a
// launch would cost a second launch.
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const VERSION_RE = /(\d+)\.(\d+)\.(\d+)\.(\d+)/;

/** Async, bounded: never blocks main (performance rule 1). null when unknown. */
export async function readBrowserVersion(executablePath: string, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  if (platform === 'win32') {
    // WHY not `chrome.exe --version` on Windows: it prints nothing there (it
    // opens a window instead). Chrome, Edge and Brave all install beside a
    // folder named after their exact version.
    try {
      const dir = path.dirname(executablePath);
      const versions = (await fs.promises.readdir(dir)).filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d));
      versions.sort((a, b) => compareVersions(b, a));
      return versions[0] ?? null;
    } catch { return null; }
  }
  return new Promise((resolve) => {
    execFile(executablePath, ['--version'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const m = VERSION_RE.exec(String(stdout));
      resolve(m ? m[0] : null);
    });
  });
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** The user agent a normal (windowed) Chrome of this version sends on this OS.
 *  Chrome freezes the minor parts to 0.0.0 in its real UA (UA reduction). */
export function normalUserAgent(version: string, platform: NodeJS.Platform = process.platform): string {
  const major = version.split('.')[0];
  const os = platform === 'win32'
    ? 'Windows NT 10.0; Win64; x64'
    : platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
