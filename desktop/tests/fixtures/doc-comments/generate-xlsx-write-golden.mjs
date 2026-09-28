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
