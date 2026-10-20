import { describe, it, expect, vi, afterEach } from 'vitest';
import { findChannel, serveRemoteChannel } from '../src/main/ipc/channel-table';
import { bindSessionOps } from '../src/main/ipc/session';
afterEach(() => bindSessionOps(null));
describe('provider-neutral queue actions', () => {
 it('rejects forged action fields before delegate dispatch and serves the same handler to phones', async () => {
  const action = vi.fn(async () => ({ status: 'done' })); bindSessionOps({ queueAction: action, sessionManager: { getSession: () => ({ provider: 'claude' }) } } as any);
  const def = findChannel('session:queue-action'); expect(def).toBeDefined();
  expect(await def!.handler({ sessionId: 's', action: { kind: 'identity', extra: true } }, {} as any)).toMatchObject({ status: 'rejected' }); expect(action).not.toHaveBeenCalled();
  expect(await def!.handler({ sessionId: 's', action: { kind: 'identity' } }, {} as any)).toEqual({ status: 'done' });
  const remote = await serveRemoteChannel(def!, { sessionId: 's', action: { kind: 'identity' } }, { remote: {}, isConnected: () => true } as any);
  expect(remote.reply && remote.payload).toEqual({ status: 'done' }); expect(action).toHaveBeenCalledTimes(2);
 });
 it('delegates native remove/send-now without changing its host implementation', async () => {
  const removeQueued = vi.fn(() => true), sendQueuedNow = vi.fn(() => true);
  bindSessionOps({ sessionManager: { getSession: () => ({ provider: 'native' }) }, nativeHost: { removeQueued, sendQueuedNow } } as any);
  const def = findChannel('session:queue-action')!;
  expect(await def.handler({ sessionId: 's', action: { kind: 'remove', itemId: 'item' } }, {} as any)).toMatchObject({ status: 'done' });
  expect(await def.handler({ sessionId: 's', action: { kind: 'send-now', itemId: 'item' } }, {} as any)).toMatchObject({ status: 'done' });
  expect(removeQueued).toHaveBeenCalledWith('s','item'); expect(sendQueuedNow).toHaveBeenCalledWith('s','item');
 });
});
