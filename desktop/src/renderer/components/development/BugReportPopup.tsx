// desktop/src/renderer/components/development/BugReportPopup.tsx
//
// The entry point for "Report a Bug or Request a Feature". Everything it does
// lives in ReportDesign; this file is the name the rest of the app imports.
//
// HISTORY (2026-09-10). This used to hold a second, legacy screen, and a gate that
// showed it to everyone except the workbench. The gate was held up on purpose: the
// legacy review screen carried "Let Claude Try to Fix It" — set up the workspace,
// open a session, hand it the bug — and the approved design had no such action, so
// flipping it would have deleted a working feature no deck asked to remove.
//
// The grader then measured what the gate cost: THIRTEEN of the 23 signed contract
// rows unmet, for one reason. `main.ts` never puts a mode on a packaged window, so
// no user could reach the new screen; every test in the suite passed on a screen
// nobody could open. And the screen users did get pre-collects logs and diagnostics
// before anyone consents, runs an AI summary before you see anything, and answers
// every send failure with "Opening GitHub in your browser…" — the exact dishonesty
// this feature exists to remove. Keeping that to protect one action was the wrong
// trade.
//
// So the action was CARRIED OVER rather than deleted: ReportDesign's "Let your
// assistant try to fix it", built on the managed setup instead of the fixed-folder
// installer (which pulled into an existing ~/youcoded-dev, and R9 forbids that).
// It goes to Destin on the acceptance deck to keep, cut or redesign. Nothing was
// silently removed, and nothing is now shown to a user that was never approved.
import { ReportDesign, type ReportContext } from './ReportDesign';

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * What failed, when the report was opened from an error (audit E-01). Optional:
   * Settings → Development opens the same screen with nothing to carry.
   */
  context?: ReportContext;
}

export function BugReportPopup(props: Props) {
  return <ReportDesign {...props} />;
}
