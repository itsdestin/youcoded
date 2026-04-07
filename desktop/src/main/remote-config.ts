import fs from 'fs';
import path from 'path';
import os from 'os';
import bcrypt from 'bcryptjs';

const CONFIG_PATH = () => path.join(os.homedir(), '.claude', 'destincode-remote.json');
const BCRYPT_ROUNDS = 10;

interface ConfigData {
  enabled: boolean;
  port: number;
  passwordHash: string | null;
  trustTailscale: boolean;
  keepAwakeHours: number; // 0 = off
}

export class RemoteConfig {
  enabled: boolean;
  port: number;
  passwordHash: string | null;
  trustTailscale: boolean;
  keepAwakeHours: number;

  constructor() {
    const defaults: ConfigData = {
      enabled: true,
      port: 9900,
      passwordHash: null,
      trustTailscale: false,
      keepAwakeHours: 0,
    };

    const configPath = CONFIG_PATH();
    if (fs.existsSync(configPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        this.enabled = data.enabled ?? defaults.enabled;
        this.port = data.port ?? defaults.port;
        this.passwordHash = data.passwordHash ?? defaults.passwordHash;
        this.trustTailscale = data.trustTailscale ?? defaults.trustTailscale;
        this.keepAwakeHours = data.keepAwakeHours ?? defaults.keepAwakeHours;
        return;
      } catch {
        // Fall through to defaults
      }
    }

    this.enabled = defaults.enabled;
    this.port = defaults.port;
    this.passwordHash = defaults.passwordHash;
    this.trustTailscale = defaults.trustTailscale;
    this.keepAwakeHours = defaults.keepAwakeHours;
  }

  async setPassword(plaintext: string): Promise<void> {
    this.passwordHash = await bcrypt.hash(plaintext, BCRYPT_ROUNDS);
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
    const configPath = CONFIG_PATH();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      enabled: this.enabled,
      port: this.port,
      passwordHash: this.passwordHash,
      trustTailscale: this.trustTailscale,
      keepAwakeHours: this.keepAwakeHours,
    }, null, 2));
  }

  /** Return config data safe for the renderer (no password hash). */
  toSafeObject(): { enabled: boolean; port: number; hasPassword: boolean; trustTailscale: boolean; keepAwakeHours: number } {
    return {
      enabled: this.enabled,
      port: this.port,
      hasPassword: !!this.passwordHash,
      trustTailscale: this.trustTailscale,
      keepAwakeHours: this.keepAwakeHours,
    };
  }

  /** Detect Tailscale installation and connection status. */
  static async detectTailscale(port: number): Promise<{ installed: boolean; ip: string | null; hostname: string | null; url: string | null }> {
    try {
      const { execFile } = require('child_process');
      const { promisify } = require('util');
      const execFileAsync = promisify(execFile);
      let tsPath = 'tailscale';
      try { const w = require('which'); tsPath = w.sync('tailscale'); } catch {}
      // Platform-specific fallbacks when tailscale isn't on PATH
      if (tsPath === 'tailscale') {
        const fs = require('fs');
        const candidates = process.platform === 'win32'
          ? ['C:\\Program Files\\Tailscale\\tailscale.exe', `${process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'}\\Tailscale\\tailscale.exe`]
          : process.platform === 'darwin'
            ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale']
            : ['/usr/bin/tailscale', '/usr/local/bin/tailscale'];
        for (const p of candidates) {
          try { fs.accessSync(p); tsPath = p; break; } catch {}
        }
      }

      const { stdout: ip } = await execFileAsync(tsPath, ['ip', '-4']);
      const tailscaleIp = ip.trim();

      let hostname = '';
      try {
        const { stdout: statusJson } = await execFileAsync(tsPath, ['status', '--json']);
        const status = JSON.parse(statusJson);
        hostname = status.Self?.HostName || '';
      } catch {}

      return { installed: true, ip: tailscaleIp, hostname, url: `http://${tailscaleIp}:${port}` };
    } catch {
      return { installed: false, ip: null, hostname: null, url: null };
    }
  }
}
