import { execFile, execSync, spawn } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import fs from 'fs';
import https from 'https';
import { log } from './logger';

const execFileAsync = promisify(execFile);

// Optional — which may not be installed; fall back to bare command name
let whichSync: ((cmd: string) => string) | null = null;
try { const w = require('which'); whichSync = w.sync; } catch { /* noop */ }

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
// Helper functions
// ---------------------------------------------------------------------------

/**
 * On Windows, re-reads User and System PATH from the registry so that
 * freshly-installed tools are visible without restarting the app.
 * On macOS/Linux this is a no-op — main.ts already prepends common paths.
 *
 * NOTE: Uses execSync with hardcoded registry query strings — no user input
 * is interpolated. This is intentional; execFile cannot run reg queries that
 * need shell parsing of the output format.
 */
export function refreshPath(): void {
  if (process.platform !== 'win32') return;

  try {
    const userPath = execSync(
      'reg query "HKCU\\Environment" /v Path',
      { encoding: 'utf8' },
    )
      .split('\n')
      .find((l) => l.includes('REG_'))
      ?.replace(/.*REG_(EXPAND_)?SZ\s+/i, '')
      .trim() ?? '';

    const systemPath = execSync(
      'reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v Path',
      { encoding: 'utf8' },
    )
      .split('\n')
      .find((l) => l.includes('REG_'))
      ?.replace(/.*REG_(EXPAND_)?SZ\s+/i, '')
      .trim() ?? '';

    process.env.PATH = `${userPath};${systemPath}`;
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
export function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = (targetUrl: string) => {
      https.get(targetUrl, (res) => {
        // Follow redirects
        if (
          (res.statusCode === 301 || res.statusCode === 302) &&
          res.headers.location
        ) {
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
    const { stdout } = await execFileAsync(nodePath, ['--version']);
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
    const { stdout } = await execFileAsync(gitPath, ['--version']);
    const version = stdout.trim();
    log('INFO', 'prereq', `Git detected: ${version}`);
    return { installed: true, version, path: gitPath };
  } catch (err) {
    return { installed: false, error: String(err) };
  }
}

/** Detect Claude Code CLI. */
export async function detectClaude(): Promise<DetectionResult> {
  try {
    const claudePath = resolveCommand('claude');
    const { stdout } = await execFileAsync(claudePath, ['--version']);
    const version = stdout.trim();
    log('INFO', 'prereq', `Claude Code detected: ${version}`);
    return { installed: true, version, path: claudePath };
  } catch (err) {
    return { installed: false, error: String(err) };
  }
}

/** Detect DestinClaude toolkit by checking for VERSION file. No command execution. */
export async function detectToolkit(): Promise<DetectionResult> {
  try {
    const versionFile = path.join(
      os.homedir(),
      '.claude',
      'plugins',
      'destinclaude',
      'VERSION',
    );
    const version = fs.readFileSync(versionFile, 'utf8').trim();
    log('INFO', 'prereq', `Toolkit detected: ${version}`);
    return { installed: true, version, path: versionFile };
  } catch {
    return { installed: false, error: 'Toolkit not found' };
  }
}

/** Detect whether Claude Code is authenticated. */
export async function detectAuth(): Promise<DetectionResult> {
  try {
    const claudePath = resolveCommand('claude');
    const { stdout } = await execFileAsync(claudePath, ['auth', 'status']);
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

// ---------------------------------------------------------------------------
// Installation functions
// ---------------------------------------------------------------------------

/** Install Node.js silently. */
export async function installNode(): Promise<{ success: boolean; error?: string }> {
  try {
    log('INFO', 'prereq', 'Installing Node.js...');

    if (process.platform === 'win32') {
      await execFileAsync(
        'winget',
        [
          'install',
          'OpenJS.NodeJS.LTS',
          '--silent',
          '--accept-package-agreements',
          '--accept-source-agreements',
        ],
        { timeout: 300000 },
      );
    } else if (process.platform === 'darwin') {
      const tmpPkg = path.join(os.tmpdir(), 'node-v20.19.0.pkg');
      await downloadFile(
        'https://nodejs.org/dist/v20.19.0/node-v20.19.0.pkg',
        tmpPkg,
      );
      await execFileAsync('installer', [
        '-pkg',
        tmpPkg,
        '-target',
        'CurrentUserHomeDirectory',
      ]);
      // Best-effort cleanup
      fs.unlink(tmpPkg, () => {});
    } else {
      return { success: false, error: 'Unsupported platform for Node.js install' };
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

/** Install Git silently. */
export async function installGit(): Promise<{ success: boolean; error?: string }> {
  try {
    log('INFO', 'prereq', 'Installing Git...');

    if (process.platform === 'win32') {
      await execFileAsync(
        'winget',
        [
          'install',
          'Git.Git',
          '--silent',
          '--accept-package-agreements',
          '--accept-source-agreements',
        ],
        { timeout: 300000 },
      );
    } else if (process.platform === 'darwin') {
      // xcode-select --install may return non-zero if already installed or
      // requires a GUI interaction; wrap in try/catch so either case is OK.
      try {
        await execFileAsync('xcode-select', ['--install']);
      } catch {
        log('WARN', 'prereq', 'xcode-select --install exited non-zero (may already be installed or needs GUI)');
      }
    } else {
      return { success: false, error: 'Unsupported platform for Git install' };
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

/** Install Claude Code CLI globally via npm. */
export async function installClaude(): Promise<{ success: boolean; error?: string }> {
  try {
    log('INFO', 'prereq', 'Installing Claude Code CLI...');

    const npmPath = resolveCommand('npm');
    await execFileAsync(
      npmPath,
      ['install', '-g', '@anthropic-ai/claude-code'],
      { timeout: 300000 },
    );

    refreshPath();
    const check = await detectClaude();
    if (!check.installed) {
      return { success: false, error: check.error ?? 'Claude Code not found after install' };
    }

    log('INFO', 'prereq', `Claude Code installed: ${check.version}`);
    return { success: true };
  } catch (err) {
    const msg = String(err);
    log('ERROR', 'prereq', 'Claude Code install failed', { error: msg });
    return { success: false, error: msg };
  }
}

/** Clone the DestinClaude toolkit into ~/.claude/plugins/destinclaude. */
export async function cloneToolkit(): Promise<{ success: boolean; error?: string }> {
  try {
    const targetDir = path.join(
      os.homedir(),
      '.claude',
      'plugins',
      'destinclaude',
    );
    const versionFile = path.join(targetDir, 'VERSION');

    // Already cloned — return early
    if (fs.existsSync(versionFile)) {
      log('INFO', 'prereq', 'Toolkit already present, skipping clone');
      return { success: true };
    }

    log('INFO', 'prereq', 'Cloning DestinClaude toolkit...');

    // Ensure parent directory exists
    fs.mkdirSync(path.join(os.homedir(), '.claude', 'plugins'), {
      recursive: true,
    });

    const gitPath = resolveCommand('git');
    await execFileAsync(gitPath, [
      'clone',
      'https://github.com/itsdestin/destinclaude.git',
      targetDir,
    ]);

    // Create minimal symlinks so the setup-wizard is discoverable by Claude Code.
    // The full set of symlinks is created by the wizard itself in Phase 5.
    try {
      const home = os.homedir();
      const skillsDir = path.join(home, '.claude', 'skills');
      const commandsDir = path.join(home, '.claude', 'commands');
      fs.mkdirSync(skillsDir, { recursive: true });
      fs.mkdirSync(commandsDir, { recursive: true });

      // On Windows, real symlinks require Developer Mode + MSYS=winsymlinks:nativestrict.
      // If symlinks fail, fall back — the plugin.json discovery may still work.
      const wizardSkillSrc = path.join(targetDir, 'core', 'skills', 'setup-wizard');
      const wizardSkillDst = path.join(skillsDir, 'setup-wizard');
      const wizardCmdSrc = path.join(targetDir, 'core', 'commands', 'setup-wizard.md');
      const wizardCmdDst = path.join(commandsDir, 'setup-wizard.md');

      if (!fs.existsSync(wizardSkillDst)) {
        try { fs.symlinkSync(wizardSkillSrc, wizardSkillDst, 'junction'); } catch {
          try { fs.symlinkSync(wizardSkillSrc, wizardSkillDst, 'dir'); } catch (e) {
            log('WARN', 'prereq', 'Could not symlink setup-wizard skill', { error: String(e) });
          }
        }
      }
      if (!fs.existsSync(wizardCmdDst)) {
        try { fs.symlinkSync(wizardCmdSrc, wizardCmdDst, 'junction'); } catch {
          try { fs.symlinkSync(wizardCmdSrc, wizardCmdDst, 'file'); } catch (e) {
            log('WARN', 'prereq', 'Could not symlink setup-wizard command', { error: String(e) });
          }
        }
      }
    } catch (e) {
      log('WARN', 'prereq', 'Symlink creation failed (wizard may still work via plugin discovery)', { error: String(e) });
    }

    log('INFO', 'prereq', 'Toolkit cloned successfully');
    return { success: true };
  } catch (err) {
    const msg = String(err);
    log('ERROR', 'prereq', 'Toolkit clone failed', { error: msg });
    return { success: false, error: msg };
  }
}

/**
 * Start OAuth login by spawning `claude auth login` and extracting the auth URL.
 * Returns the URL so the caller can open it via shell.openExternal().
 * The CLI process is kept alive — it waits for the OAuth callback.
 * Call pollAuthStatus() to detect when login completes.
 */
export function startOAuthLogin(): { url: string | null; kill: () => void } {
  const claudePath = resolveCommand('claude');
  let authUrl: string | null = null;

  const child = spawn(claudePath, ['auth', 'login'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // Capture the auth URL from stdout
  child.stdout?.on('data', (data: Buffer) => {
    const text = data.toString();
    const match = text.match(/https:\/\/claude\.com\/[^\s]+/);
    if (match) authUrl = match[0];
  });

  child.stderr?.on('data', (data: Buffer) => {
    log('WARN', 'prereq', 'OAuth stderr', { output: data.toString().trim() });
  });

  child.on('error', (err) => {
    log('ERROR', 'prereq', 'OAuth process error', { error: String(err) });
  });

  // Return URL getter + cleanup. URL may not be available immediately —
  // the caller should wait briefly then read it.
  return {
    get url() { return authUrl; },
    kill: () => { try { child.kill(); } catch {} },
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
    const claudePath = resolveCommand('claude');
    await execFileAsync(claudePath, ['auth', 'set-key', key]);

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
    const output = execSync(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock" /v AllowDevelopmentWithoutDevLicense',
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

    await execFileAsync('powershell', [
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
