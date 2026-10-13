// @vitest-environment jsdom
import { describe, test, expect, beforeEach, vi } from 'vitest';

// platform.ts sets window.__PLATFORM__ once on import from
// synchronously-available signals (location.protocol, window.claude).
// Packaged Electron on Windows loads the renderer via `win.loadFile()`,
// so location.protocol is 'file:' — the same as Android's WebView.
// The detection must prefer the window.claude signal (injected by the
// Electron preload) over the protocol check, otherwise packaged desktop
// is mis-tagged as Android.

async function runBootstrap(): Promise<string | undefined> {
  vi.resetModules();
  delete (window as any).__PLATFORM__;
  delete document.documentElement.dataset.platform;
  await import('../src/renderer/platform');
  return (window as any).__PLATFORM__;
}

function setProtocol(protocol: 'file:' | 'http:' | 'https:') {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, protocol },
  });
}

describe('platform startup detection', () => {
  beforeEach(() => {
    delete (window as any).claude;
  });

  test('packaged Electron desktop (file:// + preload-injected window.claude) is detected as electron', async () => {
    setProtocol('file:');
    (window as any).claude = { __marker: 'preload-injected' };
    expect(await runBootstrap()).toBe('electron');
  });

  test('Android WebView (file:// without window.claude) is detected as android', async () => {
    setProtocol('file:');
    expect(await runBootstrap()).toBe('android');
  });

  test('dev-mode Electron (http://localhost + window.claude) is detected as electron', async () => {
    setProtocol('http:');
    (window as any).claude = { __marker: 'preload-injected' };
    expect(await runBootstrap()).toBe('electron');
  });

  test('remote browser (http(s):// without window.claude) is left undefined for remote-shim auth:ok to fill in', async () => {
    setProtocol('https:');
    expect(await runBootstrap()).toBeUndefined();
  });

  test('html[data-platform] is mirrored when __PLATFORM__ is set', async () => {
    setProtocol('file:');
    (window as any).claude = {};
    await runBootstrap();
    expect(document.documentElement.dataset.platform).toBe('electron');
  });
});

describe('getCapabilities', () => {
  async function load() {
    vi.resetModules();
    return await import('../src/renderer/platform');
  }
  beforeEach(() => { delete (window as any).claude; });

  test('a screen that has heard nothing from its host gets the conservative set', async () => {
    const { getCapabilities } = await load();
    expect(getCapabilities()).toMatchObject({ nativeWindows: false, openInOs: false, nativeSessions: false, terminalTransport: 'text' });
  });

  test('reads what the host said, on every call (the answer can change when the screen reconnects elsewhere)', async () => {
    const { getCapabilities } = await load();
    (window as any).claude = { capabilities: { openInOs: true, terminalTransport: 'raw-bytes' } };
    expect(getCapabilities()).toMatchObject({ openInOs: true, terminalTransport: 'raw-bytes', nativeWindows: false });
    (window as any).claude = { capabilities: { openInOs: false } };
    expect(getCapabilities().openInOs).toBe(false);
  });
});
