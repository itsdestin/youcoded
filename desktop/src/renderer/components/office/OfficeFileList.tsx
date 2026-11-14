// The Office start screen's file rows and what you can do with each (design stage, 2026-11-14,
// card #143 — Destin picked: Rename, View in folder, Ask about this, Make a copy, Remove from
// Recent, a right-click menu, a search box and "Show all").
//
// References the rows follow (named on the review deck): the session strip's right-click menu
// (SessionStrip.tsx — the shared ContextMenu), the file drawer's inline rename (SessionDrawer.tsx)
// and the comment cards' hover buttons (CommentActions.tsx). Wording is the chat file menu's own
// ("View in folder", "Ask about this", "Copy as path" — context-menu/build-menu.ts).
import React, { memo, useEffect, useRef, useState } from 'react';
import type { OfficeFile } from '../../../shared/office-types';
import { getCapabilities } from '../../platform';
import { ContextMenu } from '../context-menu/ContextMenu';
import type { MenuEntry } from '../context-menu/build-menu';
import { MenuIcon } from '../context-menu/menu-icons';
import { genRefId } from '../context-menu/compose-ref';
import { Button, Dialog, ErrorState, OneJobCard, OneJobHint, OneJobLabel, TextInput, Tooltip } from '../ui';
import { OfficeKindGlyph } from './office-icons';

/** What a row's actions do. One object for every row (OfficeHome keeps it stable), so a memoised
 *  row is not redrawn by its parent's re-render (renderer-lists: stable props). */
export interface OfficeRowActions {
  open(f: OfficeFile): void;
  /** Resolves to null when renamed, or the reason it could not be (shown under the name). */
  rename(f: OfficeFile, newName: string): Promise<string | null>;
  duplicate(f: OfficeFile): void;
  /** Only on Recent rows. */
  forget?(f: OfficeFile): void;
}

/** "Ask about this": the file goes into the chat box as a pill, like a quote does (build-menu.ts). */
function askAbout(f: OfficeFile): void {
  window.dispatchEvent(new CustomEvent('youcoded:compose-insert', {
    detail: { ref: { id: genRefId(), kind: 'doc', path: f.path, fileName: f.name, label: f.name } },
  }));
}

// Typed loosely, as build-menu.ts does: the window's shell bridge carries showItemInFolder, the
// shared type does not list it.
function viewInFolder(f: OfficeFile): void {
  void (window.claude?.shell as { showItemInFolder?: (p: string) => Promise<void> } | undefined)?.showItemInFolder?.(f.path);
}

function copyPath(f: OfficeFile): void {
  void navigator.clipboard?.writeText(f.path).catch(() => {});
}

const stem = (name: string) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(0, i) : name; };
const ext = (name: string) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i) : ''; };

/** The right-click menu, also behind the row's "More" button (the touch path: no right-click there). */
function menuFor(f: OfficeFile, actions: OfficeRowActions, startRename: () => void): MenuEntry[] {
  const inOs = getCapabilities().openInOs;
  return [
    { type: 'item', id: 'open', label: 'Open', icon: 'open', primary: true, run: () => actions.open(f) },
    { type: 'item', id: 'ask', label: 'Ask about this', icon: 'ask', run: () => askAbout(f) },
    { type: 'sep' },
    { type: 'item', id: 'rename', label: 'Rename', icon: 'rename', run: startRename },
    { type: 'item', id: 'copy', label: 'Make a copy', icon: 'copy', run: () => actions.duplicate(f) },
    // WHY only where the screen has a file manager (openInOs): on a phone or a remote browser the
    // shell call does nothing, so the item would be a click with no result (build-menu.ts does the same).
    ...(inOs ? [{ type: 'item' as const, id: 'reveal', label: 'View in folder', icon: 'folder' as const, run: () => viewInFolder(f) }] : []),
    { type: 'item', id: 'copy-path', label: 'Copy as path', icon: 'path', run: () => copyPath(f) },
    ...(actions.forget ? [{ type: 'sep' as const }, { type: 'item' as const, id: 'forget', label: 'Remove from Recent', icon: 'remove' as const, run: () => actions.forget!(f) }] : []),
  ];
}

// WHY a fill step on hover, not only a colour nudge (design guide §2.4 "Hover, press and focus").
const ROW_BUTTON =
  'shrink-0 w-7 h-7 rounded-md inline-flex items-center justify-center text-fg-muted hover:text-fg hover:bg-well active:bg-edge ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent coarse-hit cursor-pointer';

// WHY one right-hand slot shared by the time and the buttons (Destin, review 1 R-2: "fully right
// aligned and replace the changed/opened … text while on hover", with a polished fade): the time
// fades out as the buttons fade and slide in, in the same place, so the row never reflows. Only
// opacity and transform move (performance rule 6); motion-reduce keeps the swap but drops the
// slide. On touch (no hover) the buttons stay and the time gives way to them (narrow-viewport rule).
const SLOT_FADE = 'transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none';
const TIME_CLASS =
  `absolute inset-y-0 right-0 flex items-center whitespace-nowrap text-2xs text-fg-muted ${SLOT_FADE} ` +
  'group-hover:opacity-0 group-focus-within:opacity-0 pointer-coarse:opacity-0';
const BUTTONS_CLASS =
  `absolute inset-y-0 right-0 flex items-center gap-0.5 ${SLOT_FADE} ` +
  'opacity-0 translate-x-1 pointer-events-none ' +
  'group-hover:opacity-100 group-hover:translate-x-0 group-hover:pointer-events-auto ' +
  'group-focus-within:opacity-100 group-focus-within:translate-x-0 group-focus-within:pointer-events-auto ' +
  'pointer-coarse:opacity-100 pointer-coarse:translate-x-0 pointer-coarse:pointer-events-auto motion-reduce:translate-x-0';

function MoreGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

function RowButton({ label, onClick, children, ...rest }: { label: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; children: React.ReactNode } & React.AriaAttributes) {
  return (
    <Tooltip text={label}>
      <button type="button" aria-label={label} className={ROW_BUTTON} onClick={(e) => { e.stopPropagation(); onClick(e); }} {...rest}>
        {children}
      </button>
    </Tooltip>
  );
}

export const OfficeFileRow = memo(function OfficeFileRow({ f, verb, when, actions, startRenaming = false, startMenu = false, pointed = false }: {
  f: OfficeFile; verb: string; when: string; actions: OfficeRowActions;
  /** Photo-only: the rename popup opens over this row (shoot's `office/rename`). */
  startRenaming?: boolean;
  /** Photo-only: the row opens with its menu showing (shoot's `office/home#menu`). */
  startMenu?: boolean;
  /** Photo-only: the row drawn as it is under the pointer (shoot's `office/home#hover`) — a still
   *  picture cannot hover. The same look hover gives, nothing more. */
  pointed?: boolean;
}) {
  const [renaming, setRenaming] = useState(startRenaming);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const inOs = getCapabilities().openInOs;
  const openMenuAt = (x: number, y: number) => setMenu({ x, y });
  useEffect(() => {
    if (!startMenu || !rowRef.current) return;
    const r = rowRef.current.getBoundingClientRect();
    setMenu({ x: r.right - 200, y: r.bottom - 6 });
  }, [startMenu]);

  return (
    <>
      <div
        ref={rowRef}
        role="button"
        tabIndex={0}
        aria-label={f.name}
        onClick={() => actions.open(f)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); actions.open(f); }
          // The keyboard way to the menu (and the rename shortcut every file manager has).
          if (e.key === 'F2') { e.preventDefault(); setRenaming(true); }
          if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            openMenuAt(r.left + 40, r.bottom - 4);
          }
        }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openMenuAt(e.clientX, e.clientY); }}
        className={`group flex items-center gap-3 h-11 px-2 rounded-md cursor-pointer text-left hover:bg-inset active:bg-edge focus:outline-none focus-visible:ring-2 focus-visible:ring-accent select-none ${pointed ? 'bg-inset' : ''}`}
      >
        <OfficeKindGlyph kind={f.kind} className="w-4 h-4 shrink-0 text-fg-2" />
        <div className="min-w-0 flex-1">
          <div className="text-sm text-fg truncate">{f.name}</div>
          <div className="text-2xs text-fg-muted truncate">{f.folder}</div>
        </div>
        {/* The time and the buttons share this one slot, right-aligned (see SLOT_FADE). */}
        <div className="relative shrink-0 w-32 h-7">
          {/* Says WHICH time it is: Recent shows when you opened it, the project list when it changed (U3). */}
          <span className={`${TIME_CLASS} ${pointed ? '!opacity-0' : ''}`}>{verb} {when}</span>
          <div className={`${BUTTONS_CLASS} ${pointed ? '!opacity-100 !translate-x-0' : ''}`}>
            <RowButton label="Ask about this" onClick={() => askAbout(f)}><MenuIcon name="ask" /></RowButton>
            <RowButton label="Rename" onClick={() => setRenaming(true)}><MenuIcon name="rename" /></RowButton>
            {inOs && <RowButton label="View in folder" onClick={() => viewInFolder(f)}><MenuIcon name="folder" /></RowButton>}
            <RowButton label="More" aria-haspopup="menu" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openMenuAt(r.left, r.bottom + 4); }}><MoreGlyph /></RowButton>
          </div>
        </div>
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} anchor={rowRef.current ?? undefined}
          entries={menuFor(f, actions, () => setRenaming(true))} onClose={() => setMenu(null)} />
      )}
      {/* WHY outside the row: the popup is portalled, but React still bubbles its clicks up the
          component tree — inside the row, every click in it would also open the file. */}
      {renaming && <RenameFileDialog f={f} actions={actions} onClose={() => { setRenaming(false); rowRef.current?.focus(); }} />}
    </>
  );
});

/** Rename, as a session is renamed (Destin, review 1 R-2/R-4: "more like session renaming";
 *  SessionRenameDialog.tsx): a small popup with the name field, Save over Cancel. Only the name
 *  before the ending is typed — .docx stays, so the file keeps opening in Office. */
function RenameFileDialog({ f, actions, onClose }: { f: OfficeFile; actions: OfficeRowActions; onClose: () => void }) {
  const [draft, setDraft] = useState(stem(f.name));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const ending = ext(f.name);
  const save = async () => {
    const next = draft.trim();
    if (!next || saving) return;
    if (next === stem(f.name)) { onClose(); return; }
    setSaving(true); setError(null);
    const why = await actions.rename(f, `${next}${ending}`);
    if (!alive.current) return;
    setSaving(false);
    // WHY the popup stays on a refusal: the typed name is kept and the reason shows above it,
    // so a rename never silently does nothing.
    if (why) { setError(why); return; }
    onClose();
  };
  return (
    <Dialog open screen="office/rename" title="Rename file" size="panel" layer={3} onClose={() => { if (!saving) onClose(); }}>
      {error && <ErrorState message={error} onRetry={() => void save()} variant="inline" />}
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <OneJobCard actions={<>
          <Button type="submit" disabled={saving || !draft.trim()}>{saving ? 'Saving…' : 'Save'}</Button>
          <Button variant="secondary" type="button" disabled={saving} onClick={onClose}>Cancel</Button>
        </>}>
          <div>
            <OneJobLabel htmlFor="office-file-name">File name</OneJobLabel>
            <TextInput id="office-file-name" value={draft} disabled={saving} onChange={(e) => { setDraft(e.target.value); setError(null); }}
              autoFocus onFocus={(e) => e.currentTarget.select()} maxLength={200} className="w-full" />
            {ending && <OneJobHint>Keeps its {ending} ending, so it still opens in Office.</OneJobHint>}
          </div>
        </OneJobCard>
      </form>
    </Dialog>
  );
}
