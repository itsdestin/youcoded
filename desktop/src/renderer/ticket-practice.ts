// Practice-app switches for the "Submit a ticket" screen (Settings → Help & feedback →
// Report a bug). Every one returns the shipped value outside the workbench and the
// photo-only build (`isWorkbenchMode` folds to false in the app and the website), so a
// typo shows the real screen.
//
// WHY its own file and not workbench-mode.ts: another session edits that file in the same
// worktree, and commits here go by path — a shared file would sweep its edits into ours
// (project-switcher friction, round 1).
import { isWorkbenchMode } from './workbench-mode';
import type { ReportContext } from './components/development/ReportDesign';

const param = (k: string) => (isWorkbenchMode() ? new URLSearchParams(location.search).get(k) : null);

/** `?reportFrom=error` opens the ticket the way an error's "Report bug" does: with the
 *  place it happened and the error's own words, so that state can be photographed. The
 *  error text is the practice Office failure (OfficeView passes `actionError.message`). */
export function workbenchReportContext(): ReportContext | null {
  return param('reportFrom') === 'error'
    ? { surface: 'Office', error: 'Could not save "Budget.xlsx": the file is open in another program (EBUSY).' }
    : null;
}
