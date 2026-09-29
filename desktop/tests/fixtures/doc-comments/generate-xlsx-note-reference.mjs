#!/usr/bin/env node
// T18's own spike — generates the checked-in reference for what exceljs
// writes for a legacy cell Note, using the CURRENT desktop `xlsx-comments.ts`
// write path (docs/active/specs/2026-09-26-doc-comments-build-design.md
// §4.3a, §8 T18): "a short spike (part of T18, not a separate task) writes a
// note with the CURRENT desktop `xlsx-comments.ts`/exceljs against a fixture
// workbook, unzips the result, and captures the literal
// comments<N>.xml/vmlDrawing<N>.vml/relationship/content-types shape exceljs
// actually produces as a checked-in reference
// (`shared-fixtures/doc-comments/xlsx-note-reference/`)."
//
// This writes THROUGH `addXlsxComment` (not raw exceljs) precisely so the
// note BODY text reflects this app's own "Name: text" convention — a Kotlin
// writer (T19) targets "produce OOXML matching this reference's shape for a
// new note," which includes the wiring exceljs's `cell.note` setter
// generates AROUND that body, not just the body text alone.
//
// Same vite `ssrLoadModule` mechanism as `generate-docx-golden.mjs` (see that
// file's own header for why: no `tsx`/`ts-node` dependency exists in this
// repo, and adding one would need a real `npm install` this task doesn't
// warrant — `vite` is already a direct devDependency).
//
// Run by hand only, from anywhere (paths resolve off this file's own
// location) — this is NOT part of `npm test`/CI. The drift SELF-check that
// runs on every test invocation is `desktop/tests/xlsx-note-reference-drift.
// test.ts`, which re-captures the SAME shape and diffs it against whatever
// this script last wrote, so an exceljs bump that changes the OOXML shape
// fails loudly at test time (review 2, F17) instead of only being noticed by
// re-running this script by hand.
//
// Usage: `node desktop/tests/fixtures/doc-comments/generate-xlsx-note-reference.mjs`
import { createServer } from 'vite';
import { writeFile, mkdir, readFile, mkdtemp, rm } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import ExcelJS from 'exceljs';
import { captureXlsxNoteParts, buildBlankSingleCellWorkbook } from './xlsx-note-parts.mjs';

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = join(FIXTURES_DIR, '..', '..', '..'); // desktop/tests/fixtures/doc-comments -> desktop/
const REPO_ROOT = join(DESKTOP_ROOT, '..'); // desktop/ -> youcoded/
const REFERENCE_DIR = join(REPO_ROOT, 'shared-fixtures', 'doc-comments', 'xlsx-note-reference');

async function main() {
  const server = await createServer({ configFile: false, root: DESKTOP_ROOT, ssr: {}, logLevel: 'error' });
  try {
    const mod = await server.ssrLoadModule('/src/main/doc-comments/xlsx-comments.ts');
    const dir = await mkdtemp(join(tmpdir(), 'ycd-xlsx-note-ref-'));
    try {
      const target = join(dir, 'blank.xlsx');
      const wb = await buildBlankSingleCellWorkbook(ExcelJS);
      await wb.xlsx.writeFile(target);

      const result = await mod.addXlsxComment({
        absolutePath: target,
        path: 'reports/blank.xlsx',
        selector: { kind: 'cell', selector: { type: 'CellSelector', cell: 'A1' } },
        text: 'A brand new note.',
        author: 'user',
      });
      if (!result.ok) throw new Error(`addXlsxComment failed: ${result.error}`);

      const bytes = await readFile(target);
      const { rawParts, manifest } = await captureXlsxNoteParts(bytes);

      await mkdir(REFERENCE_DIR, { recursive: true });
      for (const [name, content] of Object.entries(rawParts)) {
        await writeFile(join(REFERENCE_DIR, name), content);
      }
      await writeFile(join(REFERENCE_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      // The actual .xlsx too, so a human (or T19) can open it directly rather
      // than only reading the extracted XML fragments.
      await writeFile(join(REFERENCE_DIR, 'single-note.xlsx'), bytes);

      console.log(`wrote ${REFERENCE_DIR}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    await server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
