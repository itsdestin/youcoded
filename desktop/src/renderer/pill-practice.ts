// Practice-app switch for the status tags' tint (submit-ticket-5, proposal 9). Returns the
// shipped value outside the workbench and the photo-only build (`isWorkbenchMode` folds to
// false in the app and the website), so nothing changes for users until Destin picks.
// `?pillTint=strong` draws the proposed stronger tint. Delete with the losing look.
import { isWorkbenchMode } from './workbench-mode';

export function workbenchPillTintStrong(): boolean {
  return isWorkbenchMode() && new URLSearchParams(location.search).get('pillTint') === 'strong';
}
