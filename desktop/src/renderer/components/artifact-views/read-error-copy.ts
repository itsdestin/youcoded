// The words for a file-read refusal code, in one place.
//
// WHY its own module (2026-09-11): two surfaces word the same refusals — the
// file pane (useArtifactContent) and a file path tapped in chat that could not
// open (useOpenFilepath). One sentence per code keeps them from telling the
// person two different things about the same file. Moved verbatim from
// useArtifactContent.ts; unknown codes still surface as the host sent them
// rather than being replaced with a guessed cause (error-message-standards).
function describeFsCode(code: unknown): string {
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  if (code === 'ELOOP') return 'too many symbolic links in its path';
  // Anything else is shown as the platform reported it — never re-worded into a guess.
  return typeof code === 'string' && code ? code : 'no detail was given';
}

export function describeReadError(error: unknown, code?: unknown): string {
  if (error === 'protected-path') {
    return 'YouCoded won’t open this file because it’s in a protected location (like saved passwords, keys or settings folders).';
  }
  // A file the assistant wrote through `../` that lands outside every project
  // folder (read-service.ts, judgeRelativeRecord). The file IS there — saying
  // "missing" would be false. Deliberately names no location and promises no
  // fix: the answer also reaches remote browsers, and only a folder strictly
  // inside the home folder can ever vouch for such a file (review 2026-09-23).
  if (error === 'outside-projects') {
    return 'YouCoded won’t open this file because it’s outside your project folders.';
  }
  // The check itself failed. Only the filesystem's own error is reported.
  if (error === 'record-unreadable') {
    return `YouCoded couldn’t check this file (${describeFsCode(code)}).`;
  }
  if (error === 'artifact-not-found') {
    return 'This file could not be resolved inside the project.';
  }
  return `Couldn’t read this file: ${String(error ?? 'unknown error')}`;
}
