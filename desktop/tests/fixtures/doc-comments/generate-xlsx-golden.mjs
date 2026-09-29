// Golden-fixture generator for T18/T21 of the doc-comments build
// (docs/active/specs/2026-09-26-doc-comments-build-design.md §4.3a, T18,
// T21) — the xlsx sibling of `generate-docx-golden.mjs` (see that file's own
// header for the full "why run the real TS reader instead of hand-
// transcribing expected JSON" reasoning and the vite `ssrLoadModule`
// mechanism; identical here).
//
// Reads each fixture below with the REAL desktop `readXlsxComments`, and
// dumps its actual output as JSON. The Kotlin test (`app/src/test/kotlin/
// com/youcoded/app/doccomments/XlsxCommentsTest.kt`) reads these same JSON
// files and asserts field-for-field equality against its own parse of the
// SAME fixtures (`createdAt` excluded from the comparison on both sides —
// see that test's own header for why: it is a fresh `Date.now()`/`System.
// currentTimeMillis()` stamped at READ time, not a value either reader can
// reproduce byte-for-byte across two separate processes run at two different
// moments).
//
// `chartsheet-workbook.xlsx` (F2, implementation review — parity): one real
// worksheet plus one chartsheet, `make-xlsx-chartsheet-fixture.mjs`. Its
// golden output pins that a chartsheet must never make a workbook look
// multi-sheet — proof that desktop's own `singleSheet` calculation already
// excludes it (exceljs's `reconcile()` never surfaces a chartsheet as a
// worksheet at all), the same behaviour `XlsxComments.kt`'s own F2 fix now
// matches on Android.
//
// `docling-xlsx-comments.xlsx`/`elden-ring-completionist-checklist.xlsx`
// (T21, design review — this pair had NO shared golden before: T12's own
// desktop test and T18's own Kotlin test each independently hand-wrote their
// own expected values against the SAME two real files, which can agree by
// construction without either implementation's ACTUAL output ever being
// cross-checked against the other's. This is exactly the drift T21 exists to
// catch — see §9.3's own "two implementations can each pass their own suite
// while producing subtly incompatible output" warning. Golden output
// includes the elden fixture's real B19 cell (5 independent threads, none
// dropped or merged) since that is this pair's own highest-risk shape.
//
// Usage: `node desktop/tests/fixtures/doc-comments/generate-xlsx-golden.mjs`
import { createServer } from 'vite';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// WHY (2026-09-28 PR review): a threaded comment's `dT` has no time zone and
// the reader treats it as local time, so the goldens' `createdAt` values
// depend on the zone this runs in. Pinned to the zone the committed goldens
// were made in; XlsxCommentsTest.kt pins the same zone (GOLDEN_TIME_ZONE).
// Node re-reads TZ on every Date operation, so setting it here takes effect.
process.env.TZ = 'America/Phoenix';

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = join(FIXTURES_DIR, '..', '..', '..'); // desktop/tests/fixtures/doc-comments -> desktop/
const GOLDEN_DIR = join(FIXTURES_DIR, 'golden');
// desktop/tests/fixtures/doc-comments -> desktop -> youcoded/ -> shared-fixtures/...
const THREADED_REF_DIR = join(FIXTURES_DIR, '..', '..', '..', '..', 'shared-fixtures', 'doc-comments', 'xlsx-threaded-reference');

const FIXTURES = [
  { file: 'q3-sales-by-rep.xlsx', path: 'reports/q3-sales-by-rep.xlsx' },
  { file: 'chartsheet-workbook.xlsx', path: 'reports/chartsheet-workbook.xlsx' },
  { file: 'docling-xlsx-comments.xlsx', path: 'reports/docling-xlsx-comments.xlsx', dir: THREADED_REF_DIR },
  { file: 'elden-ring-completionist-checklist.xlsx', path: 'reports/elden-ring-completionist-checklist.xlsx', dir: THREADED_REF_DIR },
];

async function main() {
  const server = await createServer({
    configFile: false,
    root: DESKTOP_ROOT,
    ssr: {},
    logLevel: 'error',
  });
  try {
    const mod = await server.ssrLoadModule('/src/main/doc-comments/xlsx-comments.ts');
    await mkdir(GOLDEN_DIR, { recursive: true });
    for (const { file, path, dir } of FIXTURES) {
      const bytes = await readFile(join(dir ?? FIXTURES_DIR, file));
      const result = await mod.readXlsxComments(bytes, path);
      if (!result.ok) {
        throw new Error(`readXlsxComments failed for ${file}: ${result.error}`);
      }
      const outPath = join(GOLDEN_DIR, file.replace(/\.xlsx$/, '.json'));
      // T21 correction: `createdAt` used to be zeroed here under the
      // (pre-2026-09-27-redesign) assumption that it was a fresh wall-clock
      // stamp with nothing meaningful to compare — true of the RETIRED
      // legacy-Notes reader, false of the current threaded-comments-only
      // reader: `createdAt` is `parseThreadedDate(dT)`, parsed straight out of
      // the file's own `dT` attribute (xlsx-comments.ts), so it is fully
      // DETERMINISTIC content, not a clock read — zeroing it would have hidden
      // a genuine cross-platform date-parsing disagreement instead of catching
      // one. `q3-sales-by-rep.xlsx`/`chartsheet-workbook.xlsx` are Notes-only
      // fixtures that now correctly read back as ZERO comments (§4.1), so this
      // change is a no-op for them either way.
      await writeFile(outPath, `${JSON.stringify({ comments: result.comments }, null, 2)}\n`);
      console.log(`wrote ${outPath} (${result.comments.length} comment(s))`);
    }
  } finally {
    await server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
