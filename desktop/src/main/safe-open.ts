// Safe versions of the two "hand this to the operating system" calls: shell.openExternal (a web address) and
// shell.openPath (a file). Both used to be called raw from many places; a poisoned address or a planted program file
// would then run something instead of just showing a page or a document (2026-10-30 security audit F2, F7).
import fs from 'fs';
import path from 'path';
import { shell } from 'electron';

// ── Addresses ────────────────────────────────────────────────────────────────

/** True for an address the OS may open on our behalf: web pages, and (when allowed) mail links. Nothing else — a
 *  `file:` or custom-scheme address can start a program on some systems. Parsed with the URL constructor, never a prefix
 *  test, so `https:evil` style oddities are judged by what the OS would actually read. */
export function isSafeExternalUrl(url: unknown, opts: { mailto?: boolean } = {}): url is string {
  if (typeof url !== 'string' || url.length === 0 || url.length > 8192) return false;
  let parsed: URL;
  try { parsed = new URL(url.trim()); } catch { return false; }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return true;
  return parsed.protocol === 'mailto:' && opts.mailto !== false;
}

/** shell.openExternal behind the address check. Resolves false (and opens nothing) for a refused address. */
export async function safeOpenExternal(url: unknown, opts: { mailto?: boolean } = {}): Promise<boolean> {
  if (!isSafeExternalUrl(url, opts)) {
    console.warn('[safe-open] refused to open a non-web address');
    return false;
  }
  await shell.openExternal(url.trim());
  return true;
}

// ── Files ────────────────────────────────────────────────────────────────────

// File types the OS RUNS (or installs, or mounts, or imports as settings) when it "opens" them, rather than showing them.
// WHY a list of what to refuse instead of what to allow: people open hundreds of document and media types legitimately,
// and an allow-list would break them silently; the dangerous set is small and well known. Includes types that only
// run on SOME systems (a .js file runs under Windows Script Host but opens in an editor on Linux) because the same
// path can be opened on any of them and the cost of revealing a folder instead is one extra click.
export const RISKY_OPEN_EXTENSIONS: ReadonlySet<string> = new Set([
  // Windows programs, installers and shortcuts
  'exe', 'com', 'scr', 'pif', 'msi', 'msp', 'mst', 'msix', 'msixbundle', 'appx', 'appxbundle', 'appinstaller',
  'lnk', 'url', 'dll', 'sys', 'cpl', 'msc', 'gadget', 'application', 'appref-ms', 'xbap', 'job', 'inf', 'reg',
  'settingcontent-ms', 'library-ms', 'search-ms', 'diagcab', 'diagpkg', 'theme', 'themepack', 'chm', 'hta', 'rdp', 'rdg',
  // Windows scripts
  'bat', 'cmd', 'ps1', 'ps1xml', 'ps2', 'ps2xml', 'psc1', 'psc2', 'psm1', 'psd1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'wsc', 'ws',
  // Disk images the OS mounts on open
  'iso', 'img', 'vhd', 'vhdx', 'dmg',
  // macOS and Linux programs, packages and launchers
  'app', 'command', 'tool', 'workflow', 'action', 'scpt', 'scptd', 'applescript', 'osx', 'pkg', 'mpkg', 'mobileconfig',
  'sh', 'bash', 'zsh', 'fish', 'csh', 'ksh', 'run', 'bin', 'out', 'elf', 'appimage', 'desktop', 'deb', 'rpm',
  'flatpak', 'flatpakref', 'snap', 'webloc', 'inetloc', 'fileloc', 'terminal',
  // Interpreter scripts that run when double-clicked on some systems
  'py', 'pyw', 'pyz', 'pyc', 'pl', 'rb', 'tcl', 'jar', 'jnlp',
  // Browser extensions install themselves
  'crx', 'xpi',
]);

/** The extension a file system will act on: lower-cased, with the trailing dots and spaces Windows ignores removed. */
function openExtension(filePath: string): string {
  const base = path.basename(filePath).replace(/[. \t]+$/, '');
  const dot = base.lastIndexOf('.');
  return dot <= 0 && !base.startsWith('.') ? '' : base.slice(dot + 1).toLowerCase();
}

/** True when opening this file would run it (or install/mount/import it) instead of showing it. Judges the name as
 *  given AND where a link really leads, and — on systems with an execute permission — an extensionless file marked runnable. */
export async function isRiskyToOpen(filePath: string): Promise<boolean> {
  const names = [filePath];
  try { const real = await fs.promises.realpath(filePath); if (real !== filePath) names.push(real); } catch { /* missing: judge the name only */ }
  if (names.some((n) => RISKY_OPEN_EXTENSIONS.has(openExtension(n)))) return true;
  if (process.platform !== 'win32') {
    try {
      const st = await fs.promises.stat(filePath);
      // A regular file with no extension and any execute bit is a program (or script) by convention.
      if (st.isFile() && (st.mode & 0o111) !== 0 && openExtension(filePath) === '') return true;
    } catch { /* missing: shell.openPath reports it */ }
  }
  return false;
}

/** shell.openPath behind the file-type check. Same contract as shell.openPath ('' on success, else an error text), but a
 *  program-like file is SHOWN in its folder instead of being run. */
export async function openPathSafely(filePath: string): Promise<string> {
  if (await isRiskyToOpen(filePath)) {
    shell.showItemInFolder(filePath);
    return '';
  }
  return shell.openPath(filePath);
}
