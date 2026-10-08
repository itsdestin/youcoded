// Pins the wiring that no behaviour test sees: channel agreement, and the off switch in main.ts.
import { describe, it, expect } from 'vitest';
import { readSource } from './helpers/guard-scope';
import { HITCH_CHANNEL, traceIpc } from '../src/main/hitch-recorder';
import { CHANNEL_TABLE, registerDesktopChannels } from '../src/main/ipc/channel-table';
import { join } from 'node:path';

const src = (...p: string[]) => readSource(join(__dirname, '..', ...p));

describe('hitch recorder wiring', () => {
  it('preload, the shared contract and main agree on the one channel', () => {
    expect(src('src', 'main', 'preload.ts')).toContain(`PERF_HITCH_BATCH: '${HITCH_CHANNEL}'`);
    // WHY the contract, not types.ts: the preload's channel list is GENERATED from backend-contract.ts (generate-preload-channels.mjs).
    expect(src('src', 'shared', 'backend-contract.ts')).toContain(`PERF_HITCH_BATCH: '${HITCH_CHANNEL}'`);
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
  // WHY (integration 2026-10-05): handlers now register through the channel table's registerDesktopChannels, on the SAME ipcMain
  // object the trace wrapped. The "last channel" hint must therefore carry the table entry's own name, not a dispatcher's.
  it('a channel registered by the channel table is named by its own name in the last-IPC hint', () => {
    const listeners = new Map<string, (...a: any[]) => unknown>();
    const fake = { handle: (c: string, f: any) => { listeners.set(c, f); }, on: (c: string, f: any) => { listeners.set(c, f); } };
    let clock = 1000;
    const trace = traceIpc(fake, () => clock);
    // Test-only entries (CHANNEL_TABLE is mutable for this): invoking a real entry could touch the developer's files.
    const mine = [
      { name: 'zz-test:hitch-handle', kind: 'handle', handler: () => 1 },
      { name: 'zz-test:hitch-fire', kind: 'on', handler: () => undefined },
    ] as any[];
    CHANNEL_TABLE.push(...mine);
    try {
      registerDesktopChannels(fake, () => null, () => {});
      expect(listeners.size).toBeGreaterThan(300); // the real table went through the wrapper too
      for (const def of mine) {
        clock += 50;
        void listeners.get(def.name)!({ sender: { id: 1 } }, undefined);
        expect(trace.last()).toEqual({ channel: def.name, agoMs: 0 });
      }
    } finally { for (const d of mine) CHANNEL_TABLE.splice(CHANNEL_TABLE.indexOf(d), 1); }
  });
});
