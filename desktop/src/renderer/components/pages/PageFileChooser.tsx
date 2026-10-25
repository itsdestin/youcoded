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
// Round 2 (Destin, 2026-10-24: "too simple… not enough information"; "switch between a
// tiles/list view kinda like project view… project view prob has too much stuff/too
// big. we should be able to fit a lot of files"): a tiles / list switch as in Projects →
// Files, but compact — small tiles, dense rows with when each file changed and its
// size, sortable columns, search inside the folder, and quick places — which ended up
// (round 3) in a menu on the first item of the path. Tiles first for someone new.
import React, { useEffect, useMemo, useState } from 'react';
import type { PageFileEntry, PageSummary, PagesBridge } from '../../../shared/pages-types';
import { fileKind } from '../../../shared/artifacts/categorization';
import { Button, CARD_LEVEL_1, ErrorState, LoadingState, Menu, MenuRadioItem, SearchFilterPill, SectionLabel, SegmentedTabs, TextInput, Tooltip } from '../ui';
import { ChevronDown } from '../ui/ChevronDown';
import { Dialog } from '../ui/Dialog';
import { FileKindIcon, FolderIcon, GridViewIcon, ListViewIcon } from '../project-view/icons';
import { useNarrowViewport } from '../../hooks/use-narrow-viewport';
import { isWorkbenchMode } from '../../workbench-mode';

function bridge(): PagesBridge | undefined {
  return (window as unknown as { claude?: { pages?: PagesBridge } }).claude?.pages;
}

/** `ask`: the waiting pick or save main handed out; the listing is answered only while it waits. */
export type FileChooserMode = { kind: 'open'; ask: string; types?: string[] } | { kind: 'save'; ask: string; suggestedName: string; types?: string[] };
type View = 'list' | 'tiles';
type Sort = 'name' | 'changed' | 'size';

/** The usual folders, one tap away (Destin's pick on the details question). */
const PLACES: Array<{ label: string; trail: string[] }> = [
  { label: 'Home', trail: [] }, { label: 'Desktop', trail: ['Desktop'] }, { label: 'Documents', trail: ['Documents'] },
  { label: 'Downloads', trail: ['Downloads'] }, { label: 'Pictures', trail: ['Pictures'] },
];

/** Bytes as a person reads them. */
function sizeWords(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** When a file changed: the time today, the day this year, else the full date. */
function changedWords(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return d.getFullYear() === now.getFullYear()
    ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Workbench switches, so each state the review needs is a screen of its own. */
function workbenchParam(name: string): string | null {
  return isWorkbenchMode() ? new URLSearchParams(location.search).get(name) : null;
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
  // Round 3 (Destin, 2026-10-24, step 2e deck): the places live in a menu on the first
  // item of the path — "the name of the folder should be in the dropdown as the first
  // breadcrumb item" — so they take no row or column, and a phone shows the same.
  const [placesOpen, setPlacesOpen] = useState(false);
  // WHY after mount (the photo-only build's open menu): a menu open from the first render signs up
  // for Escape before its dialog does, so one Escape would close both. Opening it a moment later is
  // what a click does.
  useEffect(() => { if (workbenchParam('pagesChooserPlaces') === 'open') setPlacesOpen(true); }, []);
  // The folder shown, as path segments under Home ([] = Home itself).
  const [trail, setTrail] = useState<string[]>(() => (workbenchParam('pagesChooserAt') ?? '').split('/').filter(Boolean));
  // Tiles first for someone new (Destin: "we should default to tiles for new users").
  const [view, setView] = useState<View>(() => (workbenchParam('pagesChooserView') === 'list' ? 'list' : 'tiles'));
  const [sort, setSort] = useState<{ by: Sort; up: boolean }>({ by: 'name', up: true });
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<PageFileEntry[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(() => workbenchParam('pagesChooserPick'));
  const [name, setName] = useState(mode.kind === 'save' ? mode.suggestedName : '');
  const folder = trail.join('/');

  useEffect(() => {
    let live = true;
    setEntries(null); setFailed(null); setQuery('');
    const b = bridge();
    if (!b?.listFolder) { setFailed("This screen can't browse the computer's files."); return () => { live = false; }; }
    b.listFolder(page.id, mode.ask, folder).then((r) => {
      if (!live) return;
      if (r.ok) setEntries(r.entries); else setFailed(r.message);
    }).catch(() => { if (live) setFailed("The computer's folder couldn't be read."); });
    return () => { live = false; };
  }, [folder, page.id, mode.ask]);

  const types = mode.types ?? [];
  const fits = (e: PageFileEntry) => e.kind === 'folder' || types.length === 0 || types.some((t) => e.name.toLowerCase().endsWith(t));
  const { shown, others } = useMemo(() => {
    const all = entries ?? [];
    const kept = all.filter(fits);
    const q = query.trim().toLowerCase();
    const matched = q ? kept.filter((e) => e.name.toLowerCase().includes(q)) : kept;
    const by = (a: PageFileEntry, b: PageFileEntry) =>
      sort.by === 'changed' ? (a.modified ?? '').localeCompare(b.modified ?? '')
      : sort.by === 'size' ? (a.size ?? 0) - (b.size ?? 0)
      : a.name.localeCompare(b.name, undefined, { numeric: true });
    // Folders always first, whatever the order: you go into them, not choose them.
    const sorted = [...matched].sort((a, b) => (a.kind !== b.kind ? (a.kind === 'folder' ? -1 : 1) : (sort.up ? 1 : -1) * by(a, b)));
    return { shown: sorted, others: all.length - kept.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, query, sort, types.join(',')]);

  const ready = mode.kind === 'open' ? picked !== null : name.trim() !== '';
  const choose = () => { if (ready) onChoose({ folder, file: mode.kind === 'open' ? picked! : name.trim() }); };
  const activate = (e: PageFileEntry) => (e.kind === 'folder' ? (setTrail([...trail, e.name]), setPicked(null)) : mode.kind === 'open' ? setPicked(e.name) : setName(e.name));
  const openNow = (e: PageFileEntry) => { if (e.kind === 'file' && mode.kind === 'open') onChoose({ folder, file: e.name }); };
  const sortBy = (by: Sort) => setSort((s) => ({ by, up: s.by === by ? !s.up : true }));

  // Buttons for the whole popup on its pinned bottom line (guide "Popups"): the way
  // back outlined, the action filled, at the right; stacked on a phone, filled on top.
  const footer = (
    <div className={narrow ? 'flex flex-col-reverse gap-2' : 'flex items-center justify-end gap-2'}>
      <Button variant="secondary" onClick={onClose} className={narrow ? 'w-full' : ''}>Cancel</Button>
      <Tooltip text={ready ? '' : mode.kind === 'open' ? 'Choose a file first' : 'Name the file first'} placement="top">
        <Button variant="primary" onClick={choose} disabled={!ready} className={narrow ? 'w-full' : ''}>{mode.kind === 'open' ? 'Open' : 'Save here'}</Button>
      </Tooltip>
    </div>
  );

  // The first item of the path is the place you are in (Home, Documents, Pictures…), and
  // it IS the menu of places. The rest of the path follows it. Kept outside the path's
  // sideways scroll, so the menu is never clipped by it.
  const root = PLACES.some((p) => p.trail[0] === trail[0] && p.trail.length === 1) ? trail[0] : null;
  const rest = root ? trail.slice(1) : trail;
  const placesMenu = (
    <Menu open={placesOpen} onOpenChange={setPlacesOpen} label="Places on your computer"
      trigger={(
        <Button size="sm" variant="secondary" aria-label={`${root ?? 'Home'} — places on your computer`} aria-expanded={placesOpen}
          className="shrink-0 gap-1.5 px-2" onClick={() => setPlacesOpen(!placesOpen)}>
          <FolderIcon size={14} /><span className={rest.length === 0 ? 'text-fg font-medium' : ''}>{root ?? 'Home'}</span><ChevronDown className="w-3 h-3" />
        </Button>
      )}>
      {PLACES.map((p) => (
        <MenuRadioItem key={p.label} checked={(p.trail[0] ?? null) === root} onSelect={() => { setTrail(p.trail); setPicked(null); }}>{p.label}</MenuRadioItem>
      ))}
    </Menu>
  );

  const trailRow = (
    <div className="scroll-mask-x overflow-x-auto flex items-center gap-1 min-w-0 flex-1" data-file-chooser-trail>
      {rest.map((seg, i) => (
        <React.Fragment key={`${i}-${seg}`}>
          <span aria-hidden="true" className="text-fg-faint text-xs">›</span>
          <button type="button" onClick={() => { setTrail(trail.slice(0, trail.length - rest.length + i + 1)); setPicked(null); }}
            className={`shrink-0 px-1.5 py-0.5 rounded-md text-xs transition-colors ${i === rest.length - 1 ? 'text-fg font-medium' : 'text-fg-muted hover:text-fg hover:bg-inset'}`}>
            {seg}
          </button>
        </React.Fragment>
      ))}
    </div>
  );

  const header = (label: string, by: Sort, cls: string) => (
    <button type="button" onClick={() => sortBy(by)} className={`${cls} text-2xs text-fg-muted hover:text-fg text-left inline-flex items-center gap-1`} aria-sort={sort.by === by ? (sort.up ? 'ascending' : 'descending') : undefined}>
      {label}{sort.by === by && <span aria-hidden="true">{sort.up ? '↑' : '↓'}</span>}
    </button>
  );

  const list = (
    <div className="flex flex-col" role="listbox" aria-label="Files and folders">
      <div className="flex items-center gap-2 px-2 pb-1">
        {header('Name', 'name', 'flex-1 min-w-0')}
        {!narrow && header('Changed', 'changed', 'w-24')}
        {header('Size', 'size', 'w-16 justify-end')}
      </div>
      {shown.map((e) => {
        const isPicked = e.kind === 'file' && picked === e.name;
        return (
          <button key={e.name} type="button" role="option" aria-selected={isPicked} onClick={() => activate(e)} onDoubleClick={() => openNow(e)}
            className={`w-full flex items-center gap-2 px-2 h-8 rounded-md text-left text-sm transition-colors ${isPicked ? 'bg-accent/15 text-fg' : 'text-fg-2 hover:bg-inset'}`} data-file-entry={e.kind}>
            <span className="shrink-0 text-fg-muted">{e.kind === 'folder' ? <FolderIcon size={15} /> : <FileKindIcon kind={fileKind(e.name)} size={15} />}</span>
            <span className="min-w-0 flex-1 truncate">{e.name}</span>
            {!narrow && <span className="w-24 shrink-0 text-xs text-fg-muted">{changedWords(e.modified)}</span>}
            <span className="w-16 shrink-0 text-xs text-fg-muted text-right">{e.kind === 'file' ? sizeWords(e.size) : ''}</span>
          </button>
        );
      })}
    </div>
  );

  const tiles = (
    <div className="grid gap-1.5 p-0.5" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${narrow ? 88 : 92}px, 1fr))` }} role="listbox" aria-label="Files and folders">
      {shown.map((e) => {
        const isPicked = e.kind === 'file' && picked === e.name;
        return (
          <button key={e.name} type="button" role="option" aria-selected={isPicked} onClick={() => activate(e)} onDoubleClick={() => openNow(e)}
            className={`flex flex-col gap-1 p-1.5 rounded-lg text-left transition-colors ${isPicked ? 'bg-accent/15 ring-2 ring-accent' : 'hover:bg-inset'}`} data-file-entry={e.kind}>
            <span className="aspect-[4/3] w-full rounded-md overflow-hidden bg-inset border border-edge-dim flex items-center justify-center text-fg-muted">
              {e.thumb ? <img src={e.thumb} alt="" className="w-full h-full object-cover" /> : e.kind === 'folder' ? <FolderIcon size={26} /> : <FileKindIcon kind={fileKind(e.name)} size={26} />}
            </span>
            <span className="text-xs text-fg leading-snug line-clamp-2 break-words">{e.name}</span>
            <span className="text-2xs text-fg-muted">{e.kind === 'file' ? changedWords(e.modified) : ' '}</span>
          </button>
        );
      })}
    </div>
  );

  const filesMain = (
    <div className="flex flex-col gap-1.5 min-w-0 flex-1">
      <div className="flex items-center gap-2 px-0.5">
        {placesMenu}
        {trailRow}
        <SegmentedTabs aria-label="File view" value={view} onChange={(v) => setView(v as View)}
          tabs={[{ id: 'list', label: <ListViewIcon size={14} />, title: 'List' }, { id: 'tiles', label: <GridViewIcon size={14} />, title: 'Tiles' }]} />
      </div>
      <SearchFilterPill value={query} onChange={setQuery} placeholder="Search this folder" inputAriaLabel="Search this folder" />
      {failed ? <div className="p-1"><ErrorState variant="inline" message={failed} onRetry={() => setTrail([...trail])} /></div>
        : entries === null ? <div className="p-3"><LoadingState what="files" /></div>
        : shown.length === 0 ? <div className="px-2 py-3 text-xs text-fg-muted">{query ? 'Nothing here matches.' : mode.kind === 'save' ? 'Nothing here yet. Your file will be the first.' : 'No files here that this page can open.'}</div>
        : <div className="scroll-mask max-h-[26rem] overflow-y-auto">{view === 'list' ? list : tiles}</div>}
      {entries !== null && others > 0 && (
        <div className="px-2 pb-0.5 text-xs text-fg-muted">{others === 1 ? '1 other file is' : `${others} other files are`} not shown: this page works with {types.join(', ')} files.</div>
      )}
    </div>
  );
  // One card holds the path, the places menu and the files (guide: nothing bare on the popup).
  const filesCard = (
    <div className={`${CARD_LEVEL_1} p-1.5 flex flex-col gap-1.5`}>
      {filesMain}
    </div>
  );

  return (
    <Dialog screen="pages/page/file-chooser" open onClose={onClose} layer={3} size="wide" footer={footer}
      title={mode.kind === 'save' ? 'Save a file' : 'Choose a file'}
      subtitle={mode.kind === 'save' ? `${page.name} wants to save a file on your computer.` : `${page.name} asks for a file on your computer.`}>
      <div className="flex flex-col gap-3" data-file-chooser={mode.kind} data-file-chooser-view={view}>
        <SectionLabel>Your computer</SectionLabel>
        {filesCard}
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
