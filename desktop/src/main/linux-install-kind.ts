// How this Linux copy of YouCoded was installed — the question the updater has
// to answer before it downloads anything.
//
// WHY this exists: the update picker used to hand every Linux install the
// AppImage. On a pacman/deb/rpm install that is a ~180 MB download that cannot
// update anything: the AppImage self-replace path looks for the running
// AppImage ($APPIMAGE), finds none, and quietly opens the download page
// instead. Reported 2026-09-20 on an Arch install of `youcoded 1.3.0_beta.80-1`.
//
// electron-builder installs the native packages to /opt/YouCoded, so the
// package manager that OWNS process.execPath is the honest answer — better than
// reading /etc/os-release, which says what the distro is, not how this copy got
// here (an AppImage on Arch, or a .deb installed on a distro with rpm present).
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';

export type LinuxInstallKind =
  | 'appimage'  // running from an AppImage — can self-replace
  | 'pacman'    // Arch package, installed to /opt
  | 'deb'       // Debian/Ubuntu package
  | 'rpm'       // Fedora/openSUSE package
  | 'unknown';  // dev checkout, tarball, Nix, a container… treat as portable

/** The package managers we can ask "do you own this file?", in query order. */
const OWNERS: ReadonlyArray<{ kind: LinuxInstallKind; cmd: string; args: (p: string) => string[] }> = [
  { kind: 'pacman', cmd: 'pacman', args: (p) => ['-Qo', p] },
  { kind: 'deb', cmd: 'dpkg', args: (p) => ['-S', p] },
  { kind: 'rpm', cmd: 'rpm', args: (p) => ['-qf', p] },
];

export interface LinuxInstallKindDeps {
  platform?: NodeJS.Platform;
  execPath?: string;
  envAppImage?: string;
  exists?: (p: string) => boolean;
  /** Returns the child's exit status; null/non-zero both mean "not this one". */
  run?: (cmd: string, args: string[]) => number | null;
}

function defaultRun(cmd: string, args: string[]): number | null {
  // A missing package manager throws ENOENT into `error`, not a status — both
  // read as "not the owner". Two seconds is far beyond a local database query,
  // and the timeout keeps a wedged tool from hanging the update check.
  const res = spawnSync(cmd, args, { stdio: 'ignore', timeout: 2000 });
  if (res.error) return null;
  return res.status;
}

export function detectLinuxInstallKind(deps: LinuxInstallKindDeps = {}): LinuxInstallKind {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'linux') return 'unknown';

  const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
  // $APPIMAGE is set by the AppImage runtime and points at the image itself.
  // It is the only case that can update in place, so it is checked first.
  const appImage = deps.envAppImage ?? process.env.APPIMAGE;
  if (appImage && exists(appImage)) return 'appimage';

  const run = deps.run ?? defaultRun;
  const execPath = deps.execPath ?? process.execPath;
  for (const owner of OWNERS) {
    if (run(owner.cmd, owner.args(execPath)) === 0) return owner.kind;
  }
  return 'unknown';
}

// WHY an async twin (2026-09-26): the first question used to run on the main
// thread as up to three blocking spawnSync calls — measured ~170 ms of app-wide
// freeze on every launch (pacman here), and up to 2 s per manager on a machine
// where one is slow. The update check now awaits primeLinuxInstallKind() before
// it reads the answer, so the blocking path below is only a fallback.
function defaultRunAsync(cmd: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(cmd, args, { stdio: 'ignore' }); } catch { resolve(null); return; }
    // Same 2 s budget as defaultRun; a killed child exits with a null status,
    // which reads as "not the owner" exactly like spawnSync's timeout did.
    const timer = setTimeout(() => child.kill(), 2000);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}

export async function detectLinuxInstallKindAsync(
  deps: Omit<LinuxInstallKindDeps, 'run' | 'exists'> & {
    exists?: (p: string) => boolean | Promise<boolean>;
    run?: (cmd: string, args: string[]) => Promise<number | null>;
  } = {},
): Promise<LinuxInstallKind> {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'linux') return 'unknown';
  const exists = deps.exists ?? ((p: string) => fs.promises.access(p).then(() => true, () => false));
  const appImage = deps.envAppImage ?? process.env.APPIMAGE;
  if (appImage && (await exists(appImage))) return 'appimage';
  const run = deps.run ?? defaultRunAsync;
  const execPath = deps.execPath ?? process.execPath;
  // In order, one at a time — same precedence as the sync version.
  for (const owner of OWNERS) {
    if ((await run(owner.cmd, owner.args(execPath))) === 0) return owner.kind;
  }
  return 'unknown';
}

let cached: LinuxInstallKind | undefined;
let priming: Promise<LinuxInstallKind> | undefined;

/** Works the answer out without blocking and caches it; safe to call repeatedly. */
export function primeLinuxInstallKind(): Promise<LinuxInstallKind> {
  priming ??= detectLinuxInstallKindAsync().then((k) => (cached ??= k), () => (cached ??= 'unknown'));
  return priming;
}

/** The process-wide answer. Cached: it cannot change while the app runs, and
 *  the update check asks on every poll. */
export function linuxInstallKind(): LinuxInstallKind {
  cached ??= detectLinuxInstallKind();
  return cached;
}
