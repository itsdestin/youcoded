// Pins T3's docComments:* dispatch point (docs/active/specs/2026-09-26-doc-
// comments-build-design.md §1.1, §3.2, §4.1), T11's docx write dispatch
// (§3.3) AND T13's xlsx write dispatch (§4.3): a .docx/.xlsx target has no
// sidecar — list() reads the file's OWN comments via T10/T12's readers, and
// every mutation dispatches to docx-comments.ts's/xlsx-comments.ts's own
// write functions through the SAME containment/untracked-source gate
// `listNativeComments` already uses.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  nativeFormatFor,
  refuseNativeMutation,
  listNativeComments,
  addNativeDocxComment,
  replyToNativeDocxComment,
  resolveNativeDocxComment,
  reopenNativeDocxComment,
  moveNativeDocxComment,
  addNativeXlsxComment,
  replyToNativeXlsxComment,
  resolveNativeXlsxComment,
  reopenNativeXlsxComment,
  moveNativeXlsxComment,
} from '../src/main/doc-comments/doc-comments-dispatch';

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'doc-comments');

let root: string;
beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-doc-comments-dispatch-'));
});
afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('nativeFormatFor', () => {
  it('classifies .docx and .xlsx, case-insensitively, and nothing else', () => {
    expect(nativeFormatFor('docs/plan.DOCX')).toBe('docx');
    expect(nativeFormatFor('reports/q3.xlsx')).toBe('xlsx');
    expect(nativeFormatFor('notes/todo.md')).toBeNull();
    expect(nativeFormatFor('src/app.ts')).toBeNull();
  });
});

describe('refuseNativeMutation', () => {
  it('lets a .docx target, a .xlsx target, and everything else proceed — every native write path is real', () => {
    expect(refuseNativeMutation('reports/q3.xlsx')).toBeNull();
    expect(refuseNativeMutation('docs/plan.docx')).toBeNull();
    expect(refuseNativeMutation('notes/todo.md')).toBeNull();
  });
});

describe('listNativeComments — reading a real .docx inside a project', () => {
  it('reads the fixture’s own comments through the containment-checked source path', async () => {
    await fs.promises.mkdir(path.join(root, 'docs'), { recursive: true });
    await fs.promises.copyFile(path.join(FIXTURES_DIR, 'launch-brief.docx'), path.join(root, 'docs', 'launch-brief.docx'));
    const result = await listNativeComments('docx', { path: 'docs/launch-brief.docx', projectRoot: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.comments.length).toBeGreaterThan(0);
    expect(result.comments[0].path).toBe('docs/launch-brief.docx');
  });

  it('refuses a ../../etc/passwd-shaped path the same way every other entry point does', async () => {
    const result = await listNativeComments('docx', { path: '../../../../etc/passwd', projectRoot: root });
    expect(result).toEqual({ ok: false, error: 'path-outside-project' });
  });
});

describe('listNativeComments — reading a real .xlsx inside a project', () => {
  it('reads the fixture’s own cell notes through the containment-checked source path', async () => {
    await fs.promises.mkdir(path.join(root, 'reports'), { recursive: true });
    await fs.promises.copyFile(path.join(FIXTURES_DIR, 'q3-sales-by-rep.xlsx'), path.join(root, 'reports', 'q3-sales-by-rep.xlsx'));
    const result = await listNativeComments('xlsx', { path: 'reports/q3-sales-by-rep.xlsx', projectRoot: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const q3Note = result.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'B2');
    expect(q3Note).toBeDefined();
    expect(q3Note?.text).toContain('West is Priya');
  });
});

describe('listNativeComments — fallback (no projectRoot) source-file gate (post-T3 review, F1 blocker)', () => {
  // Gate 2 of the F1 fix: `resolveSourceFilePath`'s own no-projectRoot branch
  // resolves ANY absolute path with no containment at all (it exists to serve
  // §1.4's hashed loose-file *sidecar* lookup, which never exposes a file's
  // content) — reading actual .docx/.xlsx BYTES through it must instead reuse
  // the same authority the artifacts binary viewers use (`authorizeBytesRead`,
  // read-binary-access.ts), never trust an arbitrary caller-named path.
  //
  // RED-BEFORE-GREEN: against the pre-fix commit (58ee463df) this whole
  // describe block fails — the first case resolves ok:true and actually reads
  // the untracked file's comments, because no gate existed at all.
  it('refuses an untracked absolute .docx path with no projectRoot, even though the file is real and readable', async () => {
    const loose = path.join(root, 'untracked.docx');
    await fs.promises.copyFile(path.join(FIXTURES_DIR, 'launch-brief.docx'), loose);
    const result = await listNativeComments('docx', { path: loose }); // no projectRoot at all
    expect(result).toEqual({ ok: false, error: 'path-not-tracked' });
  });

  it('the same path with projectRoot supplied is unaffected by Gate 2 — it is judged by the ordinary in-project containment check instead', async () => {
    // Sanity that Gate 2 only applies to the NO-projectRoot fallback: the
    // identical relative path, with a projectRoot, still reads normally (this
    // is the pre-existing "reading a real .docx inside a project" case run
    // once more here to pin that the new gate did not also start refusing it).
    await fs.promises.mkdir(path.join(root, 'docs'), { recursive: true });
    await fs.promises.copyFile(path.join(FIXTURES_DIR, 'launch-brief.docx'), path.join(root, 'docs', 'in-project.docx'));
    const result = await listNativeComments('docx', { path: 'docs/in-project.docx', projectRoot: root });
    expect(result.ok).toBe(true);
  });
});

// T11: the docx mutation dispatch functions get the SAME containment/
// untracked-source gate as listNativeComments, before ever reaching
// docx-comments.ts's write module.
describe('addNativeDocxComment / replyToNativeDocxComment / etc. — gated the same way listNativeComments is', () => {
  it('adds a real comment through the containment-checked path inside a project', async () => {
    await fs.promises.mkdir(path.join(root, 'docs'), { recursive: true });
    const target = path.join(root, 'docs', 'launch-brief.docx');
    await fs.promises.copyFile(path.join(FIXTURES_DIR, 'launch-brief.docx'), target);
    const result = await addNativeDocxComment({
      path: 'docs/launch-brief.docx',
      projectRoot: root,
      selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'Marketing emails go out', prefix: '', suffix: '', occurrence: 0 } },
      text: 'Confirm the send time.',
      author: 'user',
    });
    expect(result.ok).toBe(true);
  });

  it('refuses a ../../etc/passwd-shaped path the same way listNativeComments does', async () => {
    const result = await addNativeDocxComment({
      path: '../../../../etc/passwd',
      projectRoot: root,
      selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'x', prefix: '', suffix: '', occurrence: 0 } },
      text: 'x',
      author: 'user',
    });
    expect(result).toEqual({ ok: false, error: 'path-outside-project' });
  });

  it('refuses an untracked absolute .docx path with no projectRoot, same as listNativeComments', async () => {
    const loose = path.join(root, 'untracked.docx');
    await fs.promises.copyFile(path.join(FIXTURES_DIR, 'launch-brief.docx'), loose);
    const result = await replyToNativeDocxComment({ path: loose, id: 'w-0', text: 'x', author: 'user' });
    expect(result).toEqual({ ok: false, error: 'path-not-tracked' });
  });

  it('resolve/reopen/move all dispatch to the real docx write path inside a project', async () => {
    await fs.promises.mkdir(path.join(root, 'docs'), { recursive: true });
    const target = path.join(root, 'docs', 'launch-brief.docx');
    await fs.promises.copyFile(path.join(FIXTURES_DIR, 'launch-brief.docx'), target);

    const resolved = await resolveNativeDocxComment({ path: 'docs/launch-brief.docx', projectRoot: root, id: 'w-1', by: 'user' });
    expect(resolved).toEqual({ ok: true });

    const reopened = await reopenNativeDocxComment({ path: 'docs/launch-brief.docx', projectRoot: root, id: 'w-1', by: 'user' });
    expect(reopened).toEqual({ ok: true });

    const moved = await moveNativeDocxComment({
      path: 'docs/launch-brief.docx',
      projectRoot: root,
      id: 'w-1',
      newSelector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'Marketing emails go out', prefix: '', suffix: '', occurrence: 0 } },
    });
    expect(moved).toEqual({ ok: true });
  });
});

// T13: the xlsx mutation dispatch functions get the SAME containment/
// untracked-source gate as listNativeComments/docx's own write dispatch,
// before ever reaching xlsx-comments.ts's write module.
describe('addNativeXlsxComment / replyToNativeXlsxComment / etc. — gated the same way listNativeComments is', () => {
  it('adds a real comment through the containment-checked path inside a project', async () => {
    await fs.promises.mkdir(path.join(root, 'reports'), { recursive: true });
    const target = path.join(root, 'reports', 'q3-sales-by-rep.xlsx');
    await fs.promises.copyFile(path.join(FIXTURES_DIR, 'q3-sales-by-rep.xlsx'), target);
    const result = await addNativeXlsxComment({
      path: 'reports/q3-sales-by-rep.xlsx',
      projectRoot: root,
      selector: { kind: 'cell', selector: { type: 'CellSelector', cell: 'A1', sheet: 'Q3' } },
      text: 'Confirm this total.',
      author: 'user',
    });
    expect(result.ok).toBe(true);
  });

  it('refuses a ../../etc/passwd-shaped path the same way listNativeComments does', async () => {
    const result = await addNativeXlsxComment({
      path: '../../../../etc/passwd',
      projectRoot: root,
      selector: { kind: 'cell', selector: { type: 'CellSelector', cell: 'A1', sheet: 'Q3' } },
      text: 'x',
      author: 'user',
    });
    expect(result).toEqual({ ok: false, error: 'path-outside-project' });
  });

  it('refuses an untracked absolute .xlsx path with no projectRoot, same as listNativeComments', async () => {
    const loose = path.join(root, 'untracked.xlsx');
    await fs.promises.copyFile(path.join(FIXTURES_DIR, 'q3-sales-by-rep.xlsx'), loose);
    const result = await replyToNativeXlsxComment({ path: loose, id: 'x-1-B2', text: 'x', author: 'user' });
    expect(result).toEqual({ ok: false, error: 'path-not-tracked' });
  });

  it('reply/resolve/reopen/move all dispatch to the real xlsx write path inside a project', async () => {
    await fs.promises.mkdir(path.join(root, 'reports'), { recursive: true });
    const target = path.join(root, 'reports', 'q3-sales-by-rep.xlsx');
    await fs.promises.copyFile(path.join(FIXTURES_DIR, 'q3-sales-by-rep.xlsx'), target);

    const listed = await listNativeComments('xlsx', { path: 'reports/q3-sales-by-rep.xlsx', projectRoot: root });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const q3Note = listed.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'B2');
    expect(q3Note).toBeDefined();
    const id = q3Note!.id;

    const replied = await replyToNativeXlsxComment({ path: 'reports/q3-sales-by-rep.xlsx', projectRoot: root, id, text: 'Thanks!', author: 'user' });
    expect(replied).toEqual({ ok: true });

    const resolved = await resolveNativeXlsxComment({ path: 'reports/q3-sales-by-rep.xlsx', projectRoot: root, id, by: 'user' });
    expect(resolved).toEqual({ ok: true });

    const reopened = await reopenNativeXlsxComment({ path: 'reports/q3-sales-by-rep.xlsx', projectRoot: root, id, by: 'user' });
    expect(reopened).toEqual({ ok: true });

    const moved = await moveNativeXlsxComment({
      path: 'reports/q3-sales-by-rep.xlsx',
      projectRoot: root,
      id,
      newSelector: { kind: 'cell', selector: { type: 'CellSelector', cell: 'C2', sheet: 'Q3' } },
    });
    expect(moved).toEqual({ ok: true });
  });
});
