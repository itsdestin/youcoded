// Practice-app switch for the "unsaved changes" popup (deck close-session-5). Returns the shipped
// value outside the workbench and the photo-only build (`isWorkbenchMode` folds to false in the app
// and the website), so nothing changes for users until Destin picks. `?unsavedList=rows` draws the
// files as plain rows in one box; anything else, a box per file. WHY its own file: other sessions
// edit workbench-mode.ts in this worktree, and commits go by path. Delete with the losing look.
import { isWorkbenchMode } from './workbench-mode';

export function workbenchUnsavedListRows(): boolean {
  return isWorkbenchMode() && new URLSearchParams(location.search).get('unsavedList') === 'rows';
}
