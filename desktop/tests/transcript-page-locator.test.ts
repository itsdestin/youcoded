import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Electron mock: identical to ipc-handlers.test.ts (registerIpcHandlers
// transitively imports main.ts, which touches Electron at module scope).
vi.mock('electron', () => {
  const BrowserWindowMock: any = vi.fn(() => ({ loadURL: vi.fn(), on: vi.fn(), webContents: { send: vi.fn() } }));
  BrowserWindowMock.getAllWindows = vi.fn(() => []);
  return {
    app: { isPackaged: false, getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0-test'), whenReady: vi.fn(() => new Promise(() => {})), on: vi.fn(), quit: vi.fn(), setAppUserModelId: vi.fn(), commandLine: { appendSwitch: vi.fn() }, getGPUInfo: vi.fn(() => new Promise(() => {})) },
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    BrowserWindow: BrowserWindowMock,
    Menu: { setApplicationMenu: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    dialog: { showOpenDialog: vi.fn() },
    clipboard: { readImage: vi.fn(() => ({ isEmpty: () => true })) },
    nativeImage: {},
    shell: { openExternal: vi.fn() },
    powerSaveBlocker: { start: vi.fn(() => 0), stop: vi.fn() },
  };
});

import { registerIpcHandlers } from '../src/main/ipc-handlers';
import { WindowRegistry } from '../src/main/window-registry';

/**
 * Scroll-back on a just-resumed conversation.
 *
 * The FIRST page request carries a fallback locator (claudeSessionId +
 * projectSlug) because a just-resumed CC session is not watched yet — the
 * watcher starts when CC's SessionStart hook reports the transcript path, a
 * second or two later. Every SUBSEQUENT request (the scroll-up sentinel in
 * ChatView, the buddy floater) carries only a cursor. Until this suite, main
 * answered those with `{events: [], cursor: null, hasMore: false}` — byte-for-byte
 * the answer for "you have reached the beginning of the conversation" — and the
 * reducer permanently dropped the cursor and the sentinel. Destin, 2026-09-07:
 * "the first handful of messages load fine, but then nothing before those loads."
 */

function turnLines(i: number): string {
  const user = JSON.stringify({
    type: 'user', uuid: `u-${i}`, promptId: `p-${i}`, isMeta: false,
    timestamp: new Date(1_700_000_000_000 + i).toISOString(),
    message: { role: 'user', content: `prompt ${i}` },
  });
  const asst = JSON.stringify({
    type: 'assistant', uuid: `a-${i}`,
    timestamp: new Date(1_700_000_000_001 + i).toISOString(),
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `reply ${i}` }] },
  });
  return user + '\n' + asst + '\n';
}

const CC_ID = 'ccsession-1';
const SLUG = '-home-destin-project';

describe('transcript:page locator memory', () => {
  let tmpHome: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;
  let mockIpcMain: { handle: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-page-locator-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    mockIpcMain = { handle: vi.fn(), on: vi.fn() };
  });

  afterEach(() => {
    homedirSpy.mockRestore();
    try { fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); } catch { /* best-effort */ }
  });

  function writeTranscript(turns: number, slug = SLUG, ccId = CC_ID): void {
    const dir = path.join(tmpHome, '.claude', 'projects', slug);
    fs.mkdirSync(dir, { recursive: true });
    let body = '';
    for (let i = 0; i < turns; i++) body += turnLines(i);
    fs.writeFileSync(path.join(dir, `${ccId}.jsonl`), body);
  }

  function pageHandler(windowRegistry?: WindowRegistry) {
    const mockSessionManager: any = {
      createSession: vi.fn(), destroySession: vi.fn(), listSessions: vi.fn(() => []),
      getSession: vi.fn(() => undefined),
      sendInput: vi.fn(), resizeSession: vi.fn(), on: vi.fn(),
    };
    const mockWindow: any = { webContents: { send: vi.fn() }, isDestroyed: () => false };
    const mockSkillProvider: any = {
      configStore: { getPackages: vi.fn(() => ({})) },
      install: vi.fn(), installMany: vi.fn(),
      ensureBundledPluginsInstalled: vi.fn(), ensureMigrated: vi.fn(),
    };
    const mockCommandProvider: any = { list: vi.fn(() => []), refresh: vi.fn() };
    registerIpcHandlers(
      mockIpcMain as any, mockSessionManager, mockWindow, mockSkillProvider, mockCommandProvider,
      undefined, undefined, undefined, windowRegistry,
    );
    const call = (mockIpcMain.handle as any).mock.calls.find((c: any) => c[0] === 'transcript:page');
    return call[1] as (evt: any, req: any) => Promise<any>;
  }

  const evt = { sender: { id: 1 } };

  it('a scroll-up request resolves the file the first page already located', async () => {
    writeTranscript(40);
    const handler = pageHandler();

    const first = await handler(evt, {
      sessionId: 'desktop-1', beforeCursor: null, claudeSessionId: CC_ID, projectSlug: SLUG,
    });
    expect(first.hasMore).toBe(true);
    expect(first.cursor).not.toBeNull();

    // The sentinel's request. ChatView has no locator to send — only the cursor.
    const older = await handler(evt, { sessionId: 'desktop-1', beforeCursor: first.cursor });
    expect(older.events.length).toBeGreaterThan(0);
  });

  it('reports that it could not locate the transcript, rather than "no more history"', async () => {
    const handler = pageHandler();
    const page = await handler(evt, { sessionId: 'never-seen', beforeCursor: null });
    expect(page.events).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.unresolved).toBe(true);
  });

  it('reaching the real beginning of a conversation is NOT reported as unresolved', async () => {
    writeTranscript(3);
    const handler = pageHandler();
    const page = await handler(evt, {
      sessionId: 'desktop-1', beforeCursor: null, claudeSessionId: CC_ID, projectSlug: SLUG,
    });
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.hasMore).toBe(false);
    expect(page.unresolved).toBeFalsy();
  });

  it('never remembers a traversal-shaped locator', async () => {
    writeTranscript(40);
    const handler = pageHandler();

    const bad = await handler(evt, {
      sessionId: 'desktop-1', beforeCursor: null,
      claudeSessionId: '../../../../etc/passwd', projectSlug: SLUG,
    });
    expect(bad.events).toEqual([]);
    expect(bad.unresolved).toBe(true);

    // …and nothing was stashed under that session id for a later request to use.
    const older = await handler(evt, {
      sessionId: 'desktop-1', beforeCursor: { path: 'x', offset: 10, sizeAtRead: 10 },
    });
    expect(older.unresolved).toBe(true);
  });

  // A window that INHERITED a session by tear-off is marked so its first page
  // reads to EOF (WindowRegistry.markInheritedByTransfer) — without that it
  // renders a conversation frozen at the moment the session was resumed. The
  // mark is a ONE-SHOT consumed by the first `beforeCursor: null` request, and
  // first-page requests now retry for longer while main reports `unresolved`,
  // so an attempt that served nothing must not be the one that spends it.
  it('an unresolved answer does not spend the tear-off read-to-EOF mark', async () => {
    const registry = new WindowRegistry();
    registry.markInheritedByTransfer('desktop-1', 1);
    const handler = pageHandler(registry);

    const page = await handler(evt, { sessionId: 'desktop-1', beforeCursor: null });
    expect(page.unresolved).toBe(true);

    expect(registry.consumeInheritedByTransfer('desktop-1', 1)).toBe(true);
  });

  it('forgets a remembered locator when its session is destroyed', async () => {
    writeTranscript(40);
    const handler = pageHandler();
    await handler(evt, {
      sessionId: 'desktop-1', beforeCursor: null, claudeSessionId: CC_ID, projectSlug: SLUG,
    });

    const destroy = (mockIpcMain.handle as any).mock.calls.find((c: any) => c[0] === 'session:destroy')[1];
    await destroy(evt, 'desktop-1');

    const older = await handler(evt, { sessionId: 'desktop-1', beforeCursor: null });
    expect(older.unresolved).toBe(true);
  });
});
