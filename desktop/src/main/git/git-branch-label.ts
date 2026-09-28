// The status bar's Git Branch label for a folder, read straight from `.git`.
//
// WHY this exists: the Git Branch chip's only feed was Claude Code's status
// line (hook-scripts/statusline.sh writes ~/.claude/.gitbranch-<id>), so a
// native session — which has no status line — showed nothing even inside a
// repo (Destin, 2026-08-25). buildStatusData asks this for native sessions.
//
// Same shape as the status line writes — "<repo folder>/<branch>", "HEAD" when
// detached (what `git rev-parse --abbrev-ref HEAD` prints) — so the chip reads
// the same in both kinds of session. Plain file reads, no git subprocess: it
// runs on every status push for every native session.
import fs from 'fs';
import path from 'path';

export async function gitBranchLabel(cwd: string): Promise<string | null> {
  if (!cwd) return null;
  try {
    if (!(await fs.promises.stat(cwd)).isDirectory()) return null;
  } catch {
    return null;
  }
  let dir = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    const st = await fs.promises.stat(dotGit).catch(() => null);
    if (st) {
      let gitDir = dotGit;
      if (st.isFile()) {
        // A worktree (or submodule): `.git` is a file naming the real git dir.
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(await fs.promises.readFile(dotGit, 'utf8').catch(() => ''));
        if (!m) return null;
        gitDir = path.resolve(dir, m[1]);
      }
      const head = await fs.promises.readFile(path.join(gitDir, 'HEAD'), 'utf8').catch(() => null);
      if (head === null) return null;
      const ref = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(head);
      return `${path.basename(dir)}/${ref ? ref[1] : 'HEAD'}`;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
