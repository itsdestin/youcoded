// Office fixtures (design stage, 2026-09-28). Three neutral files — a garden
// plan, its budget and a short talk — so no screenshot ever shows anyone's own
// documents.
//
// The editors are not part of the workbench: they are the Euro-Office add-on,
// served on their own origin. For the mockups that origin is a local server of
// the trial build with the theme bridge added — see
// youcoded-dev/docs/active/prototypes/2026-09-27-office-trial/README.md
// ("Serving the editors for the workbench"). Without it an open document shows
// the editor's own "could not be opened" state, which is the honest answer.
import type { OfficeFile } from '../../../../shared/office-types';

export const OFFICE_EDITOR_ORIGIN = 'http://127.0.0.1:4717';

const DIR = '/home/you/Projects/community-garden';

export const OFFICE_FILES: readonly OfficeFile[] = [
  { path: `${DIR}/Garden plan.docx`, name: 'Garden plan.docx', kind: 'document', folder: 'community-garden', at: '2026-09-28T00:00:00Z' },
  { path: `${DIR}/Garden budget.xlsx`, name: 'Garden budget.xlsx', kind: 'spreadsheet', folder: 'community-garden', at: '2026-09-28T00:00:00Z' },
  { path: `${DIR}/Garden talk.pptx`, name: 'Garden talk.pptx', kind: 'presentation', folder: 'community-garden', at: '2026-09-28T00:00:00Z' },
];

export function officeSampleUrl(origin: string, name: string): string {
  return `${origin}/samples/${encodeURIComponent(name)}`;
}
