# Reverse-direction WRITE parity goldens (T21 §9.3 "the same in reverse")

Every OTHER cross-platform WRITE golden in this build goes one direction only — desktop
writes, Android reads (`desktop/tests/fixtures/doc-comments/write-golden/`, consumed by
`DocxCommentsCrossPlatformParityTest.kt`/`XlsxCommentsCrossPlatformParityTest.kt`). This
directory closes the other direction: a snapshot of ONE JVM run each, produced by a
disposable, JUnit-test-shaped generator (run by hand, then deleted — see each `.json`
recipe's own field names and `docs/active/specs/2026-09-26-doc-comments-build-design.md`
§9.3), proving desktop's REAL readers (`docx-comments.ts`/`xlsx-comments.ts`) can parse what
Kotlin wrote.

Consumer: `desktop/tests/doc-comments-kotlin-write-golden.test.ts`.

## Files

- `docx-add-reply-resolve-move.{docx,json}` — Kotlin applied add → reply → resolve → move to
  `launch-brief.docx`.
- `xlsx-add-reply-resolve-move.{xlsx,json}` — same sequence against
  `docling-xlsx-comments.xlsx`.
- `docx-edit-delete.{docx,json}` (2026-09-28, design doc §"Edit and delete") — Kotlin edited
  `launch-brief.docx`'s real `w-0` comment's text and deleted `w-1`'s WHOLE thread (root + its
  one reply, `w-1-r1`), in the same fixture, so one golden proves both ops in reverse.
- `xlsx-edit-delete.{xlsx,json}` (2026-09-28) — same shape against
  `docling-xlsx-comments.xlsx`: edited `G12`'s (root-only) text, deleted `F7`'s WHOLE thread
  (root + its one reply).

## Regenerating

Write a disposable JUnit-test-shaped Kotlin class under
`app/src/test/kotlin/com/youcoded/app/doccomments/`, gated on `System.getenv("GENERATE_GOLDEN")
== "1"` so it never runs in CI, that applies the desired operation(s) with the real Kotlin
writer against a copy of the named test-resource fixture and writes the result directly into
this directory. Run it via `JAVA_HOME=<a JDK 21> ANDROID_HOME=$HOME/.android-sdk ./gradlew
:app:testDebugUnitTest --tests "com.youcoded.app.doccomments.<YourGeneratorClass>" -x
bundleWebUi` with `GENERATE_GOLDEN=1`, then **delete the generator file** — it is scaffolding,
never committed (the same convention `desktop/tests/fixtures/doc-comments/generate-*-write-
golden.mjs`'s own header comments describe for the TS side, adapted here because Kotlin has no
lightweight script runner).
