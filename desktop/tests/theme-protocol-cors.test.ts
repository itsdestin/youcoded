import path from 'node:path';
import os from 'node:os';
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

// WHY no main.ts read here any more (Plan B, 2026-09-16): "main.ts never sets
// `webSecurity: false`" is the ast-grep rule main-web-security-never-disabled.
describe('theme rig cross-origin fetch contract', () => {
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
