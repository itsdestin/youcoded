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
  it.each(['mascot', 'chat', 'bar', 'overlay'])('pins %s CSS pixels to native DIPs on every document load', (role) => {
    expect(boot(`?mode=buddy-${role}`)).toHaveBeenCalledExactlyOnceWith(1);
    expect(boot(`?mode=buddy-${role}`)).toHaveBeenCalledExactlyOnceWith(1);
  });
  it.each(['', '?mode=workbench', '?mode=buddy-unknown', '?other=buddy-mascot'])('leaves ordinary app zoom untouched (%s)', (search) => {
    expect(boot(search)).not.toHaveBeenCalled();
  });
});
