import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { OverlayPanel as PopoverPanel } from '../overlays/Overlay';
import { fieldClasses } from './field';
import type { SelectOption } from './Select';

export interface TypeableSelectProps {
  options: readonly SelectOption[];
  value: string;
  /** Return false to reject a typed draft and restore the controlled value. */
  onCommit: (value: string) => boolean | void;
  disabled?: boolean;
  placeholder?: string;
  'aria-label': string;
}

export function TypeableSelect({ options, value, onCommit, disabled, placeholder = 'None', 'aria-label': label }: TypeableSelectProps) {
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(options.findIndex((o) => o.value === value && !o.disabled));
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
  const restore = () => { setDraft(value); setOpen(false); };

  useEffect(() => setDraft(value), [value]);
  useEffect(() => { if (disabled) restore(); }, [disabled, value]);
  useLayoutEffect(() => {
    if (!open) return;
    measure();
    const selected = options.findIndex((option) => option.value === value && !option.disabled);
    const first = options.findIndex((option) => !option.disabled);
    setActive(selected >= 0 ? selected : first);
  }, [open, options, value]);
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
    if (onCommit(next) === false) setDraft(value);
    else setDraft(next);
  };
  const commitOption = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    commitValue(option.value);
  };
  const step = (direction: 1 | -1) => {
    const start = active >= 0 ? active : (direction === 1 ? -1 : 0);
    for (let n = 1; n <= options.length; n++) {
      const index = (start + direction * n + options.length * n) % options.length;
      if (!options[index]?.disabled) return index;
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
      <PopoverPanel ref={menuRef} layer={4} data-select-portal="" className="fixed p-1 max-h-64 overflow-y-auto"
        style={rect}>
        <div id={listboxId} role="listbox" aria-label={label}>{options.map((option, index) => <div id={`${listboxId}-${index}`} key={option.value || 'none'} role="option"
          aria-selected={option.value === value} aria-disabled={option.disabled || undefined}
          onMouseEnter={() => { if (!option.disabled) setActive(index); }} onMouseDown={(event) => event.preventDefault()}
          onClick={() => commitOption(index)} className={`px-2.5 py-1.5 rounded-md text-2xs ${option.disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'} ${index === active && !option.disabled ? 'bg-inset' : ''}`}>
          {option.label}
        </div>)}</div>
      </PopoverPanel>, document.body)}
  </div>;
}
