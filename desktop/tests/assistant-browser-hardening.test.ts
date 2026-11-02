// Pins audit B1 (browser sandbox on, with a logged fallback on Linux hosts that cannot sandbox) and B4 (local and
// special addresses are not loadable in the assistant's browser).
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { launchSandboxed } from '../src/main/assistant-browser/browser-service';
import { navigationVerdict } from '../src/main/assistant-browser/browser-tool-runners';

describe('launchSandboxed', () => {
  it('starts with the sandbox on and does nothing else when that works', async () => {
    const launch = vi.fn(async (_sandbox: boolean) => 'ctx');
    const warn = vi.fn();
    expect(await launchSandboxed(launch, 'linux', warn)).toBe('ctx');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(true);
    expect(warn).not.toHaveBeenCalled();
  });
  it('on Linux, retries once without the sandbox when the host cannot sandbox, and logs a warning', async () => {
    const launch = vi.fn(async (sandbox: boolean) => {
      if (sandbox) throw new Error('browserType.launchPersistentContext: Target page, context or browser has been closed\n[pid=1][err] FATAL:zygote_host_impl_linux.cc(132)] No usable sandbox! Update your kernel');
      return 'ctx';
    });
    const warn = vi.fn();
    const before = vi.fn(async () => undefined);
    expect(await launchSandboxed(launch, 'linux', warn, before)).toBe('ctx');
    expect(launch.mock.calls.map((c) => c[0])).toEqual([true, false]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/WITHOUT the browser sandbox/);
    expect(before).toHaveBeenCalledTimes(1);
  });
  it('does not drop the sandbox for any other failure', async () => {
    const launch = vi.fn(async () => { throw new Error('Executable doesn\'t exist at /usr/bin/google-chrome'); });
    await expect(launchSandboxed(launch, 'linux', vi.fn())).rejects.toThrow(/Executable/);
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it('never drops the sandbox on Windows or macOS', async () => {
    for (const platform of ['win32', 'darwin'] as const) {
      const launch = vi.fn(async () => { throw new Error('No usable sandbox!'); });
      await expect(launchSandboxed(launch, platform, vi.fn())).rejects.toThrow();
      expect(launch).toHaveBeenCalledTimes(1);
    }
  });
  it('the service asks for the sandbox explicitly (Playwright otherwise adds --no-sandbox)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/main/assistant-browser/browser-service.ts'), 'utf8');
    expect(src).toMatch(/chromiumSandbox,\n/);
    expect(src).not.toMatch(/['"`]--no-sandbox/);
  });
});

describe('navigationVerdict for non-web addresses', () => {
  const env = {} as never;
  it('blocks local files, data pages and browser-internal pages', async () => {
    for (const u of ['file:///etc/passwd', 'FILE:///C:/Users/x', 'data:text/html,<h1>x</h1>', 'about:config', 'about:srcdoc#x'.replace('srcdoc', 'debug'),
      'view-source:https://example.com', 'chrome://settings', 'devtools://devtools/bundled/inspector.html', 'javascript:alert(1)', 'chrome-extension://abc/x.html', 'ftp://example.com/']) {
      expect(await navigationVerdict(env, null, u), u).toBe('block');
    }
  });
  it('still allows an empty page, a page\'s own embedded document, its blobs and the browser error page', async () => {
    for (const u of ['about:blank', 'about:srcdoc', 'blob:https://example.com/abc', 'chrome-error://chromewebdata/']) {
      expect(await navigationVerdict(env, null, u), u).toBe('allow');
    }
  });
});
