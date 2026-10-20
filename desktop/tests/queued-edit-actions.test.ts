import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ClaudeQueue } from '../src/main/claude-queue';
import { ClaudeQueueStore } from '../src/main/claude-queue-store';
import { createQueuedEditActions, type QueueDraftSnapshot, type QueuedEditApi } from '../src/renderer/state/queued-edit-actions';

function fixture() {
  let draft: QueueDraftSnapshot = { sessionId: 's', revision: 0, empty: true };
  const item = { queueItemId: 'item', originalText: 'original words', attachments: ['/tmp/picture.png'] };
  const checkout = vi.fn<QueuedEditApi['checkout']>(async () => ({ status: 'reserved' as const, item }));
  const ack = vi.fn(async () => {}); const cancel = vi.fn(async () => {});
  const fillIfCurrent = vi.fn((before: QueueDraftSnapshot, _text: string, _files: string[]) => {
    if (before.sessionId !== draft.sessionId || before.revision !== draft.revision || !draft.empty) return false;
    draft = { ...draft, revision: draft.revision + 1, empty: false }; return true;
  });
  const actions = createQueuedEditActions({ api: { checkout, ack, cancel }, composer: { snapshot: () => ({ ...draft }), fillIfCurrent }, makeId: () => 'edit-token' });
  return { actions, checkout, ack, cancel, fillIfCurrent, item, setDraft: (d: QueueDraftSnapshot) => { draft = d; } };
}

describe('queued edit transfer', () => {
  it('recovers the same acknowledgement token after coordinator reload without refilling or upgrading its epoch',async()=>{
    let saved:string|null=null;const storage={load:()=>saved,save:(value:string)=>{saved=value;}};const f=fixture();f.ack.mockRejectedValueOnce(Error('lost ack'));
    const make=()=>createQueuedEditActions({api:{checkout:f.checkout,ack:f.ack,cancel:f.cancel},composer:{snapshot:()=>({sessionId:'s',revision:0,empty:true}),fillIfCurrent:f.fillIfCurrent},storage});
    expect(await make().edit('s','item','old-epoch')).toBe('unknown');const token=f.ack.mock.calls[0];
    expect(saved).toContain('old-epoch');expect(saved).toContain('"ack"');
    expect(await make().edit('s','item','new-epoch')).toBe('edited');expect(f.ack.mock.calls[1]).toEqual(token);expect(f.fillIfCurrent).toHaveBeenCalledTimes(1);expect(f.checkout).toHaveBeenCalledTimes(1);
  });
  it('refuses checkout when the recovery token cannot be persisted',async()=>{
    const f=fixture();const actions=createQueuedEditActions({api:{checkout:f.checkout,ack:f.ack,cancel:f.cancel},composer:{snapshot:()=>({sessionId:'s',revision:0,empty:true}),fillIfCurrent:f.fillIfCurrent},storage:{load:()=>null,save:()=>{throw Error('quota');}}});
    expect(await actions.edit('s','item')).toBe('unknown');expect(await actions.edit('s','item')).toBe('unknown');expect(f.checkout).not.toHaveBeenCalled();expect(f.ack).not.toHaveBeenCalled();
  });
  it('refills exact text and attachments before acknowledging the host checkout', async () => {
    const f = fixture(); expect(await f.actions.edit('s', 'item')).toBe('edited');
    expect(f.fillIfCurrent).toHaveBeenCalledWith({ sessionId: 's', revision: 0, empty: true }, 'original words', ['/tmp/picture.png']);
    expect(f.fillIfCurrent.mock.invocationCallOrder[0]).toBeLessThan(f.ack.mock.invocationCallOrder[0]);
    expect(f.cancel).not.toHaveBeenCalled();
  });
  it('leaves the host untouched when another draft already exists', async () => {
    const f = fixture(); f.setDraft({ sessionId: 's', revision: 1, empty: false });
    expect(await f.actions.edit('s', 'item')).toBe('draft-busy'); expect(f.checkout).not.toHaveBeenCalled();
  });
  it('does not edit a background session into the active composer', async () => {
    const f = fixture(); expect(await f.actions.edit('other', 'item')).toBe('session-changed'); expect(f.checkout).not.toHaveBeenCalled();
  });
  it.each(['new-draft', 'session-switch'])('preserves %s that happens while checkout is in flight', async (kind) => {
    const f = fixture(); let finish!: (value: { status: 'reserved'; item: typeof f.item }) => void;
    f.checkout.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.actions.edit('s', 'item');
    f.setDraft({ sessionId: kind === 'session-switch' ? 'other' : 's', revision: 1, empty: false });
    finish({ status: 'reserved', item: f.item });
    expect(await pending).toBe('draft-changed'); expect(f.ack).not.toHaveBeenCalled(); expect(f.cancel).toHaveBeenCalledTimes(1);
  });
  it('captures a new edit epoch and never upgrades it after a lost reply', async () => {
    const f = fixture(); f.checkout.mockRejectedValueOnce(Error('lost reply'));
    expect(await f.actions.edit('s', 'item', 'epoch-old')).toBe('unknown');
    expect(await f.actions.edit('s', 'item', 'epoch-new')).toBe('edited');
    expect(f.checkout.mock.calls[0][2].sendEpoch).toBe('epoch-old');
    expect(f.checkout.mock.calls[1][2].sendEpoch).toBe('epoch-old');
  });
  it('reuses its checkout token after a lost checkout reply rather than creating a competing edit', async () => {
    const f = fixture(); f.checkout.mockRejectedValueOnce(Error('lost reply'));
    expect(await f.actions.edit('s', 'item')).toBe('unknown'); expect(f.fillIfCurrent).not.toHaveBeenCalled();
    expect(await f.actions.edit('s', 'item')).toBe('edited');
    expect(f.checkout.mock.calls[0]).toEqual(f.checkout.mock.calls[1]);
  });
  it('retries only the acknowledgement after a lost ack, never overwriting the newer draft', async () => {
    const f = fixture(); f.ack.mockRejectedValueOnce(Error('lost ack'));
    expect(await f.actions.edit('s', 'item')).toBe('unknown');
    f.setDraft({ sessionId: 's', revision: 2, empty: false });
    expect(await f.actions.edit('s', 'item')).toBe('edited');
    expect(f.fillIfCurrent).toHaveBeenCalledTimes(1); expect(f.checkout).toHaveBeenCalledTimes(1); expect(f.ack).toHaveBeenCalledTimes(2);
  });
  it('does not refill a host response for another queue item', async () => {
    const f = fixture(); f.checkout.mockResolvedValueOnce({ status: 'reserved', item: { ...f.item, queueItemId: 'other' } });
    expect(await f.actions.edit('s', 'item')).toBe('unknown'); expect(f.fillIfCurrent).not.toHaveBeenCalled(); expect(f.ack).not.toHaveBeenCalled();
  });
  it('does not refill an item whose delivery already won the checkout race', async () => {
    const f = fixture(); f.checkout.mockResolvedValueOnce({ status: 'unavailable' });
    expect(await f.actions.edit('s', 'item')).toBe('too-late');
    expect(f.fillIfCurrent).not.toHaveBeenCalled(); expect(f.ack).not.toHaveBeenCalled();
  });
  it('does not attempt a second refill when the composer reports an indeterminate exception', async () => {
    const f = fixture(); f.fillIfCurrent.mockImplementationOnce(() => { throw Error('view failed'); });
    expect(await f.actions.edit('s', 'item')).toBe('unknown');
    expect(await f.actions.edit('s', 'item')).toBe('unknown');
    expect(f.fillIfCurrent).toHaveBeenCalledTimes(1); expect(f.ack).not.toHaveBeenCalled(); expect(f.cancel).not.toHaveBeenCalled();
  });
  it('coalesces simultaneous clicks for one edit', async () => {
    const f = fixture(); let finish!: (value: { status: 'reserved'; item: typeof f.item }) => void;
    f.checkout.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const a = f.actions.edit('s', 'item'), b = f.actions.edit('s', 'item'); expect(a).toBe(b);
    finish({ status: 'reserved', item: f.item }); await a;
    expect(f.checkout).toHaveBeenCalledTimes(1); expect(f.fillIfCurrent).toHaveBeenCalledTimes(1);
  });
  it('settles a lost cancellation reply against the real host after cancellation already committed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'queue-edit-host-'));
    try {
      const host = new ClaudeQueue({ storage: new ClaudeQueueStore(dir) }); await host.restore();
      const root = await host.bind({ provider: 'claude', conversationId: 'conversation' }, 'incarnation');
      const queued = await host.enqueue(root, { sendEpoch: host.snapshot(root).sendEpoch, sendId: 'send-edit-host', originalText: 'Keep these words', attachments: [], displayContent: 'Keep these words' });
      let loseReply = true;
      const actions = createQueuedEditActions({
        api: {
          checkout: async (_sid, id, token) => ({ status: 'reserved', item: await host.checkout(root, id, token) }),
          ack: async (_sid, token) => host.ackCheckout(root, token),
          cancel: async (_sid, token) => { await host.cancelCheckout(root, token); if (loseReply) { loseReply = false; throw Error('Reply lost after durable cancellation'); } },
        },
        composer: { snapshot: () => ({ sessionId: 's', revision: 0, empty: true }), fillIfCurrent: () => false },
      });
      expect(await actions.edit('s', queued.item.queueItemId)).toBe('unknown');
      expect(host.snapshot(root).items[0].checkout).toBeUndefined();
      expect(await actions.edit('s', queued.item.queueItemId)).toBe('draft-changed');
      expect(host.snapshot(root).items[0].originalText).toBe('Keep these words');
    } finally { await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }); }
  });
  it('retains and retries a cancellation token if the draft changed and cancellation reply was lost', async () => {
    const f = fixture(); f.fillIfCurrent.mockReturnValueOnce(false); f.cancel.mockRejectedValueOnce(Error('lost cancel'));
    expect(await f.actions.edit('s', 'item')).toBe('unknown');
    expect(await f.actions.edit('s', 'item')).toBe('draft-changed');
    expect(f.cancel).toHaveBeenCalledTimes(2); expect(f.checkout).toHaveBeenCalledTimes(1); expect(f.fillIfCurrent).toHaveBeenCalledTimes(1);
  });
});
