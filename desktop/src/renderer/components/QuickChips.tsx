import React, { useState, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { isAndroid } from '../platform';
import { useSkills } from '../state/skill-context';
import type { ChipConfig } from '../../shared/types';
import { Scrim, OverlayPanel } from './overlays/Overlay';
import { useScrollFade } from '../hooks/useScrollFade';
import { useEscClose } from '../hooks/use-esc-close';

// Pencil SVG icon — matches the one used in StatusBar.tsx
function PencilIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M12.146.854a.5.5 0 0 1 .708 0l2.292 2.292a.5.5 0 0 1 0 .708l-9.5 9.5a.5.5 0 0 1-.168.11l-4 1.5a.5.5 0 0 1-.638-.638l1.5-4a.5.5 0 0 1 .11-.168l9.5-9.5zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5z"/>
    </svg>
  );
}

// Drag grip (6-dot braille) — mirrors SessionStrip's DragGrip
function DragGrip() {
  return (
    <svg className="w-3 h-3 text-fg-faint" viewBox="0 0 12 16" fill="currentColor">
      <circle cx="3.5" cy="2" r="1.2" />
      <circle cx="8.5" cy="2" r="1.2" />
      <circle cx="3.5" cy="8" r="1.2" />
      <circle cx="8.5" cy="8" r="1.2" />
      <circle cx="3.5" cy="14" r="1.2" />
      <circle cx="8.5" cy="14" r="1.2" />
    </svg>
  );
}

export interface QuickChip {
  label: string;
  prompt: string;
}

// Fallback defaults if no config exists yet
export const defaultChips: QuickChip[] = [
  { label: 'Journal', prompt: "let's journal" },
  { label: 'Inbox', prompt: 'check my inbox' },
  { label: 'Git Status', prompt: "run git status and summarize what's changed" },
  { label: 'Review PR', prompt: 'review the latest PR on this repo' },
  { label: 'Fix Tests', prompt: 'run the tests and fix any failures' },
  { label: 'Briefing', prompt: 'brief me on ' },
  { label: 'Draft Text', prompt: 'help me draft a text to ' },
];

interface Props {
  onChipTap: (chip: QuickChip) => void;
}

export default function QuickChips({ onChipTap }: Props) {
  const { chips, setChips, installed } = useSkills();
  const [editorOpen, setEditorOpen] = useState(false);

  const displayChips: QuickChip[] = chips.length > 0
    ? chips.map(c => ({ label: c.label, prompt: c.prompt }))
    : defaultChips;

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
    <div className="relative">
      <div className="flex gap-1 px-3 py-1 overflow-x-auto scrollbar-none items-center">
        {displayChips.map((chip) => (
          <button
            key={chip.label}
            onClick={() => onChipTap(chip)}
            className={`shrink-0 ${chipHeight} px-2.5 rounded-md bg-panel border border-edge-dim text-[11px] text-fg-2 hover:bg-inset hover:text-fg transition-colors`}
          >
            {chip.label}
          </button>
        ))}

        {/* Pencil button — opens chip editor */}
        <button
          onClick={() => setEditorOpen(!editorOpen)}
          className={`shrink-0 ${pencilSize} rounded-md bg-well border border-edge-dim text-fg-muted hover:bg-inset hover:text-fg transition-colors flex items-center justify-center`}
          title="Edit quick chips"
        >
          <PencilIcon size={android ? 12 : 10} />
        </button>
      </div>

      {/* Chip editor popup — centered L2 modal (Scrim + OverlayPanel) to match
          the StatusBar widget config popup. */}
      <ChipEditorPopup
        open={editorOpen}
        chips={chips}
        setChips={setChips}
        installed={installed}
        onClose={() => setEditorOpen(false)}
      />
    </div>
  );
}

// ── Chip Editor Popup ──────────────────────────────────────────────────────

interface ChipEditorProps {
  open: boolean;
  chips: ChipConfig[];
  setChips: (chips: ChipConfig[]) => Promise<void>;
  installed: import('../../shared/types').SkillEntry[];
  onClose: () => void;
}

// Centered L2 modal — matches StatusBar WidgetConfigPopup so popup styling
// (scrim, surface, blur, shadow) stays theme-driven and consistent.
function ChipEditorPopup({ open, chips, setChips, installed, onClose }: ChipEditorProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [customLabel, setCustomLabel] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');

  // Skills not already assigned to a chip
  const chipSkillIds = useMemo(() => new Set(chips.map(c => c.skillId).filter(Boolean)), [chips]);
  const availableSkills = useMemo(
    () => installed.filter(s => !chipSkillIds.has(s.id)),
    [installed, chipSkillIds]
  );

  const remove = useCallback((index: number) => {
    setChips(chips.filter((_, i) => i !== index));
  }, [chips, setChips]);

  // ── Pointer-event drag-to-reorder (mirrors SessionStrip pattern) ────────
  // List is vertical, so hit-testing is Y-based and the insertion indicator
  // is a horizontal bar drawn in the gap between rows.
  const listRef = useRef<HTMLDivElement>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [dragLabel, setDragLabel] = useState<string>('');
  const [ghostTarget, setGhostTarget] = useState<{ left: number; top: number; width: number } | null>(null);
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const isDragging = useRef(false);
  const suppressClick = useRef(false);
  // Scroll-fade: header stays outside scroll region; body mask shows fade edges.
  const bodyRef = useScrollFade<HTMLDivElement>();
  const skillPickerRef = useScrollFade<HTMLDivElement>();

  const handlePointerDown = useCallback((e: React.PointerEvent, idx: number) => {
    if (e.button !== 0) return;
    dragOrigin.current = { x: e.clientX, y: e.clientY };
    isDragging.current = false;
    setDragIdx(idx);
    setDragLabel(chips[idx]?.label || '');
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [chips]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (dragIdx === null || !dragOrigin.current) return;

    // 5px threshold so a plain click doesn't register as a drag
    if (!isDragging.current) {
      const dx = e.clientX - dragOrigin.current.x;
      const dy = e.clientY - dragOrigin.current.y;
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      isDragging.current = true;
      suppressClick.current = true;
    }

    setDragPos({ x: e.clientX, y: e.clientY });

    // Hit-test: nearest row by vertical distance (X-independent)
    const list = listRef.current;
    if (!list) return;
    const els = list.querySelectorAll('[data-chip-idx]');

    let closest: number | null = null;
    let closestDist = Infinity;
    const rowRects: { idx: number; rect: DOMRect }[] = [];
    els.forEach(el => {
      const idx = parseInt((el as HTMLElement).dataset.chipIdx!, 10);
      const rect = el.getBoundingClientRect();
      rowRects.push({ idx, rect });
      const centerY = (rect.top + rect.bottom) / 2;
      const dist = Math.abs(e.clientY - centerY);
      if (idx !== dragIdx && dist < closestDist) {
        closestDist = dist;
        closest = idx;
      }
    });

    setOverIdx(closest);

    // Horizontal insertion bar in the gap above/below the target row
    if (closest !== null) {
      const targetIdx = closest;
      rowRects.sort((a, b) => a.idx - b.idx);
      const listRect = list.getBoundingClientRect();
      const target = rowRects.find(r => r.idx === targetIdx)!;
      let top: number;
      if (targetIdx < dragIdx) {
        const prev = rowRects.find(r => r.idx === targetIdx - 1);
        top = prev ? (prev.rect.bottom + target.rect.top) / 2 : target.rect.top - 2;
      } else {
        const next = rowRects.find(r => r.idx === targetIdx + 1);
        top = next ? (target.rect.bottom + next.rect.top) / 2 : target.rect.bottom + 2;
      }
      setGhostTarget({ left: listRect.left, top, width: listRect.width });
    } else {
      setGhostTarget(null);
    }
  }, [dragIdx]);

  const handlePointerUp = useCallback(() => {
    if (dragIdx !== null && isDragging.current && overIdx !== null && overIdx !== dragIdx) {
      // Splice-move semantics (not swap) — matches the visual insertion indicator
      const next = [...chips];
      const [moved] = next.splice(dragIdx, 1);
      next.splice(overIdx, 0, moved);
      setChips(next);
    }
    setDragIdx(null);
    setOverIdx(null);
    setDragPos(null);
    setGhostTarget(null);
    dragOrigin.current = null;
    isDragging.current = false;
    setTimeout(() => { suppressClick.current = false; }, 0);
  }, [dragIdx, overIdx, chips, setChips]);

  const dragging = dragIdx !== null && isDragging.current && dragPos !== null;

  const addFromSkill = useCallback((skill: import('../../shared/types').SkillEntry) => {
    if (chips.length >= 10) return;
    setChips([...chips, {
      skillId: skill.id,
      label: skill.displayName || skill.id,
      prompt: skill.prompt || `/${skill.id}`,
    }]);
    setShowAddForm(false);
  }, [chips, setChips]);

  const addCustom = useCallback(() => {
    if (chips.length >= 10 || !customLabel.trim() || !customPrompt.trim()) return;
    setChips([...chips, { label: customLabel.trim(), prompt: customPrompt.trim() }]);
    setCustomLabel('');
    setCustomPrompt('');
    setShowAddForm(false);
  }, [chips, setChips, customLabel, customPrompt]);

  if (!open) return null;

  return createPortal(
    <>
      {/* Overlay layer L2 — theme-driven via Scrim/OverlayPanel. */}
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        layer={2}
        className="fixed flex flex-col"
        style={{
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(420px, 90vw)',
          maxHeight: '80vh',
        }}
      >
        {/* Header stays outside the scroll region so the fade mask
            never clips it. Matches PreferencesPopup/StatusBar pattern. */}
        <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-edge">
          <h2 className="text-sm font-bold text-fg">Edit Quick Chips</h2>
          <button
            onClick={onClose}
            className="text-fg-muted hover:text-fg-2 text-lg leading-none w-7 h-7 flex items-center justify-center rounded-sm hover:bg-inset"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div ref={bodyRef} className="scroll-fade">
          <div className="px-4 py-3 space-y-4">
            {/* Chip list — drag-to-reorder via pointer events (mirrors
                SessionStrip dropdown). Grip icon appears on hover; drop
                splices the row into the target position. */}
            {chips.length > 0 && (
              <div ref={listRef} className="space-y-1 relative">
                {chips.map((chip, i) => {
                  const isBeingDragged = dragIdx === i && isDragging.current;
                  return (
                    <div
                      key={i}
                      data-chip-idx={i}
                      onPointerDown={(e) => handlePointerDown(e, i)}
                      onPointerMove={handlePointerMove}
                      onPointerUp={handlePointerUp}
                      className={`group/row flex items-center gap-2 px-2 py-1.5 rounded-md bg-well border border-edge-dim text-[11px] select-none touch-none ${
                        isBeingDragged ? 'opacity-30' : ''
                      }`}
                      style={{
                        transition: 'opacity 150ms, background 150ms',
                        cursor: isAndroid() ? 'default' : 'grab',
                      }}
                    >
                      {/* Drag grip — visible on hover (desktop only) */}
                      <span className={`shrink-0 flex items-center transition-opacity ${isAndroid() ? 'hidden' : 'opacity-0 group-hover/row:opacity-100'}`}>
                        <DragGrip />
                      </span>
                      <span className="font-medium text-fg truncate flex-1">{chip.label}</span>
                      <span className="text-fg-faint truncate max-w-[100px]">{chip.prompt}</span>
                      <button
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => { if (!suppressClick.current) remove(i); }}
                        className="shrink-0 px-1 text-fg-muted hover:text-red-400"
                        title="Remove chip"
                      >
                        &times;
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Add chip button / form */}
            {chips.length < 10 && !showAddForm && (
              <button
                onClick={() => setShowAddForm(true)}
                className="w-full py-1.5 text-[11px] text-fg-muted border border-dashed border-edge-dim rounded-md hover:border-edge hover:text-fg transition-colors"
              >
                + Add Chip
              </button>
            )}

            {showAddForm && (
              <div className="bg-inset border border-edge-dim rounded-lg p-2.5 space-y-2">
                {/* Custom chip form */}
                <div className="space-y-1.5">
                  <input
                    value={customLabel}
                    onChange={(e) => setCustomLabel(e.target.value.slice(0, 20))}
                    placeholder="Label (max 20 chars)"
                    className="w-full px-2 py-1 text-[11px] bg-well border border-edge-dim rounded-md text-fg placeholder:text-fg-faint focus:outline-none focus:border-accent"
                  />
                  <textarea
                    value={customPrompt}
                    onChange={(e) => setCustomPrompt(e.target.value.slice(0, 500))}
                    placeholder="Prompt text"
                    rows={2}
                    className="w-full px-2 py-1 text-[11px] bg-well border border-edge-dim rounded-md text-fg placeholder:text-fg-faint focus:outline-none focus:border-accent resize-none"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={addCustom}
                      disabled={!customLabel.trim() || !customPrompt.trim()}
                      className="px-2 py-1 text-[10px] bg-accent text-on-accent rounded-md disabled:opacity-40"
                    >
                      Add Custom
                    </button>
                    <button onClick={() => setShowAddForm(false)} className="px-2 py-1 text-[10px] text-fg-muted hover:text-fg">Cancel</button>
                  </div>
                </div>

                {/* Divider + installed-skills picker */}
                {availableSkills.length > 0 && (
                  <>
                    <div className="border-t border-edge-dim" />
                    <p className="text-[10px] text-fg-faint font-medium">Or pick from installed skills:</p>
                    <div ref={skillPickerRef} className="scroll-fade max-h-32 space-y-0.5">
                      {availableSkills.map(skill => (
                        <button
                          key={skill.id}
                          onClick={() => addFromSkill(skill)}
                          className="w-full text-left px-2 py-1 text-[11px] text-fg-muted hover:text-fg hover:bg-well rounded-sm transition-colors"
                        >
                          {skill.displayName || skill.id}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {chips.length >= 10 && (
              <p className="text-[10px] text-fg-faint text-center">Maximum 10 chips reached</p>
            )}
          </div>
        </div>
      </OverlayPanel>

      {/* Insertion indicator — horizontal accent bar in the row gap */}
      {dragging && ghostTarget && (
        <div
          className="fixed z-[9998] pointer-events-none"
          style={{
            left: ghostTarget.left,
            top: ghostTarget.top,
            width: ghostTarget.width,
            transform: 'translateY(-50%)',
            transition: 'top 120ms cubic-bezier(0.34, 1.56, 0.64, 1)',
          }}
        >
          <div className="h-0.5 w-full rounded-full bg-accent" style={{ opacity: 0.8 }} />
        </div>
      )}

      {/* Floating drag ghost — follows cursor */}
      {dragging && dragPos && (
        <div
          className="fixed z-[9999] pointer-events-none flex items-center gap-1.5 rounded-md px-2.5 py-1 bg-inset border border-edge shadow-lg shadow-black/40"
          style={{
            left: dragPos.x,
            top: dragPos.y,
            transform: 'translate(-50%, -50%) scale(1.05)',
          }}
        >
          <DragGrip />
          <span className="text-[11px] font-medium text-fg whitespace-nowrap max-w-[180px] truncate">
            {dragLabel}
          </span>
        </div>
      )}
    </>,
    document.body,
  );
}
