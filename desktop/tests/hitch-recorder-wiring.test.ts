// Pins the wiring that no behaviour test sees: channel agreement, and the off switch in main.ts.
import { describe, it, expect } from 'vitest';
import { readSource } from './helpers/guard-scope';
import { HITCH_CHANNEL } from '../src/main/hitch-recorder';
import { join } from 'node:path';

const src = (...p: string[]) => readSource(join(__dirname, '..', ...p));

describe('hitch recorder wiring', () => {
  it('preload, shared types and main agree on the one channel', () => {
    expect(src('src', 'main', 'preload.ts')).toContain(`PERF_HITCH_BATCH: '${HITCH_CHANNEL}'`);
    expect(src('src', 'shared', 'types.ts')).toContain(`PERF_HITCH_BATCH: '${HITCH_CHANNEL}'`);
  });
  it('the channel is fire-only desktop: no remote shim, host or Android surface carries it', () => {
    expect(src('src', 'renderer', 'remote-shim.ts')).not.toContain(HITCH_CHANNEL);
    expect(src('src', 'main', 'remote-server.ts')).not.toContain(HITCH_CHANNEL);
    expect(readSource(join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'))).not.toContain(HITCH_CHANNEL);
  });
  it('main wraps ipcMain before registering handlers and honours the off switch', () => {
    const main = src('src', 'main', 'main.ts');
    expect(main.indexOf('traceIpc(ipcMain)')).toBeGreaterThan(0);
    expect(main.indexOf('traceIpc(ipcMain)')).toBeLessThan(main.indexOf('registerIpcHandlers('));
    expect(main).toContain('hitchLogDisabled()');
    expect(main).toContain('hitchRecorder?.noteMainWindowLoaded()');
  });
  it('main tells the recorder about suspend, resume and screen lock', () => {
    const main = src('src', 'main', 'main.ts');
    for (const ev of ['suspend', 'resume', 'lock-screen', 'unlock-screen']) expect(main).toContain(`'${ev}'`);
    expect(main).toContain('hitchRecorder?.noteSleep()');
  });
  it('the recorder module writes only through the async writer (no sync fs)', () => {
    for (const f of ['hitch-recorder.ts', 'hitch-log-writer.ts', 'hitch-validate.ts']) {
      expect(src('src', 'main', f)).not.toMatch(/\b(readFileSync|writeFileSync|appendFileSync|existsSync|statSync|mkdirSync|renameSync|openSync)\b/);
    }
  });
});
