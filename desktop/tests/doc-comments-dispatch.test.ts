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

  // T8 review F4: Windows' own filesystem API strips a trailing '.'/' ' off a
  // path component when it resolves one, so `report.docx.`/`report.docx ` on
  // disk really is `report.docx` there. Stubbing process.platform since this
  // suite runs on Linux and the real behavior is platform-specific.
  describe('a trailing dot/space (Windows filename normalization)', () => {
    const realPlatform = process.platform;
    afterEach(() => { Object.defineProperty(process, 'platform', { value: realPlatform }); });

    it('on win32: a trailing dot or space is stripped before the extension check, so it is still native', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      expect(nativeFormatFor('docs/brief.docx.')).toBe('docx');
      expect(nativeFormatFor('docs/brief.docx ')).toBe('docx');
      expect(nativeFormatFor('reports/q3.xlsx.')).toBe('xlsx');
      // Multiple trailing dots/spaces (Windows strips the whole trailing run).
      expect(nativeFormatFor('docs/brief.docx.. ')).toBe('docx');
      // An actual non-native file with a trailing dot stays non-native.
      expect(nativeFormatFor('notes/todo.md.')).toBeNull();
    });

    it('on POSIX: a trailing dot/space is significant — a genuinely different file, never coerced to native', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      expect(nativeFormatFor('docs/brief.docx.')).toBeNull();
      expect(nativeFormatFor('docs/brief.docx ')).toBeNull();
    });
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
  // §4.1's threaded-comments-only redesign (2026-09-27): `q3-sales-by-rep.xlsx`
  // carries only GENUINE legacy Notes, no threaded comments at all — this
  // dispatch point reads through xlsx-comments.ts's own reader, which now
  // never surfaces a genuine Note (the product has no write path for one any
  // more). Confirms the dispatch layer passes that empty result through
  // rather than a leftover legacy-Notes read succeeding underneath it.
  it('reads zero comments from a workbook with only genuine Notes, through the containment-checked source path', async () => {
    await fs.promises.mkdir(path.join(root, 'reports'), { recursive: true });
    await fs.promises.copyFile(path.join(FIXTURES_DIR, 'q3-sales-by-rep.xlsx'), path.join(root, 'reports', 'q3-sales-by-rep.xlsx'));
    const result = await listNativeComments('xlsx', { path: 'reports/q3-sales-by-rep.xlsx', projectRoot: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.comments).toEqual([]);
  });

  it('reads a real threaded comment through the containment-checked source path', async () => {
    await fs.promises.mkdir(path.join(root, 'reports'), { recursive: true });
    const target = path.join(root, 'reports', 'q3-sales-by-rep.xlsx');
    await fs.promises.copyFile(path.join(FIXTURES_DIR, 'q3-sales-by-rep.xlsx'), target);
    const added = await addNativeXlsxComment({
      path: 'reports/q3-sales-by-rep.xlsx',
      projectRoot: root,
      selector: { kind: 'cell', selector: { type: 'CellSelector', cell: 'C3', sheet: 'Q3' } },
      text: 'A brand new thread.',
      author: 'user',
    });
    expect(added.ok).toBe(true);
    const result = await listNativeComments('xlsx', { path: 'reports/q3-sales-by-rep.xlsx', projectRoot: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const thread = result.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'C3');
    expect(thread).toBeDefined();
    expect(thread?.text).toBe('A brand new thread.');
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

    // §4.1's threaded-comments-only redesign: this fixture carries only
    // genuine legacy Notes, so a real THREAD to mutate has to be added
    // first — mirrors how a real session would reach this state.
    const added = await addNativeXlsxComment({
      path: 'reports/q3-sales-by-rep.xlsx',
      projectRoot: root,
      selector: { kind: 'cell', selector: { type: 'CellSelector', cell: 'C3', sheet: 'Q3' } },
      text: 'A brand new thread.',
      author: 'user',
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const id = added.id;

    // Review leftover (a): reply is now enriched with the persisted
    // CommentReply, mirroring docx's own already-enriched reply response.
    const replied = await replyToNativeXlsxComment({ path: 'reports/q3-sales-by-rep.xlsx', projectRoot: root, id, text: 'Thanks!', author: 'user' });
    expect(replied).toEqual({ ok: true, reply: { id: expect.stringMatching(/^xt-.*-r1$/), author: 'user', text: 'Thanks!', createdAt: expect.any(Number) } });

    const resolved = await resolveNativeXlsxComment({ path: 'reports/q3-sales-by-rep.xlsx', projectRoot: root, id, by: 'user' });
    expect(resolved).toEqual({ ok: true });

    const reopened = await reopenNativeXlsxComment({ path: 'reports/q3-sales-by-rep.xlsx', projectRoot: root, id, by: 'user' });
    expect(reopened).toEqual({ ok: true });

    // Review F3 (Medium) partial fix: move now returns the FRESH, hint-
    // accurate id (embedding the new cell) rather than a bare {ok:true}.
    const moved = await moveNativeXlsxComment({
      path: 'reports/q3-sales-by-rep.xlsx',
      projectRoot: root,
      id,
      newSelector: { kind: 'cell', selector: { type: 'CellSelector', cell: 'C2', sheet: 'Q3' } },
    });
    expect(moved).toEqual({ ok: true, id: expect.stringMatching(/^xt-\d+-C2-/) });
  });
});
