// Design: docs/active/specs/2026-09-24-welcome-back-design.md §4, §6.
// A deterministic id generator (same DI shape as welcome-back-store.test.ts's
// fake fs) lets these assert on exact ordering — including that a reused
// request never sends a second push.
import { describe, it, expect, beforeEach } from 'vitest';
import { createCloseRequestManager, applyCloseAnswer, type CloseRequestManager, type CloseRequestPush } from '../src/main/close-request-manager';

function createIdSequence() {
  let n = 0;
  return () => `req-${++n}`;
}

describe('createCloseRequestManager', () => {
  let genId: () => string;
  let manager: CloseRequestManager;

  beforeEach(() => {
    genId = createIdSequence();
    manager = createCloseRequestManager({ genId });
  });

  it('sends one push and resolves {close:false} on Cancel', async () => {
    const pushes: CloseRequestPush[] = [];
    const promise = manager.request(1, 2, (p) => pushes.push(p));
    expect(pushes).toEqual([{ requestId: 'req-1', sessions: 2 }]);
    manager.answer('req-1', { close: false });
    await expect(promise).resolves.toEqual({ close: false });
  });

  it('resolves {close:true, reopen:false} when the switch was left off', async () => {
    const promise = manager.request(1, 1, () => {});
    manager.answer('req-1', { close: true, reopen: false });
    await expect(promise).resolves.toEqual({ close: true, reopen: false });
  });

  it('resolves {close:true, reopen:true} when "Resume on Next Launch?" was on', async () => {
    const promise = manager.request(1, 1, () => {});
    manager.answer('req-1', { close: true, reopen: true });
    await expect(promise).resolves.toEqual({ close: true, reopen: true });
  });

  // No timeout (Destin, 2026-09-24: "just remove the timer"): a request
  // nobody has answered stays pending — the window waits for the person.
  it('an unanswered request stays pending — nothing closes the window on its own', async () => {
    let settled = false;
    void manager.request(1, 3, () => {}).then(() => { settled = true; });
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
  });

  it('a second close press for the same window reuses the pending request — no second push', async () => {
    const pushes: CloseRequestPush[] = [];
    const first = manager.request(1, 2, (p) => pushes.push(p));
    const second = manager.request(1, 2, (p) => pushes.push(p));
    expect(pushes).toHaveLength(1); // the second call sent nothing
    manager.answer('req-1', { close: true, reopen: false });
    await expect(first).resolves.toEqual({ close: true, reopen: false });
    await expect(second).resolves.toEqual({ close: true, reopen: false });
  });

  it('settleAll resolves every pending request as keep-tracked and reports each for the cancelled push', async () => {
    const w1 = manager.request(1, 2, () => {});
    const w2 = manager.request(2, 1, () => {});
    const cancelled: Array<[number, string]> = [];
    manager.settleAll((windowId, requestId) => cancelled.push([windowId, requestId]));
    await expect(w1).resolves.toEqual({ close: true, reopen: true });
    await expect(w2).resolves.toEqual({ close: true, reopen: true });
    expect(cancelled.sort()).toEqual([[1, 'req-1'], [2, 'req-2']].sort());
  });

  it('a late answer after settleAll (SIGTERM/before-quit route) is ignored', async () => {
    const promise = manager.request(1, 1, () => {});
    manager.settleAll(() => {});
    await expect(promise).resolves.toEqual({ close: true, reopen: true });
    expect(() => manager.answer('req-1', { close: false })).not.toThrow();
  });

  it('a fresh request for a window whose previous one already settled gets a NEW requestId', async () => {
    const pushes: CloseRequestPush[] = [];
    const first = manager.request(1, 1, (p) => pushes.push(p));
    manager.answer('req-1', { close: false });
    await first;
    manager.request(1, 1, (p) => pushes.push(p));
    expect(pushes.map((p) => p.requestId)).toEqual(['req-1', 'req-2']);
  });
});

// applyCloseAnswer: main.ts review finding, T3. The in-app prompt does not
// block the strip the way the old modal dialog.showMessageBox did, so a
// session can leave a window (dragged elsewhere, or closed with its own X)
// while that window's prompt is still awaiting an answer. The caller MUST
// re-read ownership after the answer lands and pass that live list here —
// these tests pin what the function does with whatever list it is given,
// including the case where everything has already left.
describe('applyCloseAnswer', () => {
  function fakeEffects() {
    const untracked: string[] = [];
    const destroyed: string[] = [];
    const released: string[] = [];
    return {
      untracked, destroyed, released,
      effects: {
        untrack: (id: string) => untracked.push(id),
        destroySession: (id: string) => destroyed.push(id),
        releaseSession: (id: string) => released.push(id),
      },
    };
  }

  it('Cancel (close:false) touches nothing and says do not close', () => {
    const { effects, untracked, destroyed, released } = fakeEffects();
    const shouldClose = applyCloseAnswer({ close: false }, ['s1', 's2'], effects);
    expect(shouldClose).toBe(false);
    expect(untracked).toEqual([]);
    expect(destroyed).toEqual([]);
    expect(released).toEqual([]);
  });

  it('close:true, reopen:false untracks, destroys and releases every currently-owned id', () => {
    const { effects, untracked, destroyed, released } = fakeEffects();
    const shouldClose = applyCloseAnswer({ close: true, reopen: false }, ['s1', 's2'], effects);
    expect(shouldClose).toBe(true);
    expect(untracked).toEqual(['s1', 's2']);
    expect(destroyed).toEqual(['s1', 's2']);
    expect(released).toEqual(['s1', 's2']);
  });

  it('close:true, reopen:true destroys and releases but never untracks', () => {
    const { effects, untracked, destroyed, released } = fakeEffects();
    const shouldClose = applyCloseAnswer({ close: true, reopen: true }, ['s1'], effects);
    expect(shouldClose).toBe(true);
    expect(untracked).toEqual([]);
    expect(destroyed).toEqual(['s1']);
    expect(released).toEqual(['s1']);
  });

  it('a session that left the window during the prompt is never destroyed or untracked', () => {
    // The window was asked about 's1' and 's2'; by the time the answer lands,
    // 's1' has been dragged into another window (main.ts re-reads
    // windowRegistry.sessionsForWindow(wid) AFTER the await and passes THAT
    // list here — this test is what the re-read must produce for the fix to
    // hold). Only 's2' may be touched.
    const { effects, untracked, destroyed, released } = fakeEffects();
    const stillOwned = ['s2']; // 's1' already left — NOT in this list
    const shouldClose = applyCloseAnswer({ close: true, reopen: false }, stillOwned, effects);
    expect(shouldClose).toBe(true);
    expect(untracked).toEqual(['s2']);
    expect(destroyed).toEqual(['s2']);
    expect(released).toEqual(['s2']);
    // The strongest form of the assertion: 's1' appears nowhere.
    expect(untracked).not.toContain('s1');
    expect(destroyed).not.toContain('s1');
    expect(released).not.toContain('s1');
  });

  it('every session having left during the prompt still closes the window, destroying nothing', () => {
    const { effects, untracked, destroyed, released } = fakeEffects();
    const shouldClose = applyCloseAnswer({ close: true, reopen: false }, [], effects);
    expect(shouldClose).toBe(true);
    expect(untracked).toEqual([]);
    expect(destroyed).toEqual([]);
    expect(released).toEqual([]);
  });
});
