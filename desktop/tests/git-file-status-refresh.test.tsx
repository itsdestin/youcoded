// @vitest-environment jsdom
// Pins what makes the git footer cheap: ONE git:file-status answer costs three
// git subprocesses in main (status, diff --numstat, rev-list — git-service.ts),
// and the hook used to re-ask on EVERY artifacts:changed for the project. While
// Claude edits a project that is a burst of unrelated files, each one spawning
// three processes for a footer line about a different file.
//
// Pinned here:
//   1. a change to ANOTHER file does not re-ask
//   2. a change to THIS file does, matched by relative path or by sidecar id
//      (the watcher reports tracked files by id and discovered ones by path)
//   3. git:changed still re-asks unconditionally — a commit or checkout
//      anywhere changes the branch and staged state this footer shows
//   4. bursts are debounced into one answer
//   5. git:changed is answered IMMEDIATELY, not debounced — GitReviewView reads
//      the same event with no delay and sits directly above this footer
//   6. an ignore-rule file is never "another file" — it decides whether THIS
//      file is untracked, which the footer's counts branch on
//   7. switching files drops a pending refresh for the file that just closed
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { useGitFileStatus } from '../src/renderer/hooks/useGitFileStatus';

const fileStatus = vi.fn();
let artifactListeners: ((evt: any) => void)[] = [];
let gitListeners: (() => void)[] = [];

const ROOT = '/proj';
const OPEN_REL = 'docs/open.md';
const OPEN_ID = 'art_open';

function Probe({ relPath = OPEN_REL, artifactId = OPEN_ID }: { relPath?: string; artifactId?: string | null }) {
  const status = useGitFileStatus(ROOT, relPath, true, artifactId);
  return <div data-testid="branch">{status?.branch ?? '-'}</div>;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  artifactListeners = [];
  gitListeners = [];
  fileStatus.mockResolvedValue({ ok: true, isRepo: true, branch: 'main', counts: null, hasHistory: true, staged: false, conflicted: false });
  (window as any).claude = {
    git: {
      fileStatus,
      watch: () => Promise.resolve({ ok: true }),
      unwatch: () => Promise.resolve({ ok: true }),
      onChanged: (fn: () => void) => { gitListeners.push(fn); return () => {}; },
    },
    artifacts: {
      onChanged: (fn: (evt: any) => void) => { artifactListeners.push(fn); return () => {}; },
    },
  };
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

const emitArtifact = (evt: any) => artifactListeners.forEach((fn) => fn(evt));
const settleDebounce = async () => { await vi.advanceTimersByTimeAsync(400); };

describe('useGitFileStatus refresh filter', () => {
  it('answers once on mount', async () => {
    render(<Probe />);
    await waitFor(() => expect(fileStatus).toHaveBeenCalledTimes(1));
  });

  it('ignores a change to a DIFFERENT file', async () => {
    render(<Probe />);
    await waitFor(() => expect(fileStatus).toHaveBeenCalledTimes(1));
    emitArtifact({ projectRoot: ROOT, artifactId: 'docs/other.md', kind: 'edit', by: 'external' });
    emitArtifact({ projectRoot: ROOT, artifactId: 'art_somethingelse', kind: 'edit', by: 'agent' });
    await settleDebounce();
    expect(fileStatus).toHaveBeenCalledTimes(1);
  });

  it('re-asks for THIS file, by path or by sidecar id', async () => {
    render(<Probe />);
    await waitFor(() => expect(fileStatus).toHaveBeenCalledTimes(1));
    emitArtifact({ projectRoot: ROOT, artifactId: OPEN_REL, kind: 'edit', by: 'external' });
    await settleDebounce();
    expect(fileStatus).toHaveBeenCalledTimes(2);
    emitArtifact({ projectRoot: ROOT, artifactId: OPEN_ID, kind: 'edit', by: 'agent' });
    await settleDebounce();
    expect(fileStatus).toHaveBeenCalledTimes(3);
  });

  it('re-asks when the broadcaster could not name a file', async () => {
    // A null id means "something changed, we cannot say what" — showing a stale
    // footer is worse than one extra read.
    render(<Probe />);
    await waitFor(() => expect(fileStatus).toHaveBeenCalledTimes(1));
    emitArtifact({ projectRoot: ROOT, artifactId: null, kind: 'exclude', by: 'user' });
    await settleDebounce();
    expect(fileStatus).toHaveBeenCalledTimes(2);
  });

  it('ignores another project entirely', async () => {
    render(<Probe />);
    await waitFor(() => expect(fileStatus).toHaveBeenCalledTimes(1));
    emitArtifact({ projectRoot: '/other-proj', artifactId: OPEN_REL, kind: 'edit', by: 'external' });
    await settleDebounce();
    expect(fileStatus).toHaveBeenCalledTimes(1);
  });

  it('still re-asks on any git:changed — branch and staged state are repo-wide', async () => {
    render(<Probe />);
    await waitFor(() => expect(fileStatus).toHaveBeenCalledTimes(1));
    gitListeners.forEach((fn) => fn());
    await settleDebounce();
    expect(fileStatus).toHaveBeenCalledTimes(2);
  });

  it('answers a git:changed IMMEDIATELY — no debounce', async () => {
    // Stage/Unstage/Commit/Discard broadcast git:changed synchronously, and
    // GitReviewView — directly above this footer — re-reads it with no delay.
    // Delaying only the footer shows two contradictory git states in one panel
    // on the very click the user is watching. Asserted with NO timer advance:
    // the listener must call through on the spot.
    render(<Probe />);
    await waitFor(() => expect(fileStatus).toHaveBeenCalledTimes(1));
    gitListeners.forEach((fn) => fn());
    expect(fileStatus).toHaveBeenCalledTimes(2);
  });

  it('re-asks when an IGNORE-RULE file changes, though it is another file', async () => {
    // .gitignore decides whether the open file is untracked at all, and
    // gitFileStatus branches on that (worktree add-counts vs diff --numstat).
    // Filtered out, the footer keeps counts for a file git no longer tracks.
    render(<Probe />);
    await waitFor(() => expect(fileStatus).toHaveBeenCalledTimes(1));
    emitArtifact({ projectRoot: ROOT, artifactId: '.gitignore', kind: 'edit', by: 'agent' });
    await settleDebounce();
    expect(fileStatus).toHaveBeenCalledTimes(2);
    emitArtifact({ projectRoot: ROOT, artifactId: 'sub/dir/.gitattributes', kind: 'edit', by: 'external' });
    await settleDebounce();
    expect(fileStatus).toHaveBeenCalledTimes(3);
  });

  it('drops a pending refresh when the user switches files', async () => {
    // The debounce timer belongs to the effect run that created it. If it were
    // not cleared, a burst on the OLD file would land ~300ms after the switch
    // and answer for a path that is no longer on screen.
    const { rerender } = render(<Probe />);
    await waitFor(() => expect(fileStatus).toHaveBeenCalledTimes(1));
    emitArtifact({ projectRoot: ROOT, artifactId: OPEN_REL, kind: 'edit', by: 'external' });
    rerender(<Probe relPath="docs/second.md" artifactId="art_second" />);
    await waitFor(() => expect(fileStatus).toHaveBeenCalledTimes(2));
    await settleDebounce();
    // Exactly the mount read for the new file — the old file's pending refresh
    // never fired.
    expect(fileStatus).toHaveBeenCalledTimes(2);
    expect(fileStatus).toHaveBeenLastCalledWith(ROOT, 'docs/second.md');
  });

  it('collapses a burst of this file\'s own changes into ONE answer', async () => {
    // A save emits several events in quick succession; three git processes per
    // event is the cost being removed.
    render(<Probe />);
    await waitFor(() => expect(fileStatus).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 8; i++) emitArtifact({ projectRoot: ROOT, artifactId: OPEN_REL, kind: 'edit', by: 'external' });
    await settleDebounce();
    expect(fileStatus).toHaveBeenCalledTimes(2);
  });
});
