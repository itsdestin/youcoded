import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Must mock before importing the module
vi.mock('fs');
vi.mock('os');

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

    expect(config.enabled).toBe(true);
    expect(config.port).toBe(9900);
    expect(config.passwordHash).toBeNull();
    expect(config.trustTailscale).toBe(false);
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
    expect(config.trustTailscale).toBe(true);
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

  it('isTailscaleIp detects CGNAT range', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { RemoteConfig } = await import('../src/main/remote-config');
    const config = new RemoteConfig();

    expect(config.isTailscaleIp('100.64.1.1')).toBe(true);
    expect(config.isTailscaleIp('100.127.255.255')).toBe(true);
    expect(config.isTailscaleIp('100.128.0.0')).toBe(false);
    expect(config.isTailscaleIp('192.168.1.1')).toBe(false);
    // IPv6-mapped IPv4
    expect(config.isTailscaleIp('::ffff:100.64.1.1')).toBe(true);
    expect(config.isTailscaleIp('::ffff:192.168.1.1')).toBe(false);
  });
});
