// Loads the REAL src/main/preload.ts in a sandbox and returns the
// `window.claude` object it exposes, recording every ipcRenderer.invoke.
//
// WHY (final review F29): a parity test that hand-writes the payload the
// preload "would" send proves nothing about the preload — a method that sent
// `amount` instead of `tokens` would pass. Tests that need the real payload
// call the real preload method and read what it sent.
import { readFileSync } from 'node:fs';
// node:url's URL on purpose: a jsdom test replaces the global one.
import { URL as NodeURL, fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

export interface RealPreload {
  /** The object preload passed to contextBridge.exposeInMainWorld('claude', …). */
  claude: any;
  /** Every ipcRenderer.invoke call, in order: [channel, ...args]. */
  invokes: unknown[][];
}

let compiled: string | undefined;

export function loadRealPreload(): RealPreload {
  compiled ??= ts.transpileModule(
    readFileSync(fileURLToPath(new NodeURL('../../src/main/preload.ts', import.meta.url)), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } },
  ).outputText;
  const exposed: Record<string, any> = {};
  const invokes: unknown[][] = [];
  const noop = () => undefined;
  vm.runInNewContext(compiled, {
    exports: {}, process: { env: {}, platform: 'linux' },
    location: { search: '' }, URLSearchParams, console, setTimeout, clearTimeout,
    require: () => ({
      contextBridge: { exposeInMainWorld: (key: string, api: any) => { exposed[key] = api; } },
      ipcRenderer: {
        invoke: (...args: unknown[]) => { invokes.push(args); return Promise.resolve(undefined); },
        on: noop, off: noop, removeListener: noop, removeAllListeners: noop, send: noop, sendSync: noop,
      },
      webFrame: { setZoomFactor: noop },
      webUtils: { getPathForFile: () => '' },
    }),
  });
  return { claude: exposed.claude, invokes };
}
