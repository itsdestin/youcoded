// Office fixtures. Neutral files — a garden plan, its budget, a short talk, a volunteer rota
// and a grant report — so no screenshot ever shows anyone's own documents. The files
// themselves are in fixtures/office/ (made by scripts/make-office-fixtures.py).
//
// The editors are not part of the workbench: they are the Euro-Office add-on, served on their
// own origin by `node scripts/office-workbench-server.mjs` (desktop/), which also translates
// each fixture with the real x2t for the fake host's open_file (Task 6). Without it an open
// document shows the editor's own "couldn't open" state, which is the honest answer.
import type { OfficeFile } from '../../../../shared/office-types';

// `?officePort=` — WHY (2026-10-05): shoot starts this checkout's own editor on a free port when
// another worktree's holds 4717 (scripts/shoot/office-editor.mjs in the workspace), so a picture
// never shows a different build of the editor and verify is not blocked by another session.
function officePort(): number {
  try {
    const p = Number(new URLSearchParams(typeof location !== 'undefined' ? location.search : '').get('officePort'));
    return Number.isInteger(p) && p > 0 && p < 65536 ? p : 4717;
  } catch { return 4717; }
}
export const OFFICE_EDITOR_ORIGIN = `http://127.0.0.1:${officePort()}`;

const DIR = '/home/you/Projects/community-garden';

export const OFFICE_FILES: readonly OfficeFile[] = [
  { path: `${DIR}/Garden plan.docx`, name: 'Garden plan.docx', kind: 'document', folder: 'community-garden', at: '2026-09-28T00:00:00Z' },
  { path: `${DIR}/Garden budget.xlsx`, name: 'Garden budget.xlsx', kind: 'spreadsheet', folder: 'community-garden', at: '2026-09-28T00:00:00Z' },
  { path: `${DIR}/Garden talk.pptx`, name: 'Garden talk.pptx', kind: 'presentation', folder: 'community-garden', at: '2026-09-28T00:00:00Z' },
];

/** The fixtures on disk, by name. */
// 'Launch brief.docx' / 'Q3 sales by rep.xlsx' carry comments made through the live editor
// (the office/*-comments screens): the same comments the reading view's launch brief and Q3 workbook hold.
const FIXTURE_NAMES = ['Garden plan.docx', 'Garden budget.xlsx', 'Garden talk.pptx', 'Volunteer rota.xlsx', 'Grant report.docx', 'Launch brief.docx', 'Q3 sales by rep.xlsx'];

/** Which fixture a fake path opens: its own, or — for a file "created" in the workbench —
 *  the first fixture of its kind (there are no blank templates in the workbench). */
export function officeFixtureName(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (FIXTURE_NAMES.includes(base)) return base;
  const ext = base.slice(base.lastIndexOf('.'));
  return FIXTURE_NAMES.find((n) => n.endsWith(ext)) ?? FIXTURE_NAMES[0];
}

/** The fixture's own bytes (the quick preview reads them). */
export function officeSampleUrl(origin: string, name: string): string {
  return `${origin}/samples/${encodeURIComponent(officeFixtureName(name))}`;
}
