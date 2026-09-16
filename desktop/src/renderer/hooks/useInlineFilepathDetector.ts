// What counts as a file extension. This used to be a short WHITELIST of the
// types the artifact viewer could render, which meant a path Claude printed for
// an .mp3, .zip, .sh or .rs was not clickable AT ALL — the user had to copy it
// out by hand. Destin, 2026-09-05: recognise every file type and let the viewer
// be honest about the ones it can't show (BinaryFallback already says so and
// offers "Open externally"). A text-ish unknown type (.sh, .rs, .toml…) opens
// in the code viewer on its own — see RendererRegistry.getViewer's textHint.
//
// So the test is now the SHAPE of an extension rather than a list:
//   • 1–8 characters, letters and digits only
//   • at least one letter — otherwise "step 2/3.1" and "a ratio of 3/4.5"
//     would become files
//   • all-lowercase or all-uppercase — real extensions are written one way or
//     the other (mp3, README.MD), while an English word after a missing space
//     ("either/or.It's") is Capitalised, and that is the false positive that
//     an open-ended rule would otherwise put a clickable pill on.
const EXT_SHAPE_RE = /^[A-Za-z0-9]{1,8}$/;

function looksLikeExtension(ext: string): boolean {
  if (!EXT_SHAPE_RE.test(ext)) return false;
  if (!/[A-Za-z]/.test(ext)) return false;
  return ext === ext.toLowerCase() || ext === ext.toUpperCase();
}

// Matches:
//   /abs/path           absolute Unix
//   ~/path              tilde home
//   ./rel  ../rel       explicit-relative
//   C:\path  C:/path    Windows drive
//   dir/file.ext        bare relative (multi-segment with at least one separator)
// All followed by .ext where ext has the shape of an extension (above).
// The bare-relative case (last alternative) requires at least one directory
// segment + separator before the filename, so we don't false-match standalone
// filenames like "plan.md".
// The trailing lookahead also accepts sentence-final punctuation (./!/?) but
// ONLY when followed by whitespace or end-of-text — so "see /docs/plan.md."
// still pills, while `a/b.min.js` isn't cut short at `.min` (the `.` there is
// followed by a letter, not whitespace).
const PATH_RE = /(?:^|(?<=\s|[\(\[\{,'"\`>]))((?:[a-zA-Z]:[\\/]|~[\\/]|\.{1,2}[\\/]|\/|[\w\-.]+[\\/])[^\s\)\]\},'"\`<:;]*?\.([a-zA-Z0-9]+))(?=$|[\s\)\]\},'"\`<:;]|[.!?](?:\s|$))/g;

// Protocol-less domains ("see w3.org/intro.html") match the bare-relative
// alternative and would become dead pills. Reject when the FIRST segment looks
// like a hostname ending in a common TLD. Deliberately a short list — a dotted
// directory name like `docs.old/file.md` must keep working.
const DOMAIN_FIRST_SEGMENT_RE = /^(?:[\w-]+\.)+(?:com|org|net|io|dev|ai|co|app|edu|gov|me|us|uk)$/i;

export interface FilepathMatch {
  path: string;
  start: number;
  end: number;
}

export function detectFilepaths(text: string): FilepathMatch[] {
  const out: FilepathMatch[] = [];
  PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_RE.exec(text))) {
    if (!looksLikeExtension(m[2])) continue;
    const p = m[1];
    // Bare-relative candidates only: absolute/tilde/drive/dot-relative paths
    // can't be domains.
    if (/^[\w\-.]/.test(p) && !/^[a-zA-Z]:[\\/]/.test(p) && !p.startsWith('.')) {
      const firstSeg = p.split(/[\\/]/, 1)[0];
      if (DOMAIN_FIRST_SEGMENT_RE.test(firstSeg)) continue;
    }
    out.push({ path: p, start: m.index, end: m.index + m[0].length });
  }
  return out;
}
