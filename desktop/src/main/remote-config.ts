import fs from 'fs';
import path from 'path';
import os from 'os';
import bcrypt from 'bcryptjs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { REMOTE_SERVER_DEFAULT_PORT, PORT_OFFSET } from '../shared/ports';

const execFileAsync = promisify(execFile);

const CONFIG_PATH = () => path.join(os.homedir(), '.claude', 'destincode-remote.json');
const BCRYPT_ROUNDS = 10;
// Dev profile shares ~/.claude/destincode-remote.json with the built app, but
// must NOT bind the built app's saved port and must NOT overwrite that saved
// port on user actions. Offset-shift on read; no-op on save.
const IS_DEV_PROFILE = process.env.DESTINCODE_PROFILE === 'dev';

interface ConfigData {
  enabled: boolean;
  port: number;
  passwordHash: string | null;
  passwordPlain: string | null;
  trustTailscale: boolean;
  keepAwakeHours: number; // 0 = off
  everPaired: boolean;
}

export class RemoteConfig {
  enabled: boolean;
  port: number;
  passwordHash: string | null;
  passwordPlain: string | null;
  trustTailscale: boolean;
  keepAwakeHours: number;
  everPaired: boolean;

  constructor() {
    const defaults: ConfigData = {
      enabled: false,
      // Dev-profile offset shifts this (e.g., 9900 → 9950) so dev and built app
      // don't fight over the same port when both have remote access enabled.
      port: REMOTE_SERVER_DEFAULT_PORT,
      passwordHash: null,
      passwordPlain: null,
      trustTailscale: false,
      keepAwakeHours: 0,
      everPaired: false,
    };

    const configPath = CONFIG_PATH();
    if (fs.existsSync(configPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        this.enabled = data.enabled ?? defaults.enabled;
        // Shift saved port by PORT_OFFSET in dev so we don't collide with built app.
        this.port = (data.port ?? defaults.port) + (IS_DEV_PROFILE ? PORT_OFFSET : 0);
        this.passwordHash = data.passwordHash ?? defaults.passwordHash;
        this.passwordPlain = data.passwordPlain ?? defaults.passwordPlain;
        this.trustTailscale = data.trustTailscale ?? defaults.trustTailscale;
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
    this.passwordPlain = defaults.passwordPlain;
    this.trustTailscale = defaults.trustTailscale;
    this.keepAwakeHours = defaults.keepAwakeHours;
    this.everPaired = defaults.everPaired;
  }

  async setPassword(plaintext: string): Promise<void> {
    this.passwordHash = await bcrypt.hash(plaintext, BCRYPT_ROUNDS);
    this.passwordPlain = plaintext;
    this.save();
  }

  async verifyPassword(plaintext: string): Promise<boolean> {
    if (!this.passwordHash) return false;
    return bcrypt.compare(plaintext, this.passwordHash);
  }

  /** Check if an IP is in the Tailscale CGNAT range (100.64.0.0/10). */
  isTailscaleIp(ip: string): boolean {
    // Strip IPv6-mapped IPv4 prefix
    const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    const parts = normalized.split('.');
    if (parts.length !== 4) return false;
    const first = parseInt(parts[0], 10);
    const second = parseInt(parts[1], 10);
    // 100.64.0.0/10 = 100.64.0.0 – 100.127.255.255
    return first === 100 && second >= 64 && second <= 127;
  }

  save(): void {
    // Dev profile shares the config file with the built app — never persist
    // dev-side edits (would clobber built-app port, password hash, etc.).
    if (IS_DEV_PROFILE) {
      console.warn('[RemoteConfig] skipping save in dev profile (shared config file)');
      return;
    }
    const configPath = CONFIG_PATH();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // Security: restrict file permissions to owner-only (contains password hash)
    fs.writeFileSync(configPath, JSON.stringify({
      enabled: this.enabled,
      port: this.port,
      passwordHash: this.passwordHash,
      trustTailscale: this.trustTailscale,
      keepAwakeHours: this.keepAwakeHours,
      everPaired: this.everPaired,
    }, null, 2), { mode: 0o600 });
  }

  /** Return config data safe for the renderer (no password hash, no plaintext password). */
  toSafeObject(): { enabled: boolean; port: number; hasPassword: boolean; password: null; trustTailscale: boolean; keepAwakeHours: number; everPaired: boolean } {
    return {
      enabled: this.enabled,
      port: this.port,
      hasPassword: !!this.passwordHash,
      password: null, // Security: never expose plaintext password over IPC or WebSocket
      trustTailscale: this.trustTailscale,
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
          : ['/usr/bin/tailscale', '/usr/local/bin/tailscale'];
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
