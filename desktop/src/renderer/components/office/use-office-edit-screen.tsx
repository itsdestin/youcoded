// Office hooks for the file panels (SessionDrawer, FilesTab), kept out of those files so
// they stay inside their line budgets.
//
// Photo-only (`shoot`): the `chat/files/edit/<id>` screen — a file opened in
// the session drawer and put straight into Edit mode, so the Office slim editor
// can be reviewed without a click. Lives here, not in SessionDrawer, to keep
// that file inside its line budget.
import React, { type RefObject } from 'react';
import { PageGlyph } from '../pages/page-icons';
import { useScreenOpen } from '../../shoot-mode';
import type { ActiveArtifactHandle } from '../artifact-views/ActiveArtifactView';
import { OFFICE_PAGE_ID } from '../../../shared/pages-types';
import { isOfficeEditable, officeFileFor } from './office-files';
import { openDoc } from './office-store';

export function useOfficeEditScreen(
  editRef: RefObject<ActiveArtifactHandle | null>,
  open: (artifactId: string) => void,
  ids: readonly string[],
): void {
  // The viewer becomes editable only once the file has loaded; retry briefly.
  const editWhenReady = (n: number): void => {
    if (editRef.current?.isEditable) editRef.current.startEdit();
    else if (n > 0) setTimeout(() => editWhenReady(n - 1), 100);
  };
  useScreenOpen('chat/files/edit', (id) => { if (id) { open(id); editWhenReady(40); } }, ids);
}

/** The file panels' header action for an Office file (office-review#B-inline, Destin's note:
 *  "move the open in office button to be a new icon that replaces the open in external/default
 *  app icon in the file panel header for office docs"). Returns null for any other file, or
 *  where the editors cannot run, so the panel keeps its usual Open-externally button. */
export function officeHeaderAction(
  absolutePath: string | null | undefined,
  dispatch: (a: { type: 'PAGE_OPENED'; pageId: string }) => void,
  beforeOpen?: () => void,
): { title: string; glyph: React.ReactNode; onClick: () => void } | null {
  if (!absolutePath || !isOfficeEditable(absolutePath)) return null;
  if (!(window as unknown as { claude?: { office?: unknown } }).claude?.office) return null;
  return {
    title: 'Open in Office',
    // The Office page's own briefcase, so the button reads as "go to Office".
    glyph: <PageGlyph icon="office" className="w-4 h-4" />,
    onClick: () => {
      // One editor per file: an in-place edit closes before the file moves to a full tab.
      beforeOpen?.();
      openDoc(officeFileFor(absolutePath));
      dispatch({ type: 'PAGE_OPENED', pageId: OFFICE_PAGE_ID });
    },
  };
}
