import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useEscClose } from '../../hooks/use-esc-close';

/**
 * The small menu anchored under its trigger — a few choices that drop down from a pill or an
 * icon button and close again: your status in the friends card (Online / Incognito), the
 * Marketplace account chip (Sign out).
 *
 * WHY one piece (games-social friction, proposal 8): the friends card's status menu and the
 * Marketplace account chip each carried their own copy of the same popover — outside-click
 * listener, Escape, the panel's classes, the item's classes — and the copies had already drifted
 * (one closed on Escape, the other did not; one was 12px text, the other 14px). This owns all of
 * it once:
 *   - no scrim (it is anchored, not centred, and must not dim the page);
 *   - closes on a press outside it and on Escape (through the app's Escape stack, so one
 *     Escape closes the menu and not the popup behind it), and when an item is chosen;
 *   - keyboard: opening from the keyboard puts focus on the chosen item (or the first),
 *     ↑/↓/Home/End move between items, Tab leaves and closes, and focus goes back to the
 *     trigger when the menu closes from inside it;
 *   - roles: `menu`, `menuitem`, `menuitemradio` + `aria-checked`.
 *
 * Not for long lists or anything with a search box — that is `Select` / the model picker. The
 * project and chat ⋯ menus position themselves on the page (`hooks/useAnchoredMenu`) because
 * they can sit at the screen's edge; this one hangs under its trigger.
 *
 * The caller owns `open` (the trigger usually shows it — `PillButton`'s chevron turns over), so
 * the trigger is the caller's own button: give it `onClick={() => onOpenChange(!open)}`.
 */

const MENU = 'layer-surface absolute top-full mt-1 rounded-md p-1.5 text-xs shadow-md';
const ITEM = 'w-full text-left px-2 py-1.5 rounded text-fg-2 hover:text-fg hover:bg-inset focus:outline-none focus-visible:text-fg focus-visible:bg-inset disabled:opacity-40 transition-colors';
const ITEMS = '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)';

/** Closes the menu after an item's own action (and gives focus back to the trigger). */
const ChooseContext = createContext<(fn: () => void) => void>((fn) => fn());

interface MenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The caller's button that opens it (it should toggle `open` on click). */
  trigger: ReactNode;
  /** Which edge of the trigger the menu lines up with. */
  align?: 'left' | 'right';
  /** The menu's name for a screen reader, e.g. "Your status". */
  label: string;
  /** Extra classes for the menu panel — a minimum width (`min-w-60`). */
  className?: string;
  children: ReactNode;
}

export function Menu({ open, onOpenChange, trigger, align = 'left', label, className = '', children }: MenuProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const items = () => [...(menuRef.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
  const trig = () => wrapRef.current?.querySelector<HTMLElement>('button, [tabindex]') ?? null;
  // True while focus is somewhere inside the menu, so closing can hand it back to the trigger
  // (a keyboard user) without moving focus for someone who clicked elsewhere.
  const focusInside = () => !!menuRef.current?.contains(document.activeElement);
  const close = useCallback((restore: boolean) => {
    onOpenChange(false);
    if (restore) trig()?.focus();
  }, [onOpenChange]);

  // A press outside the trigger and the menu closes it. `mousedown` (not click), as both copies
  // it replaces did: the menu is gone before whatever was pressed reacts.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onOpenChange(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, onOpenChange]);
  useEscClose(open, () => close(focusInside()));

  // Opened while the TRIGGER has focus (a key press, or a click in a browser that focuses
  // buttons): focus moves to the chosen item, else the first. A mouse user sees no ring — the
  // focus came from a pointer, so `:focus-visible` does not match.
  const wasOpen = useRef(open);
  useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      const t = trig();
      if (t && document.activeElement === t) {
        const all = items();
        (all.find((el) => el.getAttribute('aria-checked') === 'true') ?? all[0])?.focus();
      }
    }
    wasOpen.current = open;
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const inMenu = menuRef.current?.contains(e.target as Node);
    // ↓ on the closed trigger opens it (the menu-button pattern); focus follows in the effect above.
    if (!inMenu) {
      if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); onOpenChange(true); }
      return;
    }
    const all = items();
    if (!all.length) return;
    const at = all.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => { e.preventDefault(); all[(i + all.length) % all.length].focus(); };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at < 0 ? all.length - 1 : at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(all.length - 1);
    else if (e.key === 'Tab') onOpenChange(false);
  };

  const choose = useCallback((fn: () => void) => { const back = focusInside(); fn(); close(back); }, [close]);

  return (
    <div ref={wrapRef} className="relative shrink-0 flex" onKeyDown={onKeyDown}>
      {trigger}
      {open && (
        // z-index 62 = one above L2 popup content (61): the menu must clear a popup or a
        // drawer it is opened from (the copies it replaces used the same).
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          className={`${MENU} ${align === 'right' ? 'right-0' : 'left-0'} ${className}`.trim()}
          style={{ zIndex: 62 }}
        >
          <ChooseContext.Provider value={choose}>{children}</ChooseContext.Provider>
        </div>
      )}
    </div>
  );
}

/** One action in a `Menu`. Choosing it runs `onSelect` and closes the menu. */
export function MenuItem({ onSelect, hint, disabled, children }: { onSelect: () => void; hint?: ReactNode; disabled?: boolean; children: ReactNode }) {
  const choose = useContext(ChooseContext);
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={() => choose(onSelect)} className={ITEM}>
      <ItemText hint={hint}>{children}</ItemText>
    </button>
  );
}

/** One of a set of choices in a `Menu` where exactly one is current (Online / Incognito). */
export function MenuRadioItem({ checked, onSelect, hint, disabled, children }: { checked: boolean; onSelect: () => void; hint?: ReactNode; disabled?: boolean; children: ReactNode }) {
  const choose = useContext(ChooseContext);
  return (
    <button type="button" role="menuitemradio" aria-checked={checked} disabled={disabled} onClick={() => choose(onSelect)} className={ITEM}>
      <ItemText hint={hint}>{children}</ItemText>
    </button>
  );
}

/** A line of plain words at the top of a `Menu` that is not a choice ("Signed in as @you"). */
export function MenuNote({ children }: { children: ReactNode }) {
  return <div role="none" className="px-2 py-1.5 text-fg-2 truncate">{children}</div>;
}

/** An item's name, with an optional grey line under it that says what choosing it does. */
function ItemText({ hint, children }: { hint?: ReactNode; children: ReactNode }) {
  if (!hint) return <>{children}</>;
  return (
    <>
      <span className="block text-fg">{children}</span>
      <span className="block text-2xs text-fg-muted">{hint}</span>
    </>
  );
}
