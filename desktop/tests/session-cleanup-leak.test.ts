// R-4: open and close 50 chats through the real SessionManager and the real per-chat owners; nothing may be left behind.
// WHY (L-3, Destin 2026-11-18): this test blocks merging (it runs in verify.sh like every other test). It counts items,
// never milliseconds, so a loaded machine cannot make it flaky.
import { describe, it, expect, vi } from 'vitest';
import os from 'os';
import { SessionManager } from '../src/main/session-manager';
import { SessionCleanup } from '../src/main/session-cleanup';
import { makeRig } from './helpers/screens-rig';
import { sizesOf, growth, activeResources } from './helpers/leak-probe';

const tmpDir = os.tmpdir();
const handlers: Record<string, (...a: any[]) => void> = {};
const mockWorker = {
  send: vi.fn(), on: vi.fn((...[event, cb]: any[]) => { handlers[event] = cb; }), off: vi.fn(),
  disconnect: vi.fn(), kill: vi.fn(), stderr: { on: vi.fn() },
};
vi.mock('child_process', () => ({ fork: vi.fn(() => mockWorker), spawn: vi.fn(() => mockWorker) }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: vi.fn(() => tmpDir) } }));

const CHATS = 50;

describe('cleanup registry unit behaviour', () => {
  it('runs every sign-up in order, survives a throwing one, and is idempotent', () => {
    const c = new SessionCleanup(); const ran: string[] = [];
    c.register('a', () => { ran.push('1'); });
    c.register('a', () => { throw new Error('boom'); });
    c.register('a', async () => { ran.push('3'); throw new Error('async boom'); });
    c.register('a', () => { ran.push('4'); });
    c.closeSession('a'); c.closeSession('a');
    expect(ran).toEqual(['1', '3', '4']);
    expect(c.openCount).toBe(0);
  });
  it('un-register removes one; a close then reopen of the same id keeps the new life safe', () => {
    const c = new SessionCleanup(); const ran: string[] = [];
    const off = c.register('a', () => { ran.push('old-off'); }); off();
    c.register('a', () => { ran.push('first-life'); });
    c.closeSession('a');
    c.register('a', () => { ran.push('second-life'); });      // the chat reopened under the same id
    expect(ran).toEqual(['first-life']);                  // the earlier close did not touch the new life
    c.closeSession('a');
    expect(ran).toEqual(['first-life', 'second-life']);
  });
  it('a cleanup that registers again during close lands in the next life, not this close', () => {
    const c = new SessionCleanup(); const ran: string[] = [];
    c.register('a', () => { c.register('a', () => { ran.push('next'); }); });
    c.closeSession('a');
    expect(ran).toEqual([]); expect(c.openCount).toBe(1);
    c.closeSession('a'); expect(ran).toEqual(['next']);
  });
});

describe(`open and close ${CHATS} chats`, () => {
  it('leaves the session manager, record, live-facts and screens owners at their starting size', async () => {
    const manager = new SessionManager();
    const rig = makeRig();
    const baseSizes = () => ({
      ...sizesOf('manager', manager), ...sizesOf('records', rig.records), ...sizesOf('screens', rig.screens), ...sizesOf('live', rig.live),
    });
    const before = baseSizes();
    const resourcesBefore = activeResources();
    const listenersBefore = manager.eventNames().map((e) => [String(e), manager.listenerCount(e)]);
    let registryRuns = 0;

    for (let i = 0; i < CHATS; i++) {
      const info = manager.createSession({ cwd: tmpDir, name: `chat ${i}`, skipPermissions: false });
      const id = info.id;
      const onError = handlers.error;
      manager.onSessionClose(id, () => { registryRuns++; });
      // what the app's main side does per chat: a record, terminal output, then the exit wiring of ipc-handlers.ts
      rig.records.begin(id);
      rig.records.note(id, 'hook:event', { type: 'SessionStart', sessionId: id, payload: {} });
      // a running turn is what makes the computer keep its own copy of the terminal for the chat
      rig.records.note(id, 'transcript:event', { type: 'user-message', sessionId: id, uuid: `u${i}`, timestamp: 1, data: { text: 'go' } });
      rig.screens.noteOutput(id, 'hello\r\n');
      expect(rig.screens['per'].has(id)).toBe(true); // the owner really holds something for this chat
      manager.once('session-exit', (sid: string) => { rig.records.drop(sid); rig.live.forget(sid); rig.screens.forget(sid); });
      // alternate the exit routes: a deliberate close and a worker that failed to start
      if (i % 2 === 0) manager.destroySession(id); else onError(new Error('spawn failed'));
    }
    await rig.settle();

    expect(registryRuns).toBe(CHATS);
    expect(manager.cleanup.openCount).toBe(0);
    // tombstones are a bounded, deliberate memory (TOMBSTONES_MAX) — everything else must be back at baseline
    const after = baseSizes();
    const grew = growth(before, after);
    delete grew['records.gone'];
    expect(grew).toEqual({});
    // no event listener piled up on the manager, and no new timers or handles are left running
    expect(manager.eventNames().map((e) => [String(e), manager.listenerCount(e)])).toEqual(listenersBefore);
    const res = activeResources();
    for (const [k, n] of Object.entries(res)) expect(n, `leftover ${k}`).toBeLessThanOrEqual((resourcesBefore[k] ?? 0));
    manager.destroyAll();
  });

  it('a chat that ends twice (two exit routes racing) runs its sign-ups once', () => {
    const manager = new SessionManager();
    const info = manager.createSession({ cwd: tmpDir, name: 'twice', skipPermissions: false });
    let runs = 0; manager.onSessionClose(info.id, () => { runs++; });
    handlers.error(new Error('crash'));
    manager.destroySession(info.id);   // the entry is already gone: no second exit
    expect(runs).toBe(1);
    manager.destroyAll();
  });
});
