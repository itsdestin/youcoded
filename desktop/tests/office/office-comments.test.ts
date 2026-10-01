// Comments on a document open in Office go through its editor (main/office/office-comments.ts):
// main asks the window that opened the document, only that window's answer counts, and a change
// its editor cannot take yet is kept — made once the editor is ready, or written to the file once
// the document closes. A read is never kept: it reads the file.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createOfficeComments, OFFICE_COMMENTS_ANSWER, OFFICE_COMMENTS_CHANGED, OFFICE_COMMENTS_REQUEST } from '../../src/main/office/office-comments';
import type { Ask, LiveAnswer, LiveOp } from '../../src/main/doc-comments/live-comments';

const FILE = '/docs/plan.docx';

function setup(opts: { open?: boolean; inUse?: boolean } = {}) {
  const ipc = new EventEmitter();
  const state = { open: opts.open ?? true, inUse: opts.inUse ?? opts.open ?? true };
  const session = { token: 't1', path: FILE, senderId: 5 };
  const sessions = {
    latestByPath: (p: string) => (state.open && p === FILE ? session : undefined),
    inUse: (p: string) => state.inUse && p === FILE,
    get: (t: string) => (state.open && t === 't1' ? session : undefined),
  };
  // The window: answers each request with `reply(op)`, or stays silent when it returns undefined.
  let reply: (op: LiveOp & { key: string }) => LiveAnswer | undefined = () => ({ ok: true });
  const sent: Array<{ token: string; id: string; op: LiveOp & { key: string } }> = [];
  const win = {
    isDestroyed: () => false,
    send: vi.fn((channel: string, req: { token: string; id: string; op: LiveOp & { key: string } }) => {
      if (channel !== OFFICE_COMMENTS_REQUEST) return;
      sent.push(req);
      const a = reply(req.op);
      if (a) queueMicrotask(() => ipc.emit(OFFICE_COMMENTS_ANSWER, { sender: { id: 5 } }, req.id, a));
    }),
  };
  const changed: string[] = [];
  const router = createOfficeComments({
    sessions: () => sessions, windowFor: (id) => (id === 5 ? win : null), ipc, onChanged: (p) => changed.push(p), capMs: 1000, retryMs: 500,
  });
  return { ipc, state, router, sent, changed, setReply: (r: typeof reply) => { reply = r; } };
}

const add = (ask: Ask) => ask({ kind: 'add', text: 'hi', author: 'Assistant', quote: 'plan' });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('office comments router', () => {
  it('a file no editor holds is left to the file, untouched', async () => {
    const { router, sent } = setup({ open: false, inUse: false });
    const fallback = vi.fn(async () => 'file');
    expect(await router.run('/docs/other.docx', add, fallback, { queueable: true })).toBeNull();
    expect(await router.run(FILE, add, fallback, { queueable: true })).toBeNull();
    expect(sent).toEqual([]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('an open document\'s editor gets the op (named by its token) and its answer is the result', async () => {
    const { router, sent, setReply } = setup();
    setReply(() => ({ ok: true, id: 'e1' }));
    const r = await router.run(FILE, add, async () => null, { queueable: true });
    expect(r).toEqual({ how: 'live', value: { ok: true, id: 'e1' } });
    expect(sent[0]).toMatchObject({ token: 't1', op: { kind: 'add', text: 'hi' } });
    expect(sent[0].op.key).toMatch(/:0$/);
  });

  it('only the window that was asked may answer', async () => {
    const { ipc, router, sent, setReply } = setup();
    setReply(() => undefined);
    const p = router.run(FILE, add, async () => null, { queueable: true });
    await vi.advanceTimersByTimeAsync(0);
    ipc.emit(OFFICE_COMMENTS_ANSWER, { sender: { id: 99 } }, sent[0].id, { ok: true, id: 'forged' });
    ipc.emit(OFFICE_COMMENTS_ANSWER, { sender: { id: 5 } }, sent[0].id, { ok: true, id: 'real' });
    expect(await p).toEqual({ how: 'live', value: { ok: true, id: 'real' } });
  });

  it('an editor still opening keeps the change, makes it once ready, and never twice', async () => {
    const { router, sent, setReply } = setup();
    setReply(() => ({ ok: false, error: 'editor-not-ready' }));
    const r = await router.run(FILE, add, async () => null, { queueable: true });
    expect(r).toEqual({ how: 'queued' });
    expect(router.pending(FILE)).toBe(1);
    // A later change waits behind it, in order.
    expect(await router.run(FILE, (ask) => ask({ kind: 'resolve', id: 'e1' }), async () => null, { queueable: true })).toEqual({ how: 'queued' });
    setReply(() => ({ ok: true, id: 'e1' }));
    await vi.advanceTimersByTimeAsync(500);
    expect(router.pending(FILE)).toBe(0);
    const done = sent.filter((s) => s.op.kind !== 'list').map((s) => [s.op.kind, s.op.key.split(':')[0]]);
    // The add was tried twice with the same key (the editor makes it once), then the resolve.
    expect(done.map((d) => d[0])).toEqual(['add', 'add', 'resolve']);
    expect(done[0][1]).toBe(done[1][1]);
  });

  it('no answer in time counts as not ready: the change is kept', async () => {
    const { router, setReply } = setup();
    setReply(() => undefined);
    const p = router.run(FILE, add, async () => null, { queueable: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toEqual({ how: 'queued' });
  });

  it('a read the editor cannot answer reads the file instead of waiting', async () => {
    const { router, setReply } = setup();
    setReply(() => ({ ok: false, error: 'editor-busy' }));
    expect(await router.run(FILE, (ask) => ask({ kind: 'list' }), async () => null, { queueable: false })).toBeNull();
    expect(router.pending(FILE)).toBe(0);
  });

  it('a kept change whose document closes is written to the file', async () => {
    const { router, state, setReply } = setup();
    setReply(() => ({ ok: false, error: 'editor-not-ready' }));
    const fallback = vi.fn(async () => ({ ok: true }));
    await router.run(FILE, add, fallback, { queueable: true });
    state.open = false; state.inUse = true; // closing: still saving its last changes
    await vi.advanceTimersByTimeAsync(500);
    expect(fallback).not.toHaveBeenCalled();
    state.inUse = false; // closed
    await vi.advanceTimersByTimeAsync(500);
    expect(fallback).toHaveBeenCalledOnce();
    expect(router.pending(FILE)).toBe(0);
  });

  it('a document opening (not ready to be asked) keeps the change rather than writing the file under it', async () => {
    const { router, state } = setup({ open: false, inUse: true });
    const fallback = vi.fn(async () => null);
    expect(await router.run(FILE, add, fallback, { queueable: true })).toEqual({ how: 'queued' });
    state.open = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(fallback).not.toHaveBeenCalled();
    expect(router.pending(FILE)).toBe(0);
  });

  it('a comment changed in the editor is passed on for the document\'s path — from its own window only', () => {
    const { ipc, changed } = setup();
    ipc.emit(OFFICE_COMMENTS_CHANGED, { sender: { id: 99 } }, 't1');
    ipc.emit(OFFICE_COMMENTS_CHANGED, { sender: { id: 5 } }, 'nope');
    ipc.emit(OFFICE_COMMENTS_CHANGED, { sender: { id: 5 } }, 't1');
    expect(changed).toEqual([FILE]);
  });
});
