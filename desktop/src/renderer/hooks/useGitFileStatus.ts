// Footer data for the git surface. Fetches git:file-status for the open file
// and refreshes on BOTH change feeds: artifacts:changed (worktree edits, from
// the chokidar watcher) and git:changed (commits/checkouts/staging, from the
// .git watcher — the chokidar one ignores .git/ by design).
// On Android/remote every call rejects (unsupported) and the hook settles to
// null — the footer then renders exactly as it does today. Same graceful
// degradation as content search (FilesTab).
import { useEffect, useState } from 'react';
import type { GitFileStatusResult } from '../../shared/git-types';

// One git:file-status answer costs THREE git subprocesses in main (status,
// diff --numstat, rev-list — git-service.ts). artifacts:changed arrives in
// bursts: an agent editing a file emits one per write, and without a debounce
// each event in the burst spawned three processes for a footer line nobody
// could read mid-burst. 300ms is comfortably longer than a burst's inter-event
// gap and short enough that the footer still reads as live after a save.
//
// git:changed is deliberately NOT debounced here — see the subscribe below.
const REFRESH_DEBOUNCE_MS = 300;

// Ignore-rule files decide whether ANY given file is untracked, and
// gitFileStatus branches on exactly that (git-service.ts: `entry?.untracked`
// picks worktree add-counts over `diff --numstat`). So an edit to one of these
// is never "a change to another file", and the per-file filter below must let
// it through or the open file keeps a badge that no longer matches git.
// Known limit: the event carries only an artifact id, which is a sidecar id for
// a TRACKED file and a relative path otherwise. This matches the path form —
// the case that actually occurs, since .gitignore is rarely a tracked artifact.
const IGNORE_RULE_FILE = /(^|[/\\])\.git(ignore|attributes)$/;

export function useGitFileStatus(
  projectRoot: string,
  relPath: string | null,
  enabled: boolean,
  // Sidecar id of the open file, when it has one. The watcher reports a TRACKED
  // file by its sidecar id and a merely-discovered one by its relative path, so
  // matching needs both — see the filter below.
  artifactId?: string | null,
): GitFileStatusResult | null {
  const [status, setStatus] = useState<GitFileStatusResult | null>(null);

  useEffect(() => {
    setStatus(null);
    if (!enabled || !relPath || !projectRoot) return;
    const api = (window as any).claude?.git;
    if (!api?.fileStatus) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const refresh = () => {
      api.fileStatus(projectRoot, relPath)
        .then((r: GitFileStatusResult) => { if (alive) setStatus(r?.ok ? r : null); })
        .catch(() => { if (alive) setStatus(null); });
    };
    const refreshSoon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; refresh(); }, REFRESH_DEBOUNCE_MS);
    };
    refresh();   // the first answer is immediate; only the re-reads are debounced
    api.watch?.(projectRoot)?.catch?.(() => {});
    // git:changed stays UNFILTERED and UNDEBOUNCED. Unfiltered: a commit,
    // checkout or branch switch anywhere in the repo changes the branch name and
    // the staged/history state this footer shows, even when the open file was
    // not the file committed. Undebounced: both producers already coalesce it —
    // git-watcher.ts debounces its fs events 300ms, and the Stage/Unstage/
    // Commit/Discard handlers broadcast exactly once per action — so a debounce
    // here buys nothing and costs correctness. GitReviewView refreshes off the
    // same event with no delay, and it sits directly above this footer: delaying
    // only one of them shows two contradictory git states in one panel for a
    // third of a second, on the very click the user is watching.
    const offGit = api.onChanged?.(() => refresh()) ?? (() => {});
    const offArtifacts = (window as any).claude?.artifacts?.onChanged?.((evt: any) => {
      if (evt?.projectRoot !== projectRoot) return;
      // A worktree edit to ANOTHER file cannot change this file's status — its
      // +/- counts, staged flag and history are all per-path. Before this filter
      // every file Claude touched anywhere in the project re-ran three git
      // processes for the one file on screen.
      // A null id means the broadcaster could not name a file — the exclude
      // handler and Android's append-version both send one on every agent write;
      // refresh rather than risk showing a stale footer.
      const id = evt?.artifactId;
      if (id != null && !IGNORE_RULE_FILE.test(id) && id !== relPath && id !== artifactId) return;
      refreshSoon();
    }) ?? (() => {});

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      offGit();
      offArtifacts();
      api.unwatch?.(projectRoot)?.catch?.(() => {});
    };
  }, [projectRoot, relPath, enabled, artifactId]);

  return status;
}
