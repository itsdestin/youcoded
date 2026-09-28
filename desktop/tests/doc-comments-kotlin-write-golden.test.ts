// T21's "same in reverse" requirement (docs/active/specs/2026-09-26-doc-
// comments-build-design.md §9.3, §8 T21: "the same in reverse for a Kotlin-
// written fixture"). Every OTHER cross-platform golden in this build goes
// one direction only — desktop writes, Android reads (`write-golden/*`,
// consumed by `DocxCommentsCrossPlatformParityTest.kt`/`XlsxCommentsCross
// PlatformParityTest.kt`). This file closes the other direction: the Kotlin
// writer produced these two fixtures ONCE (`GenerateKotlinWriteGoldenTmp.kt`,
// a disposable JUnit-test-shaped generator run by hand via `./gradlew
// :app:testDebugUnitTest --tests ...GenerateKotlinWriteGoldenTmp` with
// `GENERATE_GOLDEN=1`, then deleted — the same "generator script, run by
// hand, not part of CI" convention as the TS side's `generate-*-golden.mjs`,
// adapted to Kotlin having no lightweight script runner), applying an add ->
// reply -> resolve -> move sequence to `launch-brief.docx` (docx) and
// `docling-xlsx-comments.xlsx` (xlsx). This test proves desktop's REAL reader
// (`docx-comments.ts`/`xlsx-comments.ts`) can read what Kotlin wrote and
// produces the shape Kotlin's own writer/JSON recipe (`shared-fixtures/
// doc-comments/kotlin-write-golden/*.json`) says it should.
//
// A Node process and a JVM process never run inside the same test (§9.3's
// own framing) — this fixture pair is a snapshot of one JVM run, committed,
// the same "both sides match a shared, checked-in golden fixture" structure
// every other T21 guard uses, just with the writer/reader roles swapped.
//
// `docx-edit-delete.{docx,json}`/`xlsx-edit-delete.{xlsx,json}` (2026-09-28,
// design doc §"Edit and delete") extend this same reverse direction to the
// edit/delete ops, added for this task's own T21 parity extension —
// previously "not extended in this pass" per that section's own closing
// note. Same disposable-generator convention, run once via the (also
// deleted) `GenerateKotlinWriteGoldenEditDeleteTmp.kt`: Kotlin edited one
// real pre-existing comment's text and deleted a DIFFERENT real pre-existing
// comment's whole thread (root + reply), in the same fixture, so one golden
// proves both ops in reverse.
import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { readDocxComments } from '../src/main/doc-comments/docx-comments';
import { readXlsxComments } from '../src/main/doc-comments/xlsx-comments';

const KOTLIN_GOLDEN_DIR = join(__dirname, '..', '..', 'shared-fixtures', 'doc-comments', 'kotlin-write-golden');

describe('doc-comments — desktop reads a Kotlin-WRITTEN docx (the reverse direction)', () => {
  it('the add -> reply -> resolve -> move sequence Kotlin wrote reads back correctly through the real desktop reader', async () => {
    const recipe = JSON.parse(await readFile(join(KOTLIN_GOLDEN_DIR, 'docx-add-reply-resolve-move.json'), 'utf8'));
    const bytes = await readFile(join(KOTLIN_GOLDEN_DIR, 'docx-add-reply-resolve-move.docx'));
    const result = await readDocxComments(bytes, recipe.path);
    expect(result.ok, `desktop's reader must parse what Kotlin wrote: ${JSON.stringify(result)}`).toBe(true);
    if (!result.ok) return;

    // The comment MOVED off its original `addExact` location — search for it
    // by content instead of position, matching the original fixture's own
    // OTHER (untouched) comment count as a sanity floor.
    const moved = result.comments.find((c) => c.text === recipe.addText);
    expect(moved, 'the comment Kotlin added, replied to, resolved, then moved must still be found').toBeDefined();
    if (!moved) return;
    expect(moved.author).toBe('person:You'); // Word/Excel comments always attribute to a person; 'user' -> displayName 'You' (§4.2/DocCommentTypes)
    expect(moved.resolved).toBe(true);
    expect(moved.replies).toHaveLength(1);
    expect(moved.replies[0].text).toBe(recipe.replyText);
    expect(moved.replies[0].author).toBe('person:Assistant'); // 'assistant' -> displayName 'Assistant'
    expect(moved.selector.kind).toBe('text');
    if (moved.selector.kind === 'text') {
      expect(moved.selector.selector.exact).toBe(recipe.newExact);
    }

    // The comment must no longer be anchored at its ORIGINAL location.
    const stillAtOriginal = result.comments.some(
      (c) => c.selector.kind === 'text' && c.selector.selector.exact === recipe.addExact && c.text === recipe.addText
    );
    expect(stillAtOriginal, 'the OLD location must have no comment left after the move').toBe(false);

    // launch-brief.docx's own pre-existing comments (unrelated to this
    // sequence) are untouched — the desktop reader still finds them.
    const original = await readDocxComments(await readFile(join(__dirname, 'fixtures', 'doc-comments', 'launch-brief.docx')), recipe.path);
    expect(original.ok).toBe(true);
    if (original.ok) {
      expect(result.comments.length).toBe(original.comments.length + 1);
    }
  });

  // Edit/delete build (2026-09-28, design doc §"Edit and delete") — this
  // task's own T21 parity extension, previously "not extended in this pass".
  // Kotlin edited w-0's text and deleted w-1's WHOLE thread (root + its one
  // reply, w-1-r1) against a fresh copy of the SAME real launch-brief.docx
  // fixture desktop's own writer uses.
  it('the edit -> delete sequence Kotlin wrote reads back correctly through the real desktop reader', async () => {
    const recipe = JSON.parse(await readFile(join(KOTLIN_GOLDEN_DIR, 'docx-edit-delete.json'), 'utf8'));
    const bytes = await readFile(join(KOTLIN_GOLDEN_DIR, 'docx-edit-delete.docx'));
    const result = await readDocxComments(bytes, recipe.path);
    expect(result.ok, `desktop's reader must parse what Kotlin wrote: ${JSON.stringify(result)}`).toBe(true);
    if (!result.ok) return;

    const edited = result.comments.find((c) => c.id === recipe.editId);
    expect(edited, 'the comment Kotlin edited must still be found').toBeDefined();
    expect(edited?.text).toBe(recipe.editText);

    const deleted = result.comments.find((c) => c.id === recipe.deletedId);
    expect(deleted, 'the thread Kotlin deleted must be completely gone').toBeUndefined();
    // The deleted thread's own reply must be gone too — proof a Kotlin
    // delete removes every reply chained to the root, not just the root's
    // own document.xml anchor.
    const danglingReply = result.comments.some((c) => c.replies.some((r) => r.id === recipe.deletedReplyId));
    expect(danglingReply, "the deleted thread's reply must not survive anywhere").toBe(false);

    // launch-brief.docx's own pre-existing comment count minus the one whole
    // thread Kotlin deleted.
    const original = await readDocxComments(await readFile(join(__dirname, 'fixtures', 'doc-comments', 'launch-brief.docx')), recipe.path);
    expect(original.ok).toBe(true);
    if (original.ok) {
      expect(result.comments.length).toBe(original.comments.length - 1);
    }
  });
});

describe('doc-comments — desktop reads a Kotlin-WRITTEN xlsx (the reverse direction)', () => {
  it('the add -> reply -> resolve -> move sequence Kotlin wrote reads back correctly through the real desktop reader', async () => {
    const recipe = JSON.parse(await readFile(join(KOTLIN_GOLDEN_DIR, 'xlsx-add-reply-resolve-move.json'), 'utf8'));
    const bytes = await readFile(join(KOTLIN_GOLDEN_DIR, 'xlsx-add-reply-resolve-move.xlsx'));
    const result = await readXlsxComments(bytes, recipe.path);
    expect(result.ok, `desktop's reader must parse what Kotlin wrote: ${JSON.stringify(result)}`).toBe(true);
    if (!result.ok) return;

    const moved = result.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === recipe.newCell);
    expect(moved, 'the comment Kotlin added, replied to, resolved, then moved must be at its new cell').toBeDefined();
    if (!moved) return;
    expect(moved.text).toBe(recipe.addText);
    expect(moved.author).toBe('person:You'); // Word/Excel comments always attribute to a person; 'user' -> displayName 'You' (§4.2/DocCommentTypes)
    expect(moved.resolved).toBe(true);
    expect(moved.replies).toHaveLength(1);
    expect(moved.replies[0].text).toBe(recipe.replyText);
    expect(moved.replies[0].author).toBe('person:Assistant'); // 'assistant' -> displayName 'Assistant'

    const stillAtOriginal = result.comments.some((c) => c.selector.kind === 'cell' && c.selector.selector.cell === recipe.addCell);
    expect(stillAtOriginal, 'the OLD cell must have no thread left after the move').toBe(false);

    // docling's own real pre-existing F7/G12 threads are untouched.
    const original = await readXlsxComments(
      await readFile(join(__dirname, '..', '..', 'shared-fixtures', 'doc-comments', 'xlsx-threaded-reference', 'docling-xlsx-comments.xlsx')),
      recipe.path
    );
    expect(original.ok).toBe(true);
    if (original.ok) {
      expect(result.comments.length).toBe(original.comments.length + 1);
    }
  });

  // Edit/delete build (2026-09-28, design doc §"Edit and delete") — this
  // task's own T21 parity extension, previously "not extended in this pass".
  // Kotlin edited G12's (root-only) text and deleted F7's WHOLE thread (root
  // + its one reply) against a fresh copy of the SAME real docling fixture
  // desktop's own writer uses.
  it('the edit -> delete sequence Kotlin wrote reads back correctly through the real desktop reader', async () => {
    const recipe = JSON.parse(await readFile(join(KOTLIN_GOLDEN_DIR, 'xlsx-edit-delete.json'), 'utf8'));
    const bytes = await readFile(join(KOTLIN_GOLDEN_DIR, 'xlsx-edit-delete.xlsx'));
    const result = await readXlsxComments(bytes, recipe.path);
    expect(result.ok, `desktop's reader must parse what Kotlin wrote: ${JSON.stringify(result)}`).toBe(true);
    if (!result.ok) return;

    const edited = result.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === recipe.editCell);
    expect(edited, 'the thread Kotlin edited must still be found').toBeDefined();
    expect(edited?.text).toBe(recipe.editText);

    const deleted = result.comments.some((c) => c.selector.kind === 'cell' && c.selector.selector.cell === recipe.deletedCell);
    expect(deleted, 'the thread Kotlin deleted must be completely gone').toBe(false);

    // docling's own pre-existing thread count minus the one whole thread
    // Kotlin deleted.
    const original = await readXlsxComments(
      await readFile(join(__dirname, '..', '..', 'shared-fixtures', 'doc-comments', 'xlsx-threaded-reference', 'docling-xlsx-comments.xlsx')),
      recipe.path
    );
    expect(original.ok).toBe(true);
    if (original.ok) {
      expect(result.comments.length).toBe(original.comments.length - 1);
    }
  });
});
