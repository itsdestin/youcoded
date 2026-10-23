// update-install-facts.ts — what installing an update on THIS copy of the app would take.
//
// WHY its own module (#183 T2, design §3): the answer depends on the platform, on where the app
// lives and on who may write there. Keeping it pure, with every probe injected, lets one test file
// walk all three platforms from a Linux runner. It is computed once at startup, async, and never on
// a click or a quit path (performance rule 1).
import path from 'path';
import type { LinuxInstallKind } from './linux-install-kind';

export interface InstallFacts {
  /** Installing needs an administrator (Linux package; Mac bundle/parent not writable; Windows per-machine). */
  needsPassword: boolean;
  /** No in-app install at all: unpackaged; Mac bundle misnamed or translocated; AppImage folder not
   *  writable; a Linux copy that is neither an AppImage nor a package. Restart falls back to today's
   *  interactive installer. */
  installRefused: boolean;
  /** The one refusal that also stops the BACKGROUND download: an AppImage whose folder cannot be
   *  written has nowhere to stage, and nothing could ever replace it (design E9). */
  noBackgroundDownload: boolean;
}

export interface InstallFactsDeps {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  execPath: string;
  env: NodeJS.ProcessEnv;
  linuxKind: LinuxInstallKind;
  /** fs.access(p, W_OK) as a boolean. */
  canWrite: (p: string) => Promise<boolean>;
  /** Create and remove a temp file in `dir` — a real write, not a permission-bit guess. */
  probeFolderWritable: (dir: string) => Promise<boolean>;
}

/** Windows per-machine install: the exe sits under %ProgramFiles% or %ProgramFiles(x86)%.
 *  WHY by path and not fs.access: access() ignores Windows ACLs and says "writable" for a folder
 *  an ordinary user cannot touch (design E4). Case-insensitive, like the file system. */
export function isWindowsPerMachinePath(execPath: string, env: NodeJS.ProcessEnv): boolean {
  const norm = (p: string) => path.win32.normalize(p).toLowerCase();
  const exe = norm(execPath);
  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
    if (!root) continue;
    const r = norm(root).replace(/[\\/]+$/, '');
    if (exe.startsWith(r + '\\')) return true;
  }
  return false;
}

/** `/Applications/YouCoded.app/Contents/MacOS/YouCoded` -> `/Applications/YouCoded.app`. */
export function macBundleOf(execPath: string): string {
  return path.posix.dirname(path.posix.dirname(path.posix.dirname(execPath)));
}

export async function computeInstallFacts(deps: InstallFactsDeps): Promise<InstallFacts> {
  const facts: InstallFacts = { needsPassword: false, installRefused: !deps.isPackaged, noBackgroundDownload: false };
  if (deps.platform === 'win32') {
    facts.needsPassword = isWindowsPerMachinePath(deps.execPath, deps.env);
  } else if (deps.platform === 'darwin') {
    const bundle = macBundleOf(deps.execPath);
    // The swap helper replaces the bundle by path, so it must be the app it is named for and not a
    // randomized read-only App Translocation copy (design D9).
    if (path.posix.basename(bundle) !== 'YouCoded.app' || bundle.includes('/AppTranslocation/')) facts.installRefused = true;
    facts.needsPassword = !(await deps.canWrite(bundle)) || !(await deps.canWrite(path.posix.dirname(bundle)));
  } else if (deps.platform === 'linux') {
    if (deps.linuxKind === 'pacman' || deps.linuxKind === 'deb' || deps.linuxKind === 'rpm') {
      facts.needsPassword = true;
    } else if (deps.linuxKind === 'appimage' && deps.env.APPIMAGE) {
      // Never "needs a password": the AppImage replaces itself with the user's own rights. If its
      // folder is read-only there is no way in at all.
      if (!(await deps.probeFolderWritable(path.dirname(deps.env.APPIMAGE)))) {
        facts.installRefused = true;
        facts.noBackgroundDownload = true;
      }
    } else {
      // A tarball or source checkout: nothing in-app can replace it, so say so up front.
      facts.installRefused = true;
    }
  }
  return facts;
}
