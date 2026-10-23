// update-exit.ts — the few instant steps that install an update while the app is exiting, the Mac swap
// helper they hand off to, and the record of an attempt (#183 T3, design §4 and rev 4).
//
// WHY its own module: the exit hook runs after teardown, from Electron's will-quit AND from the 10 s
// watchdog right before app.exit(), so it may do only instant work (rev 4 F4): one rename, one small file
// write, one detached spawn. Everything slow (hashing, the brake, mounting a disk image) happened earlier,
// in update-service.ts's prepare step and at download time. Keeping the instant part here makes that
// promise checkable: `runExitPlan` is synchronous and a test scans its source for anything async.
import fs from 'fs';
import path from 'path';
import { spawn as nodeSpawn } from 'child_process';

/** What the prepare step leaves behind for the exit hook. Names only the paths the hook needs. */
export type ExitPlan =
  | { kind: 'win-nsis'; version: string; installer: string }
  | { kind: 'appimage'; version: string; staged: string; target: string }
  | { kind: 'mac-go'; version: string; goFile: string };

export interface ExitDeps {
  spawn?: typeof nodeSpawn;
  /** update-cache/attempt.json */
  attemptPath: string;
  /** Failed attempts already recorded for this version (carried forward into the new record). */
  failures: number;
  now?: () => number;
  /** app.relaunch(), for the AppImage that has just replaced itself. */
  relaunch: () => void;
  warn?: (msg: string, detail?: unknown) => void;
}

/** Windows NSIS: silent, marked as an update; `--force-run` makes NSIS start the app again (Restart). */
export function nsisArgs(relaunch: boolean): string[] {
  return relaunch ? ['/S', '--updated', '--force-run'] : ['/S', '--updated'];
}

/**
 * The instant exit steps. SYNCHRONOUS ON PURPOSE (design rev 4 F4): the process is about to end, so
 * nothing may be awaited here; the sync calls are on the main-blocking-calls allowlist with that reason.
 * Writes the attempt record first (so a spawn that dies still counts), then does exactly one thing.
 * Returns whether the install step was handed off.
 */
export function runExitPlan(plan: ExitPlan, relaunch: boolean, deps: ExitDeps): boolean {
  const warn = deps.warn ?? (() => {});
  try {
    // WHY before the step, not after: the next launch decides "did it work" from this file alone.
    fs.writeFileSync(deps.attemptPath, JSON.stringify({ version: plan.version, at: (deps.now ?? Date.now)(), failures: deps.failures }));
  } catch (e) { warn('could not write attempt.json', e); }
  try {
    if (plan.kind === 'win-nsis') {
      const child = (deps.spawn ?? nodeSpawn)(plan.installer, nsisArgs(relaunch), { detached: true, stdio: 'ignore', windowsHide: false });
      child.on?.('error', (e: Error) => warn('installer did not start', e));
      child.unref();
      return true;
    }
    if (plan.kind === 'appimage') {
      // Same folder as the running image, so this is one atomic rename (design D20); the running process
      // keeps its open file, the next start runs the new one.
      fs.renameSync(plan.staged, plan.target);
      if (relaunch) deps.relaunch();
      return true;
    }
    // The helper (already waiting for our pid) reads this file: its presence is the "go", its text says
    // whether to reopen the app afterwards.
    fs.writeFileSync(plan.goFile, relaunch ? 'relaunch\n' : 'install\n');
    return true;
  } catch (e) {
    warn('exit install step failed', e);
    return false;
  }
}

// ─── Attempt record (async; startup only) ───────────────────────────────────

/** `seen`: the launch after the attempt already counted its failure (not written by the exit hook). */
export interface AttemptRecord { version: string; at: number; failures: number; seen?: boolean }

export async function readAttempt(attemptPath: string): Promise<AttemptRecord | null> {
  try {
    const raw = JSON.parse(await fs.promises.readFile(attemptPath, 'utf8')) as Record<string, unknown>;
    if (typeof raw.version !== 'string' || !/^[0-9A-Za-z.+-]+$/.test(raw.version)) return null;
    const failures = typeof raw.failures === 'number' && Number.isInteger(raw.failures) && raw.failures >= 0 ? raw.failures : 0;
    return { version: raw.version, at: typeof raw.at === 'number' ? raw.at : 0, failures, seen: raw.seen === true };
  } catch { return null; }
}

// ─── macOS swap helper ──────────────────────────────────────────────────────

/**
 * The helper, as FIXED script text. It is never built from paths: they arrive as positional arguments
 * ($1..$8), so a space or a quote in one cannot change what runs (design §4). Used twice: as the user
 * (writable bundle) and as root (the one password box, started through osascript).
 *
 *   $1 pid of the app   $2 the installed bundle   $3 the staged new bundle   $4 the go file
 *   $5 what to delete when finished (the staged app, or its private folder)
 *   $6 'user' | 'root'  $7 the running app's designated requirement (root re-checks it)  $8 the user's uid
 *
 * It waits for the app to EXIT, then looks for the go file (rev 4 F2): present = swap, absent = delete the
 * staging and stop. So a held Restart, a crash, a SIGTERM or a plain quit with the switch off never swaps.
 * It gives up after 24 h. Any failed step puts the old bundle back.
 * The YC_* variables are test seams only (a Linux runner has no codesign/open); osascript's root shell
 * starts with a clean environment, so they cannot reach the real run.
 */
export const MAC_HELPER_SCRIPT = `
pid="$1"; old="$2"; staged="$3"; go="$4"; cleanup="$5"; mode="$6"; req="$7"; uid="$8"
tick="\${YC_SLEEP:-1}"; limit="\${YC_MAX_WAIT:-86400}"
n=0
while kill -0 "$pid" 2>/dev/null; do
  n=$((n + 1))
  [ "$n" -gt "$limit" ] && exit 0
  sleep "$tick"
done
if [ ! -f "$go" ]; then rm -rf "$cleanup"; exit 0; fi
action=$(head -n 1 "$go")
rm -f "$go"
bak="$old.bak"
fail() { rm -rf "$cleanup"; exit 1; }
[ -d "$staged" ] && [ -d "$old" ] || fail
if [ "$mode" = root ]; then
  owner=$(ls -dn "$old" | awk '{print $3":"$4}')
  \${YC_CHOWN:-chown} root:wheel "$cleanup" || fail
  chmod 700 "$cleanup" || fail
  \${YC_CHOWN:-chown} -R root:wheel "$staged" || fail
  \${YC_CODESIGN:-codesign} --verify --deep --strict -R="$req" "$staged" || fail
fi
rm -rf "$bak"
\${YC_MV:-mv} "$old" "$bak" || fail
if \${YC_MV:-mv} "$staged" "$old"; then
  if [ "$mode" = root ]; then \${YC_CHOWN:-chown} -R "$owner" "$old" || true; fi
  rm -rf "$bak"
else
  rm -rf "$old"
  mv "$bak" "$old"
  fail
fi
rm -rf "$cleanup"
if [ "$action" = relaunch ]; then
  if [ "$mode" = root ]; then \${YC_LAUNCHCTL:-launchctl} asuser "$uid" \${YC_OPEN:-open} "$old"; else \${YC_OPEN:-open} "$old"; fi
fi
exit 0
`;

export interface MacHelperInput {
  pid: number;
  oldBundle: string;
  staged: string;
  mode: 'user' | 'root';
  /** The running app's `designated =>` requirement (root mode checks the staged app against it). */
  requirement?: string;
  uid: number;
}

/** Where the go file lives and what the helper deletes, by where the staged app sits. */
export function macGoPaths(staged: string): { goFile: string; cleanup: string; mode: 'user' | 'root' } {
  // Password case: `<tmp>/youcoded-update-<v>/YouCoded.app` in a mode-700 folder that holds the go file too.
  if (path.basename(staged) === 'YouCoded.app' && path.basename(path.dirname(staged)).startsWith('youcoded-update-')) {
    const folder = path.dirname(staged);
    return { goFile: path.join(folder, 'go'), cleanup: folder, mode: 'root' };
  }
  // Writable case: the hidden `.YouCoded-update-<v>.app` beside the bundle; its go file is a sibling (the
  // startup sweep removes both, and nothing is ever written INSIDE the staged bundle: that breaks its seal).
  return { goFile: staged + '.go', cleanup: staged, mode: 'user' };
}

/** `sh -c <script> sh <args…>`: the argv for /bin/sh. */
export function macHelperArgv(i: MacHelperInput): string[] {
  const g = macGoPaths(i.staged);
  return ['-c', MAC_HELPER_SCRIPT, 'sh', String(i.pid), i.oldBundle, i.staged, g.goFile, g.cleanup, i.mode, i.requirement ?? 'none', String(i.uid)];
}

/**
 * The administrator start: ONE osascript call that raises the Mac's own password box and starts the
 * same helper as root, in the background, returning at once. The AppleScript is fixed text; the helper
 * script and every path ride as arguments and are quoted by AppleScript's own `quoted form of`.
 * Every argument is non-empty and none starts with "-" (osascript would read that as its own option).
 */
export function macRootStartArgs(i: MacHelperInput): string[] {
  const argv = macHelperArgv({ ...i, mode: 'root' }).slice(1); // [script, 'sh', pid, …]
  const [script, , ...rest] = argv;
  return [
    '-e', 'on run argv',
    '-e', 'set cmd to "/bin/sh -c " & quoted form of (item 1 of argv) & " sh"',
    '-e', 'repeat with i from 2 to (count of argv)',
    '-e', 'set cmd to cmd & " " & quoted form of (item i of argv)',
    '-e', 'end repeat',
    '-e', 'do shell script (cmd & " >/dev/null 2>&1 &") with administrator privileges',
    '-e', 'end run',
    script, ...rest,
  ];
}
