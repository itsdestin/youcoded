// Which files Office edits, and the OfficeFile a path stands for. Tiny on
// purpose: the file viewers ask this for every file they show, and must not
// load the editor code to find out.
import type { OfficeFile, OfficeKind } from '../../../shared/office-types';

const KIND_BY_EXT: Record<string, OfficeKind> = {
  docx: 'document', doc: 'document', odt: 'document',
  xlsx: 'spreadsheet', xls: 'spreadsheet', ods: 'spreadsheet',
  pptx: 'presentation', ppt: 'presentation', odp: 'presentation',
};

/** The formats main's translator and version history accept (x2t.ts, versions.ts). */
const EDITABLE_EXT = new Set(['docx', 'xlsx', 'pptx']);

/** Files the file viewers edit in Office instead of as text.
 *  WHY only docx/xlsx/pptx (final review, finding 1): main refuses the older and
 *  OpenDocument formats, so offering Office for a .doc hid its "Open with the default
 *  app" button and showed an Edit that dead-ended. KIND_BY_EXT stays wider because
 *  officeFileFor still names the kind of any Office-family file it is handed. */
export function isOfficeEditable(path: string): boolean {
  return EDITABLE_EXT.has(path.split('.').pop()?.toLowerCase() ?? '');
}

export function officeFileFor(absolutePath: string): OfficeFile {
  const parts = absolutePath.split(/[\\/]/);
  const name = parts[parts.length - 1] ?? absolutePath;
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return { path: absolutePath, name, kind: KIND_BY_EXT[ext] ?? 'document', folder: parts[parts.length - 2] ?? '', at: new Date().toISOString() };
}

