// "Choose a file" — YouCoded's own file chooser for a page used from a phone's
// browser (pages-finish step 2; deck step 2, Q-remote-pick: "YouCoded's own file
// chooser"). The computer's Open and Save windows cannot appear on a phone, so this
// browses the COMPUTER's folders from the phone and picks one file there.
//
// What it never shows: password and key files (main's secret-file list, the same
// one the phone's file reads already use), and anything outside the person's home
// folder. Files of other kinds than the page works with are counted, not listed, so
// the page's ask stays the focus and nothing is picked by mistake.
//
// Shape: a popup with its job as the title (guide "Popups and side panels"); where
// you are as a row of folder chips that scrolls sideways (the chip-row rule); one
// card of plain pick-list rows (guide "Lists and menus": pick-one menus are plain
// rows, the chosen row looks different from a hovered one); the buttons that act on
// the whole popup on its pinned bottom line, Cancel outlined, the action filled.
import React, { useEffect, useState } from 'react';
import type { PageFileEntry, PageSummary, PagesBridge } from '../../../shared/pages-types';
import { fileKind } from '../../../shared/artifacts/categorization';
import { Button, CARD_LEVEL_1, ErrorState, LoadingState, SectionLabel, TextInput, Tooltip } from '../ui';
import { Dialog } from '../ui/Dialog';
import { FileKindIcon, FolderIcon } from '../project-view/icons';
import { useNarrowViewport } from '../../hooks/use-narrow-viewport';
import { isWorkbenchMode } from '../../workbench-mode';

function bridge(): PagesBridge | undefined {
  return (window as unknown as { claude?: { pages?: PagesBridge } }).claude?.pages;
}

export type FileChooserMode = { kind: 'open'; types?: string[] } | { kind: 'save'; suggestedName: string; types?: string[] };

/** Bytes as a person reads them. */
function sizeWords(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function PageFileChooser({ page, mode, onChoose, onClose }: {
  page: PageSummary | null;
  mode: FileChooserMode | null;
  /** The chosen file (open) or folder + name (save), under Home; main checks it again. */
  onChoose: (choice: { folder: string; file: string }) => void;
  onClose: () => void;
}) {
  const open = page !== null && mode !== null;
  if (!open) return <Dialog screen="pages/page/file-chooser" open={false} onClose={onClose} title="">{null}</Dialog>;
  // A fresh chooser for every ask (key), so a new ask starts at Home with nothing picked.
  return <ChooserBody key={`${mode.kind}:${page.id}`} page={page} mode={mode} onChoose={onChoose} onClose={onClose} />;
}

function ChooserBody({ page, mode, onChoose, onClose }: { page: PageSummary; mode: FileChooserMode; onChoose: (c: { folder: string; file: string }) => void; onClose: () => void }) {
  const narrow = useNarrowViewport();
  // The folder shown, as path segments under Home ([] = Home itself).
  // The workbench may open it inside a folder (`?pagesChooserAt=Documents/Budgets`) so
  // the review shows a real listing, not only Home.
  const [trail, setTrail] = useState<string[]>(() => {
    if (!isWorkbenchMode()) return [];
    const at = new URLSearchParams(location.search).get('pagesChooserAt');
    return at ? at.split('/').filter(Boolean) : [];
  });
  const [entries, setEntries] = useState<PageFileEntry[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [name, setName] = useState(mode.kind === 'save' ? mode.suggestedName : '');
  const folder = trail.join('/');

  useEffect(() => {
    let live = true;
    setEntries(null); setFailed(null); setPicked(null);
    const b = bridge();
    if (!b?.listFolder) { setFailed("This screen can't browse the computer's files."); return () => { live = false; }; }
    b.listFolder(folder).then((r) => {
      if (!live) return;
      if (r.ok) setEntries(r.entries); else setFailed(r.message);
    }).catch(() => { if (live) setFailed("The computer's folder couldn't be read."); });
    return () => { live = false; };
  }, [folder]);

  const types = mode.types ?? [];
  const fits = (e: PageFileEntry) => e.kind === 'folder' || types.length === 0 || types.some((t) => e.name.toLowerCase().endsWith(t));
  const shown = (entries ?? []).filter(fits);
  const others = (entries ?? []).length - shown.length;
  const ready = mode.kind === 'open' ? picked !== null : name.trim() !== '';
  const choose = () => { if (ready) onChoose({ folder, file: mode.kind === 'open' ? picked! : name.trim() }); };

  // Buttons for the whole popup on its pinned bottom line (guide "Popups": several
  // groups → the footer): the way back outlined, the action filled, at the right;
  // stacked full width on a phone, filled on top (guide "Buttons").
  const footer = (
    <div className={narrow ? 'flex flex-col-reverse gap-2' : 'flex items-center justify-end gap-2'}>
      <Button variant="secondary" onClick={onClose} className={narrow ? 'w-full' : ''}>Cancel</Button>
      <Tooltip text={ready ? '' : mode.kind === 'open' ? 'Choose a file first' : 'Name the file first'} placement="top">
        <Button variant="primary" onClick={choose} disabled={!ready} className={narrow ? 'w-full' : ''}>{mode.kind === 'open' ? 'Open' : 'Save here'}</Button>
      </Tooltip>
    </div>
  );

  return (
    <Dialog screen="pages/page/file-chooser" open onClose={onClose} layer={3} size="document" footer={footer}
      title={mode.kind === 'save' ? 'Save a file' : 'Choose a file'}
      subtitle={mode.kind === 'save' ? `${page.name} wants to save a file on your computer.` : `${page.name} asks for a file on your computer.`}>
    <div className="flex flex-col gap-3" data-file-chooser={mode.kind}>
      {/* One labelled card (guide: nothing bare on the popup): where you are, as chips
          you can go back to, then what is there. */}
      <SectionLabel>Your computer</SectionLabel>
      <div className={`${CARD_LEVEL_1} p-1.5 flex flex-col gap-1`}>
      <div className="scroll-mask-x overflow-x-auto flex items-center gap-1 px-0.5 py-0.5" data-file-chooser-trail>
        {['Home', ...trail].map((seg, i) => (
          <React.Fragment key={`${i}-${seg}`}>
            {i > 0 && <span aria-hidden="true" className="text-fg-faint text-xs">›</span>}
            <Button variant={i === trail.length ? 'secondary' : 'ghost'} size="sm" className="shrink-0" onClick={() => setTrail(trail.slice(0, i))}>{seg}</Button>
          </React.Fragment>
        ))}
      </div>

        {failed ? <div className="p-1.5"><ErrorState variant="inline" message={failed} onRetry={() => setTrail([...trail])} /></div>
          : entries === null ? <div className="p-3"><LoadingState what="files" /></div>
          : shown.length === 0 ? <div className="px-2 py-3 text-xs text-fg-muted">{mode.kind === 'save' ? 'Nothing here yet. Your file will be the first.' : 'No files here that this page can open.'}</div>
          : (
            <div className="scroll-mask max-h-80 overflow-y-auto flex flex-col" role="listbox" aria-label="Files and folders">
              {shown.map((e) => {
                const isPicked = e.kind === 'file' && picked === e.name;
                return (
                  <button
                    key={e.name}
                    type="button"
                    role="option"
                    aria-selected={isPicked}
                    onClick={() => (e.kind === 'folder' ? setTrail([...trail, e.name]) : mode.kind === 'open' ? setPicked(e.name) : setName(e.name))}
                    onDoubleClick={() => { if (e.kind === 'file' && mode.kind === 'open') onChoose({ folder, file: e.name }); }}
                    className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md text-left text-sm transition-colors ${isPicked ? 'bg-accent/15 text-fg' : 'text-fg-2 hover:bg-inset'}`}
                    data-file-entry={e.kind}
                  >
                    <span className="shrink-0 text-fg-muted">{e.kind === 'folder' ? <FolderIcon size={16} /> : <FileKindIcon kind={fileKind(e.name)} size={16} />}</span>
                    <span className="min-w-0 flex-1 truncate">{e.name}</span>
                    {e.kind === 'file' && !narrow && <span className="shrink-0 text-xs text-fg-muted">{sizeWords(e.size)}</span>}
                  </button>
                );
              })}
            </div>
          )}
        {entries !== null && others > 0 && (
          <div className="px-2 pt-1.5 pb-1 text-xs text-fg-muted">{others === 1 ? '1 other file is' : `${others} other files are`} not shown: this page works with {types.join(', ')} files.</div>
        )}
      </div>

      {mode.kind === 'save' && (<>
        <SectionLabel>Save as</SectionLabel>
        <div className={`${CARD_LEVEL_1} p-3 flex flex-col gap-1.5`}>
          <label htmlFor="file-chooser-name" className="text-xs font-medium text-fg">File name</label>
          <TextInput id="file-chooser-name" value={name} onChange={(e) => setName(e.target.value)} className="select-text" />
          <div className="text-xs text-fg-muted">It is saved in the folder shown above, on your computer.</div>
        </div>
      </>)}

    </div>
    </Dialog>
  );
}
