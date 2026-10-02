import React, { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { isAndroid } from '../platform';
import { useSkills } from '../state/skill-context';
import type { ChipConfig } from '../../shared/types';
import { Button, CARD_LEVEL_1, Dialog, SectionLabel, SettingRow, TextInput, Textarea, Toggle, Tooltip } from './ui';
import { useScrollFade } from '../hooks/useScrollFade';
import { useEscClose } from '../hooks/use-esc-close';
import { useScreenOpen } from '../shoot-mode';

// Pencil SVG icon — matches the one used in StatusBar.tsx
function PencilIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M12.146.854a.5.5 0 0 1 .708 0l2.292 2.292a.5.5 0 0 1 0 .708l-9.5 9.5a.5.5 0 0 1-.168.11l-4 1.5a.5.5 0 0 1-.638-.638l1.5-4a.5.5 0 0 1 .11-.168l9.5-9.5zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5z"/>
    </svg>
  );
}

export interface QuickChip {
  label: string;
  prompt: string;
}

interface Props {
  onChipTap: (chip: QuickChip) => void;
}

export default function QuickChips({ onChipTap }: Props) {
  const { chips, setChips, installed } = useSkills();
  const [editorOpen, setEditorOpen] = useState(false);
  // photo-only build: `shoot` opens it by name, and its two pages as subpages.
  const [screenSub, setScreenSub] = useState<string | undefined>();
  useScreenOpen('chat/quick-chips', (sub) => { setEditorOpen(true); setScreenSub(sub); }, ['edit', 'add']);

  // The store is the only source. There is deliberately no hardcoded fallback
  // list here: one used to stand in whenever `chips` was empty, which conflated
  // "still loading" with "the user deleted every chip" — the row painted seven
  // built-in chips that the editor, which reads the real store list, could not
  // see or edit. Empty renders empty; the pencil holds the row's height, so
  // nothing shifts when the chips arrive.
  // A chip "set aside" in the editor stays saved but off the row (pick-menus-4#PM4-1).
  const displayChips: QuickChip[] = chips.filter(c => !c.hidden).map(c => ({ label: c.label, prompt: c.prompt }));

  // Outside-click dismissal now handled by the <Scrim> inside ChipEditorPopup.

  // Close on Escape — routed through the central useEscClose LIFO stack. The
  // EscCloseProvider runs in capture phase and calls stopPropagation itself,
  // so the previous capture-phase + stopPropagation workaround is no longer
  // needed; LIFO stack ordering ensures the editor pops first when topmost.
  const handleEditorClose = useCallback(() => setEditorOpen(false), [setEditorOpen]);
  useEscClose(editorOpen, handleEditorClose);

  const android = isAndroid();
  const chipHeight = android ? 'h-8' : 'h-6';
  const pencilSize = android ? 'w-8 h-8' : 'w-6 h-6';

  return (
    // select-none: quick chips are chrome, not highlightable or copyable
    // (Destin, 2026-09-10). The chip editor is a portaled Dialog, unaffected.
    <div className="relative select-none">
      <div className="flex gap-1 px-3 py-1 overflow-x-auto scrollbar-none items-center">
        {displayChips.map((chip, i) => (
          <button
            key={`${i}-${chip.label}`}
            onClick={() => onChipTap(chip)}
            // `quick-chip` is the hook chrome-style: 'float' hangs its per-chip
            // lift on (globals.css → "FLOAT chrome"). A class, not a token: the
            // rule needs the element, and Tailwind has no way to name "the chip".
            className={`quick-chip shrink-0 ${chipHeight} px-2.5 rounded-md bg-panel border border-edge-dim text-2xs text-fg-2 hover:bg-inset hover:text-fg transition-colors`}
          >
            {chip.label}
          </button>
        ))}

        {/* Pencil button — opens chip editor */}
        <Tooltip text="Edit quick chips">
        <button
          onClick={() => setEditorOpen(!editorOpen)}
          // `quick-chip-edit`: float chrome gives it the chips' own surface, as
          // the status bar's edit button shares its chips' surface.
          className={`quick-chip-edit shrink-0 ${pencilSize} rounded-md bg-well border border-edge-dim text-fg-muted hover:bg-inset hover:text-fg transition-colors flex items-center justify-center`}
        >
          <PencilIcon size={android ? 12 : 10} />
        </button>
        </Tooltip>
      </div>

      {/* Chip editor popup — centered L2 modal (Scrim + OverlayPanel) to match
          the StatusBar widget config popup. */}
      <ChipEditorPopup
        open={editorOpen}
        chips={chips}
        setChips={setChips}
        installed={installed}
        screenSub={screenSub}
        onClose={() => setEditorOpen(false)}
      />
    </div>
  );
}

// ── Chip Editor Popup ──────────────────────────────────────────────────────
//
// WHY this shape (pick-menus-3#PM3-1 → pick-menus-4#PM4-1, Destin 2026-10-01): the
// chips are drawn as chips, on two shelves — "Shown above the message box" and "Set
// aside" (kept, not shown) — and you drag a chip between them or along a shelf.
// Pointing at a chip shows its pencil (always shown on touch, .touch-reveal); the
// pencil opens an edit page in the same popup, with the Dialog's own back arrow.
// Page buttons: Remove (red) far left, Cancel then Save on the right.

interface ChipEditorProps {
  open: boolean;
  chips: ChipConfig[];
  setChips: (chips: ChipConfig[]) => Promise<void>;
  installed: import('../../shared/types').SkillEntry[];
  /** Photo-only build: which page `shoot` asked for ('edit' / 'add'). */
  screenSub?: string;
  onClose: () => void;
}

type View = { kind: 'list' } | { kind: 'edit'; idx: number } | { kind: 'add' };

const MAX_CHIPS = 10;

function ChipEditorPopup({ open, chips, setChips, installed, screenSub, onClose }: ChipEditorProps) {
  const [view, setView] = useState<View>({ kind: 'list' });
  const [label, setLabel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [shown, setShown] = useState(true);
  const toList = useCallback(() => setView({ kind: 'list' }), []);

  const beginEdit = useCallback((idx: number) => {
    const chip = chips[idx];
    if (!chip) return;
    setLabel(chip.label); setPrompt(chip.prompt); setShown(!chip.hidden);
    setView({ kind: 'edit', idx });
  }, [chips]);
  const beginAdd = useCallback(() => {
    setLabel(''); setPrompt(''); setShown(true);
    setView({ kind: 'add' });
  }, []);

  const canSave = !!label.trim() && !!prompt.trim();
  const save = useCallback(() => {
    if (!canSave) return;
    const fields = { label: label.trim(), prompt: prompt.trim(), hidden: shown ? undefined : true };
    if (view.kind === 'edit') {
      // Spread the existing chip so skillId survives — the uninstall cascade
      // matches on it, so a tuned skill chip must stay bound to its skill.
      setChips(chips.map((c, i) => (i === view.idx ? clean({ ...c, ...fields }) : c)));
    } else if (view.kind === 'add' && chips.length < MAX_CHIPS) {
      setChips([...chips, clean(fields)]);
    }
    toList();
  }, [canSave, label, prompt, shown, view, chips, setChips, toList]);

  const remove = useCallback((idx: number) => {
    setChips(chips.filter((_, i) => i !== idx));
    toList();
  }, [chips, setChips, toList]);

  const addFromSkill = useCallback((skill: import('../../shared/types').SkillEntry) => {
    if (chips.length >= MAX_CHIPS) return;
    setChips([...chips, { skillId: skill.id, label: skill.displayName || skill.id, prompt: skill.prompt || `/${skill.id}` }]);
    toList();
  }, [chips, setChips, toList]);

  // Skills not already on a chip, for the add page's picker.
  const chipSkillIds = useMemo(() => new Set(chips.map(c => c.skillId).filter(Boolean)), [chips]);
  const availableSkills = useMemo(() => installed.filter(s => !chipSkillIds.has(s.id)), [installed, chipSkillIds]);
  const skillPickerRef = useScrollFade<HTMLDivElement>();

  // Photo-only build: open the page `shoot` named, once the chips have loaded.
  useEffect(() => {
    if (screenSub === 'edit' && chips.length > 1) beginEdit(1);
    else if (screenSub === 'add') beginAdd();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per request
  }, [screenSub, chips.length > 1]);

  // Esc on a page goes back to the shelves before it closes the popup (LIFO stack).
  useEscClose(open && view.kind !== 'list', toList);

  const drag = useChipDrag(chips, setChips);

  if (!open) return null;

  if (view.kind !== 'list') {
    const editing = view.kind === 'edit' ? chips[view.idx] : null;
    return createPortal(
      <Dialog screen={view.kind === 'edit' ? 'chat/quick-chips/edit' : 'chat/quick-chips/add'} open onClose={onClose}
        onBack={toList} title={editing ? `Edit “${editing.label}”` : 'Add a chip'} size="panel">
        <div className={`${CARD_LEVEL_1} p-3 space-y-1.5`}>
          <TextInput size="sm" value={label} onChange={(e) => setLabel(e.target.value.slice(0, 20))}
            placeholder="Label (max 20 characters)" aria-label="Chip label" className="w-full" autoFocus />
          <Textarea size="sm" value={prompt} onChange={(e) => setPrompt(e.target.value.slice(0, 500))}
            placeholder="What the chip sends" rows={3} aria-label="Chip prompt" className="w-full" />
        </div>
        <div className={`${CARD_LEVEL_1} px-3 py-1`}>
          <SettingRow header variant="item" title="Show above the message box" description="Off keeps it here, set aside"
            control={<Toggle checked={shown} onChange={setShown} aria-label="Show above the message box" />} />
        </div>
        {view.kind === 'add' && availableSkills.length > 0 && (
          <section>
            <SectionLabel className="mb-2">Or use an installed skill</SectionLabel>
            <div ref={skillPickerRef} className={`${CARD_LEVEL_1} scroll-fade max-h-40 p-1`}>
              {availableSkills.map(skill => (
                <button key={skill.id} type="button" onClick={() => addFromSkill(skill)}
                  className="w-full text-left px-2 py-1.5 text-xs text-fg-2 hover:text-fg hover:bg-inset rounded-sm transition-colors">
                  {skill.displayName || skill.id}
                </button>
              ))}
            </div>
          </section>
        )}
        <div className="flex items-center gap-2">
          {view.kind === 'edit' && <Button variant="danger" size="sm" onClick={() => remove(view.idx)}>Remove</Button>}
          <span className="flex-1" />
          <Button variant="secondary" size="sm" onClick={toList}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={!canSave}>{view.kind === 'edit' ? 'Save' : 'Add'}</Button>
        </div>
      </Dialog>,
      document.body,
    );
  }

  const shelf = (hidden: boolean) => chips.map((c, i) => ({ c, i })).filter(({ c }) => !!c.hidden === hidden);
  const renderShelf = (hidden: boolean, title: string, empty: string) => {
    const items = shelf(hidden);
    return (
      <section>
        <SectionLabel className="mb-2">{title}</SectionLabel>
        <div data-shelf={hidden ? 'aside' : 'shown'}
          className={`${CARD_LEVEL_1} p-3 flex flex-wrap gap-1.5 min-h-12 transition-colors ${drag.overShelf === (hidden ? 'aside' : 'shown') ? 'border-accent' : ''}`}>
          {items.length === 0 && <span className="text-3xs text-fg-muted self-center">{empty}</span>}
          {items.map(({ c, i }) => (
            <span key={i} data-chip-idx={i}
              onPointerDown={(e) => drag.down(e, i)} onPointerMove={drag.move} onPointerUp={drag.up} onPointerCancel={drag.up}
              className={`group/chip h-7 pl-2.5 pr-1 rounded-md bg-panel border inline-flex items-center gap-1 text-2xs select-none touch-none cursor-grab transition-opacity ${
                hidden ? 'border-dashed border-edge-dim text-fg-muted' : 'border-edge-dim text-fg-2'} ${drag.dragIdx === i ? 'opacity-30' : ''}`}>
              {c.label}
              <button type="button" aria-label={`Edit ${c.label}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); if (!drag.suppressClick.current) beginEdit(i); }}
                className="touch-reveal w-5 h-5 rounded-sm flex items-center justify-center text-fg-faint opacity-0 group-hover/chip:opacity-100 focus-visible:opacity-100 hover:text-fg hover:bg-inset transition-opacity">
                <PencilIcon size={9} />
              </button>
            </span>
          ))}
        </div>
      </section>
    );
  };

  return createPortal(
    <>
      <Dialog screen="chat/quick-chips" open onClose={onClose} title="Edit quick chips" size="panel">
        {renderShelf(false, 'Shown above the message box', 'Drag a chip here to show it')}
        {renderShelf(true, 'Set aside', 'Drag a chip here to keep it without showing it')}
        <p className="text-3xs text-fg-muted">Drag a chip between the two to show or hide it, or along a shelf to reorder. The pencil on a chip edits it.</p>
        {chips.length < MAX_CHIPS
          ? <Button variant="secondary" size="sm" className="w-full" onClick={beginAdd}>+ Add a chip</Button>
          : <p className="text-3xs text-fg-muted text-center">Maximum {MAX_CHIPS} chips reached</p>}
      </Dialog>
      {drag.ghost && (
        <div className="fixed z-[9999] pointer-events-none rounded-md px-2.5 h-7 inline-flex items-center bg-inset border border-edge shadow-lg shadow-black/40 text-2xs font-medium text-fg"
          style={{ left: drag.ghost.x, top: drag.ghost.y, transform: 'translate(-50%, -50%) scale(1.05)' }}>
          {drag.ghost.label}
        </div>
      )}
    </>,
    document.body,
  );
}

/** Drop the `hidden` key when false so a shown chip stores exactly as before. */
function clean(c: ChipConfig): ChipConfig {
  const { hidden, ...rest } = c;
  return hidden ? { ...rest, hidden: true } : rest;
}

/** Pointer drag across the two shelves. A press that moves under 5px is a click.
 *  On drop: over a chip → land before it (or after it, right half), taking that
 *  chip's shelf; over a shelf's empty space → the end of that shelf. */
function useChipDrag(chips: ChipConfig[], setChips: (c: ChipConfig[]) => Promise<void>) {
  const origin = useRef<{ x: number; y: number; idx: number } | null>(null);
  const suppressClick = useRef(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null);
  const [overShelf, setOverShelf] = useState<'shown' | 'aside' | null>(null);

  const hit = (x: number, y: number) => {
    const el = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null;
    const chipEl = el?.closest<HTMLElement>('[data-chip-idx]') ?? null;
    const shelfEl = el?.closest<HTMLElement>('[data-shelf]') ?? null;
    return { chipEl, shelf: (shelfEl?.dataset.shelf as 'shown' | 'aside' | undefined) ?? null };
  };

  const down = (e: React.PointerEvent, idx: number) => {
    if (e.button !== 0) return;
    origin.current = { x: e.clientX, y: e.clientY, idx };
    suppressClick.current = false;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    const o = origin.current;
    if (!o) return;
    if (dragIdx === null) {
      if (Math.abs(e.clientX - o.x) < 5 && Math.abs(e.clientY - o.y) < 5) return;
      setDragIdx(o.idx);
      suppressClick.current = true;
    }
    setGhost({ x: e.clientX, y: e.clientY, label: chips[o.idx]?.label ?? '' });
    setOverShelf(hit(e.clientX, e.clientY).shelf);
  };
  const up = (e: React.PointerEvent) => {
    const o = origin.current;
    origin.current = null;
    const wasDragging = dragIdx !== null;
    setDragIdx(null); setGhost(null); setOverShelf(null);
    if (!o || !wasDragging) return;
    const { chipEl, shelf } = hit(e.clientX, e.clientY);
    if (!shelf) return;
    const moving = { ...chips[o.idx], hidden: shelf === 'aside' };
    const rest = chips.filter((_, i) => i !== o.idx);
    let at = rest.length;
    if (chipEl) {
      const target = parseInt(chipEl.dataset.chipIdx!, 10);
      if (target !== o.idx) {
        const r = chipEl.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        const t = rest.indexOf(chips[target]);
        at = after ? t + 1 : t;
      }
    }
    rest.splice(at, 0, clean(moving));
    setChips(rest);
  };
  return { down, move, up, dragIdx, ghost, overShelf, suppressClick };
}
