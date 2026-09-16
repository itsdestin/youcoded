// Remote access batch 2, design §6 "Surfaces" (T4): the strip's two channels on
// every surface. Preload declares them (desktop never shows the strip), desktop
// IPC answers not-remote, the shim implements them, the host handles
// remote:rehydrate (remote-channel-parity.test.ts checks the host case), and
// Android relies on its catch-all. App's own use is pinned in
// remote-place-app-wiring.test.ts.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readStripped, assertPatternMatches } from './helpers/guard-scope';

const src = (...p: string[]) => readStripped(join(__dirname, '..', 'src', ...p));

describe('remote:rehydrate and remote:conversation-status surfaces', () => {
  it('both IPC maps name remote:rehydrate', () => {
    const constant = /REMOTE_REHYDRATE:\s*'remote:rehydrate'/;
    assertPatternMatches(constant, "REMOTE_REHYDRATE: 'remote:rehydrate',", 'the IPC map entry');
    expect(src('main', 'preload.ts')).toMatch(constant);
    expect(src('shared', 'types.ts')).toMatch(constant);
  });

  it('preload declares rehydrate, reportHydrate and the status push', () => {
    const preload = src('main', 'preload.ts');
    const invoke = /rehydrate:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(IPC\.REMOTE_REHYDRATE\)/;
    assertPatternMatches(invoke, 'rehydrate: () => ipcRenderer.invoke(IPC.REMOTE_REHYDRATE)', 'the preload invoke');
    expect(preload).toMatch(invoke);
    const report = /reportHydrate:\s*\([^)]*\)\s*=>\s*\{\s*\}/;
    assertPatternMatches(report, 'reportHydrate: (_report: { seq?: number; kept: string[] }) => {}', 'an empty arrow');
    expect(preload).toMatch(report);
    const status = /remoteConversationStatus:\s*\([^)]*\)\s*=>\s*\(\)\s*=>\s*\{\s*\}/;
    assertPatternMatches(status, 'remoteConversationStatus: (_cb: unknown) => () => {}', 'a no-op subscriber');
    expect(preload).toMatch(status);
  });

  it('desktop IPC answers not-remote — a desktop has no remote copy to refresh', () => {
    const handler = /ipcMain\.handle\(IPC\.REMOTE_REHYDRATE,[\s\S]{0,300}?ok:\s*false,\s*code:\s*'not-remote'/;
    assertPatternMatches(handler, "ipcMain.handle(IPC.REMOTE_REHYDRATE, async () => ({ ok: false, code: 'not-remote' }))", 'the refusal');
    expect(src('main', 'ipc-handlers.ts')).toMatch(handler);
  });

  it('the shim invokes remote:rehydrate and exposes reportHydrate and the status push', () => {
    const shim = src('renderer', 'remote-shim.ts');
    const inv = /invoke\('remote:rehydrate',\s*\{\s*seq/;
    assertPatternMatches(inv, "invoke('remote:rehydrate', { seq })", 'the shim invoke');
    expect(shim).toMatch(inv);
    expect(shim).toMatch(/reportHydrate:\s*\(/);
    expect(shim).toMatch(/remoteConversationStatus:\s*\(/);
  });

  it('the workbench no longer lists them as mock-only', () => {
    const mockOnly = src('renderer', 'dev', 'workbench', 'mock-only.ts');
    expect(mockOnly).not.toMatch(/channel:\s*'on\.remoteConversationStatus'/);
    expect(mockOnly).not.toMatch(/channel:\s*'remote\.rehydrate'/);
  });
});
