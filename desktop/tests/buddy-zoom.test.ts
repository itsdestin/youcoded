import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const preload = ts.transpileModule(
  readFileSync(new URL('../src/main/preload.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } },
).outputText;

function boot(search: string) {
  const setZoomFactor = vi.fn();
  vm.runInNewContext(preload, {
    exports: {}, process: { env: {}, platform: 'linux' },
    location: { search }, URLSearchParams,
    require: () => ({
      contextBridge: { exposeInMainWorld: vi.fn() },
      ipcRenderer: { on: vi.fn() },
      webFrame: { setZoomFactor },
    }),
  });
  return setZoomFactor;
}

describe('buddy preload zoom', () => {
  it.each(['mascot', 'chat', 'bar'])('pins %s CSS pixels to native DIPs on every document load', (role) => {
    expect(boot(`?mode=buddy-${role}`)).toHaveBeenCalledExactlyOnceWith(1);
    expect(boot(`?mode=buddy-${role}`)).toHaveBeenCalledExactlyOnceWith(1);
  });
  // buddy-overlay is listed on purpose: it was a real mode until 2026-09-16 and
  // must now be treated like any other unknown string.
  it.each(['', '?mode=workbench', '?mode=buddy-unknown', '?mode=buddy-overlay', '?other=buddy-mascot'])('leaves ordinary app zoom untouched (%s)', (search) => {
    expect(boot(search)).not.toHaveBeenCalled();
  });
});
