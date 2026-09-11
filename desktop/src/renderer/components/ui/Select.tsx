import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown } from './ChevronDown';
import { createPortal } from 'react-dom';
import { OverlayPanel, POPOVER_Z } from '../overlays/Overlay';
import { useEscClose } from '../../hooks/use-esc-close';
import { fieldClasses, type FieldSize } from './field';

/**
 * The one dropdown (change 21, §1.3). NO native <select> anywhere.
 *
 * Styling the trigger alone is not enough and that's the whole point: a native
 * <select>'s option list stays OS-rendered, so you get the OS blue-highlight menu
 * dropping out of a themed app. This renders the list itself.
 *
 * Three product call sites: ThemeScreen particles, ProvidersSection
 * add-provider type, SkillEditor category (plus three in the dev workbench
 * toolbar). RuntimeBinding's provider + model pair used to be here too; both
 * were replaced by model/ModelPicker.tsx's one merged list. (SessionDrawer's
 * sort select folds into FileFilterPopover instead — change 38.)
 */

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export type SelectProps = {
  options: readonly SelectOption[];
  value: string;
  onChange: (value: string) => void;
  size?: FieldSize;
  placeholder?: string;
  disabled?: boolean;
  'aria-label'?: string;
  className?: string;
  /** Tailwind class for the menu width. Defaults to matching the trigger. */
  menuClassName?: string;
  /**
   * Render the menu at POPOVER_Z instead of the default L4 (z-100). Needed ONLY
   * when this Select lives inside a host in the z-9000 exception band (the
   * SessionStrip new-session form) — at L4 the portaled menu lands behind that
   * host and is invisible/unclickable. Leave unset everywhere else; the normal
   * layer scale is correct for the settings panels.
   */
  escapeHost?: boolean;
};

export function Select({
  options,
  value,
  onChange,
  size = 'md',
  placeholder = 'Select…',
  disabled,
  className = '',
  menuClassName = '',
  escapeHost = false,
  'aria-label': ariaLabel,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  // First-character typeahead ("g" jumps to the next option starting with g).
  const typeahead = useRef({ buffer: '', at: 0 });

  const selected = options.find((o) => o.value === value);

  // The menu is exactly the trigger's width and centered under it — for equal
  // widths that means aligning their horizontal centers (left = center -
  // width/2), clamped to the viewport with FolderSwitcher's 8px margin so a
  // trigger near the screen edge never pushes the menu off-screen.
  const measure = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    const width = r.width;
    const centered = r.left + r.width / 2 - width / 2;
    const left = Math.min(
      Math.max(centered, margin),
      Math.max(margin, window.innerWidth - width - margin),
    );
    setRect({ left, top: r.bottom + 4, width });
  };

  useLayoutEffect(() => {
    if (!open) return;
    measure();
    // Open with focus on the current value, not the top of the list.
    const i = options.findIndex((o) => o.value === value);
    setActiveIndex(i === -1 ? 0 : i);
  }, [open, options, value]);

  // The selected option can be dozens deep — RuntimeBinding's model select
  // renders whatever a provider's catalog returns, and OpenRouter-style
  // providers return a lot. Without this the menu opens scrolled to the top with
  // the current value nowhere in sight.
  useLayoutEffect(() => {
    if (open) activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  // All six call sites live inside scrollable settings panels, so a menu
  // positioned once on open drifts away from its trigger as soon as the panel
  // scrolls. Capture-phase catches scrolls on any ancestor, not just window.
  useEffect(() => {
    if (!open) return;
    const reposition = () => measure();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open]);

  useEscClose(open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      // Don't swallow a mousedown that lands inside ANOTHER Select's portaled
      // menu. The menus portal to document.body, so this capture listener can't
      // see them via menuRef — without the marker check, opening Select B while
      // Select A is open (or vice versa) has A eat the event and close, and B's
      // option click never fires.
      if (t instanceof Element && t.closest('[data-select-portal]')) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, [open]);

  const commit = (i: number) => {
    const opt = options[i];
    if (!opt || opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  /** Next selectable index in `dir`, skipping disabled options and wrapping. */
  const step = (from: number, dir: 1 | -1) => {
    for (let n = 1; n <= options.length; n++) {
      const i = (from + dir * n + options.length * n) % options.length;
      if (!options[i]?.disabled) return i;
    }
    return from;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => step(i, 1));
        return;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => step(i, -1));
        return;
      case 'Home':
        e.preventDefault();
        setActiveIndex(step(options.length - 1, 1));
        return;
      case 'End':
        e.preventDefault();
        setActiveIndex(step(0, -1));
        return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        commit(activeIndex);
        return;
      case 'Tab':
        setOpen(false);
        return;
      default:
        break;
    }

    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now();
      const ta = typeahead.current;
      // Keystrokes within 500ms accumulate ("mo" -> "model-b"); after that the
      // buffer resets so a new letter starts a fresh jump.
      ta.buffer = now - ta.at < 500 ? ta.buffer + e.key.toLowerCase() : e.key.toLowerCase();
      ta.at = now;
      const hit = options.findIndex(
        (o) => !o.disabled && o.label.toLowerCase().startsWith(ta.buffer),
      );
      if (hit !== -1) setActiveIndex(hit);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        className={fieldClasses(size, `flex items-center justify-between gap-2 w-full text-left ${className}`)}
      >
        <span className={`truncate ${selected ? '' : 'text-fg-muted'}`}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown className="w-3 h-3 shrink-0 text-fg-muted" />
      </button>

      {open &&
        rect &&
        createPortal(
          // L4 so a menu opened from inside an L2 popup (z-61) isn't trapped
          // behind the panel that owns it. When escapeHost is set, POPOVER_Z
          // overrides L4 via the style spread (a popover spawned from a z-9000
          // host must clear it — see Overlay.tsx).
          <OverlayPanel
            ref={menuRef}
            layer={4}
            // Marker so OTHER Selects' outside-click handlers (and host menus'
            // contains() checks) can see this portaled menu on document.body.
            data-select-portal=""
            className={`fixed ${menuClassName}`}
            // width (not minWidth) locks the menu to exactly the field's width,
            // centered under it (see measure) — Destin: match the field, centered.
            style={{
              left: rect.left,
              top: rect.top,
              width: rect.width,
              borderRadius: 'var(--radius-lg)',
              ...(escapeHost ? { zIndex: POPOVER_Z } : {}),
            }}
          >
            {/* The scroll lives on this inner div, NOT on the OverlayPanel.
                .layer-surface sets `overflow: hidden` as unlayered CSS, and
                Tailwind emits overflow-y-auto inside @layer utilities — unlayered
                beats layered, so an overflow-y-auto on the panel itself would be
                silently ignored and the menu would clip instead of scroll. */}
            <div
              role="listbox"
              aria-label={ariaLabel}
              className="p-1 max-h-64 overflow-y-auto"
              onKeyDown={onKeyDown}
            >
              {options.map((opt, i) => {
                const isSelected = opt.value === value;
                const isActive = i === activeIndex;
                return (
                  <div
                    key={opt.value}
                    ref={isActive ? activeRef : undefined}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={opt.disabled || undefined}
                    onMouseEnter={() => !opt.disabled && setActiveIndex(i)}
                    onClick={() => commit(i)}
                    className={[
                      // coarse-roomy grows the row on touch. Options sit flush
                      // against each other, so they can't use coarse-hit's
                      // overflowing box — it would steal the neighbour's taps.
                      'px-2.5 py-1.5 coarse-roomy rounded-md text-2xs cursor-pointer truncate',
                      opt.disabled ? 'opacity-50 cursor-not-allowed' : '',
                      isSelected
                        ? 'bg-accent text-on-accent font-medium'
                        : `text-fg-2 ${isActive && !opt.disabled ? 'bg-inset' : ''}`,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {opt.label}
                  </div>
                );
              })}
            </div>
          </OverlayPanel>,
          document.body,
        )}
    </>
  );
}
