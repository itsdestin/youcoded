// The words for a file-read refusal code, in one place.
//
// WHY its own module (2026-09-11): two surfaces word the same refusals — the
// file pane (useArtifactContent) and a file path tapped in chat that could not
// open (useOpenFilepath). One sentence per code keeps them from telling the
// person two different things about the same file. Moved verbatim from
// useArtifactContent.ts; unknown codes still surface as the host sent them
// rather than being replaced with a guessed cause (error-message-standards).
export function describeReadError(error: unknown): string {
  if (error === 'protected-path') {
    return 'YouCoded won’t open this file because it’s in a protected location (like saved passwords, keys or settings folders).';
  }
  // A file the assistant wrote through `../` that lands outside every project
  // folder (read-service.ts, judgeRelativeRecord). The file IS there — saying
  // "missing" would be false — and saving its folder as a project is exactly
  // what makes it open, so the sentence names that.
  if (error === 'outside-projects') {
    return 'YouCoded won’t open this file because it’s outside your project folders. To open it here, add its folder as a project, then Retry.';
  }
  if (error === 'artifact-not-found') {
    return 'This file could not be resolved inside the project.';
  }
  return `Couldn’t read this file: ${String(error ?? 'unknown error')}`;
}
