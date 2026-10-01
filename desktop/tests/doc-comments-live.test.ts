// Finish plan Task 6: while Office has a Word/Excel file open, comment reads and changes go
// through its editor (live-comments.ts), because a write to the file would be erased by the
// editor's next autosave. When no editor holds the file, the file is read and written as before.
// The editor here is a stand-in for the add-on's yc-comments.js (its own tests pin that side).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  listNativeComments, addNativeDocxComment, replyToNativeDocxComment, resolveNativeDocxComment,
  addNativeXlsxComment, deleteNativeDocxReply, editNativeDocxComment,
} from '../src/main/doc-comments/doc-comments-dispatch';
import { readDocxComments } from '../src/main/doc-comments/docx-comments';
import { setLiveCommentsRouter, EditorNotReady, type Ask, type LiveComment, type LiveOp, type LiveCommentsRouter } from '../src/main/doc-comments/live-comments';

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'doc-comments');

let root: string;
beforeEach(async () => { root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-doc-comments-live-'))); });
afterEach(async () => { setLiveCommentsRouter(null); await fs.promises.rm(root, { recursive: true, force: true }); });

/** An editor holding comments, answering ops the way yc-comments.js does. */
function fakeEditor(initial: LiveComment[] = []) {
  const comments = initial.map((c) => ({ ...c, replies: [...c.replies] }));
  const ops: LiveOp[] = [];
  let n = 0;
  const ask: Ask = async (op) => {
    ops.push(op);
    const find = (id: string) => comments.find((c) => c.id === id);
    switch (op.kind) {
      case 'list': return { ok: true, comments: JSON.parse(JSON.stringify(comments)) };
      case 'add': {
        const c: LiveComment = { id: `e${++n}`, text: op.text, author: op.author, time: 1, solved: false, replies: [], quote: op.quote, sheet: op.cell ? op.sheet ?? 'Q3' : undefined, cell: op.cell?.toUpperCase(), guid: op.cell ? `{AAAA-${n}}` : undefined };
        comments.push(c);
        return { ok: true, id: c.id, guid: c.guid };
      }
      case 'reply': { const c = find(op.id); if (!c) return { ok: false, error: 'comment-not-found' }; c.replies.push({ text: op.text, author: op.author, time: 2 }); return { ok: true, index: c.replies.length - 1 }; }
      case 'resolve': { const c = find(op.id); if (!c) return { ok: false, error: 'comment-not-found' }; c.solved = true; return { ok: true }; }
      case 'edit': { const c = find(op.id)!; c.text = op.text; return { ok: true }; }
      case 'delete-reply': { find(op.id)!.replies.splice(op.index, 1); return { ok: true }; }
      default: return { ok: false, error: 'unknown-op' };
    }
  };
  return { comments, ops, ask };
}

/** A router for one open file; `ready` false makes it keep (queue) the request. */
function routerFor(openPath: string, editor: ReturnType<typeof fakeEditor>, opts: { ready?: boolean } = {}): LiveCommentsRouter & { kept: Array<() => Promise<unknown>> } {
  const kept: Array<() => Promise<unknown>> = [];
  return {
    kept,
    async run(realPath, work, _fallback, { queueable }) {
      if (realPath !== openPath) return null;
      if (opts.ready === false) {
        if (!queueable) return null;
        kept.push(() => work(editor.ask));
        return { how: 'queued' };
      }
      try { return { how: 'live', value: await work(editor.ask) }; } catch (e) { if (e instanceof EditorNotReady) return { how: 'queued' }; throw e; }
    },
  };
}

async function copyFixture(name: string, rel: string): Promise<string> {
  const target = path.join(root, rel);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.copyFile(path.join(FIXTURES_DIR, name), target);
  return target;
}

const textSelector = (exact: string) => ({ kind: 'text' as const, selector: { type: 'TextQuoteSelector' as const, exact, prefix: '', suffix: '', occurrence: 0 } });

describe('comments on a Word file open in Office', () => {
  it('not open: an add writes the file, as before', async () => {
    const file = await copyFixture('launch-brief.docx', 'docs/brief.docx');
    setLiveCommentsRouter(routerFor('/somewhere/else.docx', fakeEditor()));
    const before = await readDocxComments(await fs.promises.readFile(file), 'docs/brief.docx');
    const quote = before.ok && before.comments[0].selector.kind === 'text' ? before.comments[0].selector.selector.exact : '';
    const r = await addNativeDocxComment({ path: 'docs/brief.docx', projectRoot: root, selector: textSelector(quote), text: 'On disk', author: 'assistant' });
    expect(r.ok).toBe(true);
    const after = await readDocxComments(await fs.promises.readFile(file), 'docs/brief.docx');
    expect(after.ok && after.comments.some((c) => c.text === 'On disk')).toBe(true);
  });

  it('open: the add goes to the editor (named "Assistant"), and the file is left for the editor to save', async () => {
    const file = await copyFixture('launch-brief.docx', 'docs/brief.docx');
    const bytes = await fs.promises.readFile(file);
    const editor = fakeEditor();
    setLiveCommentsRouter(routerFor(file, editor));
    const r = await addNativeDocxComment({ path: 'docs/brief.docx', projectRoot: root, selector: textSelector('launch'), text: 'Live', author: 'assistant' });
    expect(r).toEqual({ ok: true, id: 'oo-e1', text: 'Live' });
    expect(editor.ops).toContainEqual({ kind: 'add', text: 'Live', author: 'Assistant', quote: 'launch', occurrence: 0 });
    expect((await fs.promises.readFile(file)).equals(bytes)).toBe(true);
  });

  it('open: reads come from the editor, including a comment not saved yet; the saved one keeps its quote context', async () => {
    const file = await copyFixture('launch-brief.docx', 'docs/brief.docx');
    const saved = await readDocxComments(await fs.promises.readFile(file), 'docs/brief.docx');
    if (!saved.ok) throw new Error('fixture');
    const first = saved.comments[0];
    const name = first.author.slice('person:'.length);
    const quote = first.selector.kind === 'text' ? first.selector.selector.exact : '';
    const editor = fakeEditor([
      { id: 'e7', text: first.text, author: name, time: 5, solved: false, quote, replies: [] },
      { id: 'e8', text: 'Not saved yet', author: 'Assistant', time: 6, solved: false, quote: 'x', replies: [{ text: 'ok', author: 'You', time: 7 }] },
    ]);
    setLiveCommentsRouter(routerFor(file, editor));
    const r = await listNativeComments('docx', { path: 'docs/brief.docx', projectRoot: root });
    if (!r.ok) throw new Error(r.error);
    expect(r.comments.map((c) => c.id)).toEqual(['oo-e7', 'oo-e8']);
    expect(r.comments[0].selector).toEqual(first.selector);
    expect(r.comments[1].author).toBe('person:Assistant');
    expect(r.comments[1].replies).toEqual([{ id: 'oo-e8-r1', author: 'person:You', text: 'ok', createdAt: 7 }]);
  });

  it('open: an id read from the file before it opened (w-<n>) still names its comment', async () => {
    const file = await copyFixture('launch-brief.docx', 'docs/brief.docx');
    const saved = await readDocxComments(await fs.promises.readFile(file), 'docs/brief.docx');
    if (!saved.ok) throw new Error('fixture');
    const first = saved.comments[0];
    const quote = first.selector.kind === 'text' ? first.selector.selector.exact : '';
    const editor = fakeEditor([{ id: 'e7', text: first.text, author: first.author.slice('person:'.length), time: 5, solved: false, quote, replies: [] }]);
    setLiveCommentsRouter(routerFor(file, editor));
    const r = await replyToNativeDocxComment({ path: 'docs/brief.docx', projectRoot: root, id: first.id, text: 'Agreed', author: 'assistant' });
    expect(r).toMatchObject({ ok: true, reply: { id: `${first.id}-r1`, text: 'Agreed', author: 'assistant' } });
    expect(editor.comments[0].replies).toEqual([{ text: 'Agreed', author: 'Assistant', time: 2 }]);
    expect(await resolveNativeDocxComment({ path: 'docs/brief.docx', projectRoot: root, id: 'w-99999', by: 'assistant' })).toEqual({ ok: false, error: 'comment-not-found' });
  });

  it('open: the reading view\'s edit and reply delete reach the editor too', async () => {
    const file = await copyFixture('launch-brief.docx', 'docs/brief.docx');
    const editor = fakeEditor([{ id: 'e1', text: 'old', author: 'You', time: 1, solved: false, quote: 'q', replies: [{ text: 'r', author: 'Assistant', time: 2 }] }]);
    setLiveCommentsRouter(routerFor(file, editor));
    expect(await editNativeDocxComment({ path: 'docs/brief.docx', projectRoot: root, id: 'oo-e1', text: 'new' })).toEqual({ ok: true, text: 'new' });
    expect(await deleteNativeDocxReply({ path: 'docs/brief.docx', projectRoot: root, id: 'oo-e1', replyId: 'oo-e1-r1' })).toEqual({ ok: true });
    expect(editor.comments[0]).toMatchObject({ text: 'new', replies: [] });
    expect(await deleteNativeDocxReply({ path: 'docs/brief.docx', projectRoot: root, id: 'oo-e1', replyId: 'oo-e1-r4' })).toEqual({ ok: false, error: 'reply-not-found' });
  });

  it('open but its editor cannot answer yet: the change is kept and the caller told so; a read reads the file', async () => {
    const file = await copyFixture('launch-brief.docx', 'docs/brief.docx');
    const editor = fakeEditor();
    const router = routerFor(file, editor, { ready: false });
    setLiveCommentsRouter(router);
    const r = await addNativeDocxComment({ path: 'docs/brief.docx', projectRoot: root, selector: textSelector('launch'), text: 'Later', author: 'assistant' });
    expect(r).toEqual({ ok: true, queued: true });
    expect(editor.ops).toEqual([]);
    const listed = await listNativeComments('docx', { path: 'docs/brief.docx', projectRoot: root });
    expect(listed.ok && listed.comments.every((c) => c.id.startsWith('w-'))).toBe(true);
    // Once the editor is ready, the kept change is made there.
    await router.kept[0]();
    expect(editor.comments.map((c) => c.text)).toEqual(['Later']);
  });
});

describe('comments on an Excel file open in Office', () => {
  it('a live comment gets the id the saved file will give it: xt-<sheetId>-<cell>-<guid>', async () => {
    const file = await copyFixture('q3-sales-by-rep.xlsx', 'reports/q3.xlsx');
    const editor = fakeEditor();
    setLiveCommentsRouter(routerFor(file, editor));
    const listedBefore = await listNativeComments('xlsx', { path: 'reports/q3.xlsx', projectRoot: root });
    expect(listedBefore.ok).toBe(true);
    const r = await addNativeXlsxComment({ path: 'reports/q3.xlsx', projectRoot: root, selector: { kind: 'cell', selector: { type: 'CellSelector', cell: 'b4' } }, text: 'Check', author: 'user' });
    expect(r.ok && 'id' in r && r.id).toMatch(/^xt-\d+-B4-AAAA-1$/);
    expect(editor.ops.find((o) => o.kind === 'add')).toMatchObject({ kind: 'add', cell: 'b4', author: 'You' });
    const listed = await listNativeComments('xlsx', { path: 'reports/q3.xlsx', projectRoot: root });
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.comments.map((c) => c.id)).toEqual([(r as { id: string }).id]);
    expect(listed.comments[0].selector).toMatchObject({ kind: 'cell', selector: { cell: 'B4' } });
  });
});
