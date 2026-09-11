// desktop/tests/main-read-path-no-sync-fs.test.ts
//
// WHY: source-scanning guard for Task 2 (perf/main-thread-async-reads) — the
// user-action READ paths converted off fs.*Sync so a slow disk can no longer
// freeze Electron's main thread (and with it, the whole app UI):
//   - marketplace-file-reader.ts: opening a skill/command/agent file in the
//     in-app marketplace viewer.
//   - theme-preview-generator.ts (buildPreviewHTML): regenerating a theme's
//     preview image after editing its wallpaper/pattern.
//   - transcript-cwd.ts: resolving which project a transcript belongs to —
//     called once per project slug on every Resume Browser open.
//   - session-browser.ts's listing path: the Resume Browser's slug→path
//     resolution chain and the store-overlay loop that runs on every open.
//
// This guard is scoped to exactly those files/slices, not the whole src/main
// tree — Task 1's hot-path guard (main-hot-path-no-sync-fs.test.ts) covers a
// different set of files on a different branch, and each branch must be able
// to merge independently without depending on the other's guard file.
//
// Uses the shared stripComments/readStripped from tests/helpers/guard-scope.ts
// rather than a fourth copy of comment-stripping logic (see that file's own
// WHY) — a guard reading raw text would fail on the WHY comments these very
// migrations leave behind, which quote the old fs.*Sync call they replaced.
import { describe, it, expect } from 'vitest';
import path from 'path';
import { readStripped } from './helpers/guard-scope';

const MAIN_DIR = path.join(__dirname, '..', 'src', 'main');
const SYNC_FS = /\bfs\.\w+Sync\s*\(/;

function read(relPath: string): string {
  return readStripped(path.join(MAIN_DIR, relPath));
}

/** Extracts the text between two markers (inclusive of neither), so a slice
 *  assertion fails loudly — not silently on an empty string — if either
 *  marker's name drifts out from under this guard. */
function slice(src: string, fromMarker: string, toMarker: string): string {
  const start = src.indexOf(fromMarker);
  const end = src.indexOf(toMarker, start + 1);
  expect(start, `marker not found: ${JSON.stringify(fromMarker)}`).toBeGreaterThan(-1);
  expect(end, `marker not found after start: ${JSON.stringify(toMarker)}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('Task 2 read paths carry no fs.*Sync', () => {
  it('marketplace-file-reader (whole file)', () => {
    expect(read('marketplace-file-reader.ts')).not.toMatch(SYNC_FS);
  });

  it('theme-preview-generator buildPreviewHTML', () => {
    const body = slice(
      read('theme-preview-generator.ts'),
      'async function buildPreviewHTML',
      'function escapeHtml',
    );
    expect(body).not.toMatch(SYNC_FS);
  });

  it('transcript-cwd (whole file)', () => {
    expect(read('transcript-cwd.ts')).not.toMatch(SYNC_FS);
  });

  it('session-browser listing path (readIndexMeta through the end of listPastSessions)', () => {
    // One contiguous slice covers readIndexMeta, resolveSlugToPath,
    // walkSlugParts, forwardResolveSlug, walkForward, readTopic,
    // readSessionTranscriptMeta, and listPastSessions itself — including the
    // store-overlay loop's four fs.existsSync-turned-exists() calls — because
    // all of them sit contiguously between readIndexMeta and loadHistory in
    // file order. Scope per controller decision 4 (task-2-brief.md).
    const body = slice(
      read('session-browser.ts'),
      'function readIndexMeta',
      'export async function loadHistory',
    );
    expect(body).not.toMatch(SYNC_FS);
  });
});
