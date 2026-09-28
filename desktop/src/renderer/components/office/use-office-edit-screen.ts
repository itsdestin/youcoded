// Photo-only (`shoot`): the `chat/files/edit/<id>` screen — a file opened in
// the session drawer and put straight into Edit mode, so the Office slim editor
// can be reviewed without a click. Lives here, not in SessionDrawer, to keep
// that file inside its line budget.
import type { RefObject } from 'react';
import { useScreenOpen } from '../../shoot-mode';
import type { ActiveArtifactHandle } from '../artifact-views/ActiveArtifactView';

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
