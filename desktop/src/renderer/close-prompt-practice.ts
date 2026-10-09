// Practice-app switch for the close-session prompt (backlog row 17, deck close-session-1).
// Returns the shipped value outside the workbench and the photo-only build (`isWorkbenchMode`
// folds to false in the app and the website), so nothing changes for users until Destin picks.
// `?closeTags=folded` draws the Tags card folded to one row; anything else, the open card.
// WHY its own file: other sessions edit workbench-mode.ts in this worktree, and commits go by
// path. Delete with the losing look.
import { isWorkbenchMode } from './workbench-mode';

export function workbenchCloseTagsFolded(): boolean {
  return isWorkbenchMode() && new URLSearchParams(location.search).get('closeTags') === 'folded';
}
