// T21's own staleness self-check (docs/active/specs/2026-09-26-doc-comments-
// build-design.md §9.3, §8 T21): "desktop's own CI adds a self-check that
// fails loudly if freshly-generated output no longer matches the committed
// golden fixture, so staleness is caught immediately rather than only the
// next time someone remembers to regenerate it."
//
// WHY this matters: the cross-platform parity tests (`DocxComments
// CrossPlatformParityTest.kt`, `XlsxCommentsCrossPlatformParityTest.kt`) read
// the COMMITTED golden `.docx`/`.xlsx` bytes directly — they never re-run
// desktop's writer. If a future change to `docx-comments.ts`/`xlsx-
// comments.ts` alters the write path's output shape (e.g. a different but
// individually-valid relationship-id scheme) WITHOUT the committed golden
// fixture being regenerated, desktop's own CI (which only checks its writer's
// FRESH output against fresh expectations) could stay green while the
// Kotlin-side test silently keeps comparing against now-STALE bytes that no
// longer represent what desktop's current code actually produces. This test
// closes that gap: it re-runs the EXACT recorded operation from each
// committed `write-golden/*.json` "recipe" against a fresh copy of the SAME
// original fixture, then asserts the fresh result still matches the
// committed golden — on drift, THIS test goes red immediately, on the
// desktop side, in the same CI run that introduced the change.
//
// WHY structural equality (via each format's own real reader), not a raw
// byte diff: `w:date`/`w16cex:dateUtc` (docx) and each `dT` a fresh `add`/
// `reply` stamps (xlsx) are real wall-clock timestamps — two runs of the
// SAME generator at two different real moments can never be byte-identical.
// The comparison this test makes is the SAME one already established and
// reviewed for cross-RUNTIME parity (`assertSameIgnoringTimestamps` in the
// Kotlin parity tests): every OBSERABLE field a caller can read back must
// match, `createdAt` excluded. A brand-new xlsx thread's own GUID is ALSO
// excluded for the same reason `XlsxCommentsCrossPlatformParityTest.kt`
// excludes it: `mutateAddXlsxComment` mints a fresh random GUID per call, so
// even two same-process runs of the SAME writer disagree on it by design.
import { describe, it, expect } from 'vitest';
import { readFile, writeFile, mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import JSZip from 'jszip';
import {
  readDocxComments,
  addDocxComment,
  replyToDocxComment,
  resolveDocxComment,
  reopenDocxComment,
  moveDocxComment,
  editDocxComment,
  editDocxReply,
  deleteDocxComment,
  deleteDocxReply,
} from '../src/main/doc-comments/docx-comments';
import {
  readXlsxComments,
  addXlsxComment,
  replyToXlsxComment,
  resolveXlsxComment,
  reopenXlsxComment,
  moveXlsxComment,
  editXlsxComment,
  editXlsxReply,
  deleteXlsxComment,
  deleteXlsxReply,
} from '../src/main/doc-comments/xlsx-comments';
import type { CommentSelector, PersistedComment } from '../src/shared/doc-comments-types';

const FIXTURES_DIR = join(__dirname, 'fixtures', 'doc-comments');
const GOLDEN_DIR = join(FIXTURES_DIR, 'write-golden');
const THREADED_REF_DIR = join(__dirname, '..', '..', 'shared-fixtures', 'doc-comments', 'xlsx-threaded-reference');

function textSelector(exact: string): CommentSelector {
  return { kind: 'text', selector: { type: 'TextQuoteSelector', exact, prefix: '', suffix: '', occurrence: 0 } };
}
function cellSelector(cell: string, sheet?: string): CommentSelector {
  return { kind: 'cell', selector: { type: 'CellSelector', cell, ...(sheet ? { sheet } : {}) } };
}

async function scratchCopyOf(bytes: Buffer | Uint8Array, name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ycd-golden-staleness-'));
  const target = join(dir, name);
  await writeFile(target, bytes);
  return target;
}

/** Field-for-field equality excluding `createdAt` (always) and `id`
 *  (`excludeId: true` — a brand-new xlsx thread's own freshly-minted GUID). */
function assertSameContent(expected: PersistedComment, actual: PersistedComment, label: string, excludeId = false) {
  if (!excludeId) expect(actual.id, `${label}: id`).toBe(expected.id);
  expect(actual.selector, `${label}: selector`).toEqual(expected.selector);
  expect(actual.text, `${label}: text`).toBe(expected.text);
  expect(actual.author, `${label}: author`).toBe(expected.author);
  expect(actual.resolved, `${label}: resolved`).toBe(expected.resolved);
  expect(actual.replies.map((r) => [r.author, r.text]), `${label}: replies`).toEqual(expected.replies.map((r) => [r.author, r.text]));
  expect(actual.history.map((h) => [h.by, h.action]), `${label}: history`).toEqual(expected.history.map((h) => [h.by, h.action]));
}

describe('doc-comments write-golden staleness self-check — docx', () => {
  const CASES = [
    { name: 'add-launch-brief', op: 'add', args: (a: any) => ({ selector: textSelector(a.exact), text: a.text, author: a.author }) },
    { name: 'add-spanning-comment', op: 'add', args: (a: any) => ({ selector: textSelector(a.exact), text: a.text, author: a.author }) },
    { name: 'add-word365-realistic', op: 'add', args: (a: any) => ({ selector: textSelector(a.exact), text: a.text, author: a.author }) },
    { name: 'reply-launch-brief', op: 'reply', args: (a: any) => ({ id: a.id, text: a.text, author: a.author }) },
    { name: 'resolve-spanning-comment', op: 'resolve', args: (a: any) => ({ id: a.id }) },
    { name: 'reopen-launch-brief', op: 'reopen', args: (a: any) => ({ id: a.id }) },
    { name: 'move-launch-brief', op: 'move', args: (a: any) => ({ id: a.id, newSelector: textSelector(a.newExact) }) },
    { name: 'move-word365-realistic', op: 'move', args: (a: any) => ({ id: a.id, newSelector: textSelector(a.newExact) }) },
    // Edit/delete build (2026-09-28, design doc §"Edit and delete") — this
    // task's own T21 parity extension, previously "not extended in this pass".
    { name: 'edit-launch-brief', op: 'edit', args: (a: any) => ({ id: a.id, text: a.text }) },
    { name: 'edit-reply-launch-brief', op: 'edit-reply', args: (a: any) => ({ id: a.id, replyId: a.replyId, text: a.text }) },
    { name: 'delete-reply-launch-brief', op: 'delete-reply', args: (a: any) => ({ id: a.id, replyId: a.replyId }) },
    { name: 'delete-thread-launch-brief', op: 'delete', args: (a: any) => ({ id: a.id }) },
  ] as const;

  for (const testCase of CASES) {
    it(`${testCase.name}: desktop's CURRENT writer still reproduces the committed golden`, async () => {
      const recipe = JSON.parse(await readFile(join(GOLDEN_DIR, `${testCase.name}.json`), 'utf8'));
      const originalBytes = await readFile(join(FIXTURES_DIR, recipe.fixture));
      const target = await scratchCopyOf(originalBytes, recipe.fixture);
      const callArgs = testCase.args(recipe.args);

      let result;
      if (testCase.op === 'add') result = await addDocxComment({ absolutePath: target, path: recipe.path, ...(callArgs as any) });
      else if (testCase.op === 'reply') result = await replyToDocxComment({ absolutePath: target, path: recipe.path, ...(callArgs as any) });
      else if (testCase.op === 'resolve') result = await resolveDocxComment({ absolutePath: target, path: recipe.path, ...(callArgs as any) });
      else if (testCase.op === 'reopen') result = await reopenDocxComment({ absolutePath: target, path: recipe.path, ...(callArgs as any) });
      else if (testCase.op === 'move') result = await moveDocxComment({ absolutePath: target, path: recipe.path, ...(callArgs as any) });
      else if (testCase.op === 'edit') result = await editDocxComment({ absolutePath: target, path: recipe.path, ...(callArgs as any) });
      else if (testCase.op === 'edit-reply') result = await editDocxReply({ absolutePath: target, path: recipe.path, ...(callArgs as any) });
      else if (testCase.op === 'delete') result = await deleteDocxComment({ absolutePath: target, path: recipe.path, ...(callArgs as any) });
      else result = await deleteDocxReply({ absolutePath: target, path: recipe.path, ...(callArgs as any) });

      expect(result.ok, `fresh write failed: ${JSON.stringify(result)}`).toBe(true);

      const goldenBytes = await readFile(join(GOLDEN_DIR, `${testCase.name}.docx`));
      const freshBytes = await readFile(target);
      const goldenRead = await readDocxComments(goldenBytes, recipe.path);
      const freshRead = await readDocxComments(freshBytes, recipe.path);
      expect(goldenRead.ok, 'committed golden must still parse').toBe(true);
      expect(freshRead.ok, 'freshly-written output must still parse').toBe(true);
      if (!goldenRead.ok || !freshRead.ok) return;

      const goldenComments = [...goldenRead.comments].sort((a, b) => a.id.localeCompare(b.id));
      const freshComments = [...freshRead.comments].sort((a, b) => a.id.localeCompare(b.id));
      expect(freshComments.length, `${testCase.name}: comment count drifted from the committed golden`).toBe(goldenComments.length);
      for (let i = 0; i < goldenComments.length; i++) {
        assertSameContent(goldenComments[i], freshComments[i], `${testCase.name} comments[${i}]`);
      }
    });
  }
});

describe('doc-comments write-golden staleness self-check — xlsx', () => {
  it("add-docling: desktop's CURRENT writer still reproduces the committed golden", async () => {
    const recipe = JSON.parse(await readFile(join(GOLDEN_DIR, 'add-docling.json'), 'utf8'));
    const step = recipe.steps[0];
    const originalBytes = await readFile(join(THREADED_REF_DIR, recipe.fixture));
    const target = await scratchCopyOf(originalBytes, recipe.fixture);

    const result = await addXlsxComment({ absolutePath: target, path: recipe.path, selector: cellSelector(step.args.cell), text: step.args.text, author: step.args.author });
    expect(result.ok, `fresh write failed: ${JSON.stringify(result)}`).toBe(true);

    const goldenRead = await readXlsxComments(await readFile(join(GOLDEN_DIR, 'add-docling.xlsx')), recipe.path);
    const freshRead = await readXlsxComments(await readFile(target), recipe.path);
    expect(goldenRead.ok).toBe(true);
    expect(freshRead.ok).toBe(true);
    if (!goldenRead.ok || !freshRead.ok) return;

    const goldenNew = goldenRead.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === step.args.cell)!;
    const freshNew = freshRead.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === step.args.cell)!;
    expect(goldenNew, 'committed golden missing the new thread').toBeDefined();
    expect(freshNew, 'fresh output missing the new thread').toBeDefined();
    assertSameContent(goldenNew, freshNew, 'add-docling new thread', true);

    // Every OTHER thread in this real (small, 2-thread) fixture is untouched.
    const goldenRest = goldenRead.comments.filter((c) => c.id !== goldenNew.id).sort((a, b) => a.id.localeCompare(b.id));
    const freshRest = freshRead.comments.filter((c) => c.id !== freshNew.id).sort((a, b) => a.id.localeCompare(b.id));
    expect(freshRest.length).toBe(goldenRest.length);
    for (let i = 0; i < goldenRest.length; i++) assertSameContent(goldenRest[i], freshRest[i], `add-docling unrelated[${i}]`);
  });

  it("move-docling: desktop's CURRENT writer still reproduces the committed golden", async () => {
    const recipe = JSON.parse(await readFile(join(GOLDEN_DIR, 'move-docling.json'), 'utf8'));
    const step = recipe.steps[0];
    const originalBytes = await readFile(join(THREADED_REF_DIR, recipe.fixture));
    const target = await scratchCopyOf(originalBytes, recipe.fixture);

    const result = await moveXlsxComment({ absolutePath: target, path: recipe.path, id: step.args.id, newSelector: cellSelector(step.args.newCell) });
    expect(result.ok, `fresh write failed: ${JSON.stringify(result)}`).toBe(true);

    const goldenRead = await readXlsxComments(await readFile(join(GOLDEN_DIR, 'move-docling.xlsx')), recipe.path);
    const freshRead = await readXlsxComments(await readFile(target), recipe.path);
    expect(goldenRead.ok).toBe(true);
    expect(freshRead.ok).toBe(true);
    if (!goldenRead.ok || !freshRead.ok) return;

    const goldenMoved = goldenRead.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === step.args.newCell)!;
    const freshMoved = freshRead.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === step.args.newCell)!;
    // A move never mints a fresh GUID (§4.2/§4.3), so the id IS deterministic
    // here — compared for real equality, unlike a brand-new `add`ed thread.
    assertSameContent(goldenMoved, freshMoved, 'move-docling moved thread', false);

    const goldenRest = goldenRead.comments.filter((c) => c.id !== goldenMoved.id).sort((a, b) => a.id.localeCompare(b.id));
    const freshRest = freshRead.comments.filter((c) => c.id !== freshMoved.id).sort((a, b) => a.id.localeCompare(b.id));
    expect(freshRest.length).toBe(goldenRest.length);
    for (let i = 0; i < goldenRest.length; i++) assertSameContent(goldenRest[i], freshRest[i], `move-docling unrelated[${i}]`);
  });

  it("resolve-b19-sibling: desktop's CURRENT writer still reproduces the committed golden", async () => {
    const recipe = JSON.parse(await readFile(join(GOLDEN_DIR, 'resolve-b19-sibling.json'), 'utf8'));
    const step = recipe.steps[0];
    const originalBytes = await readFile(join(THREADED_REF_DIR, recipe.fixture));
    const target = await scratchCopyOf(originalBytes, recipe.fixture);

    const result = await resolveXlsxComment({ absolutePath: target, path: recipe.path, id: step.args.id });
    expect(result.ok, `fresh write failed: ${JSON.stringify(result)}`).toBe(true);

    const goldenRead = await readXlsxComments(await readFile(join(GOLDEN_DIR, 'resolve-b19-sibling.xlsx')), recipe.path);
    const freshRead = await readXlsxComments(await readFile(target), recipe.path);
    expect(goldenRead.ok).toBe(true);
    expect(freshRead.ok).toBe(true);
    if (!goldenRead.ok || !freshRead.ok) return;

    const goldenComments = [...goldenRead.comments].sort((a, b) => a.id.localeCompare(b.id));
    const freshComments = [...freshRead.comments].sort((a, b) => a.id.localeCompare(b.id));
    expect(freshComments.length, 'comment count drifted from the committed golden (all ~700 threads, including B19 siblings)').toBe(goldenComments.length);
    for (let i = 0; i < goldenComments.length; i++) assertSameContent(goldenComments[i], freshComments[i], `resolve-b19-sibling comments[${i}]`);
  });

  it("elden-sequence: desktop's CURRENT writer still reproduces the committed golden", async () => {
    const recipe = JSON.parse(await readFile(join(GOLDEN_DIR, 'elden-sequence.json'), 'utf8'));
    const originalBytes = await readFile(join(THREADED_REF_DIR, recipe.fixture));
    const target = await scratchCopyOf(originalBytes, recipe.fixture);

    let currentId: string | undefined;
    for (const step of recipe.steps as any[]) {
      let r;
      if (step.op === 'add') {
        r = await addXlsxComment({ absolutePath: target, path: recipe.path, selector: cellSelector(step.args.cell, step.args.sheet), text: step.args.text, author: step.args.author });
        expect(r.ok, `add step failed: ${JSON.stringify(r)}`).toBe(true);
        if (r.ok) currentId = r.id;
      } else if (step.op === 'reply') {
        r = await replyToXlsxComment({ absolutePath: target, path: recipe.path, id: currentId!, text: step.args.text, author: step.args.author });
        expect(r.ok, `reply step failed: ${JSON.stringify(r)}`).toBe(true);
      } else if (step.op === 'resolve') {
        r = await resolveXlsxComment({ absolutePath: target, path: recipe.path, id: currentId! });
        expect(r.ok, `resolve step failed: ${JSON.stringify(r)}`).toBe(true);
      } else if (step.op === 'reopen') {
        r = await reopenXlsxComment({ absolutePath: target, path: recipe.path, id: currentId! });
        expect(r.ok, `reopen step failed: ${JSON.stringify(r)}`).toBe(true);
      } else if (step.op === 'move') {
        r = await moveXlsxComment({ absolutePath: target, path: recipe.path, id: currentId!, newSelector: cellSelector(step.args.newCell, step.args.newSheet) });
        expect(r.ok, `move step failed: ${JSON.stringify(r)}`).toBe(true);
        if (r.ok) currentId = r.id;
      }
    }

    const lastStep = recipe.steps[recipe.steps.length - 1];
    expect(lastStep.op, "this test's own final-state assertions assume the sequence ends with move").toBe('move');

    const goldenRead = await readXlsxComments(await readFile(join(GOLDEN_DIR, 'elden-sequence.xlsx')), recipe.path);
    const freshRead = await readXlsxComments(await readFile(target), recipe.path);
    expect(goldenRead.ok).toBe(true);
    expect(freshRead.ok).toBe(true);
    if (!goldenRead.ok || !freshRead.ok) return;

    const goldenFinal = goldenRead.comments.find(
      (c) => c.selector.kind === 'cell' && c.selector.selector.cell === lastStep.args.newCell && c.selector.selector.sheet === lastStep.args.newSheet
    )!;
    const freshFinal = freshRead.comments.find(
      (c) => c.selector.kind === 'cell' && c.selector.selector.cell === lastStep.args.newCell && c.selector.selector.sheet === lastStep.args.newSheet
    )!;
    expect(goldenFinal, 'committed golden missing the final moved thread').toBeDefined();
    expect(freshFinal, 'fresh output missing the final moved thread').toBeDefined();
    assertSameContent(goldenFinal, freshFinal, 'elden-sequence final thread', true);
    expect(freshFinal.resolved, 'resolve followed by reopen (then a move) must leave the thread unresolved').toBe(false);

    const goldenRest = goldenRead.comments.filter((c) => c.id !== goldenFinal.id).sort((a, b) => a.id.localeCompare(b.id));
    const freshRest = freshRead.comments.filter((c) => c.id !== freshFinal.id).sort((a, b) => a.id.localeCompare(b.id));
    expect(freshRest.length, 'unrelated thread count drifted (including the other 4 B19 siblings)').toBe(goldenRest.length);
    for (let i = 0; i < goldenRest.length; i++) assertSameContent(goldenRest[i], freshRest[i], `elden-sequence unrelated[${i}]`);
  });

  // Edit/delete build (2026-09-28, design doc §"Edit and delete") — this
  // task's own T21 parity extension, previously "not extended in this pass".
  // All four reuse docling's real F7 (root + one reply) and G12 (root only).
  it("edit-docling: desktop's CURRENT writer still reproduces the committed golden", async () => {
    const recipe = JSON.parse(await readFile(join(GOLDEN_DIR, 'edit-docling.json'), 'utf8'));
    const step = recipe.steps[0];
    const originalBytes = await readFile(join(THREADED_REF_DIR, recipe.fixture));
    const target = await scratchCopyOf(originalBytes, recipe.fixture);

    const result = await editXlsxComment({ absolutePath: target, path: recipe.path, id: step.args.id, text: step.args.text });
    expect(result.ok, `fresh write failed: ${JSON.stringify(result)}`).toBe(true);

    const goldenRead = await readXlsxComments(await readFile(join(GOLDEN_DIR, 'edit-docling.xlsx')), recipe.path);
    const freshRead = await readXlsxComments(await readFile(target), recipe.path);
    expect(goldenRead.ok).toBe(true);
    expect(freshRead.ok).toBe(true);
    if (!goldenRead.ok || !freshRead.ok) return;

    const goldenComments = [...goldenRead.comments].sort((a, b) => a.id.localeCompare(b.id));
    const freshComments = [...freshRead.comments].sort((a, b) => a.id.localeCompare(b.id));
    expect(freshComments.length, 'edit-docling: comment count drifted from the committed golden').toBe(goldenComments.length);
    for (let i = 0; i < goldenComments.length; i++) assertSameContent(goldenComments[i], freshComments[i], `edit-docling comments[${i}]`);
  });

  it("edit-reply-docling: desktop's CURRENT writer still reproduces the committed golden", async () => {
    const recipe = JSON.parse(await readFile(join(GOLDEN_DIR, 'edit-reply-docling.json'), 'utf8'));
    const step = recipe.steps[0];
    const originalBytes = await readFile(join(THREADED_REF_DIR, recipe.fixture));
    const target = await scratchCopyOf(originalBytes, recipe.fixture);

    const result = await editXlsxReply({ absolutePath: target, path: recipe.path, id: step.args.id, replyId: step.args.replyId, text: step.args.text });
    expect(result.ok, `fresh write failed: ${JSON.stringify(result)}`).toBe(true);

    const goldenRead = await readXlsxComments(await readFile(join(GOLDEN_DIR, 'edit-reply-docling.xlsx')), recipe.path);
    const freshRead = await readXlsxComments(await readFile(target), recipe.path);
    expect(goldenRead.ok).toBe(true);
    expect(freshRead.ok).toBe(true);
    if (!goldenRead.ok || !freshRead.ok) return;

    const goldenComments = [...goldenRead.comments].sort((a, b) => a.id.localeCompare(b.id));
    const freshComments = [...freshRead.comments].sort((a, b) => a.id.localeCompare(b.id));
    expect(freshComments.length, 'edit-reply-docling: comment count drifted from the committed golden').toBe(goldenComments.length);
    for (let i = 0; i < goldenComments.length; i++) assertSameContent(goldenComments[i], freshComments[i], `edit-reply-docling comments[${i}]`);
  });

  it("delete-reply-docling: desktop's CURRENT writer still reproduces the committed golden", async () => {
    const recipe = JSON.parse(await readFile(join(GOLDEN_DIR, 'delete-reply-docling.json'), 'utf8'));
    const step = recipe.steps[0];
    const originalBytes = await readFile(join(THREADED_REF_DIR, recipe.fixture));
    const target = await scratchCopyOf(originalBytes, recipe.fixture);

    const result = await deleteXlsxReply({ absolutePath: target, path: recipe.path, id: step.args.id, replyId: step.args.replyId });
    expect(result.ok, `fresh write failed: ${JSON.stringify(result)}`).toBe(true);

    const goldenRead = await readXlsxComments(await readFile(join(GOLDEN_DIR, 'delete-reply-docling.xlsx')), recipe.path);
    const freshRead = await readXlsxComments(await readFile(target), recipe.path);
    expect(goldenRead.ok).toBe(true);
    expect(freshRead.ok).toBe(true);
    if (!goldenRead.ok || !freshRead.ok) return;

    const goldenComments = [...goldenRead.comments].sort((a, b) => a.id.localeCompare(b.id));
    const freshComments = [...freshRead.comments].sort((a, b) => a.id.localeCompare(b.id));
    expect(freshComments.length, 'delete-reply-docling: comment count drifted from the committed golden').toBe(goldenComments.length);
    for (let i = 0; i < goldenComments.length; i++) assertSameContent(goldenComments[i], freshComments[i], `delete-reply-docling comments[${i}]`);
  });

  it("delete-thread-docling: desktop's CURRENT writer still reproduces the committed golden", async () => {
    const recipe = JSON.parse(await readFile(join(GOLDEN_DIR, 'delete-thread-docling.json'), 'utf8'));
    const step = recipe.steps[0];
    const originalBytes = await readFile(join(THREADED_REF_DIR, recipe.fixture));
    const target = await scratchCopyOf(originalBytes, recipe.fixture);

    const result = await deleteXlsxComment({ absolutePath: target, path: recipe.path, id: step.args.id });
    expect(result.ok, `fresh write failed: ${JSON.stringify(result)}`).toBe(true);

    const goldenRead = await readXlsxComments(await readFile(join(GOLDEN_DIR, 'delete-thread-docling.xlsx')), recipe.path);
    const freshRead = await readXlsxComments(await readFile(target), recipe.path);
    expect(goldenRead.ok).toBe(true);
    expect(freshRead.ok).toBe(true);
    if (!goldenRead.ok || !freshRead.ok) return;

    const goldenComments = [...goldenRead.comments].sort((a, b) => a.id.localeCompare(b.id));
    const freshComments = [...freshRead.comments].sort((a, b) => a.id.localeCompare(b.id));
    expect(freshComments.length, 'delete-thread-docling: comment count drifted from the committed golden').toBe(goldenComments.length);
    for (let i = 0; i < goldenComments.length; i++) assertSameContent(goldenComments[i], freshComments[i], `delete-thread-docling comments[${i}]`);
    // G12's independent thread must survive both the golden and the fresh write.
    expect(freshComments.some((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'G12')).toBe(true);
  });

  it("delete-last-comment-fresh: desktop's CURRENT writer still reproduces the committed golden, including part cleanup", async () => {
    const recipe = JSON.parse(await readFile(join(GOLDEN_DIR, 'delete-last-comment-fresh.json'), 'utf8'));
    const [addStep, deleteStep] = recipe.steps;
    const originalBytes = await readFile(join(FIXTURES_DIR, recipe.fixture));
    const target = await scratchCopyOf(originalBytes, recipe.fixture);

    const addResult = await addXlsxComment({ absolutePath: target, path: recipe.path, selector: cellSelector(addStep.args.cell), text: addStep.args.text, author: addStep.args.author });
    expect(addResult.ok, `fresh add failed: ${JSON.stringify(addResult)}`).toBe(true);
    if (!addResult.ok) return;
    const deleteResult = await deleteXlsxComment({ absolutePath: target, path: recipe.path, id: addResult.id });
    expect(deleteResult.ok, `fresh delete failed: ${JSON.stringify(deleteResult)}`).toBe(true);

    const freshRead = await readXlsxComments(await readFile(target), recipe.path);
    expect(freshRead).toEqual({ ok: true, comments: [] });

    // The committed golden itself must still read back as zero comments too.
    const goldenRead = await readXlsxComments(await readFile(join(GOLDEN_DIR, 'delete-last-comment-fresh.xlsx')), recipe.path);
    expect(goldenRead).toEqual({ ok: true, comments: [] });

    // Structural cleanup — every comment part, its rels, content-type
    // overrides and the worksheet's own <legacyDrawing> are all gone, on
    // BOTH the committed golden and the freshly-written output (mirrors
    // xlsx-comments.test.ts's own from-scratch last-comment-cleanup pin).
    for (const [label, bytes] of [
      ['golden', await readFile(join(GOLDEN_DIR, 'delete-last-comment-fresh.xlsx'))],
      ['fresh', await readFile(target)],
    ] as const) {
      const zip = await JSZip.loadAsync(bytes);
      expect(zip.file('xl/comments1.xml'), `${label}: comments1.xml must be gone`).toBeNull();
      expect(zip.file('xl/drawings/vmlDrawing1.vml'), `${label}: vmlDrawing1.vml must be gone`).toBeNull();
      expect(zip.file('xl/threadedComments/threadedComment1.xml'), `${label}: threadedComment1.xml must be gone`).toBeNull();
      const worksheetXml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
      expect(worksheetXml, `${label}: legacyDrawing must be gone`).not.toContain('legacyDrawing');
      const relsFile = zip.file('xl/worksheets/_rels/sheet1.xml.rels');
      if (relsFile) {
        const relsXml = await relsFile.async('string');
        expect(relsXml, `${label}: rels must not reference the removed comment parts`).not.toMatch(/comments1\.xml|vmlDrawing1\.vml|threadedComment1\.xml/);
      }
    }
  });
});
