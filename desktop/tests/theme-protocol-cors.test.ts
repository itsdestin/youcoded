import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ handle: vi.fn(), readFile: vi.fn(), realpath: vi.fn() }));
vi.mock('electron', () => ({ protocol: { handle: mocks.handle } }));
vi.mock('fs/promises', () => ({ readFile: mocks.readFile, realpath: mocks.realpath }));
import { registerThemeProtocol } from '../src/main/theme-protocol';

let handler: (request: { url: string }) => Promise<Response>;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.realpath.mockImplementation(async (file: string) => file);
  registerThemeProtocol();
  handler = mocks.handle.mock.calls[0][1];
});

describe('theme rig cross-origin fetch contract', () => {
  it('registers the scheme for CORS fetch without disabling web security', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/main/main.ts'), 'utf8');
    const registration = source.match(/protocol\.registerSchemesAsPrivileged\(\[[\s\S]*?\]\);/)?.[0];
    expect(registration).toBeTruthy();
    const register = vi.fn();
    vm.runInNewContext(registration!, { protocol: { registerSchemesAsPrivileged: register } });
    expect(register.mock.calls[0][0]).toContainEqual(expect.objectContaining({
      scheme: 'theme-asset',
      privileges: expect.objectContaining({ supportFetchAPI: true, corsEnabled: true }),
    }));
    expect(source).not.toMatch(/webSecurity\s*:\s*false/);
  });

  it('serves SVG bytes with CORS permission for dev and packaged renderer origins', async () => {
    mocks.readFile.mockResolvedValue(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    const response = await handler({ url: 'theme-asset://meadow-mist/assets/mascot-rig.svg' });
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(await response.text()).toContain('<svg');
    expect(mocks.readFile).toHaveBeenCalledWith(path.join(os.homedir(), '.claude/wecoded-themes/meadow-mist/assets/mascot-rig.svg'));
  });

  it('keeps missing assets readable as 404 rather than a CORS failure', async () => {
    mocks.readFile.mockRejectedValue(new Error('ENOENT'));
    const response = await handler({ url: 'theme-asset://meadow-mist/missing.svg' });
    expect(response.status).toBe(404);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it.each(['..', '.', '%2e%2e', 'bad%2fslug', ''])('refuses unsafe hostname %s before reading any file', async (host) => {
    mocks.readFile.mockResolvedValue(Buffer.from('private settings'));
    const response = await handler({ url: `theme-asset://${host}/settings.json` });
    expect(response.status).toBe(403);
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it.each(['theme', 'asset'])('refuses a %s symlink escaping confinement', async (kind) => {
    const root = path.join(os.homedir(), '.claude/wecoded-themes');
    const theme = path.join(root, 'meadow-mist');
    mocks.readFile.mockResolvedValue(Buffer.from('private settings'));
    mocks.realpath.mockImplementation(async (file: string) => {
      if (kind === 'theme' && file === theme) return path.dirname(root);
      if (kind === 'asset' && file === path.join(theme, 'settings.json')) return path.join(path.dirname(root), 'settings.json');
      return file;
    });
    const response = await handler({ url: 'theme-asset://meadow-mist/settings.json' });
    expect(response.status).toBe(403);
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it('still refuses encoded traversal before reading any file', async () => {
    const response = await handler({ url: 'theme-asset://meadow-mist/%2e%2e%2fprivate.json' });
    expect(response.status).toBe(403);
    expect(mocks.readFile).not.toHaveBeenCalled();
  });
});
