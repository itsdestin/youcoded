// OfficeInlineEditor — Edit mode for Office files in the session drawer and
// Project View (office-questions#Q-open-mode: the quick preview first, the
// editor on Edit; #Q-slim: "YouCoded's own bar").
//
//   ┌ [↶][↷] | [B][I][U] | [•][1.] | [≡][≡][≡]            [ Open in Office ] ┐
//   │  the Euro-Office editor, its own toolbar and side rails hidden          │
//
// The bar is drawn with the app's own Button, so it matches every theme; each
// press is forwarded to the editor, which does exactly what its own toolbar
// button would. Anything beyond the basics is one press away in Office.
import React, { useEffect, useRef, useState } from 'react';
import { Button, LoadingState, Tooltip } from '../ui';
import type { ArtifactViewProps } from '../artifact-views/types';
import type { OfficeBridge } from '../../../shared/office-types';
import { officeFileFor } from './office-files';
import { OFFICE_PAGE_ID } from '../../../shared/pages-types';
import { useArtifactDispatch } from '../../state/ArtifactContext';
import { EditorFrame } from './EditorFrame';
import type { EditorFrameHandle, OfficeCommand, OfficeCommandState } from './EditorFrame';
import { CommandGlyph } from './office-icons';
import { openDoc } from './office-store';

const GROUPS: { cmd: OfficeCommand; label: string }[][] = [
  [{ cmd: 'undo', label: 'Undo' }, { cmd: 'redo', label: 'Redo' }],
  [{ cmd: 'bold', label: 'Bold' }, { cmd: 'italic', label: 'Italic' }, { cmd: 'underline', label: 'Underline' }],
  [{ cmd: 'markers', label: 'Bulleted list' }, { cmd: 'numbering', label: 'Numbered list' }],
  [{ cmd: 'align-left', label: 'Align left' }, { cmd: 'align-center', label: 'Center' }, { cmd: 'align-right', label: 'Align right' }],
];

export function OfficeInlineEditor({ absolutePath, artifactId, onCancelEdit }: ArtifactViewProps) {
  const dispatch = useArtifactDispatch();
  const frame = useRef<EditorFrameHandle>(null);
  const [origin, setOrigin] = useState<string | null>(null);
  const [state, setState] = useState<OfficeCommandState>({});
  const file = officeFileFor(absolutePath);
  useEffect(() => {
    const b = (window as unknown as { claude?: { office?: OfficeBridge } }).claude?.office;
    b?.status().then((s) => setOrigin(s.editorOrigin), () => setOrigin(null));
  }, []);

  // Lists only exist in documents and slides; slides align through a menu, so
  // those three stay out of a presentation's bar rather than doing nothing.
  const groups = GROUPS.filter((g) => {
    if (g[0].cmd === 'markers') return file.kind !== 'spreadsheet';
    if (g[0].cmd === 'align-left') return file.kind !== 'presentation';
    return true;
  });

  const openInOffice = () => {
    // The file moves to Office: one editor per file, so this one closes.
    onCancelEdit?.();
    openDoc(file);
    dispatch({ type: 'PAGE_OPENED', pageId: OFFICE_PAGE_ID });
  };

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
                    variant="ghost"
                    size="icon"
                    aria-label={label}
                    aria-pressed={cmd === 'undo' || cmd === 'redo' ? undefined : !!s?.on}
                    disabled={s ? !s.enabled : false}
                    onClick={() => frame.current?.command(cmd)}
                    className={s?.on ? 'bg-inset text-fg' : ''}
                  >
                    <CommandGlyph cmd={cmd} />
                  </Button>
                </Tooltip>
              );
            })}
          </React.Fragment>
        ))}
        <div className="flex-1" />
        <Button variant="secondary" size="sm" onClick={openInOffice} className="shrink-0">Open in Office</Button>
      </div>
      <div className="relative flex-1 min-h-0">
        {origin === null
          ? <LoadingState what="the editor" verb="Starting" />
          : <EditorFrame ref={frame} file={file} origin={origin} slim onCommandState={setState} screen={artifactId ? `chat/files/edit/${artifactId}` : undefined} />}
      </div>
    </div>
  );
}
