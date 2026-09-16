import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// INVARIANTS UNDER TEST — the two halves of "drag a session into a new window
// and the conversation comes back complete" (Destin, 2026-09-03):
//
//   1. An ownership handoff aimed at a window that has not mounted yet is
//      HELD and delivered when that window pulls. Electron drops a
//      `webContents.send` with no listener; it does not queue it. Before this,
//      every tear-off into a fresh window silently skipped its whole handoff.
//
//   2. A window that INHERITED a session gets its first page of history read to
//      EOF, not to the transcript watcher's startOffset. The stop-at-startOffset
//      rule assumes the requester already received the rest over the live
//      stream — true of a window that was listening, false of one that just
//      inherited the session. It showed a conversation frozen at the moment the
//      session was resumed, missing every message since.
// ---------------------------------------------------------------------------

import { PendingAcquireQueue } from '../src/main/pending-acquire';
import { WindowRegistry } from '../src/main/window-registry';

describe('PendingAcquireQueue — a handoff survives a renderer that is not listening yet', () => {
  it('holds a payload for an unready window and hands it over on claim', () => {
    const q = new PendingAcquireQueue<{ sessionId: string }>();
    expect(q.isReady(7)).toBe(false);
    q.enqueue(7, { sessionId: 's1' });
    expect(q.claim(7)).toEqual([{ sessionId: 's1' }]);
  });

  it('reports ready after a claim, so later transfers push instead of queueing', () => {
    const q = new PendingAcquireQueue<{ sessionId: string }>();
    q.claim(7);
    expect(q.isReady(7)).toBe(true);
  });

  it('preserves order across several transfers into one booting window', () => {
    const q = new PendingAcquireQueue<{ sessionId: string }>();
    q.enqueue(7, { sessionId: 'a' });
    q.enqueue(7, { sessionId: 'b' });
    expect(q.claim(7).map((p) => p.sessionId)).toEqual(['a', 'b']);
  });

  it('does not replay on a second claim — a remount must not re-apply a handoff', () => {
    const q = new PendingAcquireQueue<{ sessionId: string }>();
    q.enqueue(7, { sessionId: 'a' });
    q.claim(7);
    expect(q.claim(7)).toEqual([]);
  });

  it('keeps windows separate', () => {
    const q = new PendingAcquireQueue<{ sessionId: string }>();
    q.enqueue(7, { sessionId: 'a' });
    q.enqueue(8, { sessionId: 'b' });
    expect(q.claim(8).map((p) => p.sessionId)).toEqual(['b']);
    expect(q.claim(7).map((p) => p.sessionId)).toEqual(['a']);
  });

  it('forget() drops a closed window\'s queue and its ready flag', () => {
    const q = new PendingAcquireQueue<{ sessionId: string }>();
    q.enqueue(7, { sessionId: 'a' });
    q.claim(7);
    q.forget(7);
    expect(q.isReady(7)).toBe(false);
    expect(q.claim(7)).toEqual([]);
  });
});

describe('WindowRegistry — the inherited-session mark', () => {
  it('is consumed exactly once, by the inheriting window', () => {
    const r = new WindowRegistry();
    r.markInheritedByTransfer('s1', 42);
    expect(r.consumeInheritedByTransfer('s1', 42)).toBe(true);
    expect(r.consumeInheritedByTransfer('s1', 42)).toBe(false);
  });

  it('does not fire for a different window', () => {
    const r = new WindowRegistry();
    r.markInheritedByTransfer('s1', 42);
    expect(r.consumeInheritedByTransfer('s1', 43)).toBe(false);
    // …and the real inheritor still gets it.
    expect(r.consumeInheritedByTransfer('s1', 42)).toBe(true);
  });

  it('is false for a session nobody inherited', () => {
    const r = new WindowRegistry();
    expect(r.consumeInheritedByTransfer('never-transferred', 42)).toBe(false);
  });

  it('is dropped when the inheriting window unregisters', () => {
    const r = new WindowRegistry();
    r.registerWindow(42, Date.now());
    r.markInheritedByTransfer('s1', 42);
    r.unregisterWindow(42);
    expect(r.consumeInheritedByTransfer('s1', 42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The end-to-end half: the real transcript:page handler, asked for the same
// session by an inheriting window and by an ordinary one.
// ---------------------------------------------------------------------------

vi.mock('electron', () => {
  const BrowserWindowMock: any = vi.fn(() => ({ loadURL: vi.fn(), on: vi.fn(), webContents: { send: vi.fn() } }));
  BrowserWindowMock.getAllWindows = vi.fn(() => []);
  return {
    app: {
      isPackaged: false,
      getPath: vi.fn(() => '/tmp'),
      getVersion: vi.fn(() => '0.0.0-test'),
      whenReady: vi.fn(() => new Promise(() => {})),
      on: vi.fn(),
      quit: vi.fn(),
      setAppUserModelId: vi.fn(),
      commandLine: { appendSwitch: vi.fn() },
      getGPUInfo: vi.fn(() => new Promise(() => {})),
    },
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    BrowserWindow: BrowserWindowMock,
    Menu: { setApplicationMenu: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    dialog: { showOpenDialog: vi.fn() },
    clipboard: { readImage: vi.fn(() => ({ isEmpty: () => true })) },
    nativeImage: {},
    shell: { openExternal: vi.fn() },
    powerSaveBlocker: { start: vi.fn(() => 0), stop: vi.fn() },
    screen: { getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })), getAllDisplays: vi.fn(() => []) },
    webContents: { fromId: vi.fn(() => null) },
  };
});

// The watcher is constructed inside registerIpcHandlers, so it is stubbed here
// rather than injected. `pageSourceFor` is the only surface this test needs; it
// hands back a real file plus the startOffset that reproduces the bug.
const watcherState = vi.hoisted(() => ({ jsonlPath: '', startOffset: 0 }));
// Partial mock: transcript-page.ts imports the REAL parseTranscriptLine from
// this same module, so replacing the whole module would break the page reader
// this test is here to exercise.
vi.mock('../src/main/transcript-watcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/transcript-watcher')>();
  class TranscriptWatcherStub {
    on() { return this; }

    off() { return this; }

    removeAllListeners() { return this; }

    pageSourceFor() {
      return {
        jsonlPath: watcherState.jsonlPath,
        subagentsDir: path.join(path.dirname(watcherState.jsonlPath), 'subagents'),
        startOffset: watcherState.startOffset,
      };
    }

    getHistory() { return []; }

    watchSession() { /* no-op */ }

    unwatchSession() { /* no-op */ }

    stopAll() { /* no-op */ }
  }
  return { ...actual, TranscriptWatcher: TranscriptWatcherStub };
});

// Native host must report "not a native session" so the CC/JSONL branch runs.
vi.mock('../src/main/harness/native-session-host', () => {
  class NativeSessionHostStub {
    getHistoryPage() { return null; }

    getHistory() { return null; }

    // The IPC handlers read through the async twins and the liveness check
    // (2026-09-16 C2); "not a native session" for all three.
    async getHistoryPageAsync() { return null; }

    async getHistoryAsync() { return null; }

    isLive() { return false; }

    setModelReleasedHandler() { /* no-op */ }

    on() { return this; }

    off() { return this; }

    removeAllListeners() { return this; }
  }
  return { NativeSessionHost: NativeSessionHostStub };
});

import { EventEmitter } from 'node:events';
import { registerIpcHandlers } from '../src/main/ipc-handlers';
import { IPC } from '../src/shared/types';

/** One CC-shaped turn: a user prompt line and an assistant reply line. */
function turnLines(i: number): string {
  const user = JSON.stringify({
    type: 'user', uuid: `u-${i}`, promptId: `p-${i}`, isMeta: false,
    timestamp: new Date(1_700_000_000_000 + i * 2).toISOString(),
    message: { role: 'user', content: `prompt ${i}` },
  });
  const asst = JSON.stringify({
    type: 'assistant', uuid: `a-${i}`,
    timestamp: new Date(1_700_000_000_001 + i * 2).toISOString(),
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `reply ${i}` }] },
  });
  return `${user}\n${asst}\n`;
}

let tmpDir = '';
afterEach(() => {
  if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } }
  tmpDir = '';
});

/**
 * Write a transcript whose first `resumedTurns` turns existed when the watcher
 * attached, and whose remaining turns arrived live afterwards. That split is
 * exactly a session Destin resumed this morning and has been talking to since.
 */
function buildResumedTranscript(resumedTurns: number, liveTurns: number) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tearoff-'));
  const jsonlPath = path.join(tmpDir, 'session.jsonl');
  let body = '';
  for (let i = 0; i < resumedTurns; i++) body += turnLines(i);
  fs.writeFileSync(jsonlPath, body);
  // The watcher attaches here — startOffset is the file's size at that moment.
  const startOffset = fs.statSync(jsonlPath).size;
  for (let i = resumedTurns; i < resumedTurns + liveTurns; i++) body += turnLines(i);
  fs.writeFileSync(jsonlPath, body);
  watcherState.jsonlPath = jsonlPath;
  watcherState.startOffset = startOffset;
}

function buildHandlers() {
  const mockIpcMain = { handle: vi.fn(), on: vi.fn() };
  const sessionManager: any = new EventEmitter();
  sessionManager.listSessions = vi.fn(() => []);
  sessionManager.getSession = vi.fn(() => undefined);
  const mainWindow: any = { isDestroyed: () => false, webContents: { send: vi.fn() } };
  const skillProvider: any = {
    configStore: { getPackages: vi.fn(() => ({})) },
    install: vi.fn(),
    installMany: vi.fn(),
    ensureBundledPluginsInstalled: vi.fn(),
    ensureMigrated: vi.fn(),
  };
  const registry = new WindowRegistry();
  registry.registerWindow(1, Date.now());
  registry.registerWindow(2, Date.now() + 1);

  registerIpcHandlers(
    mockIpcMain as any,
    sessionManager as any,
    mainWindow as any,
    skillProvider as any,
    undefined as any, // commandProvider
    undefined as any, // hookRelay
    undefined as any, // remoteConfig
    undefined as any, // remoteServer
    registry as any,
  );

  const pageHandler = (mockIpcMain.handle as any).mock.calls
    .find((c: any) => c[0] === IPC.TRANSCRIPT_PAGE)[1];
  return { pageHandler, registry };
}

const promptsIn = (page: any) => page.events
  .filter((e: any) => e.type === 'user-message')
  .map((e: any) => e.data.text);

describe('transcript:page — a window that INHERITED a session reads to the end', () => {
  it('reproduces the bug: an ordinary first page stops at the watcher startOffset', async () => {
    buildResumedTranscript(3, 4);
    const { pageHandler } = buildHandlers();
    const page = await pageHandler({ sender: { id: 2 } }, { sessionId: 's1', beforeCursor: null });
    // Only the pre-resume turns. Everything said since is absent — this is the
    // "the latest message shown is not actually the latest" report.
    expect(promptsIn(page)).toEqual(['prompt 0', 'prompt 1', 'prompt 2']);
  });

  it('an inheriting window gets the tail too, ending on the real newest message', async () => {
    buildResumedTranscript(3, 4);
    const { pageHandler, registry } = buildHandlers();
    registry.markInheritedByTransfer('s1', 2);
    const page = await pageHandler({ sender: { id: 2 } }, { sessionId: 's1', beforeCursor: null });
    const prompts = promptsIn(page);
    expect(prompts).toEqual([
      'prompt 0', 'prompt 1', 'prompt 2', 'prompt 3', 'prompt 4', 'prompt 5', 'prompt 6',
    ]);
    expect(prompts[prompts.length - 1]).toBe('prompt 6');
  });

  it('the mark belongs to the inheritor — another window still gets the short page', async () => {
    buildResumedTranscript(3, 4);
    const { pageHandler, registry } = buildHandlers();
    registry.markInheritedByTransfer('s1', 2);
    const page = await pageHandler({ sender: { id: 1 } }, { sessionId: 's1', beforeCursor: null });
    expect(promptsIn(page)).toEqual(['prompt 0', 'prompt 1', 'prompt 2']);
  });

  it('is one-shot: a later page read by the same window is ordinary again', async () => {
    buildResumedTranscript(3, 4);
    const { pageHandler, registry } = buildHandlers();
    registry.markInheritedByTransfer('s1', 2);
    await pageHandler({ sender: { id: 2 } }, { sessionId: 's1', beforeCursor: null });
    const second = await pageHandler({ sender: { id: 2 } }, { sessionId: 's1', beforeCursor: null });
    expect(promptsIn(second)).toEqual(['prompt 0', 'prompt 1', 'prompt 2']);
  });

  it('paging BACKWARD never consumes the mark — only a first page can', async () => {
    buildResumedTranscript(3, 4);
    const { pageHandler, registry } = buildHandlers();
    registry.markInheritedByTransfer('s1', 2);
    // A cursor-bearing request is a scroll-back, not a hydration.
    await pageHandler(
      { sender: { id: 2 } },
      { sessionId: 's1', beforeCursor: { path: watcherState.jsonlPath, offset: 10, sizeAtRead: 0 } },
    );
    const first = await pageHandler({ sender: { id: 2 } }, { sessionId: 's1', beforeCursor: null });
    expect(promptsIn(first)).toContain('prompt 6');
  });
});
