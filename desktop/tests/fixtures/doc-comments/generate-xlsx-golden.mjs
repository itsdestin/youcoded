// Golden-fixture generator for T18/T21 of the doc-comments build
// (docs/active/specs/2026-09-26-doc-comments-build-design.md §4.3a, T18,
// T21) — the xlsx sibling of `generate-docx-golden.mjs` (see that file's own
// header for the full "why run the real TS reader instead of hand-
// transcribing expected JSON" reasoning and the vite `ssrLoadModule`
// mechanism; identical here).
//
// Reads `tests/fixtures/doc-comments/q3-sales-by-rep.xlsx` (T12's own real
// fixture — eight notes across two sheets, `make-xlsx-fixture.mjs`) with the
// REAL desktop `readXlsxComments`, and dumps its actual output as JSON. The
// Kotlin test (`app/src/test/kotlin/com/youcoded/app/doccomments/
// XlsxCommentsTest.kt`) reads this same JSON and asserts field-for-field
// equality against its own parse of the SAME fixture (`createdAt` excluded
// from the comparison on both sides — see that test's own header for why: it
// is a fresh `Date.now()`/`System.currentTimeMillis()` stamped at READ time,
// not a value either reader can reproduce byte-for-byte across two separate
// processes run at two different moments).
//
// Usage: `node desktop/tests/fixtures/doc-comments/generate-xlsx-golden.mjs`
import { createServer } from 'vite';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = join(FIXTURES_DIR, '..', '..', '..'); // desktop/tests/fixtures/doc-comments -> desktop/
const GOLDEN_DIR = join(FIXTURES_DIR, 'golden');

const FIXTURE = { file: 'q3-sales-by-rep.xlsx', path: 'reports/q3-sales-by-rep.xlsx' };

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
    const bytes = await readFile(join(FIXTURES_DIR, FIXTURE.file));
    const result = await mod.readXlsxComments(bytes, FIXTURE.path);
    if (!result.ok) {
      throw new Error(`readXlsxComments failed for ${FIXTURE.file}: ${result.error}`);
    }
    const outPath = join(GOLDEN_DIR, FIXTURE.file.replace(/\.xlsx$/, '.json'));
    // `createdAt` is a fresh wall-clock stamp on every read (§4.1: exceljs's
    // legacy Note carries no timestamp of its own) — zeroed out here so the
    // committed golden file never shows a stale "when this script last ran"
    // value as if it were meaningful. The Kotlin test ignores this field on
    // comparison rather than relying on this placeholder matching anything.
    const scrubbed = result.comments.map((c) => ({
      ...c,
      createdAt: 0,
      replies: c.replies.map((r) => ({ ...r, createdAt: 0 })),
    }));
    await writeFile(outPath, `${JSON.stringify({ comments: scrubbed }, null, 2)}\n`);
    console.log(`wrote ${outPath} (${result.comments.length} comment(s))`);
  } finally {
    await server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
