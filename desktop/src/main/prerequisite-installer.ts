import { execFile, execSync, spawn, ExecFileOptions } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import fs from 'fs';
import https from 'https';
import crypto from 'crypto';
import { app } from 'electron';
import { log } from './logger';

/**
 * ANSI CSI/OSC/SGR stripper.
 * `claude auth login` inside a PTY emits colored/styled output; stripping makes
 * URL regex matching robust across CLI versions that decorate the link.
 */
function stripAnsi(s: string): string {
  // Covers CSI (ESC [...m and friends), OSC (ESC ]...BEL/ST), and stray ESC-sequences.
  return s
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '');
}

const execFileAsync = promisify(execFile);

// Optional — which may not be installed; fall back to bare command name
let whichSync: ((cmd: string) => string) | null = null;
try { const w = require('which'); whichSync = w.sync; } catch { /* noop */ }

/**
 * EINVAL-safe wrapper around execFile.
 *
 * Why: Node 18.20.2+ / 20.12.2+ / 21.7.1+ ship the CVE-2024-27980 mitigation,
 * which makes `child_process.spawn` / `execFile` REFUSE to launch `.cmd`/`.bat`
 * files on Windows unless `shell: true` is passed — failure surfaces as
 * `Error: spawn EINVAL`. `npm`, `claude` (when installed via npm), and many
 * other Node-CLI shims are `.cmd` files on Windows, so we route every
 * subprocess through this helper to flip `shell: true` automatically when the
 * resolved path's extension demands it. Real `.exe` paths take the standard
 * no-shell route so we keep the no-shell-injection guarantee for those.
 *
 * Args we pass here are static or already-validated strings (npm package name,
 * git URL, version flags, base64-ish API key) — none contain `cmd.exe`
 * metacharacters (& | > < ^ %), so `shell: true`'s relaxed quoting is safe.
 */
/**
 * Pure shell-flag decision for {@link runCommand} — exported for pinning tests.
 * Returns true ONLY on Windows AND when the resolved command is a `.cmd`/`.bat`
 * shim (the CVE-2024-27980 EINVAL case). Real `.exe`/bare paths return false so
 * they keep the no-shell (`shell:false`) no-injection guarantee. Extracted so a
 * unit test can pin the decision without spawning real processes.
 */
export function shouldUseShell(cmd: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
}

function runCommand(
  cmd: string,
  args: string[] = [],
  opts: ExecFileOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const needsShell = shouldUseShell(cmd, process.platform);
  // Cast: we never pass `encoding: 'buffer'`, so stdout/stderr are strings.
  // The `shell: boolean` field is supported at runtime but the overloads in
  // @types/node default to the buffer-or-string union, so we narrow it here.
  return execFileAsync(cmd, args, { ...opts, shell: needsShell }) as Promise<{
    stdout: string;
    stderr: string;
  }>;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DetectionResult {
  installed: boolean;
  version?: string;
  path?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// User-local install layout (macOS + Linux)
//
// Node's official macOS .pkg requires admin (sudo) and does not honor
// `-target CurrentUserHomeDirectory` — the pkg isn't authored for per-user
// install, so `installer` exits non-zero for a normal user. On Linux, a
// distro-package-manager install (apt/dnf/pacman) would each need sudo plus
// distro detection. We sidestep both by extracting the official prebuilt
// tarball to a user-writable dir and persisting it to PATH ourselves, so no
// admin prompt and no package manager is ever needed.
// ---------------------------------------------------------------------------

// v24.21.0 is the current LTS; v20 reached end-of-life in April 2026 (bumped 2026-10-02, all platforms).
const NODE_VERSION = 'v24.21.0';
// Pinned, NOT "latest": the download URL interpolates the version into the
// asset filename (gh_<ver>_macOS_arm64.zip), so there is no /latest/ URL that
// yields a predictable name, and resolving it at runtime would make the
// installer depend on the GitHub API being reachable and unauthenticated.
// Bump deliberately; the only constraint is that the release still publishes
// the macOS .zip / Linux .tar.gz assets this installer expects.
const GH_VERSION = '2.96.0';
const PATH_MARKER = '# Added by YouCoded first-run installer';

/** Root dir for YouCoded-managed user-local tools (macOS: ~/Library/..., Linux: ~/.youcoded). */
function youcodedDataDir(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'YouCoded');
  }
  return path.join(os.homedir(), '.youcoded');
}

/** Where we extract Node's tarball (macOS + Linux). */
function userLocalNodeDir(): string {
  return path.join(youcodedDataDir(), 'node');
}

/**
 * Bin dir for single-binary tools we install user-locally (currently just `gh`).
 * Deliberately NOT `userLocalNodeBinDir()` — that dir is owned by the Node
 * tarball extraction, which uses `--strip-components=1` into `userLocalNodeDir()`
 * and would clobber anything else living there on a Node reinstall.
 */
function userLocalToolsBinDir(): string {
  return path.join(youcodedDataDir(), 'bin');
}

/** Node's bin dir (contains node, npm, npx — and later, claude from `npm i -g`). */
function userLocalNodeBinDir(): string {
  return path.join(userLocalNodeDir(), 'bin');
}

/** Prepend `dir` to process.env.PATH if not already present. */
function prependToProcessPath(dir: string): void {
  const sep = process.platform === 'win32' ? ';' : ':';
  const current = process.env.PATH ?? '';
  if (!current.split(sep).includes(dir)) {
    process.env.PATH = `${dir}${sep}${current}`;
  }
}

/**
 * Append an idempotent PATH export to common POSIX shell profiles so
 * interactive shells (and PTY sessions the app spawns) see the new bin dir.
 * Best-effort — failures on any single file are logged, not fatal.
 */
function persistPathToShellProfiles(dir: string): void {
  if (process.platform === 'win32') return;
  const home = os.homedir();
  const bashLine = `export PATH="${dir}:$PATH"`;

  // Fix (v1.2.4): fish does not understand POSIX `export PATH=...` syntax, so a
  // fish user (increasingly common on Linux) would lose the new Node bin dir on
  // every shell restart. fish uses `set -gx PATH ...` and its config lives at
  // ~/.config/fish/config.fish. Only touch the fish config when fish is
  // plausibly the user's shell (file already exists, or $SHELL points at fish)
  // so we don't scatter fish config onto non-fish users' machines.
  const fishConfig = path.join(home, '.config', 'fish', 'config.fish');
  const usesFish =
    (process.env.SHELL ?? '').endsWith('/fish') || fs.existsSync(fishConfig);

  const targets: Array<{ file: string; line: string }> = [
    { file: path.join(home, '.zshrc'), line: bashLine },
    { file: path.join(home, '.bash_profile'), line: bashLine },
    { file: path.join(home, '.bashrc'), line: bashLine },
  ];
  if (usesFish) {
    targets.push({ file: fishConfig, line: `set -gx PATH "${dir}" $PATH` });
  }

  for (const { file, line } of targets) {
    try {
      let existing = '';
      try { existing = fs.readFileSync(file, 'utf8'); } catch { /* file doesn't exist — that's fine */ }
      if (existing.includes(PATH_MARKER)) continue;
      // mkdir -p the parent so ~/.config/fish/ is created for a fish user who
      // has never written a config.fish. No-op for the home-dir profiles.
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `\n${PATH_MARKER}\n${line}\n`, 'utf8');
      log('INFO', 'prereq', `Added Node bin to PATH in ${path.basename(file)}`);
    } catch (err) {
      log('WARN', 'prereq', `Could not update ${file}`, { error: String(err) });
    }
  }
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Resolves the absolute path to reg.exe on Windows.
 * Hardcoding System32 prevents relying on the app's potentially stale or
 * corrupted environment PATH to find the registry tool.
 */
// exported for pinning tests (the quoted/unquoted asymmetry vs getPowerShellPath is load-bearing)
export function getRegPath(): string {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const regPath = path.join(systemRoot, 'System32', 'reg.exe');
  return fs.existsSync(regPath) ? `"${regPath}"` : 'reg';
}

/**
 * Resolves the absolute path to powershell.exe on Windows.
 * Prevents relying on the app's potentially stale or corrupted environment PATH
 * to find PowerShell for first-run bootstrapping.
 *
 * Fix: must return the path UNQUOTED. `getRegPath` returns a quoted path because
 * it's interpolated into a `execSync(string)` template that cmd.exe parses; this
 * helper is consumed via `runCommand(ps, args)` → `execFile(ps, args)` which
 * passes the literal string to CreateProcess. Embedded quotes become part of
 * the filename and CreateProcess fails with ENOENT — verified empirically on
 * 2026-05-21 (the bug shipped briefly in the first PATH-hardening pass).
 */
// exported for pinning tests (must stay UNQUOTED — see the WHY comment above)
export function getPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const psPath = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(psPath) ? psPath : 'powershell';
}

/**
 * Absolute path where Anthropic's native installer drops the Claude Code
 * launcher: `%USERPROFILE%\.local\bin\claude.exe` on Windows, `~/.local/bin/claude`
 * on POSIX (verified empirically 2026-05-30 against a real install).
 *
 * Why this exists: the installer registers that bin dir on the *user* PATH
 * (HKCU on Windows, shell rc on POSIX), but a still-running process — including
 * YouCoded itself — keeps its launch-time PATH snapshot. So immediately after a
 * successful install, `which claude` misses and detection wrongly reports
 * not-installed, dead-ending the user (a real friend hit exactly this: "claude
 * is not recognized" in a shell opened before the PATH write). detectClaude()
 * falls back to this absolute path so a fresh install is recognized without an
 * app restart.
 */
function claudeInstallPath(): string {
  const home = os.homedir();
  return process.platform === 'win32'
    ? path.join(home, '.local', 'bin', 'claude.exe')
    : path.join(home, '.local', 'bin', 'claude');
}

/**
 * `claude` on PATH, else the native installer's absolute path when it is on disk.
 *
 * WHY (first-run local models, 2026-09-14): Claude Code now installs after the
 * "Log in with Claude" click, inside THIS running process, whose PATH snapshot
 * predates the install — and the login spawns `claude` a moment later. The same
 * fallback detectClaude() already uses, for the three callers that spawn it.
 */
function resolveClaudeCommand(): string {
  const onPath = resolveCommand('claude');
  if (onPath !== 'claude') return onPath;
  const installed = claudeInstallPath();
  return fs.existsSync(installed) ? installed : onPath;
}

/** The dir Anthropic's bootstrap downloads the versioned binary into before installing. */
function claudeDownloadsDir(): string {
  return path.join(os.homedir(), '.claude', 'downloads');
}

/**
 * True when an error message indicates a Windows sharing violation / file-in-use
 * lock (ERROR_SHARING_VIOLATION / ERROR_LOCK_VIOLATION / EBUSY). The native
 * bootstrap's `Invoke-WebRequest -OutFile` opens the download target for
 * exclusive write; if a concurrent install attempt, a leftover partial, or an
 * antivirus real-time scan is holding that file, the open fails with this class
 * of error. These locks are typically transient, so installClaude() retries.
 */
export function isFileLockError(msg: string): boolean {
  return /being used by another process|cannot access the file|sharing violation|lock violation|EBUSY|ERROR_SHARING_VIOLATION/i.test(
    msg,
  );
}

/**
 * True when `err` is a spawn-time "executable not found on PATH" failure.
 * Node sets the STRING code 'ENOENT' on the error when the binary itself is
 * missing; a process that launched but exited non-zero gets a NUMERIC exit
 * code instead, so this never misfires on script failures inside the child.
 * Exported for pinning tests.
 */
export function isSpawnEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Best-effort removal of stale/partial Claude binaries left in the downloads dir
 * by a prior failed attempt. A leftover `claude-<v>-<plat>.exe` is the most
 * common thing an antivirus scanner or interrupted download leaves locked, and
 * the bootstrap overwrites blindly (no in-use check), so clearing it first
 * removes the collision target. Never throws — a missing dir or a still-locked
 * file just means we proceed and let the retry loop handle it.
 */
function cleanStaleClaudeDownloads(): void {
  try {
    const dir = claudeDownloadsDir();
    for (const name of fs.readdirSync(dir)) {
      if (/^claude-.*\.exe$/i.test(name) || /^claude-/i.test(name)) {
        try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* still locked — let retry handle it */ }
      }
    }
  } catch { /* dir doesn't exist yet — nothing to clean */ }
}

/**
 * Builds the PATH that refreshPath() installs, from the registry's raw User and System values.
 *
 * WHY expand %VARS%: both registry values are usually REG_EXPAND_SZ, holding entries like
 * `%SystemRoot%\system32` and `%USERPROFILE%\AppData\Local\Microsoft\WindowsApps`. `reg query`
 * prints them unexpanded, and Windows does not expand them when searching PATH, so copying them
 * in as-is dropped System32 and WindowsApps (where winget lives) from the app's PATH. Seen in the
 * clean Windows 11 VM on 2026-10-02: winget installed Node, refreshPath ran, and the very next
 * step failed "spawn winget ENOENT", so setup dead-ended at Git with "winget is missing".
 *
 * WHY keep the current PATH's other entries after the registry's: the app's launch-time PATH
 * can hold folders the registry doesn't list (added by the launcher or by us, e.g. Claude's
 * bin dir); dropping them breaks tools that were working a moment ago. Registry entries come
 * first so freshly installed tools win; duplicates are dropped case-insensitively (Windows paths).
 */
export function buildRefreshedPath(
  userPath: string,
  systemPath: string,
  currentPath: string,
  env: NodeJS.ProcessEnv,
): string {
  // Windows variable names are case-insensitive; Node's process.env already is on Windows,
  // but a plain object (tests, or a copied env) is not, so look names up case-insensitively.
  const lookup = (name: string): string | undefined => {
    if (env[name] !== undefined) return env[name];
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? env[key] : undefined;
  };
  // An unknown %NAME% is left as written, which is what Windows itself does.
  const expand = (entry: string) => entry.replace(/%([^%;]+)%/g, (m, name: string) => lookup(name) ?? m);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [userPath, systemPath, currentPath].join(';').split(';')) {
    const entry = expand(raw.trim());
    if (!entry) continue;
    const key = entry.replace(/[\\/]+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out.join(';');
}

/**
 * On Windows, re-reads User and System PATH from the registry so that
 * freshly-installed tools are visible without restarting the app.
 * On macOS/Linux this is a no-op — main.ts already prepends common paths.
 *
 * NOTE: Uses execSync with hardcoded registry query strings — no user input
 * is interpolated. This is intentional; execFile cannot run reg queries that
 * need shell parsing of the output format.
 */
function refreshPath(): void {
  if (process.platform !== 'win32') return;

  try {
    const reg = getRegPath();
    const userPath = execSync(
      `${reg} query "HKCU\\Environment" /v Path`,
      { encoding: 'utf8' },
    )
      .split('\n')
      .find((l) => l.includes('REG_'))
      ?.replace(/.*REG_(EXPAND_)?SZ\s+/i, '')
      .trim() ?? '';

    const systemPath = execSync(
      `${reg} query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v Path`,
      { encoding: 'utf8' },
    )
      .split('\n')
      .find((l) => l.includes('REG_'))
      ?.replace(/.*REG_(EXPAND_)?SZ\s+/i, '')
      .trim() ?? '';

    process.env.PATH = buildRefreshedPath(userPath, systemPath, process.env.PATH ?? '', process.env);
    // The Claude Code native installer does not always register its bin dir
    // (%USERPROFILE%\.local\bin) on the user PATH — verified 2026-05-30, a real
    // install printed "Native installation exists but ...\.local\bin is not in
    // your PATH". Rebuilding PATH from the registry above would then leave
    // claude unresolvable. Re-prepend the bin dir so which.sync() (detection)
    // and forked pty-worker spawns (session launch) both find claude.exe.
    prependToProcessPath(path.dirname(claudeInstallPath()));
    log('INFO', 'prereq', 'PATH refreshed from registry');
  } catch (err) {
    log('WARN', 'prereq', 'Failed to refresh PATH from registry', {
      error: String(err),
    });
  }
}

/** Resolve a command name to its full path via `which`, or return bare name. */
export function resolveCommand(cmd: string): string {
  if (whichSync) {
    try {
      return whichSync(cmd);
    } catch { /* not found */ }
  }
  return cmd;
}

/**
 * Download a file via HTTPS, following 301/302 redirects.
 * Returns a Promise that resolves when writing is complete.
 */
function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = (targetUrl: string) => {
      https.get(targetUrl, (res) => {
        // Follow redirects
        if (
          [301, 302, 303, 307, 308].includes(res.statusCode ?? 0) &&
          res.headers.location
        ) {
          res.resume(); // drop the redirect body so the socket is freed
          request(res.headers.location);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} downloading ${targetUrl}`));
          return;
        }

        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => resolve());
        });
        file.on('error', (err) => {
          fs.unlink(dest, () => {}); // best-effort cleanup
          reject(err);
        });
      }).on('error', reject);
    };

    request(url);
  });
}

// ---------------------------------------------------------------------------
// Detection functions
// ---------------------------------------------------------------------------

/** Detect Node.js >= 18. */
export async function detectNode(): Promise<DetectionResult> {
  try {
    const nodePath = resolveCommand('node');
    const { stdout } = await runCommand(nodePath, ['--version']);
    const version = stdout.trim(); // e.g. "v20.19.0"
    const major = parseInt(version.replace(/^v/, ''), 10);

    if (major < 18) {
      return {
        installed: false,
        version,
        path: nodePath,
        error: `Node.js ${version} is too old (need >= 18)`,
      };
    }

    log('INFO', 'prereq', `Node.js detected: ${version}`);
    return { installed: true, version, path: nodePath };
  } catch (err) {
    return { installed: false, error: String(err) };
  }
}

/** Detect Git. */
export async function detectGit(): Promise<DetectionResult> {
  try {
    const gitPath = resolveCommand('git');
    const { stdout } = await runCommand(gitPath, ['--version']);
    const version = stdout.trim();
    log('INFO', 'prereq', `Git detected: ${version}`);
    return { installed: true, version, path: gitPath };
  } catch (err) {
    return { installed: false, error: String(err) };
  }
}

/** Detect Claude Code CLI. */
export async function detectClaude(): Promise<DetectionResult> {
  // Resolve via PATH first (covers npm/global installs and a propagated PATH).
  // Fall back to the native installer's known absolute path so a brand-new
  // install is recognized even when its bin dir hasn't propagated to this
  // process's PATH yet — see claudeInstallPath() for the why.
  const candidates = [resolveCommand('claude')];
  const absolute = claudeInstallPath();
  if (!candidates.includes(absolute) && fs.existsSync(absolute)) {
    candidates.push(absolute);
  }

  let lastErr = 'claude not found';
  for (const claudePath of candidates) {
    try {
      const { stdout } = await runCommand(claudePath, ['--version']);
      const version = stdout.trim();
      log('INFO', 'prereq', `Claude Code detected: ${version}`, { path: claudePath });
      return { installed: true, version, path: claudePath };
    } catch (err) {
      lastErr = String(err);
    }
  }
  return { installed: false, error: lastErr };
}

/** Detect whether Claude Code is authenticated. */
export async function detectAuth(): Promise<DetectionResult> {
  try {
    const claudePath = resolveClaudeCommand();
    const { stdout } = await runCommand(claudePath, ['auth', 'status']);
    // claude auth status exits 0 even when not logged in — parse the JSON
    const parsed = JSON.parse(stdout.trim());
    if (parsed.loggedIn === true) {
      log('INFO', 'prereq', 'Auth status: authenticated', { email: parsed.email });
      return { installed: true, version: parsed.email || 'authenticated' };
    }
    return { installed: false, error: 'Not logged in' };
  } catch (err) {
    return { installed: false, error: String(err) };
  }
}

/**
 * Detect winget on Windows.
 *
 * WHY: winget is an MSIX App Execution Alias, not a standard Win32 PE binary.
 * If the Windows "App Installer" package is missing or disabled by policy, winget
 * does not exist on the machine. Upfront detection provides a clear, actionable
 * warning to Destin's users instead of failing with a cryptic "spawn ENOENT" error.
 */
export async function detectWinget(): Promise<DetectionResult> {
  if (process.platform !== 'win32') {
    return { installed: true };
  }
  try {
    const wingetPath = resolveCommand('winget');
    // We execute `winget --version` to verify that the execution alias is active
    // and working, rather than just checking if the command name resolves.
    const { stdout } = await runCommand(wingetPath, ['--version']);
    const version = stdout.trim();
    log('INFO', 'prereq', `winget detected: ${version}`);
    return { installed: true, version, path: wingetPath };
  } catch (err) {
    log('WARN', 'prereq', 'winget detection failed', { error: String(err) });
    return {
      installed: false,
      error:
        'winget (App Installer) is missing, disabled, or not on your system PATH. ' +
        'Please install App Installer from the Microsoft Store (https://aka.ms/getwinget) ' +
        'or enable it in Windows Settings / Policy, then try again.',
    };
  }
}

// ---------------------------------------------------------------------------
// Installation functions
// ---------------------------------------------------------------------------

/**
 * True on musl-libc Linux (Alpine, etc.). The official nodejs.org prebuilt
 * tarballs are glibc-linked and fail to exec on musl, so installNode() must
 * bail early with actionable guidance rather than "succeed" and then fail the
 * post-install detectNode() with an opaque error. musl ships its loader as
 * /lib/ld-musl-<arch>.so.1; glibc does not.
 */
function isMuslLinux(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    return fs.readdirSync('/lib').some((f) => f.startsWith('ld-musl-'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Direct-download installs (Node on every platform, Git on Windows)
//
// WHY no winget (Destin, 2026-10-02): winget is missing on Windows Server, LTSC and many
// school/work PCs (Store blocked), which dead-ended setup. macOS/Linux already extract an
// official archive into a user folder with no admin prompt; Windows now does the same. Every
// archive is pinned to a sha256 and verified BEFORE it is extracted or run, so a tampered or
// truncated download is rejected instead of executed.
// ---------------------------------------------------------------------------

export interface DownloadAsset {
  url: string;
  name: string;
  sha256: string;
}

// Hashes copied from https://nodejs.org/dist/v24.21.0/SHASUMS256.txt (verified by Destin 2026-10-02).
const NODE_SHA256: Record<string, string> = {
  'darwin-arm64.tar.gz': 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057',
  'darwin-x64.tar.gz': '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097',
  'linux-arm64.tar.gz': '724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5',
  'linux-x64.tar.gz': '6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff',
  'win-arm64.zip': '8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921',
  'win-x64.zip': '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541',
};

const GIT_WIN_VERSION = 'v2.56.0.windows.1';
const GIT_WIN_SHA256: Record<string, string> = {
  '64-bit': 'eceb5e061aa90df2f69ddd3e90f0030e1b8037a7829934bc40e4be1caa1accc1',
  arm64: 'edd9bd32aefa5d2bd4b938c38c18ceca306a7f6b29a6951cd6a4bb16d9d28d8f',
};

/** Node archive for a platform/arch, or null when we ship no pinned build for it. Pure. */
export function nodeAsset(platform: NodeJS.Platform, arch: string): DownloadAsset | null {
  const a = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null;
  if (!a) return null;
  let key: string;
  if (platform === 'win32') key = `win-${a}.zip`;
  else if (platform === 'darwin' || platform === 'linux') key = `${platform}-${a}.tar.gz`;
  else return null;
  const sha256 = NODE_SHA256[key];
  if (!sha256) return null;
  const name = `node-${NODE_VERSION}-${key}`;
  return { name, url: `https://nodejs.org/dist/${NODE_VERSION}/${name}`, sha256 };
}

/** Portable Git (7-Zip self-extractor with bash — NOT MinGit, which has no bash) for Windows. Pure. */
export function gitWindowsAsset(arch: string): DownloadAsset | null {
  const tag = arch === 'arm64' ? 'arm64' : arch === 'x64' ? '64-bit' : null;
  if (!tag) return null;
  const name = `PortableGit-${GIT_WIN_VERSION.replace(/^v/, '').replace(/\.windows\.\d+$/, '')}-${tag}.7z.exe`;
  return {
    name,
    url: `https://github.com/git-for-windows/git/releases/download/${GIT_WIN_VERSION}/${name}`,
    sha256: GIT_WIN_SHA256[tag],
  };
}

/** Non-blocking existence check (this runs in the main process; no *Sync calls). */
async function pathExists(p: string): Promise<boolean> {
  try { await fs.promises.access(p); return true; } catch { return false; }
}

/** sha256 (hex) of a file, streamed so a 60 MB archive is not held in memory. */
function sha256OfFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/** True when the file's sha256 equals `expected` (case-insensitive). */
export async function fileMatchesSha256(file: string, expected: string): Promise<boolean> {
  return (await sha256OfFile(file)).toLowerCase() === expected.toLowerCase();
}

/**
 * Download `asset` to `dest` and check its sha256. On mismatch (or a failed download) the file is
 * deleted and an Error with a plain message is thrown, so nothing unverified is ever extracted/run.
 */
async function downloadVerified(asset: DownloadAsset, dest: string): Promise<void> {
  try {
    await downloadFile(asset.url, dest);
  } catch (err) {
    await fs.promises.rm(dest, { force: true });
    throw err;
  }
  if (!(await fileMatchesSha256(dest, asset.sha256))) {
    await fs.promises.rm(dest, { force: true });
    throw new Error(
      `The downloaded ${asset.name} did not match its expected checksum, so it was discarded. ` +
      'Check your connection (a school/work network can alter downloads), then click Try Again.',
    );
  }
}

/**
 * New user-PATH value with `dir` prepended, or null when it is already listed
 * (case-insensitive, trailing slash ignored). Pure so the registry write can be pinned in tests.
 * Entries are kept verbatim — they may hold %VARS% that must stay unexpanded (REG_EXPAND_SZ).
 */
export function mergeUserPath(current: string, dir: string): string | null {
  const norm = (p: string) => p.trim().replace(/[\\/]+$/, '').toLowerCase();
  const entries = current.split(';').filter((e) => e.trim() !== '');
  if (entries.some((e) => norm(e) === norm(dir))) return null;
  return [dir, ...entries].join(';');
}

/** `%LOCALAPPDATA%\YouCoded` — where Windows Node and Git live (no admin needed). */
export function windowsToolsRoot(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const local = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
  return path.win32.join(local, 'YouCoded');
}

/** Folders to put on PATH for the Windows installs. Pure. */
export function windowsNodeDir(root: string): string { return path.win32.join(root, 'node'); }
export function windowsGitCmdDir(root: string): string { return path.win32.join(root, 'git', 'cmd'); }

/**
 * Persist `dir` on the user's PATH (HKCU\Environment\Path) without flattening REG_EXPAND_SZ entries.
 * WHY PowerShell + registry API instead of `setx`: setx expands %VARS% and truncates at 1024
 * characters, silently corrupting a long PATH. The dir travels in an environment variable, never
 * spliced into script text. Best-effort: a failure is logged, because this process's PATH is
 * already updated and main.ts re-adds the dirs at every launch.
 */
async function persistUserPathWindows(dir: string): Promise<void> {
  try {
    const ps = getPowerShellPath();
    const base = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
    const read =
      "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$false);" +
      "$v=$k.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);" +
      'if($v -ne $null){[Console]::Out.Write($v)}';
    const { stdout } = await runCommand(ps, [...base, read], { timeout: 30000 });
    const merged = mergeUserPath(stdout.trim(), dir);
    if (merged === null) return; // already on the user PATH
    // The SetEnvironmentVariable call below only exists to make Windows broadcast
    // WM_SETTINGCHANGE so Explorer and newly opened terminals pick the new PATH up.
    const write =
      "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true);" +
      "$k.SetValue('Path',$env:YOUCODED_NEW_PATH,[Microsoft.Win32.RegistryValueKind]::ExpandString);" +
      "$k.Close();[Environment]::SetEnvironmentVariable('YOUCODED_PATH_REFRESH',$null,'User')";
    await runCommand(ps, [...base, write], {
      timeout: 30000,
      env: { ...process.env, YOUCODED_NEW_PATH: merged },
    });
    log('INFO', 'prereq', `Added ${dir} to the user PATH`);
  } catch (err) {
    log('WARN', 'prereq', `Could not save ${dir} to the user PATH`, { error: String(err) });
  }
}

/** Windows' own tar.exe (bsdtar reads .zip). A tar on PATH may be Git's GNU tar, which misreads `C:` paths. */
async function windowsTarPath(): Promise<string> {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const p = path.join(systemRoot, 'System32', 'tar.exe');
  return await pathExists(p) ? p : 'tar';
}

/**
 * Move a fully-extracted staging folder into place. Retries because antivirus often holds the
 * freshly written files for a moment (EPERM/EBUSY), and removes any previous copy first.
 * WHY staging+rename: a half-extracted folder at the final path would look "installed".
 */
async function moveIntoPlace(staging: string, finalDir: string): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < 6; i++) {
    try {
      await fs.promises.rm(finalDir, { recursive: true, force: true });
      await fs.promises.rename(staging, finalDir);
      return;
    } catch (err) {
      lastErr = err;
      await delay(1000);
    }
  }
  throw lastErr;
}

async function installNodeWindows(): Promise<{ success: boolean; error?: string } | null> {
  // "Already there": a Node the user installed themselves (or an earlier run) is used as-is.
  refreshPath();
  const root = windowsToolsRoot();
  const nodeDir = windowsNodeDir(root);
  if (await pathExists(path.join(nodeDir, 'node.exe'))) prependToProcessPath(nodeDir);
  const before = await detectNode();
  if (before.installed) {
    log('INFO', 'prereq', `Node.js already installed: ${before.version}`);
    return { success: true };
  }

  const asset = nodeAsset('win32', process.arch);
  if (!asset) return { success: false, error: `No Node.js download for Windows on ${process.arch}.` };
  const zip = path.join(os.tmpdir(), asset.name);
  const staging = `${nodeDir}.staging`;
  await downloadVerified(asset, zip);
  try {
    await fs.promises.rm(staging, { recursive: true, force: true });
    await fs.promises.mkdir(staging, { recursive: true });
    // --strip-components=1 peels the top-level node-vX-win-<arch>/ folder.
    await runCommand(await windowsTarPath(), ['-xf', zip, '-C', staging, '--strip-components=1'], { timeout: 300000 });
    await moveIntoPlace(staging, nodeDir);
  } finally {
    await fs.promises.rm(zip, { force: true });
    await fs.promises.rm(staging, { recursive: true, force: true });
  }
  prependToProcessPath(nodeDir);
  await persistUserPathWindows(nodeDir);
  return null; // caller runs the usual post-install detection
}

async function installGitWindows(): Promise<{ success: boolean; error?: string } | null> {
  refreshPath();
  const root = windowsToolsRoot();
  const gitRoot = path.win32.join(root, 'git');
  const cmdDir = windowsGitCmdDir(root);
  if (await pathExists(path.join(cmdDir, 'git.exe'))) prependToProcessPath(cmdDir);
  const before = await detectGit();
  if (before.installed) {
    log('INFO', 'prereq', `Git already installed: ${before.version}`);
    return { success: true };
  }

  const asset = gitWindowsAsset(process.arch);
  if (!asset) return { success: false, error: `No Git download for Windows on ${process.arch}.` };
  const exe = path.join(os.tmpdir(), asset.name);
  const staging = `${gitRoot}.staging`;
  await downloadVerified(asset, exe);
  try {
    await fs.promises.rm(staging, { recursive: true, force: true });
    await fs.promises.mkdir(path.dirname(staging), { recursive: true });
    // The .7z.exe is a 7-Zip self-extractor: -o<dir> sets the target, -y answers every prompt.
    await runCommand(exe, [`-o${staging}`, '-y'], { timeout: 600000 });
    if (!await pathExists(path.join(staging, 'cmd', 'git.exe'))) {
      throw new Error('Git unpacked without its programs (cmd\\git.exe is missing).');
    }
    await moveIntoPlace(staging, gitRoot);
  } finally {
    await fs.promises.rm(exe, { force: true });
    await fs.promises.rm(staging, { recursive: true, force: true });
  }
  prependToProcessPath(cmdDir);
  await persistUserPathWindows(cmdDir);
  return null;
}

/**
 * Poll `detect` until it reports installed or `timeoutMs` passes. Injectable clock/sleep so the
 * test needs no real waiting. Returns the detection result, or null on timeout.
 */
export async function pollUntilInstalled(
  detect: () => Promise<DetectionResult>,
  opts: { intervalMs: number; timeoutMs: number; sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<DetectionResult | null> {
  const sleep = opts.sleep ?? delay;
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.timeoutMs;
  for (;;) {
    const r = await detect();
    if (r.installed) return r;
    if (now() >= deadline) return null;
    await sleep(opts.intervalMs);
  }
}

// WHY module-level: "Try Again" (or a second run) while Apple's installer is still pending must
// join the one poll already running, never start another.
let macGitWait: Promise<{ success: boolean; error?: string }> | null = null;
const MAC_GIT_POLL_MS = 5000;
const MAC_GIT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * macOS Git check that never pops Apple's dialog. WHY: without the Command Line Tools,
 * /usr/bin/git is Apple's stub, and running it can open the "install developer tools" prompt —
 * every 5 s while we wait. `xcode-select -p` only answers whether the tools are there (it fails
 * with "Unable to get active developer directory" until they are, seen in the macOS VM
 * 2026-10-02), so Git itself is run only once they are.
 */
async function detectGitQuietlyOnMac(): Promise<DetectionResult> {
  try {
    await runCommand('xcode-select', ['-p']);
  } catch {
    return { installed: false };
  }
  return detectGit();
}

/** Copy shown while Apple's Command Line Tools dialog is open (it can hide behind our window). */
const MAC_GIT_WAIT_MESSAGE =
  "Waiting for Apple's installer — click Install in the window Apple opened (it may be behind this one).";

const MAC_GIT_TIMEOUT_ERROR =
  'macOS is installing Command Line Tools. Accept the "Install" prompt ' +
  'in the system dialog, wait for it to finish (a few minutes), then ' +
  'click Try Again.';

/** Install Node.js silently. */
export async function installNode(): Promise<{ success: boolean; error?: string }> {
  try {
    log('INFO', 'prereq', 'Installing Node.js...');

    if (process.platform === 'win32') {
      const early = await installNodeWindows();
      if (early) return early;
    } else if (process.platform === 'darwin' || process.platform === 'linux') {
      // Fix (v1.2.4): the official nodejs.org prebuilt tarballs are glibc-linked
      // and will not exec on musl-libc distros (Alpine). Detect musl up front
      // and surface actionable per-distro guidance — otherwise the tarball
      // "installs" fine and detectNode() fails afterward with an unhelpful
      // "Node.js not found after install".
      if (isMuslLinux()) {
        return {
          success: false,
          error:
            'This looks like a musl-libc Linux distro (e.g. Alpine), which the ' +
            'bundled Node.js installer does not support. Install Node with your ' +
            'package manager, then click Try Again:\n' +
            '  Alpine:  sudo apk add nodejs npm',
        };
      }

      // User-local tarball install — no sudo, no admin prompt, no distro
      // package manager. macOS: Node's .pkg is system-wide only (previous
      // `installer -target CurrentUserHomeDirectory` was rejected by the pkg
      // metadata). Linux: apt/dnf/pacman would each need sudo + distro
      // detection. The official prebuilt tarball sidesteps both.
      const asset = nodeAsset(process.platform, process.arch);
      if (!asset) {
        return { success: false, error: `No Node.js download for ${process.platform} on ${process.arch}.` };
      }
      const tmpTar = path.join(os.tmpdir(), asset.name);
      // WHY verified (2026-10-02): the tarball is extracted into the user's PATH, so an altered
      // download would run as the user. Checked against the pinned sha256 before extraction.
      await downloadVerified(asset, tmpTar);

      const installDir = userLocalNodeDir();
      fs.mkdirSync(installDir, { recursive: true });
      // --strip-components=1 peels the top-level `node-vX.Y.Z-<plat>-<arch>/`
      // directory so bin/ lib/ include/ share/ land directly under installDir.
      await runCommand('tar', [
        '-xzf', tmpTar,
        '-C', installDir,
        '--strip-components=1',
      ], { timeout: 300000 });
      fs.unlink(tmpTar, () => {});

      // Make the new node/npm visible to this process AND to future shells.
      prependToProcessPath(userLocalNodeBinDir());
      persistPathToShellProfiles(userLocalNodeBinDir());
    } else {
      return { success: false, error: `Unsupported platform for Node.js install: ${process.platform}` };
    }

    refreshPath();
    const check = await detectNode();
    if (!check.installed) {
      return { success: false, error: check.error ?? 'Node.js not found after install' };
    }

    log('INFO', 'prereq', `Node.js installed: ${check.version}`);
    return { success: true };
  } catch (err) {
    const msg = String(err);
    log('ERROR', 'prereq', 'Node.js install failed', { error: msg });
    return { success: false, error: msg };
  }
}

/**
 * Install Git silently. `onProgress` lets the caller show a note while a slow, user-driven step
 * (macOS's Command Line Tools dialog) is pending.
 */
export async function installGit(
  onProgress?: (message: string) => void,
): Promise<{ success: boolean; error?: string }> {
  try {
    log('INFO', 'prereq', 'Installing Git...');

    if (process.platform === 'win32') {
      const early = await installGitWindows();
      if (early) return early;
    } else if (process.platform === 'darwin') {
      // `xcode-select --install` pops Apple's dialog, which can sit BEHIND our window, and the
      // install is driven by the user clicking in it. WHY wait instead of failing (Destin,
      // 2026-10-02): returning a failure showed a red "failed" + Try Again for a perfectly
      // normal step. We trigger it once, tell the user what to look for, and poll for Git.
      if (!macGitWait) {
        macGitWait = (async () => {
          try {
            await runCommand('xcode-select', ['--install']);
          } catch {
            log('INFO', 'prereq', 'xcode-select --install triggered dialog (or CLT already present)');
          }
          const found = await pollUntilInstalled(detectGitQuietlyOnMac, {
            intervalMs: MAC_GIT_POLL_MS,
            timeoutMs: MAC_GIT_TIMEOUT_MS,
          });
          return found
            ? { success: true }
            : { success: false, error: MAC_GIT_TIMEOUT_ERROR };
        })().finally(() => { macGitWait = null; });
      }
      onProgress?.(MAC_GIT_WAIT_MESSAGE);
      const result = await macGitWait;
      if (result.success) log('INFO', 'prereq', 'Git installed');
      return result;
    } else if (process.platform === 'linux') {
      // No portable Git tarball exists, and a real install needs root +
      // distro detection (apt/dnf/pacman) — not something to do silently.
      // Git ships preinstalled on most Linux distros, and installMissing()
      // re-detects before calling this, so reaching here means Git is
      // genuinely absent. Surface actionable per-distro guidance instead of
      // a dead-end "unsupported platform" error.
      return {
        success: false,
        error:
          'Install Git with your distribution\'s package manager, then click Try Again:\n' +
          '  Debian / Ubuntu:  sudo apt install git\n' +
          '  Fedora / RHEL:    sudo dnf install git\n' +
          '  Arch:             sudo pacman -S git',
      };
    } else {
      return { success: false, error: `Unsupported platform for Git install: ${process.platform}` };
    }

    refreshPath();
    const check = await detectGit();
    if (!check.installed) {
      return { success: false, error: check.error ?? 'Git not found after install' };
    }

    log('INFO', 'prereq', `Git installed: ${check.version}`);
    return { success: true };
  } catch (err) {
    const msg = String(err);
    log('ERROR', 'prereq', 'Git install failed', { error: msg });
    return { success: false, error: msg };
  }
}

/**
 * Install the GitHub CLI into a user-local bin dir (macOS + Linux only).
 *
 * `github-auth.ts` owns the gh install ENTRY POINT (`installGh`) and the
 * Windows/winget branch; this function exists only to fill the macOS/Linux
 * branch it used to punt on ("No auto-install on macOS/Linux in v1 — surface
 * the one-liner instead"), which dead-ended every non-Windows user in the sync
 * wizard. The download/extract/PATH machinery lives here because this module
 * already owns `youcodedDataDir()`, `downloadFile()` and shell-profile PATH
 * persistence. Call it via `github-auth.installGh()`, not directly.
 *
 * Deliberately does NOT use Homebrew (unlike `installRclone` in
 * sync-setup-handlers.ts, which shells out to `brew` and therefore fails on any
 * Mac without it) — a stock macOS has no `brew`, and telling a non-developer to
 * install a package manager first is the exact dead end this removes.
 *
 * Archive shapes differ by platform and are NOT interchangeable (verified
 * against the cli/cli releases API 2026-07-20): macOS publishes `.zip`, Linux
 * publishes `.tar.gz`. Both unpack to `gh_<ver>_<plat>_<arch>/bin/gh`.
 */
export async function installGhUserLocal(): Promise<{ success: boolean; error?: string }> {
  try {
    log('INFO', 'prereq', 'Installing GitHub CLI...');

    if (process.platform === 'darwin' || process.platform === 'linux') {
      // gh's release assets use Go's arch tokens: amd64 (not x64) and arm64.
      const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
      // gh names the macOS asset "macOS" (capitalised) and the Linux one "linux".
      const platToken = process.platform === 'darwin' ? 'macOS' : 'linux';
      const ext = process.platform === 'darwin' ? 'zip' : 'tar.gz';
      const stem = `gh_${GH_VERSION}_${platToken}_${arch}`;
      const archivePath = path.join(os.tmpdir(), `${stem}.${ext}`);

      await downloadFile(
        `https://github.com/cli/cli/releases/download/v${GH_VERSION}/${stem}.${ext}`,
        archivePath,
      );

      // Extract to a scratch dir first, then copy out only the binary. Keeps
      // the tools bin dir flat and avoids leaving the archive's LICENSE/man
      // tree behind.
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-gh-'));
      try {
        if (ext === 'zip') {
          // `unzip` ships with macOS; -o overwrites a partial from a retry.
          await runCommand('unzip', ['-q', '-o', archivePath, '-d', scratch], { timeout: 300000 });
        } else {
          await runCommand('tar', ['-xzf', archivePath, '-C', scratch], { timeout: 300000 });
        }

        const extractedBin = path.join(scratch, stem, 'bin', 'gh');
        if (!fs.existsSync(extractedBin)) {
          // Fail loudly with the real path rather than letting the post-install
          // detect() report a generic "not found" that hides the cause.
          return {
            success: false,
            error: `GitHub CLI archive did not contain the expected binary at ${stem}/bin/gh`,
          };
        }

        const binDir = userLocalToolsBinDir();
        fs.mkdirSync(binDir, { recursive: true });
        const dest = path.join(binDir, 'gh');
        fs.copyFileSync(extractedBin, dest);
        fs.chmodSync(dest, 0o755);
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
        fs.unlink(archivePath, () => {});
      }

      // Visible to this process AND to future shells / PTY sessions.
      prependToProcessPath(userLocalToolsBinDir());
      persistPathToShellProfiles(userLocalToolsBinDir());
    } else {
      return { success: false, error: `Unsupported platform for GitHub CLI install: ${process.platform}` };
    }

    refreshPath();
    // Verify by running the binary we just placed, not by PATH lookup: PATH
    // propagation into an already-running Electron process is exactly the
    // failure installClaude() documents, and here we know the absolute path.
    try {
      const { stdout } = await runCommand(path.join(userLocalToolsBinDir(), 'gh'), ['--version']);
      log('INFO', 'prereq', `GitHub CLI installed: ${stdout.trim().split('\n')[0]}`);
    } catch (err) {
      return { success: false, error: `GitHub CLI installed but would not run: ${String(err)}` };
    }
    return { success: true };
  } catch (err) {
    const msg = String(err);
    log('ERROR', 'prereq', 'GitHub CLI install failed', { error: msg });
    return { success: false, error: msg };
  }
}

/**
 * Install Claude Code via Anthropic's native installer.
 *
 * Why not `npm install -g @anthropic-ai/claude-code` (the prior approach):
 * `npm` on Windows is `npm.cmd`, and Node's CVE-2024-27980 mitigation
 * (18.20.2+ / 20.12.2+ / 21.7.1+) refuses to spawn `.cmd` files via
 * `child_process.spawn` / `execFile` without `shell: true` — failure surfaces
 * as `Error: spawn EINVAL`. Even with the `runCommand` shell-true workaround
 * applied here, a real-world friend's first-run install hit it and we had to
 * triage by hand. The native installer drops a real `claude.exe` (and
 * `claude` on POSIX) onto PATH, so the whole `.cmd` shim chain — `npm.cmd`
 * during install, `claude.cmd` during every subsequent `claude --version` /
 * `claude auth status` / `claude auth set-key` call — disappears.
 *
 * Bootstrap shape (verified 2026-04-28):
 * - https://claude.ai/install.ps1 → bootstrap.ps1 → downloads claude-<v>-<plat>.exe
 *   from downloads.claude.ai → runs `claude install` to wire up PATH (HKCU).
 * - https://claude.ai/install.sh → bootstrap.sh → same shape for POSIX.
 * Both bootstraps are non-interactive, require no admin/sudo, and exit 0 on
 * success / 1 on failure with a descriptive message on stderr.
 */
/** Run the platform-specific native-installer bootstrap exactly once. */
async function runClaudeBootstrap(): Promise<void> {
    if (process.platform === 'win32') {
      // -NoProfile: skip user PowerShell profile (faster, no side effects).
      // -ExecutionPolicy Bypass: works around per-user "Restricted" policies
      //   that would otherwise block `iex`. Process-scoped only — does not
      //   alter the user's persistent ExecutionPolicy.
      const ps = getPowerShellPath();
      await runCommand(
        ps,
        [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-Command',
          'irm https://claude.ai/install.ps1 | iex',
        ],
        { timeout: 300000 },
      );
    } else if (process.platform === 'darwin' || process.platform === 'linux') {
      // bash ships with macOS and nearly every Linux distro, but NOT all of
      // them (minimal/container images may ship only dash or busybox sh), so
      // we defensively translate a missing-bash spawn failure below instead of
      // assuming it exists. The installer itself uses `set -e`, so any failure
      // inside the pipe propagates as a non-zero exit.
      //
      // Fix (v1.2.4): curl is NOT guaranteed on minimal Linux installs (Debian
      // netinst, some container images ship only wget). Probe for curl first,
      // fall back to wget, and if neither exists exit with an actionable
      // message instead of an opaque "curl: command not found". `set -o
      // pipefail` is required so a failure on the LEFT side of the pipe (the
      // downloader / the no-downloader `exit 1`) is not masked by `bash`
      // exiting 0 on empty stdin.
      try {
        await runCommand(
          'bash',
          ['-c',
            'set -o pipefail; url=https://claude.ai/install.sh; ' +
            '{ if command -v curl >/dev/null 2>&1; then curl -fsSL "$url"; ' +
            'elif command -v wget >/dev/null 2>&1; then wget -qO- "$url"; ' +
            'else echo "Neither curl nor wget is installed. Install one with ' +
            'your package manager, then click Try Again." >&2; exit 1; fi; } | bash'],
          { timeout: 300000 },
        );
      } catch (err) {
        // Fix: without this, a missing bash surfaced to the user as the raw
        // Node error "spawn bash ENOENT". The ENOENT is precisely "bash is not
        // on PATH", so we can state the real cause and the fix (per
        // docs/error-message-standards.md — specific and accurate).
        if (isSpawnEnoent(err)) {
          throw new Error(
            'bash was not found on PATH. Install bash with your package manager ' +
            '(Debian/Ubuntu: sudo apt install bash · Fedora/RHEL: sudo dnf install bash · ' +
            'Arch: sudo pacman -S bash), then click Try Again.',
          );
        }
        throw err;
      }
    } else {
      throw new Error(`Unsupported platform: ${process.platform}`);
    }
}

/** Max attempts when the bootstrap dies on a transient file-lock. */
const CLAUDE_INSTALL_LOCK_RETRIES = 3;

export async function installClaude(): Promise<{ success: boolean; error?: string }> {
  try {
    log('INFO', 'prereq', 'Installing Claude Code via native installer...');

    // Run the bootstrap, retrying on transient file-lock errors. The bootstrap
    // downloads claude-<v>-<plat>.exe to ~/.claude/downloads with an exclusive
    // OutFile open and has no retry of its own; a concurrent attempt, a leftover
    // partial, or an antivirus real-time scan can hold that file and fail the
    // open with "being used by another process". Pre-clean the stale download
    // and give transient locks a moment to clear before retrying.
    let lastErr: unknown;
    for (let attempt = 1; attempt <= CLAUDE_INSTALL_LOCK_RETRIES; attempt++) {
      cleanStaleClaudeDownloads();
      try {
        await runClaudeBootstrap();
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        if (isFileLockError(String(err)) && attempt < CLAUDE_INSTALL_LOCK_RETRIES) {
          log('WARN', 'prereq', `Claude download locked, retrying (${attempt}/${CLAUDE_INSTALL_LOCK_RETRIES})`, { error: String(err) });
          await delay(2000);
          continue;
        }
        throw err;
      }
    }
    if (lastErr) throw lastErr;

    refreshPath();
    const check = await detectClaude();
    if (!check.installed) {
      // Most likely cause: the installer wrote PATH to HKCU, but the parent
      // Electron process snapshotted PATH at launch and our refreshPath() only
      // re-reads the registry on Windows. On macOS/Linux, the installer
      // updates ~/.zshrc / ~/.bashrc, which a still-running app can't see.
      // detectClaude() already probes the native installer's absolute path, so
      // reaching here means the binary isn't even on disk there — a restart is
      // the deterministic fix either way.
      return {
        success: false,
        error:
          'Claude Code installed but is not on this app\'s PATH yet. Quit and reopen YouCoded — the new PATH entry will be picked up on next launch.',
      };
    }

    log('INFO', 'prereq', `Claude Code installed: ${check.version}`);
    return { success: true };
  } catch (err) {
    const msg = String(err);
    log('ERROR', 'prereq', 'Claude Code install failed', { error: msg });
    // Map the opaque sharing-violation stack trace to an actionable message.
    if (isFileLockError(msg)) {
      return {
        success: false,
        error:
          'Another program (often antivirus, or a second install attempt) is holding the Claude Code download open. Close other YouCoded windows, wait a moment, and click Try Again. If it keeps happening, restart your PC and reopen YouCoded.',
      };
    }
    return { success: false, error: msg };
  }
}


/**
 * Start OAuth login by spawning `claude auth login` inside a PTY.
 *
 * Why a PTY, not piped stdio: newer Claude Code CLI versions detect a
 * non-TTY stdin and either abort or fail to fully bring up the local
 * OAuth callback HTTP server. The symptom in the UI was the browser
 * reaching Claude's auth page, signing in, then getting "localhost
 * refused to connect" on the redirect — nothing was listening on the
 * callback port because the CLI had already bailed. A PTY makes the
 * CLI behave exactly as if run from Terminal.app.
 *
 * Returns the URL so the caller can open it via shell.openExternal().
 * The CLI process is kept alive — it waits for the OAuth callback.
 * Call pollAuthStatus() to detect when login completes.
 */
export function startOAuthLogin(): { url: string | null; kill: () => void } {
  const claudePath = resolveClaudeCommand();

  // Locate pty-worker.js the same way SessionManager does — in packaged builds
  // it lives under app.asar.unpacked/ so the system node can read it.
  let workerPath = path.join(__dirname, 'pty-worker.js');
  if (app?.isPackaged) {
    const unpacked = workerPath.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    if (fs.existsSync(unpacked)) workerPath = unpacked;
  }
  let nodePath = 'node';
  try { if (whichSync) nodePath = whichSync('node'); } catch { /* use bare 'node' */ }

  const worker = spawn(nodePath, [workerPath], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });

  let authUrl: string | null = null;
  let buffer = '';                 // accumulated stdout (ANSI-stripped) for regex matches across chunks
  const DIAG_MAX = 2000;           // cap diagnostic log volume
  let diagBuf = '';

  // Modern CLI versions may render the link as claude.com, console.anthropic.com,
  // or claude.ai — accept any of them so regex drift doesn't silently break auth.
  const URL_RE = /https:\/\/(?:claude\.com|claude\.ai|console\.anthropic\.com)\/[^\s\x1b]+/;

  worker.stderr?.on('data', (chunk: Buffer) => {
    log('WARN', 'prereq', 'OAuth worker stderr', { output: chunk.toString().trim() });
  });

  worker.on('error', (err) => {
    log('ERROR', 'prereq', 'OAuth worker spawn failed', { error: String(err) });
  });

  worker.on('message', (msg: any) => {
    if (msg.type === 'data') {
      const clean = stripAnsi(String(msg.data));
      buffer += clean;
      if (diagBuf.length < DIAG_MAX) diagBuf += clean;
      if (!authUrl) {
        const m = buffer.match(URL_RE);
        if (m) {
          authUrl = m[0];
          log('INFO', 'prereq', 'OAuth URL captured', { url: authUrl });
        }
      }
    } else if (msg.type === 'exit') {
      log('WARN', 'prereq', 'OAuth CLI exited', {
        exitCode: msg.exitCode,
        authUrlCaptured: Boolean(authUrl),
        // If the URL was never captured, the tail of output is the best debugging clue.
        stdoutTail: authUrl ? undefined : diagBuf.slice(-DIAG_MAX),
      });
    } else if (msg.type === 'spawned') {
      log('INFO', 'prereq', 'OAuth PTY spawned', { pid: msg.pid });
    }
  });

  // Kick off the CLI inside the PTY worker.
  try {
    worker.send({
      type: 'spawn',
      command: claudePath,
      args: ['auth', 'login'],
      cols: 120,
      rows: 30,
      cwd: os.homedir(),
    });
  } catch (err) {
    log('ERROR', 'prereq', 'OAuth worker.send failed', { error: String(err) });
  }

  return {
    get url() { return authUrl; },
    kill: () => {
      try { worker.send({ type: 'kill' }); } catch {}
      try { worker.kill(); } catch {}
    },
  };
}

/**
 * Poll `claude auth status` until authenticated or timeout.
 * Returns true when auth succeeds.
 */
export async function pollAuthStatus(timeoutMs = 120000, intervalMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await detectAuth();
    if (result.installed) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

/** Submit an API key for authentication. Key is passed as an array arg — no shell interpolation. */
export async function submitApiKey(key: string): Promise<{ success: boolean; error?: string }> {
  try {
    const claudePath = resolveClaudeCommand();
    await runCommand(claudePath, ['auth', 'set-key', key]);

    const check = await detectAuth();
    if (!check.installed) {
      return { success: false, error: check.error ?? 'Auth check failed after setting key' };
    }

    log('INFO', 'prereq', 'API key set and verified');
    return { success: true };
  } catch (err) {
    const msg = String(err);
    log('ERROR', 'prereq', 'API key submission failed', { error: msg });
    return { success: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/** Check available disk space. Returns sufficient=true if >= 500 MB free. */
export function checkDiskSpace(): { sufficient: boolean; availableMB: number } {
  try {
    const home = os.homedir();
    const stats = fs.statfsSync(home);
    const availableBytes = stats.bavail * stats.bsize;
    const availableMB = Math.floor(availableBytes / (1024 * 1024));
    return { sufficient: availableMB >= 500, availableMB };
  } catch {
    // Can't determine disk space — assume sufficient to avoid blocking install
    return { sufficient: true, availableMB: -1 };
  }
}

/**
 * Check whether Windows Developer Mode is enabled.
 * On non-Windows platforms, returns true (not required).
 *
 * NOTE: Uses execSync with a hardcoded registry query string — no user input.
 */
export function checkWindowsDevMode(): boolean {
  if (process.platform !== 'win32') return true;

  try {
    const reg = getRegPath();
    const output = execSync(
      `${reg} query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock" /v AllowDevelopmentWithoutDevLicense`,
      { encoding: 'utf8' },
    );
    return output.includes('0x1');
  } catch {
    return false;
  }
}

/**
 * Attempt to enable Windows Developer Mode via an elevated reg command.
 * Returns success based on whether the mode is enabled after the attempt.
 */
export async function enableWindowsDevMode(): Promise<{ success: boolean; error?: string }> {
  if (process.platform !== 'win32') {
    return { success: true };
  }

  try {
    log('INFO', 'prereq', 'Attempting to enable Windows Developer Mode...');

    const ps = getPowerShellPath();
    await runCommand(ps, [
      '-Command',
      'Start-Process reg -ArgumentList "add","HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock","/v","AllowDevelopmentWithoutDevLicense","/t","REG_DWORD","/d","1","/f" -Verb RunAs -Wait',
    ]);

    const enabled = checkWindowsDevMode();
    if (enabled) {
      log('INFO', 'prereq', 'Windows Developer Mode enabled');
      return { success: true };
    }

    return { success: false, error: 'Developer Mode still not enabled after reg write' };
  } catch (err) {
    const msg = String(err);
    log('ERROR', 'prereq', 'Failed to enable Developer Mode', { error: msg });
    return { success: false, error: msg };
  }
}
