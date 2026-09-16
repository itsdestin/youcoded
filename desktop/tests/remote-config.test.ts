import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Must mock before importing the module
vi.mock('fs');
vi.mock('os');

// child_process.execFile is required() inside detectTailscale. We intercept
// it so each test can deterministically simulate the tailscale CLI's behavior.
// vi.hoisted is required because vi.mock factories run before normal `const`
// declarations are initialized — without hoisting, the closure would capture
// an undefined execFileMock and the real binary would run.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('child_process', () => ({
  execFile: (file: string, args: string[], cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void) => {
    try {
      const stdout = execFileMock(file, args);
      cb(null, { stdout, stderr: '' });
    } catch (err) {
      cb(err as Error);
    }
  },
}));

// `which` is also require()'d inside resolveTailscalePath. Force it to throw
// so the candidate-path fallback runs (and uses our mocked fs.accessSync).
vi.mock('which', () => ({
  default: { sync: () => { throw new Error('not found'); } },
  sync: () => { throw new Error('not found'); },
}));

describe('RemoteConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.mocked(os.homedir).mockReturnValue('/mock/home');
  });

  it('returns defaults when config file does not exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { RemoteConfig } = await import('../src/main/remote-config');
    const config = new RemoteConfig();

    expect(config.enabled).toBe(false);
    expect(config.port).toBe(9900);
    expect(config.passwordHash).toBeNull();
  });

  it('loads config from disk', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      enabled: false,
      port: 8080,
      passwordHash: '$2b$10$fakehash',
      trustTailscale: true,
    }));
    const { RemoteConfig } = await import('../src/main/remote-config');
    const config = new RemoteConfig();

    expect(config.enabled).toBe(false);
    expect(config.port).toBe(8080);
    expect(config.passwordHash).toBe('$2b$10$fakehash');
    // Contract R9: a saved trustTailscale is read past and granted nothing. An existing
    // user who had switched it on is not silently left trusted after the upgrade.
    expect((config as unknown as Record<string, unknown>).trustTailscale).toBeUndefined();
  });

  it('setPassword hashes and saves to disk', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    const { RemoteConfig } = await import('../src/main/remote-config');
    const config = new RemoteConfig();

    await config.setPassword('test123');

    expect(config.passwordHash).toBeTruthy();
    expect(config.passwordHash).toMatch(/^\$2[ab]\$/);
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('verifyPassword returns true for correct password', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    const { RemoteConfig } = await import('../src/main/remote-config');
    const config = new RemoteConfig();

    await config.setPassword('mypass');
    const result = await config.verifyPassword('mypass');

    expect(result).toBe(true);
  });

  it('verifyPassword returns false for wrong password', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    const { RemoteConfig } = await import('../src/main/remote-config');
    const config = new RemoteConfig();

    await config.setPassword('mypass');
    const result = await config.verifyPassword('wrongpass');

    expect(result).toBe(false);
  });

  it('flags a short password as weak, and a long one as not (2026-09-10 security review)', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    const { RemoteConfig } = await import('../src/main/remote-config');
    const config = new RemoteConfig();

    await config.setPassword('short'); // 5 chars, under the 8-char minimum
    expect(config.weakPassword).toBe(true);
    expect(config.toSafeObject().weakPassword).toBe(true);

    await config.setPassword('abcd-efgh-jkmn'); // >= 8
    expect(config.weakPassword).toBe(false);
    expect(config.toSafeObject().weakPassword).toBe(false);
  });

  it('learns a hand-edited short password is weak on a successful sign-in', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    const { RemoteConfig } = await import('../src/main/remote-config');
    const config = new RemoteConfig();

    await config.setPassword('1'); // simulate a legacy one-char password
    config.weakPassword = false;   // pretend we don't know its length yet (e.g. loaded from disk)
    const ok = await config.verifyPassword('1');
    expect(ok).toBe(true);
    expect(config.weakPassword).toBe(true);
  });

  it('no longer offers a way to trust an address instead of a password', async () => {
    // The removed check treated 100.64.0.0/10 as proof of Tailscale membership. That is the
    // carrier-grade NAT range, not one Tailscale owns, and membership was never authorization.
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { RemoteConfig } = await import('../src/main/remote-config');
    const config = new RemoteConfig() as unknown as Record<string, unknown>;

    expect(config.isTailscaleIp).toBeUndefined();
    expect(config.trustTailscale).toBeUndefined();
  });

  describe('detectTailscale', () => {
    beforeEach(() => {
      execFileMock.mockReset();
      vi.mocked(fs.existsSync).mockReturnValue(false);
    });

    it('returns installed:false when binary is missing', async () => {
      // No candidate path exists on disk and `tailscale version` is never reached
      // because resolveTailscalePath falls through to the literal 'tailscale',
      // which then fails the version probe.
      vi.mocked(fs.accessSync).mockImplementation(() => { throw new Error('ENOENT'); });
      execFileMock.mockImplementation(() => { throw new Error('ENOENT'); });

      const { RemoteConfig } = await import('../src/main/remote-config');
      const result = await RemoteConfig.detectTailscale(9900);

      expect(result).toEqual({
        installed: false,
        connected: false,
        // The setup banner needs to know WHICH prerequisite is missing, so a missing
        // binary is reported as its own state rather than one flat not-connected flag.
        state: 'not-installed',
        ip: null,
        hostname: null,
        url: null,
      });
    });

    it('returns installed:true, connected:false when VPN is stopped (regression test)', async () => {
      // Binary exists at a candidate path on disk...
      vi.mocked(fs.accessSync).mockImplementation(() => {});
      // ...but `tailscale status --json` fails because the daemon is stopped.
      // Previously this also tried `tailscale ip -4` first and the failure
      // caused the function to return installed:false. Regression guard.
      execFileMock.mockImplementation((_file: string, args: string[]) => {
        if (args[0] === 'status') throw new Error('failed to connect to local Tailscale daemon');
        if (args[0] === 'ip') throw new Error('Tailscale is stopped');
        return '';
      });

      const { RemoteConfig } = await import('../src/main/remote-config');
      const result = await RemoteConfig.detectTailscale(9900);

      expect(result.installed).toBe(true);
      expect(result.connected).toBe(false);
      expect(result.ip).toBeNull();
      expect(result.url).toBeNull();
      // Tailscale said nothing we can act on, so neither do we. The setup banner reads
      // this and offers a plain Connect rather than naming a cause it cannot know.
      expect(result.state).toBe('unknown');
    });

    it('returns installed:true, connected:false when daemon reports BackendState !== Running', async () => {
      vi.mocked(fs.accessSync).mockImplementation(() => {});
      execFileMock.mockImplementation((_file: string, args: string[]) => {
        if (args[0] === 'status') return JSON.stringify({ BackendState: 'Stopped', Self: { HostName: 'mybox' } });
        return '';
      });

      const { RemoteConfig } = await import('../src/main/remote-config');
      const result = await RemoteConfig.detectTailscale(9900);

      expect(result.installed).toBe(true);
      expect(result.connected).toBe(false);
      expect(result.hostname).toBe('mybox');
      expect(result.ip).toBeNull();
      expect(result.url).toBeNull();
      expect(result.state).toBe('stopped');
    });

    it('separates signed out from switched off, because the next step differs', async () => {
      // One flat connected:false sent both users to "open the Tailscale app and turn it
      // on" — useless advice for a machine that is running but has never been signed in.
      vi.mocked(fs.accessSync).mockImplementation(() => {});
      execFileMock.mockImplementation((_file: string, args: string[]) => {
        if (args[0] === 'status') return JSON.stringify({ BackendState: 'NeedsLogin', Self: { HostName: 'mybox' } });
        return '';
      });

      const { RemoteConfig } = await import('../src/main/remote-config');
      const result = await RemoteConfig.detectTailscale(9900);

      expect(result.installed).toBe(true);
      expect(result.connected).toBe(false);
      expect(result.state).toBe('signed-out');
    });

    it('calls a starting daemon unknown rather than switched off', async () => {
      // Starting is transitional. Telling the user to switch on something that is already
      // switching on sends them to fix a problem that is fixing itself.
      vi.mocked(fs.accessSync).mockImplementation(() => {});
      execFileMock.mockImplementation((_file: string, args: string[]) => {
        if (args[0] === 'status') return JSON.stringify({ BackendState: 'Starting', Self: { HostName: 'mybox' } });
        return '';
      });

      const { RemoteConfig } = await import('../src/main/remote-config');
      const result = await RemoteConfig.detectTailscale(9900);

      expect(result.state).toBe('unknown');
    });

    it('returns installed:true, connected:true with IP from status JSON when running', async () => {
      vi.mocked(fs.accessSync).mockImplementation(() => {});
      execFileMock.mockImplementation((_file: string, args: string[]) => {
        if (args[0] === 'status') return JSON.stringify({
          BackendState: 'Running',
          Self: { HostName: 'mybox', TailscaleIPs: ['100.64.1.5', 'fd7a:115c::1'] },
        });
        return '';
      });

      const { RemoteConfig } = await import('../src/main/remote-config');
      const result = await RemoteConfig.detectTailscale(9900);

      expect(result.installed).toBe(true);
      expect(result.connected).toBe(true);
      expect(result.hostname).toBe('mybox');
      expect(result.ip).toBe('100.64.1.5');
      expect(result.url).toBe('http://100.64.1.5:9900');
    });

    it('falls back to `tailscale ip -4` when status JSON has no TailscaleIPs', async () => {
      vi.mocked(fs.accessSync).mockImplementation(() => {});
      execFileMock.mockImplementation((_file: string, args: string[]) => {
        if (args[0] === 'status') return JSON.stringify({ BackendState: 'Running', Self: { HostName: 'mybox' } });
        if (args[0] === 'ip') return '100.64.1.5\n';
        return '';
      });

      const { RemoteConfig } = await import('../src/main/remote-config');
      const result = await RemoteConfig.detectTailscale(9900);

      expect(result.connected).toBe(true);
      expect(result.ip).toBe('100.64.1.5');
      expect(result.url).toBe('http://100.64.1.5:9900');
    });
  });
});

// Dev-profile config isolation. Before this, every profile shared the built
// app's ~/.claude/youcoded-remote.json, so save() had to be a hard no-op —
// which meant remote access could never be enabled from a dev instance and
// remote features were untestable outside a production install.
describe('RemoteConfig dev-profile isolation', () => {
  const ORIGINAL_PROFILE = process.env.YOUCODED_PROFILE;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.mocked(os.homedir).mockReturnValue('/mock/home');
  });

  afterEach(() => {
    // PROFILE is captured at module load, so the env var must be restored or
    // it leaks into every later dynamic import in this file.
    if (ORIGINAL_PROFILE === undefined) delete process.env.YOUCODED_PROFILE;
    else process.env.YOUCODED_PROFILE = ORIGINAL_PROFILE;
  });

  it('reads a per-profile file instead of the built app config', async () => {
    process.env.YOUCODED_PROFILE = 'dev';
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { RemoteConfig } = await import('../src/main/remote-config');
    new RemoteConfig();

    const readPath = vi.mocked(fs.existsSync).mock.calls[0][0];
    expect(readPath).toBe(path.join('/mock/home', '.claude', 'youcoded-remote.dev.json'));
    expect(readPath).not.toBe(path.join('/mock/home', '.claude', 'youcoded-remote.json'));
  });

  it('persists in a dev profile, and only to the dev file', async () => {
    process.env.YOUCODED_PROFILE = 'dev';
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { RemoteConfig } = await import('../src/main/remote-config');
    const config = new RemoteConfig();
    config.enabled = true;
    config.save();

    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const [writePath, body] = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(writePath).toBe(path.join('/mock/home', '.claude', 'youcoded-remote.dev.json'));
    expect(JSON.parse(body as string).enabled).toBe(true);
  });

  it('still uses the unsuffixed file when no profile is set (built app)', async () => {
    delete process.env.YOUCODED_PROFILE;
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { RemoteConfig } = await import('../src/main/remote-config');
    new RemoteConfig();

    expect(vi.mocked(fs.existsSync).mock.calls[0][0])
      .toBe(path.join('/mock/home', '.claude', 'youcoded-remote.json'));
  });

  it('does not re-apply the port offset to a saved dev port', async () => {
    // The dev file already stores dev's own port; re-adding PORT_OFFSET on
    // load would drift it by 50 on every save/load cycle.
    process.env.YOUCODED_PROFILE = 'dev';
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ enabled: true, port: 9950 }));
    const { RemoteConfig } = await import('../src/main/remote-config');
    expect(new RemoteConfig().port).toBe(9950);
  });
});
