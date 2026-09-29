// Cross-platform WRITE parity golden generator for T21 of the doc-comments
// build (docs/active/specs/2026-09-26-doc-comments-build-design.md §4.3,
// §4.3a, §8 T21, §9.3). Xlsx sibling of `generate-docx-write-golden.mjs` (see
// that file's own header for the full "why run the real TS writer instead of
// hand-transcribing expected output" reasoning, and its "WHY NOT literal
// id/date injection" note — identical logic applies here: `addXlsxComment`'s
// new thread id is deterministic from the ORIGINAL file's own content
// (`xt-{sheetId}-{cell}-{GUID}`, minted fresh, but the GUID itself IS
// randomly generated per write — see below for how this script and the
// Kotlin parity test both handle that one genuinely non-deterministic value).
//
// Unlike docx's one-case-per-operation shape, this generator's `elden-
// sequence` case chains add → reply → resolve → reopen → move on ONE working
// copy — the literal shape design review 1/3 (F11/F2) describes ("desktop
// writes a docx/xlsx add+reply+resolve+move sequence") — because xlsx's own
// highest-risk property (§4.2's multi-thread-per-cell finding, and a
// cross-SHEET move) is best proven by one thread's full lifecycle crossing
// from a sheet with NO prior comment parts (`Sorceries & Incantations List`,
// confirmed comment-free in shared-fixtures/doc-comments/xlsx-threaded-
// reference/manifest.json) to a sheet that already has some (`Remembrance
// List`), exercising both "create the part from scratch" and "surgically add
// to an existing part" in a single, realistic lifecycle.
//
// `resolve-b19-sibling` covers the OTHER named highest-risk shape (§9.3): a
// resolve on ONE of the real elden B19 cell's five independent, pre-existing
// threads must never disturb the other four — the one case a single-thread
// sequence starting from a brand-new cell could never exercise.
//
// `add-docling`/`move-docling` give the same per-operation breadth against
// the OTHER real fixture (genuinely Excel-365-authored, not Google Sheets),
// mirroring docx's own "prove it against more than one real file" shape.
//
// WHY the new thread's own GUID is NOT compared for exact equality (unlike
// docx's deterministic `w:id`): `mutateAddXlsxComment` mints a fresh random
// GUID for a brand-new thread (§4.2's `guidFormat`), so two INDEPENDENT
// writers (desktop now, Kotlin later) applied to the same input never
// produce the same GUID — this is expected and does not indicate drift. The
// Kotlin parity test therefore compares everything BUT the newly-minted
// thread's own `id`/GUID (cell/sheet, text, author, resolved, replies,
// history) for an `add`-originated thread, while an operation against a
// PRE-EXISTING thread (`resolve-b19-sibling`, and `reply-docling`/`move-
// docling` which target docling's real F7 thread) compares the real id
// exactly, since that id was never re-minted.
//
// Usage: `node desktop/tests/fixtures/doc-comments/generate-xlsx-write-golden.mjs`
// (run BY HAND when a fixture or the writer's own output shape changes,
// never as part of `npm test`/CI — same convention as
// generate-docx-write-golden.mjs).
//
// `edit-docling`/`edit-reply-docling`/`delete-reply-docling`/`delete-thread-
// docling`/`delete-last-comment-fresh` (2026-09-28, design doc §"Edit and
// delete") extend this same golden set to the edit/delete ops, added for
// this task's own T21 parity extension — previously "not extended in this
// pass" per that section's own closing note. `delete-last-comment-fresh`
// runs against `fresh-single-comment.xlsx` (a brand-new, comment-free
// workbook) specifically to prove `cleanupEmptyCommentPartsIfNeeded` removes
// every comment part/rel/content-type override/`<legacyDrawing>` when a
// sheet's LAST comment is deleted — the other four docling fixtures always
// leave at least one sibling thread behind, so none of them can exercise
// that cleanup path.
import { createServer } from 'vite';
import { readFile, writeFile, mkdir, copyFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = join(FIXTURES_DIR, '..', '..', '..'); // desktop/tests/fixtures/doc-comments -> desktop/
const GOLDEN_DIR = join(FIXTURES_DIR, 'write-golden');
const THREADED_REF_DIR = join(FIXTURES_DIR, '..', '..', '..', '..', 'shared-fixtures', 'doc-comments', 'xlsx-threaded-reference');

function cellSelector(cell, sheet) {
  return { kind: 'cell', selector: { type: 'CellSelector', cell, ...(sheet ? { sheet } : {}) } };
}

async function main() {
  const server = await createServer({ configFile: false, root: DESKTOP_ROOT, ssr: {}, logLevel: 'error' });
  try {
    const mod = await server.ssrLoadModule('/src/main/doc-comments/xlsx-comments.ts');
    await mkdir(GOLDEN_DIR, { recursive: true });

    // ── add-docling: a brand-new thread on the real Excel-authored file ────
    {
      const name = 'add-docling';
      const fixture = 'docling-xlsx-comments.xlsx';
      const path = 'reports/docling-xlsx-comments.xlsx';
      const outPath = join(GOLDEN_DIR, `${name}.tmp.xlsx`);
      await writeFile(outPath, await readFile(join(THREADED_REF_DIR, fixture)));
      const result = await mod.addXlsxComment({
        absolutePath: outPath,
        path,
        selector: cellSelector('C1'),
        text: 'Which release of docling generated this?',
        author: 'user',
      });
      if (!result.ok) throw new Error(`${name}: desktop writer failed: ${JSON.stringify(result)}`);
      await finish(name, fixture, path, [{ op: 'add', args: { cell: 'C1', text: 'Which release of docling generated this?', author: 'user' }, result }], outPath);
    }

    // ── move-docling: relocate the real, pre-existing F7 thread ────────────
    {
      const name = 'move-docling';
      const fixture = 'docling-xlsx-comments.xlsx';
      const path = 'reports/docling-xlsx-comments.xlsx';
      const outPath = join(GOLDEN_DIR, `${name}.tmp.xlsx`);
      const bytes = await readFile(join(THREADED_REF_DIR, fixture));
      await writeFile(outPath, bytes);
      const before = await mod.readXlsxComments(bytes, path);
      if (!before.ok) throw new Error(`${name}: could not re-read original fixture`);
      const f7 = before.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'F7');
      if (!f7) throw new Error(`${name}: F7 thread not found in original fixture`);
      const result = await mod.moveXlsxComment({ absolutePath: outPath, path, id: f7.id, newSelector: cellSelector('H20') });
      if (!result.ok) throw new Error(`${name}: desktop writer failed: ${JSON.stringify(result)}`);
      await finish(name, fixture, path, [{ op: 'move', args: { id: f7.id, newCell: 'H20' }, result }], outPath);
    }

    // ── resolve-b19-sibling: resolve ONE of elden's real 5 independent
    // threads on B19, leaving the other four untouched — §4.2/§9.3's own
    // named highest-risk shape for this format. Deterministic target
    // selection (lexicographically-lowest id among the five) so both this
    // generator and the Kotlin parity test pick the SAME thread without
    // needing to agree on read order. ──
    {
      const name = 'resolve-b19-sibling';
      const fixture = 'elden-ring-completionist-checklist.xlsx';
      const path = 'reports/elden-ring-completionist-checklist.xlsx';
      const outPath = join(GOLDEN_DIR, `${name}.tmp.xlsx`);
      const bytes = await readFile(join(THREADED_REF_DIR, fixture));
      await writeFile(outPath, bytes);
      const before = await mod.readXlsxComments(bytes, path);
      if (!before.ok) throw new Error(`${name}: could not re-read original fixture`);
      const atB19 = before.comments
        .filter((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'B19')
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (atB19.length !== 5) throw new Error(`${name}: expected 5 threads on B19, found ${atB19.length}`);
      const target = atB19[0];
      const result = await mod.resolveXlsxComment({ absolutePath: outPath, path, id: target.id });
      if (!result.ok) throw new Error(`${name}: desktop writer failed: ${JSON.stringify(result)}`);
      await finish(name, fixture, path, [{ op: 'resolve', args: { id: target.id }, result }], outPath);
    }

    // ── elden-sequence: add (on a sheet with NO prior comment parts) →
    // reply → resolve → reopen → move CROSS-SHEET (onto a sheet that
    // already has other threads) — the "sequence" T21's own design review
    // wording names, and the strongest single proof this design has that
    // every op agrees cross-platform against real-Excel-scale part counts. ──
    {
      const name = 'elden-sequence';
      const fixture = 'elden-ring-completionist-checklist.xlsx';
      const path = 'reports/elden-ring-completionist-checklist.xlsx';
      const outPath = join(GOLDEN_DIR, `${name}.tmp.xlsx`);
      await writeFile(outPath, await readFile(join(THREADED_REF_DIR, fixture)));

      const steps = [];

      const addArgs = { cell: 'ZZ999', sheet: 'Sorceries & Incantations List', text: 'T21 golden-fixture parity check — does this round-trip identically on both platforms?', author: 'user' };
      const addResult = await mod.addXlsxComment({ absolutePath: outPath, path, selector: cellSelector(addArgs.cell, addArgs.sheet), text: addArgs.text, author: addArgs.author });
      if (!addResult.ok) throw new Error(`${name}: add failed: ${JSON.stringify(addResult)}`);
      steps.push({ op: 'add', args: addArgs, result: addResult });
      const newId = addResult.id;

      const replyArgs = { id: newId, text: 'Confirmed on desktop — checking Android next.', author: 'assistant' };
      const replyResult = await mod.replyToXlsxComment({ absolutePath: outPath, path, id: replyArgs.id, text: replyArgs.text, author: replyArgs.author });
      if (!replyResult.ok) throw new Error(`${name}: reply failed: ${JSON.stringify(replyResult)}`);
      steps.push({ op: 'reply', args: replyArgs, result: replyResult });

      const resolveResult = await mod.resolveXlsxComment({ absolutePath: outPath, path, id: newId });
      if (!resolveResult.ok) throw new Error(`${name}: resolve failed: ${JSON.stringify(resolveResult)}`);
      steps.push({ op: 'resolve', args: { id: newId }, result: resolveResult });

      const reopenResult = await mod.reopenXlsxComment({ absolutePath: outPath, path, id: newId });
      if (!reopenResult.ok) throw new Error(`${name}: reopen failed: ${JSON.stringify(reopenResult)}`);
      steps.push({ op: 'reopen', args: { id: newId }, result: reopenResult });

      // Cross-sheet: `Remembrance List` already has its OWN threaded-comment
      // parts (unlike `Sorceries & Incantations List`, which had none before
      // the `add` above) — the move must surgically add into an EXISTING
      // part on the destination while removing from the freshly-created part
      // on the source.
      const moveArgs = { id: newId, newCell: 'ZZ998', newSheet: 'Remembrance List' };
      const moveResult = await mod.moveXlsxComment({ absolutePath: outPath, path, id: newId, newSelector: cellSelector(moveArgs.newCell, moveArgs.newSheet) });
      if (!moveResult.ok) throw new Error(`${name}: move failed: ${JSON.stringify(moveResult)}`);
      steps.push({ op: 'move', args: moveArgs, result: moveResult });

      await finish(name, fixture, path, steps, outPath);
    }

    // ── Edit/delete build (2026-09-28, design doc §"Edit and delete"), added
    // for this task's own T21 parity extension. Reuses docling's real F7
    // (root + one reply) and G12 (root only) threads — the same two threads
    // xlsx-comments.test.ts's own edit/delete suite already exercises. ──────

    // edit-docling: overwrite G12's (root-only) text.
    {
      const name = 'edit-docling';
      const fixture = 'docling-xlsx-comments.xlsx';
      const path = 'reports/docling-xlsx-comments.xlsx';
      const outPath = join(GOLDEN_DIR, `${name}.tmp.xlsx`);
      const bytes = await readFile(join(THREADED_REF_DIR, fixture));
      await writeFile(outPath, bytes);
      const before = await mod.readXlsxComments(bytes, path);
      if (!before.ok) throw new Error(`${name}: could not re-read original fixture`);
      const g12 = before.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'G12');
      if (!g12) throw new Error(`${name}: G12 thread not found`);
      const newText = 'Edited: confirmed against the vendor spec sheet.';
      const result = await mod.editXlsxComment({ absolutePath: outPath, path, id: g12.id, text: newText });
      if (!result.ok) throw new Error(`${name}: desktop writer failed: ${JSON.stringify(result)}`);
      await finish(name, fixture, path, [{ op: 'edit', args: { id: g12.id, text: newText }, result }], outPath);
    }

    // edit-reply-docling: overwrite F7's one reply.
    {
      const name = 'edit-reply-docling';
      const fixture = 'docling-xlsx-comments.xlsx';
      const path = 'reports/docling-xlsx-comments.xlsx';
      const outPath = join(GOLDEN_DIR, `${name}.tmp.xlsx`);
      const bytes = await readFile(join(THREADED_REF_DIR, fixture));
      await writeFile(outPath, bytes);
      const before = await mod.readXlsxComments(bytes, path);
      if (!before.ok) throw new Error(`${name}: could not re-read original fixture`);
      const f7 = before.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'F7');
      if (!f7) throw new Error(`${name}: F7 thread not found`);
      const reply = f7.replies[0];
      if (!reply) throw new Error(`${name}: F7 has no reply to edit`);
      const newText = 'Edited: it dropped further after the audit, actually.';
      const result = await mod.editXlsxReply({ absolutePath: outPath, path, id: f7.id, replyId: reply.id, text: newText });
      if (!result.ok) throw new Error(`${name}: desktop writer failed: ${JSON.stringify(result)}`);
      await finish(name, fixture, path, [{ op: 'edit-reply', args: { id: f7.id, replyId: reply.id, text: newText }, result }], outPath);
    }

    // delete-reply-docling: remove F7's one reply, root survives.
    {
      const name = 'delete-reply-docling';
      const fixture = 'docling-xlsx-comments.xlsx';
      const path = 'reports/docling-xlsx-comments.xlsx';
      const outPath = join(GOLDEN_DIR, `${name}.tmp.xlsx`);
      const bytes = await readFile(join(THREADED_REF_DIR, fixture));
      await writeFile(outPath, bytes);
      const before = await mod.readXlsxComments(bytes, path);
      if (!before.ok) throw new Error(`${name}: could not re-read original fixture`);
      const f7 = before.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'F7');
      if (!f7) throw new Error(`${name}: F7 thread not found`);
      const reply = f7.replies[0];
      if (!reply) throw new Error(`${name}: F7 has no reply to delete`);
      const result = await mod.deleteXlsxReply({ absolutePath: outPath, path, id: f7.id, replyId: reply.id });
      if (!result.ok) throw new Error(`${name}: desktop writer failed: ${JSON.stringify(result)}`);
      await finish(name, fixture, path, [{ op: 'delete-reply', args: { id: f7.id, replyId: reply.id }, result }], outPath);
    }

    // delete-thread-docling: remove F7's WHOLE thread (root + reply); G12's
    // independent thread on the same sheet survives untouched.
    {
      const name = 'delete-thread-docling';
      const fixture = 'docling-xlsx-comments.xlsx';
      const path = 'reports/docling-xlsx-comments.xlsx';
      const outPath = join(GOLDEN_DIR, `${name}.tmp.xlsx`);
      const bytes = await readFile(join(THREADED_REF_DIR, fixture));
      await writeFile(outPath, bytes);
      const before = await mod.readXlsxComments(bytes, path);
      if (!before.ok) throw new Error(`${name}: could not re-read original fixture`);
      const f7 = before.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'F7');
      if (!f7) throw new Error(`${name}: F7 thread not found`);
      const result = await mod.deleteXlsxComment({ absolutePath: outPath, path, id: f7.id });
      if (!result.ok) throw new Error(`${name}: desktop writer failed: ${JSON.stringify(result)}`);
      await finish(name, fixture, path, [{ op: 'delete', args: { id: f7.id }, result }], outPath);
    }

    // delete-last-comment-fresh: add the ONLY comment to a brand-new,
    // comment-free workbook (`fresh-single-comment.xlsx`, built the same way
    // xlsx-comments.test.ts's own `writeMinimalXlsxTo` does, via exceljs),
    // then delete it — proves ALL comment parts/rels/content-type overrides/
    // <legacyDrawing> are removed, leaving the workbook exactly as if it
    // never had comments (§"Edit and delete", `cleanupEmptyCommentPartsIfNeeded`).
    {
      const name = 'delete-last-comment-fresh';
      const fixture = 'fresh-single-comment.xlsx';
      const path = 'fresh-single-comment.xlsx';
      const outPath = join(GOLDEN_DIR, `${name}.tmp.xlsx`);
      await writeFile(outPath, await readFile(join(FIXTURES_DIR, fixture)));

      const addArgs = { cell: 'A1', text: 'only comment', author: 'user' };
      const addResult = await mod.addXlsxComment({ absolutePath: outPath, path, selector: cellSelector(addArgs.cell), text: addArgs.text, author: addArgs.author });
      if (!addResult.ok) throw new Error(`${name}: add failed: ${JSON.stringify(addResult)}`);
      const newId = addResult.id;

      const deleteResult = await mod.deleteXlsxComment({ absolutePath: outPath, path, id: newId });
      if (!deleteResult.ok) throw new Error(`${name}: delete failed: ${JSON.stringify(deleteResult)}`);

      await finish(
        name,
        fixture,
        path,
        [
          { op: 'add', args: addArgs, result: addResult },
          { op: 'delete', args: { id: newId }, result: deleteResult },
        ],
        outPath
      );
    }
  } finally {
    await server.close();
  }
}

async function finish(name, fixture, path, steps, outPath) {
  const finalXlsxPath = join(GOLDEN_DIR, `${name}.xlsx`);
  await copyFile(outPath, finalXlsxPath);
  await writeFile(join(GOLDEN_DIR, `${name}.json`), JSON.stringify({ fixture, path, steps }, null, 2) + '\n');
  console.log(`wrote ${finalXlsxPath} (${steps.length} step(s): ${steps.map((s) => s.op).join(' -> ')})`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
