// F5 (implementation review of T16/T18, docs/active/specs/2026-09-26-doc-
// comments-build-design.md §3.2a/§4.3a/T21): a drift guard for the fixtures
// DocxCommentsTest.kt/XlsxCommentsTest.kt's own golden-parity tests depend on.
//
// WHY this lives here, on the desktop side: T16/T18's own header comments
// (DocxComments.kt, XlsxComments.kt) already explain that every `.docx`/
// `.xlsx` fixture and golden `.json` under `app/src/test/resources/
// doc-comments/` is "the SAME file... copied verbatim from desktop/tests/
// fixtures/doc-comments/" specifically so a fixture drift can never silently
// make the cross-platform parity claim compare two different inputs. That
// claim has never actually been CHECKED by a test before this one — nothing
// re-reads both copies and confirms they still match after later edits on
// either side. A Node process and a JVM process never run inside the same
// test/CI job (doc-comments-json-sidecar-fixture-parity.test.ts's own header
// makes the identical observation for the simpler JSON-sidecar case), so this
// runs on whichever side CAN see both trees at once — a plain Node/vitest
// test reading two directories on disk needs no JVM at all, unlike the
// reverse.
//
// This is a real regression this exact shape has already almost caused: F2's
// own review added `chartsheet-workbook.xlsx` + its golden JSON to BOTH
// trees by hand (no automated copy step) — precisely the kind of edit this
// guard exists to catch if a future one only touches one side.
import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';

const DESKTOP_DIR = join(__dirname, 'fixtures', 'doc-comments');
const ANDROID_DIR = join(__dirname, '..', '..', 'app', 'src', 'test', 'resources', 'doc-comments');

async function listFilesRecursive(root: string, base = ''): Promise<string[]> {
  const entries = await readdir(join(root, base), { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(root, rel)));
    } else {
      out.push(rel);
    }
  }
  return out;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('doc-comments — Android fixture drift guard', () => {
  it('every fixture/golden file the two trees share is byte-for-byte identical', async () => {
    const desktopFiles = new Set(await listFilesRecursive(DESKTOP_DIR));
    const androidFiles = new Set(await listFilesRecursive(ANDROID_DIR));
    const shared = [...desktopFiles].filter((f) => androidFiles.has(f)).sort();

    // A guard you did not break is a guard you did not test: if a rename on
    // either side ever made `shared` empty (or suspiciously small), the loop
    // below would trivially pass having checked nothing. Both trees today
    // share the five docx fixtures + their golden JSON, the two xlsx
    // fixtures + their golden JSON, and the json-sidecar fixture — at least
    // a dozen files — so a count under 10 means the PATHS above drifted, not
    // that everything is fine.
    expect(shared.length).toBeGreaterThanOrEqual(10);

    const mismatches: string[] = [];
    for (const rel of shared) {
      const [desktopBuf, androidBuf] = await Promise.all([
        readFile(join(DESKTOP_DIR, rel)),
        readFile(join(ANDROID_DIR, rel)),
      ]);
      if (sha256(desktopBuf) !== sha256(androidBuf)) mismatches.push(rel);
    }
    expect(mismatches).toEqual([]);
  });
});
