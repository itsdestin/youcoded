import { vi } from 'vitest';
import { chromium } from 'playwright-core';
import type { ChildProcess } from 'child_process';
import { inspect } from 'util';
import type { FoundBrowser } from '../../src/main/assistant-browser/browser-discovery';
import { readBrowserVersion } from '../../src/main/assistant-browser/browser-version';
import type { BrowserClient } from '../../src/main/assistant-browser/browser-client';

/** Test-only observation: keep the original launch options and errors intact. */
export function browserDiagnostics(suite: string) {
  const restores: Array<() => void> = [];
  const log = (level: string, message: string, data?: unknown) => {
    // WHY the production tool deliberately shortens Playwright errors for people;
    // CI needs the original call log, browser stderr and exit details to diagnose it.
    console.error(`[${suite}] ${level} ${message}${data === undefined ? '' : `\n${inspect(data, { depth: null, maxStringLength: null, maxArrayLength: null })}`}`);
  };
  return {
    log,
    async start(found: FoundBrowser[]) {
      const selected = found[0];
      log('INFO', 'Browser selection', {
        platform: process.platform, arch: process.arch, node: process.version,
        selected, candidates: found,
        // Windows Chrome --version opens a window; use the app's safe directory
        // probe there, and its bounded executable --version probe on Unix.
        version: selected ? await readBrowserVersion(selected.executablePath) : null,
      });
      const launch = chromium.launchPersistentContext.bind(chromium);
      const launchSpy = vi.spyOn(chromium, 'launchPersistentContext').mockImplementation(async (...args) => {
        log('INFO', 'launchPersistentContext', args);
        try { return await launch(...args); }
        catch (error) { log('ERROR', 'Full browser launch error (including Playwright browser stderr)', error); throw error; }
      });
      const connect = chromium.connectOverCDP.bind(chromium);
      const connectSpy = vi.spyOn(chromium, 'connectOverCDP').mockImplementation(async (...args) => {
        log('INFO', 'connectOverCDP', args);
        try { return await connect(...args); }
        catch (error) { log('ERROR', 'Full browser connection error', error); throw error; }
      });
      restores.push(() => launchSpy.mockRestore(), () => connectSpy.mockRestore());
    },
    async tool<T extends { text: string; isError?: boolean }>(name: string, call: () => Promise<T>): Promise<T> {
      try {
        const result = await call();
        if (result.isError) log('ERROR', `Tool ${name}`, result.text);
        return result;
      } catch (error) { log('ERROR', `Tool ${name} threw`, error); throw error; }
    },
    client(client: BrowserClient) {
      const call = client.callTool.bind(client);
      const spy = vi.spyOn(client, 'callTool').mockImplementation(async (...args) => {
        const result = await call(...args);
        if (result.isError) log('ERROR', `Tool ${args[0]} ${args[1]}`, result.text);
        return result;
      });
      restores.push(() => spy.mockRestore());
    },
    child(child: ChildProcess) {
      log('INFO', 'Fixture browser spawned', { pid: child.pid, executable: child.spawnfile, args: child.spawnargs });
      child.stdout?.on('data', (data: Buffer) => log('INFO', 'Fixture browser stdout', data.toString()));
      child.stderr?.on('data', (data: Buffer) => log('INFO', 'Fixture browser stderr', data.toString()));
      child.on('error', (error) => log('ERROR', 'Fixture browser child error', error));
      child.on('exit', (code, signal) => log('INFO', 'Fixture browser child exit', { code, signal }));
    },
    restore() { for (const restore of restores.splice(0).reverse()) restore(); },
  };
}
