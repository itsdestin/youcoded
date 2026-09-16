// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { GitReviewView } from './GitReviewView';
import type { GitFileReviewResult } from '../../../shared/git-types';

// Typed against the real IPC result shape (not inferred from the literal) so
// `Partial<typeof review>` allows `uncommitted: null` in the "clean file"
// test below — `uncommitted` is `GitUncommitted | null` on the real type,
// but a bare object-literal inference would narrow it to non-null only.
const review: GitFileReviewResult = {
  ok: true, isRepo: true, branch: 'master',
  uncommitted: {
    hunks: [{ oldStart: 142, oldLines: 1, newStart: 142, newLines: 2, lines: ['-old line', '+new line', '+added line'] }],
    counts: { added: 2, removed: 1 }, staged: false, untracked: false, inHead: true, binary: false, conflicted: false,
  },
  log: [
    // pathAtCommit deliberately differs from relPath ('src/f.ts') so the
    // "historical path, not current path" assertion below is meaningful.
    // counts differ (a real value vs null) so the header-counts test below
    // can assert both the "shows +/-" and "shows nothing" cases.
    { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 'fix: first', authorDate: '2026-07-22T10:00:00Z', pathAtCommit: 'old-name.ts', counts: { added: 3, removed: 1 } },
    { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', subject: 'feat: second', authorDate: '2026-07-21T10:00:00Z', pathAtCommit: 'src/f.ts', counts: null },
  ],
  hasMore: false, stagedCount: 0,
};

function mountWith(overrides: Partial<typeof review> = {}, props: Partial<React.ComponentProps<typeof GitReviewView>> = {}) {
  (window as any).claude = {
    git: {
      fileReview: vi.fn(async () => ({ ...review, ...overrides })),
      commitFileDiff: vi.fn(async () => ({ ok: true, hunks: [], binary: false })),
      stage: vi.fn(async () => ({ ok: true })),
      unstage: vi.fn(async () => ({ ok: true })),
      commit: vi.fn(async () => ({ ok: true })),
      onChanged: vi.fn(() => () => {}),
    },
  };
  render(
    <GitReviewView
      projectRoot="/proj" relPath="src/f.ts" fileName="f.ts"
      onBack={() => {}} onRequestDiscard={() => {}}
      {...props}
    />,
  );
  return (window as any).claude.git;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('GitReviewView', () => {
  it('renders sub-header title, branch chip, uncommitted card first and expanded', async () => {
    mountWith();
    await waitFor(() => expect(screen.getByText('Uncommitted changes')).toBeInTheDocument());
    expect(screen.getByText(/Reviewing changes for/)).toBeInTheDocument();
    expect(screen.getByText('master')).toBeInTheDocument();
    // expanded by default: its diff rows are visible
    expect(screen.getByText('-old line'.slice(1))).toBeInTheDocument(); // "old line" text cell
    // commit cards listed, collapsed
    expect(screen.getByText('fix: first')).toBeInTheDocument();
    expect(screen.getByText('feat: second')).toBeInTheDocument();
  });

  it('commit card header shows the same +/- counts as the uncommitted card; null counts show no count text', async () => {
    mountWith();
    // Scope to the specific commit card so the assertion isn't ambiguous
    // with the uncommitted card's own +2/−1 counts.
    const firstCard = (await waitFor(() => screen.getByText('fix: first'))).closest('button')!;
    expect(within(firstCard).getByText('+3')).toBeInTheDocument();
    expect(within(firstCard).getByText('−1')).toBeInTheDocument(); // U+2212 minus, same glyph as the uncommitted card
    // 'feat: second' has counts: null -> no +/- text for it at all
    const secondCard = screen.getByText('feat: second').closest('button')!;
    expect(within(secondCard).queryByText('+', { exact: false })).not.toBeInTheDocument();
  });

  it('the expanded diff sits in a height-capped scroll container, separate from the uncommitted card action row', async () => {
    mountWith();
    await waitFor(() => expect(screen.getByText('Uncommitted changes')).toBeInTheDocument());
    const diffText = screen.getByText('old line');
    const scrollContainer = diffText.closest('.overflow-y-auto');
    expect(scrollContainer).not.toBeNull();
    expect(scrollContainer?.className).toContain('max-h-[45vh]');
    // The action row (staged checkbox) must NOT be inside that scroll cap.
    const actionRow = screen.getByText('Include in commit');
    expect(scrollContainer?.contains(actionRow)).toBe(false);
  });

  it('no uncommitted card when the file is clean', async () => {
    mountWith({ uncommitted: null });
    await waitFor(() => expect(screen.getByText('fix: first')).toBeInTheDocument());
    expect(screen.queryByText('Uncommitted changes')).not.toBeInTheDocument();
  });

  it('no composer block when the file is clean (uncommitted is null)', async () => {
    mountWith({ uncommitted: null });
    await waitFor(() => expect(screen.getByText('fix: first')).toBeInTheDocument());
    // Entire composer should be hidden: no message textarea, no commit button
    expect(screen.queryByPlaceholderText('Commit message')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Commit/ })).not.toBeInTheDocument();
  });

  it('expanding a commit card lazily fetches its diff using the HISTORICAL path, not the current path', async () => {
    const git = mountWith();
    await waitFor(() => screen.getByText('fix: first'));
    fireEvent.click(screen.getByText('fix: first'));
    await waitFor(() =>
      expect(git.commitFileDiff).toHaveBeenCalledWith('/proj', 'a'.repeat(40), 'old-name.ts', undefined));
  });

  it('renders "Moved from" copy instead of the generic empty state for a renamedFrom commit with no content changes', async () => {
    const git = mountWith({
      log: [
        {
          sha: 'c'.repeat(40), shortSha: 'ccccccc', subject: 'chore: move file',
          authorDate: '2026-07-20T10:00:00Z', pathAtCommit: 'src/f.ts', renamedFrom: 'old-name.ts',
          counts: { added: 0, removed: 0 },
        },
      ],
    });
    await waitFor(() => screen.getByText('chore: move file'));
    fireEvent.click(screen.getByText('chore: move file'));
    await waitFor(() =>
      expect(git.commitFileDiff).toHaveBeenCalledWith('/proj', 'c'.repeat(40), 'src/f.ts', 'old-name.ts'));
    await waitFor(() =>
      expect(screen.getByText('Moved from “old-name.ts” — no content changes in this commit.')).toBeInTheDocument());
    expect(screen.queryByText('No direct changes to this file in this commit.')).not.toBeInTheDocument();
  });

  it('Show more appears when hasMore and fetches the next page', async () => {
    const git = mountWith({ hasMore: true });
    await waitFor(() => screen.getByRole('button', { name: /Show more/ }));
    fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
    await waitFor(() =>
      expect(git.fileReview).toHaveBeenCalledWith('/proj', 'src/f.ts', { logSkip: 2 }));
  });

  it('composer: disabled until a message exists AND stagedCount > 0', async () => {
    mountWith({ stagedCount: 0 });
    await waitFor(() => screen.getByText('Uncommitted changes'));
    const btn = screen.getByRole('button', { name: /Commit/ }) as HTMLButtonElement;
    expect(btn).toBeDisabled(); // no staged files
    fireEvent.change(screen.getByPlaceholderText('Commit message'), { target: { value: 'msg' } });
    expect(btn).toBeDisabled(); // still no staged files
  });

  it('composer: commit fires git.commit with the message and clears it', async () => {
    const git = mountWith({ stagedCount: 2 });
    await waitFor(() => screen.getByText('Uncommitted changes'));
    const area = screen.getByPlaceholderText('Commit message');
    fireEvent.change(area, { target: { value: 'feat: from drawer' } });
    const btn = screen.getByRole('button', { name: 'Commit 2 staged files' });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    await waitFor(() => expect(git.commit).toHaveBeenCalledWith('/proj', 'feat: from drawer'));
    await waitFor(() => expect((area as HTMLTextAreaElement).value).toBe(''));
  });

  it('staged checkbox row stages/unstages the file', async () => {
    const git = mountWith();
    await waitFor(() => screen.getByText('Include in commit'));
    fireEvent.click(screen.getByText('Include in commit'));
    await waitFor(() => expect(git.stage).toHaveBeenCalledWith('/proj', 'src/f.ts'));
  });

  // Legible mirror (owner decision 2026-07-23): the checkbox used to hide
  // behind `!uncommitted.untracked`, so brand-new files had no way to be
  // included in a commit from this view at all. It must render for
  // untracked files too, and clicking it must still call git.stage — the
  // backend already handles staging an untracked file as a plain `git add`.
  it('shows the Include in commit checkbox for an untracked file and stages it on click', async () => {
    const git = mountWith({
      uncommitted: {
        hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+new file'] }],
        counts: { added: 1, removed: 0 }, staged: false, untracked: true, inHead: false, binary: false, conflicted: false,
      },
    });
    await waitFor(() => screen.getByText('Uncommitted changes'));
    const checkbox = screen.getByText('Include in commit');
    expect(checkbox).toBeInTheDocument();
    fireEvent.click(checkbox);
    await waitFor(() => expect(git.stage).toHaveBeenCalledWith('/proj', 'src/f.ts'));
  });

  // Composer empty-cart hint (owner decision 2026-07-23): nothing explains
  // WHY the commit button is disabled when the message field is empty of
  // staged files — the hint only needs to appear when nothing is staged.
  it('shows the empty-cart hint when stagedCount is 0 and hides it once something is staged', async () => {
    mountWith({ stagedCount: 0 });
    await waitFor(() => screen.getByText('Uncommitted changes'));
    expect(screen.getByText('Tick “Include in commit” on a change above to choose what gets committed.')).toBeInTheDocument();

    cleanup();
    mountWith({ stagedCount: 2 });
    await waitFor(() => screen.getByText('Uncommitted changes'));
    expect(screen.queryByText('Tick “Include in commit” on a change above to choose what gets committed.')).not.toBeInTheDocument();
  });

  // Revert-button rename (owner decision 2026-07-23): "Delete file…" read as
  // deleting the underlying file even though it only moves it to the OS
  // trash (or restores from HEAD) — same label for both tracked and
  // untracked files now, behavior (onRequestDiscard(!inHead)) unchanged.
  it('revert button reads "Revert Changes…" for a tracked file and calls onRequestDiscard(false)', async () => {
    const onRequestDiscard = vi.fn();
    mountWith({}, { onRequestDiscard });
    const btn = await waitFor(() => screen.getByRole('button', { name: 'Revert Changes…' }));
    fireEvent.click(btn);
    expect(onRequestDiscard).toHaveBeenCalledWith(false);
  });

  it('revert button also reads "Revert Changes…" for an untracked file and calls onRequestDiscard(true)', async () => {
    const onRequestDiscard = vi.fn();
    mountWith({
      uncommitted: {
        hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+new file'] }],
        counts: { added: 1, removed: 0 }, staged: false, untracked: true, inHead: false, binary: false, conflicted: false,
      },
    }, { onRequestDiscard });
    const btn = await waitFor(() => screen.getByRole('button', { name: 'Revert Changes…' }));
    fireEvent.click(btn);
    expect(onRequestDiscard).toHaveBeenCalledWith(true);
  });

  it('surfaces a failed operation error verbatim', async () => {
    const git = mountWith({ stagedCount: 1 });
    git.commit.mockResolvedValueOnce({ ok: false, error: 'nothing added to commit' });
    await waitFor(() => screen.getByText('Uncommitted changes'));
    fireEvent.change(screen.getByPlaceholderText('Commit message'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commit 1 staged file' }));
    await waitFor(() => expect(screen.getByText('nothing added to commit')).toBeInTheDocument());
  });

  it('surfaces a commit-diff fetch error instead of collapsing to "No direct changes"', async () => {
    const git = mountWith();
    git.commitFileDiff.mockResolvedValueOnce({ ok: false, error: 'fatal: bad object', hunks: [], binary: false });
    await waitFor(() => screen.getByText('fix: first'));
    fireEvent.click(screen.getByText('fix: first'));
    await waitFor(() => expect(screen.getByText('fatal: bad object')).toBeInTheDocument());
    expect(screen.queryByText('No direct changes to this file in this commit.')).not.toBeInTheDocument();
  });

  it('renders externalError in the same slot as opError when there is no opError', async () => {
    mountWith({}, { externalError: 'fatal: could not restore f.ts' });
    await waitFor(() => screen.getByText('Uncommitted changes'));
    expect(screen.getByText('fatal: could not restore f.ts')).toBeInTheDocument();
  });

  it('calls onExternalErrorClear at the top of a new run() (stage/unstage)', async () => {
    const onExternalErrorClear = vi.fn();
    const git = mountWith({}, { onExternalErrorClear });
    await waitFor(() => screen.getByText('Include in commit'));
    fireEvent.click(screen.getByText('Include in commit'));
    await waitFor(() => expect(git.stage).toHaveBeenCalledWith('/proj', 'src/f.ts'));
    expect(onExternalErrorClear).toHaveBeenCalledTimes(1);
  });

  it('a blocked run() (busy guard) does not call onExternalErrorClear', async () => {
    const onExternalErrorClear = vi.fn();
    const git = mountWith({}, { onExternalErrorClear });
    await waitFor(() => screen.getByText('Include in commit'));
    let resolveStage: (v: { ok: boolean }) => void = () => {};
    git.stage.mockReturnValueOnce(new Promise((resolve) => { resolveStage = resolve; }));
    const btn = screen.getByText('Include in commit');
    fireEvent.click(btn); // first call clears
    fireEvent.click(btn); // second call is blocked by the busy guard — no additional clear
    expect(onExternalErrorClear).toHaveBeenCalledTimes(1);
    resolveStage({ ok: true });
    await waitFor(() => expect(git.stage).toHaveBeenCalledTimes(1));
  });

  // 2026-07-22 bug: the parser dropped unmerged files entirely, so a mid-merge
  // file had no review card at all. Now it renders like a modified file plus
  // an honest Conflict badge (viewing only — no resolution UI).
  it('shows a Conflict badge on the uncommitted card for a conflicted file, and none otherwise', async () => {
    mountWith({ uncommitted: { ...review.uncommitted!, conflicted: true } });
    await waitFor(() => screen.getByText('Uncommitted changes'));
    expect(screen.getByText('Conflict')).toBeInTheDocument();
    // The rest of the card is unchanged: diff visible, revert intact, and the
    // checkbox present (but disabled — pinned separately below).
    expect(screen.getByText('old line')).toBeInTheDocument();
    expect(screen.getByText('Include in commit')).toBeInTheDocument();

    cleanup();
    mountWith();
    await waitFor(() => screen.getByText('Uncommitted changes'));
    expect(screen.queryByText('Conflict')).not.toBeInTheDocument();
  });

  // PR #304 review advisory: `git add` on an unmerged file marks the conflict
  // resolved with the <<<<<<< markers STAGED as content — a non-technical user
  // could then commit the markers, and unstaging cannot restore the unmerged
  // state. So the include-in-commit checkbox must be disabled (with a plain-
  // language hint) while the file is conflicted, and clicking it must not
  // reach git.stage.
  it('disables Include in commit for a conflicted file and never calls stage', async () => {
    const git = mountWith({ uncommitted: { ...review.uncommitted!, conflicted: true } });
    await waitFor(() => screen.getByText('Uncommitted changes'));
    const checkbox = screen.getByText('Include in commit').closest('button')!;
    expect(checkbox).toBeDisabled();
    expect(checkbox).toHaveAttribute('data-hint', 'Resolve the conflict before committing this file');
    fireEvent.click(checkbox);
    expect(git.stage).not.toHaveBeenCalled();
    expect(git.unstage).not.toHaveBeenCalled();
    // Non-conflicted control: same click path stays enabled and stages.
    cleanup();
    const git2 = mountWith();
    await waitFor(() => screen.getByText('Include in commit'));
    const enabled = screen.getByText('Include in commit').closest('button')!;
    expect(enabled).toBeEnabled();
    expect(enabled).not.toHaveAttribute('data-hint');
    fireEvent.click(enabled);
    await waitFor(() => expect(git2.stage).toHaveBeenCalledWith('/proj', 'src/f.ts'));
  });

  // 2026-07-22 bug: refresh() (rides every git:changed) refetches only page
  // one while extraLog keeps the "Show more" pages — an overlapping page one
  // then rendered the same commit twice (duplicate React key), and the next
  // Show more's raw-length skip jumped past unseen commits. Dedupe-by-sha was
  // chosen over clearing extraLog so a refresh (e.g. the user ticking
  // "Include in commit") never collapses history they already scrolled open.
  it('a git:changed refresh after Show more neither duplicates commits nor overcounts the next skip', async () => {
    const entry = (ch: string, subject: string) => ({
      sha: ch.repeat(40), shortSha: ch.repeat(7), subject,
      authorDate: '2026-07-22T10:00:00Z', pathAtCommit: 'src/f.ts', counts: null,
    });
    const [a, b, c, d] = [entry('a', 'fix: A'), entry('b', 'fix: B'), entry('c', 'fix: C'), entry('d', 'fix: D')];
    let changed: () => void = () => {};
    const fileReview = vi.fn()
      .mockResolvedValueOnce({ ...review, uncommitted: null, log: [a, b], hasMore: true }) // initial
      .mockResolvedValueOnce({ ...review, uncommitted: null, log: [c, d], hasMore: true }) // Show more
      // refresh after history shifted (A gone): page one now overlaps extraLog's C
      .mockResolvedValueOnce({ ...review, uncommitted: null, log: [b, c], hasMore: true })
      .mockResolvedValue({ ...review, uncommitted: null, log: [], hasMore: false }); // final Show more
    (window as any).claude = {
      git: {
        fileReview,
        commitFileDiff: vi.fn(async () => ({ ok: true, hunks: [], binary: false })),
        onChanged: vi.fn((cb: () => void) => { changed = cb; return () => {}; }),
      },
    };
    render(
      <GitReviewView
        projectRoot="/proj" relPath="src/f.ts" fileName="f.ts"
        onBack={() => {}} onRequestDiscard={() => {}}
      />,
    );
    await waitFor(() => screen.getByText('fix: A'));
    fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
    await waitFor(() => screen.getByText('fix: D'));
    expect(fileReview).toHaveBeenLastCalledWith('/proj', 'src/f.ts', { logSkip: 2 });

    changed(); // git:changed -> refresh() refetches page one only
    await waitFor(() => expect(screen.queryByText('fix: A')).not.toBeInTheDocument());
    // C sits in BOTH the refreshed page one and extraLog — must render once.
    expect(screen.getAllByText('fix: C')).toHaveLength(1);
    // Already-shown history is NOT yanked away (the dedupe-vs-clear choice).
    expect(screen.getByText('fix: B')).toBeInTheDocument();
    expect(screen.getByText('fix: D')).toBeInTheDocument();

    // Next skip counts the deduped visible list (3), not the raw sum (4).
    fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
    await waitFor(() =>
      expect(fileReview).toHaveBeenLastCalledWith('/proj', 'src/f.ts', { logSkip: 3 }));
  });

  it('serializes overlapping stage/unstage clicks through run()', async () => {
    const git = mountWith();
    await waitFor(() => screen.getByText('Include in commit'));
    let resolveStage: (v: { ok: boolean }) => void = () => {};
    git.stage.mockReturnValueOnce(new Promise((resolve) => { resolveStage = resolve; }));
    const btn = screen.getByText('Include in commit');
    fireEvent.click(btn);
    fireEvent.click(btn); // second click while the first op is still in-flight
    expect(git.stage).toHaveBeenCalledTimes(1);
    resolveStage({ ok: true });
    await waitFor(() => expect(git.stage).toHaveBeenCalledTimes(1));
  });
});
