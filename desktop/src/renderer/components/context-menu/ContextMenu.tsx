import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { OverlayPanel } from '../overlays/Overlay';
import { useEscClose } from '../../hooks/use-esc-close';
import { MenuIcon } from './menu-icons';
import type { MenuEntry } from './build-menu';
import { ScreenMark } from '../../shoot-mode';

// The themed right-click menu itself. Portalled to document.body on the app's
// .layer-surface popover (L4, like the Select dropdown) so it re-themes and
// glasses automatically. The host owns which entries + where; this owns look,
// edge-flip positioning, keyboard nav, and dismissal.

const VIEWPORT_PAD = 8;

export function ContextMenu({
  x,
  y,
  entries,
  onClose,
  screen,
}: {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
  /** Set when `shoot` opened this menu (photo-only build): names its mark. */
  screen?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const menuElRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Indices of focusable (enabled) items, for arrow-key navigation.
  const enabledIndices = useMemo(
    () => entries.map((e, i) => (e.type === 'item' && !e.disabled ? i : -1)).filter((i) => i >= 0),
    [entries],
  );
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Flip left / up when the menu would overflow the viewport (open near an edge).
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + width > window.innerWidth - VIEWPORT_PAD) left = Math.max(VIEWPORT_PAD, x - width);
    if (top + height > window.innerHeight - VIEWPORT_PAD) top = Math.max(VIEWPORT_PAD, y - height);
    setPos({ left, top });
  }, [x, y, entries]);

  // Focus the menu CONTAINER (not the first item) so keydown reaches us for
  // arrow-key nav, but nothing looks pre-selected on open — the first item only
  // highlights once the user hovers or arrows onto it.
  useEffect(() => {
    menuElRef.current?.focus();
  }, []);

  useEscClose(true, onClose);

  // Dismiss on outside pointer-down, scroll, resize, or focus loss. The listener
  // is added after this paint, so the right-click that opened the menu (its own
  // mousedown already fired) can't immediately close it.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) onClose();
    };
    const onScroll = () => onClose();
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const run = (entry: MenuEntry) => {
    if (entry.type !== 'item' || entry.disabled) return;
    // Close first so focus/selection side-effects of the action (e.g. focusing
    // the composer, mutating the selection) aren't fighting the open menu.
    onClose();
    void entry.run();
  };

  const moveFocus = (dir: 1 | -1) => {
    if (enabledIndices.length === 0) return;
    const active = document.activeElement;
    const current = enabledIndices.findIndex((i) => itemRefs.current[i] === active);
    const next = current === -1 ? (dir === 1 ? 0 : enabledIndices.length - 1) : (current + dir + enabledIndices.length) % enabledIndices.length;
    itemRefs.current[enabledIndices[next]]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveFocus(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveFocus(-1);
        break;
      case 'Home':
        e.preventDefault();
        itemRefs.current[enabledIndices[0]]?.focus();
        break;
      case 'End':
        e.preventDefault();
        itemRefs.current[enabledIndices[enabledIndices.length - 1]]?.focus();
        break;
      default:
        break;
    }
  };

  return createPortal(
    <OverlayPanel
      ref={panelRef}
      layer={4}
      className="fixed select-none"
      style={{ left: pos.left, top: pos.top, minWidth: 200, borderRadius: 'var(--radius-lg)' }}
    >
      {screen && <ScreenMark name={screen} />}
      {/* Keyboard handling lives on this inner div — OverlayPanel's typed props
          don't include onKeyDown, and the menu shouldn't scroll (no overflow on
          the surface). */}
      <div ref={menuElRef} role="menu" tabIndex={-1} className="p-1 outline-none" onKeyDown={onKeyDown}>
      {entries.map((entry, i) => {
        if (entry.type === 'sep') {
          return <div key={`sep-${i}`} className="h-px my-1 mx-1.5" style={{ background: 'var(--edge-dim)' }} role="separator" />;
        }
        return (
          <button
            key={entry.id}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            aria-disabled={entry.disabled || undefined}
            tabIndex={-1}
            onClick={() => run(entry)}
            className={[
              'flex items-center gap-2.5 w-full text-left px-2.5 py-1.5 rounded-md text-2xs coarse-roomy',
              entry.disabled
                ? 'opacity-50 cursor-not-allowed'
                : entry.primary
                  ? 'text-fg font-medium hover:bg-inset focus:bg-inset'
                  : 'text-fg-2 hover:bg-inset focus:bg-inset',
            ].join(' ')}
          >
            <span
              className={entry.primary && !entry.disabled ? '' : 'text-fg-muted'}
              style={entry.primary && !entry.disabled ? { color: 'var(--accent)' } : undefined}
            >
              <MenuIcon name={entry.icon} />
            </span>
            <span className="flex-1 truncate">{entry.label}</span>
            {entry.kbd && <span className="text-fg-muted text-3xs tracking-wide">{entry.kbd}</span>}
          </button>
        );
      })}
      </div>
    </OverlayPanel>,
    document.body,
  );
}
