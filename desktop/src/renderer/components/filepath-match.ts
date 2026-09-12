// Pure matching + artifactify-args logic for FilepathToken (the inline chat
// pill). Extracted so the resolution rules — which drive EVERY pill click —
// are unit-testable without mounting React.
import { canonicalize } from '../../shared/artifacts/canonicalize';
import type { ArtifactRecord } from '../../shared/artifacts/types';

/** An artifact's comparable path: relative for internal, absolute for external. */
function artifactPath(a: ArtifactRecord): string {
  const p = (a.kind === 'internal' ? a.path : a.absolutePath) ?? '';
  return p.replace(/\\/g, '/').toLowerCase();
}

/** POSIX `/…` or a Windows drive path `x:/…` (already slash-normalised). */
function isAbsoluteClick(normalised: string): boolean {
  return normalised.startsWith('/') || /^[a-z]:\//.test(normalised);
}

/**
 * Find the best artifact match for a clicked path.
 *
 * EXACT matches always beat suffix matches — previously both were OR'd in one
 * predicate, so a suffix match earlier in the array (any same-named file
 * anywhere in the project) could shadow an exact match later in the array.
 * The suffix pass stays because Claude often references a file relative to a
 * subdirectory (`desktop/src/x.ts`) while the artifact is stored relative to
 * the project root (`youcoded/desktop/src/x.ts`). Comparison is
 * case-insensitive (Windows paths are, and this only picks a match priority).
 */
export function findBestMatch(
  list: ArtifactRecord[],
  clickedPath: string,
  cwd?: string
): ArtifactRecord | undefined {
  const norm = clickedPath.replace(/\\/g, '/').toLowerCase();
  // WHY (wrong-file bug, 2026-09-11): tapping
  // /home/destin/youcoded-dev/wecoded-themes/CLAUDE.md opened the workspace
  // ROOT CLAUDE.md — the suffix pass below saw `.../CLAUDE.md` end with the
  // root record's `CLAUDE.md`. An ABSOLUTE path names one place, so when we
  // know the session's folder we can turn every record into its full absolute
  // form and demand an exact match: a same-named file elsewhere is simply not
  // the file that was tapped. Relative clicks keep the suffix pass, because
  // "desktop/src/x.ts" really is ambiguous about where it starts.
  if (cwd) {
    const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const absOf = (a: ArtifactRecord): string => {
      const p = artifactPath(a);
      if (!p) return '';
      return a.kind === 'internal' ? `${root}/${p}` : p;
    };
    if (isAbsoluteClick(norm)) return list.find((a) => absOf(a) === norm);
    // Relative and `~/` clicks (review 2026-09-11, finding 2): the old suffix
    // pass let "wecoded-themes/CLAUDE.md" and "~/youcoded-dev/wecoded-themes/
    // CLAUDE.md" select the ROOT CLAUDE.md, because the clicked text ended with
    // that record's short path. Compare against each record's FULL path
    // instead, in one direction only — the record's full path must end with
    // what was clicked — so "desktop/src/x.ts" still finds
    // youcoded/desktop/src/x.ts, but a same-named file in another folder never
    // matches. A relative click tries folder + path exactly first; a `~` click
    // has no folder to anchor to (the renderer can't expand it).
    const tail = norm.replace(/^~\//, '').replace(/^\.\//, '');
    if (!tail || tail === '~') return undefined;
    if (!norm.startsWith('~')) {
      const exact = list.find((a) => absOf(a) === `${root}/${tail}`);
      if (exact) return exact;
    }
    return list.find((a) => {
      const abs = absOf(a);
      return abs !== '' && abs.endsWith(`/${tail}`);
    });
  }
  return (
    list.find((a) => artifactPath(a) === norm) ??
    list.find((a) => {
      const p = artifactPath(a);
      return p.length > 0 && (norm.endsWith('/' + p) || p.endsWith('/' + norm));
    })
  );
}

export interface ArtifactifyArgs {
  path: string;
  kind: 'internal' | 'external';
  absolutePath: string | null;
  type: 'read';
  author: 'user';
}

/** Suffix-tolerant lookup of a tool's absolute file path in a session's artifact
 *  list. Moved from ToolBody (2026-08-25) so the SendUserFile card and the
 *  Write/Edit/Read preview card share ONE matcher. Internal records compare by
 *  relative path (suffix of the absolute), externals by absolutePath. */
export function matchSessionArtifact(arts: ArtifactRecord[], absPath: string): ArtifactRecord | undefined {
  if (!absPath) return undefined;
  const norm = absPath.replace(/\\/g, '/');
  return arts.find((a) => {
    const aPath = (a.kind === 'internal' ? a.path : a.absolutePath) ?? '';
    const an = aPath.replace(/\\/g, '/');
    return an === norm || norm.endsWith('/' + an) || an.endsWith('/' + norm);
  });
}

/**
 * Build the appendVersion args for "artifactifying" a clicked path that isn't
 * tracked or discovered anywhere (e.g. a file Claude created via a Bash/python
 * script, or one in a temp dir outside the project). Mirrors the internal-vs-
 * external logic the App.tsx artifact tracker uses for tool-use events: a path
 * under cwd is internal (relative path); anything else is external (basename +
 * absolute path).
 *
 * Uses the shared canonicalize() so `..` segments resolve and drive-letter
 * case can't misclassify — the previous inline version resolved `../x` to a
 * literal `cwd/../x` and then classified it INTERNAL because the string still
 * started with cwd.
 *
 * Returns null for `~/` paths: the renderer can't expand the home directory,
 * and persisting a literal `~` would bake a wrong absolute path into the
 * sidecar. (Suffix matching in findBestMatch still resolves most `~` clicks
 * against already-tracked files before this is ever reached.)
 */
export function buildArtifactifyArgs(clickedPath: string, cwd: string): ArtifactifyArgs | null {
  const norm = clickedPath.replace(/\\/g, '/');
  if (norm.startsWith('~')) return null;
  const isAbs = /^[a-zA-Z]:\//.test(norm) || norm.startsWith('/');
  const cwdFwd = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const abs = isAbs ? norm : `${cwdFwd}/${norm}`;
  const canonAbs = canonicalize(abs, null); // resolves . and .., lowercases drive
  const canonRoot = canonicalize(cwdFwd, null);
  if (canonAbs === canonRoot || canonAbs.startsWith(canonRoot + '/')) {
    return {
      path: canonAbs === canonRoot ? '' : canonAbs.slice(canonRoot.length + 1),
      kind: 'internal',
      absolutePath: null,
      type: 'read',
      author: 'user',
    };
  }
  const basename = canonAbs.split('/').pop() || canonAbs;
  return { path: basename, kind: 'external', absolutePath: canonAbs, type: 'read', author: 'user' };
}
