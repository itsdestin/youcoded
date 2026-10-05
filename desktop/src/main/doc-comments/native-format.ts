// Extension-based "does this path's comments live inside the file itself"
// decision — split out of doc-comments-dispatch.ts (T3 follow-up, design
// docs/active/specs/2026-09-26-doc-comments-build-design.md §1.5's new
// per-document watcher) so `doc-comments-store.ts` can reuse the EXACT same
// function `doc-comments-dispatch.ts`'s LIST/ADD/etc. already use, without
// doc-comments-store.ts importing doc-comments-dispatch.ts — that would be a
// circular import, since doc-comments-dispatch.ts already imports
// `resolveSourceFilePath`/`Refusal` FROM doc-comments-store.ts. `doc-comments-
// dispatch.ts` re-exports `nativeFormatFor` from here so every existing
// caller (`ipc-handlers.ts`, `remote-server.ts`) keeps importing it from the
// same place, unchanged.
import path from 'path';

export type NativeFormat = 'docx' | 'xlsx';

/**
 * T8 review F4: Windows' own filesystem API strips trailing '.'/' ' characters
 * off a path component when it resolves one — `report.docx.` and
 * `report.docx ` on disk both open as `report.docx` there (the same
 * normalization `fs.realpath` eventually inherits on that platform). A naive
 * `path.extname` knows nothing about this, so a caller naming
 * `report.docx.`/`report.docx ` on a real Windows machine would see this
 * function say "not native" while the OS itself opens the real Word/Excel
 * file underneath — a data-integrity gap.
 *
 * Gated to `process.platform === 'win32'` because a trailing dot/space is
 * NOT insignificant on POSIX — `report.docx.` and `report.docx` are two
 * genuinely different files there, and stripping unconditionally would be
 * the over-matching bug in the opposite direction (a plain-text file that
 * happens to end in a dot getting treated as a Word file). Matches
 * guards.ts's `canonicalize` own `process.platform === 'win32'` gate for the
 * same class of platform-specific normalization.
 */
function stripWindowsTrailingDotsAndSpaces(filePath: string): string {
  return process.platform === 'win32' ? filePath.replace(/[. ]+$/, '') : filePath;
}

/** Extension-based dispatch decision — the ONE place that decides "does this
 *  path have its comments inside the file itself." `doc-comments-tools.ts`'s
 *  `permissionSubject` (the ask decision), its `execute()` (the actual write
 *  dispatch), and `doc-comments-store.ts`'s `resolveWatchTarget` (the T3
 *  follow-up per-document watcher, §1.5) all call this SAME function on the
 *  SAME string, so none of them can ever disagree about a given path. */
export function nativeFormatFor(filePath: string): NativeFormat | null {
  const ext = path.extname(stripWindowsTrailingDotsAndSpaces(filePath)).toLowerCase();
  if (ext === '.docx') return 'docx';
  if (ext === '.xlsx') return 'xlsx';
  return null;
}
