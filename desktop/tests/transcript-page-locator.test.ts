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
import { TranscriptWatcher } from '../src/main/transcript-watcher';
import { NativeSessionHost } from '../src/main/harness/native-session-host';
import { shouldReconcileNativePage, snapshotResumeBoundary } from '../src/main/transcript-page-source';

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

describe('history page interruption boundary', () => {
  it('reconciles native history only when the host confirms the session is idle', () => {
    expect(shouldReconcileNativePage({ nativeIdle: true, inherited: false, olderPage: false })).toBe(true);
    expect(shouldReconcileNativePage({ nativeIdle: false, inherited: false, olderPage: false })).toBe(false);
  });

  it('reconciles idle older pages, but never guesses that a busy or transferred page is stale', () => {
    expect(shouldReconcileNativePage({ nativeIdle: true, inherited: false, olderPage: true })).toBe(true);
    expect(shouldReconcileNativePage({ nativeIdle: false, inherited: false, olderPage: true })).toBe(false);
    expect(shouldReconcileNativePage({ nativeIdle: true, inherited: true, olderPage: true })).toBe(false);
  });
});

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

  function pageHandler(windowRegistry?: WindowRegistry, sessionManagerOverride?: any, remoteServer?: any) {
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
      mockIpcMain as any, sessionManagerOverride ?? mockSessionManager, mockWindow, mockSkillProvider, mockCommandProvider,
      undefined, undefined, remoteServer, windowRegistry,
    );
    const call = [...(mockIpcMain.handle as any).mock.calls].reverse().find((c: any) => c[0] === 'transcript:page');
    return call[1] as (evt: any, req: any) => Promise<any>;
  }

  const evt = { sender: { id: 1 } };

  it('does not interrupt a native turn that starts while history is being read', async () => {
    const history = vi.spyOn(NativeSessionHost.prototype, 'getHistoryPageAsync').mockResolvedValue({
      events: [{ type: 'tool-use', sessionId: 'native-1', uuid: 'u1', timestamp: 1,
        data: { toolUseId: 't1', toolName: 'Bash', toolInput: {} } }],
      nextIndex: null, hasMore: false,
    });
    const live = vi.spyOn(NativeSessionHost.prototype, 'isLive').mockReturnValue(true);
    const idle = vi.spyOn(NativeSessionHost.prototype, 'isIdle')
      .mockReturnValueOnce(true).mockReturnValueOnce(false);
    try {
      const page = await pageHandler()(evt, { sessionId: 'native-1', beforeCursor: null });
      expect(page.reconcileInterrupted).toBe(false);
      expect(idle).toHaveBeenCalledTimes(2);
    } finally {
      history.mockRestore();
      live.mockRestore();
      idle.mockRestore();
    }
  });

  it('snapshots the transcript size before a Claude Code resume can append', () => {
    writeTranscript(2);
    const boundary = snapshotResumeBoundary('/home/destin/project', CC_ID);
    expect(boundary?.offset).toBeGreaterThan(0);
    writeTranscript(3);
    expect(boundary?.offset).toBeLessThan(fs.statSync(boundary!.jsonlPath).size);
    expect(snapshotResumeBoundary('/home/destin/project', '../bad')).toBeNull();
  });

  it('bounds a just-resumed Claude Code fallback page before new transcript writes', async () => {
    writeTranscript(2);
    const file = path.join(tmpHome, '.claude', 'projects', SLUG, `${CC_ID}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ type: 'assistant', uuid: 'old-tool-line',
      timestamp: new Date(1_700_000_000_003).toISOString(),
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'old-tool', name: 'Bash', input: {} }] },
    }) + '\n');
    const manager: any = {
      createSession: vi.fn(() => ({ id: 'desktop-1', provider: 'claude', cwd: '/home/destin/project', status: 'active' })),
      destroySession: vi.fn(), listSessions: vi.fn(() => []), getSession: vi.fn(),
      sendInput: vi.fn(), resizeSession: vi.fn(), on: vi.fn(),
    };
    const registry = new WindowRegistry();
    const handler = pageHandler(registry, manager);
    const create = [...(mockIpcMain.handle as any).mock.calls].reverse().find((c: any) => c[0] === 'session:create')[1];
    await create(evt, { provider: 'claude', cwd: '/home/destin/project', resumeSessionId: CC_ID, name: 'Resuming' });
    const oldEnd = fs.statSync(file).size;
    fs.appendFileSync(file, turnLines(2)); // a live turn appended after the resume began
    const page = await handler(evt, {
      sessionId: 'desktop-1', beforeCursor: null, claudeSessionId: CC_ID, projectSlug: SLUG,
    });
    expect(page.reconcileInterruptedToolIds).toEqual(['old-tool']);
    expect(page.events.some((e: any) => e.data?.text === 'prompt 2')).toBe(true);
    registry.markInheritedByTransfer('desktop-1', 1);
    const redocked = await handler(evt, { sessionId: 'desktop-1', beforeCursor: null });
    expect(redocked.reconcileInterruptedToolIds).toEqual(['old-tool']);
    expect(redocked.events.some((e: any) => e.data?.text === 'prompt 2')).toBe(true);
    // An older page wholly before the restart is historical even after the
    // newest page has been redocked and a new turn has started.
    const older = await handler(evt, { sessionId: 'desktop-1',
      beforeCursor: { path: file, offset: oldEnd, sizeAtRead: fs.statSync(file).size } });
    expect(older.reconcileInterrupted).toBe(true);
  });

  // The phone's session:create runs the desktop's own create path (setSessionCreate), so a
  // Claude Code resume started from a phone takes the same pre-spawn snapshot.
  it('a Claude Code resume started from a phone is bounded the same way', async () => {
    writeTranscript(2);
    const file = path.join(tmpHome, '.claude', 'projects', SLUG, `${CC_ID}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ type: 'assistant', uuid: 'old-tool-line',
      timestamp: new Date(1_700_000_000_003).toISOString(),
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'old-tool', name: 'Bash', input: {} }] },
    }) + '\n');
    const manager: any = {
      createSession: vi.fn(() => ({ id: 'desktop-2', provider: 'claude', cwd: '/home/destin/project', status: 'active' })),
      destroySession: vi.fn(), listSessions: vi.fn(() => []), getSession: vi.fn(),
      sendInput: vi.fn(), resizeSession: vi.fn(), on: vi.fn(),
    };
    let createFromPhone: ((opts: any) => Promise<any>) | null = null;
    const remote = {
      broadcast: vi.fn(), setNativeRuntime: vi.fn(), setSessionMetaWiring: vi.fn(), setSessionNamingWiring: vi.fn(),
      setLastTopic: vi.fn(), getClientCount: vi.fn(() => 0), broadcastStatusData: vi.fn(), onStatusChange: vi.fn(() => () => {}),
      setSessionCreate: vi.fn((fn: any) => { createFromPhone = fn; }),
    };
    const handler = pageHandler(new WindowRegistry(), manager, remote);
    await createFromPhone!({ provider: 'claude', cwd: '/home/destin/project', resumeSessionId: CC_ID, name: 'Resuming' });
    fs.appendFileSync(file, turnLines(2)); // a live turn appended after the resume began
    const page = await handler(evt, {
      sessionId: 'desktop-2', beforeCursor: null, claudeSessionId: CC_ID, projectSlug: SLUG,
    });
    expect(page.reconcileInterruptedToolIds).toEqual(['old-tool']);
  });

  it('a scroll-up request resolves the file the first page already located', async () => {
    writeTranscript(40);
    const handler = pageHandler();

    const first = await handler(evt, {
      sessionId: 'desktop-1', beforeCursor: null, claudeSessionId: CC_ID, projectSlug: SLUG,
    });
    expect(first.hasMore).toBe(true);
    expect(first.cursor).not.toBeNull();
    // Locator fallback reads to EOF, so it cannot distinguish pre-crash work
    // from a newly running tool; do not claim that it has been interrupted.
    expect(first.reconcileInterruptedToolIds).toBeUndefined();

    // The sentinel's request. ChatView has no locator to send — only the cursor.
    const older = await handler(evt, { sessionId: 'desktop-1', beforeCursor: first.cursor });
    expect(older.events.length).toBeGreaterThan(0);
  });

  it('does not mistake a late watcher cutoff for the pre-resume boundary', async () => {
    writeTranscript(3);
    const file = path.join(tmpHome, '.claude', 'projects', SLUG, `${CC_ID}.jsonl`);
    const spy = vi.spyOn(TranscriptWatcher.prototype, 'pageSourceFor').mockReturnValue({
      jsonlPath: file, subagentsDir: path.join(path.dirname(file), CC_ID, 'subagents'),
      startOffset: fs.statSync(file).size, cwd: tmpHome,
    });
    try {
      const handler = pageHandler();
      const first = await handler(evt, { sessionId: 'desktop-1', beforeCursor: null });
      expect(first.reconcileInterruptedToolIds).toBeUndefined();

      const registry = new WindowRegistry();
      const inheritedHandler = pageHandler(registry);
      registry.markInheritedByTransfer('desktop-1', 1);
      const consume = vi.spyOn(registry, 'consumeInheritedByTransfer');
      const inherited = await inheritedHandler(evt, { sessionId: 'desktop-1', beforeCursor: null });
      expect(consume).toHaveBeenCalledWith('desktop-1', 1);
      expect(inherited.reconcileInterruptedToolIds).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
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
