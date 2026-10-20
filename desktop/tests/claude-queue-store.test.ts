import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeQueueStore } from '../src/main/claude-queue-store';
import { ClaudeQueue } from '../src/main/claude-queue';

const roots: string[] = [];
afterEach(async () => { for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true, maxRetries: 5 }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'claude-queue-store-')); roots.push(root);
  const storage = new ClaudeQueueStore(root); const q = new ClaudeQueue({ storage }); await q.restore();
  const alias = { provider: 'claude' as const, conversationId: 'conversation' }; const id = await q.bind(alias, 'live');
  return { root, storage, q, id, alias };
}
const enqueue = (q: ClaudeQueue, id: string, p: Omit<import('../src/shared/conversation-queue-types').QueuePayload, 'sendEpoch'>) => q.enqueue(id, { ...p, sendEpoch: q.snapshot(id).sendEpoch });
describe('private Claude queue journal storage', () => {
  it('round trips exact payload and aliases, restores paused before publication', async () => {
    const { storage, q, id, alias } = await fixture();
    const input = { sendId: 'stable', originalText: 'é\n@file  ', attachments: ['C:\\space folder\\image.png'], displayContent: 'display\nexact' };
    await enqueue(q, id, input);
    const published: any[] = []; const fresh = new ClaudeQueue({ storage, publish: s => published.push(s) }); await fresh.restore();
    expect(fresh.snapshot(id).items[0]).toMatchObject(input); expect(published.every(s => s.paused && s.live === null)).toBe(true);
    expect(await fresh.bind(alias, 'new')).toBe(id);
  });
  it('rebuilds both Clear aliases from the same journal after restart without a separate index', async () => {
    const { storage, q, id, alias } = await fixture();
    await enqueue(q, id, { sendId: 'stable', originalText: 'original', attachments: ['/tmp/image.png'], displayContent: 'display' });
    const clear = await q.freezeForClear(id, 'live'); const next = { ...alias, conversationId: 'replacement' };
    await q.beginClear(id, clear.clearId); await q.rebindAfterClear(id, clear.clearId, next, 'next-live');
    const fresh = new ClaudeQueue({ storage }); await fresh.restore();
    expect(await fresh.bind(next, 'restored')).toBe(id);
    expect(fresh.snapshot(id)).toMatchObject({ alias: next, aliases: [next], paused: true });
    expect(await fresh.bind(alias, 'independent-old-conversation')).not.toBe(id); // obsolete, unneeded alias was compacted
  });
  it('rejects invalid UTF-8 before JSON parsing and rejects a copied journal under a different UUID', async () => {
    const { root, storage, id } = await fixture(); const file = join(root, 'claude-queues', id + '.json'); const original = await readFile(file);
    await writeFile(file, Buffer.from([0xc3, 0x28])); await expect(storage.load()).rejects.toThrow();
    await writeFile(file, original); await writeFile(join(root, 'claude-queues', '11111111-1111-4111-8111-111111111111.json'), original);
    await expect(storage.load()).rejects.toThrow(/identity/);
  });
  it('CAS retirement rejects stale revisions and actionable data and cannot resurrect an old queue', async () => {
    const { storage, q, id, alias } = await fixture(); const old = (await storage.load())[0];
    await expect(storage.retire(id, old.revision)).rejects.toThrow(/recoverable/);
    await q.close(id, 'live'); expect(await storage.load()).toEqual([]);
    await expect(storage.save({ ...old, revision: old.revision + 1 }, old.revision)).rejects.toThrow(/revision/);
    const next = await q.bind(alias, 'new-live'); expect(next).not.toBe(id);
    await enqueue(q, next, { sendId: 's', originalText: 'x', attachments: [], displayContent: 'x' });
    await q.close(next, 'new-live'); const record = (await storage.load())[0];
    await expect(storage.retire(next, record.revision - 1)).rejects.toThrow(/revision/);
    await expect(storage.retire(next, record.revision)).rejects.toThrow(/recoverable/);
  });
  it('retries the exact committed retirement marker after unlink fails without permitting stale revisions', async () => {
    const { root, storage, q, id } = await fixture(); const file = join(root, 'claude-queues', id + '.json');
    const original = fs.unlink.bind(fs);
    const unlink = vi.spyOn(fs, 'unlink').mockImplementationOnce(async p => { if (p === file) throw Object.assign(Error('busy unlink'), { code: 'EBUSY' }); return original(p); });
    try {
      await expect(q.close(id, 'live')).rejects.toThrow('busy unlink');
      const closed = q.snapshot(id); const marker = JSON.parse(await readFile(file, 'utf8'));
      expect(marker).toMatchObject({ retired: true, queueId: id, revision: closed.revision + 1 });
      await expect(storage.retire(id, closed.revision - 1)).rejects.toThrow(/revision/);
      await q.retireClosed(id); expect(() => q.snapshot(id)).toThrow(/Unknown/);
      expect(await storage.load()).toEqual([]);
    } finally { unlink.mockRestore(); }
  });
  it('completes interrupted CAS retirement cleanup without loading it as an empty runnable queue', async () => {
    const { root, storage, id } = await fixture(); const old = (await storage.load())[0];
    await writeFile(join(root, 'claude-queues', id + '.json'), JSON.stringify({ version: 2, retired: true, queueId: id, revision: old.revision + 1 }));
    expect(await storage.load()).toEqual([]); expect(await storage.load()).toEqual([]);
    await expect(storage.save({ ...old, revision: old.revision + 1 }, old.revision)).rejects.toThrow(/revision/);
  });
  it('never retires a stored edit checkout or ambiguous delivery while closing', async () => {
    const { q, id, storage, alias } = await fixture();
    const row = await enqueue(q, id, { sendId: 'edit', originalText: 'original', attachments: ['/tmp/file'], displayContent: 'display' });
    const editor = { checkoutId: 'checkout', sessionId: 'screen', draftRevision: 7 };
    await q.checkout(id, row.item.queueItemId, editor); await q.close(id, 'live');
    const r = (await storage.load())[0]; await expect(storage.retire(id, r.revision)).rejects.toThrow(/recoverable/);
    const fresh = new ClaudeQueue({ storage, ready: () => true }); await fresh.restore(); await fresh.bind(alias, 'new-live');
    expect(fresh.snapshot(id).items[0].checkout).toEqual(editor); await fresh.cancelCheckout(id, editor); await fresh.resume(id, 'new-live');
    const a = (await fresh.claim(id, { boundaryId: 'batch', boundarySeq: 1, incarnation: 'new-live', alias, wireHash: 'a'.repeat(64) }))!;
    await fresh.close(id, 'new-live'); const uncertain = (await storage.load())[0];
    await expect(storage.retire(id, uncertain.revision)).rejects.toThrow(/recoverable/);
    expect(uncertain.items[0]).toMatchObject({ status: 'uncertain', attempt: { attemptId: a.attempt.attemptId } });
  });
  it('persists explicit epoch rotation and rejects a stale in-flight epoch after restart', async () => {
    const { q, id, storage, alias } = await fixture(); const epoch = q.snapshot(id).sendEpoch;
    const oldPayload = { sendEpoch: epoch, sendId: 'stable', originalText: 'one', attachments: [], displayContent: 'one' };
    const item = await q.enqueue(id, oldPayload); await q.remove(id, item.item.queueItemId);
    const nextEpoch = await q.rotateSendEpoch(id, epoch);
    const fresh = new ClaudeQueue({ storage }); await fresh.restore();
    // A fully history-free closed/restored queue can retire; rebinding creates a new UUID, also fencing old requests.
    expect(await fresh.bind(alias, 'restored')).not.toBe(id);
    await expect(fresh.enqueue(id, oldPayload)).rejects.toThrow(/Unknown/);
    expect(nextEpoch).not.toBe(epoch);
  });
  it('CAS refuses stale writers rather than overwriting another durable transition', async () => {
    const { storage, q, id } = await fixture(); const record = (await storage.load())[0];
    await enqueue(q, id, { sendId: 'one', originalText: 'one', attachments: [], displayContent: 'one' });
    await expect(storage.save({ ...record, revision: record.revision + 1 }, record.revision)).rejects.toThrow(/revision/);
    expect((await storage.load())[0].items).toHaveLength(1);
  });
  it('refuses malformed, oversized and unknown-version journals without overwriting bytes', async () => {
    const { root, storage, id } = await fixture(); const file = join(root, 'claude-queues', id + '.json');
    for (const body of ['{bad', JSON.stringify({ version: 900 }), ' '.repeat(ClaudeQueueStore.MAX_BYTES + 1)]) {
      await writeFile(file, body); await expect(storage.load()).rejects.toThrow(); expect(await readFile(file, 'utf8')).toBe(body);
    }
  });
  it('rejects path escape IDs, structural extras, duplicate items and invalid statuses', async () => {
    const { root, storage, q, id } = await fixture();
    await enqueue(q, id, { sendId: 'one', originalText: 'one', attachments: [], displayContent: 'one' });
    const record = (await storage.load())[0];
    await expect(storage.save({ ...record, queueId: '../escape' }, record.revision)).rejects.toThrow();
    for (const changed of [{ ...record, unexpected: true }, { ...record, items: [...record.items, ...record.items] }, { ...record, items: [{ ...record.items[0], status: 'go' }] }]) {
      await writeFile(join(root, 'claude-queues', id + '.json'), JSON.stringify(changed)); await expect(storage.load()).rejects.toThrow();
    }
  });
  it('read errors and blocked storage never become empty runnable queues', async () => {
    const { root } = await fixture(); const blocked = join(root, 'file-not-directory'); await writeFile(blocked, 'x');
    const q = new ClaudeQueue({ storage: new ClaudeQueueStore(blocked) }); await expect(q.restore()).rejects.toThrow();
    const badRoot = await mkdtemp(join(tmpdir(), 'queue-invalid-')); roots.push(badRoot); await mkdir(join(badRoot, 'claude-queues')); await writeFile(join(badRoot, 'claude-queues', 'bad.json'), '{}');
    await expect(new ClaudeQueue({ storage: new ClaudeQueueStore(badRoot) }).restore()).rejects.toThrow();
  });
});
