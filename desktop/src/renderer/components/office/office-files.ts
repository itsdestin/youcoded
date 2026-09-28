// Which files Office edits, and the OfficeFile a path stands for. Tiny on
// purpose: the file viewers ask this for every file they show, and must not
// load the editor code to find out.
import type { OfficeFile, OfficeKind } from '../../../shared/office-types';

const KIND_BY_EXT: Record<string, OfficeKind> = {
  docx: 'document', doc: 'document', odt: 'document',
  xlsx: 'spreadsheet', xls: 'spreadsheet', ods: 'spreadsheet',
  pptx: 'presentation', ppt: 'presentation', odp: 'presentation',
};

/** Files the file viewers edit in Office instead of as text. */
export function isOfficeEditable(path: string): boolean {
  return (path.split('.').pop()?.toLowerCase() ?? '') in KIND_BY_EXT;
}

export function officeFileFor(absolutePath: string): OfficeFile {
  const parts = absolutePath.split(/[\\/]/);
  const name = parts[parts.length - 1] ?? absolutePath;
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return { path: absolutePath, name, kind: KIND_BY_EXT[ext] ?? 'document', folder: parts[parts.length - 2] ?? '', at: new Date().toISOString() };
}

