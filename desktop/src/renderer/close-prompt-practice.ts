// Practice-app switch for the close-session prompt (backlog row 17, deck close-session-2).
// Returns the shipped value outside the workbench and the photo-only build (`isWorkbenchMode`
// folds to false in the app and the website), so nothing changes for users until Destin picks.
// `?closeFlags=` picks where Pin to top and Mark complete sit: `lists` (shipped — one card
// under its own label), `split` (a labelled card each) or `subject` (inside the session's own
// card). WHY its own file: other sessions edit workbench-mode.ts in this worktree, and commits
// go by path. Delete with the losing looks.
import { isWorkbenchMode } from './workbench-mode';

export type CloseFlagsLayout = 'lists' | 'split' | 'subject';

export function workbenchCloseFlagsLayout(): CloseFlagsLayout {
  const v = isWorkbenchMode() ? new URLSearchParams(location.search).get('closeFlags') : null;
  return v === 'split' || v === 'subject' ? v : 'lists';
}
