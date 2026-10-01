// The `session:open` table entry (main/ipc/session.ts): who is asking, what is held for them while they are filled, and when it is let go.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { findChannel } from '../src/main/ipc/channel-table';
import { bindSessionOps } from '../src/main/ipc/session';
import { SessionRecords } from '../src/main/session-record';
import { AudienceFills } from '../src/main/audience-fill';
import { WindowRegistry } from '../src/main/window-registry';

const S = 's1';
afterEach(() => bindSessionOps(null));

function world(opts: { known?: boolean; page?: () => Promise<any> } = {}) {
  const records = new SessionRecords();
  records.begin(S);
  const fills = new AudienceFills();
  const registry = new WindowRegistry();
  registry.registerWindow(4, 1);
  registry.registerSocket(-1000);
  const nativeHost = { isLive: () => false };
  bindSessionOps({
    sessionManager: { getSession: (id: string) => ((opts.known ?? true) && id === S ? { id } : undefined) },
    nativeHost, windowRegistry: registry,
    transcriptPage: vi.fn(opts.page ?? (async () => ({ events: [], cursor: null, hasMore: false }))),
  } as any);
  const runtime: any = { records, fills, nativeHost };
  const after: Array<() => void> = [];
  const def = findChannel('session:open')!;
  return { records, fills, registry, runtime, after, def, afterReply: (fn: () => void) => { after.push(fn); } };
}

describe('session:open for a phone', () => {
  it('subscribes the phone to the session, holds its pushes until the answer is sent, then lets them through', async () => {
    const w = world();
    const ctx: any = { door: 'remote', runtime: w.runtime, audienceId: -1000, broadcast: () => {}, afterReply: w.afterReply };
    const reply: any = await w.def.handler({ sessionId: S }, ctx);
    expect(reply.ok).toBe(true);
    expect(w.registry.getSocketWatchers(S)).toEqual([-1000]);
    expect(w.fills.filling('s-1000', S)).toBe(true);        // still held: the door has not sent the answer yet
    const got: number[] = [];
    w.fills.hold('s-1000', S, () => got.push(1));
    w.after[0]();                                           // the door sent the answer
    expect(w.fills.filling('s-1000', S)).toBe(false);
    expect(got).toEqual([1]);
  });

  it('a phone that asks about a session the computer does not run gets "gone" and is not subscribed', async () => {
    const w = world({ known: false });
    const ctx: any = { door: 'remote', runtime: w.runtime, audienceId: -1000, broadcast: () => {}, afterReply: w.afterReply };
    const reply: any = await w.def.handler({ sessionId: S }, ctx);
    expect(reply).toMatchObject({ ok: false, gone: true });
    w.after[0]?.();
    expect(w.fills.filling('s-1000', S)).toBe(false);
  });

  it('never replays a password ask to a phone (door says remote)', async () => {
    const w = world();
    w.runtime.nativeHost = { isLive: () => true, pendingAskEventsFor: () => [{ type: 'PasswordRequest', sessionId: S, payload: { _requestId: 'p' }, timestamp: 1 }], specialistRunsFor: () => [], shellRunsFor: () => [], currentUsageProgressFor: () => null, sessionContextFor: () => null, isIdle: () => false };
    const phone: any = await w.def.handler({ sessionId: S }, { door: 'remote', runtime: w.runtime, audienceId: -1000, broadcast: () => {}, afterReply: w.afterReply } as any);
    expect(phone.after.some((p: any) => p.payload?.type === 'PasswordRequest')).toBe(false);
  });
});

describe('session:open for a computer window', () => {
  it('holds under the window\'s own key and does not subscribe it (a window receives by ownership)', async () => {
    const w = world();
    const ctx: any = { door: 'desktop', runtime: w.runtime, windowId: 4, broadcast: () => {}, afterReply: w.afterReply };
    await w.def.handler({ sessionId: S }, ctx);
    expect(w.fills.filling('w4', S)).toBe(true);
    expect(w.registry.getSubscribers(S).size).toBe(0);
    w.after[0]();
    expect(w.fills.filling('w4', S)).toBe(false);
  });

  it('a failed page read lets the held pushes go at once and rethrows (a window is never left holding)', async () => {
    const w = world({ page: async () => { throw new Error('disk'); } });
    const ctx: any = { door: 'desktop', runtime: w.runtime, windowId: 4, broadcast: () => {}, afterReply: w.afterReply };
    await expect(w.def.handler({ sessionId: S }, ctx)).rejects.toThrow('disk');
    expect(w.fills.filling('w4', S)).toBe(false);
  });

  it('is served to both doors: a table entry that is not computer-only', () => {
    const def = findChannel('session:open')!;
    expect(def.desktopOnly).toBeFalsy();
    expect(def.remoteAllowed).not.toBe(false);
  });
});
