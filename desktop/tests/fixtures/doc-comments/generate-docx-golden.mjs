// Golden-fixture generator for T16/T21 of the doc-comments build
// (docs/active/specs/2026-09-26-doc-comments-build-design.md §3.2a, T16, T21).
//
// WHY this exists: T16 ports `readDocxComments` (desktop/src/main/doc-comments/
// docx-comments.ts) to Kotlin for Android. The design's own instruction is
// that Android must produce the SAME `PersistedComment[]` shape desktop does,
// proven against the SAME fixtures — not just "doesn't crash". Rather than
// hand-transcribing desktop's expected output into a second, independently-
// maintained fixture (the exact drift risk T21's own citation warns about:
// "a fixture drift here would silently make the parity test compare two
// different inputs"), this script runs the REAL desktop reader against each
// checked-in `.docx` fixture and dumps its actual output as JSON. The Kotlin
// test (`app/src/test/kotlin/com/youcoded/app/doccomments/DocxCommentsTest.kt`)
// reads these same JSON files and asserts field-for-field equality against
// its own parse of the same fixtures.
//
// HOW this runs TS with no new dependency: `desktop/package.json` sets
// `"type": "commonjs"`, so plain `node docx-comments.ts` can't load it (it
// uses ESM `import`/`export`) and there is no `tsx`/`ts-node` dependency in
// this repo to reach for instead (checked — `docs/PITFALLS.md` → Worktrees
// warns against a bare `npm install` inside a hardlinked worktree, which
// adding one would require). `vite` is already a direct devDependency (it
// builds the renderer) and exposes a programmatic `createServer().
// ssrLoadModule()` API that transpiles + executes a TS module the same way
// vitest's own `vite-node` runner already does for every `*.test.ts` file in
// this repo — this script is that same mechanism, just invoked directly
// instead of through the test runner, and only ever run BY HAND when a
// fixture or the reader's own output shape changes, never as part of `npm
// test`/CI (this file is deliberately named without `.test.`/`.spec.`, so
// vitest's own `include` glob in vitest.config.ts never picks it up).
//
// Usage: `node desktop/tests/fixtures/doc-comments/generate-docx-golden.mjs`
// (run from anywhere — paths below are resolved off this file's own location).
import { createServer } from 'vite';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = join(FIXTURES_DIR, '..', '..', '..'); // desktop/tests/fixtures/doc-comments -> desktop/
const GOLDEN_DIR = join(FIXTURES_DIR, 'golden');

// Every fixture T10/T16 read against, plus word365-realistic (T11's own
// richer fixture — rsids, commentsIds.xml/commentsExtensible.xml) for wider
// parity coverage. Path stamped onto each record matches what
// docx-comments.test.ts itself uses for the same fixture, so a human
// comparing the two test files sees the same inputs.
const FIXTURES = [
  { file: 'launch-brief.docx', path: 'docs/launch-brief.docx' },
  { file: 'no-comments.docx', path: 'docs/no-comments.docx' },
  { file: 'spanning-comment.docx', path: 'docs/spanning-comment.docx' },
  { file: 'deeply-nested.docx', path: 'docs/deeply-nested.docx' },
  { file: 'word365-realistic.docx', path: 'docs/word365-realistic.docx' },
];

async function main() {
  const server = await createServer({
    configFile: false,
    root: DESKTOP_ROOT,
    ssr: {},
    logLevel: 'error',
  });
  try {
    const mod = await server.ssrLoadModule('/src/main/doc-comments/docx-comments.ts');
    await mkdir(GOLDEN_DIR, { recursive: true });
    for (const { file, path } of FIXTURES) {
      const bytes = await readFile(join(FIXTURES_DIR, file));
      const result = await mod.readDocxComments(bytes, path);
      if (!result.ok) {
        throw new Error(`readDocxComments failed for ${file}: ${result.error}`);
      }
      const outPath = join(GOLDEN_DIR, file.replace(/\.docx$/, '.json'));
      // Stable 2-space JSON, trailing newline — diff-friendly in review.
      await writeFile(outPath, JSON.stringify({ comments: result.comments }, null, 2) + '\n');
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
