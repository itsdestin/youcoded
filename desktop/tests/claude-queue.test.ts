import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ClaudeQueue } from '../src/main/claude-queue';
import type { QueueJournal, QueueStorage } from '../src/shared/conversation-queue-types';

const alias = { provider: 'claude' as const, conversationId: 'conversation-one' };
const payload = (sendId = 'send-one') => ({ sendId, originalText: '  Read @notes.md\nexactly é ', attachments: ['/tmp/a.png', '/tmp/notes.md'], displayContent: 'Original display\nwith image' });
function memory() {
  const records = new Map<string, QueueJournal>();
  const store: QueueStorage = {
    load: async () => structuredClone([...records.values()]),
    retire: vi.fn(async (id, expected) => { if (records.get(id)?.revision !== expected) throw Error('revision conflict'); records.delete(id); }),
    save: vi.fn(async (record, expected) => {
      if ((records.get(record.queueId)?.revision ?? null) !== expected) throw Error('revision conflict');
      records.set(record.queueId, structuredClone(record));
    }),
  };
  return { store, records };
}
async function fixture(options: { maxItems?: number; maxTombstones?: number; ready?: () => boolean } = {}) {
  const m = memory(); const publish = vi.fn();
  const q = new ClaudeQueue({ storage: m.store, publish, ready: () => true, ...options });
  await q.restore(); const id = await q.bind(alias, 'live-one');
  return { ...m, q, id, publish };
}
// Existing tests model NEW deliberate requests; explicit epochs below always override this convenience.
const enqueue = (q: ClaudeQueue, id: string, p: Omit<import('../src/shared/conversation-queue-types').QueuePayload, 'sendEpoch'> & { sendEpoch?: string }) => q.enqueue(id, { sendEpoch: q.snapshot(id).sendEpoch, ...p });
const sequences = new WeakMap<ClaudeQueue, Map<string, number>>();
const claim = (q: ClaudeQueue, id: string, boundaryId = 'batch-one', incarnation = 'live-one') => {
  let map = sequences.get(q); if (!map) { map = new Map(); sequences.set(q, map); }
  const key = incarnation + ':' + boundaryId; if (!map.has(key)) map.set(key, map.size + 1);
  return q.claim(id, { boundaryId, boundarySeq: map.get(key)!, incarnation, alias, wireHash: 'a'.repeat(64) });
};

describe('host-owned Claude queue', () => {
  it('reserves enqueue validation and capacity before attachment capture and never copies duplicate requests',async()=>{
    const {q,id}=await fixture({maxItems:1});const prepare=vi.fn(async()=>['/private/retained.png']);const p={...payload(),sendEpoch:q.snapshot(id).sendEpoch};
    const first=await q.enqueue(id,p,prepare);expect(prepare).toHaveBeenCalledTimes(1);expect(q.snapshot(id).items[0].preparedAttachments).toEqual(['/private/retained.png']);
    expect((await q.enqueue(id,p,prepare)).duplicate).toBe(true);expect(prepare).toHaveBeenCalledTimes(1);
    await expect(q.enqueue(id,{...p,sendId:'full'},prepare)).rejects.toThrow(/full/);await expect(q.enqueue(id,{...p,sendId:'stale',sendEpoch:randomUUID()},prepare)).rejects.toThrow(/epoch/);expect(prepare).toHaveBeenCalledTimes(1);
    await q.remove(id,first.item.queueItemId);expect(await q.enqueue(id,{...p,sendId:'next'},prepare)).toMatchObject({duplicate:false});expect(prepare).toHaveBeenCalledTimes(2);
  });
  it('rejects a retained historical alias for live binding after Clear, including after restart', async () => {
    const { q, id, store } = await fixture(); await enqueue(q, id, payload()); const a = (await claim(q, id))!.attempt;
    await q.accept(id, a, 'accepted'); const clear = await q.freezeForClear(id, 'live-one'); await q.beginClear(id, clear.clearId);
    const next = { ...alias, conversationId: 'current-B' }; await q.rebindAfterClear(id, clear.clearId, next, 'live-two');
    await expect(q.bind(alias, 'live-two')).rejects.toThrow(/historical/);
    await q.close(id, 'live-two'); const fresh = new ClaudeQueue({ storage: store }); await fresh.restore();
    await expect(fresh.bind(alias, 'live-three')).rejects.toThrow(/historical/);
    expect(await fresh.bind(next, 'live-three')).toBe(id);
  });
  it('reuses registry capacity after more than 128 empty bind/close lifecycles without resurrecting old IDs', async () => {
    const { q, id, store } = await fixture(); await q.close(id, 'live-one');
    expect(() => q.snapshot(id)).toThrow(/Unknown/);
    await expect(q.enqueue(id, { ...payload(), sendEpoch: randomUUID() })).rejects.toThrow(/Unknown/);
    for (let n = 0; n < 140; n++) { const next = await q.bind({ ...alias, conversationId: 'unused-' + n }, 'live'); await q.close(next, 'live'); }
    expect(await store.load()).toEqual([]); expect(await q.bind(alias, 'replacement')).not.toBe(id);
  });
  it('rotates an explicit send epoch only after all actionable data resolves and rejects every stale-epoch replay', async () => {
    const { q, id } = await fixture({ maxTombstones: 2 }); const old = q.snapshot(id).sendEpoch;
    const first = await enqueue(q, id, payload()); await expect(q.rotateSendEpoch(id, old)).rejects.toThrow(/active/);
    await q.remove(id, first.item.queueItemId); const second = await enqueue(q, id, payload('two')); await q.remove(id, second.item.queueItemId);
    const next = await q.rotateSendEpoch(id, old); expect(next).not.toBe(old);
    await expect(enqueue(q, id, { ...payload(), sendEpoch: old } as any)).rejects.toThrow(/epoch/);
    await expect(q.rotateSendEpoch(id, old)).rejects.toThrow(/epoch/);
    expect((await enqueue(q, id, { ...payload(), sendEpoch: next } as any)).duplicate).toBe(false);
  });
  it('keeps epoch identities and closed data recoverable when rotation or retirement IO fails', async () => {
    const { q, id, store } = await fixture(); const epoch = q.snapshot(id).sendEpoch;
    const row = await enqueue(q, id, payload()); await q.remove(id, row.item.queueItemId);
    vi.mocked(store.save).mockRejectedValueOnce(Error('rotation IO'));
    await expect(q.rotateSendEpoch(id, epoch)).rejects.toThrow('rotation IO');
    expect(q.snapshot(id).sendEpoch).toBe(epoch); expect((await enqueue(q, id, payload())).duplicate).toBe(true);
    await q.rotateSendEpoch(id, epoch); vi.mocked(store.retire).mockRejectedValueOnce(Error('retire IO'));
    await expect(q.close(id, 'live-one')).rejects.toThrow('retire IO');
    expect(q.snapshot(id).live).toBeNull(); await q.retireClosed(id); expect(() => q.snapshot(id)).toThrow(/Unknown/);
  });
  it('continues past 1024 deliberate sends through bounded epochs without replaying an old epoch', async () => {
    const { q, id } = await fixture({ maxTombstones: 8 }); const originalEpoch = q.snapshot(id).sendEpoch;
    for (let n = 0; n < 1030; n++) {
      if (q.snapshot(id).tombstones.length === 8) await q.rotateSendEpoch(id, q.snapshot(id).sendEpoch);
      const row = await enqueue(q, id, payload('same-id-' + (n % 8))); await q.remove(id, row.item.queueItemId);
    }
    expect(q.snapshot(id).tombstones.length).toBeLessThanOrEqual(8);
    await expect(q.enqueue(id, { ...payload('same-id-0'), sendEpoch: originalEpoch })).rejects.toThrow(/epoch/);
  });
  it('compacts obsolete Clear aliases before execution and permits more than 32 legitimate Clears', async () => {
    const { q, id } = await fixture();
    for (let n = 0; n < 40; n++) { const c = await q.freezeForClear(id, n ? 'live-' + (n - 1) : 'live-one'); await q.beginClear(id, c.clearId); await q.rebindAfterClear(id, c.clearId, { ...alias, conversationId: 'clear-' + n }, 'live-' + n); }
    expect(q.snapshot(id).aliases).toHaveLength(1);
    await enqueue(q, id, payload()); await q.resume(id, 'live-39');
  });
  it('reserves alias capacity before Clear and recovers capacity after old accepted evidence is confirmed', async () => {
    const { q, id } = await fixture(); let current = alias; let live = 'live-one'; const attempts = [];
    for (let n = 0; n < 31; n++) {
      await enqueue(q, id, payload('send-' + n)); await q.resume(id, live);
      const a = (await q.claim(id, { boundaryId: 'batch', boundarySeq: 1, incarnation: live, alias: current, wireHash: 'a'.repeat(64) }))!.attempt;
      attempts.push(a); await q.accept(id, a, 'receipt-' + n);
      const c = await q.freezeForClear(id, live); await q.beginClear(id, c.clearId);
      current = { ...alias, conversationId: 'conversation-' + n }; live = 'live-' + n; await q.rebindAfterClear(id, c.clearId, current, live);
    }
    const c = await q.freezeForClear(id, live);
    await expect(q.beginClear(id, c.clearId)).rejects.toThrow(/alias capacity/);
    expect(q.snapshot(id).clear?.phase).toBe('frozen'); // external command has NOT been authorized
    await q.confirm(id, attempts[0], 'old-row'); await q.beginClear(id, c.clearId);
    await q.rebindAfterClear(id, c.clearId, { ...alias, conversationId: 'last' }, 'last-live');
    expect(q.snapshot(id).aliases.length).toBeLessThanOrEqual(32);
    await enqueue(q, id, payload('new-waiting')); await q.resume(id, 'last-live');
    const next = await q.claim(id, { boundaryId: 'next', boundarySeq: 1, incarnation: 'last-live', alias: { ...alias, conversationId: 'last' }, wireHash: 'a'.repeat(64) });
    expect(next?.item.sendId).toBe('new-waiting'); // old receipt-only items do not hold dispatch forever
  });
  it('protects reserved Clear result storage from later enqueues while the command is executing', async () => {
    const { q, id } = await fixture();
    for (let n = 0; n < 7; n++) await enqueue(q, id, { sendId: 'large-' + n, originalText: 'x'.repeat(262144), attachments: [], displayContent: '' });
    const c = await q.freezeForClear(id, 'live-one'); await q.beginClear(id, c.clearId);
    await expect(enqueue(q, id, { sendId: 'crowd-out-result', originalText: 'x'.repeat(253000), attachments: [], displayContent: '' })).rejects.toThrow(/reservation/);
    await q.rebindAfterClear(id, c.clearId, { ...alias, conversationId: 'b'.repeat(256) }, 'i'.repeat(256));
    expect(q.snapshot(id).items).toHaveLength(7);
  });
  it('retains checkout, unresolved attempts and dedup history on close and refuses epoch rotation until resolved', async () => {
    const { q, id } = await fixture(); const first = await enqueue(q, id, payload());
    await q.checkout(id, first.item.queueItemId, { checkoutId: 'edit', sessionId: 'screen', draftRevision: 1 });
    await expect(q.rotateSendEpoch(id, q.snapshot(id).sendEpoch)).rejects.toThrow(/active/);
    await q.close(id, 'live-one'); expect(q.snapshot(id).items[0].checkout).toBeDefined();
    await q.bind(alias, 'live-two'); await q.cancelCheckout(id, { checkoutId: 'edit', sessionId: 'screen', draftRevision: 1 });
    await q.remove(id, first.item.queueItemId); await q.close(id, 'live-two');
    expect(q.snapshot(id).tombstones).toHaveLength(1); // not forgotten by automatic empty retirement
    await expect(q.retireClosed(id)).rejects.toThrow(/recoverable/);
    await q.rotateSendEpoch(id, q.snapshot(id).sendEpoch); await q.retireClosed(id);
    expect(() => q.snapshot(id)).toThrow(/Unknown/);
  });
  it('preserves full original payload, FIFO and immutable snapshots', async () => {
    const { q, id } = await fixture();
    const first = await enqueue(q, id, payload()); await enqueue(q, id, payload('second'));
    expect(first.item).toMatchObject(payload());
    const copy = q.snapshot(id); copy.items[0].attachments.length = 0;
    expect(q.snapshot(id).items[0].attachments).toEqual(payload().attachments);
    const a = await claim(q, id); expect(a?.item.sendId).toBe('send-one');
    expect(await claim(q, id, 'batch-two')).toBeNull(); // one active delivery
    await q.confirm(id, a!.attempt, 'transcript-one');
    expect((await claim(q, id, 'batch-two'))?.item.sendId).toBe('second');
  });
  it('deduplicates concurrently and retains bounded tombstones without evicting identity', async () => {
    const { q, id } = await fixture({ maxTombstones: 2 });
    const [a, b] = await Promise.all([enqueue(q, id, payload()), enqueue(q, id, payload())]);
    expect(a.item.queueItemId).toBe(b.item.queueItemId); expect(b.duplicate).toBe(true);
    await expect(enqueue(q, id, { ...payload(), originalText: 'conflict' })).rejects.toThrow(/different payload/);
    await q.remove(id, a.item.queueItemId);
    expect((await enqueue(q, id, payload())).duplicate).toBe(true);
    const second = await enqueue(q, id, payload('second')); await q.remove(id, second.item.queueItemId);
    await expect(enqueue(q, id, payload('third'))).rejects.toThrow(/identity history/);
    expect(q.snapshot(id).items).toHaveLength(0);
  });
  it('caps waiting payloads and refuses non-user input or malformed data', async () => {
    const { q, id } = await fixture({ maxItems: 1 });
    await enqueue(q, id, payload()); await expect(enqueue(q, id, payload('two'))).rejects.toThrow(/full/);
    await expect(enqueue(q, id, { ...payload(), source: 'task-notification' } as any)).rejects.toThrow(/payload/);
    await expect(enqueue(q, id, { ...payload(), originalText: 'x'.repeat(262145) })).rejects.toThrow(/payload/);
  });
  it('does not publish or expose an enqueue/claim until the durable transition completes', async () => {
    const { q, id, store, publish } = await fixture();
    const original = store.save; let finish!: () => void;
    vi.mocked(store.save).mockImplementationOnce(async (...args) => { await new Promise<void>(r => { finish = r; }); await original(...args); });
    const pendingEnqueue = enqueue(q, id, payload()); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(q.snapshot(id).items).toHaveLength(0); expect(publish).toHaveBeenCalledTimes(1);
    finish(); await pendingEnqueue;
    vi.mocked(store.save).mockRejectedValueOnce(Error('disk full'));
    await expect(claim(q, id)).rejects.toThrow('disk full');
    expect(q.snapshot(id).items[0].status).toBe('waiting');
    expect((await claim(q, id))?.item.status).toBe('delivering');
  });
  it('does not acknowledge an enqueue or freeze after a failed durable write', async () => {
    const { q, id, store, publish } = await fixture();
    vi.mocked(store.save).mockRejectedValueOnce(Error('storage offline'));
    await expect(enqueue(q, id, payload())).rejects.toThrow('storage offline');
    expect(q.snapshot(id).items).toHaveLength(0); expect(publish).toHaveBeenCalledTimes(1);
    await enqueue(q, id, payload()); const a = (await claim(q, id))!.attempt;
    vi.mocked(store.save).mockRejectedValueOnce(Error('storage offline'));
    await expect(q.freezeForClear(id, 'live-one')).rejects.toThrow('storage offline');
    expect(q.snapshot(id).clear).toBeNull(); expect(q.isCurrentClaim(id, a)).toBe(true);
  });
  it('keeps delivery waits outside transitions so enqueue, Stop and Clear are not blocked', async () => {
    const { q, id } = await fixture(); await enqueue(q, id, payload());
    const a = await claim(q, id); // transport may hold this token indefinitely, without holding a state lock
    await enqueue(q, id, payload('next')); await q.stop(id, 'live-one');
    expect(q.snapshot(id).paused).toBe(false);
    const clear = await q.freezeForClear(id, 'live-one');
    expect(clear.revoked.map(x => x.attemptId)).toEqual([a!.attempt.attemptId]);
    expect(q.snapshot(id).items.map(x => x.status)).toEqual(['uncertain', 'waiting']);
  });
  it('requires readiness, current live identity, fresh boundary and deliberate resume after restore', async () => {
    let ready = false; const { q, id, store } = await fixture({ ready: () => ready });
    await enqueue(q, id, payload()); expect(await claim(q, id)).toBeNull(); ready = true;
    expect(await claim(q, id, 'batch-one', 'stale')).toBeNull();
    const a = await claim(q, id); await q.confirm(id, a!.attempt, 'u1');
    await enqueue(q, id, payload('two')); expect(await claim(q, id)).toBeNull(); // consumed boundary
    const restored = new ClaudeQueue({ storage: store, ready: () => true }); await restored.restore();
    await restored.bind(alias, 'live-two'); expect(restored.snapshot(id).paused).toBe(true);
    expect(await claim(restored, id, 'new', 'live-two')).toBeNull();
    await restored.prioritize(id, restored.snapshot(id).items[0].queueItemId, 'live-two');
    expect((await claim(restored, id, 'new', 'live-two'))?.item.sendId).toBe('two');
    await expect(enqueue(q, id, payload('stale-writer'))).rejects.toThrow(/revision conflict/);
  });
  it.each([false, true])('restores a claimed item uncertain with native acceptance %s, never automatically resending', async accepted => {
    const { q, id, store } = await fixture(); await enqueue(q, id, payload());
    const a = await claim(q, id); if (accepted) await q.accept(id, a!.attempt, 'receipt-one');
    const restored = new ClaudeQueue({ storage: store }); await restored.restore(); await restored.bind(alias, 'new-live');
    const row = restored.snapshot(id).items[0]; expect(row.status).toBe('uncertain'); expect(row.attempt?.receipt).toBe(accepted ? 'receipt-one' : undefined);
    if (accepted) await restored.resume(id, 'new-live');
    else await expect(restored.resume(id, 'new-live')).rejects.toThrow(/quarantine/);
    expect(await claim(restored, id, 'new-boundary', 'new-live')).toBeNull();
    await restored.confirm(id, a!.attempt, 'actual-human-attachment');
    expect(restored.snapshot(id).items).toHaveLength(0);
    expect((await enqueue(restored, id, payload())).duplicate).toBe(true);
  });
  it('removes only the exact waiting item and rejects checkout/removal after claim', async () => {
    const { q, id } = await fixture(); const a = await enqueue(q, id, payload()); const b = await enqueue(q, id, payload('two'));
    expect(await q.remove(id, b.item.queueItemId)).toMatchObject(payload('two'));
    await claim(q, id); await expect(q.remove(id, a.item.queueItemId)).rejects.toThrow(/waiting/);
    await expect(q.checkout(id, a.item.queueItemId, { checkoutId: 'edit', sessionId: 'screen', draftRevision: 1 })).rejects.toThrow(/waiting/);
  });
  it('reserves edit checkout idempotently and keeps a recoverable payload through disconnect/restart', async () => {
    const { q, id, store } = await fixture(); const a = await enqueue(q, id, payload());
    const editor = { checkoutId: 'edit-one', sessionId: 'screen-one', draftRevision: 4 };
    const x = await q.checkout(id, a.item.queueItemId, editor); expect(x).toMatchObject({ ...payload(), checkout: editor });
    expect(await q.checkout(id, a.item.queueItemId, editor)).toEqual(x);
    expect(await claim(q, id)).toBeNull();
    await expect(q.ackCheckout(id, { ...editor, draftRevision: 5 })).rejects.toThrow(/checkout/);
    const restored = new ClaudeQueue({ storage: store }); await restored.restore();
    expect(restored.snapshot(id).items[0].checkout).toEqual(editor);
    await restored.cancelCheckout(id, editor); expect(restored.snapshot(id).items[0].checkout).toBeUndefined();
    await expect(restored.checkout(id, a.item.queueItemId, editor)).rejects.toThrow(/cancelled/);
    const again = { ...editor, checkoutId: 'edit-after-cancel' };
    await restored.checkout(id, a.item.queueItemId, again); await restored.ackCheckout(id, again); await restored.ackCheckout(id, again);
    expect(restored.snapshot(id).items).toHaveLength(0); expect((await enqueue(restored, id, payload())).duplicate).toBe(true);
  });
  it('acknowledges repeated cancellation without releasing a newer editor or resurrecting the cancelled checkout', async () => {
    const { q, id, store } = await fixture(); const row = await enqueue(q, id, payload());
    const old = { checkoutId: 'cancelled', sessionId: 'screen-one', draftRevision: 1 };
    await q.checkout(id, row.item.queueItemId, old); await q.cancelCheckout(id, old);
    await expect(q.cancelCheckout(id, old)).resolves.toBeUndefined();
    await expect(q.checkout(id, row.item.queueItemId, old)).rejects.toThrow(/cancelled/);
    const newer = { checkoutId: 'newer', sessionId: 'screen-two', draftRevision: 2 };
    await q.checkout(id, row.item.queueItemId, newer); await q.cancelCheckout(id, old);
    expect(q.snapshot(id).items[0].checkout).toEqual(newer);
    const restored = new ClaudeQueue({ storage: store }); await restored.restore();
    await restored.cancelCheckout(id, old); expect(restored.snapshot(id).items[0].checkout).toEqual(newer);
  });
  it('bounds terminal cancellation history and rejects old editor requests after send epoch rotation', async () => {
    const { q, id } = await fixture(); const row = await enqueue(q, id, payload()); const oldEpoch = q.snapshot(id).sendEpoch;
    const first = { checkoutId: 'old-cancel', sessionId: 'screen', draftRevision: 1, sendEpoch: oldEpoch };
    await q.checkout(id, row.item.queueItemId, first); await q.cancelCheckout(id, first);
    await q.remove(id, row.item.queueItemId); const epoch = await q.rotateSendEpoch(id, oldEpoch);
    const next = await enqueue(q, id, payload('next'));
    await expect(q.checkout(id, next.item.queueItemId, first)).rejects.toThrow(/epoch/);
    await expect(q.checkout(id, next.item.queueItemId, { checkoutId: 'unscoped', sessionId: 'screen', draftRevision: 1 })).rejects.toThrow(/epoch/);
    const owner = { ...first, sendEpoch: epoch }; await q.checkout(id, next.item.queueItemId, owner);
    await expect(q.cancelCheckout(id, first)).rejects.toThrow(/epoch/);
    await q.cancelCheckout(id, { checkoutId: 'unscoped', sessionId: 'screen', draftRevision: 1 });
    expect(q.snapshot(id).items[0].checkout).toEqual(owner);
    await q.cancelCheckout(id, owner);
    for (let n = 0; n < 1023; n++) {
      const token = { checkoutId: 'terminal-' + n, sessionId: 'screen', draftRevision: n, sendEpoch: epoch };
      await q.checkout(id, next.item.queueItemId, token); await q.cancelCheckout(id, token);
    }
    expect(q.snapshot(id).cancelledCheckouts).toHaveLength(1024);
    await expect(q.checkout(id, next.item.queueItemId, { checkoutId: 'overflow', sessionId: 'screen', draftRevision: 2000, sendEpoch: epoch })).rejects.toThrow(/history full/);
    await q.cancelCheckout(id, owner); expect(q.snapshot(id).items[0].checkout).toBeUndefined(); // old terminal ack still works at cap
  });
  it('prioritizes selected waiting work and requests interrupt only from active readiness', async () => {
    const { q, id } = await fixture(); await enqueue(q, id, payload()); const b = await enqueue(q, id, payload('two'));
    expect(await q.prioritize(id, b.item.queueItemId, 'live-one', true)).toEqual({ interrupt: true });
    expect((await claim(q, id))?.item.sendId).toBe('two');
  });
  it('separates admission from native acceptance and blocks Clear until unknown handoff is resolved', async () => {
    const { q, id } = await fixture(); await enqueue(q, id, payload()); const a = (await claim(q, id))!.attempt;
    await q.admit(id, a, 'native-CAS');
    expect(q.snapshot(id).items[0].attempt).toMatchObject({ admission: 'native-CAS' });
    expect(q.snapshot(id).items[0].attempt?.receipt).toBeUndefined();
    const c = await q.freezeForClear(id, 'live-one');
    await expect(q.beginClear(id, c.clearId)).rejects.toThrow(/unresolved/);
    await expect(q.rebindAfterClear(id, c.clearId, alias, 'next')).rejects.toThrow(/Clear/);
    await expect(q.revokeBeforeAdmission(id, a, { revocationId: 'revoked', composerEmpty: true })).rejects.toThrow(/admission/);
    await q.accept(id, a, 'next-e-success');
    expect(q.snapshot(id).items[0].attempt?.receipt).toBe('next-e-success');
    expect(q.snapshot(id).items).toHaveLength(1); // no transcript UUID was invented
    await q.beginClear(id, c.clearId);
    await expect(q.beginClear(id, c.clearId)).rejects.toThrow(/started/);
    await q.rebindAfterClear(id, c.clearId, { ...alias, conversationId: 'cleared' }, 'next');
    expect(q.snapshot(id).items[0]).toMatchObject({ status: 'uncertain', attempt: { alias } });
    await q.confirm(id, a, 'real-transcript'); expect(q.snapshot(id).items).toHaveLength(0);
  });
  it('restores an admission-only claim quarantined without upgrading it to native acceptance', async () => {
    const { q, id, store } = await fixture(); await enqueue(q, id, payload()); const a = (await claim(q, id))!.attempt;
    await q.admit(id, a, 'CAS-only'); const c = await q.freezeForClear(id, 'live-one');
    const fresh = new ClaudeQueue({ storage: store }); await fresh.restore(); await fresh.bind(alias, 'new-live');
    expect(fresh.snapshot(id).items[0].attempt).toMatchObject({ admission: 'CAS-only' });
    expect(fresh.snapshot(id).items[0].attempt?.receipt).toBeUndefined();
    expect(fresh.hasWriteBarrier(id)).toBe(true); await expect(fresh.beginClear(id, c.clearId)).rejects.toThrow(/unresolved/);
    await fresh.confirm(id, a, 'actual-user-row'); await fresh.admit(id, a, 'CAS-only'); await fresh.accept(id, a, 'late-next');
    await fresh.beginClear(id, c.clearId); // transcript/acceptance may arrive in either order
  });
  it('partial staging blocks resume and Clear until native revocation proves no admission and an empty composer', async () => {
    const { q, id } = await fixture(); await enqueue(q, id, payload()); const a = (await claim(q, id))!.attempt;
    await q.uncertain(id, a); expect(q.snapshot(id).quarantines).toEqual([a.attemptId]);
    await expect(q.resume(id, 'live-one')).rejects.toThrow(/quarantine/);
    const c = await q.freezeForClear(id, 'live-one');
    await expect(q.beginClear(id, c.clearId)).rejects.toThrow(/unresolved/);
    await q.revokeBeforeAdmission(id, a, { revocationId: 'native-CAS-revoked', composerEmpty: true });
    expect(q.snapshot(id).items[0].status).toBe('waiting'); expect(q.snapshot(id).quarantines).toEqual([]);
    await q.beginClear(id, c.clearId); await q.rebindAfterClear(id, c.clearId, alias, 'next');
    expect(q.snapshot(id)).toMatchObject({ paused: true });
  });
  it('freezes Clear durably, rebinds aliases while paused and preserves old attempt provenance', async () => {
    const { q, id } = await fixture(); await enqueue(q, id, payload()); const b = await enqueue(q, id, payload('next'));
    const a = await claim(q, id); const clear = await q.freezeForClear(id, 'live-one');
    const replacement = { ...alias, conversationId: 'after-clear' };
    await q.accept(id, a!.attempt, 'late-receipt'); await q.beginClear(id, clear.clearId);
    await q.rebindAfterClear(id, clear.clearId, replacement, 'live-two');
    expect(q.snapshot(id)).toMatchObject({ queueId: id, alias: replacement, paused: true });
    expect(q.snapshot(id).items[0]).toMatchObject({ status: 'uncertain', attempt: { alias, incarnation: 'live-one' } });
    await q.accept(id, a!.attempt, 'late-receipt'); await q.confirm(id, a!.attempt, 'real-row');
    expect(q.snapshot(id).items.map(x => x.queueItemId)).toEqual([b.item.queueItemId]);
    await expect(q.bind(alias, 'live-two')).rejects.toThrow(/historical/); // old retained evidence never authorizes current binding
    expect(q.snapshot(id).paused).toBe(true);
    await expect(q.bind(replacement, 'other-live')).rejects.toThrow(/bound/);
  });
  it('quarantines an ambiguous failure and only retries a proven untouched claim in the current generation', async () => {
    const { q, id } = await fixture(); await enqueue(q, id, payload()); const a = await claim(q, id);
    await q.notSent(id, a!.attempt); expect(q.snapshot(id).items[0].status).toBe('waiting');
    const b = await claim(q, id, 'second'); await q.uncertain(id, b!.attempt);
    expect(q.snapshot(id)).toMatchObject({ paused: true });
    await expect(q.notSent(id, b!.attempt)).rejects.toThrow(/Claim/);
    await expect(q.accept(id, { ...b!.attempt, wireHash: 'b'.repeat(64) }, 'wrong')).rejects.toThrow(/attempt/);
  });
  it('Stop leaves waiting intent unpaused but requires safe handoff resolution before the next ready message', async () => {
    const { q, id } = await fixture(); await enqueue(q, id, payload()); await enqueue(q, id, payload('next'));
    const first = await claim(q, id); await q.stop(id, 'live-one');
    expect(q.snapshot(id).paused).toBe(false);
    expect(await claim(q, id, 'after-stop')).toBeNull(); // readiness cannot override composer quarantine
    await q.accept(id, first!.attempt, 'native-resolved');
    expect((await claim(q, id, 'after-stop'))?.item.sendId).toBe('next');
    expect(q.snapshot(id).items.find(i => i.sendId === first!.item.sendId)?.status).toBe('uncertain');
  });
  it('does not invoke readiness or write storage when an obsolete token cannot claim', async () => {
    const ready = vi.fn(() => true); const { q, id, store } = await fixture({ ready });
    await enqueue(q, id, payload()); const before = vi.mocked(store.save).mock.calls.length;
    expect(await claim(q, id, 'fence', 'old')).toBeNull();
    expect(ready).not.toHaveBeenCalled(); expect(store.save).toHaveBeenCalledTimes(before);
  });
  it('does not silently resume a frozen Clear or reassign an alias owned by another queue', async () => {
    const { q, id } = await fixture(); const two = { ...alias, conversationId: 'second' }; await q.bind(two, 'other');
    const c = await q.freezeForClear(id, 'live-one');
    await expect(q.resume(id, 'live-one')).rejects.toThrow(/frozen/);
    await q.beginClear(id, c.clearId);
    await expect(q.rebindAfterClear(id, c.clearId, two, 'new')).rejects.toThrow(/alias/);
    expect(q.snapshot(id)).toMatchObject({ paused: true, alias });
  });
  it('close preserves unsent entries, fences incarnation and permits a later binding without auto resume', async () => {
    const { q, id } = await fixture(); await enqueue(q, id, payload()); await q.close(id, 'live-one');
    expect(q.snapshot(id)).toMatchObject({ paused: true, live: null });
    await q.bind(alias, 'live-two'); expect(q.snapshot(id).items).toHaveLength(1); expect(await claim(q, id)).toBeNull();
  });
  it('keeps constant-size monotonic boundary history beyond 256 batches and rejects old sequences', async () => {
    const { q, id } = await fixture(); await enqueue(q, id, payload());
    for (let n = 0; n < 300; n++) { const a = (await claim(q, id, 'boundary-' + n))!; await q.notSent(id, a.attempt); }
    expect(await claim(q, id, 'boundary-0')).toBeNull();
    const next = (await claim(q, id, 'next'))!; expect(next.attempt.boundarySeq).toBe(301);
    expect(q.snapshot(id).boundaryHighWater).toBe(301);
    await q.notSent(id, next.attempt);
    expect(await q.claim(id, { ...next.attempt, boundaryId: 'different-name', alias })).toBeNull();
  });
  it('fails closed without readiness and makes acceptance idempotent even after transcript confirmation', async () => {
    const { store, q, id } = await fixture(); await enqueue(q, id, payload()); const a = await claim(q, id);
    await q.accept(id, a!.attempt, 'receipt'); await q.confirm(id, a!.attempt, 'uuid');
    await expect(q.accept(id, a!.attempt, 'receipt')).resolves.toBeUndefined();
    await expect(q.accept(id, a!.attempt, 'different')).rejects.toThrow(/receipt/);
    const restored = new ClaudeQueue({ storage: store }); await restored.restore(); await restored.bind(alias, 'new');
    await enqueue(restored, id, payload('next')); await restored.resume(id, 'new');
    expect(await claim(restored, id, 'fresh', 'new')).toBeNull();
  });
  it('rechecks readiness and exact claim identity without holding an IO lock', async () => {
    let ready = true; const { q, id } = await fixture({ ready: () => ready }); await enqueue(q, id, payload()); const a = (await claim(q, id))!.attempt;
    expect(q.isCurrentClaim(id, a)).toBe(true); ready = false; expect(q.isCurrentClaim(id, a)).toBe(false); ready = true;
    expect(q.isCurrentClaim(id, { ...a, wireHash: 'b'.repeat(64) })).toBe(false);
    await q.freezeForClear(id, 'live-one'); expect(q.isCurrentClaim(id, a)).toBe(false);
  });
  it('keeps a failed Clear frozen after restart and publishes only after every recovery write succeeds', async () => {
    const { q, id, store } = await fixture(); await enqueue(q, id, payload()); await q.freezeForClear(id, 'live-one');
    const publish = vi.fn(); const restored = new ClaudeQueue({ storage: store, publish });
    vi.mocked(store.save).mockRejectedValueOnce(Error('recovery IO'));
    await expect(restored.restore()).rejects.toThrow('recovery IO'); expect(publish).not.toHaveBeenCalled();
    expect(() => restored.snapshot(id)).toThrow(/restored/);
    await restored.restore(); await restored.bind(alias, 'new');
    await expect(restored.resume(id, 'new')).rejects.toThrow(/frozen/);
  });
  it('returns a claim only after its store write and prevents result/caller mutation from changing journal state', async () => {
    const { q, id, store } = await fixture(); const p = payload(); const enqueued = enqueue(q, id, p); p.attachments.length = 0; await enqueued;
    const original = store.save; let finish!: () => void;
    vi.mocked(store.save).mockImplementationOnce(async (...args) => { await new Promise<void>(r => { finish = r; }); await original(...args); });
    let returned = false; const pending = claim(q, id).then(v => { returned = true; return v; });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function')); expect(returned).toBe(false); expect(q.snapshot(id).items[0].status).toBe('waiting');
    finish(); const a = (await pending)!; expect(a.item.attachments).toEqual(payload().attachments);
    a.item.attachments.length = 0; a.attempt.alias.conversationId = 'changed';
    expect(q.snapshot(id).items[0].attempt?.alias).toEqual(alias);
  });
  it('rejects duplicate aliases from storage and exposes no partial restore', async () => {
    const { records, id } = await fixture(); const one = structuredClone(records.get(id)!);
    const q = new ClaudeQueue({ storage: { load: async () => [one, { ...one, queueId: randomUUID() }], save: async () => {}, retire: async () => {} } });
    await expect(q.restore()).rejects.toThrow(/alias/); expect(() => q.snapshot(id)).toThrow(/restored/);
  });
});
