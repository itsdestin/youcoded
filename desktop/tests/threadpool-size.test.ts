// The app's entry point raises libuv's thread pool from 4 to 16 threads, so a stalled disk cannot
// hold every helper thread and queue all other async file work (2026-10-22 freeze hunt). The size
// is read only when the pool first starts, so it must be set BEFORE the app's own modules load.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as ts from 'typescript';

function runBootstrap(env: Record<string, string>) {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/bootstrap.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const proc = { env };
  let sizeWhenAppLoaded: string | undefined;
  vm.runInNewContext(compiled, { process: proc, require: () => { sizeWhenAppLoaded = proc.env.UV_THREADPOOL_SIZE; } });
  return { sizeWhenAppLoaded, env: proc.env };
}

describe('libuv thread pool size', () => {
  it('is 16 by the time the app loads', () => {
    expect(runBootstrap({}).sizeWhenAppLoaded).toBe('16');
  });
  it('respects a value the launcher set', () => {
    expect(runBootstrap({ UV_THREADPOOL_SIZE: '8' }).env.UV_THREADPOOL_SIZE).toBe('8');
  });
  it('the headless (Android) entry sets it before its first import', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/headless/headless-main.ts'), 'utf8');
    expect(src.indexOf("UV_THREADPOOL_SIZE = '16'")).toBeGreaterThan(-1);
    expect(src.indexOf("UV_THREADPOOL_SIZE = '16'")).toBeLessThan(src.indexOf("import './install-electron-shim'"));
  });
});
