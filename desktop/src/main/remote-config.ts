import fs from 'fs';
import path from 'path';
import os from 'os';
import bcrypt from 'bcryptjs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { REMOTE_SERVER_DEFAULT_PORT } from '../shared/ports';
import { remoteConfigPath } from './remote-paths';

const execFileAsync = promisify(execFile);

const BCRYPT_ROUNDS = 10;

// Fix: dev instances get their OWN remote config file. Previously every profile
// read and wrote ~/.claude/youcoded-remote.json — the built app's file — so
// save() had to be a hard no-op to avoid clobbering the real app's port and
// password hash. The side effect was that remote access could never be enabled
// from a dev instance at all, making remote features untestable outside a
// production install. A per-profile file removes the sharing, so dev can
// configure and persist its own remote server safely.
//
// The path itself now comes from remote-paths.ts, shared with the device store,
// which used to be scoped differently and so leaked pairings across profiles.
const CONFIG_PATH = () => remoteConfigPath();
// Any non-empty YOUCODED_PROFILE is a dev instance: concurrent dev instances with
// distinct profiles (e.g. 'dev2') each get their own file and port rather than
// fighting over the built app's 9900. The port offset is applied in shared/ports.ts.

interface ConfigData {
  enabled: boolean;
  port: number;
  passwordHash: string | null;
  keepAwakeHours: number; // 0 = off
  everPaired: boolean;
}

export class RemoteConfig {
  enabled: boolean;
  port: number;
  passwordHash: string | null;
  keepAwakeHours: number;
  everPaired: boolean;

  constructor() {
    const defaults: ConfigData = {
      enabled: false,
      // Dev-profile offset shifts this (e.g., 9900 → 9950) so dev and built app
      // don't fight over the same port when both have remote access enabled.
      port: REMOTE_SERVER_DEFAULT_PORT,
      passwordHash: null,
      keepAwakeHours: 0,
      everPaired: false,
    };

    const configPath = CONFIG_PATH();
    if (fs.existsSync(configPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        this.enabled = data.enabled ?? defaults.enabled;
        // No dev shift here: the config file is per-profile now, so a dev file
        // already stores dev's own port (REMOTE_SERVER_DEFAULT_PORT is itself
        // offset-derived — 9950 under YOUCODED_PORT_OFFSET=50). Re-adding the
        // offset on load would drift the port by 50 on every save/load cycle.
        this.port = data.port ?? defaults.port;
        this.passwordHash = data.passwordHash ?? defaults.passwordHash;
        // Note: a `passwordPlain` field used to exist on disk (never read, only
        // written). save() no longer serializes it, so it'll disappear on the
        // next save. We intentionally don't load it into memory here.
        this.keepAwakeHours = data.keepAwakeHours ?? defaults.keepAwakeHours;
        this.everPaired = data.everPaired ?? defaults.everPaired;
        return;
      } catch {
        // Fall through to defaults
      }
    }

    this.enabled = defaults.enabled;
    this.port = defaults.port;
    this.passwordHash = defaults.passwordHash;
    this.keepAwakeHours = defaults.keepAwakeHours;
    this.everPaired = defaults.everPaired;
  }

  async setPassword(plaintext: string): Promise<void> {
    this.passwordHash = await bcrypt.hash(plaintext, BCRYPT_ROUNDS);
    this.save();
  }

  async verifyPassword(plaintext: string): Promise<boolean> {
    if (!this.passwordHash) return false;
    return bcrypt.compare(plaintext, this.passwordHash);
  }

  save(): void {
    // The dev-profile no-op that used to live here is gone: CONFIG_PATH() is
    // per-profile, so a dev save can no longer reach the built app's file.
    // Persisting is what makes remote access configurable in dev at all.
    const configPath = CONFIG_PATH();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // Security: restrict file permissions to owner-only (contains password hash)
    fs.writeFileSync(configPath, JSON.stringify({
      enabled: this.enabled,
      port: this.port,
      passwordHash: this.passwordHash,
      keepAwakeHours: this.keepAwakeHours,
      everPaired: this.everPaired,
    }, null, 2), { mode: 0o600 });
  }

  /** Return config data safe for the renderer (no password hash, no plaintext password). */
  toSafeObject(): { enabled: boolean; port: number; hasPassword: boolean; password: null; keepAwakeHours: number; everPaired: boolean } {
    return {
      enabled: this.enabled,
      port: this.port,
      hasPassword: !!this.passwordHash,
      password: null, // Security: never expose plaintext password over IPC or WebSocket
      keepAwakeHours: this.keepAwakeHours,
      everPaired: this.everPaired,
    };
  }

  /** Mark that at least one device has paired. */
  markPaired(): void {
    if (this.everPaired) return;
    this.everPaired = true;
    this.save();
  }

  /** Resolve the Tailscale CLI binary path across platforms. */
  static resolveTailscalePath(): string {
    let tsPath = 'tailscale';
    try { const w = require('which'); tsPath = w.sync('tailscale'); } catch {}
    if (tsPath === 'tailscale') {
      const candidates = process.platform === 'win32'
        ? ['C:\\Program Files\\Tailscale\\tailscale.exe', `${process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'}\\Tailscale\\tailscale.exe`]
        : process.platform === 'darwin'
          ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale']
          // Linux: `which` above already covers anything on PATH. These are
          // common install locations that a GUI-launched app's stripped PATH
          // often misses — notably /snap/bin (snap) and linuxbrew.
          : ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/snap/bin/tailscale', '/home/linuxbrew/.linuxbrew/bin/tailscale'];
      for (const p of candidates) {
        try { fs.accessSync(p); tsPath = p; break; } catch {}
      }
    }
    return tsPath;
  }

  /**
   * Detect Tailscale installation and connection status.
   *
   * Fix: previously this ran `tailscale ip -4` first and used its success as the
   * installation signal. That command fails when the VPN is disconnected (or the
   * daemon is stopped), so the UI showed Tailscale as "uninstalled" any time the
   * VPN was off. We now probe installation independently of the daemon — by
   * verifying the binary on disk (or via `tailscale version`, which doesn't need
   * the local API) — and only then probe connection state.
   */
  static async detectTailscale(port: number): Promise<{ installed: boolean; connected: boolean; ip: string | null; hostname: string | null; url: string | null }> {
    const notInstalled = { installed: false, connected: false, ip: null, hostname: null, url: null };

    const tsPath = RemoteConfig.resolveTailscalePath();

    // Step 1: confirm the binary exists, independent of daemon state.
    // resolveTailscalePath() returns a verified absolute path on success, or
    // the literal 'tailscale' as a fallback. For the fallback, run
    // `tailscale version` (does not require the daemon) to check PATH.
    let installed = false;
    if (tsPath !== 'tailscale') {
      try { fs.accessSync(tsPath); installed = true; } catch {}
    } else {
      try { await execFileAsync(tsPath, ['version']); installed = true; } catch {}
    }
    if (!installed) return notInstalled;

    // Step 2: probe daemon for connection state. Tolerate failure — when the
    // Tailscale service is fully stopped, `status --json` errors out, but
    // Tailscale is still installed (just not running).
    let connected = false;
    let hostname: string | null = null;
    let tailscaleIp: string | null = null;
    try {
      const { stdout: statusJson } = await execFileAsync(tsPath, ['status', '--json']);
      const status = JSON.parse(statusJson);
      hostname = status.Self?.HostName || null;
      connected = status.BackendState === 'Running';
      if (connected) {
        // Prefer the IP from status JSON (one fewer subprocess). Fall back to
        // `tailscale ip -4` only if status JSON didn't include one.
        const ips: string[] = status.Self?.TailscaleIPs ?? [];
        tailscaleIp = ips.find((ip) => ip.includes('.')) ?? null;
        if (!tailscaleIp) {
          try {
            const { stdout: ipOut } = await execFileAsync(tsPath, ['ip', '-4']);
            tailscaleIp = ipOut.trim() || null;
          } catch {}
        }
      }
    } catch {}

    return {
      installed: true,
      connected,
      ip: tailscaleIp,
      hostname,
      url: tailscaleIp ? `http://${tailscaleIp}:${port}` : null,
    };
  }

  /** Install Tailscale silently. Windows: winget, macOS: brew, Linux: manual. */
  static async installTailscale(): Promise<{ success: boolean; error?: string }> {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);

    try {
      if (process.platform === 'win32') {
        // WHY: winget is an MSIX App Execution Alias, not guaranteed to exist on
        // Windows Server / LTSC / policy-restricted machines. Probe upfront so the
        // user gets an actionable error instead of cryptic ENOENT. Reuses the
        // shared detectWinget helper from prerequisite-installer.
        const { detectWinget } = await import('./prerequisite-installer');
        const wingetCheck = await detectWinget();
        if (!wingetCheck.installed) {
          return { success: false, error: wingetCheck.error };
        }
        await execFileAsync(
          'winget',
          ['install', 'Tailscale.Tailscale', '--silent', '--accept-package-agreements', '--accept-source-agreements'],
          { timeout: 300000 },
        );
      } else if (process.platform === 'darwin') {
        await execFileAsync('brew', ['install', '--cask', 'tailscale'], { timeout: 300000 });
      } else {
        return { success: false, error: 'linux-manual' };
      }

      // Verify installation
      const check = await RemoteConfig.detectTailscale(REMOTE_SERVER_DEFAULT_PORT);
      if (!check.installed) {
        return { success: false, error: 'Tailscale not found after install. You may need to restart the app.' };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  /** Start Tailscale authentication by running `tailscale up`. Returns the auth URL if found. */
  static async startTailscaleAuth(): Promise<{ url: string | null; error?: string }> {
    const { spawn } = require('child_process');
    const tsPath = RemoteConfig.resolveTailscalePath();

    return new Promise((resolve) => {
      let authUrl: string | null = null;
      let settled = false;

      const child = spawn(tsPath, ['up'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      const onData = (data: Buffer) => {
        const text = data.toString();
        const match = text.match(/https:\/\/[^\s]+/);
        if (match && !settled) {
          authUrl = match[0];
          settled = true;
          resolve({ url: authUrl });
        }
      };

      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);

      child.on('error', (err: Error) => {
        if (!settled) { settled = true; resolve({ url: null, error: String(err) }); }
      });

      child.on('close', (code: number) => {
        if (!settled) {
          settled = true;
          // Exit code 0 with no URL means already authenticated
          if (code === 0) resolve({ url: null });
          else resolve({ url: null, error: `tailscale up exited with code ${code}` });
        }
      });

      // If no URL appears after 10s, resolve anyway (may already be authed)
      setTimeout(() => {
        if (!settled) { settled = true; resolve({ url: null }); }
      }, 10000);
    });
  }
}
