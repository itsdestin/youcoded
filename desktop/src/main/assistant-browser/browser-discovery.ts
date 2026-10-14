// Which Chromium-family browser the assistant browser drives
// (spec docs/active/specs/2026-10-13-assistant-browser-design.md §2).
//
// WHY the user's own installed browser and not a bundled one: a bundled
// Chromium is ~150 MB per platform in every installer, and Google's sign-in
// treats a stock "Chrome for Testing" build as less trustworthy than real
// Chrome. Nearly every desktop already has one of these (Windows always ships
// Edge), so "works out of the box" means FINDING it; the download is the
// fallback for the rest (browser-installer.ts).
//
// WHY async fs only: discovery runs from an IPC handler and from the first tool
// call — performance rule 1 bans blocking fs on any path a click reaches.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { BrowserKind, FoundBrowser } from '../../shared/browser-types';
export type { BrowserKind, FoundBrowser } from '../../shared/browser-types';

/** Order = preference when the user hasn't picked one. Chrome first: best site
 *  compatibility and the sign-in flows users expect. */
export const BROWSER_KINDS: readonly BrowserKind[] = ['chrome', 'edge', 'chromium', 'brave', 'downloaded'];

const LABELS: Record<BrowserKind, string> = {
  chrome: 'Google Chrome',
  edge: 'Microsoft Edge',
  chromium: 'Chromium',
  brave: 'Brave',
  downloaded: 'Chromium (downloaded for the assistant)',
};

export interface DiscoveryEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  /** Where browser-installer.ts puts a downloaded Chromium. */
  downloadDir: string | null;
  /** Resolves true when the path exists and is a file. Injected for tests. */
  isFile?: (p: string) => Promise<boolean>;
  /** Lists a directory's entries ([] when missing). Injected for tests. */
  listDir?: (p: string) => Promise<string[]>;
}

async function defaultIsFile(p: string): Promise<boolean> {
  try { return (await fs.promises.stat(p)).isFile(); } catch { return false; }
}

async function defaultListDir(p: string): Promise<string[]> {
  try { return await fs.promises.readdir(p); } catch { return []; }
}

/** Candidate executable paths per kind for one platform, most likely first. */
export function candidatePaths(kind: Exclude<BrowserKind, 'downloaded'>, platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter((r): r is string => !!r);
    const rel: Record<typeof kind, string> = {
      chrome: 'Google\\Chrome\\Application\\chrome.exe',
      edge: 'Microsoft\\Edge\\Application\\msedge.exe',
      chromium: 'Chromium\\Application\\chrome.exe',
      brave: 'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    };
    return roots.map((r) => path.win32.join(r, rel[kind]));
  }
  if (platform === 'darwin') {
    const app: Record<typeof kind, string> = {
      chrome: 'Google Chrome.app/Contents/MacOS/Google Chrome',
      edge: 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      chromium: 'Chromium.app/Contents/MacOS/Chromium',
      brave: 'Brave Browser.app/Contents/MacOS/Brave Browser',
    };
    return ['/Applications', path.posix.join(home, 'Applications')].map((r) => path.posix.join(r, app[kind]));
  }
  // Linux and the BSDs: distro packages land in /usr/bin; vendor .debs/.rpms in /opt.
  const names: Record<typeof kind, string[]> = {
    chrome: ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/opt/google/chrome/chrome'],
    edge: ['/usr/bin/microsoft-edge-stable', '/usr/bin/microsoft-edge', '/opt/microsoft/msedge/msedge'],
    // WHY no /snap/bin/chromium: a snap-confined Chromium cannot open a profile
    // folder under the app's hidden data directory, so it would be "found" and
    // then fail to start (design review 1 #11). Ubuntu's /usr/bin/chromium-browser
    // is a snap wrapper too — it is tried last and a start failure says so.
    chromium: ['/usr/bin/chromium', '/usr/lib/chromium/chromium', '/usr/bin/chromium-browser'],
    brave: ['/usr/bin/brave-browser', '/usr/bin/brave', '/opt/brave.com/brave/brave'],
  };
  return names[kind];
}

/** The executable inside a Chromium that playwright-core's installer put in
 *  `downloadDir` (layout: chromium-<rev>/chrome-<plat>/<exe>). Newest revision wins. */
async function findDownloaded(downloadDir: string, platform: NodeJS.Platform, isFile: (p: string) => Promise<boolean>, listDir: (p: string) => Promise<string[]>): Promise<string | null> {
  const revs = (await listDir(downloadDir))
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  const inner = platform === 'win32'
    ? ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']
    : platform === 'darwin'
      ? ['chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']
      : ['chrome-linux64/chrome', 'chrome-linux/chrome'];
  for (const rev of revs) {
    for (const rel of inner) {
      const p = path.join(downloadDir, rev, rel);
      if (await isFile(p)) return p;
    }
  }
  return null;
}

/** Every usable browser on this machine, in preference order. One entry per kind. */
export async function discoverBrowsers(d: DiscoveryEnv): Promise<FoundBrowser[]> {
  const isFile = d.isFile ?? defaultIsFile;
  const listDir = d.listDir ?? defaultListDir;
  const found: FoundBrowser[] = [];
  for (const kind of BROWSER_KINDS) {
    if (kind === 'downloaded') {
      if (!d.downloadDir) continue;
      const p = await findDownloaded(d.downloadDir, d.platform, isFile, listDir);
      if (p) found.push({ kind, label: LABELS[kind], executablePath: p });
      continue;
    }
    for (const p of candidatePaths(kind, d.platform, d.env, d.home)) {
      if (await isFile(p)) { found.push({ kind, label: LABELS[kind], executablePath: p }); break; }
    }
  }
  return found;
}

/** The browser to use: the user's pick when it is still installed, else the first found. */
export function pickBrowser(found: FoundBrowser[], preferred: BrowserKind | null): FoundBrowser | null {
  if (preferred) {
    const hit = found.find((b) => b.kind === preferred);
    if (hit) return hit;
  }
  return found[0] ?? null;
}

export function defaultDiscoveryEnv(downloadDir: string | null): DiscoveryEnv {
  return { platform: process.platform, env: process.env, home: os.homedir(), downloadDir };
}
