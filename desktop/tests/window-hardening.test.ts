// Pins that one call applies every per-window security rule: the permission policy, the Office frame guard and the preview frame guard.
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ shell: {} }));
import { secureAppWindow } from '../src/main/window-hardening';

describe('secureAppWindow', () => {
  it('installs the permission policy and both frame guards on the window', () => {
    const frameListeners: Array<(e: any) => void> = [];
    const session = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() };
    const win = { webContents: { session, mainFrame: { frameTreeNodeId: 1 }, on: (_e: string, l: (e: any) => void) => { frameListeners.push(l); } } };
    secureAppWindow(win as any, { devServerUrl: 'http://localhost:5223', mainDir: '/app/dist/main', log: vi.fn() });
    expect(session.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(session.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
    expect(frameListeners).toHaveLength(2);   // Office frames + preview frames, both on will-frame-navigate

    // A preview frame (directly under the app page) trying to leave for a website is cancelled by the second listener.
    const preview = { url: 'about:srcdoc', frameTreeNodeId: 7, parent: { url: 'file:///app/index.html', frameTreeNodeId: 1, parent: null } };
    const nav = { url: 'https://lookalike.example/', isMainFrame: false, frame: preview, preventDefault: vi.fn() };
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    frameListeners.forEach((l) => l(nav));
    quiet.mockRestore();
    expect(nav.preventDefault).toHaveBeenCalled();
  });
});
