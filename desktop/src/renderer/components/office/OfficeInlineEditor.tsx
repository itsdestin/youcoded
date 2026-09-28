// OfficeInlineEditor — Edit mode for Office files in the session drawer and
// Project View (office-questions#Q-open-mode: the quick preview first, the
// editor on Edit; #Q-slim: "YouCoded's own bar").
//
//   ┌ [↶][↷] | [B][I][U] | [•][1.] | [≡][≡][≡]                              ┐
//   │  the Euro-Office editor, its own toolbar and side rails hidden          │
//
// The bar is drawn with the app's own Button, so it matches every theme; each
// press is forwarded to the editor, which does exactly what its own toolbar
// button would. Anything beyond the basics is one press away in Office — the
// briefcase in the panel header (office-review#B-inline), not a button in this bar.
import React, { useEffect, useRef, useState } from 'react';
import { Button, Tooltip } from '../ui';
import type { ArtifactViewProps } from '../artifact-views/types';
import { officeFileFor } from './office-files';
import { EditorFrame } from './EditorFrame';
import type { EditorFrameHandle, OfficeCommand, OfficeCommandState } from './EditorFrame';
import { CommandGlyph } from './office-icons';
import { flushOffice, holdInline, markCopied, officeDocFor, openDoc, registerFlush, useSaveState } from './office-store';
import { OfficeSaveFailed } from './OfficeSaveFailed';
import { useArtifactDispatch } from '../../state/ArtifactContext';
import { OFFICE_PAGE_ID } from '../../../shared/pages-types';

const GROUPS: { cmd: OfficeCommand; label: string }[][] = [
  [{ cmd: 'undo', label: 'Undo' }, { cmd: 'redo', label: 'Redo' }],
  [{ cmd: 'bold', label: 'Bold' }, { cmd: 'italic', label: 'Italic' }, { cmd: 'underline', label: 'Underline' }],
  [{ cmd: 'markers', label: 'Bulleted list' }, { cmd: 'numbering', label: 'Numbered list' }],
  [{ cmd: 'align-left', label: 'Align left' }, { cmd: 'align-center', label: 'Center' }, { cmd: 'align-right', label: 'Align right' }],
];

export function OfficeInlineEditor({ absolutePath, artifactId, onCancelEdit }: ArtifactViewProps) {
  const frame = useRef<EditorFrameHandle>(null);
  const [state, setState] = useState<OfficeCommandState>({});
  // After "Save a copy…" this slot edits the copy (the owner's "Save As" decision, fix round 2);
  // until then it is the panel's own file.
  const [copyPath, setCopyPath] = useState<string | null>(null);
  useEffect(() => setCopyPath(null), [absolutePath]);
  const editPath = copyPath ?? absolutePath;
  const file = officeFileFor(editPath);
  const dispatch = useArtifactDispatch();
  // One editor per file (design §5): Edit on a file that already has an Office tab brings that
  // tab forward instead of starting a second editor on the same file. Decided once, on mount.
  const [inOffice] = useState(() => officeDocFor(file.path) !== null);
  const cancelRef = useRef(onCancelEdit);
  cancelRef.current = onCancelEdit;
  useEffect(() => {
    if (inOffice) {
      openDoc(file);
      dispatch({ type: 'PAGE_OPENED', pageId: OFFICE_PAGE_ID });
      cancelRef.current?.();
      return;
    }
    // While this in-place editor is up, opening the file in Office from anywhere ends it first.
    return holdInline(file.path, () => cancelRef.current?.());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- file is derived from editPath
  }, [editPath, inOffice]);
  // Done and the panel close flush the PANEL's file (ActiveArtifactView); once this slot edits a
  // copy, that flush must reach the copy's editor.
  useEffect(() => (copyPath ? registerFlush(absolutePath, () => flushOffice(copyPath)) : undefined), [absolutePath, copyPath]);
  const saveState = useSaveState(file.path);
  if (inOffice) return null;

  // Lists only exist in documents and slides; slides align through a menu, so
  // those three stay out of a presentation's bar rather than doing nothing.
  const groups = GROUPS.filter((g) => {
    if (g[0].cmd === 'markers') return file.kind !== 'spreadsheet';
    if (g[0].cmd === 'align-left') return file.kind !== 'presentation';
    return true;
  });


  return (
    <div className="h-full flex flex-col">
      <div role="toolbar" aria-label="Formatting" className="h-10 shrink-0 flex items-center gap-1 px-2 border-b border-edge-dim bg-panel select-none overflow-x-auto">
        {groups.map((g, i) => (
          <React.Fragment key={g[0].cmd}>
            {i > 0 && <span aria-hidden="true" className="w-px h-4 mx-1 bg-edge-dim shrink-0" />}
            {g.map(({ cmd, label }) => {
              const s = state[cmd];
              return (
                <Tooltip key={cmd} text={label} placement="bottom">
                  <Button
                    variant="toggle"
                    size="icon"
                    aria-label={label}
                    aria-pressed={cmd === 'undo' || cmd === 'redo' ? undefined : !!s?.on}
                    disabled={s ? !s.enabled : false}
                    onClick={() => frame.current?.command(cmd)}
                  >
                    <CommandGlyph cmd={cmd} />
                  </Button>
                </Tooltip>
              );
            })}
          </React.Fragment>
        ))}
      </div>
      {/* A failed save shows its reason and the save-failed actions right above the document
          (I1, Task 6 fix round 1): Done and closing the panel wait on it rather than dropping
          the changes. "Close without saving" leaves the in-place edit. */}
      {saveState.phase === 'saved' && saveState.copiedTo && (
        <div className="shrink-0 px-3 py-1.5 text-2xs text-fg-muted border-b border-edge-dim" role="status">
          Saved a copy to {saveState.copiedTo} — now editing the copy.
        </div>
      )}
      {saveState.phase === 'failed' && (
        <div className="shrink-0 p-2 border-b border-edge-dim">
          <OfficeSaveFailed message={saveState.message ?? "Office couldn't save this file."} frame={frame} onCloseWithoutSaving={() => cancelRef.current?.()} />
        </div>
      )}
      <div className="relative flex-1 min-h-0">
        {/* WHY no wait for an origin here any more (Task 5): each document gets its own,
            which the frame asks main for itself, showing its own loading state meanwhile. */}
        <EditorFrame
          key={file.path}
          ref={frame}
          file={file}
          slim
          onCommandState={setState}
          screen={artifactId ? `chat/files/edit/${artifactId}` : undefined}
          onSwitchTo={(p, folder) => { setCopyPath(p); markCopied(p, folder); }}
        />
      </div>
    </div>
  );
}
