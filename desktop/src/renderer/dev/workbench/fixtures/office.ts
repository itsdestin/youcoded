// Office fixtures. Neutral files — a garden plan, its budget, a short talk, a volunteer rota
// and a grant report — so no screenshot ever shows anyone's own documents. The files
// themselves are in fixtures/office/ (made by scripts/make-office-fixtures.py).
//
// The editors are not part of the workbench: they are the Euro-Office add-on, served on their
// own origin by `node scripts/office-workbench-server.mjs` (desktop/), which also translates
// each fixture with the real x2t for the fake host's open_file (Task 6). Without it an open
// document shows the editor's own "couldn't open" state, which is the honest answer.
import type { OfficeFile } from '../../../../shared/office-types';

export const OFFICE_EDITOR_ORIGIN = 'http://127.0.0.1:4717';

const DIR = '/home/you/Projects/community-garden';

export const OFFICE_FILES: readonly OfficeFile[] = [
  { path: `${DIR}/Garden plan.docx`, name: 'Garden plan.docx', kind: 'document', folder: 'community-garden', at: '2026-09-28T00:00:00Z' },
  { path: `${DIR}/Garden budget.xlsx`, name: 'Garden budget.xlsx', kind: 'spreadsheet', folder: 'community-garden', at: '2026-09-28T00:00:00Z' },
  { path: `${DIR}/Garden talk.pptx`, name: 'Garden talk.pptx', kind: 'presentation', folder: 'community-garden', at: '2026-09-28T00:00:00Z' },
];

/** The fixtures on disk, by name. */
const FIXTURE_NAMES = ['Garden plan.docx', 'Garden budget.xlsx', 'Garden talk.pptx', 'Volunteer rota.xlsx', 'Grant report.docx'];

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
