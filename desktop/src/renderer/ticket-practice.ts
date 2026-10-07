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

/** How the "Include with ticket" choices look — three drafts for Destin (deck submit-ticket-2,
 *  ST2-C1; he found the tick boxes "still odd"). `?ticketTicks=`:
 *    rows     (shipped) — the setting-row recipe: title and a plain hint on the left, the tick
 *             box at the right, vertically centred; no (i) buttons;
 *    switches — the same rows with a switch instead of a tick box (the Settings recipe for an
 *               on/off choice);
 *    left     — the whole line is one tappable box, tick box on the LEFT (the guide's
 *               "I understand" look).
 *  Delete the losers (and this switch) when he picks. */
export type TicketTicks = 'rows' | 'switches' | 'left';
export function workbenchTicketTicks(): TicketTicks {
  const v = param('ticketTicks');
  return v === 'switches' || v === 'left' ? v : 'rows';
}
