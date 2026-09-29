// @vitest-environment jsdom
// mock-shim.ts's `docComments` namespace (T5, design docs/active/specs/
// 2026-09-26-doc-comments-build-design.md §7) — pins that the workbench's
// fake serves the SAME wire shape the real docComments:* IPC does
// ({ok:true,comments:PersistedComment[]}/{ok:true,id}/{ok:false,error}), so
// the renderer's real store (doc-comments-store.ts) runs unmodified against
// it, and that every seeded fixture file/state is actually reachable.
import { afterEach, describe, it, expect } from 'vitest';
import { createStore } from '../src/renderer/dev/workbench/mock-store';
import { createMockShim, setLatency } from '../src/renderer/dev/workbench/mock-shim';

setLatency(0);

afterEach(() => { window.history.replaceState({}, '', '/'); });

const PLAN_PATH = 'docs/active/plans/2026-09-24-onboarding-redesign.md';
const CODE_PATH = 'desktop/src/renderer/components/ChatView.tsx';
const DOCX_PATH = 'docs/launch-brief.docx';
const XLSX_PATH = 'reports/q3-sales-by-rep.xlsx';

function shim(scenario: Parameters<typeof createStore>[0] = 'default') {
  return createMockShim(createStore(scenario)) as any;
}

describe('mock-shim docComments', () => {
  it('seeds every fixture file the workbench must be able to show on ?mode=workbench', async () => {
    const c = shim();
    for (const path of [PLAN_PATH, CODE_PATH, DOCX_PATH, XLSX_PATH]) {
      const res = await c.docComments.list(path);
      expect(res.ok).toBe(true);
      expect(res.comments.length).toBeGreaterThan(0);
    }
  });

  it('the seeded set covers open, replied, resolved and a person: author (Word/Excel colleague)', async () => {
    const c = shim();
    const all = [
      ...(await c.docComments.list(PLAN_PATH)).comments,
      ...(await c.docComments.list(CODE_PATH)).comments,
      ...(await c.docComments.list(DOCX_PATH)).comments,
      ...(await c.docComments.list(XLSX_PATH)).comments,
    ];
    expect(all.some((x: any) => !x.resolved && x.replies.length === 0)).toBe(true); // open, no reply
    expect(all.some((x: any) => !x.resolved && x.replies.length > 0)).toBe(true); // replied, still open
    expect(all.some((x: any) => x.resolved)).toBe(true); // resolved
    expect(all.some((x: any) => typeof x.author === 'string' && x.author.startsWith('person:'))).toBe(true);
    // A cell selector (Excel) and a text selector with a lineHint (code).
    expect(all.some((x: any) => x.selector.kind === 'cell')).toBe(true);
    expect(all.some((x: any) => x.selector.kind === 'text' && x.selector.lineHint)).toBe(true);
  });

  it('the empty scenario seeds nothing (a first-open file with zero comments)', async () => {
    // `activeScenario` (mock-shim.ts's `handWritten`) reads the URL, not the
    // store the scenario id builds — same convention mock-shim-window.test.ts
    // uses for every other URL-driven scenario check.
    window.history.replaceState({}, '', '/?scenario=empty');
    const c = shim('empty');
    const res = await c.docComments.list(PLAN_PATH);
    expect(res).toEqual({ ok: true, comments: [] });
  });

  it('add refuses empty text the same way the real store does, and mints its own id on success', async () => {
    const c = shim();
    const selector = { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'x', prefix: '', suffix: '', occurrence: 0 } };
    const refused = await c.docComments.add('new-file.md', selector, '', 'user');
    expect(refused.ok).toBe(false);
    const added = await c.docComments.add('new-file.md', selector, 'a real note', 'user');
    expect(added.ok).toBe(true);
    expect(typeof added.id).toBe('string');
    const listed = await c.docComments.list('new-file.md');
    expect(listed.comments).toEqual([expect.objectContaining({ id: added.id, text: 'a real note' })]);
  });

  it('reply/resolve/reopen/move mutate the SAME comment list() reads back, and refuse an unknown id', async () => {
    const c = shim();
    const before = await c.docComments.list(PLAN_PATH);
    const id = before.comments[0].id;
    expect((await c.docComments.reply('irrelevant-path', 'no-such-id', 'x', 'user')).ok).toBe(false);
    expect((await c.docComments.reply(PLAN_PATH, id, 'a reply', 'assistant')).ok).toBe(true);
    expect((await c.docComments.resolve(PLAN_PATH, id, 'user')).ok).toBe(true);
    let after = await c.docComments.list(PLAN_PATH);
    const updated = after.comments.find((x: any) => x.id === id);
    expect(updated.resolved).toBe(true);
    expect(updated.replies.some((r: any) => r.text === 'a reply')).toBe(true);
    expect((await c.docComments.reopen(PLAN_PATH, id, 'user')).ok).toBe(true);
    const newSelector = { kind: 'cell', selector: { type: 'CellSelector', cell: 'Z9' } };
    expect((await c.docComments.move(PLAN_PATH, id, newSelector)).ok).toBe(true);
    after = await c.docComments.list(PLAN_PATH);
    expect(after.comments.find((x: any) => x.id === id).selector).toEqual(newSelector);
  });

  it('edit/edit-reply/delete/delete-reply mutate the SAME comment list() reads back, and refuse an unknown id', async () => {
    const c = shim();
    const before = await c.docComments.list(PLAN_PATH);
    const id = before.comments[0].id;
    expect((await c.docComments.reply(PLAN_PATH, id, 'a reply', 'assistant')).ok).toBe(true);
    const withReply = await c.docComments.list(PLAN_PATH);
    const replyId = withReply.comments.find((x: any) => x.id === id).replies[0].id;

    expect((await c.docComments.edit('irrelevant-path', 'no-such-id', 'x')).ok).toBe(false);
    expect((await c.docComments.edit(PLAN_PATH, id, 'edited text')).ok).toBe(true);
    expect((await c.docComments.editReply(PLAN_PATH, id, replyId, 'edited reply')).ok).toBe(true);
    const afterEdit = await c.docComments.list(PLAN_PATH);
    const edited = afterEdit.comments.find((x: any) => x.id === id);
    expect(edited.text).toBe('edited text');
    expect(edited.replies.find((r: any) => r.id === replyId).text).toBe('edited reply');

    expect((await c.docComments.deleteReply(PLAN_PATH, id, replyId)).ok).toBe(true);
    const afterDeleteReply = await c.docComments.list(PLAN_PATH);
    expect(afterDeleteReply.comments.find((x: any) => x.id === id).replies).toEqual([]);

    expect((await c.docComments.delete(PLAN_PATH, id)).ok).toBe(true);
    const afterDelete = await c.docComments.list(PLAN_PATH);
    expect(afterDelete.comments.some((x: any) => x.id === id)).toBe(false);
    expect((await c.docComments.delete(PLAN_PATH, id)).ok).toBe(false); // already gone
  });

  it('edit/editReply refuse empty text the same way add does', async () => {
    const c = shim();
    const before = await c.docComments.list(PLAN_PATH);
    const id = before.comments[0].id;
    expect((await c.docComments.edit(PLAN_PATH, id, '')).ok).toBe(false);
  });

  it('onChanged fires on every mutation, and watch/unwatch never throw', async () => {
    const c = shim();
    const events: Array<{ path: string }> = [];
    const unsub = c.docComments.onChanged((evt: { path: string }) => events.push(evt));
    await c.docComments.watch(PLAN_PATH);
    const selector = { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'y', prefix: '', suffix: '', occurrence: 0 } };
    await c.docComments.add(PLAN_PATH, selector, 'note', 'user');
    expect(events).toEqual([{ path: PLAN_PATH }]);
    await c.docComments.unwatch(PLAN_PATH);
    unsub();
  });
});
