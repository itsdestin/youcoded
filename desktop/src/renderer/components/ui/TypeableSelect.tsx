import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { OverlayPanel as PopoverPanel } from '../overlays/Overlay';
import { fieldClasses } from './field';
import { useEscClose } from '../../hooks/use-esc-close';
import type { SelectOption } from './Select';

export interface TypeableSelectProps {
  options: readonly SelectOption[];
  value: string;
  /** Return false to reject a typed draft and restore the controlled value. */
  onCommit: (value: string) => boolean | void;
  disabled?: boolean;
  placeholder?: string;
  'aria-label': string;
  /** Search mode: the box shows the chosen option's LABEL, and typing narrows the list to the
   *  options this returns true for. WHY (custom-providers, 2026-10-20): Add provider offers ~200
   *  services — a list you can only scroll is unusable at that length, and a caller decides what
   *  "matches" (an "Other address…" row must survive every query). Absent = the original
   *  behaviour: the box shows the raw value and the whole list always shows. */
  filter?: (option: SelectOption, query: string) => boolean;
}

export function TypeableSelect({ options, value, onCommit, disabled, placeholder = 'None', 'aria-label': label, filter }: TypeableSelectProps) {
  const labelOf = (v: string) => (filter ? options.find((o) => o.value === v)?.label ?? v : v);
  const [draft, setDraft] = useState(labelOf(value));
  // In search mode the list narrows to the typed words — but only once they differ from the
  // chosen option's label, so reopening the box shows the whole list again.
  const shownFor = (text: string): readonly SelectOption[] => {
    const q = text.trim().toLowerCase();
    return filter && q && text !== labelOf(value) ? options.filter((o) => filter(o, q)) : options;
  };
  const shown = shownFor(draft);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(shown.findIndex((o) => o.value === value && !o.disabled));
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const [rect, setRect] = useState({ left: 0, top: 0, width: 0 });

  const measure = () => {
    const r = inputRef.current?.getBoundingClientRect();
    if (!r) return;
    const margin = 8;
    const left = Math.min(Math.max(r.left, margin), Math.max(margin, window.innerWidth - r.width - margin));
    setRect({ left, top: r.bottom + 4, width: r.width });
  };
  const restore = () => { setDraft(labelOf(value)); setOpen(false); };

  useEffect(() => setDraft(labelOf(value)), [value]);
  // WHY on the app's Escape stack (shoot --check, 2026-10-20): the box's own keydown ran
  // after the popup's capture-phase listener, so Escape on an open list closed the whole
  // Settings dialog instead of just the list. Select.tsx registers the same way.
  useEscClose(open && !disabled, () => restore());
  useEffect(() => { if (disabled) restore(); }, [disabled, value]);
  useLayoutEffect(() => {
    if (!open) return;
    measure();
    const selected = shown.findIndex((option) => option.value === value && !option.disabled);
    const first = shown.findIndex((option) => !option.disabled);
    setActive(selected >= 0 ? selected : first);
  }, [open, options, value, shown.length]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const node = event.target as Node;
      if (!inputRef.current?.contains(node) && !menuRef.current?.contains(node)) restore();
    };
    window.addEventListener('mousedown', close, true);
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open, value]);

  const commitValue = (next: string) => {
    setOpen(false);
    // WHY the parent owns validation: arbitrary positive values are valid even
    // when absent from the preset menu, while rejected drafts must visibly undo.
    if (onCommit(next) === false) setDraft(labelOf(value));
    else setDraft(labelOf(next));
  };
  const commitOption = (index: number, list: readonly SelectOption[] = shown) => {
    const option = list[index];
    if (!option || option.disabled) return;
    commitValue(option.value);
  };
  const step = (direction: 1 | -1) => {
    const start = active >= 0 ? active : (direction === 1 ? -1 : 0);
    for (let n = 1; n <= shown.length; n++) {
      const index = (start + direction * n + shown.length * n) % shown.length;
      if (!shown[index]?.disabled) return index;
    }
    return active;
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { restore(); return; }
    if (event.key === 'Tab') { restore(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setActive(step(event.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      // WHY read the DOM value: change + Enter can arrive before React rerenders,
      // and committing the render's stale draft would silently restore the preset.
      const currentDraft = event.currentTarget.value;
      if (filter) {
        // Search mode picks from the list, never commits the typed words: narrow with the
        // DOM's text (same stale-render reason as above) and take the highlighted row.
        const list = shownFor(currentDraft);
        const at = active >= 0 && active < list.length && !list[active]?.disabled ? active : list.findIndex((o) => !o.disabled);
        if (at >= 0) commitOption(at, list); else restore();
        return;
      }
      const exact = options.findIndex((option) => option.value === currentDraft && !option.disabled);
      if (open && currentDraft === value) commitOption(active);
      else if (exact >= 0) commitOption(exact);
      else commitValue(currentDraft);
    }
  };

  return <div className="relative w-full">
    <input ref={inputRef} role="combobox" aria-label={label} aria-expanded={open} aria-autocomplete="list"
      aria-controls={open ? listboxId : undefined} aria-activedescendant={open && active >= 0 ? `${listboxId}-${active}` : undefined}
      disabled={disabled} placeholder={placeholder} value={draft}
      onFocus={() => { if (!disabled) setOpen(true); }}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (!next || (!inputRef.current?.contains(next) && !menuRef.current?.contains(next))) restore();
      }}
      onChange={(event) => { setDraft(event.target.value); setOpen(true); }} onKeyDown={onKeyDown}
      className={fieldClasses('md', 'w-full')} />
    {open && !disabled && createPortal(
      // WHY custom: native option menus cannot follow YouCoded's active theme.
      // WHY the list scrolls on the inner listbox (2026-10-15, the one scroll fade): the panel is
      // .layer-surface, whose unlayered `overflow: hidden` beat the Tailwind overflow-y-auto that
      // sat on it, so a long option list was clipped instead of scrolled (Select.tsx's note). The
      // listbox now scrolls and fades its edges, like Select's.
      // WHY the same corner, rows and selected look as Select.tsx (custom-providers-review-1#R-2,
      // Destin: "this popup menu/background/rounding seems a bit odd… not consistent with other
      // menus"): this menu took the popup's own large corner and never marked the chosen row.
      <PopoverPanel ref={menuRef} layer={4} data-select-portal="" className="fixed max-h-64 flex flex-col"
        style={{ ...rect, borderRadius: 'var(--radius-lg)' }}>
        <div id={listboxId} role="listbox" aria-label={label} className="scroll-mask min-h-0 p-1 overflow-y-auto">{shown.map((option, index) => <div id={`${listboxId}-${index}`} key={option.value || 'none'} role="option"
          aria-selected={option.value === value} aria-disabled={option.disabled || undefined}
          onMouseEnter={() => { if (!option.disabled) setActive(index); }} onMouseDown={(event) => event.preventDefault()}
          onClick={() => commitOption(index)} className={[
            'px-2.5 py-1.5 coarse-roomy rounded-md text-2xs truncate',
            option.disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
            option.value === value
              ? 'bg-accent text-on-accent font-medium'
              : `text-fg-2 ${index === active && !option.disabled ? 'bg-inset' : ''}`,
          ].join(' ')}>
          {option.label}
        </div>)}</div>
      </PopoverPanel>, document.body)}
  </div>;
}
