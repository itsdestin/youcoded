// git-guard.ts — refuse a repository the built-in git would misread.
//
// WHY (iPhone app, card #89): the built-in git (just-git) reads only the common index format (version 2) and does not
// understand a "split index". Given such a repository it does not fail: it silently writes a wrong commit (reproduced
// in testing). A repository made on a computer with newer git settings can be one of those, and it may sit in the
// Files app. So the repository is refused, in plain words, before git touches it.

/** The few file-system calls the guard needs (the shell's own file system has all of them). */
export interface GuardFs {
  resolvePath(base: string, path: string): string;
  exists(path: string): Promise<boolean>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  readdir(path: string): Promise<string[]>;
}

export const GIT_INDEX_REFUSAL =
  "git: this repository's index file is in a format the built-in git on this iPhone cannot read safely " +
  '(a version other than 2, or a split index). Nothing was changed.\n';

/** Looks where `git` would: the working folder, or the folder(s) named by leading `-C <dir>` options, then upward.
 *  Returns the refusal text, or null when git may go ahead. */
export async function gitIndexProblem(fs: GuardFs, cwd: string, args: string[]): Promise<string | null> {
  let start = cwd;
  // `git -C a -C b` means b relative to a; the guard must look in the same place git will.
  for (let i = 0; args[i] === '-C'; i += 2) start = fs.resolvePath(start, args[i + 1] ?? '.');
  for (let dir = start; ; dir = dir.slice(0, dir.lastIndexOf('/')) || '/') {
    const gitDir = `${dir === '/' ? '' : dir}/.git`;
    if (await fs.exists(`${gitDir}/index`)) {
      const head = await fs.readFileBuffer(`${gitDir}/index`);
      // 12-byte header: "DIRC", then the version as a big-endian number.
      const version = head.length >= 8 ? new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(4) : 0;
      const split = (await fs.readdir(gitDir)).some((n) => n.startsWith('sharedindex.'));
      return version !== 2 || split ? GIT_INDEX_REFUSAL : null;
    }
    if (dir === '/') return null;
  }
}
